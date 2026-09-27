/**
 * owner: benchmarks. Local benchmarks (MS1 "backend speed", docs/plans/2026-09-26-backend-optimization
 * §1): what the desktop worker measures about each full run on this computer and banks in its own
 * file beside the workspace (userData/benchmarks.sqlite). Content-free by construction: counts,
 * timings, HTTP statuses, diagnostic codes, job kinds and numeric Canvas course ids. Never a URL,
 * host, title, name or any coursework text.
 */
export const BENCHMARK_RECORD_VERSION = 1;

export type BenchmarkTrigger = "benchmark" | "manual" | "background" | "planning";
export type BenchmarkStatus = "ok" | "partial" | "needs_sign_in" | "failed" | "cancelled";

export interface BenchmarkMachine {
  platform: string;
  arch: string;
  cpu: string;
  cores: number;
  memoryGb: number;
  electron: string | null;
  node: string;
  appVersion: string | null;
  schemaVersion: number;
}

export interface BenchmarkRequestStats {
  total: number;
  failed: number;
  bytes: number;
  p50Ms: number | null;
  p95Ms: number | null;
  /** Per read path: canvas, download, gitlab, space, public, feed, planning. */
  byService: Record<string, { requests: number; bytes: number; failed: number }>;
  /** HTTP status → count (failures without a status count as "error"). */
  byStatus: Record<string, number>;
}

export interface BenchmarkPhase {
  /** canvas-lists, canvas-pages, documents, websites, gitlab, calendar, planning. */
  phase: string;
  /** Offset of the first and last activity from the run's start (ms): a span, not exclusive time. */
  firstMs: number;
  lastMs: number;
  requests: number;
  bytes: number;
  saves: number;
}

export interface BenchmarkCourse {
  /** Numeric Canvas course id; the view joins it with the workspace for a label. */
  courseId: string;
  requests: number;
  bytes: number;
  records: number;
  documents: number;
  webPages: number;
  /** The course-website crawl's own stats and diagnostic codes, when it ran. */
  crawl: { pages: number; durationMs: number | null; codes: Record<string, number> } | null;
  /** Canvas source status → count. */
  sources: Record<string, number>;
}

export interface BenchmarkPipeline {
  /** From the end of the sync until no due job of an available kind remained (or the wait ended). */
  waitedMs: number;
  drained: boolean;
  done: number;
  failed: number;
  /** kind → status → count, after the wait. */
  jobs: Record<string, Record<string, number>>;
  /** Jobs queued for kinds that cannot run here (for example Jev enrichment without a gateway). */
  unavailablePending: number;
  presentAtStart: boolean;
  /** Syncs that started while the drain was being measured (they pause the drain). */
  syncsDuringWait: number;
}

export interface BenchmarkOutcome {
  courses: number;
  resources: number;
  byKind: Record<string, number>;
  documents: number;
  documentsWithText: number;
  webPages: number;
  passages: number;
  facts: number;
  links: number;
  /** Source status → count. */
  sources: Record<string, number>;
  dbBytes: number;
  walBytes: number;
}

export interface BenchmarkQuery {
  /** The fixed MS1 query set (evals/perf) run against the real store after the run. */
  queries: number;
  p50Ms: number;
  p95Ms: number;
  passageP50Ms: number | null;
  passageP95Ms: number | null;
}

export interface BenchmarkRun {
  v: typeof BENCHMARK_RECORD_VERSION;
  id: string;
  trigger: BenchmarkTrigger;
  status: BenchmarkStatus;
  startedAt: string;
  finishedAt: string;
  machine: BenchmarkMachine;
  sync: {
    wallMs: number;
    action: string;
    needsSignIn: boolean;
    firstValueMs: number | null;
    nextWeekInstructionsMs: number | null;
    phases: BenchmarkPhase[];
    requests: BenchmarkRequestStats;
    courses: BenchmarkCourse[];
    /** Diagnostic code → count, over the sources this run saved. */
    diagnostics: Record<string, number>;
  } | null;
  planning: {
    wallMs: number;
    ok: boolean;
    failed: string[];
    requests: number;
    bytes: number;
  } | null;
  pipeline: BenchmarkPipeline | null;
  outcome: BenchmarkOutcome | null;
  query: BenchmarkQuery | null;
}

/** One row of the bank's list: enough for the history table without loading every record. */
export interface BenchmarkSummary {
  id: string;
  trigger: BenchmarkTrigger;
  status: BenchmarkStatus;
  startedAt: string;
  wallMs: number | null;
  pipelineMs: number | null;
  requests: number | null;
  resources: number | null;
  courses: number | null;
}

export interface BenchmarkStatusNow {
  running: boolean;
  trigger: BenchmarkTrigger | null;
  phase: string | null;
  elapsedMs: number;
  requests: number;
  saves: number;
}

export type BenchmarkRequest =
  | { op: "list" }
  | { op: "get"; id: string }
  | { op: "status" }
  | { op: "run" }
  | { op: "clear" };

/** owner: benchmarks. The renderer's access to the bank (main → worker; reads only, plus run and clear). */
export interface BenchmarksBridge {
  list(): Promise<BenchmarkSummary[]>;
  get(id: string): Promise<BenchmarkRun | null>;
  status(): Promise<BenchmarkStatusNow>;
  /** A full Canvas sync as the app runs it, then the material-pipeline wait; banks and returns it. */
  run(): Promise<BenchmarkRun | null>;
  clear(): Promise<void>;
}
