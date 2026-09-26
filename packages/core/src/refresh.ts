/** Network scheduling has no model dependency. The host owns timers and suspend/resume. */
export interface RefreshSettings {
  enabled: boolean;
  intervalMinutes: number;
  jitterFraction: number;
  quietStartHour: number;
  quietEndHour: number;
}
export interface RefreshOutcome {
  needsSignIn: boolean;
  signature?: string;
  complete?: boolean;
}
export interface RefreshRun {
  startedAt: string;
  finishedAt: string;
  trigger: "manual" | "background";
  action: "refreshed" | "unchanged" | "feeds_only" | "failed";
  needsSignIn: boolean;
}
export interface RefreshDependencies {
  settings(): RefreshSettings;
  now?: () => Date;
  random?: () => number;
  hasSources(): boolean;
  begin?(): void;
  feeds(signal: AbortSignal): Promise<{ changed: boolean }>;
  probe(signal: AbortSignal): Promise<RefreshOutcome>;
  full(signal: AbortSignal): Promise<RefreshOutcome>;
  external(signal: AbortSignal, force: boolean): Promise<void>;
  record(run: RefreshRun): void | Promise<void>;
}
export function inQuietHours(
  hour: number,
  start: number,
  end: number,
): boolean {
  if (start === end) return false;
  return start < end
    ? hour >= start && hour < end
    : hour >= start || hour < end;
}
export function createRefreshCoordinator(deps: RefreshDependencies) {
  const now = deps.now ?? (() => new Date());
  const random = deps.random ?? Math.random;
  let nextAt = 0,
    retryCanvasAt = 0,
    signature: string | undefined;
  let suspended = false,
    stopped = false,
    controller: AbortController | undefined;
  let running: Promise<RefreshRun | undefined> | undefined;
  function schedule() {
    const s = deps.settings();
    nextAt =
      now().getTime() +
      s.intervalMinutes *
        60_000 *
        (1 + (Math.max(0, Math.min(1, random())) * 2 - 1) * s.jitterFraction);
  }
  async function run(
    trigger: "manual" | "background",
  ): Promise<RefreshRun | undefined> {
    if (stopped || suspended) return;
    const settings = deps.settings(),
      date = now();
    if (
      trigger === "background" &&
      (!settings.enabled ||
        !deps.hasSources() ||
        date.getTime() < nextAt ||
        inQuietHours(
          date.getHours(),
          settings.quietStartHour,
          settings.quietEndHour,
        ))
    )
      return;
    controller = new AbortController();
    const signal = controller.signal;
    const result: RefreshRun = {
      startedAt: date.toISOString(),
      finishedAt: date.toISOString(),
      trigger,
      action: "failed",
      needsSignIn: false,
    };
    let attemptedCanvas = false;
    try {
      deps.begin?.();
      // Feeds carry their own permission. Their failure must not stop authenticated reads.
      let feedsChanged = false;
      try {
        feedsChanged = (await deps.feeds(signal)).changed;
      } catch {
        signal.throwIfAborted();
      }
      if (trigger === "background" && date.getTime() < retryCanvasAt) {
        result.action = "feeds_only";
        result.needsSignIn = true;
      } else {
        attemptedCanvas = true;
        const probe =
          trigger === "manual" ? undefined : await deps.probe(signal);
        if (probe?.needsSignIn) {
          result.action = "feeds_only";
          result.needsSignIn = true;
        } else if (
          trigger === "manual" ||
          feedsChanged ||
          !signature ||
          probe?.signature !== signature
        ) {
          const full = await deps.full(signal);
          result.needsSignIn = full.needsSignIn;
          result.action = "refreshed";
          signature =
            !full.needsSignIn && full.complete !== false
              ? (full.signature ?? probe?.signature)
              : undefined;
        } else result.action = "unchanged";
      }
      if (result.needsSignIn && attemptedCanvas)
        retryCanvasAt = now().getTime() + settings.intervalMinutes * 60_000 * 3;
      else if (result.action === "refreshed") retryCanvasAt = 0;
      // Public sources have their own six-hour TTL even when Canvas hasn't changed.
      await deps.external(signal, trigger === "manual");
    } catch {
      // Errors and cancellation never become a successful empty read.
      result.action = "failed";
    } finally {
      result.finishedAt = now().toISOString();
      controller = undefined;
      schedule();
      await deps.record(result);
    }
    return result;
  }
  return {
    tick(trigger: "manual" | "background" = "background") {
      if (running) return running;
      running = run(trigger).finally(() => {
        running = undefined;
      });
      return running;
    },
    suspend() {
      suspended = true;
      controller?.abort();
    },
    resume() {
      suspended = false;
      schedule();
    },
    reconnected() {
      retryCanvasAt = 0;
      signature = undefined;
      nextAt = 0;
    },
    cancel() {
      controller?.abort();
    },
    async stop() {
      stopped = true;
      controller?.abort();
      await running;
    },
  };
}
