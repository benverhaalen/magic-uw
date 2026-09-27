/**
 * Notifications in core: the feed is computed by the pure rules in @magic/domain from stored
 * changes; this module supplies its inputs, keeps read/dismissed state, and runs the one
 * hosted step — Jev triage of new course messages — through the same privacy gate, receipts,
 * cancellation and stale-result checks as the existing assignment judgment.
 */
import { randomUUID } from "node:crypto";
import {
  emptyNotificationState,
  messageTriageResultSchema,
  messageTriageStateSchema,
  MESSAGE_TRIAGE_MAX_UPCOMING,
  MESSAGE_TRIAGE_QUESTION_VERSION,
  type MessageTriageJudgment,
  type NotificationFeed,
  type ResourceView,
  type Store,
} from "@magic/contracts";
import { buildNotifications, maySend } from "@magic/domain";
import { JudgmentBudgetError, type JudgmentGateway } from "@magic/ai";
import { courseInclusion } from "./access";
import { resourceViews } from "./queries";

const DAY = 86400000;
/** Changes older than this never produce a notification or a triage request. */
export const NOTIFICATION_WINDOW_MS = 7 * DAY;
/** Upcoming work offered to Jev as "does this message affect it?" candidates. */
const UPCOMING_HORIZON_MS = 21 * DAY;
/** At most this many messages are sent per wake; the gateway budget bounds the rest. */
const TRIAGE_PER_WAKE = 10;
const TRIAGE_TIMEOUT_MS = 20000;
const RETRY_AFTER_FAILURE_MS = 30 * 60000;
const PAUSE_AFTER_LIMIT_MS = 60 * 60000;
const PURPOSE = "Sort announcement importance";

export interface NotificationDeps {
  now(): string;
  timeZone: string;
  gateway?: JudgmentGateway;
  /** Core's purge/privacy generation: a result from an older generation is discarded. */
  generation(): number;
  closed(): boolean;
}

