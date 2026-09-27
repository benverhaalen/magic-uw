/**
 * The app's one job loop (core creates it; the desktop worker drives its sync and presence
 * signals). It drains every ready registered kind, code jobs and Jev's `enrich.resource` alike,
 * through the course-core drain (`createDrain`, `lease(kinds[])`), in small slices:
 *
 * - idle-only: a slice starts only after a quiet gap, never while a sync is reading;
 * - yields to syncs: a sync starting aborts the slice between jobs; the sync's end wakes it again;
 * - presence-aware: while the student is at the computer, slices are small and spaced out; away,
 *   they run back to back;
 * - bounded: each slice leases at most `slice` jobs, then yields to the event loop;
 * - retry-after: a handler's `defer` sets a durable per-kind cooldown, and the loop wakes itself
 *   when the earliest cooldown ends (also after a restart).
 *
 * A handler that sends (Jev) keeps its own egress checks: `available` gates leasing and the
 * handler re-checks consent, writes its receipt and discards a result that went stale.
 * Planning data is never queued.
 */
import type { Store } from "@magic/contracts";
import type { CourseCoreStore, CourseJob, CourseRef } from "../../../contracts/src/course-core";
import { createDrain, type DrainContext, type DrainReport } from "../drain";
import { createDerivation, isDeriveStore, type DeriveReport } from "./derive";
import { enqueueOnSave, type JobRegistry } from "./registry";

export interface PipelineTiming {
  /** Quiet gap before a slice starts (ms). */
  idleMs?: number;
  /** Jobs per slice while present / away. */
  presentSlice?: number;
  awaySlice?: number;
  /** Gap between slices while present (ms). */
  presentGapMs?: number;
  /**
   * owner: drain. Run the derivation reconcile (`./derive`) at the start of every slice: passages,
   * facts and references kept current in budgeted batches instead of per-row jobs. The app turns
   * it on with `appJobRegistry()`; without it the per-row kinds do the same work (tests, evals).
   */
  derive?: boolean;
  /** Synchronous work per derivation stretch before it yields (ms). */
  deriveBudgetMs?: number;
}
/** owner: drain. What the reconcile did since the loop started. */
export interface DeriveTotals {
  passages: number;
  courses: number;
  unchanged: number;
  writes: number;
  transactions: number;
  maxBatchMs: number;
  errors: string[];
}
export interface PipelineLoopOptions extends PipelineTiming {
  store: Store & Pick<CourseCoreStore, "lease">;
  registry: JobRegistry;
  now?: () => string;
}
export interface PipelineLoop {
  /** Something was saved or the timer fired: run after the quiet gap. */
  wake(): void;
  presence(present: boolean): void;
  syncStarted(): void;
  syncEnded(): void;
  suspend(): void;
  resume(): void;
  /** Abort the running slice between jobs (purge, privacy change); the next wake continues. */
  interrupt(): void;
  /** Enqueue every source's resources once (idempotent: the store keys jobs by hash); yields per source. */
  backfill(): Promise<number>;
  /** Drain until nothing due is left, ignoring the idle gap and syncs (tests and the eval harness). */
  runToIdle(): Promise<DrainReport>;
  stop(): Promise<void>;
  readonly totals: DrainReport;
  /** owner: drain. The student opened this course: derive it next, even while present. */
  prioritize(course: CourseRef): void;
  /** owner: drain. The reconcile's totals (all zero when `derive` is off). */
  readonly derived: DeriveTotals;
}

