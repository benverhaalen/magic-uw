/**
 * `agenda(date, tz)`: one day-by-day list merged from the canonical dates code already holds:
 * assignment and quiz due (else lock) dates, Canvas calendar events, Outlook events, the planning
 * enrollment's class meetings, stored assessments, and, lowest priority, quoted exam dates from
 * `material_facts` (dropped when a canonical entry covers the same course and day).
 *
 * The same item seen through the assignments list, the to-do list, upcoming events, activity, a
 * module item and the calendar feed is one entry; its date comes from the most authoritative copy.
 * Planning data is read locally here and never enqueued for Jev or a model.
 */
import { OUTLOOK_CALENDAR_COURSE_ID, type Resource, type SourceHealth } from "@magic/contracts";
import { courseInclusion } from "../access";
import type { Agenda, AgendaEntry, AgendaGroup } from "../../../contracts/src/course-core";
import { graphCall, type PipelineStore } from "./course-index";
import { references } from "./references";

export type { Agenda, AgendaEntry, AgendaGroup };

export interface AgendaInput {
  date: string;
  tz: string;
  /** Days from `date` (default 14); overdue items from the 14 days before are added. */
  days?: number;
  now?: string;
  /** Attach each assignment's references (default true). */
  withReferences?: boolean;
}

const authority: Record<string, number> = {
  assignments: 0,
  quizzes: 0,
  "account-todo": 1,
  "account-upcoming-events": 2,
  "account-activity": 3,
  "module-items": 4,
  calendar_feed: 5,
};
const rankOf = (scope: string) => authority[scope] ?? 6;

function offsetMs(at: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - Math.floor(at / 1000) * 1000;
}
/** The instant a local calendar day starts in `tz` (DST-correct). */
export function dayStart(date: string, tz: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - offsetMs(guess, tz);
  return guess - offsetMs(first, tz);
}
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
export function localDate(at: number, tz: string): string {
  return new Date(at + offsetMs(at, tz)).toISOString().slice(0, 10);
}
const doneStates = new Set(["submitted", "graded", "pending_review", "complete"]);
const noSubmission = new Set(["none", "not_graded", "on_paper"]);
const isDateOnly = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
const examWords = /\b(exam|midterm|final|quiz|test)\b/i;
const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

interface Family {
  key: string;
  kind: AgendaEntry["kind"];
  accountScope: string;
  courseId: string;
  courseName: string;
  copies: { r: Resource; scope: string; at: string | undefined; dateKind: AgendaEntry["dateKind"]; allDay: boolean }[];
  canonicalId?: string;
}

