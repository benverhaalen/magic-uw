/**
 * A bounded, budget-aware request scheduler for one reader's hosts (T17).
 *
 * Canvas's own rules, which the defaults below follow:
 * - "Each request subtracts from your quota, and the quota is automatically replenished over
 *   time. In the event that your API request is throttled, you will receive a `429 Forbidden
 *   (Rate Limit Exceeded)` response." "every request will return a `X-Request-Cost` header ...
 *   If throttling is applicable to this request, there will also be a `X-Rate-Limit-Remaining`
 *   header of your remaining quota." "Parallel requests are subject to an additional pre-flight
 *   penalty ... As soon as each request finishes, the pre-flight penalty is credited back."
 *   https://canvas.instructure.com/doc/api/file.throttling.html (now served at
 *   https://developerdocs.instructure.com/services/canvas/basics/file.throttling), read 2026-09-26.
 * - The source (instructure/canvas-lms app/middleware/request_throttle.rb, master, read
 *   2026-09-26): bucket defaults `maximum: 800, hwm: 600, outflow: 10, up_front_cost: 50`; a
 *   throttled request answers `status_code = 403` unless the `request_throttle.send_429_response`
 *   setting is on, with the body "403 Forbidden (Rate Limit Exceeded)" and
 *   `"X-Rate-Limit-Remaining" => "0.0"`. It sends no `Retry-After`; one is honoured when present.
 *
 * So: remaining ≈ 600 minus 50 per request in flight, refilling at 10 per second. Healthy
 * budget: no pacing sleep and up to `concurrency` requests per host. Low budget: fewer slots,
 * then one at a time with a pause. A rate-limit answer pauses the whole host.
 */
export interface FetchSchedulerOptions {
  /** Requests in flight per host. Default 6. */
  concurrency?: number;
  /** Below this remaining budget the host runs one request at a time, paced. Default 100. */
  lowWater?: number;
  /** Canvas's pre-flight penalty per request in flight. Default 50. */
  preflightCost?: number;
  /** Budget refill per second (Canvas `outflow`). Default 10. */
  refillPerSecond?: number;
  /** Budget ceiling (Canvas `hwm`). Default 600. */
  highWater?: number;
  /**
   * How long a finished GET's result stays reusable for an identical GET (ms). Default 0: only
   * requests in flight at the same time are collapsed. A run-scoped scheduler (one sync) can
   * reuse results across the probes and the full read of that same sync.
   */
  reuseMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}
