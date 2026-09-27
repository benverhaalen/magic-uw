// owner: task-workspace. Task-owned windows in the student's default browser.
// The renderer names pages and remembered windows; main re-derives every URL from
// the saved assignment and only acts on windows the native helper saw appear.
import { spawn } from "node:child_process";
import { z } from "zod";
import type {
  TaskWindowCapability,
  TaskWindowOutcome,
  TaskWindowPage,
  TaskWindowRef,
  TaskWindowRequest,
  TaskWindowResult,
  TaskWindowRole,
  WorkSet,
} from "@magic/contracts";

type HelperReply = Record<string, unknown> & { event?: string; code?: string };
export type RunHelper = (request: Record<string, unknown>, timeoutMs: number) => Promise<HelperReply>;

export interface TaskWindowHost {
  run: RunHelper;
  /** Headless verification never asks the browser for anything. */
  headless: boolean;
  /** Current consent, rechecked before each page is sent (same gate as Start work). */
  beforeOpen(): Promise<void>;
  /** Throws unless the assignment exists, is available, and belongs to this account. */
  context(accountScope: string, resourceId: string): Promise<{ workSet: WorkSet; gitlabUrls: string[] }>;
  now(): Date;
}

const text = (max: number) => z.string().min(1).max(max);
const role = z.enum(["instructions", "work", "support"]);
const page = z.object({ key: text(2100), role, url: text(2000), title: z.string().max(500), origin: z.enum(["work_set", "gitlab", "student"]) }).strict();
const ref = z.object({
  key: text(2100), role, url: text(2000), bundleId: text(200),
  pid: z.number().int().positive(), windowNumber: z.number().int().positive(),
  placed: z.boolean(), openedAt: text(40),
}).strict();
const scoped = { accountScope: text(300).refine(v => !v.includes("\u0000")), resourceId: text(1000).refine(v => !v.includes("\u0000")) };
const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }).strict(),
  z.object({ action: z.literal("request-access") }).strict(),
  z.object({ action: z.literal("open"), ...scoped, pages: z.array(page).min(1).max(8) }).strict(),
  z.object({ action: z.literal("continue"), ...scoped, pages: z.array(page).max(8), windows: z.array(ref).max(8) }).strict(),
  z.object({ action: z.literal("close"), ...scoped, windows: z.array(ref).min(1).max(8) }).strict(),
]);

function urlKey(value: string) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}
function httpsOnly(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Only https pages open in task windows.");
  return url.href;
}