export function agenda(store: PipelineStore, input: AgendaInput): Agenda {
  const days = input.days ?? 14;
  const now = Date.parse(input.now ?? new Date().toISOString());
  const from = dayStart(input.date, input.tz);
  const to = dayStart(addDays(input.date, days), input.tz);
  const overdueFrom = dayStart(addDays(input.date, -14), input.tz);
  const todayEnd = dayStart(addDays(input.date, 1), input.tz);
  const weekEnd = dayStart(addDays(input.date, 7), input.tz);
  const sources = new Map<string, SourceHealth>(store.sources().map((s) => [s.id, s]));
  const included = courseInclusion(store);
  // One read of each course's index and references for the whole agenda, not one per entry.
  const call = graphCall(store);
  const families = new Map<string, Family>();
  const family = (key: string, kind: Family["kind"], r: Resource, source: SourceHealth) => {
    let f = families.get(key);
    if (!f) families.set(key, (f = { key, kind, accountScope: source.accountScope, courseId: r.courseId, courseName: r.courseName, copies: [] }));
    return f;
  };

  const all = store.resources();
  for (const r of all) {
    const source = sources.get(r.sourceId);
    if (!source) continue;
    const outlook = r.courseId === OUTLOOK_CALENDAR_COURSE_ID;
    if (!outlook && !included(r)) continue;
    const scope = source.scope.split(":")[0]!;
    const course = `${source.accountScope}:${r.courseId}`;
    if (r.calendar) {
      const linked = r.calendar.assignmentExternalId ?? /^event-assignment-(\d+)$/.exec(r.calendar.uid)?.[1];
      const f = linked
        ? family(`A:${course}:${linked}`, "assignment", r, source)
        : family(`E:${course}:${r.calendar.uid}:${r.calendar.recurrenceId ?? r.calendar.start}`, "event", r, source);
      f.copies.push({ r, scope, at: r.calendar.start, dateKind: linked ? "due" : "starts", allDay: r.calendar.allDay || isDateOnly(r.calendar.start) });
      continue;
    }
    if (scope === "submissions") continue;
    const mi = r.moduleItem;
    if (mi && (mi.type === "Assignment" || mi.type === "Quiz") && mi.contentId) {
      const quiz = mi.type === "Quiz";
      const f = family(`${quiz ? "Q" : "A"}:${course}:${mi.contentId}`, quiz ? "quiz" : "assignment", r, source);
      const at = mi.dueAt ?? r.dueAt ?? undefined;
      f.copies.push({ r, scope, at: at ?? mi.lockInfo?.lockAt ?? undefined, dateKind: at ? "due" : "closes", allDay: false });
      continue;
    }
    if (r.kind === "assignment" || scope === "quizzes") {
      const quiz = scope === "quizzes";
      const f = family(`${quiz ? "Q" : "A"}:${course}:${r.externalId}`, quiz ? "quiz" : "assignment", r, source);
      const due = r.dueAt ?? r.deadlines.find((d) => d.kind === "due")?.value;
      f.copies.push({ r, scope, at: due ?? r.lockAt ?? undefined, dateKind: due ? "due" : "closes", allDay: false });
    }
  }

  const entries: AgendaEntry[] = [];
  const place = (at: number): AgendaGroup | undefined =>
    at < from ? undefined : at < todayEnd ? "today" : at < weekEnd ? "week" : at < to ? "later" : undefined;
  for (const f of families.values()) {
    const copies = [...f.copies].sort((a, b) => rankOf(a.scope) - rankOf(b.scope));
    const dated = copies.find((c) => c.at);
    if (!dated?.at) continue;
    const at = dated.allDay && isDateOnly(dated.at) ? dayStart(dated.at, input.tz) : Date.parse(dated.at);
    const best = copies[0]!;
    const submitted = copies.some(
      (c) => c.r.submitted === true || c.r.completed || !!c.r.submission?.submittedAt || doneStates.has(c.r.submission?.workflowState ?? ""),
    )
      ? true
      : copies.some((c) => c.r.submitted === false) ? false : null;
    // Overdue needs evidence: Canvas's own missing flag, or an unsubmitted online submission.
    const submission = copies.find((c) => c.r.submission)?.r.submission;
    const types = copies.find((c) => c.r.submissionTypes?.length)?.r.submissionTypes ?? [];
    const needsSubmission = types.some((t) => !noSubmission.has(t));
    const missing = submission?.missing === true || (submitted === false && needsSubmission && submission?.missing !== false);
    let group: AgendaGroup | undefined;
    if (f.kind !== "event" && at < now && dated.dateKind === "due") group = at >= overdueFrom && missing ? "overdue" : at >= from ? place(at) : undefined;
    else group = place(at);
    if (!group) continue;
    const canonical = copies.find((c) => rankOf(c.scope) === 0) ?? best;
    entries.push({
      key: f.key,
      kind: f.kind === "assignment" && examWords.test(best.r.title) ? "exam" : f.kind,
      title: best.r.moduleItem?.title ?? best.r.title,
      accountScope: f.accountScope,
      courseId: f.courseId,
      courseName: f.courseName,
      at: new Date(at).toISOString(),
      allDay: dated.allDay,
      dateKind: dated.dateKind,
      group,
      authority: dated.scope,
      resourceIds: [...new Set(copies.map((c) => c.r.id))],
      submitted,
      references: f.kind === "event" || input.withReferences === false ? [] : references(store, canonical.r.id, call),
    });
  }

  // Stored assessments (syllabus, Jev or the student) and quoted exam dates: lower priority.
  const covered = (accountScope: string, courseId: string, at: number, title: string) =>
    entries.some(
      (e) =>
        e.accountScope === accountScope && e.courseId === courseId &&
        localDate(Date.parse(e.at), input.tz) === localDate(at, input.tz) &&
        (e.kind === "exam" || e.kind === "quiz" || norm(e.title).includes(norm(title)) || norm(title).includes(norm(e.title))),
    );
  for (const a of store.assessments()) {
    if (!a.date) continue;
    const at = isDateOnly(a.date) ? dayStart(a.date, input.tz) : Date.parse(a.date);
    const group = place(at);
    if (!group || covered(a.accountScope, a.courseId, at, a.title)) continue;
    entries.push({
      key: `X:${a.accountScope}:${a.courseId}:${a.id}`, kind: "exam", title: a.title, accountScope: a.accountScope, courseId: a.courseId,
      courseName: a.courseId, at: new Date(at).toISOString(), allDay: isDateOnly(a.date), dateKind: "due", group,
      authority: `assessment:${a.origin}`, resourceIds: a.resourceId ? [a.resourceId] : [], submitted: null, references: [],
    });
  }
  for (const r of all) {
    const source = sources.get(r.sourceId);
    if (!source || !r.text || !included(r)) continue;
    const scope = source.scope.split(":")[0]!;
    if (scope !== "syllabus" && !(examWords.test(r.title) && (scope === "page" || scope === "files"))) continue;
    for (const fact of store.materialFacts(r.id)) {
      if (fact.kind !== "date" || !fact.quote || !examWords.test(fact.quote)) continue;
      const at = dayStart(fact.value, input.tz);
      const group = place(at);
      if (!group || covered(source.accountScope, r.courseId, at, fact.quote)) continue;
      const key = `F:${source.accountScope}:${r.courseId}:${fact.value}:${norm(fact.quote).slice(0, 60)}`;
      if (entries.some((e) => e.key === key)) continue;
      entries.push({
        key, kind: "exam", title: fact.quote.slice(0, 120), accountScope: source.accountScope, courseId: r.courseId, courseName: r.courseName,
        at: new Date(at).toISOString(), allDay: true, dateKind: "due", group, authority: "material_facts",
        resourceIds: [r.id], submitted: null, references: [],
      });
    }
  }

  // Class meetings from the planning enrollment (local only).
  for (const record of store.planningRecords()) {
    if (record.deleted || record.kind !== "enrollment_package" || record.enrollmentState !== "enrolled") continue;
    for (const meeting of record.meetings) {
      if (meeting.kind !== "class" || meeting.mode !== "scheduled" || meeting.startMinute === null) continue;
      for (let d = 0; d < days; d++) {
        const date = addDays(input.date, d);
        if (meeting.startDate && date < meeting.startDate) continue;
        if (meeting.endDate && date > meeting.endDate) continue;
        const weekday = ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1; // 1 = Monday
        if (!meeting.days.includes(weekday)) continue;
        const at = dayStart(date, meeting.timezone) + meeting.startMinute * 60_000;
        const group = place(at);
        if (!group) continue;
        entries.push({
          key: `C:${record.localId}:${date}:${meeting.startMinute}`, kind: "class", title: `${record.courseKey} ${record.sections.join(", ")}`,
          accountScope: record.accountScope, courseId: record.courseKey, courseName: record.courseKey, at: new Date(at).toISOString(),
          allDay: false, dateKind: "starts", group, authority: "planning", resourceIds: [], submitted: null, references: [],
        });
      }
    }
  }

  entries.sort((a, b) => a.at.localeCompare(b.at) || a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title));
  const groups: Record<AgendaGroup, AgendaEntry[]> = { overdue: [], today: [], week: [], later: [] };
  for (const e of entries) groups[e.group].push(e);
  return { date: input.date, tz: input.tz, from: new Date(from).toISOString(), to: new Date(to).toISOString(), entries, groups };
}
