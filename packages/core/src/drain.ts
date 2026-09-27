/**
 * The job drain: the app's only job loop body (the pipeline loop in `jobs/pipeline.ts` runs it in
 * slices). It leases only the kinds it has handlers for, and of those only the kinds `available`
 * allows at lease time, so an unregistered or unavailable kind is never leased, failed or spun on.
 * A run ends when nothing of its kinds is due; the caller wakes it again (on save, on a timer).
 *
 *   createDrain({ store, handlers: { [kind]: handler }, available?, now?, leaseMs?, maxJobs? }): Drain
 *   drain.run(signal?): Promise<{ done, failed, skipped, stopped? }>   (concurrent calls share one run)
 *   handler(job, { signal, now }): void | DrainOutcome | Promise<…>
 *
 * Outcomes (returning nothing means done; throwing is a retry whose message is recorded on the job):
 * - done: finished (or nothing to do)
 * - retry: failed this time; the store backs off and retries up to its limit
 * - stop: refused (for example consent or privacy); the job is finished with the error, the run ends
 * - defer: a retry-after (for example a budget 429). The job returns to pending without spending an
 *   attempt, and its kind is not leased until `until` (a durable per-kind cooldown in the store).
 */
import type { Store } from "@magic/contracts";
import type { CourseCoreStore, CourseJob } from "../../contracts/src/course-core";

export type DrainOutcome =
  | { status: "done" }
  | { status: "retry"; error: string }
  | { status: "stop"; error: string }
  | { status: "defer"; until: string; error: string };
export interface DrainContext {
  signal: AbortSignal;
  now: () => string;
}
export type DrainHandler = (
  job: CourseJob,
  context: DrainContext,
) => void | DrainOutcome | Promise<void | DrainOutcome>;
export interface DrainOptions {
  store: Pick<CourseCoreStore, "lease"> & Pick<Store, "finish" | "defer">;
  handlers: Readonly<Record<string, DrainHandler>>;
  /** Checked before every lease: a kind is leased only while this answers true (default: always). */
  available?: (kind: string) => boolean;
  now?: () => string;
  leaseMs?: number;
  /** At most this many jobs per run; the next wake continues. */
  maxJobs?: number;
}
export interface DrainReport {
  done: number;
  failed: number;
  /** Jobs whose lease was lost, whose subject changed before finishing, or that were deferred. */
  skipped: number;
  /** Present when a handler refused (`stop`) and the run ended early. */
  stopped?: true;
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
    // A failed job is due again only after the store's backoff, and fails for good after its
    // retry limit, so the loop ends when nothing registered is due or after maxJobs.
    let served = 0;
    while (!signal.aborted && served < maxJobs) {
      const ready = options.available ? kinds.filter(options.available) : kinds;
      if (!ready.length) break;
      const job = options.store.lease(now(), leaseMs, ready);
      if (!job) break;
      served++;
      const handler = options.handlers[job.kind]!;
      let outcome: DrainOutcome;
      try {
        outcome = (await handler(job, { signal, now })) ?? { status: "done" };
      } catch (cause) {
        // The cause is recorded on the job, not swallowed.
        outcome = { status: "retry", error: cause instanceof Error ? cause.message : String(cause) };
      }
      if (signal.aborted && outcome.status === "done") outcome = { status: "retry", error: "Interrupted." };
      // A retry-after that has already passed is an ordinary retry.
      if (outcome.status === "defer" && !(Date.parse(outcome.until) > Date.parse(now())))
        outcome = { status: "retry", error: outcome.error };
      if (outcome.status === "defer") {
        options.store.defer(job, outcome.until, outcome.error, now()); // false: the lease was lost
        report.skipped++;
      } else {
        const error = outcome.status === "done" ? undefined : outcome.error;
        if (!options.store.finish(job, error, now())) report.skipped++;
        else if (error === undefined) report.done++;
        else report.failed++;
        if (outcome.status === "stop") {
          report.stopped = true;
          break;
        }
      }
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
