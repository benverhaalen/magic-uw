import type { GitlabLink, ResourceView, Snapshot, TaskWindowOutcome, TaskWindowOutcomeState, TaskWindowPage, TaskWindowRef, TaskWindowRole, WorkSet } from "@magic/contracts";
import { GITLAB_ORIGIN } from "../prepared-work/destination";
import type { CourseTool } from "./page-view-adapter";
import { clearInvestigations } from "./source-investigation";

/**
 * A task workspace: the student's own tool choices for one saved assignment,
 * remembered on this device so a later visit can Continue. Choices are the
 * student's; suggestions (prepared materials, a course GitLab link, course
 * tools) never become choices until the student saves them.
 *
 * Pages open in task-owned windows of the default browser: instructions on the
 * left, the page the task is worked in on the right, support pages in their own
 * windows. Magic remembers the windows it saw appear (browser process and window
 * number) so Continue can bring back exactly those. It does not observe tabs,
 * scroll, sign-in, page loads, drafts or app state. Nothing here is sent
 * anywhere; the record holds identifiers, choices and receipts, not coursework.
 */
export const STORAGE_KEY = "magic.task-workspace.v1";
const LIMIT = 100;

export type GitlabChoice =
  /** Not decided yet: a course link, if any, is only a suggestion. */
  | { state: "unset" }
  /** The student said this task does not use GitLab. */
  | { state: "none" }
  /** The student confirmed this project for this task. */
  | { state: "project"; projectPath: string };

export type Placement = "left" | "right" | "own" | "off";
export type TargetState =
  /** Fallback link: the operating system accepted it; the browser chose the window. */
  | "handed_off"
  /** The call failed in a way that does not say whether anything opened. */
  | "unconfirmed"
  | TaskWindowOutcomeState;
export interface TargetReceipt { key: string; label: string; state: TargetState; detail?: string }
export interface LastOpen { at: string; targets: TargetReceipt[] }

export interface TaskWorkspaceRecord {
  v: 1;
  accountScope: string;
  courseId: string;
  resourceId: string;
  savedAt: string;
  /** The assignment's contentHash when the student last saved or opened, to notice changed instructions. */
  instructionsHash: string;
  /** `work` is the page key for the right window (null: none); `support` pages get their own windows. */
  choices: { gitlab: GitlabChoice; work: string | null; support: string[]; pages: StudentPage[] };
  /** Windows Magic saw appear for this task; rechecked by the app before any action. */
  windows: TaskWindowRef[];
  last: LastOpen | null;
}
/**
 * A page the student added to this task, or chose from a source-check suggestion
 * (`via`). Saving it makes it the student's choice, so Continue reopens it without
 * rerunning the check.
 */
export interface StudentPage { url: string; title: string; via?: "source_check" }

