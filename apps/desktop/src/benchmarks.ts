// owner: benchmarks. Local benchmarks: the worker measures each full run the app actually makes
// (a manual or sign-in sync, the six-hour backstop, a planning refresh, or "Run benchmark") and
// banks it in its own file, userData/benchmarks.sqlite, beside the workspace. The metrics follow
// MS1 "backend speed" (docs/plans/2026-09-26-backend-optimization/plan.md §1) on the student's
// real data: wall time per phase and course, requests and bytes, time to the first useful item,
// the material pipeline's drain, the stored outcome and query latency.
//
// Content-free by construction: the recorder classifies each request as it passes and keeps only
// the service, phase, numeric course id, status, size and time. Never a URL, host, title or text.
// A separate file keeps the workspace schema untouched; "Delete local data" clears it too.
import { chmodSync, statSync } from "node:fs";
import { cpus, totalmem, platform, arch } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  BENCHMARK_RECORD_VERSION,
  type BenchmarkCourse,
  type BenchmarkMachine,
  type BenchmarkPhase,
  type BenchmarkRun,
  type BenchmarkStatus,
  type BenchmarkStatusNow,
  type BenchmarkSummary,
  type BenchmarkTrigger,
  type Resource,
  type SourceHealth,
  type Store,
} from "@magic/contracts";
import type { PassageSearchInput, PassageSearchResult } from "../../../packages/contracts/src/course-core";
import type { JobRegistry } from "../../../packages/core/src/jobs/registry";
import type { DrainReport } from "../../../packages/core/src/drain";
import type { RefreshRun } from "../../../packages/core/src/refresh";
import { SCHEMA_VERSION } from "../../../packages/storage/src/index";
import { QUERIES } from "../../../evals/perf/synthetic";
import type { PublicClient } from "../../../packages/connectors/src/network";

const MAX_RUNS = 2000;
const DRAIN_WAIT_MS = 15 * 60_000;
const DRAIN_POLL_MS = 2_000;

// ---------------------------------------------------------------------------------------------
// The bank: one row per run, the record as JSON. Its own schema version, independent of the store.
export function createBenchmarkBank(path: string) {
  const db = new DatabaseSync(path);
  try {
    chmodSync(path, 0o600);
  } catch {}
  // Rollback journal, not WAL: rare small writes, and "clear" leaves no old pages in a side file.
  db.exec(`CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, started_at TEXT NOT NULL, trigger TEXT NOT NULL, status TEXT NOT NULL,
      summary TEXT NOT NULL, record TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS runs_started ON runs (started_at);
    PRAGMA user_version = 1;`);
  const insert = db.prepare("INSERT OR REPLACE INTO runs (id, started_at, trigger, status, summary, record) VALUES (?, ?, ?, ?, ?, ?)");
  const prune = db.prepare(`DELETE FROM runs WHERE id NOT IN (SELECT id FROM runs ORDER BY started_at DESC LIMIT ${MAX_RUNS})`);
  const list = db.prepare("SELECT summary FROM runs ORDER BY started_at DESC LIMIT ?");
  const get = db.prepare("SELECT record FROM runs WHERE id = ?");
  return {
    add(run: BenchmarkRun) {
      insert.run(run.id, run.startedAt, run.trigger, run.status, JSON.stringify(summarize(run)), JSON.stringify(run));
      prune.run();
    },
    list(limit = 200): BenchmarkSummary[] {
      return (list.all(limit) as Array<{ summary: string }>).map((row) => JSON.parse(row.summary));
    },
    get(id: string): BenchmarkRun | null {
      const row = get.get(id) as { record: string } | undefined;
      return row ? (JSON.parse(row.record) as BenchmarkRun) : null;
    },
    clear() {
      db.exec("DELETE FROM runs; VACUUM;");
    },
    close() {
      db.close();
    },
  };
}
export type BenchmarkBank = ReturnType<typeof createBenchmarkBank>;

export function summarize(run: BenchmarkRun): BenchmarkSummary {
  return {
    id: run.id,
    trigger: run.trigger,
    status: run.status,
    startedAt: run.startedAt,
    wallMs: run.sync?.wallMs ?? run.planning?.wallMs ?? null,
    pipelineMs: run.pipeline?.waitedMs ?? null,
    requests: run.sync?.requests.total ?? run.planning?.requests ?? null,
    resources: run.outcome?.resources ?? null,
    courses: run.outcome?.courses ?? null,
  };
}

