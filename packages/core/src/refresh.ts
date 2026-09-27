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
  /**
   * fix/sync-events. A moved course the stored inventory doesn't know (not an excluded one):
   * the inventory changed, so the coordinator escalates to a full read instead of dropping it.
   */
  inventoryChanged?: boolean;
  /** fix/sync-events. From a manual check: courses it found that need a course read (new or re-included). */
  courses?: string[];
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
  /**
   * fix/sync-events. Baselines kept across launches, so a relaunch within the window probes
   * instead of re-reading. `fingerprint` names the stored Canvas inventory the baselines describe;
   * a different one (a purge, an import, another account) discards them and a full read follows.
   */
  fingerprint?(): string;
  persist?: { load(): unknown; save(snapshot: RefreshSnapshot): void };
  /**
   * fix/sync-events. What a manual refresh reads besides the probes, for what they can't see: the
   * course list (with syllabus bodies) and each included course's assignment list, one request
   * each. Returns the courses that need a course read (a course new to the inventory).
   */
  manual?(signal: AbortSignal): Promise<RefreshOutcome>;
}
/** fix/sync-events. What the per-course coordinator keeps between launches: hashes and times only. */
export interface RefreshSnapshot {
  version: 1;
  fingerprint: string;
  hotBaseline?: Record<string, string>;
  contentBaseline?: Record<string, string>;
  componentBaseline: Record<string, Record<string, string>>;
  fullAt: number;
  contentAt: number;
  /** Courses whose last read didn't complete: courseId → when to read them again. */
  retryAt?: Record<string, number>;
}
const isStringMap = (v: unknown): v is Record<string, string> =>
  !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");
/** Validates a persisted snapshot; anything unexpected is discarded (a full read follows). */
export function parseRefreshSnapshot(value: unknown): RefreshSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (
    v.version !== 1 ||
    typeof v.fingerprint !== "string" ||
    typeof v.fullAt !== "number" ||
    !Number.isFinite(v.fullAt) ||
    typeof v.contentAt !== "number" ||
    !Number.isFinite(v.contentAt) ||
    (v.hotBaseline !== undefined && !isStringMap(v.hotBaseline)) ||
    (v.contentBaseline !== undefined && !isStringMap(v.contentBaseline)) ||
    (v.retryAt !== undefined &&
      (!v.retryAt || typeof v.retryAt !== "object" || !Object.values(v.retryAt).every((x) => typeof x === "number" && Number.isFinite(x)))) ||
    !v.componentBaseline ||
    typeof v.componentBaseline !== "object" ||
    !Object.values(v.componentBaseline).every(isStringMap)
  )
    return undefined;
  return v as unknown as RefreshSnapshot;
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
  // fix/sync-events: baselines persisted across launches, tied to the stored inventory.
  let fingerprintAt: string | undefined;
  const loaded = perCourse
    ? parseRefreshSnapshot(
        (() => {
          try {
            return deps.persist?.load();
          } catch {
            return undefined;
          }
        })(),
      )
    : undefined;
  if (loaded) {
    hotBaseline = loaded.hotBaseline;
    contentBaseline = loaded.contentBaseline;
    Object.assign(componentBaseline, loaded.componentBaseline);
    // A clock that went backwards (or a hand-edited file) can't postpone the next read.
    fullAt = Math.min(loaded.fullAt, now().getTime());
    contentAt = Math.min(loaded.contentAt, now().getTime());
    fingerprintAt = loaded.fingerprint;
    for (const [course, at] of Object.entries(loaded.retryAt ?? {})) retryAt.set(course, at);
  }
  // 10: while a sign-in replaces the session, nothing saves the old baselines back.
  let persistBlocked = false;
  const emptySnapshot = (): RefreshSnapshot => ({ version: 1, fingerprint: "", componentBaseline: {}, fullAt: 0, contentAt: 0 });
  function clearBaselines() {
    hotBaseline = undefined;
    contentBaseline = undefined;
    for (const course of Object.keys(componentBaseline)) delete componentBaseline[course];
    retryAt.clear();
    fullAt = 0;
  }
  function persist() {
    if (persistBlocked || !perCourse || !deps.persist || !deps.fingerprint || !hotBaseline || !contentBaseline) return;
    try {
      fingerprintAt = deps.fingerprint();
      deps.persist.save({
        version: 1,
        fingerprint: fingerprintAt,
        hotBaseline,
        contentBaseline,
        componentBaseline,
        fullAt,
        contentAt,
        retryAt: Object.fromEntries(retryAt),
      });
    } catch {
      // A failed save only costs a full read on the next launch.
    }
  }
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
    // fix/sync-events: the stored inventory changed under the baselines (a purge, an import):
    // they no longer describe it, so the next read is a full one.
    if (deps.fingerprint && fingerprintAt !== undefined && deps.fingerprint() !== fingerprintAt)
      clearBaselines();
    // fix/sync-events: a full read only on the first sync (no baselines), after the backstop, or
    // when the stored inventory changed. A manual refresh probes both ways and reads the courses
    // that moved, so pressing refresh twice never reads everything twice.
    const needFull =
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
      trigger === "manual" ||
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
      if (at <= date.getTime() || trigger === "manual") moved.add(course);
    if (trigger === "manual" && deps.manual) {
      const checked = await deps.manual(signal);
      if (checked.needsSignIn) {
        result.action = "feeds_only";
        result.needsSignIn = true;
        return;
      }
      for (const course of checked.courses ?? []) moved.add(course);
    }
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
    if (warm.inventoryChanged) {
      const full = await deps.full(signal);
      result.needsSignIn = full.needsSignIn;
      // Unread: the baselines stay behind, so the next probe sees the same move again.
      if (full.needsSignIn || (full.complete === false && full.retryNeeded !== false)) return;
      fullAt = date.getTime();
      retryAt.clear();
      advance();
      return;
    }
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
        try {
          await perCourseCanvas(trigger, date, feedsChanged, signal, result);
        } finally {
          persist(); // fix/sync-events
        }
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
    /**
     * fix/sync-events. Called first when a sign-in starts (before the running read is cancelled):
     * the saved baselines are emptied and no run may save them back until reconnected().
     */
    invalidateSaved() {
      persistBlocked = true;
      try {
        deps.persist?.save(emptySnapshot());
      } catch {}
    },
    reconnected() {
      retryCanvasAt = 0;
      signature = undefined;
      // owner: T33: a new session re-baselines with a full read.
      clearBaselines();
      // fix/sync-events: and a restart before that read doesn't bring the old baselines back.
      try {
        deps.persist?.save(emptySnapshot());
      } catch {}
      fingerprintAt = undefined;
      persistBlocked = false;
      nextAt = 0;
    },
    /**
     * fix/sync-events. The student changed a course's inclusion: its baselines are dropped, so the
     * next probe sees it as new and a re-included course is read.
     */
    forget(courseId: string) {
      if (hotBaseline) delete hotBaseline[courseId];
      if (contentBaseline) delete contentBaseline[courseId];
      delete componentBaseline[courseId];
      retryAt.delete(courseId);
      persist();
      nextAt = 0;
    },
    /** fix/sync-events. Delete local data: the saved baselines go with it. */
    purged() {
      clearBaselines();
      fingerprintAt = undefined;
      try {
        deps.persist?.save(emptySnapshot());
      } catch {}
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
