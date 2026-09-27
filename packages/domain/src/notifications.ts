import type {
  AppNotification,
  DeadlineClaim,
  MailKind,
  MailTriageJudgment,
  MessageKind,
  MessageTriageJudgment,
  NotificationFeed,
  NotificationLevel,
  NotificationReason,
  NotificationState,
  ResourceChange,
  ResourceView,
  SourceHealth,
} from "@magic/contracts";
import { resolveDeadline } from "./index";
import { localTime } from "./today-rail";

/**
 * Every threshold, window and keyword the notification rules use. Code decides each level from
 * these; a cached Jev judgment may only raise a course message (see JEV_THRESHOLDS).
 */
export const NOTIFICATION_RULES = {
  /** Changes older than this are ignored (core already limits the query to about a week). */
  windowDays: 7,
  /** A due time or late cutoff this close (and not past) makes a change urgent. */
  soonHours: 72,
  /** A calendar event this close makes a time change or cancellation urgent. */
  eventSoonHours: 48,
  /** A source whose last successful read is older than this is stale. */
  staleHours: 24,
  /** Source statuses that mean updates are failing now. needs_sign_in has its own notification. */
  failingStatuses: ["error", "inaccessible"],
  /** Source statuses that describe the course, not a failed read; never counted as stale. */
  notStaleStatuses: ["not_published"],
  /** This many new assignments in one course from one read become a single grouped item. */
  groupNewAssignmentsAt: 5,
  /** This many new files and pages in one course from one read become a single grouped item. */
  groupNewMaterialsAt: 2,
  /** The feed keeps at most this many items, highest levels first. */
  maxItems: 50,
  /** A quoted announcement sentence is cut to this many characters. */
  quoteMaxChars: 200,
  /** Submission workflow states that count as turned in. */
  submittedStates: ["submitted", "pending_review", "graded"],
  /**
   * Announcement change test, judged per sentence (case-insensitive, whole words; a space
   * matches any whitespace). A sentence signals a change when it has a change phrase, or a
   * topic word together with a change word — so "the exam will be held in Room 1100" counts
   * and "exam review slides are posted" does not — unless a negation says nothing changed
   * ("the deadline was not extended", "the exam is still Friday as scheduled").
   * Exam mentions are the exception: they always count (messageAlwaysImportant).
   * "final" skips "final project/paper/..." like the Today rail.
   */
  messageChangePhrases: [
    "cancell?ed",
    "cancel+ing",
    "no class(?:es)?",
    "won['’]t meet",
    "will not meet",
    "not meeting",
    "postponed",
    "rescheduled",
    "moved to",
    "pushed (?:back|to)",
    "room change",
    "new room",
  ],
  /** Any exam mention is important on its own (Aidan, Sep 27): exams are never routine news. */
  messageAlwaysImportant: [
    "exams?",
    "midterms?",
    "finals?(?!\\s+(?:project|paper|essay|report|presentation|draft|thoughts)\\b)",
  ],
  messageTopics: [
    "quiz(?:zes)?",
    "due dates?",
    "deadlines?",
    "location",
    "room",
    "homework",
    "hw ?\\d*",
    "problem sets?",
    "psets?",
    "assignments?",
    "projects?",
    "labs?",
    "papers?",
    "lectures?",
    "class",
    "discussion sections?",
    "office hours",
  ],
  messageChangeWords: [
    "extended",
    "extensions?",
    "moved",
    "moving",
    "changed",
    "changes?",
    "now",
    "instead",
    "new (?:date|time|deadline|location|room|due date)",
    "earlier",
    "later",
    "delayed",
    "shifted",
    "revised",
    "updated",
    "will be (?:held|in|on|at|due)",
    "bring",
    "allowed",
    "not allowed",
    "covers?",
    "also includes?",
    "no longer",
  ],
  messageNegations: [
    "not (?:be )?(?:extended|moved|changed|cancell?ed|postponed|rescheduled)",
    "no changes?",
    "unchanged",
    "still (?:on|due|scheduled|at|in)",
    "as (?:scheduled|planned|usual)",
    "remains?",
    "has not changed",
  ],
  // ── email (Outlook mail: kind "message" with `mail`) ──
  /** Link rel and category-reason prefix that mark Canvas's own notification mail (the Canvas change notifies instead). */
  canvasMailRel: "canvas-item",
  canvasMailReasonPrefix: "Canvas notification",
  /**
   * Category-reason prefix graph.ts writes when only the subject names a course. Anyone can put a
   * course code in a subject, so such mail is never labelled course staff and never keyword-urgent.
   */
  subjectOnlyReasonPrefix: "Subject names",
  /** University-office phrases that make an admin email important. Whole words, case-insensitive. */
  mailOfficeKeywords: [
    "holds?",
    "registration",
    "register",
    "enroll(?:ment|ed)?",
    "deadlines?",
    "due",
    "action required",
    "financial aid",
    "fafsa",
    "tuition",
    "bills?",
    "payments?",
    "verify",
  ],
  /** An interview invitation: "interview" plus one of these context words anywhere in subject or preview. */
  mailInterviewWord: "interviews?",
  mailInterviewContext: [
    "invite",
    "invited",
    "invitation",
    "schedul(?:e|ed|ing)",
    "availability",
    "next steps?",
    "round",
  ],
  /** Never an invitation: practice interviews are campus events. */
  mailInterviewExclude: ["mock interviews?"],
  /** Job offers count like interview invitations. */
  mailOfferKeywords: ["job offer", "offer letter", "internship offer", "offer of employment"],
  /** Campus-event words for org, general and admin mail; such mail is info. */
  mailEventKeywords: [
    "events?",
    "workshops?",
    "talks?",
    "seminars?",
    "fairs?",
    "info sessions?",
    "panels?",
    "open house",
    "career fair",
    "speakers?",
  ],
  /** Graph meetingMessageType values that are replies to the student's own invite: never notified (Graph spells one "meetingTenativelyAccepted"). */
  meetingResponsePattern: "^meeting(?:Accepted|Declined|Tent?ativelyAccepted)$",
  /** This many info-level club and list emails from one read become a single grouped item. */
  groupListEmailsAt: 3,
} as const;

