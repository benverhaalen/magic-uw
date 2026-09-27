/**
 * Notifications in core: the feed is computed by the pure rules in @magic/domain from stored
 * changes; this module supplies its inputs, keeps read/dismissed state, and runs the one
 * hosted step — Jev triage of new course announcements and new email — through the same
 * privacy gate, identity scrubbing, receipts, cancellation and stale-result checks as the
 * existing assignment judgment.
 */
import { randomUUID } from "node:crypto";
import {
  emptyNotificationState,
  mailTriageResultSchema,
  mailTriageStateSchema,
  messageTriageResultSchema,
  messageTriageStateSchema,
  MAIL_TRIAGE_QUESTION_VERSION,
  MESSAGE_TRIAGE_MAX_UPCOMING,
  MESSAGE_TRIAGE_QUESTION_VERSION,
  type MailTriageJudgment,
  type MailTriageState,
  type MessageTriageJudgment,
  type NotificationFeed,
  type ResourceView,
  type Store,
} from "@magic/contracts";
import { buildNotifications, maySend } from "@magic/domain";
import { JudgmentBudgetError, type JudgmentGateway } from "@magic/ai";
import { courseInclusion } from "./access";
import { payloadScrubber } from "./identity";
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
/** Mail categories worth a judgment: advisor mail is already important by code, meetings are typed. */
const TRIAGED_MAIL_CATEGORIES = new Set(["course", "admin", "org", "general"]);
const MAIL_ROLE: Record<string, MailTriageState["role"]> = {
  course: "course staff",
  advisor: "academic advisor",
  admin: "university office",
  org: "student organization or mailing list",
  meeting: "meeting invitation",
  general: "unknown sender",
};

export interface NotificationDeps {
  now(): string;
  timeZone: string;
  gateway?: JudgmentGateway;
  /** Core's purge/privacy generation: a result from an older generation is discarded. */
  generation(): number;
  closed(): boolean;
}

/** A Canvas notification email duplicates a Canvas change that already notifies. */
export function isCanvasNotificationMail(r: ResourceView) {
  return (
    !!r.mail &&
    ((r.links ?? []).some((l) => typeof l === "object" && l.rel === "canvas-item") ||
      /^Canvas notification/i.test(r.mail.categoryReason))
  );
}