export interface HostBudget {
  remaining?: number;
  cost?: number;
}
export interface SchedulerStats {
  dispatched: number;
  collapsed: number;
  maxInFlight: number;
  pausedMs: number;
}
interface Waiter {
  priority: number;
  order: number;
  resolve: () => void;
}
interface HostState {
  active: number;
  queue: Waiter[];
  remaining?: number;
  observedAt: number;
  pausedUntil: number;
}
interface Shared {
  promise: Promise<unknown>;
  signal?: AbortSignal;
  settledAt?: number;
}
export interface FetchScheduler {
  readonly concurrency: number;
  /**
   * Runs `task` once a slot on `host` is free and the budget allows. Lower `priority` numbers
   * go first; equal priorities keep their order.
   */
  run<T>(
    host: string,
    task: () => Promise<T>,
    options?: { priority?: number; signal?: AbortSignal },
  ): Promise<T>;
  /**
   * Singleflight: identical keys share one operation while it runs (and for `reuseMs` after it
   * succeeds). A follower whose leader was cancelled runs the operation itself.
   */
  once<T>(
    key: string,
    task: (signal?: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<{ value: T; shared: boolean }>;
  /** Records a response's budget headers for `host`. */
  observe(host: string, budget: HostBudget): void;
  /** Pauses every request to `host` for `ms` (a rate-limit answer). */
  pause(host: string, ms: number): void;
  /** The budget the scheduler currently assumes for `host`, with refill since it was observed. */
  remaining(host: string): number | undefined;
  stats(): SchedulerStats;
}
export const DEFAULT_HOST_CONCURRENCY = 6;
async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
export function createFetchScheduler(
  options: FetchSchedulerOptions = {},
): FetchScheduler {
  const limit = Math.max(
    1,
    Math.min(16, Math.floor(options.concurrency ?? DEFAULT_HOST_CONCURRENCY)),
  );
  const lowWater = options.lowWater ?? 100,
    preflight = options.preflightCost ?? 50,
    refill = options.refillPerSecond ?? 10,
    highWater = options.highWater ?? 600,
    reuseMs = options.reuseMs ?? 0,
    now = options.now ?? (() => performance.now()),
    sleep = options.sleep ?? delay,
    random = () =>
      Math.min(1, Math.max(0, options.random?.() ?? Math.random()));
  const hosts = new Map<string, HostState>();
  const shared = new Map<string, Shared>();
  const stats: SchedulerStats = {
    dispatched: 0,
    collapsed: 0,
    maxInFlight: 0,
    pausedMs: 0,
  };
  let order = 0;
  function host(name: string): HostState {
    let state = hosts.get(name);
    if (!state)
      hosts.set(
        name,
        (state = { active: 0, queue: [], observedAt: 0, pausedUntil: 0 }),
      );
    return state;
  }
  function estimate(state: HostState): number | undefined {
    if (state.remaining === undefined) return undefined;
    const refilled =
      state.remaining + (Math.max(0, now() - state.observedAt) / 1000) * refill;
    return Math.min(Math.max(highWater, state.remaining), refilled);
  }
  /** Slots the budget allows: every pre-flight penalty must fit above the low-water mark. */
  function slots(state: HostState): number {
    const budget = estimate(state);
    if (budget === undefined) return limit;
    if (budget < lowWater) return 1;
    return Math.max(
      1,
      Math.min(limit, Math.floor((budget - lowWater) / preflight) + 1),
    );
  }
  function pump(state: HostState) {
    while (state.queue.length && state.active < slots(state)) {
      state.queue.sort((a, b) => a.priority - b.priority || a.order - b.order);
      const next = state.queue.shift()!;
      state.active++;
      next.resolve();
    }
  }
  async function acquire(
    state: HostState,
    priority: number,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    if (state.active < slots(state) && !state.queue.length) {
      state.active++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { priority, order: order++, resolve };
      const abort = () => {
        const index = state.queue.indexOf(waiter);
        if (index >= 0) state.queue.splice(index, 1);
        reject(signal?.reason);
      };
      waiter.resolve = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      state.queue.push(waiter);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  function release(state: HostState) {
    state.active--;
    pump(state);
  }
  return {
    concurrency: limit,
    async run(name, task, runOptions = {}) {
      const state = host(name);
      await acquire(state, runOptions.priority ?? 0, runOptions.signal);
      try {
        // A rate-limit pause holds every request to the host, not only the one that was refused.
        const paused = state.pausedUntil - now();
        if (paused > 0) {
          stats.pausedMs += paused;
          await sleep(paused, runOptions.signal);
        }
        // Low budget: the product's earlier pacing (600 ms plus 25-100 ms of jitter), now only here.
        const budget = estimate(state);
        if (budget !== undefined && budget < lowWater) {
          const wait = 600 + 25 + random() * 75;
          stats.pausedMs += wait;
          await sleep(wait, runOptions.signal);
        }
        stats.dispatched++;
        stats.maxInFlight = Math.max(stats.maxInFlight, state.active);
        return await task();
      } finally {
        release(state);
      }
    },
    async once(key, task, signal) {
      const existing = shared.get(key);
      if (
        existing &&
        (existing.settledAt === undefined ||
          now() - existing.settledAt <= reuseMs)
      ) {
        try {
          const value = await abortable(existing.promise, signal);
          stats.collapsed++;
          return { value: value as never, shared: true };
        } catch (error) {
          signal?.throwIfAborted();
          // The leader was cancelled by its own caller: this caller still wants the result.
          if (!existing.signal?.aborted) throw error;
        }
      }
      const promise = task(signal);
      const entry: Shared = { promise, signal };
      shared.set(key, entry);
      promise.then(
        () => {
          if (reuseMs > 0) entry.settledAt = now();
          else if (shared.get(key) === entry) shared.delete(key);
        },
        () => {
          if (shared.get(key) === entry) shared.delete(key);
        },
      );
      return { value: await promise, shared: false };
    },
    observe(name, budget) {
      const state = host(name);
      if (budget.remaining !== undefined && Number.isFinite(budget.remaining)) {
        state.remaining = budget.remaining;
        state.observedAt = now();
      }
      pump(state);
    },
    pause(name, ms) {
      const state = host(name);
      state.pausedUntil = Math.max(state.pausedUntil, now() + Math.max(0, ms));
      // A refusal means the bucket is full: assume no budget until a header says otherwise.
      state.remaining = Math.min(state.remaining ?? 0, 0);
      state.observedAt = now();
    },
    remaining(name) {
      return estimate(host(name));
    },
    stats: () => ({ ...stats }),
  };
}
async function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
