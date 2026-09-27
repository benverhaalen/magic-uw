/**
 * The job registry (T05b): one place that names every background job kind, what a saved
 * resource enqueues, and the handler the drain dispatches to. Handlers are code; a handler
 * that calls Jev or a model goes through egress like every other send.
 *
 * A registered handler is `ready: false` until its owning task builds it (T20 cards and links,
 * T21 compile, T10 passages). The save hook never enqueues a kind that isn't ready, so a stub
 * can't fill the queue with work nothing will do.
 */
import type { Job, Resource, Store } from "@magic/contracts";

export type JobSubjectKind = "resource" | "course" | "assessment";
export interface JobContext {
  store: Store;
  now(): string;
  signal: AbortSignal;
}
/**
 * - done: finished (or nothing to do)
 * - retry: failed this time; the store backs off and retries up to its limit
 * - stop: refused (for example consent or privacy); the drain stops for this wake
 */
export type JobOutcome =
  | { status: "done" }
  | { status: "retry"; error: string }
  | { status: "stop"; error: string };
export interface JobHandler {
  kind: string;
  subject: JobSubjectKind;
  ready: boolean;
  /** Owning task, for the stub's honest failure message. */
  owner: string;
  /** Save → enqueue: whether a newly saved or changed resource needs this job. */
  onSave?(resource: Resource): boolean;
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
): number {
  if (!registry.readyKinds().length) return 0;
  let calls = 0;
  for (const resource of store.resources()) {
    if (resource.sourceId !== sourceId || resource.deleted) continue;
    for (const kind of registry.forSave(resource)) {
      store.enqueue(kind, resource.id, resource.contentHash, now);
      calls++;
    }
  }
  return calls;
}