/**
 * Provisional, uncalibrated cut-offs for a cached message triage judgment. The top kind counts
 * only when it is both likely (kindMinP) and clearly ahead of the runner-up (kindMinMargin).
 */
export const JEV_THRESHOLDS = { kindMinP: 0.7, kindMinMargin: 0.15, yes: 0.7 } as const;
/** Kinds that may raise a message. Every other kind (general information, new material, other) never raises. */
export const JEV_RAISING_KINDS: readonly MessageKind[] = [
  "deadline_or_schedule_change",
  "exam_logistics",
  "action_required",
  "grade_or_feedback_released",
];

/** Mail kinds that may raise an email to important (urgent when an affected task is due soon). */
export const JEV_MAIL_RAISING_KINDS: readonly MailKind[] = [
  "interview_or_job",
  "deadline_or_action_required",
  "schedule_change_or_cancellation",
  "advisor_or_academic_standing",
];
/** Mail kinds that may at most surface an email as info. newsletter_or_promotion and other never raise. */
export const JEV_MAIL_INFO_KINDS: readonly MailKind[] = [
  "campus_event",
  "club_or_org_update",
  "course_related",
];

export interface NotificationInput {
  /** Stored changes, newest first as storage returns them; already limited by core to ~7 days. */
  changes: ResourceChange[];
  /** Live resources plus the last view of resources referenced by "removed" changes (deleted: true). */
  resources: ResourceView[];
  sources: SourceHealth[];
  /** readId of each source's first import: its "new" changes are baseline, never notified. */
  baselineReadIds: string[];
  /** False for an excluded course: its changes are suppressed. */
  included(resource: ResourceView): boolean;
  /** resourceId → cached judgment for the current content. */
  triage: Record<string, MessageTriageJudgment>;
  /** resourceId → cached email judgment for the current content. */
  mailTriage: Record<string, MailTriageJudgment>;
  triageStatus: NotificationFeed["triage"];
  state: NotificationState;
  now: string;
  timeZone: string;
}

const HOUR = 3600000;
const RANK: Record<NotificationLevel, number> = { urgent: 0, important: 1, info: 2 };
const higher = (a: NotificationLevel, b: NotificationLevel) => (RANK[a] <= RANK[b] ? a : b);
const words = (list: readonly string[]) =>
  new RegExp(`\\b(?:${list.map((k) => k.replaceAll(" ", "\\s+")).join("|")})\\b`, "i");
const EXAM = words(NOTIFICATION_RULES.messageAlwaysImportant);
const CHANGE_PHRASE = words(NOTIFICATION_RULES.messageChangePhrases);
const TOPIC = words(NOTIFICATION_RULES.messageTopics);
const CHANGE_WORD = words(NOTIFICATION_RULES.messageChangeWords);
const NEGATION = words(NOTIFICATION_RULES.messageNegations);
const sentences = (text: string) => text.split(/(?<=[.!?])\s+|\n+/).map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean);
/** Does one sentence say something changed? See NOTIFICATION_RULES.messageChangePhrases. */
function changeSentence(sentence: string) {
  if (EXAM.test(sentence)) return true;
  if (NEGATION.test(sentence)) return false;
  return CHANGE_PHRASE.test(sentence) || (TOPIC.test(sentence) && CHANGE_WORD.test(sentence));
}
/** The announcement change test as a matcher: true when any sentence of the text signals a change. */
const KEYWORD = { test: (text: string) => sentences(text).some(changeSentence) };
const OFFICE = words(NOTIFICATION_RULES.mailOfficeKeywords);
const INTERVIEW = words([NOTIFICATION_RULES.mailInterviewWord]);
const INTERVIEW_CONTEXT = words(NOTIFICATION_RULES.mailInterviewContext);
const INTERVIEW_EXCLUDE = words(NOTIFICATION_RULES.mailInterviewExclude);
const OFFER = words(NOTIFICATION_RULES.mailOfferKeywords);
const EVENT = words(NOTIFICATION_RULES.mailEventKeywords);
const MEETING_RESPONSE = new RegExp(NOTIFICATION_RULES.meetingResponsePattern);