export function createPipelineLoop(options: PipelineLoopOptions): PipelineLoop {
  const now = options.now ?? (() => new Date().toISOString());
  const idleMs = options.idleMs ?? 3_000;
  const presentGapMs = options.presentGapMs ?? 500;
  const kinds = options.registry.readyKinds();
  const handlers = Object.fromEntries(
    kinds.map((kind) => [
      kind,
      (job: CourseJob, context: DrainContext) =>
        options.registry.get(kind)!.run(job, { store: options.store, now: context.now, signal: context.signal }),
    ]),
  );
  const available = (kind: string) => options.registry.get(kind)?.available?.({ store: options.store }) ?? true;
  const present = createDrain({ store: options.store, handlers, available, now, maxJobs: options.presentSlice ?? 20 });
  const away = createDrain({ store: options.store, handlers, available, now, maxJobs: options.awaySlice ?? 200 });
  const totals: DrainReport = { done: 0, failed: 0, skipped: 0 };
  // owner: drain. The reconcile runs first in every slice; it yields between its own stretches.
  const derivation =
    options.derive && isDeriveStore(options.store)
      ? createDerivation({ store: options.store, now, ...(options.deriveBudgetMs ? { budgetMs: options.deriveBudgetMs } : {}) })
      : undefined;
  const derived: DeriveTotals = { passages: 0, courses: 0, unchanged: 0, writes: 0, transactions: 0, maxBatchMs: 0, errors: [] };
  function addDerived(d: DeriveReport) {
    derived.passages += d.passages;
    derived.courses += d.courses;
    derived.unchanged += d.unchanged;
    derived.writes += d.writes;
    derived.transactions += d.transactions;
    derived.maxBatchMs = Math.max(derived.maxBatchMs, d.maxBatchMs);
    derived.errors.push(...d.errors);
    derived.errors.splice(0, Math.max(0, derived.errors.length - 20));
  }
  let isPresent = true,
    syncing = 0,
    suspended = false,
    stopped = false,
    wakeWhileRunning = false,
    timer: ReturnType<typeof setTimeout> | undefined,
    cooldownTimer: ReturnType<typeof setTimeout> | undefined,
    controller: AbortController | undefined,
    running: Promise<void> | undefined;

  function schedule(delay: number) {
    // No timer while nothing registered can run (for example only Jev's kind, with Jev off) and
    // there is no reconcile to check.
    if (stopped || suspended || syncing > 0 || (!derivation && !kinds.some(available))) return;
    if (timer) clearTimeout(timer);
    // Not unref'd: a pending slice is short (the idle gap) and stop() clears it.
    timer = setTimeout(() => {
      timer = undefined;
      void slice();
    }, delay);
  }
  /** Wake when the earliest per-kind cooldown (a handler's retry-after) ends. */
  function scheduleCooldownWake() {
    if (cooldownTimer) clearTimeout(cooldownTimer);
    cooldownTimer = undefined;
    if (stopped) return;
    const at = Date.parse(now());
    let delay = Infinity;
    for (const kind of kinds) {
      const until = options.store.jobCooldown(kind);
      const wait = until ? Date.parse(until) - at : NaN;
      if (wait > 0 && wait < delay) delay = wait;
    }
    if (!Number.isFinite(delay)) return;
    cooldownTimer = setTimeout(() => {
      cooldownTimer = undefined;
      schedule(0);
    }, Math.min(delay, 2_147_483_647));
    cooldownTimer.unref?.();
  }
  async function slice(): Promise<void> {
    if (running) {
      wakeWhileRunning = true;
      return;
    }
    if (stopped || suspended || syncing > 0) return;
    wakeWhileRunning = false;
    controller = new AbortController();
    const signal = controller.signal;
    const drain = isPresent ? present : away;
    const run = (async () => {
      if (derivation) addDerived(await derivation.run(signal, { present: isPresent }));
      if (signal.aborted) return { done: 0, failed: 0, skipped: 0 } satisfies DrainReport;
      return kinds.some(available) ? drain.run(signal) : ({ done: 0, failed: 0, skipped: 0 } satisfies DrainReport);
    })().then((report) => {
      totals.done += report.done;
      totals.failed += report.failed;
      totals.skipped += report.skipped;
      const served = report.done + report.failed + report.skipped;
      scheduleCooldownWake();
      // A full slice means more is due: continue after a short gap (none while away).
      if (!report.stopped && served >= (isPresent ? (options.presentSlice ?? 20) : (options.awaySlice ?? 200)))
        schedule(isPresent ? presentGapMs : 0);
    });
    running = run.finally(() => {
      running = undefined;
      controller = undefined;
      if (wakeWhileRunning) {
        wakeWhileRunning = false;
        schedule(idleMs);
      }
    });
    await running;
  }

  return {
    wake() {
      scheduleCooldownWake();
      schedule(idleMs);
    },
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
      timer = undefined;
    },
    syncEnded() {
      syncing = Math.max(0, syncing - 1);
      schedule(idleMs);
    },
    suspend() {
      suspended = true;
      controller?.abort();
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    resume() {
      suspended = false;
      schedule(idleMs);
    },
    interrupt() {
      if (controller) {
        controller.abort();
        wakeWhileRunning = true;
      }
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
      await running;
      if (derivation && !stopped) addDerived(await derivation.run(new AbortController().signal, { present: false }));
      for (;;) {
        if (stopped) return report;
        const r = await away.run();
        report.done += r.done;
        report.failed += r.failed;
        report.skipped += r.skipped;
        if (r.stopped) report.stopped = true;
        if (r.stopped || r.done + r.failed + r.skipped === 0) break;
      }
      scheduleCooldownWake();
      return report;
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (cooldownTimer) clearTimeout(cooldownTimer);
      timer = cooldownTimer = undefined;
      controller?.abort();
      await running;
    },
    totals,
    prioritize(course) {
      if (!derivation) return;
      derivation.prioritize(course);
      schedule(0);
    },
    derived,
  };
}
