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
  /** Coverage may be incomplete solely because a stable scope is restricted. */
  retryNeeded?: boolean;
}
export interface RefreshRun {
  startedAt: string;
  finishedAt: string;
  trigger: "manual" | "background";
  action: "refreshed" | "unchanged" | "feeds_only" | "failed";
  needsSignIn: boolean;
  // owner: T33. What a per-course run did: the courses warm-read, and which probes ran.
  warmCourses?: string[];
  probes?: Array<"hot" | "content">;
  // end owner: T33
}
/** owner: T33. A per-course probe: courseId → signature (D37). */
export interface CourseProbe {
  components?: Record<string, Record<string, string>>;
  needsSignIn: boolean;
  courses: Record<string, string>;
  /** false: some part failed; unmoved courses keep their baseline, moved ones are still read. */
  complete: boolean;
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
  // owner: T33. Per-course freshness (D37). With all three, a background run is the hot tick,
  // the content probe when due, and a warm read of only the courses that moved; without them
  // the activity-summary probe and full read above run as before.
  hot?(signal: AbortSignal): Promise<CourseProbe>;
  content?(signal: AbortSignal): Promise<CourseProbe>;
  warm?(courseIds: string[], signal: AbortSignal): Promise<RefreshOutcome>;
  // end owner: T33
  /**
   * owner: T30. Microsoft Graph delta (mail, calendar, notes) through the app's own Microsoft
   * sign-in. Runs on every run it is allowed on (the hot tick's 5 minutes); a check with nothing
   * new costs one request per stream. Its failure never stops the Canvas reads.
   */
  graph?(signal: AbortSignal, trigger: "manual" | "background"): Promise<void>;
}
/**
 * The cadence table: which background read classes carry the student's signed-in session.
 * Signed-in reads (Canvas, UW GitLab, My UW, Enroll) run only while the student is present,
 * so an unattended app never holds a UW session open; credential-free calendar feeds run
 * when away. Interval, jitter and quiet hours are unchanged and shared by every class.
 * My UW and Enroll have no background step today (student-triggered only); a background
 * step for them enters this table with `signedIn: true`.
 */
export type ReadClass = "feeds" | "canvas" | "external" | "mail";
export const cadenceTable: Readonly<
  Record<ReadClass, { signedIn: boolean; reads: string }>
> = {
  feeds: { signedIn: false, reads: "Canvas calendar ICS capability URLs" },
  canvas: {
    signedIn: true,
    reads:
      "Canvas hot tick (todo, upcoming_events), per-course content probe and warm reads",
  },
  // Public course sites share this step with UW GitLab, which uses the session.
  external: { signedIn: true, reads: "UW GitLab and public course sites" },
  // owner: T30: token-based, but it reads the student's own mailbox, so it waits for presence too.
  mail: {
    signedIn: true,
    reads: "Microsoft Graph mail, calendar, OneNote and OneDrive delta (the app's own sign-in)",
  },
};
/**
 * owner: T33. The cadences, in minutes (spec A4, plan D37). One scheduler runs them all:
 * - hot: the ≤2-request dated-item tick, while present (freshness ≤5 min for dated items)
 * - content: the per-course content probe, and on app focus (≤15 min for undated materials)
 * - backstop: a full read that catches anything neither probe sees
 * - mail (T30/T35) and public feeds (T31) enter here when built: 5 and 60 minutes
 * The student's interval setting stays the upper bound of the hot tick.
 */