/** URLs this task may open: the reviewed work set (instructions and materials) and course GitLab projects. */
export function allowedTaskUrls(workSet: WorkSet, gitlabUrls: string[]) {
  const allowed = new Map<string, TaskWindowPage["origin"]>();
  for (const item of workSet.items) {
    const url = item.target.kind === "web" ? item.target.url : item.target.fallbackUrl;
    allowed.set(urlKey(url), "work_set");
  }
  for (const section of workSet.context?.sections ?? [])
    for (const url of [section.url, ...section.links.map(l => l.url)])
      if (/^https?:\/\//i.test(url) && !allowed.has(urlKey(url))) allowed.set(urlKey(url), "work_set");
  for (const url of gitlabUrls) allowed.set(urlKey(url), "gitlab");
  return allowed;
}

/** Instructions left and the work page right when both exist; support pages are never placed. */
export function sideFor(roleName: TaskWindowRole, pages: readonly Pick<TaskWindowPage, "role">[]) {
  const split = pages.some(p => p.role === "instructions") && pages.some(p => p.role === "work");
  if (!split || roleName === "support") return "none";
  return roleName === "instructions" ? "left" : "right";
}

const CODE_TEXT: Record<string, string> = {
  new_window_unsupported: "Your default browser doesn't offer Magic a way to ask for a new window.",
  several_browser_processes: "Your browser is running more than once (for example two profiles), so Magic can't tell which one would open it.",
  ambiguous_new_window: "Your browser opened more than one window, so Magic couldn't tell which is this page.",
  new_window_not_observed: "Your browser may have opened it, but Magic didn't see a new window.",
  launch_failed: "Your browser didn't accept the request.",
  no_default_browser: "Magic couldn't find your default browser.",
  accessibility_required: "Allow window arrangement in System Settings to place and bring back task windows.",
  window_not_matched: "Magic saw the new window but couldn't match it safely, so it left it where your browser put it.",
  browser_kept_its_size: "Your browser didn't take the half-screen size.",
  browser_process_gone: "Your browser was closed or restarted since then.",
  helper_missing: "This build doesn't include Magic's window helper.",
  helper_failed: "Magic's window helper stopped unexpectedly.",
};
const explain = (code: unknown) => CODE_TEXT[String(code)] ?? "Magic couldn't manage this window.";

function capabilityFrom(status: HelperReply): TaskWindowCapability {
  if (status.event !== "status")
    return { browser: null, bundleId: null, family: "unknown", newWindow: false, accessibility: false, reason: explain(status.code) };
  const family = String(status.family);
  return {
    browser: typeof status.name === "string" ? status.name.replace(/\.app$/, "") : null,
    bundleId: typeof status.bundleId === "string" ? status.bundleId : null,
    family: (["firefox", "chromium", "safari", "other"].includes(family) ? family : "unknown") as TaskWindowCapability["family"],
    newWindow: status.newWindow === true,
    accessibility: status.accessibility === true,
    reason: status.newWindow === true ? undefined : CODE_TEXT.new_window_unsupported,
  };
}

export function createTaskWindows(host: TaskWindowHost) {
  /** Which task owns each observed window ("pid:number"), so one window never serves two tasks. */
  const owners = new Map<string, { task: string; window: TaskWindowRef }>();
  let busy = false;
  const id = (w: Pick<TaskWindowRef, "pid" | "windowNumber">) => `${w.pid}:${w.windowNumber}`;

  async function capability() {
    if (host.headless) return { browser: null, bundleId: null, family: "unknown" as const, newWindow: false, accessibility: false, reason: "Headless check: nothing opens." };
    return capabilityFrom(await host.run({ action: "status" }, 4000).catch(error => ({ event: "error", code: error instanceof Error ? error.message : "helper_failed" })));
  }

  async function checkedPages(accountScope: string, resourceId: string, pages: TaskWindowPage[]) {
    const { workSet, gitlabUrls } = await host.context(accountScope, resourceId);
    const allowed = allowedTaskUrls(workSet, gitlabUrls);
    const ok: TaskWindowPage[] = [], outcomes: TaskWindowOutcome[] = [];
    for (const p of pages) {
      let url: string;
      try { url = httpsOnly(p.url); } catch (error) { outcomes.push({ key: p.key, state: "not_sent", detail: (error as Error).message }); continue; }
      // The left window is only ever the assignment's own page. A page the student
      // chose (a course tool or one they added) may go right or in its own window.
      const instructions = workSet.items.find(item => item.role === "instructions");
      const refused = p.role === "instructions"
        ? instructions?.target.kind !== "web" || urlKey(instructions.target.url) !== urlKey(url)
        : p.origin === "student" ? false : allowed.get(urlKey(url)) !== p.origin;
      if (refused) {
        outcomes.push({ key: p.key, state: "not_sent", detail: "This page isn't part of this saved task." });
        continue;
      }
      ok.push({ ...p, url });
    }
    return { ok, outcomes };
  }

  async function openPages(task: string, pages: TaskWindowPage[], all: TaskWindowPage[], cap: TaskWindowCapability) {
    const windows: TaskWindowRef[] = [], outcomes: TaskWindowOutcome[] = [];
    let area: unknown;
    const order = [...pages].sort((a, b) => rank(a.role) - rank(b.role));
    for (const p of order) {
      if (host.headless) { outcomes.push({ key: p.key, state: "test_only", detail: "Headless check: nothing was opened." }); continue; }
      if (!cap.newWindow) { outcomes.push({ key: p.key, state: "not_sent", detail: cap.reason }); continue; }
      try { await host.beforeOpen(); } catch (error) { outcomes.push({ key: p.key, state: "not_sent", detail: (error as Error).message }); continue; }
      const [accountScope, resourceId] = task.split("\u0000");
      try {
        const current = await checkedPages(accountScope!, resourceId!, [p]);
        if (!current.ok.length) { outcomes.push(...current.outcomes); continue; }
      } catch (error) {
        outcomes.push({ key: p.key, state: "not_sent", detail: error instanceof Error ? error.message : "Task access changed." });
        continue;
      }
      const side = sideFor(p.role, all);
      const reply = await host.run({ action: "open", url: p.url, side, ...(area ? { area } : {}), timeoutMs: 8000 }, 15000)
        .catch(error => ({ event: "error", code: error instanceof Error ? error.message : "helper_failed" } as HelperReply));
      if (reply.event !== "opened" || typeof reply.pid !== "number" || typeof reply.windowNumber !== "number") {
        outcomes.push({ key: p.key, state: "not_observed", detail: explain(reply.code) });
        continue;
      }
      if (side !== "none" && reply.area) area = reply.area;
      const window: TaskWindowRef = {
        key: p.key, role: p.role, url: p.url, bundleId: String(reply.bundleId), pid: reply.pid, windowNumber: reply.windowNumber,
        placed: reply.placed === true, openedAt: host.now().toISOString(),
      };
      owners.set(id(window), { task, window: { ...window } });
      windows.push(window);
      outcomes.push(side === "none" || window.placed
        ? { key: p.key, state: "new_window" }
        : { key: p.key, state: "new_window_unplaced", detail: explain(reply.placeReason) });
    }
    return { windows, outcomes };
  }

  /** Remembered windows that still exist for their browser process and aren't another task's. */
  async function present(task: string, windows: TaskWindowRef[]) {
    const alive: TaskWindowRef[] = [], gone: TaskWindowRef[] = [], blocked: TaskWindowRef[] = [], outcomes: TaskWindowOutcome[] = [];
    const groups = new Map<string, TaskWindowRef[]>();
    for (const w of windows) {
      const owned = owners.get(id(w));
      if (!owned || owned.task !== task || Object.keys(owned.window).some(key => owned.window[key as keyof TaskWindowRef] !== w[key as keyof TaskWindowRef])) {
        blocked.push(w);
        outcomes.push({ key: w.key, state: "not_sent", detail: "Magic cannot verify ownership of this remembered window in this app session. Open fresh windows explicitly; existing windows will be left alone." });
        continue;
      }
      groups.set(`${w.bundleId}\u0000${w.pid}`, [...(groups.get(`${w.bundleId}\u0000${w.pid}`) ?? []), w]);
    }
    for (const group of groups.values()) {
      const reply = await host.run({ action: "list", bundleId: group[0]!.bundleId, pid: group[0]!.pid, windows: group.map(w => w.windowNumber) }, 4000)
        .catch(() => ({ event: "error", code: "helper_failed" } as HelperReply));
      const listed = reply.event === "listed" && Array.isArray(reply.windows) ? reply.windows as { windowNumber: number; present: boolean }[] : null;
      for (const w of group) {
        const observed = listed?.find(entry => entry.windowNumber === w.windowNumber);
        if (observed?.present === true) alive.push(w);
        else if (observed?.present === false) { gone.push(w); owners.delete(id(w)); }
        else {
          blocked.push(w);
          outcomes.push({ key: w.key, state: "not_sent", detail: "Magic couldn't check this window. It was left alone; retry when the browser is available." });
        }
      }
    }
    return { alive, gone, blocked, outcomes };
  }

  async function act(action: "focus" | "close", windows: TaskWindowRef[]) {
    const states = new Map<string, string>();
    const groups = new Map<string, TaskWindowRef[]>();
    for (const w of windows) groups.set(`${w.bundleId}\u0000${w.pid}`, [...(groups.get(`${w.bundleId}\u0000${w.pid}`) ?? []), w]);
    // Focus the instructions last so they end up in front beside the work page.
    for (const group of groups.values()) {
      const ordered = action === "focus" ? [...group].sort((a, b) => rank(b.role) - rank(a.role)) : group;
      const reply = await host.run({ action, bundleId: group[0]!.bundleId, pid: group[0]!.pid, windows: ordered.map(w => w.windowNumber) }, 6000)
        .catch(() => ({ event: "error", code: "helper_failed" } as HelperReply));
      for (const w of group) {
        const entry = Array.isArray(reply.windows) ? (reply.windows as { windowNumber: number; state: string }[]).find(e => e.windowNumber === w.windowNumber) : undefined;
        states.set(id(w), entry?.state ?? `error:${reply.code ?? "helper_failed"}`);
      }
    }
    return states;
  }

  async function handle(raw: unknown): Promise<TaskWindowResult> {
    const request = requestSchema.parse(raw) as TaskWindowRequest;
    if (request.action === "status") return { mode: host.headless ? "test_only" : "live", capability: await capability(), windows: [], outcomes: [] };
    if (request.action === "request-access") {
      if (!host.headless) await host.run({ action: "request_access" }, 4000).catch(() => undefined);
      return { mode: host.headless ? "test_only" : "live", capability: await capability(), windows: [], outcomes: [] };
    }
    if (busy) throw new Error("Task windows are already being arranged.");
    busy = true;
    try {
      const task = `${request.accountScope}\u0000${request.resourceId}`;
      const mode = host.headless ? "test_only" : "live";
      const cap = host.headless ? { browser: null, bundleId: null, family: "unknown" as const, newWindow: false, accessibility: false, reason: "Headless check." } : await capability();
      if (request.action === "open") {
        const { ok, outcomes } = await checkedPages(request.accountScope, request.resourceId, request.pages);
        const opened = await openPages(task, ok, ok, cap);
        return { mode, capability: cap, windows: opened.windows, outcomes: [...outcomes, ...opened.outcomes] };
      }
      // Remembered windows only ever come from an earlier helper observation; recheck them all.
      await host.context(request.accountScope, request.resourceId);
      const { alive, gone, blocked, outcomes } = host.headless ? { alive: [], gone: request.windows, blocked: [], outcomes: [] as TaskWindowOutcome[] } : await present(task, request.windows);
      if (request.action === "close") {
        if (!cap.accessibility && alive.length) {
          return { mode, capability: cap, windows: [...alive, ...blocked], outcomes: [...outcomes, ...alive.map(w => ({ key: w.key, state: "present" as const, detail: CODE_TEXT.accessibility_required }))] };
        }
        const states = alive.length ? await act("close", alive) : new Map<string, string>();
        const still = alive.filter(w => states.get(id(w)) !== "closed");
        for (const w of alive) if (!still.includes(w)) owners.delete(id(w));
        return {
          mode, capability: cap, windows: [...still, ...blocked],
          outcomes: [...outcomes,
            ...gone.map(w => ({ key: w.key, state: "missing" as const, detail: "Already closed." })),
            ...alive.map(w => {
              const state = states.get(id(w));
              if (state === "closed") return { key: w.key, state: "closed" as const };
              if (state === "still_open") return { key: w.key, state: "still_open" as const, detail: "Your browser is asking before it closes this window." };
              if (state === "ambiguous") return { key: w.key, state: "ambiguous" as const, detail: "Another window has the same size and place, so Magic left both alone." };
              return { key: w.key, state: "still_open" as const, detail: explain(state?.replace(/^error:/, "")) };
            })],
        };
      }
      // Continue: bring back what exists, reopen only pages whose window is gone.
      const { ok, outcomes: refused } = await checkedPages(request.accountScope, request.resourceId, request.pages);
      const states = alive.length && cap.accessibility ? await act("focus", alive) : new Map<string, string>();
      const covered = new Set([...alive, ...blocked].map(w => w.key));
      const reopened = await openPages(task, ok.filter(p => !covered.has(p.key)), ok, cap);
      return {
        mode, capability: cap, windows: [...alive, ...blocked, ...reopened.windows],
        outcomes: [...outcomes, ...refused,
          ...alive.map(w => {
            const state = states.get(id(w));
            if (state === "focused") return { key: w.key, state: "focused" as const };
            if (state === "ambiguous") return { key: w.key, state: "ambiguous" as const, detail: "Another window has the same size and place, so Magic didn't bring either forward." };
            return { key: w.key, state: "present" as const, detail: cap.accessibility ? "Still open, but Magic couldn't bring it forward." : CODE_TEXT.accessibility_required };
          }),
          ...reopened.outcomes],
      };
    } finally { busy = false; }
  }
  return { handle };
}
const rank = (r: TaskWindowRole) => (r === "instructions" ? 0 : r === "work" ? 1 : 2);

/** One JSON line in, one JSON line out; the helper is killed on timeout. */
export function helperRunner(path: string): RunHelper {
  return (request, timeoutMs) => new Promise((resolve, reject) => {
    let out = "";
    let child;
    try { child = spawn(path, [], { stdio: ["pipe", "pipe", "ignore"] }); } catch { reject(new Error("helper_missing")); return; }
    const timer = setTimeout(() => { child.kill(); reject(new Error("helper_failed")); }, timeoutMs);
    child.on("error", (error: NodeJS.ErrnoException) => { clearTimeout(timer); reject(new Error(error.code === "ENOENT" || error.code === "EACCES" ? "helper_missing" : "helper_failed")); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => { out += chunk; if (out.length > 65536) child.kill(); });
    child.on("close", () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(out.trim().split("\n").at(-1) ?? "")); } catch { reject(new Error("helper_failed")); }
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

/** The account/resource guard main uses: the assignment's own source must be this account's. */
export function taskContextFrom(
  result: { workSet?: WorkSet; snapshot: { resources: { id: string; sourceId: string; courseId: string }[]; sources: { id: string; accountScope: string }[]; gitlabLinks?: { accountScope: string; courseId: string; projectPath: string }[] } },
  accountScope: string,
  resourceId: string,
  gitlabOrigin: string,
) {
  const resource = result.snapshot.resources.find(r => r.id === resourceId);
  const source = resource && result.snapshot.sources.find(s => s.id === resource.sourceId);
  if (!resource || !result.workSet || source?.accountScope !== accountScope) throw new Error("This task isn't available for this account.");
  const gitlabUrls = (result.snapshot.gitlabLinks ?? [])
    .filter(link => link.accountScope === accountScope && link.courseId === resource.courseId)
    .map(link => `${gitlabOrigin}/${link.projectPath}`);
  return { workSet: result.workSet, gitlabUrls };
}