interface TriageJob {
  resource: ResourceView;
  version: string;
  purpose: string;
  categories: string[];
  resourceIds: string[];
  state: unknown;
  send(signal: AbortSignal): Promise<{ result: { model: string; questionVersion: string; affects: Record<string, number> } }>;
  offered: string[];
  upcoming: ResourceView[];
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
    if (!deps.gateway?.triage && !deps.gateway?.mailTriage)
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
        reason: "Jev is over its limit for now; new messages will be sorted later.",
      };
    return {
      status: "on",
      reason: "Jev can raise new announcements and email; code rules decide everything else.",
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

  /** Open, dated work in one course due in the next three weeks, soonest first. */
  function upcomingFor(
    accountScope: string | undefined,
    courseId: string | undefined,
    all: ResourceView[],
    included: (r: ResourceView) => boolean,
  ) {
    if (!accountScope || !courseId) return [];
    const t = nowMs();
    // Resources carry their account through their source; same-named courses stay apart.
    const account = new Map(store.sources().map((s) => [s.id, s.accountScope]));
    return all
      .filter(
        (v) =>
          v.kind === "assignment" &&
          !v.deleted &&
          !v.completed &&
          v.submitted !== true &&
          account.get(v.sourceId) === accountScope &&
          v.courseId === courseId &&
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

  const judgmentKey = (id: string, hash: string, version: string) =>
    `${id}:${hash}:${version}`;

  /** New, non-baseline messages in the window with no judgment for their current content. */
  function newMessages(all: ResourceView[], included: (r: ResourceView) => boolean) {
    const baseline = new Set(store.baselineReadIds?.() ?? []);
    const judged = new Set(store.judgments().map((j) => j.key));
    const ids = new Set(
      store
        .changes({ since: since(), limit: 2000 })
        .filter((c) => c.type === "new" && !baseline.has(c.readId))
        .map((c) => c.resourceId),
    );
    const byId = new Map(all.map((v) => [v.id, v]));
    const fresh = [...ids]
      .map((id) => byId.get(id))
      .filter(
        (v): v is ResourceView =>
          !!v && !v.deleted && v.kind === "message" && included(v),
      );
    const announcements = fresh.filter(
      (v) =>
        !v.mail &&
        !judged.has(judgmentKey(v.id, v.contentHash, MESSAGE_TRIAGE_QUESTION_VERSION)),
    );
    const mail = fresh
      .filter(
        (v) =>
          !!v.mail &&
          v.mail.isRead !== true &&
          TRIAGED_MAIL_CATEGORIES.has(v.mail.category) &&
          !(v.mail.meetingMessageType && v.mail.meetingMessageType !== "none") &&
          !isCanvasNotificationMail(v) &&
          !judged.has(judgmentKey(v.id, v.contentHash, MAIL_TRIAGE_QUESTION_VERSION)),
      )
      .sort((a, b) => b.mail!.receivedAt.localeCompare(a.mail!.receivedAt));
    return { announcements, mail };
  }

  function jobs(all: ResourceView[], included: (r: ResourceView) => boolean): TriageJob[] {
    const gateway = deps.gateway;
    if (!gateway) return [];
    const account = new Map(store.sources().map((s) => [s.id, s.accountScope]));
    const { announcements, mail } = newMessages(all, included);
    const list: TriageJob[] = [];
    if (gateway.triage)
      for (const message of announcements) {
        const scope = account.get(message.sourceId);
        const upcoming = upcomingFor(scope, message.courseId, all, included);
        // Hosted free text is identity-scrubbed field by field, as in context().
        const scrub = payloadScrubber(store, true, scope);
        // An explicit allowlist: course name, message title and text, upcoming work titles/dates.
        const state = messageTriageStateSchema.parse({
          course: scrub.field(message.courseName || "Course", message.courseId).slice(0, 200) || "Course",
          title: scrub.field(message.title || "Announcement", message.courseId).slice(0, 500) || "Announcement",
          text: scrub.field(message.text, message.courseId).slice(0, 4000),
          upcoming: upcoming.map((u, i) => ({
            key: `a${i}`,
            title: (scrub.field(u.title, u.courseId) || "Assignment").slice(0, 300),
            due: formatDue(u.deadline.planningAt!),
          })),
        });
        list.push({
          resource: message,
          version: MESSAGE_TRIAGE_QUESTION_VERSION,
          purpose: "Sort announcement importance",
          categories: categoriesFor(upcoming),
          resourceIds: [message.id, ...upcoming.map((u) => u.id)],
          state,
          offered: state.upcoming.map((u) => u.key),
          upcoming,
          async send(signal) {
            return { result: messageTriageResultSchema.parse(await gateway.triage!(state, signal)) };
          },
        });
      }
    if (gateway.mailTriage)
      for (const email of mail) {
        const facts = email.mail!;
        const courseScope = facts.courseAccountScope ?? account.get(email.sourceId);
        const upcoming = upcomingFor(courseScope, facts.courseId, all, included);
        const courseName = facts.courseId
          ? all.find((v) => v.courseId === facts.courseId && v.kind !== "message")?.courseName
          : undefined;
        const scrub = payloadScrubber(store, true, courseScope);
        const rosterCourse = facts.courseId ?? email.courseId;
        // Only the code's sender role, subject and Outlook's own preview: never a name or address.
        const state = mailTriageStateSchema.parse({
          role: MAIL_ROLE[facts.category] ?? "unknown sender",
          subject: (scrub.field(email.title || "(no subject)", rosterCourse) || "(no subject)").slice(0, 500),
          preview: scrub.field(facts.preview, rosterCourse).slice(0, 255),
          ...(courseName ? { course: scrub.field(courseName, rosterCourse).slice(0, 200) } : {}),
          upcoming: upcoming.map((u, i) => ({
            key: `a${i}`,
            title: (scrub.field(u.title, u.courseId) || "Assignment").slice(0, 300),
            due: formatDue(u.deadline.planningAt!),
          })),
        });
        list.push({
          resource: email,
          version: MAIL_TRIAGE_QUESTION_VERSION,
          purpose: "Sort email importance",
          categories: categoriesFor(upcoming),
          resourceIds: [email.id, ...upcoming.map((u) => u.id)],
          state,
          offered: state.upcoming.map((u) => u.key),
          upcoming,
          async send(signal) {
            return { result: mailTriageResultSchema.parse(await gateway.mailTriage!(state, signal)) };
          },
        });
      }
    return list;
  }

  async function triage() {
    if (!deps.gateway || deps.closed() || nowMs() < pausedUntil) return;
    if (status().status !== "on") return;
    const all = resourceViews(store, store.resources());
    // One inclusion snapshot per pass: the per-call helper reloads every resource.
    const included = courseInclusion(store);
    // Announcements first, then the newest email; the gateway budget bounds the rest.
    for (const job of jobs(all, included).slice(0, TRIAGE_PER_WAKE)) {
      if (deps.closed()) return;
      const r = job.resource;
      const key = `${r.id}:${r.contentHash}:${job.version}`;
      if ((retryAfter.get(key) ?? 0) > nowMs()) continue;
      const receipt = (status: "blocked" | "sent" | "failed") =>
        store.addReceipt({
          id: randomUUID(),
          recipient: "jev",
          purpose: job.purpose,
          categories: job.categories,
          resourceIds: job.resourceIds,
          characters: JSON.stringify(job.state).length,
          status,
          createdAt: deps.now(),
        });
      if (!maySend(store.privacy(), "jev", job.categories).allowed) {
        receipt("blocked");
        return;
      }
      const version = deps.generation();
      const controller = (active = new AbortController());
      const timer = setTimeout(() => controller.abort(), TRIAGE_TIMEOUT_MS);
      try {
        // Log the attempt before crossing the boundary. This does not claim delivery.
        receipt("sent");
        const { result } = await job.send(controller.signal);
        if (Object.keys(result.affects).some((k) => !job.offered.includes(k)))
          throw new Error("Judgment named a task that was not offered.");
        const live = store.resource(r.id);
        if (
          deps.closed() ||
          deps.generation() !== version ||
          controller.signal.aborted ||
          !live ||
          live.deleted ||
          live.contentHash !== r.contentHash ||
          !maySend(store.privacy(), "jev", job.categories).allowed
        )
          continue;
        const judgment: MessageTriageJudgment | MailTriageJudgment = {
          result: result as never,
          upcoming: job.upcoming.map((u, i) => ({
            key: `a${i}`,
            resourceId: u.id,
            title: u.title,
          })),
        };
        store.putJudgment({
          key: judgmentKey(r.id, r.contentHash, job.version),
          resourceId: r.id,
          inputHash: r.contentHash,
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
        // A relay may report every failure the same way, so stop this wake rather than
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
    const mailTriage: Record<string, MailTriageJudgment> = {};
    const byId = new Map(live.map((v) => [v.id, v]));
    const triageStatus = status();
    // Turning Jev off also stops earlier judgments from changing what the student sees.
    if (triageStatus.status !== "off")
      for (const j of store.judgments()) {
        if (byId.get(j.resourceId)?.contentHash !== j.inputHash) continue;
        if (j.questionVersion === MESSAGE_TRIAGE_QUESTION_VERSION)
          triage[j.resourceId] = j.result as MessageTriageJudgment;
        else if (j.questionVersion === MAIL_TRIAGE_QUESTION_VERSION)
          mailTriage[j.resourceId] = j.result as MailTriageJudgment;
      }
    return buildNotifications({
      changes,
      resources: all,
      sources: store.sources(),
      baselineReadIds: store.baselineReadIds?.() ?? [],
      included: courseInclusion(store),
      triage,
      mailTriage,
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