export const cadenceMinutes = {
  hot: 5,
  content: 15,
  backstop: 360,
  mail: 5,
  publicFeeds: 60,
  /** App focus runs the content probe at most this often. */
  focusFloor: 1,
  /** An incomplete read is retried after this long. */
  retry: 30,
} as const;
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
/** owner: T33. Courses whose signature moved, appeared or disappeared since the baseline. */
export function movedCourses(
  baseline: Record<string, string> | undefined,
  current: Record<string, string>,
  /** An incomplete probe: a course missing from it is unknown, not gone. */
  partial = false,
): string[] {
  const keys = new Set([
    ...(partial ? [] : Object.keys(baseline ?? {})),
    ...Object.keys(current),
  ]);
  return [...keys]
    .filter((c) => c !== "account" && baseline?.[c] !== current[c])
    .sort();
}
export function createRefreshCoordinator(deps: RefreshDependencies) {
  const now = deps.now ?? (() => new Date());
  const random = deps.random ?? Math.random;
  const perCourse = !!(deps.hot && deps.content && deps.warm);
  let nextAt = 0,
    retryCanvasAt = 0,
    signature: string | undefined;
  let suspended = false,
    stopped = false,
    // Present until the host says otherwise; main posts the real state once the worker is ready.
    present = true,
    heldWhileAway = false,
    controller: AbortController | undefined;
  let running: Promise<RefreshRun | undefined> | undefined;
  // owner: T33. Per-course watermarks, taken before the read they describe.
  let hotBaseline: Record<string, string> | undefined,
    contentBaseline: Record<string, string> | undefined,
    contentAt = 0,
    fullAt = 0,
    focusAt = 0,
    focusRequested = false;
  const retryAt = new Map<string, number>();
  const componentBaseline: Record<string, Record<string, string>> = {};
  function comparableContent(probe: CourseProbe): CourseProbe {
    if (!probe.components) return probe;
    const courses: Record<string, string> = {};
    for (const [course, observed] of Object.entries(probe.components)) {
      if (!Object.keys(observed).length) continue;
      const merged = { ...componentBaseline[course], ...observed };
      componentBaseline[course] = merged;
      courses[course] = JSON.stringify(
        Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return { ...probe, courses };
  }
  function interval(s: RefreshSettings) {
    return perCourse
      ? Math.min(s.intervalMinutes, cadenceMinutes.hot)
      : s.intervalMinutes;
  }
  // end owner: T33
  function schedule() {
    const s = deps.settings();
    nextAt =
      now().getTime() +
      interval(s) *
        60_000 *
        (1 + (Math.max(0, Math.min(1, random())) * 2 - 1) * s.jitterFraction);
    // owner: T33. The content probe is never later than its cadence, so an undated change is
    // seen within 15 minutes of the previous probe, not 15 minutes plus a hot interval.
    if (perCourse && contentAt)
      nextAt = Math.min(nextAt, contentAt + cadenceMinutes.content * 60_000);
  }
  /**
   * owner: T33. The per-course Canvas step. Returns the run's action. A full read takes both
   * probes first, so anything that changes during the read shows on the next probe.
   */
  async function perCourseCanvas(
    trigger: "manual" | "background",
    date: Date,
    feedsChanged: boolean,
    signal: AbortSignal,
    result: RefreshRun,
  ): Promise<void> {
    const probes: Array<"hot" | "content"> = [];
    result.probes = probes;
    const needFull =
      trigger === "manual" ||
      !hotBaseline ||
      !contentBaseline ||
      date.getTime() - fullAt >= cadenceMinutes.backstop * 60_000;
    probes.push("hot");
    const hot = await deps.hot!(signal);
    if (hot.needsSignIn) {
      result.action = "feeds_only";
      result.needsSignIn = true;
      return;
    }
    const contentDue =
      needFull ||
      focusRequested ||
      date.getTime() - contentAt >= cadenceMinutes.content * 60_000;
    let content: CourseProbe | undefined;
    if (contentDue) {
      probes.push("content");
      focusRequested = false;
      content = comparableContent(await deps.content!(signal));
      if (content.needsSignIn) {
        result.action = "feeds_only";
        result.needsSignIn = true;
        return;
      }
      contentAt = now().getTime();
    }
    if (needFull) {
      const full = await deps.full(signal);
      result.needsSignIn = full.needsSignIn;
      result.action = "refreshed";
      if (!full.needsSignIn) {
        hotBaseline = hot.complete ? hot.courses : {};
        contentBaseline = content!.courses;
        // The first connect knows no course before its read: probe once after it instead, so the
        // first background run doesn't warm-read every course again.
        if (!Object.keys(contentBaseline).length) {
          const after = comparableContent(await deps.content!(signal));
          if (!after.needsSignIn) contentBaseline = after.courses;
          else {
            result.needsSignIn = true;
            return;
          }
          contentAt = now().getTime();
        }
        // An incomplete read (a file that won't download, a list the student can't see) is
        // retried after a delay, not on every tick; a failed read never erases coursework.
        fullAt =
          full.retryNeeded === false || full.complete !== false
            ? date.getTime()
            : date.getTime() -
              (cadenceMinutes.backstop - cadenceMinutes.retry) * 60_000;
        retryAt.clear();
      }
      return;
    }
    const moved = new Set(
      hot.complete ? movedCourses(hotBaseline, hot.courses) : [],
    );
    if (content)
      for (const course of movedCourses(
        contentBaseline,
        content.courses,
        !content.complete,
      ))
        moved.add(course);
    for (const [course, at] of retryAt)
      if (at <= date.getTime()) moved.add(course);
    // A feed change can't name its course here; the hot and content probes already cover the
    // dated items a feed carries, so it no longer forces a full read.
    void feedsChanged;
    const advance = () => {
      if (hot.complete) hotBaseline = hot.courses;
      if (content)
        contentBaseline = content.complete
          ? content.courses
          : { ...contentBaseline, ...content.courses };
    };
    if (!moved.size) {
      result.action = "unchanged";
      advance();
      return;
    }
    const courses = [...moved].sort();
    result.warmCourses = courses;
    const warm = await deps.warm!(courses, signal);
    result.needsSignIn = warm.needsSignIn;
    result.action = "refreshed";
    if (warm.needsSignIn) return;
    // The watermark advances; an incomplete warm read is retried after a delay, not every tick.
    for (const course of courses)
      if (warm.complete === false && warm.retryNeeded !== false)
        retryAt.set(course, now().getTime() + cadenceMinutes.retry * 60_000);
      else retryAt.delete(course);
    advance();
  }
  // end owner: T33
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
    const away = trigger === "background" && !present;
    const allowed = (read: ReadClass) => !(away && cadenceTable[read].signedIn);
    // A present run (including a manual one) reads everything, so nothing is left to catch up.
    if (!away) heldWhileAway = false;
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
      if (allowed("feeds"))
        try {
          feedsChanged = (await deps.feeds(signal)).changed;
        } catch {
          signal.throwIfAborted();
        }
      // owner: T30. Graph rides the same run, presence-gated like the Canvas reads.
      if (deps.graph) {
        if (allowed("mail"))
          try {
            await deps.graph(signal, trigger);
          } catch {
            signal.throwIfAborted();
          }
        else heldWhileAway = true;
      }
      if (trigger === "background" && date.getTime() < retryCanvasAt) {
        result.action = "feeds_only";
        result.needsSignIn = true;
      } else if (!allowed("canvas")) {
        result.action = "feeds_only";
        heldWhileAway = true;
        // A feed change seen while away still earns the full read, on the catch-up run.
        if (feedsChanged) signature = undefined;
      } else if (perCourse) {
        // owner: T33
        attemptedCanvas = true;
        await perCourseCanvas(trigger, date, feedsChanged, signal, result);
        // end owner: T33
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
            !full.needsSignIn &&
            (full.retryNeeded === false || full.complete !== false)
              ? (full.signature ?? probe?.signature)
              : undefined;
        } else result.action = "unchanged";
      }
      if (result.needsSignIn && attemptedCanvas)
        retryCanvasAt = now().getTime() + settings.intervalMinutes * 60_000 * 3;
      else if (result.action === "refreshed") retryCanvasAt = 0;
      // Public sources have their own six-hour TTL even when Canvas hasn't changed.
      if (allowed("external"))
        await deps.external(signal, trigger === "manual");
      else heldWhileAway = true;
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
    /** Main's presence signal. On return, one catch-up run if a signed-in read was held. */
    presence(value: boolean) {
      const returned = value && !present;
      present = value;
      if (returned && heldWhileAway) {
        heldWhileAway = false;
        nextAt = 0;
      }
    },
    /** owner: T33. App focus: the content probe runs on the next tick (at most once a minute). */
    focus() {
      const t = now().getTime();
      if (!perCourse || t - focusAt < cadenceMinutes.focusFloor * 60_000)
        return;
      focusAt = t;
      focusRequested = true;
      nextAt = 0;
    },
    reconnected() {
      retryCanvasAt = 0;
      signature = undefined;
      // owner: T33: a new session re-baselines with a full read.
      hotBaseline = undefined;
      contentBaseline = undefined;
      for (const course of Object.keys(componentBaseline))
        delete componentBaseline[course];
      retryAt.clear();
      nextAt = 0;
    },
    cancel() {
      controller?.abort();
    },
    async cancelAndWait() {
      controller?.abort();
      await running;
    },
    async stop() {
      stopped = true;
      controller?.abort();
      await running;
    },
  };
}