// ---------------------------------------------------------------------------------------------
// Request classification: done once, as the request passes; only the result is kept.
export interface RequestFact {
  service: string;
  phase: string;
  courseId: string | null;
  status: number | null;
  bytes: number;
  ms: number;
  failed: boolean;
  atMs: number;
}
export function classifyRequest(service: string, url: string): { service: string; phase: string; courseId: string | null } {
  let path = "";
  try {
    path = new URL(url).pathname;
  } catch {}
  const course = /\/courses\/(\d+)(?:\/|$)/.exec(path)?.[1] ?? null;
  if (service === "canvas") {
    if (/\/files\/\d+\/download$/.test(path)) return { service: "download", phase: "documents", courseId: course };
    if (/^\/api\/v1\/files\/\d+$/.test(path) || /\/files$|\/folders$/.test(path)) return { service: "canvas", phase: "documents", courseId: course };
    if (/\/pages(?:\/|$)/.test(path)) return { service: "canvas", phase: "canvas-pages", courseId: course };
    return { service: "canvas", phase: "canvas-lists", courseId: course };
  }
  if (service === "gitlab") return { service, phase: "gitlab", courseId: null };
  if (service === "space") return { service, phase: "access-checks", courseId: null };
  if (service === "feed") return { service, phase: "calendar", courseId: null };
  if (service === "download") return { service, phase: "documents", courseId: null };
  return { service, phase: "websites", courseId: null };
}
function phaseOfSource(source: Pick<SourceHealth, "kind" | "scope">): string {
  const scope = (source.scope ?? "").split(":")[0];
  if (source.kind === "web") return "websites";
  if (source.kind === "gitlab") return "gitlab";
  if (source.kind === "calendar") return "calendar";
  if (scope === "document" || scope === "file" || scope === "files" || scope === "folders") return "documents";
  if (scope === "page" || scope === "linked-page" || scope === "pages") return "canvas-pages";
  return "canvas-lists";
}
const percentile = (values: number[], p: number): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! * 10) / 10;
};
const bump = (map: Record<string, number>, key: string, by = 1) => {
  map[key] = (map[key] ?? 0) + by;
};

export function requestStats(requests: RequestFact[]) {
  const byService: Record<string, { requests: number; bytes: number; failed: number }> = {};
  const byStatus: Record<string, number> = {};
  for (const r of requests) {
    const s = (byService[r.service] ??= { requests: 0, bytes: 0, failed: 0 });
    s.requests++;
    s.bytes += r.bytes;
    if (r.failed) s.failed++;
    bump(byStatus, r.status == null ? "error" : String(r.status));
  }
  const times = requests.map((r) => r.ms);
  return {
    total: requests.length,
    failed: requests.filter((r) => r.failed).length,
    bytes: requests.reduce((n, r) => n + r.bytes, 0),
    p50Ms: percentile(times, 0.5),
    p95Ms: percentile(times, 0.95),
    byService,
    byStatus,
  };
}

// ---------------------------------------------------------------------------------------------
// The recorder.
export interface BenchmarkDeps {
  store: Store & { searchPassages?(input: PassageSearchInput): PassageSearchResult };
  dbPath: string;
  bank: BenchmarkBank;
  registry: JobRegistry;
  pipelineTotals(): DrainReport;
  present(): boolean;
  now?: () => Date;
  drainWaitMs?: number;
  drainPollMs?: number;
}
interface Context {
  id: string;
  trigger: BenchmarkTrigger;
  startedAt: string;
  start: number;
  requests: RequestFact[];
  saves: Array<{ sourceId: string; atMs: number }>;
  lastPhase: string | null;
  totalsAtStart: DrainReport;
  generation: number;
  finalized: Promise<BenchmarkRun | null>;
}

