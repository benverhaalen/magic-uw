/**
 * The session schedule behind notes: `SessionsPort.sessions(courseId, range)`. The adapter here
 * reads what exists today, in order of trust:
 *   1. the planning enrollment's class meetings (local-only; never sent to AI),
 *   2. the course map's sessions (course_sessions, schema v6),
 *   3. timed Canvas calendar events that name a lecture, discussion or lab.
 * Assignment events and all-day events are never sessions. When the material pipeline's
 * `agenda(date)` lands, it becomes another adapter behind the same port.
 */
import type {
  CourseCoreStore,
  PlanningEnrollmentPackage,
  PlanningMeeting,
  Resource,
  SessionType,
  Store,
  StoredPlanningRecord,
  NoteSessionRef,
} from "@magic/contracts";
import { buildCourseIdentityTable, resolveCourseIdentity } from "../../domain/src/planning";
import { subjectOf } from "./templates/index";

export const ZONE = "America/Chicago";
export interface NoteSession extends NoteSessionRef {
  accountScope: string;
  courseId: string;
  courseName: string;
  /** The course-map session this came from, when there is one (its map links name readings). */
  courseSessionId: string | null;
}
export interface DateRange {
  /** Inclusive local dates (America/Chicago), YYYY-MM-DD. */
  from: string;
  to: string;
}
export interface SessionsPort {
  sessions(courseId: string, range: DateRange): NoteSession[];
}
export type SessionStore = Pick<Store, "resources" | "sources" | "planningRecords"> & Pick<CourseCoreStore, "courseSessions">;

const dateParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
/** A local date and minute of day in Chicago for an instant. */
export function chicago(at: Date): { date: string; minute: number } {
  const p = Object.fromEntries(dateParts.formatToParts(at).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
}
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
/** 1 = Monday … 7 = Sunday, as planning meetings count them. */
export function weekday(date: string): number {
  return ((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
}
/** This week (from Monday) plus next week: the notes' rolling window. */
export function rollingWindow(now: Date): DateRange {
  const today = chicago(now).date;
  const monday = addDays(today, 1 - weekday(today));
  return { from: monday, to: addDays(monday, 13) };
}

/** A session's id: the course, the local date and the session type (one note per course, day and type). */
export function sessionIdOf(courseId: string, date: string, type: SessionType): string {
  return `${courseId}/${date}:${type}`;
}
export function parseSessionId(id: string): { courseId: string; date: string; type: SessionType } | null {
  const m = /^(.+)\/(\d{4}-\d{2}-\d{2}):(lecture|discussion|lab|other)$/.exec(id);
  return m ? { courseId: m[1]!, date: m[2]!, type: m[3] as SessionType } : null;
}
export function typeFromTitle(title: string): { type: SessionType; basis: string } | null {
  if (/\b(lab|laboratory)\b/i.test(title)) return { type: "lab", basis: "title names a lab" };
  if (/\b(discussion|dis|recitation|section|seminar|quiz section)\b/i.test(title))
    return { type: "discussion", basis: "title names a discussion" };
  if (/\b(lecture|lec|class)\b/i.test(title)) return { type: "lecture", basis: "title names a lecture" };
  return null;
}

export interface CanvasCourseInfo {
  accountScope: string;
  courseId: string;
  courseName: string;
  courseCode: string | null;
  startAt: string | null;
  endAt: string | null;
  url: string;
}
/** The Canvas course resource for a course, with its account scope. */
export function courseInfo(store: Pick<Store, "resources" | "sources">, courseId: string, accountScope?: string): CanvasCourseInfo | null {
  const sources = new Map(store.sources().map((s) => [s.id, s]));
  const rows = store
    .resources()
    .filter((r) => !r.deleted && r.courseId === courseId && sources.has(r.sourceId))
    .filter((r) => !accountScope || sources.get(r.sourceId)!.accountScope === accountScope)
    .filter((r) => sources.get(r.sourceId)!.kind !== "notes");
  const course = rows.find((r) => r.kind === "course") ?? rows[0];
  if (!course) return null;
  return {
    accountScope: sources.get(course.sourceId)!.accountScope,
    courseId,
    courseName: course.courseName,
    courseCode: course.course?.courseCode ?? null,
    startAt: course.course?.startAt ?? null,
    endAt: course.course?.endAt ?? null,
    url: course.url,
  };
}

/** The enrollment package for this Canvas course: by the Guide's subject table, else catalog number and title. */
function packageFor(records: StoredPlanningRecord[], course: CanvasCourseInfo): PlanningEnrollmentPackage | null {
  const live = records.filter((r) => !r.deleted);
  const packages = live.filter(
    (r): r is StoredPlanningRecord & PlanningEnrollmentPackage => r.kind === "enrollment_package" && r.enrollmentState === "enrolled",
  );
  if (!packages.length) return null;
  const subject = subjectOf(course);
  if (!subject) return null;
  let keys: string[] = [];
  try {
    const table = buildCourseIdentityTable(
      live.filter((r): r is Extract<StoredPlanningRecord, { kind: "subject" }> => r.kind === "subject"),
      live.filter((r): r is Extract<StoredPlanningRecord, { kind: "crosslist" }> => r.kind === "crosslist"),
    );
    const identity = resolveCourseIdentity({ subject: subject.subject, catalog: subject.catalog }, table);
    if (identity.status === "resolved") keys = [identity.courseKey];
  } catch {
    keys = [];
  }
  if (!keys.length) {
    // No subject table: the catalog number plus the exact course title from the enrollment's catalog record.
    const title = course.courseName.replace(/\([^)]*\)/g, " ").split(":").slice(1).join(":").replace(/\b(?:FA|SP|SU)\d{2}\b/g, "");
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    keys = live
      .filter((r): r is Extract<StoredPlanningRecord, { kind: "catalog_course" }> => r.kind === "catalog_course")
      .filter((c) => c.courseKey.endsWith(`:${subject.catalog}`) && norm(c.title) === norm(title))
      .map((c) => c.courseKey);
  }
  const matches = packages.filter((p) => keys.includes(p.courseKey));
  // Several packages for one course (different terms): the one whose meetings cover the course dates.
  if (matches.length <= 1) return matches[0] ?? null;
  const start = course.startAt?.slice(0, 10) ?? "";
  return (
    matches.find((p) => p.meetings.some((m) => m.startDate && m.endDate && m.startDate <= addDays(start || m.startDate, 14) && m.endDate >= start)) ??
    null
  );
}

/** Which section a meeting belongs to: code's rule from the package's section components. */
function meetingType(pkg: PlanningEnrollmentPackage, meeting: PlanningMeeting, all: PlanningMeeting[]): { type: SessionType; section: string | null; basis: string } {
  const sections = pkg.sections.map((s) => ({ label: s, component: s.split(/\s+/)[0]!.toUpperCase() }));
  const of = (c: string[]) => sections.find((s) => c.includes(s.component)) ?? null;
  const lec = of(["LEC"]), dis = of(["DIS", "SEM", "REC"]), lab = of(["LAB", "FLD", "STU"]);
  const kinds = [lec, dis, lab].filter(Boolean);
  if (kinds.length === 1) {
    const only = kinds[0]!;
    const type: SessionType = only === lec ? "lecture" : only === dis ? "discussion" : "lab";
    return { type, section: only.label, basis: `${only.component} section only` };
  }
  const scheduled = all.filter((m) => m.kind === "class" && m.mode === "scheduled");
  const most = Math.max(...scheduled.map((m) => m.days.length));
  const minutes = (m: PlanningMeeting) => (m.endMinute ?? 0) - (m.startMinute ?? 0);
  if (lec && meeting.days.length === most && scheduled.filter((m) => m.days.length === most).length === 1)
    return { type: "lecture", section: lec.label, basis: "meets most days a week (LEC)" };
  if (lab && minutes(meeting) >= 100) return { type: "lab", section: lab.label, basis: "100+ minutes (LAB)" };
  if (dis) return { type: "discussion", section: dis.label, basis: "shorter weekly meeting (DIS)" };
  if (lab) return { type: "lab", section: lab.label, basis: "other meeting (LAB)" };
  return { type: "lecture", section: lec?.label ?? null, basis: "LEC" };
}

function enrollmentSessions(store: SessionStore, course: CanvasCourseInfo, range: DateRange): NoteSession[] {
  const pkg = packageFor(store.planningRecords(), course);
  if (!pkg) return [];
  const out: NoteSession[] = [];
  for (const meeting of pkg.meetings) {
    if (meeting.kind !== "class" || meeting.mode !== "scheduled" || !meeting.startDate || !meeting.endDate) continue;
    const { type, section, basis } = meetingType(pkg, meeting, pkg.meetings);
    const from = meeting.startDate > range.from ? meeting.startDate : range.from;
    const to = meeting.endDate < range.to ? meeting.endDate : range.to;
    for (let date = from; date <= to; date = addDays(date, 1)) {
      if (!meeting.days.includes(weekday(date))) continue;
      out.push({
        id: sessionIdOf(course.courseId, date, type),
        type,
        date,
        startMinute: meeting.startMinute,
        endMinute: meeting.endMinute,
        title: `${type[0]!.toUpperCase()}${type.slice(1)}`,
        section,
        location: meeting.location,
        origin: "enrollment",
        typeBasis: basis,
        accountScope: course.accountScope,
        courseId: course.courseId,
        courseName: course.courseName,
        courseSessionId: null,
      });
    }
  }
  return out;
}

function mapSessions(store: SessionStore, course: CanvasCourseInfo, range: DateRange): NoteSession[] {
  return store
    .courseSessions({ accountScope: course.accountScope, courseId: course.courseId })
    .flatMap((s): NoteSession[] => {
      if (!s.date) return [];
      const at = s.date.length > 10 ? chicago(new Date(s.date)) : { date: s.date, minute: null };
      if (at.date < range.from || at.date > range.to) return [];
      const typed = typeFromTitle(s.title) ?? { type: "lecture" as const, basis: "course schedule row" };
      return [
        {
          id: sessionIdOf(course.courseId, at.date, typed.type),
          type: typed.type,
          date: at.date,
          startMinute: at.minute,
          endMinute: null,
          title: s.title,
          section: null,
          location: null,
          origin: "course_session",
          typeBasis: typed.basis,
          accountScope: course.accountScope,
          courseId: course.courseId,
          courseName: course.courseName,
          courseSessionId: s.id,
        },
      ];
    });
}

function calendarSessions(resources: Resource[], course: CanvasCourseInfo, range: DateRange): NoteSession[] {
  return resources.flatMap((r): NoteSession[] => {
    const cal = r.calendar;
    if (r.deleted || r.courseId !== course.courseId || !cal || cal.allDay || r.kind === "assignment") return [];
    if (cal.uid.startsWith("event-assignment") || cal.assignmentExternalId) return [];
    const typed = typeFromTitle(r.title);
    if (!typed) return [];
    const start = new Date(cal.start);
    if (!Number.isFinite(start.getTime())) return [];
    const at = chicago(start);
    if (at.date < range.from || at.date > range.to) return [];
    const end = cal.end ? new Date(cal.end) : null;
    return [
      {
        id: sessionIdOf(course.courseId, at.date, typed.type),
        type: typed.type,
        date: at.date,
        startMinute: at.minute,
        endMinute: end && Number.isFinite(end.getTime()) ? chicago(end).minute : null,
        title: r.title.replace(/\s*\[[^\]]*\]\s*$/, "").trim() || r.title,
        section: null,
        location: cal.location ?? null,
        origin: "calendar",
        typeBasis: typed.basis,
        accountScope: course.accountScope,
        courseId: course.courseId,
        courseName: course.courseName,
        courseSessionId: null,
      },
    ];
  });
}

const RANK: Record<NoteSession["origin"], number> = { enrollment: 0, course_session: 1, calendar: 2 };
/**
 * A read-through view for one operation: each list is read from SQLite once. A refresh reads the
 * same resources for every course and session; without this it decodes them dozens of times.
 */
export function memoStore<S extends SessionStore>(store: S): S {
  const cache = new Map<string, unknown>();
  const once = <T>(key: string, read: () => T): T => {
    if (!cache.has(key)) cache.set(key, read());
    return cache.get(key) as T;
  };
  return {
    ...store,
    resources: (search?: string) => (search === undefined ? once("resources", () => store.resources()) : store.resources(search)),
    sources: () => once("sources", () => store.sources()),
    planningRecords: () => once("planning", () => store.planningRecords()),
    courseSessions: (course?: Parameters<S["courseSessions"]>[0]) => once(`sessions:${JSON.stringify(course ?? null)}`, () => store.courseSessions(course)),
  };
}
/** The adapter over what exists today. One session per course, date and type; the most exact source wins. */
export function createSessionsAdapter(
  source: SessionStore | (() => SessionStore),
): SessionsPort & { course(courseId: string, accountScope?: string): CanvasCourseInfo | null } {
  const read = typeof source === "function" ? source : () => source;
  return {
    course: (courseId, accountScope) => courseInfo(read(), courseId, accountScope),
    sessions(courseId, range) {
      const store = read();
      const course = courseInfo(store, courseId);
      if (!course) return [];
      const all = [
        ...enrollmentSessions(store, course, range),
        ...mapSessions(store, course, range),
        ...calendarSessions(store.resources(), course, range),
      ];
      const byId = new Map<string, NoteSession>();
      for (const s of all.sort((a, b) => RANK[a.origin] - RANK[b.origin])) {
        const kept = byId.get(s.id);
        if (!kept) byId.set(s.id, s);
        // A course-map row adds its title and readings to a meeting from the enrollment.
        else if (s.origin === "course_session" && !kept.courseSessionId) byId.set(s.id, { ...kept, title: s.title, courseSessionId: s.courseSessionId });
      }
      return [...byId.values()].sort((a, b) => a.date.localeCompare(b.date) || (a.startMinute ?? 0) - (b.startMinute ?? 0));
    },
  };
}
