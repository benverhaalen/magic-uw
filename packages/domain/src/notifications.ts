import type {
  AppNotification,
  DeadlineClaim,
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
   * Announcement phrases that make a course message important. Case-insensitive, whole words;
   * a space matches any whitespace. "final" skips "final project/paper/..." like the Today rail.
   */
  messageKeywords: [
    "cancell?ed",
    "no class",
    "won['’]t meet",
    "will not meet",
    "postponed",
    "rescheduled",
    "moved to",
    "room change",
    "new room",
    "location",
    "exams?",
    "midterms?",
    "finals?(?!\\s+(?:project|paper|essay|report|presentation|draft|thoughts)\\b)",
    "quiz(?:zes)?",
    "due date",
    "deadlines?",
    "extended",
    "extension",
  ],
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
  triageStatus: NotificationFeed["triage"];
  state: NotificationState;
  now: string;
  timeZone: string;
}

const HOUR = 3600000;
const RANK: Record<NotificationLevel, number> = { urgent: 0, important: 1, info: 2 };
const higher = (a: NotificationLevel, b: NotificationLevel) => (RANK[a] <= RANK[b] ? a : b);
const KEYWORD = new RegExp(
  `\\b(?:${NOTIFICATION_RULES.messageKeywords.map((k) => k.replaceAll(" ", "\\s+")).join("|")})\\b`,
  "i",
);

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
function quoteFor(title: string, text: string): string | null {
  const max = NOTIFICATION_RULES.quoteMaxChars;
  const cut = (s: string) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);
  // Prefer the sentence that says what changed; the title is already shown as the row title.
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    const clean = sentence.replace(/\s+/g, " ").trim();
    if (clean && KEYWORD.test(clean)) return cut(clean);
  }
  return KEYWORD.test(title) ? cut(title.trim()) : null;
}
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

  for (const [id, list] of byResource) {
    const r = byId.get(id)!;
    const of = (...types: ResourceChange["type"][]) => list.filter((c) => types.includes(c.type));
    if (r.kind === "assignment") assignmentParts(r, list);
    else if (r.kind === "message") {
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
    const t = JEV_THRESHOLDS;
    const probs = Object.entries(j.result.kindProbabilities) as [MessageKind, number][];
    const ranked = [...probs].sort((a, b) => b[1] - a[1] || (a[0] === j.result.kind ? -1 : b[0] === j.result.kind ? 1 : a[0].localeCompare(b[0])));
    const [top, topP] = ranked[0] ?? [j.result.kind, 0];
    const margin = topP - (ranked[1]?.[1] ?? 0);
    // A message the model reads as general information, new material or other never raises.
    if (!JEV_RAISING_KINDS.includes(top)) return null;
    const gated = topP >= t.kindMinP && margin >= t.kindMinMargin;
    if (!gated && j.result.actionRequired < t.yes) return null;
    const affected = j.upcoming
      .filter((u) => (j.result.affects[u.key] ?? 0) >= t.yes)
      .map((u) => ({ u, r: live(u.resourceId) }))
      .filter((x) => x.r);
    const soon = affected.some((x) => within(x.r!.deadline.planningAt, NOTIFICATION_RULES.soonHours));
    return {
      level: (soon ? "urgent" : "important") as NotificationLevel,
      kind: top,
      affects: affected.map((x) => x.r!.title),
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
        observedAt: changes.at(-1)!.observedAt,
        changeIds: changes.map((c) => c.id),
        read: false,
        count: group.length,
      });
    } else
      for (const { r, c } of group)
        add(r.id, { level: "info", reason: "new_material", text: "New file or page", changes: [c] });
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
