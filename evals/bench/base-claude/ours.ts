/**
 * Our side of the ingestion head-to-head.
 *
 * - `runOursSession`: the app's own ingestion code (createIngestion with the app's acquisition
 *   options, the Canvas connector, document extraction in worker threads, and core's job drain) run
 *   in this process, reading Canvas through a bench transport: the operator's signed-in bench browser
 *   behind the read-only proxy (live) or the synthetic replica (dry run). This is what lets three
 *   fresh-database runs share one Duo sign-in with the baseline.
 * - `runOursApp`: the shipped Electron app with a fresh data folder, its own sign-in window and the
 *   MAGIC_TRIAL_LOG; one run per sign-in.
 * - `exportOurs`: our store projected onto the target schema, the same tables the gold and the
 *   baseline use. Deep tables only for the courses our app includes as current.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { captureBatchSchema, type Resource, type Store } from "@magic/contracts";
import { createLocalCourseExtractor } from "@magic/ai";
import fixture from "../../../fixtures/course.json";
import { ACQUISITION_APP, createIngestion } from "../../../apps/desktop/src/ingestion";
import { canvasFileDownloadUrl } from "../../../packages/connectors/src/canvas-file-download";
import { createPublicClient, type PublicClient } from "../../../packages/connectors/src/network";
import { courseInclusion } from "../../../packages/core/src/access";
import { pipelineJobRegistry } from "../../../packages/core/src/jobs/default-registry";
import type { AssignmentRow, FileRow, PageRow, TargetRows } from "./schema";
import { snapshotDb, writeTargetDb } from "./schema";
import type { Snapshot } from "./score";
import type { CanvasTransport } from "./transport";

const ORIGIN = "https://canvas.wisc.edu";

export function exportOurs(store: Store): TargetRows {
  const sources = new Map(store.sources().map((s) => [s.id, s]));
  const all = store.resources().filter((r) => !r.deleted && sources.get(r.sourceId)?.kind === "canvas");
  const included = courseInclusion(store, all);
  const scope = (r: Resource) => sources.get(r.sourceId)?.scope ?? "";
  const courseRows = all.filter((r) => r.kind === "course" && scope(r) === "course");
  const current = new Set(courseRows.filter((r) => included(r)).map((r) => r.courseId));
  const deep = all.filter((r) => current.has(r.courseId));
  const rows: TargetRows = { courses: [], modules: [], module_items: [], assignment_groups: [], assignments: [], pages: [], files: [], syllabus: [] };

  for (const r of courseRows)
    rows.courses.push({ id: r.courseId, name: r.courseName, course_code: r.course?.courseCode ?? null, term: r.course?.termName ?? null, is_current: current.has(r.courseId) ? 1 : 0 });
  for (const r of deep.filter((x) => scope(x) === "modules"))
    rows.modules.push({ id: r.module?.id ?? r.externalId, course_id: r.courseId, name: r.title, position: r.module?.position ?? null });
  for (const r of deep.filter((x) => scope(x).startsWith("module-items:")))
    rows.module_items.push({
      id: r.externalId, module_id: scope(r).slice("module-items:".length), course_id: r.courseId, title: r.moduleItem?.title ?? r.title,
      type: r.moduleItem?.type ?? "", content_id: r.moduleItem?.contentId ?? null, page_url: r.moduleItem?.pageUrl ?? null, position: r.moduleItem?.position ?? null,
    });
  for (const r of deep.filter((x) => scope(x) === "assignment-groups"))
    rows.assignment_groups.push({ id: r.externalId, course_id: r.courseId, name: r.title, weight: r.assignmentGroup?.weight ?? null });

  // Assignments: the course's assignment list first; the account to-do and upcoming reads fill gaps.
  const assignments = new Map<string, AssignmentRow>();
  const assignmentScopes = ["assignments", "account-todo", "account-upcoming-events"];
  for (const s of assignmentScopes)
    for (const r of deep.filter((x) => x.kind === "assignment" && scope(x) === s)) {
      if (assignments.has(r.externalId)) continue;
      const due = r.dueAt ?? r.deadlines.find((d) => d.kind === "due")?.value ?? null;
      assignments.set(r.externalId, {
        id: r.externalId, course_id: r.courseId, name: r.title, due_at: due, points_possible: r.points ?? null,
        assignment_group_id: r.assignmentGroupId ?? null, description: r.text || null,
      });
    }
  rows.assignments = [...assignments.values()];

  // Pages: bodies from page:/linked-page: reads; list rows only where no body was read.
  const pages = new Map<string, PageRow>();
  const slugOf = (url: string, courseId: string) => {
    const m = url.match(new RegExp(`/courses/${courseId}/pages/([^/?#]+)$`));
    if (!m) return undefined;
    try {
      return decodeURIComponent(m[1]!);
    } catch {
      return m[1]!;
    }
  };
  for (const r of deep.filter((x) => scope(x).startsWith("page:") || scope(x).startsWith("linked-page:"))) {
    const slug = slugOf(r.url, r.courseId);
    if (slug) pages.set(`${r.courseId}/${slug}`, { course_id: r.courseId, url: slug, title: r.title, updated_at: r.updatedAt ?? null, body_text: r.text });
  }
  for (const r of deep.filter((x) => scope(x) === "pages")) {
    const slug = slugOf(r.url, r.courseId);
    if (slug && !pages.has(`${r.courseId}/${slug}`)) pages.set(`${r.courseId}/${slug}`, { course_id: r.courseId, url: slug, title: r.title, updated_at: r.updatedAt ?? null, body_text: null });
  }
  rows.pages = [...pages.values()];

  // Files: metadata from the file:<id> reads and the Files list; text from the document:<id> reads.
  const files = new Map<string, FileRow>();
  for (const r of deep.filter((x) => x.file?.id && (scope(x) === "files" || scope(x).startsWith("file:")))) {
    const id = r.file!.id!;
    const prior = files.get(id);
    files.set(id, {
      id, course_id: r.courseId, display_name: r.file?.displayName ?? r.title, content_type: r.file?.contentType ?? null,
      size: r.file?.size ?? null, updated_at: r.file?.updatedAt ?? null, text: prior?.text ?? null,
    });
  }
  for (const r of deep.filter((x) => scope(x).startsWith("document:"))) {
    const id = scope(r).slice("document:".length);
    const row = files.get(id) ?? {
      id, course_id: r.courseId, display_name: r.file?.displayName ?? r.title, content_type: r.file?.contentType ?? null,
      size: r.file?.size ?? null, updated_at: r.file?.updatedAt ?? null, text: null,
    };
    row.text = r.text || row.text;
    files.set(id, row);
  }
  rows.files = [...files.values()];

  // Syllabus: a substantive syllabus body, else the syllabus page, else the syllabus file.
  for (const courseId of current) {
    const body = deep.find((r) => r.courseId === courseId && r.externalId === "syllabus" && scope(r) === "syllabus");
    const page = rows.pages.find((p) => p.course_id === courseId && /syllabus/i.test(p.title) && (p.body_text ?? "").trim());
    const file = rows.files.filter((f) => f.course_id === courseId && /syllabus/i.test(f.display_name) && (f.text ?? "").trim()).sort((a, b) => a.id.localeCompare(b.id))[0];
    const bodyText = body?.text?.trim() ?? "";
    if (bodyText.length >= 200) rows.syllabus.push({ course_id: courseId, source: "syllabus_body", text: bodyText });
    else if (page) rows.syllabus.push({ course_id: courseId, source: "page", text: page.body_text! });
    else if (file) rows.syllabus.push({ course_id: courseId, source: "file", text: file.text! });
    else if (bodyText) rows.syllabus.push({ course_id: courseId, source: "syllabus_body", text: bodyText });
  }
  return rows;
}

function assignmentSnapshot(store: Store, ms: number): Snapshot {
  const rows = exportOurs(store);
  return {
    ms,
    counts: Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, (v as unknown[]).length])),
    assignments: rows.assignments.map((a) => [a.id, a.due_at, a.points_possible]),
  };
}

/** The app's canvasFetch over a bench transport: API reads as JSON, course-file downloads as bytes. */
export function benchCanvasFetch(transport: CanvasTransport) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal ?? undefined;
    if (canvasFileDownloadUrl(url, ORIGIN)) {
      const r = await transport.download(url, signal);
      if (r.status !== 200)
        return new Response("", { status: 502, headers: { "x-magic-cause": r.status === 401 ? "login_page" : "http_error", "x-magic-cause-status": String(r.status) } });
      return new Response(new Uint8Array(r.bytes), { headers: { "content-type": r.contentType, "x-magic-host-class": "canvas" } });
    }
    const r = await transport.get(url, signal);
    const headers = new Headers();
    for (const [k, v] of Object.entries(r.headers)) if (!/^(content-encoding|content-length|transfer-encoding|connection)$/i.test(k)) headers.set(k, v);
    return new Response([204, 205, 304].includes(r.status) ? null : r.body, { status: r.status, headers });
  };
}

