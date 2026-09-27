/**
 * The material pipeline's background loop (the desktop worker runs one). It drains only the ready
 * code kinds through the course-core drain (`createDrain`, `lease(kinds[])`), in small slices:
 *
 * - idle-only: a slice starts only after a quiet gap, never while a sync is reading;
 * - yields to syncs: a sync starting aborts the slice between jobs; the sync's end wakes it again;
 * - presence-aware: while the student is at the computer, slices are small and spaced out; away,
 *   they run back to back;
 * - bounded: each slice leases at most `slice` jobs, then yields to the event loop.
 *
 * It never calls a model or Jev: the kinds it drains are code, and planning data is never queued.
 */
import type { Store } from "@magic/contracts";
import type { CourseCoreStore, CourseJob } from "../../../contracts/src/course-core";
import { createDrain, type DrainContext, type DrainReport } from "../drain";
import { enqueueOnSave, type JobRegistry } from "./registry";

export interface PipelineLoopOptions {
  store: Store & Pick<CourseCoreStore, "lease">;
  registry: JobRegistry;
  now?: () => string;
  /** Quiet gap before a slice starts (ms). */
  idleMs?: number;
  /** Jobs per slice while present / away. */
  presentSlice?: number;
  awaySlice?: number;
  /** Gap between slices while present (ms). */
  presentGapMs?: number;
}
export interface PipelineLoop {
  /** Something was saved or the timer fired: run after the quiet gap. */
  wake(): void;
  presence(present: boolean): void;
  syncStarted(): void;
  syncEnded(): void;
  suspend(): void;
  resume(): void;
  /** Enqueue every source's resources once (idempotent: the store keys jobs by hash); yields per source. */
  backfill(): Promise<number>;
  /** Drain until nothing due is left (tests and the eval harness). */
  runToIdle(): Promise<DrainReport>;
  stop(): Promise<void>;
  readonly totals: DrainReport;
}

export function createPipelineLoop(options: PipelineLoopOptions): PipelineLoop {
  const now = options.now ?? (() => new Date().toISOString());
  const idleMs = options.idleMs ?? 3_000;
  const presentGapMs = options.presentGapMs ?? 500;
  const kinds = options.registry.readyKinds();
  const handlers = Object.fromEntries(
    kinds.map((kind) => [
      kind,
      async (job: CourseJob, context: DrainContext) => {
        const outcome = await options.registry.get(kind)!.run(job, { store: options.store, now: context.now, signal: context.signal });
        if (outcome.status !== "done") throw new Error(outcome.error);
      },
    ]),
  );
  const present = createDrain({ store: options.store, handlers, now, maxJobs: options.presentSlice ?? 20 });
  const away = createDrain({ store: options.store, handlers, now, maxJobs: options.awaySlice ?? 200 });
  const totals: DrainReport = { done: 0, failed: 0, skipped: 0 };
  let isPresent = true,
    syncing = 0,
    suspended = false,
    stopped = false,
    timer: ReturnType<typeof setTimeout> | undefined,
    controller: AbortController | undefined,
    running: Promise<void> | undefined;

  function schedule(delay: number) {
    if (stopped || suspended || syncing > 0 || !kinds.length) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void slice();
    }, delay);
    timer.unref?.();
  }
  async function slice(): Promise<void> {
    if (running || stopped || suspended || syncing > 0) return;
    controller = new AbortController();
    const drain = isPresent ? present : away;
    const run = drain.run(controller.signal).then((report) => {
      totals.done += report.done;
      totals.failed += report.failed;
      totals.skipped += report.skipped;
      const served = report.done + report.failed + report.skipped;
      // A full slice means more is due: continue after a short gap (none while away).
      if (served >= (isPresent ? (options.presentSlice ?? 20) : (options.awaySlice ?? 200)))
        schedule(isPresent ? presentGapMs : 0);
    });
    running = run.finally(() => {
      running = undefined;
      controller = undefined;
    });
    await running;
  }

  return {
    wake: () => schedule(idleMs),
    presence(value) {
      const returned = value && !isPresent;
      isPresent = value;
      if (!value) schedule(0);
      else if (returned) controller?.abort(); // the student is back: stop the big slice between jobs
    },
    syncStarted() {
      syncing++;
      controller?.abort();
      if (timer) clearTimeout(timer);
    },
    syncEnded() {
      syncing = Math.max(0, syncing - 1);
      schedule(idleMs);
    },
    suspend() {
      suspended = true;
      controller?.abort();
      if (timer) clearTimeout(timer);
    },
    resume() {
      suspended = false;
      schedule(idleMs);
    },
    async backfill() {
      let calls = 0;
      const courses = new Set<string>();
      for (const source of options.store.sources()) {
        if (stopped) break;
        calls += enqueueOnSave(options.store, options.registry, source.id, now(), courses);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      return calls;
    },
    async runToIdle() {
      const report: DrainReport = { done: 0, failed: 0, skipped: 0 };
      for (;;) {
        const r = await away.run();
        report.done += r.done;
        report.failed += r.failed;
        report.skipped += r.skipped;
        if (r.done + r.failed + r.skipped === 0) return report;
      }
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
      await running;
    },
    totals,
  };
}
