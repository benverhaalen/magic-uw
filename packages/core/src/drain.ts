/**
 * The job drain (T10 takeover of the T05b stub). It leases only the kinds it has handlers for,
 * so an unregistered kind is never leased, failed or spun on. A run ends when nothing of its
 * kinds is due; the caller wakes it again (on ingest, on a timer). There is no polling loop.
 *
 *   createDrain({ store, handlers: { [kind]: handler }, now?, leaseMs?, maxJobs? }): Drain
 *   drain.run(signal?): Promise<{ done, failed, skipped }>   (concurrent calls share one run)
 *   handler(job, { signal, now }): void | Promise<void>      (throw to fail; the store retries
 *                                                             with backoff, then gives up)
 */
import type { Store } from "@magic/contracts";
import type { CourseCoreStore, CourseJob } from "../../contracts/src/course-core";

export interface DrainContext {
  signal: AbortSignal;
  now: () => string;
}
export type DrainHandler = (job: CourseJob, context: DrainContext) => void | Promise<void>;
export interface DrainOptions {
  store: Pick<CourseCoreStore, "lease"> & Pick<Store, "finish">;
  handlers: Readonly<Record<string, DrainHandler>>;
  now?: () => string;
  leaseMs?: number;
  /** At most this many jobs per run; the next wake continues. */
  maxJobs?: number;
}
export interface DrainReport {
  done: number;
  failed: number;
  /** Jobs whose lease was lost or whose subject changed before finishing. */
  skipped: number;
}
export interface Drain {
  readonly kinds: readonly string[];
  run(signal?: AbortSignal): Promise<DrainReport>;
}

const yieldToEvents = () => new Promise<void>((resolve) => setImmediate(resolve));

export function createDrain(options: DrainOptions): Drain {
  const kinds = Object.keys(options.handlers).filter((k) => typeof options.handlers[k] === "function");
  const now = options.now ?? (() => new Date().toISOString());
  const leaseMs = options.leaseMs ?? 60_000;
  const maxJobs = options.maxJobs ?? 500;
  let running: Promise<DrainReport> | undefined;

  async function drain(signal: AbortSignal): Promise<DrainReport> {
    const report: DrainReport = { done: 0, failed: 0, skipped: 0 };
    if (!kinds.length) return report;
    // A failed job is due again only after the store's backoff, and fails for good after its
    // retry limit, so the loop ends when nothing registered is due or after maxJobs.
    let served = 0;
    while (!signal.aborted && served < maxJobs) {
      const job = options.store.lease(now(), leaseMs, kinds);
      if (!job) break;
      served++;
      const handler = options.handlers[job.kind]!;
      let error: string | undefined;
      try {
        await handler(job, { signal, now });
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
      if (signal.aborted) error ??= "Interrupted.";
      if (!options.store.finish(job, error, now())) report.skipped++;
      else if (error === undefined) report.done++;
      else report.failed++;
      await yieldToEvents();
    }
    return report;
  }

  return {
    kinds,
    run(signal = new AbortController().signal) {
      running ??= drain(signal).finally(() => {
        running = undefined;
      });
      return running;
    },
  };
}