export function createNotifications(store: Store, deps: NotificationDeps) {
  const retryAfter = new Map<string, number>();
  let pausedUntil = 0;
  let active: AbortController | undefined;
  const nowMs = () => Date.parse(deps.now());
  const since = () => new Date(nowMs() - NOTIFICATION_WINDOW_MS).toISOString();
  const categoriesFor = (upcoming: ResourceView[]) =>
    upcoming.length ? ["communications", "course_text"] : ["communications"];

  function status(): NotificationFeed["triage"] {
    if (!deps.gateway?.triage)
      return {
        status: "unavailable",
        reason: "The Jev gateway isn't set up on this device.",
      };
    const permission = maySend(store.privacy(), "jev", [
      "communications",
      "course_text",
    ]);
    if (!permission.allowed) return { status: "off", reason: permission.reason };
    if (nowMs() < pausedUntil)
      return {
        status: "unavailable",
        reason: "Jev is over its limit for now; new announcements will be sorted later.",
      };
    return {
      status: "on",
      reason: "Jev can raise new announcements; code rules decide everything else.",
    };
  }

  function formatDue(iso: string) {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: deps.timeZone,
    }).format(new Date(iso));
  }

  /** Open, dated work in the same course due in the next three weeks, soonest first. */
  function upcomingFor(
    message: ResourceView,
    all: ResourceView[],
    included: (r: ResourceView) => boolean,
  ) {
    const t = nowMs();
    // Resources carry their account through their source; same-named courses stay apart.
    const account = new Map(store.sources().map((s) => [s.id, s.accountScope]));
    const scope = account.get(message.sourceId);
    return all
      .filter(
        (v) =>
          v.kind === "assignment" &&
          !v.deleted &&
          !v.completed &&
          v.submitted !== true &&
          scope !== undefined &&
          account.get(v.sourceId) === scope &&
          v.courseId === message.courseId &&
          included(v) &&
          !!v.deadline.planningAt &&
          Date.parse(v.deadline.planningAt) >= t &&
          Date.parse(v.deadline.planningAt) <= t + UPCOMING_HORIZON_MS,
      )
      .sort((a, b) =>
        a.deadline.planningAt!.localeCompare(b.deadline.planningAt!),
      )
      .slice(0, MESSAGE_TRIAGE_MAX_UPCOMING);
  }

  const judgmentKey = (id: string, hash: string) =>
    `${id}:${hash}:${MESSAGE_TRIAGE_QUESTION_VERSION}`;

  /** New, non-baseline course messages in the window with no judgment for their current text. */
  function candidates(
    all: ResourceView[],
    included: (r: ResourceView) => boolean,
  ) {
    const baseline = new Set(store.baselineReadIds?.() ?? []);
    const judged = new Set(
      store
        .judgments()
        .filter((j) => j.questionVersion === MESSAGE_TRIAGE_QUESTION_VERSION)
        .map((j) => j.key),
    );
    const ids = new Set(
      store
        .changes({ since: since(), limit: 2000 })
        .filter((c) => c.type === "new" && !baseline.has(c.readId))
        .map((c) => c.resourceId),
    );
    const byId = new Map(all.map((v) => [v.id, v]));
    return [...ids]
      .map((id) => byId.get(id))
      .filter(
        (v): v is ResourceView =>
          !!v &&
          !v.deleted &&
          v.kind === "message" &&
          included(v) &&
          !judged.has(judgmentKey(v.id, v.contentHash)),
      );
  }

  async function triage() {
    const gateway = deps.gateway;
    if (!gateway?.triage || deps.closed() || nowMs() < pausedUntil) return;
    if (status().status !== "on") return;
    const all = resourceViews(store, store.resources());
    // One inclusion snapshot per pass: the per-call helper reloads every resource.
    const included = courseInclusion(store);
    for (const message of candidates(all, included).slice(0, TRIAGE_PER_WAKE)) {
      if (deps.closed()) return;
      const key = `${message.id}:${message.contentHash}`;
      if ((retryAfter.get(key) ?? 0) > nowMs()) continue;
      const upcoming = upcomingFor(message, all, included);
      // An explicit allowlist: course name, message title and text, and upcoming work titles/dates.
      const state = messageTriageStateSchema.parse({
        course: (message.courseName || "Course").slice(0, 200),
        title: (message.title || "Announcement").slice(0, 500),
        text: message.text.slice(0, 4000),
        upcoming: upcoming.map((u, i) => ({
          key: `a${i}`,
          title: (u.title || "Assignment").slice(0, 300),
          due: formatDue(u.deadline.planningAt!),
        })),
      });
      const categories = categoriesFor(upcoming);
      const receipt = (status: "blocked" | "sent" | "failed") =>
        store.addReceipt({
          id: randomUUID(),
          recipient: "jev",
          purpose: PURPOSE,
          categories,
          resourceIds: [message.id, ...upcoming.map((u) => u.id)],
          characters: JSON.stringify(state).length,
          status,
          createdAt: deps.now(),
        });
      if (!maySend(store.privacy(), "jev", categories).allowed) {
        receipt("blocked");
        return;
      }
      const version = deps.generation();
      const controller = (active = new AbortController());
      const timer = setTimeout(() => controller.abort(), TRIAGE_TIMEOUT_MS);
      try {
        // Log the attempt before crossing the boundary. This does not claim delivery.
        receipt("sent");
        const result = messageTriageResultSchema.parse(
          await gateway.triage(state, controller.signal),
        );
        if (
          Object.keys(result.affects).some(
            (k) => !state.upcoming.some((u) => u.key === k),
          )
        )
          throw new Error("Judgment named a task that was not offered.");
        const live = store.resource(message.id);
        if (
          deps.closed() ||
          deps.generation() !== version ||
          controller.signal.aborted ||
          !live ||
          live.deleted ||
          live.contentHash !== message.contentHash ||
          !maySend(store.privacy(), "jev", categories).allowed
        )
          continue;
        const judgment: MessageTriageJudgment = {
          result,
          upcoming: upcoming.map((u, i) => ({
            key: `a${i}`,
            resourceId: u.id,
            title: u.title,
          })),
        };
        store.putJudgment({
          key: judgmentKey(message.id, message.contentHash),
          resourceId: message.id,
          inputHash: message.contentHash,
          model: result.model,
          questionVersion: result.questionVersion,
          result: judgment,
          createdAt: deps.now(),
        });
        retryAfter.delete(key);
      } catch (error) {
        if (deps.closed() || deps.generation() !== version) return;
        receipt("failed");
        if (error instanceof JudgmentBudgetError) {
          pausedUntil = nowMs() + error.retryAfterMs;
          return;
        }
        const text = error instanceof Error ? error.message : "";
        if (/budget|limit|try later/i.test(text)) {
          pausedUntil = nowMs() + PAUSE_AFTER_LIMIT_MS;
          return;
        }
        retryAfter.set(key, nowMs() + RETRY_AFTER_FAILURE_MS);
        // The desktop relay reports every failure the same way, so stop this wake rather than
        // sending the next message into what may be a spent budget or an unreachable gateway.
        return;
      } finally {
        clearTimeout(timer);
        active = undefined;
      }
    }
  }

  function feed(): NotificationFeed {
    const live = resourceViews(store, store.resources());
    const changes = store.changes({ since: since(), limit: 2000 });
    const liveIds = new Set(live.map((v) => v.id));
    // A removed item is no longer listed; its saved record still names what disappeared.
    const removed = [
      ...new Set(
        changes
          .filter((c) => c.type === "removed" && !liveIds.has(c.resourceId))
          .map((c) => c.resourceId),
      ),
    ]
      .map((id) => store.resource(id))
      .filter((r): r is NonNullable<typeof r> => !!r);
    const all = [...live, ...resourceViews(store, removed)];
    const triage: Record<string, MessageTriageJudgment> = {};
    const byId = new Map(live.map((v) => [v.id, v]));
    const triageStatus = status();
    // Turning Jev off also stops earlier judgments from changing what the student sees.
    if (triageStatus.status !== "off")
      for (const j of store.judgments())
      if (
        j.questionVersion === MESSAGE_TRIAGE_QUESTION_VERSION &&
        byId.get(j.resourceId)?.contentHash === j.inputHash
      )
        triage[j.resourceId] = j.result as MessageTriageJudgment;
    return buildNotifications({
      changes,
      resources: all,
      sources: store.sources(),
      baselineReadIds: store.baselineReadIds?.() ?? [],
      included: courseInclusion(store),
      triage,
      triageStatus,
      state: store.notificationState?.() ?? emptyNotificationState,
      now: deps.now(),
      timeZone: deps.timeZone,
    });
  }

  function update(change: (s: typeof emptyNotificationState) => typeof emptyNotificationState) {
    if (!store.notificationState || !store.setNotificationState)
      throw new Error("Notifications aren't available in this workspace.");
    store.setNotificationState(change(store.notificationState()));
  }

  return {
    feed,
    triage,
    status,
    abort() {
      active?.abort();
    },
    read(ids: string[]) {
      update((s) => ({ ...s, readIds: [...s.readIds, ...ids] }));
    },
    dismiss(id: string) {
      update((s) => ({
        readIds: [...s.readIds, id],
        dismissedIds: [...s.dismissedIds, id],
      }));
    },
  };
}
