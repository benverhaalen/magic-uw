/**
 * The job registry (T05b): one place that names every background job kind, what a saved
 * resource enqueues, and the handler the app's one drain (`./pipeline`, over `../drain`)
 * dispatches to. Handlers are code; a handler that calls Jev or a model goes through egress like
 * every other send (see `./enrich`).
 *
 * A registered handler is `ready: false` until its owning task builds it (T20 cards). The save
 * hook never enqueues a kind that isn't ready and the drain never leases one, so a stub can't
 * fill the queue with work nothing will do. Register before `createCore`: the drain's kinds are
 * fixed when its loop starts.
 */
import type { Job, Resource, Store } from "@magic/contracts";
import type { DrainOutcome } from "../drain";
import { courseOfSource, isPipelineStore } from "../graph/course-index";

export type JobSubjectKind = "resource" | "course" | "assessment";
export interface JobContext {
  store: Store;
  now(): string;
  signal: AbortSignal;
  /** owner: course-facts. Renews the job's lease (the drain's context); false: the lease was lost. */
  heartbeat?(): boolean;
}
/**
 * - done: finished (or nothing to do)
 * - retry: failed this time; the store backs off and retries up to its limit (a thrown error is a
 *   retry too, and its message is recorded on the job)
 * - stop: refused (for example consent or privacy); the drain stops for this wake
 * - defer: retry-after (a budget 429): pending again without spending an attempt, and the kind
 *   waits until `until`; the loop wakes itself then
 */
export type JobOutcome = DrainOutcome;
export interface JobHandler {
  kind: string;
  subject: JobSubjectKind;
  ready: boolean;
  /** Owning task, for the stub's honest failure message. */
  owner: string;
  /** owner: course-facts. Lease length for this kind (model-backed kinds: 180 s); default the drain's. */
  leaseMs?: number;
  /** Save → enqueue: whether a newly saved or changed resource needs this job. */
  onSave?(resource: Resource): boolean;
  /**
   * Checked before every lease: while false, the drain leaves this kind queued (for example Jev
   * when no gateway is configured or privacy refuses course text). Default: always available.
   */
  available?(context: { store: Store }): boolean;
  run(job: Job, context: JobContext): Promise<JobOutcome>;
}
export interface JobRegistry {
  register(handler: JobHandler): void;
  get(kind: string): JobHandler | undefined;
  kinds(): string[];
  /** Kinds a drain may lease: registered and ready. */
  readyKinds(): string[];
  /** Kinds a saved resource enqueues. */
  forSave(resource: Resource): string[];
}
const kindPattern = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/;
export function createJobRegistry(handlers: JobHandler[] = []): JobRegistry {
  const byKind = new Map<string, JobHandler>();
  const registry: JobRegistry = {
    register(handler) {
      if (!kindPattern.test(handler.kind))
        throw new Error(`Invalid job kind: ${handler.kind}`);
      if (byKind.has(handler.kind))
        throw new Error(`Job kind already registered: ${handler.kind}`);
      byKind.set(handler.kind, handler);
    },
    get: (kind) => byKind.get(kind),
    kinds: () => [...byKind.keys()],
    readyKinds: () =>
      [...byKind.values()].filter((h) => h.ready).map((h) => h.kind),
    forSave: (resource) =>
      [...byKind.values()]
        .filter((h) => h.ready && h.subject === "resource" && h.onSave?.(resource))
        .map((h) => h.kind),
  };
  for (const handler of handlers) registry.register(handler);
  return registry;
}
/** A stub handler: registered so the kind is known, never enqueued, and honest if leased. */
export function stubHandler(
  kind: string,
  subject: JobSubjectKind,
  owner: string,
): JobHandler {
  return {
    kind,
    subject,
    owner,
    ready: false,
    async run() {
      return { status: "retry", error: `Not built yet (${owner}).` };
    },
  };
}
/**
 * The save → enqueue hook. After a capture is saved, every live resource of that source
 * whose kind needs a ready job is enqueued at its current content hash. The store ignores a
 * duplicate (kind, resource, hash), so a re-save of unchanged content adds nothing.
 * Returns the number of enqueue calls (tests and the perf harness read it).
 */
export function enqueueOnSave(
  store: Store,
  registry: JobRegistry,
  sourceId: string,
  now: string,
  /** Courses already enqueued in this pass (the backfill), so each course hashes once. */
  coursesDone?: Set<string>,
): number {
  if (!registry.readyKinds().length) return 0;
  let calls = 0;
  // The pipeline store reads one source's resources; a plain store falls back to the full list.
  const graph = isPipelineStore(store) ? store : undefined;
  const saved = graph
    ? graph.sourceResources(sourceId)
    : store.resources().filter((r) => r.sourceId === sourceId && !r.deleted);
  for (const resource of saved) {
    for (const kind of registry.forSave(resource)) {
      store.enqueue(kind, resource.id, resource.contentHash, now);
      calls++;
    }
  }
  // Course kinds (the course pass): one job per course at its inventory hash, only for a source
  // that belongs to a course (not the account-level lists).
  const courseKinds = registry.readyKinds().filter((k) => registry.get(k)!.subject === "course");
  if (graph && courseKinds.length && saved.length) {
    const course = courseOfSource(graph, sourceId);
    const key = course && `${course.accountScope}:${course.courseId}`;
    if (course && key && !coursesDone?.has(key) && saved.some((r) => r.courseId === course.courseId)) {
      coursesDone?.add(key);
      const inputHash = graph.courseInventoryHash(course);
      for (const kind of courseKinds) {
        graph.enqueueSubject(
          { kind, subjectKind: "course", subjectId: `${course.accountScope}:${course.courseId}`, inputHash, sourceId },
          now,
        );
        calls++;
      }
    }
  }
  return calls;
}