/** Public web reads are outside the target schema: refused in the bench, on both sides. */
function refusingClient(): PublicClient {
  return createPublicClient({
    lookup: async () => [{ address: "0.0.0.0", family: 4 }],
    transport: async () => {
      throw new Error("bench: public web reads are not part of this benchmark");
    },
  });
}

export interface OursRun {
  side: "ours";
  mode: "session" | "app";
  wallMs: number;
  syncMs: number;
  derivationMs: number | null;
  agendaUsableMs?: number | null;
  requests: number;
  tokens: { input: number; cached: number; output: number; calls: number };
  usd: 0;
  dbPath: string;
  targetDb: string;
  timeline: Snapshot[];
  documentRun?: unknown;
  repeat?: { wallMs: number; requests: number; tokens: number; changedResources: number; targetDb: string };
}

export async function runOursSession(options: {
  transport: CanvasTransport;
  directory: string;
  /** Change the source between the first and the repeat sync (dry run), then sync again. */
  beforeRepeat?: () => Promise<unknown> | unknown;
  repeat?: boolean;
  localExtractor?: boolean;
  derivationCapMs?: number;
  log?: (line: string) => void;
}): Promise<OursRun> {
  const log = options.log ?? (() => {});
  mkdirSync(options.directory, { recursive: true });
  const dbPath = join(options.directory, "workspace.sqlite");
  rmSync(dbPath, { force: true });
  const store = createStore(dbPath);
  const core = createCore(store, {
    fixture: captureBatchSchema.parse(fixture),
    ...(options.localExtractor === false ? {} : { courseExtractor: createLocalCourseExtractor() }),
    jobs: pipelineJobRegistry(),
  });
  const canvasFetch = benchCanvasFetch(options.transport);
  const ingestion = createIngestion(store, {
    directory: options.directory,
    secrets: async () => ({}),
    client: refusingClient(),
    canvasFetch,
    onSaved: (sourceId) => void core.saved(sourceId),
    acquisition: ACQUISITION_APP,
    extractWorkerScript: resolve(new URL("../../../tests/fix-acq-extract-worker.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  });
  ingestion.presence(true);
  const timeline: Snapshot[] = [];
  const started = performance.now();
  const sample = setInterval(() => {
    try {
      timeline.push(assignmentSnapshot(store, Math.round(performance.now() - started)));
    } catch {}
  }, 1000);
  try {
    const run = await ingestion.tick("manual");
    const syncMs = Math.round(performance.now() - started);
    clearInterval(sample);
    timeline.push(assignmentSnapshot(store, syncMs));
    log(`ours: first sync ${run?.action ?? "no run"} in ${syncMs} ms, ${options.transport.requests()} requests`);
    // The drain's derivation (passages, links, facts) is reported separately and never holds the
    // sync result: a drain that has not settled within the cap is recorded as null.
    let derivationMs: number | null = null;
    const cap = options.derivationCapMs ?? 120_000;
    // The cap timer is cleared when the drain settles first; left running it kept the process alive
    // for the whole cap after the run had finished (the dry run's apparent hang).
    let capTimer: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      core.settled().then(() => true),
      new Promise<false>((r) => (capTimer = setTimeout(() => r(false), cap))),
    ]).finally(() => clearTimeout(capTimer));
    if (settled) derivationMs = Math.round(performance.now() - started);
    const targetDb = join(options.directory, "target.sqlite");
    rmSync(targetDb, { force: true });
    writeTargetDb(targetDb, exportOurs(store));
    const ledger = () => {
      try {
        return (store as unknown as { ledger(n: number): Array<{ tokensIn: number; tokensCached: number; tokensOut: number }> }).ledger(5000);
      } catch {
        return [];
      }
    };
    const first = ledger();
    const result: OursRun = {
      side: "ours", mode: "session", wallMs: Math.round(performance.now() - started), syncMs, derivationMs,
      requests: options.transport.requests(),
      tokens: { input: first.reduce((a, e) => a + e.tokensIn, 0), cached: first.reduce((a, e) => a + e.tokensCached, 0), output: first.reduce((a, e) => a + e.tokensOut, 0), calls: first.length },
      usd: 0, dbPath, targetDb, timeline, documentRun: ingestion.documentRun(),
    };
    if (options.repeat) {
      await options.beforeRepeat?.();
      const before = new Map(store.resources().map((r) => [r.id, r.contentHash]));
      const requestsBefore = options.transport.requests();
      const again = performance.now();
      await ingestion.tick("manual");
      const repeatDb = join(options.directory, "target-repeat.sqlite");
      rmSync(repeatDb, { force: true });
      writeTargetDb(repeatDb, exportOurs(store));
      result.repeat = {
        wallMs: Math.round(performance.now() - again),
        requests: options.transport.requests() - requestsBefore,
        tokens: ledger().length - first.length,
        changedResources: store.resources().filter((r) => before.get(r.id) !== r.contentHash).length,
        targetDb: repeatDb,
      };
      log(`ours: repeat sync in ${result.repeat.wallMs} ms, ${result.repeat.requests} requests, ${result.repeat.changedResources} resources changed`);
    }
    return result;
  } finally {
    clearInterval(sample);
    await ingestion.closeExtraction();
    await ingestion.stop();
    await core.close();
  }
}

/**
 * The shipped app, operator-present: a fresh data folder, the app's own sign-in window, the trial
 * log. Waits for the first sync after sign-in, then asks for the repeat (the app's Refresh button).
 */
export async function runOursApp(options: {
  root: string;
  directory: string;
  prompt: (message: string) => Promise<void>;
  timeoutMs: number;
  log: (line: string) => void;
}): Promise<OursRun> {
  const userData = join(options.directory, "userData");
  mkdirSync(userData, { recursive: true });
  const trial = join(options.directory, "trial-log.jsonl");
  const electron = resolve(options.root, "node_modules/electron/dist", process.platform === "win32" ? "electron.exe" : process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : "electron");
  if (!existsSync(join(options.root, "apps/desktop/dist/main.js")) && !existsSync(join(options.root, "apps/desktop/dist/main.cjs")))
    throw new Error("The app is not built: run `pnpm build` first.");
  const child = spawn(electron, [join(options.root, "apps/desktop")], {
    env: { ...process.env, MAGIC_USER_DATA: userData, MAGIC_TRIAL_LOG: trial },
    stdio: "ignore",
  });
  const db = join(userData, "workspace.sqlite");
  const events = () => (existsSync(trial) ? readFileSync(trial, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { at: string; event: string; service?: string }) : []);
  const runs = () => {
    if (!existsSync(db)) return [];
    const copy = join(options.directory, "poll.sqlite");
    rmSync(copy, { force: true });
    try {
      snapshotDb(db, copy);
      const store = createStore(copy);
      try {
        return store.syncRuns();
      } finally {
        store.close();
      }
    } catch {
      return [];
    }
  };
  const exportSnapshot = (target: string) => {
    const copy = join(options.directory, "final.sqlite");
    rmSync(copy, { force: true });
    snapshotDb(db, copy);
    const store = createStore(copy);
    try {
      rmSync(target, { force: true });
      writeTargetDb(target, exportOurs(store));
      return assignmentSnapshot(store, 0);
    } finally {
      store.close();
    }
  };
  const deadline = Date.now() + options.timeoutMs;
  const wait = async (condition: () => boolean, what: string) => {
    while (!condition()) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`ours (app): gave up waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  };
  try {
    options.log("ours (app): the app is opening. Accept the consent, then sign in with your NetID and Duo in the app's window.");
    await wait(() => events().some((e) => e.event === "signin.confirmed"), "sign-in");
    const signedAt = Date.parse(events().find((e) => e.event === "signin.confirmed")!.at);
    const timeline: Snapshot[] = [];
    await wait(() => {
      const snap = existsSync(db) ? (() => { try { return exportSnapshot(join(options.directory, "timeline.sqlite")); } catch { return undefined; } })() : undefined;
      if (snap) timeline.push({ ...snap, ms: Date.now() - signedAt });
      return runs().some((r) => Date.parse(r.startedAt) >= signedAt - 60_000 && r.finishedAt);
    }, "the first sync");
    const first = runs().filter((r) => Date.parse(r.startedAt) >= signedAt - 60_000).sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0]!;
    const syncMs = Date.parse(first.finishedAt) - signedAt;
    const targetDb = join(options.directory, "target.sqlite");
    timeline.push({ ...exportSnapshot(targetDb), ms: syncMs });
    const fetches = (from: number, to: number) => events().filter((e) => e.event === "fetch" && e.service === "canvas" && Date.parse(e.at) >= from && Date.parse(e.at) <= to).length;
    const result: OursRun = {
      side: "ours", mode: "app", wallMs: syncMs, syncMs, derivationMs: null, requests: fetches(signedAt, Date.parse(first.finishedAt)),
      tokens: { input: 0, cached: 0, output: 0, calls: 0 }, usd: 0, dbPath: db, targetDb, timeline,
    };
    await options.prompt("ours (app): first sync done. Press Refresh in the app now for the repeat sync, then press Enter here.");
    await wait(() => runs().filter((r) => Date.parse(r.startedAt) > Date.parse(first.finishedAt) && r.finishedAt).length > 0, "the repeat sync");
    const second = runs().filter((r) => Date.parse(r.startedAt) > Date.parse(first.finishedAt)).sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0]!;
    const repeatDb = join(options.directory, "target-repeat.sqlite");
    exportSnapshot(repeatDb);
    result.repeat = {
      wallMs: Date.parse(second.finishedAt) - Date.parse(second.startedAt), requests: fetches(Date.parse(second.startedAt), Date.parse(second.finishedAt)),
      tokens: 0, changedResources: 0, targetDb: repeatDb,
    };
    return result;
  } finally {
    child.kill();
  }
}