export interface KeyValueStore { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export function defaultStore(): KeyValueStore | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

/** Exact identity: the source account and the saved resource, never a title. */
export function taskKey(accountScope: string, resourceId: string) { return `${accountScope}\u0000${resourceId}`; }

const text = (value: unknown, max = 2000): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const PROJECT_PATH = /^[\w.-]+(?:\/[\w.-]+)+$/;
const projectPath = (value: string) => PROJECT_PATH.test(value) && !value.split("/").some(part => part === "." || part === "..");
const TARGET_STATES = new Set<TargetState>(["handed_off", "unconfirmed", "new_window", "new_window_unplaced", "not_observed", "focused", "present", "closed", "still_open", "missing", "ambiguous", "not_sent", "test_only"]);
const ROLES = new Set<TaskWindowRole>(["instructions", "work", "support"]);
const count = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
function parseWindow(w: unknown): TaskWindowRef | null {
  const x = w as Partial<TaskWindowRef> | null;
  if (!x || !text(x.key, 300) || !x.role || !ROLES.has(x.role) || !text(x.url) || httpsUrl(x.url) === null || !text(x.bundleId, 200) || !count(x.pid) || !count(x.windowNumber) || typeof x.placed !== "boolean" || !text(x.openedAt, 40)) return null;
  return { key: x.key, role: x.role, url: x.url, bundleId: x.bundleId, pid: x.pid, windowNumber: x.windowNumber, placed: x.placed, openedAt: x.openedAt };
}

function parseRecord(value: unknown): TaskWorkspaceRecord | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Partial<TaskWorkspaceRecord>;
  if (r.v !== 1 || !text(r.accountScope, 256) || !text(r.courseId, 256) || !text(r.resourceId, 1000) || !text(r.savedAt, 40) || typeof r.instructionsHash !== "string") return null;
  const c = r.choices as Partial<TaskWorkspaceRecord["choices"]> & { tools?: unknown } | undefined;
  if (!c) return null;
  const g = c.gitlab as Partial<GitlabChoice> | undefined;
  const gitlab: GitlabChoice = g?.state === "none" ? { state: "none" }
    : g?.state === "project" && text((g as { projectPath?: unknown }).projectPath, 300) && projectPath((g as { projectPath: string }).projectPath) ? { state: "project", projectPath: (g as { projectPath: string }).projectPath }
    : { state: "unset" };
  // Earlier setups saved course tools as URLs; they become own-window pages.
  const legacyTools = Array.isArray(c.tools) ? c.tools.filter((url): url is string => text(url) && httpsUrl(url) !== null).map(url => `tool:${url}`) : [];
  const support = [...new Set([...(Array.isArray(c.support) ? c.support.filter(key => text(key, 2100)) : []), ...legacyTools])].slice(0, 20);
  const pages = Array.isArray(c.pages) ? c.pages.filter((p): p is StudentPage => !!p && text(p.url) && httpsUrl(p.url) !== null && typeof p.title === "string" && p.title.length <= 200)
    .map(p => ({ url: p.url, title: p.title, ...(p.via === "source_check" ? { via: "source_check" as const } : {}) })).slice(0, 10) : [];
  const work = text(c.work, 2100) ? c.work : null;
  const windows = Array.isArray(r.windows) ? r.windows.map(parseWindow).filter((w): w is TaskWindowRef => !!w).slice(0, 8) : [];
  const last = r.last && typeof r.last === "object" && text(r.last.at, 40) && Array.isArray(r.last.targets) ? {
    at: r.last.at,
    targets: r.last.targets.filter((t): t is TargetReceipt => !!t && text(t.key, 2100) && text(t.label, 400) && TARGET_STATES.has(t.state)).slice(0, 25),
  } : null;
  return { v: 1, accountScope: r.accountScope, courseId: r.courseId, resourceId: r.resourceId, savedAt: r.savedAt, instructionsHash: r.instructionsHash, choices: { gitlab, work, support, pages }, windows, last };
}

function readAll(store: KeyValueStore | null): Map<string, TaskWorkspaceRecord> {
  const records = new Map<string, TaskWorkspaceRecord>();
  try {
    const raw = store?.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : null;
    if (!Array.isArray(parsed)) return records;
    for (const value of parsed) {
      const record = parseRecord(value);
      if (record) records.set(taskKey(record.accountScope, record.resourceId), record);
    }
  } catch { /* An unreadable record is treated as no saved setup; the student can set it up again. */ }
  return records;
}
function writeAll(store: KeyValueStore | null, records: Map<string, TaskWorkspaceRecord>) {
  if (!store) throw new Error("This device can't save task setups right now.");
  const kept = [...records.values()].sort((a, b) => b.savedAt.localeCompare(a.savedAt)).slice(0, LIMIT);
  if (kept.length) store.setItem(STORAGE_KEY, JSON.stringify(kept)); else store.removeItem(STORAGE_KEY);
}