interface Part {
  level: NotificationLevel;
  reason: NotificationReason;
  text: string;
  changes: ResourceChange[];
  evidence?: AppNotification["evidence"];
  raisedBy?: AppNotification["raisedBy"];
}

// ── values carried by changes ────────────────────────────────────────────────────────────────

/** The planning due time a change's values describe; null when due fields are present but empty. */
function dueIn(values: Record<string, unknown>): string | null | undefined {
  if (Array.isArray(values.deadlines))
    return resolveDeadline(values.deadlines as DeadlineClaim[]).planningAt;
  if ("dueAt" in values) return typeof values.dueAt === "string" ? values.dueAt : null;
  return undefined;
}
/** An event's start time in change values: its earliest event/due claim, else dueAt. */
function eventIn(values: Record<string, unknown>): string | null | undefined {
  if (Array.isArray(values.deadlines)) {
    const times = (values.deadlines as DeadlineClaim[])
      .filter((c) => c.kind === "event" || c.kind === "due")
      .map((c) => new Date(c.value).toISOString())
      .sort();
    return times[0] ?? null;
  }
  if ("dueAt" in values) return typeof values.dueAt === "string" ? values.dueAt : null;
  return undefined;
}
function eventTime(r: ResourceView): string | null {
  const claimed = eventIn({ deadlines: r.deadlines ?? [] });
  if (claimed) return claimed;
  if (r.dueAt) return r.dueAt;
  const start = r.calendar?.start;
  return start && start.includes("T") ? start : null;
}
/** Equal values; two date strings compare as instants. */
function same(a: unknown, b: unknown) {
  if (typeof a === "string" && typeof b === "string") {
    const x = Date.parse(a), y = Date.parse(b);
    return Number.isNaN(x) || Number.isNaN(y) ? a === b : x === y;
  }
  return a == b;
}

type Submission = NonNullable<ResourceView["submission"]>;
function submissionIn(values: Record<string, unknown>): Submission | null {
  const s = values.submission;
  return s && typeof s === "object" ? (s as Submission) : null;
}
function isSubmitted(r: ResourceView) {
  const s = r.submission;
  return (
    r.submitted === true ||
    Boolean(s?.submittedAt) ||
    (NOTIFICATION_RULES.submittedStates as readonly string[]).includes(s?.workflowState ?? "") ||
    (s?.score !== undefined && s?.score !== null)
  );
}

// ── formatting ───────────────────────────────────────────────────────────────────────────────