export function createBenchmarkRecorder(deps: BenchmarkDeps) {
  const now = deps.now ?? (() => new Date());
  let active: (Context & { done: Promise<void>; resolveDone(): void; resolveFinal(value: BenchmarkRun | null): void }) | undefined;
  let armed: ((context: Context) => void) | undefined;
  let benchmark: Promise<BenchmarkRun | null> | undefined;
  let waiting: { context: Context; syncs: number } | undefined;
  let closed = false;
  // "Delete local data" bumps this: a run measured before it is never banked after it.
  let generation = 0;
  let readDb: DatabaseSync | undefined;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const sql = <T>(query: string, ...params: Array<string | number>): T[] | null => {
    if (closed) return null;
    try {
      readDb ??= new DatabaseSync(deps.dbPath, { readOnly: true });
      return readDb.prepare(query).all(...params) as T[];
    } catch {
      return null;
    }
  };
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        resolve();
      }, ms);
      timers.add(timer);
    });

  function machine(): BenchmarkMachine {
    const cpu = cpus();
    return {
      platform: platform(),
      arch: arch(),
      cpu: cpu[0]?.model.trim() ?? "unknown",
      cores: cpu.length,
      memoryGb: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
      electron: process.versions.electron ?? null,
      node: process.versions.node,
      appVersion: process.env.MAGIC_APP_VERSION || null,
      schemaVersion: SCHEMA_VERSION,
    };
  }

  function jobCounts() {
    const rows = sql<{ kind: string; status: string; n: number }>("SELECT kind, status, COUNT(*) AS n FROM jobs GROUP BY kind, status") ?? [];
    const jobs: Record<string, Record<string, number>> = {};
    for (const row of rows) (jobs[row.kind] ??= {})[row.status] = Number(row.n);
    return jobs;
  }
  const available = (kind: string) => {
    const handler = deps.registry.get(kind);
    if (!handler || !handler.ready) return false;
    try {
      return handler.available ? handler.available({ store: deps.store }) : true;
    } catch {
      return false;
    }
  };
  /** Due jobs of kinds that can run here (pending or leased, not waiting on a retry time). */
  function dueJobs(): number {
    const rows = sql<{ kind: string; n: number }>(
      "SELECT kind, COUNT(*) AS n FROM jobs WHERE status IN ('pending','running') AND (run_after IS NULL OR run_after <= ?) GROUP BY kind",
      now().toISOString(),
    );
    if (!rows) return 0;
    return rows.filter((row) => available(row.kind)).reduce((n, row) => n + Number(row.n), 0);
  }

  async function waitForDrain(context: Context) {
    const started = performance.now();
    const presentAtStart = deps.present();
    const watch = { context, syncs: 0 };
    waiting = watch;
    let drained = false;
    const limit = deps.drainWaitMs ?? DRAIN_WAIT_MS;
    // Jobs are enqueued as each source is saved, so nothing due now means nothing to drain.
    while (!closed && context.generation === generation && performance.now() - started < limit) {
      if (dueJobs() === 0) {
        drained = true;
        break;
      }
      await sleep(deps.drainPollMs ?? DRAIN_POLL_MS);
    }
    if (waiting === watch) waiting = undefined;
    const totals = deps.pipelineTotals();
    const jobs = jobCounts();
    let unavailablePending = 0;
    for (const [kind, statuses] of Object.entries(jobs))
      if (!available(kind)) unavailablePending += (statuses.pending ?? 0) + (statuses.running ?? 0);
    return {
      waitedMs: Math.round(performance.now() - started),
      drained,
      done: totals.done - context.totalsAtStart.done,
      failed: totals.failed - context.totalsAtStart.failed,
      jobs,
      unavailablePending,
      presentAtStart,
      syncsDuringWait: watch.syncs,
    };
  }

  function outcome(resources: Resource[], sources: SourceHealth[]) {
    const byKind: Record<string, number> = {};
    const sourceKind = new Map(sources.map((s) => [s.id, s.kind]));
    const statuses: Record<string, number> = {};
    for (const s of sources) bump(statuses, s.status);
    let documents = 0,
      documentsWithText = 0,
      webPages = 0;
    const courses = new Set<string>();
    for (const r of resources) {
      bump(byKind, r.kind);
      if (r.kind === "course") courses.add(r.courseId);
      if (r.document) {
        documents++;
        if (r.document.extractionStatus === "ok" && r.text.trim()) documentsWithText++;
      }
      if (sourceKind.get(r.sourceId) === "web") webPages++;
    }
    const count = (table: string) => Number(sql<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.[0]?.n ?? 0);
    const size = (path: string) => {
      try {
        return statSync(path).size;
      } catch {
        return 0;
      }
    };
    return {
      courses: courses.size,
      resources: resources.length,
      byKind,
      documents,
      documentsWithText,
      webPages,
      passages: count("passages"),
      facts: count("material_facts"),
      links: count("links"),
      sources: statuses,
      dbBytes: size(deps.dbPath),
      walBytes: size(`${deps.dbPath}-wal`),
    };
  }

  function queryTimes() {
    const time = (run: () => unknown) => {
      const t = performance.now();
      run();
      return performance.now() - t;
    };
    try {
      for (const q of QUERIES) deps.store.resources(q); // warm-up pass, as in evals/perf
      const plain = QUERIES.map((q) => time(() => deps.store.resources(q)));
      const passage = deps.store.searchPassages
        ? QUERIES.map((q) => time(() => deps.store.searchPassages!({ query: q, k: 10 })))
        : [];
      return {
        queries: QUERIES.length,
        p50Ms: percentile(plain, 0.5) ?? 0,
        p95Ms: percentile(plain, 0.95) ?? 0,
        passageP50Ms: percentile(passage, 0.5),
        passageP95Ms: percentile(passage, 0.95),
      };
    } catch {
      return null;
    }
  }

  function syncPart(context: Context, run: RefreshRun, sources: SourceHealth[], resources: Resource[], finishedMs: number) {
    const byId = new Map(sources.map((s) => [s.id, s]));
    const saved = new Map<string, number>();
    for (const save of context.saves) saved.set(save.sourceId, save.atMs);
    const savedSources = [...saved.keys()].flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    // Phases: first to last activity, from requests and saves together.
    const phases = new Map<string, BenchmarkPhase>();
    const touch = (phase: string, atMs: number, request?: RequestFact) => {
      const p = phases.get(phase) ?? { phase, firstMs: atMs, lastMs: atMs, requests: 0, bytes: 0, saves: 0 };
      p.firstMs = Math.min(p.firstMs, atMs);
      p.lastMs = Math.max(p.lastMs, atMs + (request?.ms ?? 0));
      if (request) {
        p.requests++;
        p.bytes += request.bytes;
      } else p.saves++;
      phases.set(phase, p);
    };
    for (const r of context.requests) touch(r.phase, r.atMs, r);
    for (const [id, atMs] of saved) {
      const source = byId.get(id);
      if (source) touch(phaseOfSource(source), atMs);
    }
    // Courses: requests by course id plus what the run saved for it.
    const courseIds = new Set<string>();
    for (const r of context.requests) if (r.courseId) courseIds.add(r.courseId);
    // A course counts once the run read something of it: past-term and non-course sites arrive
    // only as their own metadata row (scope "course") and are left out.
    for (const s of savedSources) if (/^\d+$/.test(s.courseId) && s.scope !== "course") courseIds.add(s.courseId);
    const courses: BenchmarkCourse[] = [...courseIds].sort().map((courseId) => {
      const requests = context.requests.filter((r) => r.courseId === courseId);
      const rows = resources.filter((r) => r.courseId === courseId);
      const web = savedSources.find((s) => s.courseId === courseId && s.kind === "web");
      const codes: Record<string, number> = {};
      for (const d of web?.diagnostics ?? []) bump(codes, d.code);
      const status: Record<string, number> = {};
      for (const s of savedSources) if (s.courseId === courseId && s.kind === "canvas") bump(status, s.status);
      return {
        courseId,
        requests: requests.length,
        bytes: requests.reduce((n, r) => n + r.bytes, 0),
        records: rows.length,
        documents: rows.filter((r) => r.document).length,
        webPages: rows.filter((r) => byId.get(r.sourceId)?.kind === "web").length,
        crawl: web ? { pages: web.stats?.pages ?? 0, durationMs: web.stats?.durationMs ?? null, codes } : null,
        sources: status,
      };
    });
    const diagnostics: Record<string, number> = {};
    for (const s of savedSources) for (const d of s.diagnostics ?? []) bump(diagnostics, d.code);
    const syncRun = deps.store.syncRuns().find((r) => r.startedAt === run.startedAt);
    return {
      wallMs: Math.round(finishedMs),
      action: run.action,
      needsSignIn: run.needsSignIn,
      firstValueMs: syncRun?.stats?.firstValueMs != null ? Math.round(syncRun.stats.firstValueMs) : null,
      nextWeekInstructionsMs: syncRun?.stats?.nextWeekInstructionsMs != null ? Math.round(syncRun.stats.nextWeekInstructionsMs) : null,
      phases: [...phases.values()].sort((a, b) => a.firstMs - b.firstMs),
      requests: requestStats(context.requests),
      courses,
      diagnostics,
      savedSources,
    };
  }

  async function finalize(context: Context, run: RefreshRun): Promise<BenchmarkRun | null> {
    const finishedMs = performance.now() - context.start;
    // Only full reads are banked (and every explicit benchmark): hot ticks and warm reads aren't
    // full runs, and a run that did nothing has nothing to measure.
    const full = run.action === "refreshed" && !run.warmCourses?.length;
    if (context.trigger !== "benchmark" && !full) return null;
    const sources = deps.store.sources();
    const syncResources = deps.store.resources().filter((r) => !r.deleted);
    const sync = syncPart(context, run, sources, syncResources, finishedMs);
    // A cancelled read is recorded by the coordinator as "failed"; the two can't be told apart here.
    const status: BenchmarkStatus = sync.needsSignIn
        ? "needs_sign_in"
        : run.action === "failed"
          ? "failed"
          : sync.savedSources.some((s) => !["ok", "inaccessible", "not_published"].includes(s.status))
            ? "partial"
            : "ok";
    if (closed || context.generation !== generation) return null;
    const pipeline = await waitForDrain(context);
    if (closed || context.generation !== generation) return null;
    const resources = deps.store.resources().filter((r) => !r.deleted);
    const record: BenchmarkRun = {
      v: BENCHMARK_RECORD_VERSION,
      id: context.id,
      trigger: context.trigger,
      status,
      startedAt: context.startedAt,
      finishedAt: now().toISOString(),
      machine: machine(),
      sync: (({ savedSources: _, ...rest }) => rest)(sync),
      planning: null,
      pipeline,
      outcome: outcome(resources, deps.store.sources()),
      query: queryTimes(),
    };
    if (closed || context.generation !== generation) return null;
    deps.bank.add(record);
    return record;
  }

  return {
    /** Ingestion's onRunStart: a read really begins (skipped ticks never get here). */
    started() {
      try {
        if (closed || active) return;
        const claim = armed;
        armed = undefined;
        let resolveDone!: () => void;
        const done = new Promise<void>((resolve) => (resolveDone = resolve));
        const context: Context & { done: Promise<void>; resolveDone(): void; resolveFinal(value: BenchmarkRun | null): void } = {
          id: randomUUID(),
          trigger: claim ? "benchmark" : "background",
          startedAt: now().toISOString(),
          start: performance.now(),
          requests: [],
          saves: [],
          lastPhase: null,
          totalsAtStart: { ...deps.pipelineTotals() },
          generation,
          finalized: Promise.resolve(null),
          done,
          resolveDone,
          resolveFinal: () => {},
        };
        context.finalized = new Promise((resolve) => (context.resolveFinal = resolve));
        if (waiting) waiting.syncs++;
        active = context;
        claim?.(context);
      } catch {
        active = undefined; // measuring must never stand in the way of a sync
      }
    },
    /** Ingestion's onRunEnd, after the run is recorded in sync_runs. */
    ended(run: RefreshRun) {
      const context = active;
      active = undefined;
      if (!context) return;
      if (context.trigger !== "benchmark") context.trigger = run.trigger === "manual" ? "manual" : "background";
      context.resolveDone();
      void finalize(context, run).then(context.resolveFinal, () => context.resolveFinal(null));
    },
    /** Called by the worker's source reads and the public client, as each request finishes. */
    request(service: string, url: string, outcome: { status?: number | null; bytes?: number; ms: number; failed?: boolean }) {
      if (!active) return;
      const kind = classifyRequest(service, url);
      active.lastPhase = kind.phase;
      active.requests.push({
        ...kind,
        status: outcome.status ?? null,
        bytes: outcome.bytes ?? 0,
        ms: Math.round(outcome.ms),
        failed: outcome.failed ?? (outcome.status == null || outcome.status >= 400),
        atMs: Math.round(performance.now() - active.start - outcome.ms),
      });
    },
    /** The save hook: which source was saved, and when. */
    saved(sourceId: string) {
      if (!active) return;
      active.saves.push({ sourceId, atMs: Math.round(performance.now() - active.start) });
    },
    /** One planning refresh, banked as its own run. */
    planning(input: { startedAt: string; wallMs: number; ok: boolean; failed: string[]; requests: number; bytes: number }) {
      if (closed) return;
      try {
      const run: BenchmarkRun = {
        v: BENCHMARK_RECORD_VERSION,
        id: randomUUID(),
        trigger: "planning",
        status: input.ok ? "ok" : input.failed.some((code) => /sign.?in|session/i.test(code)) ? "needs_sign_in" : "partial",
        startedAt: input.startedAt,
        finishedAt: now().toISOString(),
        machine: machine(),
        sync: null,
        planning: { wallMs: Math.round(input.wallMs), ok: input.ok, failed: input.failed.slice(0, 20), requests: input.requests, bytes: input.bytes },
        pipeline: null,
        outcome: null,
        query: null,
      };
      deps.bank.add(run);
      } catch {
        // A failed measurement never fails the planning refresh it describes.
      }
    },
    /** "Run benchmark": after any running read ends, one manual full sync, then the drain wait. */
    runBenchmark(tick: () => Promise<unknown>): Promise<BenchmarkRun | null> {
      if (benchmark) return benchmark;
      benchmark = (async () => {
        while (active) await active.done;
        const claimed = new Promise<Context>((resolve) => (armed = resolve));
        const ran = tick();
        const context = await Promise.race([claimed, ran.then(() => null)]);
        if (!context) {
          armed = undefined;
          return null;
        }
        return context.finalized;
      })().finally(() => {
        benchmark = undefined;
      });
      return benchmark;
    },
    status(): BenchmarkStatusNow {
      if (active)
        return {
          running: true,
          trigger: active.trigger,
          phase: active.lastPhase,
          elapsedMs: Math.round(performance.now() - active.start),
          requests: active.requests.length,
          saves: active.saves.length,
        };
      if (waiting)
        return {
          running: true,
          trigger: waiting.context.trigger,
          phase: "pipeline",
          elapsedMs: Math.round(performance.now() - waiting.context.start),
          requests: waiting.context.requests.length,
          saves: waiting.context.saves.length,
        };
      return { running: Boolean(benchmark), trigger: benchmark ? "benchmark" : null, phase: null, elapsedMs: 0, requests: 0, saves: 0 };
    },
    /** "Delete local data": clears the bank and drops every run still being measured. */
    purge() {
      generation++;
      waiting = undefined;
      deps.bank.clear();
    },
    close() {
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      try {
        readDb?.close();
      } catch {}
      readDb = undefined;
    },
  };
}
export type BenchmarkRecorder = ReturnType<typeof createBenchmarkRecorder>;