export function readWorkspace(accountScope: string, resourceId: string, store = defaultStore()) {
  return readAll(store).get(taskKey(accountScope, resourceId)) ?? null;
}
export function saveWorkspace(record: TaskWorkspaceRecord, store = defaultStore()) {
  const records = readAll(store);
  records.delete(taskKey(record.accountScope, record.resourceId));
  records.set(taskKey(record.accountScope, record.resourceId), record);
  writeAll(store, records);
}
export function forgetWorkspace(accountScope: string, resourceId: string, store = defaultStore()) {
  const records = readAll(store);
  if (records.delete(taskKey(accountScope, resourceId))) writeAll(store, records);
}
/** Delete local data: every task setup goes with the coursework it described. */
export function clearTaskWorkspaces(store = defaultStore()) {
  clearInvestigations();
  try { store?.removeItem(STORAGE_KEY); } catch { /* nothing saved */ }
}
/** Drop setups whose assignment is no longer saved for that account (after Delete local data, sign-out or removal). */
export function pruneWorkspaces(snapshot: Pick<Snapshot, "resources" | "sources">, store = defaultStore()) {
  const records = readAll(store);
  if (!records.size) return 0;
  const accounts = new Map(snapshot.sources.map(source => [source.id, source.accountScope]));
  const live = new Set(snapshot.resources.filter(r => !r.deleted && r.kind === "assignment").map(r => taskKey(accounts.get(r.sourceId) ?? "", r.id)));
  let removed = 0;
  for (const key of [...records.keys()]) if (!live.has(key)) { records.delete(key); removed++; }
  if (removed) writeAll(store, records);
  return removed;
}