function when(iso: string, now: string, timeZone: string) {
  const at = localTime(iso, timeZone);
  const today = localTime(now, timeZone).date;
  const h = Math.floor(at.min / 60), m = at.min % 60;
  const clock = `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  if (at.date === today) return `Today ${clock}`;
  const days = Math.abs(Date.parse(at.date) - Date.parse(today)) / 86400000;
  const day = new Intl.DateTimeFormat(
    "en-US",
    days <= 6 ? { weekday: "short", timeZone } : { month: "short", day: "numeric", timeZone },
  ).format(new Date(iso));
  return `${day} ${clock}`;
}
const num = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
function scoreText(s: Submission | null, points: number | null) {
  if (s?.score != null && points != null) return `${num(s.score)}/${num(points)}`;
  if (s?.grade) return s.grade;
  if (s?.score != null) return `${num(s.score)} points`;
  return "Grade posted";
}
function quoteFor(title: string, text: string, pattern: { test(s: string): boolean } = KEYWORD): string | null {
  const max = NOTIFICATION_RULES.quoteMaxChars;
  const cut = (s: string) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);
  // Prefer the sentence that says what changed; the title is already shown as the row title.
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    const clean = sentence.replace(/\s+/g, " ").trim();
    if (clean && pattern.test(clean)) return cut(clean);
  }
  return pattern.test(title) ? cut(title.trim()) : null;
}
/** Top kind, its probability and its margin over the runner-up; ties favour the reported kind. */
function topKind<K extends string>(kind: K, probabilities: Record<string, number>) {
  const ranked = (Object.entries(probabilities) as [K, number][]).sort(
    (a, b) => b[1] - a[1] || (a[0] === kind ? -1 : b[0] === kind ? 1 : a[0].localeCompare(b[0])),
  );
  const [top, p] = ranked[0] ?? [kind, 0];
  return { top, p, margin: p - (ranked[1]?.[1] ?? 0) };
}
const gated = (p: number, margin: number, actionRequired: number) =>
  (p >= JEV_THRESHOLDS.kindMinP && margin >= JEV_THRESHOLDS.kindMinMargin) ||
  actionRequired >= JEV_THRESHOLDS.yes;
/** Short deterministic hash for ids built from a set of keys. */
function hash(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

// ── the engine ───────────────────────────────────────────────────────────────────────────────

/**
 * Turns stored changes and current state into the bell feed. Pure and deterministic: no I/O,
 * no clock, no model calls. Code decides every level; a cached Jev judgment may only raise a
 * course message, never lower, hide or dismiss anything.
 */
export function buildNotifications(input: NotificationInput): NotificationFeed {
  const { now, timeZone } = input;
  const nowMs = Date.parse(now);
  const within = (iso: string | null | undefined, hours: number) => {
    if (!iso) return false;
    const d = Date.parse(iso) - nowMs;
    return d >= 0 && d <= hours * HOUR;
  };
  const isPast = (iso: string | null | undefined) => Boolean(iso) && Date.parse(iso!) < nowMs;
  const windowStart = nowMs - NOTIFICATION_RULES.windowDays * 86400000;
  const baseline = new Set(input.baselineReadIds);
  const byId = new Map(input.resources.map((r) => [r.id, r]));
  const live = (id: string) => {
    const r = byId.get(id);
    return r && !r.deleted ? r : undefined;
  };

  // Chronological order: observedAt, then storage order (newest first, so a later index is older).
  const ordered = input.changes
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => {
      const t = Date.parse(c.observedAt);
      return t >= windowStart && t <= nowMs;
    })
    .sort((a, b) => a.c.observedAt.localeCompare(b.c.observedAt) || b.i - a.i)
    .map(({ c }) => c);

  const byResource = new Map<string, ResourceChange[]>();
  for (const c of ordered) {
    const r = byId.get(c.resourceId);
    if (!r || !input.included(r)) continue;
    if (c.type === "new") {
      if (baseline.has(c.readId)) continue;
      // Backfill guard: a later read can record "new" for an old item the first read missed.
      if (r.createdAt && Date.parse(r.createdAt) < windowStart) continue;
    }
    byResource.set(c.resourceId, [...(byResource.get(c.resourceId) ?? []), c]);
  }

  const parts = new Map<string, Part[]>();
  const add = (id: string, p: Part) => parts.set(id, [...(parts.get(id) ?? []), p]);
  const newAssignments = new Map<string, { r: ResourceView; c: ResourceChange }[]>();
  const newMaterials = new Map<string, { r: ResourceView; c: ResourceChange }[]>();
  const groupKey = (r: ResourceView, c: ResourceChange) => `${r.courseId}:${c.readId}`;
  const mails: { item: AppNotification & { list: boolean }; readId: string; change: ResourceChange }[] = [];

  for (const [id, list] of byResource) {
    const r = byId.get(id)!;
    const of = (...types: ResourceChange["type"][]) => list.filter((c) => types.includes(c.type));
    if (r.kind === "assignment") assignmentParts(r, list);
    else if (r.kind === "message" && r.mail) {
      // Email: only a new message notifies; current state (e.g. read) decides the level.
      const created = of("new").at(-1);
      const item = created && !r.deleted ? mailItem(r, created) : null;
      if (item) mails.push({ item, readId: created!.readId, change: created! });
    } else if (r.kind === "message") {
      const created = of("new").at(-1);
      if (created && !r.deleted) add(id, messagePart(r, created));
    } else if (r.kind === "material") {
      const created = of("new").at(-1);
      if (created && !r.deleted)
        newMaterials.set(groupKey(r, created), [...(newMaterials.get(groupKey(r, created)) ?? []), { r, c: created }]);
    } else if (r.kind === "event") eventParts(r, list);
  }

  function assignmentParts(r: ResourceView, list: ResourceChange[]) {
    const id = r.id;
    const rr = list.filter((c) => c.type === "removed" || c.type === "restored");
    const lastRR = rr.at(-1);
    if (lastRR?.type === "removed" && r.deleted) {
      const upcoming = !r.deadline.planningAt || !isPast(r.deadline.planningAt);
      add(id, {
        level: upcoming && !isSubmitted(r) ? "important" : "info",
        reason: "removed",
        text: "Removed from the course",
        changes: rr,
      });
      return;
    }
    if (r.deleted) return;
    if (lastRR?.type === "restored" && !rr.some((c) => c.type === "removed"))
      add(id, { level: "info", reason: "restored", text: "Back in the course", changes: rr });

    const submitted = isSubmitted(r);
    const due = r.deadline.planningAt;
    const past = isPast(due);

    const created = list.filter((c) => c.type === "new").at(-1);
    if (created && !past) {
      const key = groupKey(r, created);
      newAssignments.set(key, [...(newAssignments.get(key) ?? []), { r, c: created }]);
    }

    const graded = list.filter((c) => c.type === "graded");
    if (graded.length) {
      const before = submissionIn(graded[0]!.oldValues);
      const after = submissionIn(graded.at(-1)!.newValues);
      const moreComments = (after?.comments?.length ?? 0) > (before?.comments?.length ?? 0);
      const onlyComments =
        moreComments &&
        same(before?.score ?? null, after?.score ?? null) &&
        same(before?.grade ?? null, after?.grade ?? null) &&
        same(before?.workflowState ?? null, after?.workflowState ?? null);
      add(id, {
        level: "important",
        reason: onlyComments ? "feedback" : "graded",
        text: onlyComments ? "New feedback" : moreComments ? "Grade posted · New feedback" : "Grade posted",
        changes: graded,
      });
    }

    // Date and instruction changes on finished, past work are history, not news.
    if (past && submitted) return;
    const dated = list.filter((c) => c.type === "date_changed");
    const dueChanges = dated.filter((c) => dueIn(c.oldValues) !== undefined || dueIn(c.newValues) !== undefined);
    if (dueChanges.length) {
      const before = dueIn(dueChanges[0]!.oldValues) ?? null;
      const after = dueIn(dueChanges.at(-1)!.newValues) ?? null;
      if (!same(before, after)) {
        const evidence = { ...(before ? { before } : {}), ...(after ? { after } : {}) };
        let part: Omit<Part, "changes">;
        if (before && after) {
          const earlier = Date.parse(after) < Date.parse(before);
          part = {
            level: earlier ? "urgent" : "important",
            reason: earlier ? "due_earlier" : "due_later",
            text: `Due date moved ${earlier ? "earlier" : "later"}: ${when(before, now, timeZone)} → ${when(after, now, timeZone)}`,
            evidence,
          };
        } else if (after)
          part = { level: "important", reason: "due_added", text: `Due date added: ${when(after, now, timeZone)}`, evidence };
        else
          part = { level: "important", reason: "due_removed", text: `Due date removed (was ${when(before!, now, timeZone)})`, evidence };
        add(id, { ...part, level: submitted ? "info" : part.level, changes: dueChanges });
      }
    }
    const lockChanges = dated.filter((c) => "lockAt" in c.oldValues || "lockAt" in c.newValues);
    if (lockChanges.length) {
      const raw = (v: unknown) => (typeof v === "string" ? v : null);
      const before = raw(lockChanges[0]!.oldValues.lockAt);
      const after = raw(lockChanges.at(-1)!.newValues.lockAt);
      if (!same(before, after)) {
        const earlier = after !== null && (before === null || Date.parse(after) < Date.parse(before));
        const text =
          before && after
            ? `Late cutoff changed: ${when(before, now, timeZone)} → ${when(after, now, timeZone)}`
            : after
              ? `Late cutoff added: ${when(after, now, timeZone)}`
              : "Late cutoff removed";
        add(id, {
          level: submitted ? "info" : earlier && within(after, NOTIFICATION_RULES.soonHours) ? "urgent" : "important",
          reason: "cutoff_changed",
          text,
          evidence: { ...(before ? { before } : {}), ...(after ? { after } : {}) },
          changes: lockChanges,
        });
      }
    }
    const instructions = list.filter((c) => c.type === "requirements_changed");
    if (instructions.length)
      add(id, {
        level: submitted || past ? "info" : "important",
        reason: "instructions_changed",
        text: "Instructions updated",
        changes: instructions,
      });

  }

  function messagePart(r: ResourceView, created: ResourceChange): Part {
    const quote = quoteFor(r.title, r.text ?? "");
    const base: Part = quote
      ? { level: "important", reason: "announcement", text: "Course update", evidence: { quote }, changes: [created] }
      : { level: "info", reason: "announcement", text: "New announcement", changes: [created] };
    const judgment = input.triage[r.id];
    if (!judgment) return base;
    const jev = jevLevel(judgment);
    if (!jev || RANK[jev.level] >= RANK[base.level]) return base;
    return {
      ...base,
      level: jev.level,
      raisedBy: { by: "jev", from: base.level, kind: jev.kind, affects: jev.affects, model: judgment.result.model },
    };
  }

  function jevLevel(j: MessageTriageJudgment) {
    const { top, p, margin } = topKind(j.result.kind, j.result.kindProbabilities);
    // A message the model reads as general information, new material or other never raises.
    if (!JEV_RAISING_KINDS.includes(top) || !gated(p, margin, j.result.actionRequired)) return null;
    return { kind: top, ...affectedLevel(j) };
  }
  /** Important, or urgent when an affected task (affects ≥ yes) is live and due within soonHours. */
  function affectedLevel(j: { result: { affects: Record<string, number> }; upcoming: { key: string; resourceId: string }[] }) {
    const affected = j.upcoming
      .filter((u) => (j.result.affects[u.key] ?? 0) >= JEV_THRESHOLDS.yes)
      .map((u) => live(u.resourceId))
      .filter((r): r is ResourceView => Boolean(r));
    const soon = affected.some((r) => within(r.deadline.planningAt, NOTIFICATION_RULES.soonHours));
    return { level: (soon ? "urgent" : "important") as NotificationLevel, affects: affected.map((r) => r.title) };
  }

  /**
   * One new email. Code decides from the sender category and fixed phrases; Jev may raise
   * (never lower); mail the student has already read is capped at info. null = not notified.
   */
  function mailItem(r: ResourceView, created: ResourceChange): (AppNotification & { list: boolean }) | null {
    const mail = r.mail!;
    const rules = NOTIFICATION_RULES;
    if (
      (r.links ?? []).some((l) => typeof l === "object" && l.rel === rules.canvasMailRel) ||
      mail.categoryReason.startsWith(rules.canvasMailReasonPrefix)
    )
      return null;
    if (mail.meetingMessageType && MEETING_RESPONSE.test(mail.meetingMessageType)) return null;
    const subject = r.title;
    const preview = mail.preview ?? "";
    const text = `${subject}\n${preview}`;
    const quote = (pattern: { test(s: string): boolean }) => quoteFor(subject, preview, pattern) ?? undefined;
    // The Canvas course code matched this mail to; mail about an excluded course is suppressed.
    const course = mail.courseId
      ? [...input.resources].sort((x, y) => x.id.localeCompare(y.id)).find((x) => x.courseId === mail.courseId && !x.mail)
      : undefined;
    if (course && !input.included(course)) return null;
    type Decision = { level: NotificationLevel | null; label: string; quote?: string };
    // Course staff: a known staff address (graph.ts), not a subject that merely names the course.
    const staff = mail.category === "course" && !mail.categoryReason.startsWith(rules.subjectOnlyReasonPrefix);
    let decision: Decision;
    switch (mail.category) {
      case "advisor":
        decision = { level: "important", label: "Advisor" };
        break;
      case "course": {
        if (!staff) {
          decision = { level: "important", label: course ? `Mentions ${course.courseName}` : "Mentions a course" };
          break;
        }
        const label = course ? `Course staff · ${course.courseName}` : "Course staff";
        decision = KEYWORD.test(text) ? { level: "urgent", label, quote: quote(KEYWORD) } : { level: "important", label };
        break;
      }
      case "admin":
        decision =
          mail.importance === "high"
            ? { level: "important", label: "University office", quote: OFFICE.test(text) ? quote(OFFICE) : undefined }
            : OFFICE.test(text)
              ? { level: "important", label: "University office", quote: quote(OFFICE) }
              : EVENT.test(text)
                ? { level: "info", label: "Campus event", quote: quote(EVENT) }
                : { level: "info", label: "University office" };
        break;
      case "meeting":
        decision =
          mail.meetingMessageType === "meetingCancelled"
            ? { level: "important", label: "Meeting cancelled" }
            : { level: "info", label: mail.meetingMessageType === "meetingRequest" ? "Meeting invitation" : "Meeting" };
        break;
      case "org":
        decision = EVENT.test(text)
          ? { level: "info", label: "Campus event", quote: quote(EVENT) }
          : { level: "info", label: "Club or list" };
        break;
      default:
        decision = EVENT.test(text)
          ? { level: "info", label: "Campus event", quote: quote(EVENT) }
          : { level: null, label: "Email" };
    }
    // A job interview invitation or offer is important from any sender.
    const interview = !INTERVIEW_EXCLUDE.test(text) && INTERVIEW.test(text) && INTERVIEW_CONTEXT.test(text);
    if ((interview || OFFER.test(text)) && (decision.level === null || RANK[decision.level] > RANK.important))
      decision = { level: "important", label: "Job interview", quote: quote(interview ? INTERVIEW : OFFER) };

    let level = decision.level;
    let raisedBy: AppNotification["raisedBy"];
    const j = input.mailTriage[r.id];
    if (j) {
      const { top, p, margin } = topKind(j.result.kind, j.result.kindProbabilities);
      const strong = JEV_MAIL_RAISING_KINDS.includes(top);
      if ((strong || JEV_MAIL_INFO_KINDS.includes(top)) && gated(p, margin, j.result.actionRequired)) {
        const jev = strong ? affectedLevel(j) : { level: "info" as NotificationLevel, affects: [] };
        // A raise moves at most one level (unnotified counts as info), and never past important
        // unless the sender is course staff: a judgment cannot make an unknown sender urgent.
        const from = level ?? "info";
        const cap = Math.max(RANK[from] - 1, staff ? RANK.urgent : RANK.important);
        const to = RANK[jev.level] < cap ? (Object.keys(RANK) as NotificationLevel[]).find((l) => RANK[l] === cap)! : jev.level;
        if (level === null || RANK[to] < RANK[level]) {
          raisedBy = { by: "jev", from, kind: top, affects: jev.affects, model: j.result.model };
          level = to;
        }
      }
    }
    if (level === null) return null;
    // Already-read mail is listed but never counts toward the badge.
    if (mail.isRead === true && level !== "info") {
      level = "info";
      if (raisedBy && decision.level !== null) raisedBy = undefined;
    }
    const from = mail.fromName?.trim() || mail.fromAddress?.split("@")[0] || undefined;
    return {
      id: `email:${r.id}:${created.id}`,
      level,
      reason: "email",
      title: subject,
      detail: decision.level === null && raisedBy ? "Email" : decision.label,
      courseName: course?.courseName ?? "Outlook mail",
      resourceId: r.id,
      sourceId: r.sourceId,
      observedAt: created.observedAt,
      changeIds: [created.id],
      read: false,
      ...(from ? { from } : {}),
      senderReason: mail.categoryReason,
      ...(decision.quote ? { evidence: { quote: decision.quote } } : {}),
      ...(raisedBy ? { raisedBy } : {}),
      list: level === "info" && !raisedBy && (mail.category === "org" || Boolean(mail.listId)),
    };
  }

  function eventParts(r: ResourceView, list: ResourceChange[]) {
    const soon = (iso: string | null | undefined) => within(iso, NOTIFICATION_RULES.eventSoonHours);
    const removed = list.filter((c) => c.type === "removed");
    if (r.deleted) {
      if (removed.length && soon(eventTime(r)))
        add(r.id, { level: "urgent", reason: "event_cancelled", text: `Cancelled: was ${when(eventTime(r)!, now, timeZone)}`, changes: removed });
      return;
    }
    const dated = list.filter((c) => c.type === "date_changed" && (eventIn(c.oldValues) !== undefined || eventIn(c.newValues) !== undefined));
    if (!dated.length) return;
    const before = eventIn(dated[0]!.oldValues) ?? null;
    const after = eventIn(dated.at(-1)!.newValues) ?? null;
    if (same(before, after)) return;
    const evidence = { ...(before ? { before } : {}), ...(after ? { after } : {}) };
    if (before && !after) {
      if (soon(before))
        add(r.id, { level: "urgent", reason: "event_cancelled", text: `Cancelled: was ${when(before, now, timeZone)}`, evidence, changes: dated });
      return;
    }
    const text =
      before && after
        ? `Time changed: ${when(before, now, timeZone)} → ${when(after, now, timeZone)}`
        : `Time set: ${when(after!, now, timeZone)}`;
    add(r.id, { level: soon(before) || soon(after) ? "urgent" : "info", reason: "event_changed", text, evidence, changes: dated });
  }

  const items: AppNotification[] = [];
  const idOf = (reason: string, subject: string, changes: ResourceChange[]) =>
    `${reason}:${subject}:${changes.at(-1)!.id}`;
  const chronological = (cs: ResourceChange[]) => ordered.filter((c) => cs.includes(c));

  // New assignments: one grouped item for a large drop, otherwise one part per assignment.
  for (const [key, group] of [...newAssignments].sort((a, b) => a[0].localeCompare(b[0]))) {
    const soonCount = group.filter((g) => within(g.r.deadline.planningAt, NOTIFICATION_RULES.soonHours)).length;
    if (group.length >= NOTIFICATION_RULES.groupNewAssignmentsAt) {
      const changes = chronological(group.map((g) => g.c));
      items.push({
        id: idOf("new_assignments", key, changes),
        level: soonCount ? "urgent" : "important",
        reason: "new_assignments",
        title: `${group.length} new assignments`,
        ...(soonCount ? { detail: `${soonCount} due in the next 3 days` } : {}),
        courseName: group[0]!.r.courseName,
        sourceId: group[0]!.r.sourceId,
        courseId: group[0]!.r.courseId,
        observedAt: changes.at(-1)!.observedAt,
        changeIds: changes.map((c) => c.id),
        read: false,
        count: group.length,
      });
    } else
      for (const { r, c } of group) {
        const soon = within(r.deadline.planningAt, NOTIFICATION_RULES.soonHours);
        const due = r.deadline.planningAt;
        (parts.get(r.id) ?? parts.set(r.id, []).get(r.id)!).unshift({
          level: soon ? "urgent" : "important",
          reason: "new_assignment",
          text: due ? `New assignment, due ${when(due, now, timeZone)}` : "New assignment",
          changes: [c],
        });
      }
  }
  // New files and pages: grouped per course per read.
  for (const [key, group] of [...newMaterials].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (group.length >= NOTIFICATION_RULES.groupNewMaterialsAt) {
      const changes = chronological(group.map((g) => g.c));
      items.push({
        id: idOf("new_material", key, changes),
        level: "info",
        reason: "new_material",
        title: `${group.length} new files and pages`,
        courseName: group[0]!.r.courseName,
        sourceId: group[0]!.r.sourceId,
        courseId: group[0]!.r.courseId,
        observedAt: changes.at(-1)!.observedAt,
        changeIds: changes.map((c) => c.id),
        read: false,
        count: group.length,
      });
    } else
      for (const { r, c } of group)
        add(r.id, { level: "info", reason: "new_material", text: "New file or page", changes: [c] });
  }

  // Email: several info-level club and list emails from one read become one grouped row.
  const lists = new Map<string, typeof mails>();
  for (const m of mails) if (m.item.list) lists.set(m.readId, [...(lists.get(m.readId) ?? []), m]);
  const grouped = new Set<string>();
  for (const [readId, group] of [...lists].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (group.length < NOTIFICATION_RULES.groupListEmailsAt) continue;
    const changes = chronological(group.map((g) => g.change));
    const senders = [...new Set(group.map((g) => g.item.from).filter((f): f is string => Boolean(f)))].sort();
    for (const g of group) grouped.add(g.item.id);
    items.push({
      id: idOf("email", `lists:${readId}`, changes),
      level: "info",
      reason: "email",
      title: `${group.length} club and list emails`,
      ...(senders.length
        ? { detail: `From ${senders.slice(0, 3).join(", ")}${senders.length > 3 ? ` and ${senders.length - 3} more` : ""}` }
        : {}),
      courseName: "Outlook mail",
      observedAt: changes.at(-1)!.observedAt,
      changeIds: changes.map((c) => c.id),
      read: false,
      count: group.length,
    });
  }
  for (const { item } of mails)
    if (!grouped.has(item.id)) {
      const { list: _list, ...rest } = item;
      items.push(rest);
    }

  // One notification per item: highest level wins, details join, every change id is kept.
  for (const [id, list] of [...parts].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!list.length) continue;
    const r = byId.get(id)!;
    const top = list.reduce((best, p) => (RANK[p.level] < RANK[best.level] ? p : best));
    const level = list.map((p) => p.level).reduce(higher);
    const changes = chronological(list.flatMap((p) => p.changes));
    const graded = list.some((p) => p.reason === "graded");
    const score = scoreText(r.submission ?? submissionIn(changes.filter((c) => c.type === "graded").at(-1)?.newValues ?? {}), r.points);
    items.push({
      id: idOf(top.reason, id, changes),
      level,
      reason: top.reason,
      title: graded ? `${r.title}: ${score}` : r.title,
      detail: list.map((p) => p.text).join(" · "),
      courseName: r.courseName,
      resourceId: id,
      sourceId: r.sourceId,
      courseId: r.courseId,
      observedAt: changes.at(-1)!.observedAt,
      changeIds: changes.map((c) => c.id),
      read: false,
      ...(top.evidence ? { evidence: top.evidence } : {}),
      ...(top.raisedBy ? { raisedBy: top.raisedBy } : {}),
    });
  }

  // Missing work is current state, not a change: it stays while Canvas says it is missing.
  for (const r of [...input.resources].sort((a, b) => a.id.localeCompare(b.id))) {
    if (r.deleted || r.kind !== "assignment" || !input.included(r)) continue;
    const s = r.submission;
    if (s?.missing !== true || s.excused === true || isSubmitted(r)) continue;
    items.push({
      id: `missing:${r.id}`,
      level: "urgent",
      reason: "missing",
      title: r.title,
      detail: r.deadline.planningAt ? `Marked missing · was due ${when(r.deadline.planningAt, now, timeZone)}` : "Marked missing",
      courseName: r.courseName,
      resourceId: r.id,
      sourceId: r.sourceId,
      courseId: r.courseId,
      observedAt: r.observedAt,
      changeIds: [],
      read: false,
    });
  }

  // Source health. A source whose resources all belong to excluded courses is left out.
  const sourceResources = new Map<string, ResourceView[]>();
  for (const r of input.resources)
    if (!r.deleted) sourceResources.set(r.sourceId, [...(sourceResources.get(r.sourceId) ?? []), r]);
  const sources = [...input.sources]
    .filter((s) => {
      const rs = sourceResources.get(s.id) ?? [];
      return !rs.length || rs.some((r) => input.included(r));
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const maxOf = (xs: (string | null)[]) =>
    xs.filter((x): x is string => Boolean(x)).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null;
  const signedOut = new Map<string, SourceHealth[]>();
  for (const s of sources)
    if (s.status === "needs_sign_in") signedOut.set(s.accountScope, [...(signedOut.get(s.accountScope) ?? []), s]);
  for (const [scope, group] of [...signedOut].sort((a, b) => a[0].localeCompare(b[0]))) {
    const lastSuccess = maxOf(group.map((s) => s.lastSuccessAt));
    items.push({
      id: `sign_in:${scope}:${lastSuccess ?? "never"}`,
      level: "urgent",
      reason: "sign_in",
      title: "Sign in to UW again to keep updates coming",
      detail: lastSuccess ? `Last updated ${when(lastSuccess, now, timeZone)}` : "Not updated yet",
      ...(group.length === 1 ? { sourceId: group[0]!.id } : {}),
      observedAt: maxOf(group.map((s) => s.lastAttemptAt)) ?? now,
      changeIds: [],
      read: false,
      count: group.length,
    });
  }
  const stale = sources.filter(
    (s) =>
      s.status !== "needs_sign_in" &&
      !(NOTIFICATION_RULES.notStaleStatuses as readonly string[]).includes(s.status) &&
      ((NOTIFICATION_RULES.failingStatuses as readonly string[]).includes(s.status) ||
        (s.lastSuccessAt !== null && nowMs - Date.parse(s.lastSuccessAt) > NOTIFICATION_RULES.staleHours * HOUR)),
  );
  if (stale.length) {
    const names = stale.slice(0, 3).map((s) => s.label);
    items.push({
      id: `source_stale:${hash(stale.map((s) => s.id).join(","))}:${maxOf(stale.map((s) => s.lastSuccessAt)) ?? "never"}`,
      level: "important",
      reason: "source_stale",
      title:
        stale.length === 1
          ? "One source isn't updating"
          : `${stale.length} sources aren't updating`,
      detail: `Updates may be missing from ${names.join(", ")}${stale.length > names.length ? ` and ${stale.length - names.length} more` : ""}`,
      ...(stale.length === 1 ? { sourceId: stale[0]!.id } : {}),
      observedAt: maxOf(stale.map((s) => s.lastAttemptAt)) ?? now,
      changeIds: [],
      read: false,
      count: stale.length,
    });
  }

  const dismissed = new Set(input.state.dismissedIds);
  const read = new Set(input.state.readIds);
  const shown = items
    .filter((n) => !dismissed.has(n.id))
    .map((n) => ({ ...n, read: read.has(n.id) }))
    .sort(
      (a, b) =>
        RANK[a.level] - RANK[b.level] ||
        Date.parse(b.observedAt) - Date.parse(a.observedAt) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, NOTIFICATION_RULES.maxItems);
  return {
    items: shown,
    unread: shown.filter((n) => n.level !== "info" && !n.read).length,
    checkedAt: maxOf(input.sources.map((s) => s.lastSuccessAt)),
    degraded: signedOut.size > 0 || stale.length > 0,
    triage: input.triageStatus,
  };
}