/** The worker's direct public reads (course websites, downloads, feeds, Registrar), measured. */
export function measuredPublicClient(client: PublicClient, recorder: Pick<BenchmarkRecorder, "request">): PublicClient {
  async function timed<T>(service: string, url: string, run: () => Promise<T>, describe: (value: T) => { status?: number; bytes?: number }) {
    const started = performance.now();
    try {
      const value = await run();
      recorder.request(service, url, { ...describe(value), ms: performance.now() - started });
      return value;
    } catch (error) {
      recorder.request(service, url, { status: null, ms: performance.now() - started, failed: true });
      throw error;
    }
  }
  const described = (value: { response: Response }) => ({
    status: value.response.status,
    bytes: Number(value.response.headers.get("content-length")) || 0,
  });
  return {
    isCanvas: (url) => client.isCanvas(url),
    get: (url, options) => timed("public", url, () => client.get(url, options), described),
    text: (url, options) => timed("public", url, () => client.text(url, options), (v) => ({ status: v.response.status, bytes: v.text.length })),
    feed: (secretUrl, canvasOrigin, signal) => timed("feed", secretUrl, () => client.feed(secretUrl, canvasOrigin, signal), (v) => ({ status: 200, bytes: v.length })),
    signedDownload: (url, allowed, signal) => timed("download", url, () => client.signedDownload(url, allowed, signal), described),
    ...(client.outlookFeed
      ? { outlookFeed: (secretUrl: string, signal?: AbortSignal) => timed("feed", secretUrl, () => client.outlookFeed!(secretUrl, signal), (v) => ({ status: 200, bytes: v.length })) }
      : {}),
    ...(client.outlookFeedIfChanged
      ? {
          outlookFeedIfChanged: (secretUrl: string, validators: Parameters<NonNullable<PublicClient["outlookFeedIfChanged"]>>[1], signal?: AbortSignal) =>
            timed("feed", secretUrl, () => client.outlookFeedIfChanged!(secretUrl, validators, signal), (v) => ({ status: v.notModified ? 304 : 200, bytes: v.notModified ? 0 : v.text.length })),
        }
      : {}),
  };
}