export function httpsUrl(input: string): string | null {
  try {
    const url = new URL(input);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch { return null; }
}
/** Which saved course link a pasted address refers to. Core validates the address; this only matches it. */
export function gitlabPathFromUrl(input: string): string | null {
  try {
    const url = new URL(input.trim());
    if (url.origin !== GITLAB_ORIGIN) return null;
    const path = url.pathname.split("/-/")[0]!.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
    return projectPath(path) && !path.startsWith("users/") && !path.startsWith("api/") ? path : null;
  } catch { return null; }
}
export const gitlabProjectUrl = (projectPath: string) => `${GITLAB_ORIGIN}/${projectPath}`;

/** Manual course links saved for exactly this account and course. */
export function courseGitlabLinks(snapshot: Pick<Snapshot, "gitlabLinks">, accountScope: string, courseId: string): GitlabLink[] {
  return (snapshot.gitlabLinks ?? []).filter(link => link.accountScope === accountScope && link.courseId === courseId);
}

export type GitlabView =
  | { kind: "confirmed"; projectPath: string }
  /** The confirmed project is no longer linked to the course; it is not opened until the student decides. */
  | { kind: "removed"; projectPath: string }
  | { kind: "suggested"; links: string[] }
  | { kind: "none" }
  | { kind: "missing" };
export function gitlabView(choice: GitlabChoice, links: readonly GitlabLink[]): GitlabView {
  const paths = links.map(link => link.projectPath);
  if (choice.state === "project") return paths.includes(choice.projectPath) ? { kind: "confirmed", projectPath: choice.projectPath } : { kind: "removed", projectPath: choice.projectPath };
  if (choice.state === "none") return { kind: "none" };
  return paths.length ? { kind: "suggested", links: paths } : { kind: "missing" };
}

/** Where an offered page came from. Only `confirmed` evidence may be pre-selected, and only an assignment link. */
export type TargetSource =
  /** Listed in the saved Canvas assignment itself. */
  | "assignment_link"
  /** Connected through an accepted supporting-evidence link. */
  | "accepted_evidence"
  /** A same-course page section matched by the assignment's title (provisional unless linked). */
  | "course_section"
  /** Cited by a finished source check; never confirmed as this assignment's work or submission place. */
  | "source_check"
  /** The GitLab project the student confirmed for this task. */
  | "gitlab_choice"
  | "course_tool"
  | "student_page";
/** An exact span a suggestion rests on: resource, version and character range. */
export interface TargetCitation { resourceId: string; title: string; contentHash: string; version?: number; start: number; end: number; excerpt: string }
export interface TargetEvidence {
  source: TargetSource;
  /** True for the assignment's own links, accepted evidence and the student's own choices. */
  confirmed: boolean;
  cite?: TargetCitation;
  /** What a source check said about this page, with the kind of finding it reported. */
  finding?: { kind: "instruction" | "reading" | "work_target" | "context"; text: string };
}
/** A page this task can open, with where it came from. */
export interface Target {
  key: string; label: string; detail: string; url: string; origin: TaskWindowPage["origin"];
  /** A confirmed assignment link off the assignment's own site: the only kind suggested for the right window. */
  external?: boolean;
  evidence: TargetEvidence;
}
/**
 * Everything that can be opened for this task right now, besides the instructions.
 * Materials come from the reviewed work set, including pages the assignment links
 * directly that Magic hasn't saved (for example a project site). A saved choice
 * missing here is not opened.
 */
export function availableTargets(input: { set: WorkSet | null; gitlab: GitlabView; tools: readonly CourseTool[]; pages?: readonly StudentPage[] }): Target[] {
  const targets: Target[] = [];
  const instructions = input.set?.items.find(item => item.role === "instructions");
  const home = originOf(instructions?.target.kind === "web" ? instructions.target.url : "");
  for (const item of input.set?.items ?? []) {
    if (item.role === "instructions") continue;
    const url = item.target.kind === "web" ? item.target.url : item.target.fallbackUrl;
    const unsaved = item.resourceId.startsWith(`${input.set!.assignmentId}:link:`);
    const linked = unsaved || item.provenance === "assignment_link";
    // Saved or not, a page the assignment links outside its own site is where the work happens.
    const external = linked && originOf(url) !== home;
    targets.push({
      key: `item:${item.resourceId}`, label: item.title, origin: "work_set", external, url,
      evidence: { source: linked ? "assignment_link" : "accepted_evidence", confirmed: true },
      detail: external ? `Linked in the assignment · ${hostOf(url)}`
        : linked ? "Course page linked in the assignment" : "Course page connected to this assignment",
    });
  }
  // Pages cited by a provisional same-course section (the schedule and its readings) are
  // choosable but never pre-selected: the section isn't linked to the assignment.
  const context = input.set?.context;
  for (const section of context?.sections ?? []) {
    for (const link of [{ url: section.url, text: section.title as string | null }, ...section.links]) {
      if (!/^https?:\/\//i.test(link.url) || targets.some(t => t.url === link.url)) continue;
      targets.push({
        key: `context:${link.url}`, label: link.text || hostOf(link.url), origin: "work_set", url: link.url,
        evidence: { source: "course_section", confirmed: section.linkedToAssignment, cite: {
          resourceId: section.resourceId, title: section.title, contentHash: section.contentHash, start: section.start, end: section.end, excerpt: clip(section.quote, 300) } },
        detail: `${section.provisional ? "Possibly related · " : ""}${link.url === section.url ? `Has a ${context!.anchor} section` : `Cited in the ${context!.anchor} section of ${section.title}`} · ${hostOf(link.url)}`,
      });
    }
  }
  if (input.gitlab.kind === "confirmed") targets.push({
    key: `gitlab:${input.gitlab.projectPath}`, label: `GitLab · ${input.gitlab.projectPath}`, origin: "gitlab",
    detail: "You chose this UW GitLab project for this task.", url: gitlabProjectUrl(input.gitlab.projectPath),
    evidence: { source: "gitlab_choice", confirmed: true },
  });
  for (const tool of input.tools) targets.push({ key: `tool:${tool.url}`, label: tool.name, detail: `${tool.host}. ${tool.reason}`, url: tool.url, origin: "student", evidence: { source: "course_tool", confirmed: false } });
  for (const page of input.pages ?? []) if (!targets.some(t => t.url === page.url)) targets.push({
    key: `page:${page.url}`, label: page.title || hostOf(page.url), url: page.url, origin: "student", evidence: { source: "student_page", confirmed: true },
    detail: page.via === "source_check" ? `You chose this from the source check · ${hostOf(page.url)}` : `You added this page · ${hostOf(page.url)}`,
  });
  return targets;
}
export const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };
const originOf = (url: string) => { try { return new URL(url).origin; } catch { return ""; } };
const clip = (value: string, max: number) => value.length <= max ? value : `${value.slice(0, max).replace(/\s+\S*$/, "")}…`;

export interface Draft { work: string | null; support: string[]; pages: StudentPage[] }
/**
 * First open: the right window is the page the assignment itself links outside
 * Canvas (the first one), else a GitLab project the student confirmed. GitLab is
 * never assumed. Support pages start unchosen.
 */
export function initialDraft(record: TaskWorkspaceRecord | null, targets: readonly Target[]): Draft {
  if (record) return { work: record.choices.work, support: [...record.choices.support], pages: [...record.choices.pages] };
  // Only confirmed evidence is pre-selected: a course section, a source check or a course
  // GitLab link never becomes the work page without the student choosing it.
  const work = targets.find(t => t.external && t.evidence.source === "assignment_link" && t.evidence.confirmed)
    ?? targets.find(t => t.evidence.source === "gitlab_choice");
  return { work: work?.key ?? null, support: [], pages: [] };
}
export function placementOf(draft: Draft, key: string): Placement {
  return draft.work === key ? "right" : draft.support.includes(key) ? "own" : "off";
}
export function place(draft: Draft, key: string, placement: Placement): Draft {
  const support = draft.support.filter(k => k !== key);
  // One right window: the page it replaces is no longer opened.
  if (placement === "right") return { ...draft, work: key, support };
  return { ...draft, work: draft.work === key ? null : draft.work, support: placement === "own" ? [...support, key] : support };
}
/**
 * Places a page. A source-check suggestion the student places becomes one of their
 * own pages (kept for Continue); set back to Don't open, it is dropped again.
 */
export function choose(draft: Draft, target: Pick<Target, "key" | "url" | "label" | "evidence">, placement: Placement): Draft {
  const next = place(draft, target.key, placement);
  if (target.evidence.source !== "source_check" && !(target.key.startsWith("page:") && draft.pages.some(p => p.url === target.url && p.via === "source_check"))) return next;
  const others = next.pages.filter(p => p.url !== target.url);
  return { ...next, pages: placement === "off" ? others : [...others, { url: target.url, title: target.label, via: "source_check" as const }].slice(0, 10) };
}
/** The windows to open, in role order, with the instructions always first on the left. */
export function windowPages(resource: Pick<ResourceView, "url" | "title">, set: WorkSet | null, targets: readonly Target[], draft: Draft): TaskWindowPage[] {
  const instructions = set?.items.find(item => item.role === "instructions");
  const url = instructions?.target.kind === "web" ? instructions.target.url : resource.url;
  const pages: TaskWindowPage[] = [{ key: "instructions", role: "instructions", url, title: resource.title, origin: "work_set" }];
  const work = targets.find(t => t.key === draft.work);
  if (work) pages.push({ key: work.key, role: "work", url: work.url, title: work.label, origin: work.origin });
  for (const t of targets) if (t.key !== draft.work && draft.support.includes(t.key)) pages.push({ key: t.key, role: "support", url: t.url, title: t.label, origin: t.origin });
  return pages.slice(0, 8);
}
/** Saved choices the current capture no longer offers. They stay saved but are not opened. */
export function missingChoices(draft: Draft, targets: readonly Target[], known: boolean) {
  if (!known) return [];
  const offered = new Set(targets.map(t => t.key));
  return [draft.work, ...draft.support].filter((key): key is string => !!key && !offered.has(key));
}

export type Stage = "first_open" | "continue";
export function stageOf(record: TaskWorkspaceRecord | null): Stage { return record ? "continue" : "first_open"; }
export function instructionsChanged(record: TaskWorkspaceRecord | null, resource: Pick<ResourceView, "contentHash">) {
  return !!record && record.instructionsHash !== resource.contentHash;
}

/** Window outcomes from the app, as receipts. */
export function windowReceipts(outcomes: readonly TaskWindowOutcome[], pages: readonly Pick<TaskWindowPage, "key" | "title">[]): TargetReceipt[] {
  return outcomes.map(o => ({ key: o.key, label: pages.find(p => p.key === o.key)?.title || o.key, state: o.state, detail: o.detail }));
}
/** Fallback link handoff: success means the OS accepted it, nothing more. */
export function linkReceipt(page: Pick<TaskWindowPage, "key" | "title">, error?: unknown): TargetReceipt {
  if (error === undefined) return { key: page.key, label: page.title, state: "handed_off", detail: "Your browser chose where it opened." };
  const raw = error instanceof Error ? error.message : String(error);
  if (/headless/i.test(raw)) return { key: page.key, label: page.title, state: "test_only", detail: "Verification mode: external windows are off." };
  if (/Only https|Invalid link|ordinary web links/i.test(raw)) return { key: page.key, label: page.title, state: "not_sent", detail: "This link can't be opened from Magic." };
  return { key: page.key, label: page.title, state: "unconfirmed", detail: "Your default browser didn't confirm the link." };
}
/** Merge remembered windows: an action's result replaces what it rechecked. */
export function mergeWindows(previous: readonly TaskWindowRef[], next: readonly TaskWindowRef[], replace: boolean) {
  const kept = replace ? [] : previous.filter(w => !next.some(n => n.key === w.key));
  return [...kept, ...next].slice(0, 8);
}

export const STATE_LABEL: Record<TargetState, string> = {
  handed_off: "Sent to your browser",
  unconfirmed: "Not confirmed",
  new_window: "In its own window",
  new_window_unplaced: "New window, not placed",
  not_observed: "Window not seen",
  focused: "Brought forward",
  present: "Still open",
  closed: "Closed",
  still_open: "Still open",
  missing: "Window closed",
  ambiguous: "Left alone",
  not_sent: "Not sent",
  test_only: "Test only",
};
/** One sentence for the Continue header. Never claims pages loaded or work happened. */
export function lastOpenLine(last: LastOpen | null, now = new Date()): string {
  if (!last) return "Saved. Nothing has been opened from this setup yet.";
  const when = relativeWhen(last.at, now);
  const good = new Set<TargetState>(["handed_off", "new_window", "new_window_unplaced", "focused", "present"]);
  const sent = last.targets.filter(t => good.has(t.state)).length;
  const other = last.targets.length - sent;
  if (!last.targets.length) return `Last opened ${when}.`;
  const parts = [sent ? `${sent} opened` : "", other ? `${other} need${other === 1 ? "s" : ""} a look` : ""].filter(Boolean);
  return `Last opened ${when}: ${parts.join(", ")}.`;
}
function relativeWhen(iso: string, now: Date) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "at an unknown time";
  const sameDay = date.toDateString() === now.toDateString();
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
  if (sameDay) return `today at ${time}`;
  return `${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date)} at ${time}`;
}

export function recordFrom(input: {
  previous: TaskWorkspaceRecord | null; accountScope: string; resource: Pick<ResourceView, "id" | "courseId" | "contentHash">;
  draft: Draft; gitlab: GitlabChoice; last?: LastOpen | null; windows?: TaskWindowRef[]; now?: Date;
}): TaskWorkspaceRecord {
  return {
    v: 1, accountScope: input.accountScope, courseId: input.resource.courseId, resourceId: input.resource.id,
    savedAt: (input.now ?? new Date()).toISOString(), instructionsHash: input.resource.contentHash,
    choices: { gitlab: input.gitlab, work: input.draft.work, support: [...new Set(input.draft.support)].slice(0, 20), pages: input.draft.pages.slice(0, 10) },
    windows: input.windows ?? input.previous?.windows ?? [],
    last: input.last === undefined ? input.previous?.last ?? null : input.last,
  };
}
