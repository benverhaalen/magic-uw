// owner: T33 (this lane): the freshness probes at the end of this file.
import { z } from "zod";
import { CanvasFailure, canvasNextPage, type CanvasHttp } from "./canvas-http";
import { hashCanvas } from "./canvas-models";
import { readCanvasModules, moduleItemsHash, type CanvasModuleRun } from "./canvas-modules";
// end owner: T33
export interface SelectableCanvasCourse {
  id: string | number;
  name?: string | null;
  course_code?: string | null;
  workflow_state?: string;
  access_restricted_by_date?: boolean;
  concluded?: boolean;
  /** Connector-owned discovery context; never accepted from a source payload. */
  historicalOnly?: boolean;
  start_at?: string | null;
  end_at?: string | null;
  term?: {
    id?: string | number;
    name?: string | null;
    start_at?: string | null;
    end_at?: string | null;
  } | null;
  enrollments?: Array<{ type?: string; enrollment_state?: string }> | null;
  /** Canvas: the course's own dates override the term's for enrollment activity. */
  restrict_enrollments_to_course_dates?: boolean | null;
}
export interface CanvasCourseOverride {
  accountScope: string;
  courseId: string;
  included: boolean | null;
}
export interface CanvasSelectionOptions {
  accountScope?: string;
  courseOverrides?: CanvasCourseOverride[];
  selectedTerm?: string | null;
  currentTime?: Date;
  /**
   * fix/current-courses-only. The student's own UW current enrollment (Course Search & Enroll,
   * normalizeUwCurrentEnrollment): true when this Canvas course's subject and catalog number
   * (and section, when both name one) match an enrolled class. Code only; this data never goes
   * to AI, Jev or MCP. Without planning data Canvas's own signals decide alone.
   */
  enrolledThisTerm?: (course: SelectableCanvasCourse) => boolean;
}
/**
 * The reasons that place a course; the course chooser groups by them (stable strings).
 * "This term" is pre-checked, "Other Canvas sites" unchecked, past and nameless courses hidden.
 */
export const COURSE_REASONS = {
  thisTerm: "This term",
  enrolled: "Matches your UW enrollment this term",
  past: "Past course: its term ended",
  future: "Its term hasn't started",
  termless: "No academic term: an organization or community site",
  stillOpen: "Its term ended, but Canvas keeps the course open until its own end date",
} as const;
const DAY = 86400_000;
/** How long after its term ends a course still counts as this term (final exams, late grades). */
export const TERM_GRACE_DAYS = 14;
/**
 * Approximate term dates for a term Canvas names but gives no dates for (UW's calendar shape).
 * Only a fallback: Canvas's own term or course dates win whenever it sends them.
 */
function approximateTerm(term: NonNullable<ReturnType<typeof parseAcademicTerm>>): { start: number; end: number } {
  const at = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);
  switch (term.season) {
    case "fall":
      return { start: at(term.year, 9, 1), end: at(term.year, 12, 23) };
    case "winter":
      return { start: at(term.year, 12, 24), end: at(term.year + 1, 1, 20) };
    case "spring":
      return { start: at(term.endYear, 1, 15), end: at(term.endYear, 5, 20) };
    default:
      return { start: at(term.endYear, 5, 25), end: at(term.endYear, 8, 20) };
  }
}
/**
 * Where a course sits in time, from Canvas's own dates (Courses API with include[]=term):
 * the term's start_at/end_at, or the course's own when Canvas restricts enrollments to course
 * dates (restrict_enrollments_to_course_dates); a named academic term without dates falls back
 * to its approximate dates. "past": ended more than TERM_GRACE_DAYS ago. "extended": the term is
 * past but the course's own end date is still ahead (Canvas lists it open).
 */
export function courseTiming(
  course: SelectableCanvasCourse,
  currentTime = new Date(),
): "current" | "past" | "future" | "extended" | "unknown" {
  const ms = (value: string | null | undefined) => {
    const n = Date.parse(value ?? "");
    return Number.isFinite(n) ? n : undefined;
  };
  const courseStart = ms(course.start_at),
    courseEnd = ms(course.end_at),
    termStart = ms(course.term?.start_at),
    termEnd = ms(course.term?.end_at);
  const parsed = parseAcademicTerm(course.term?.name);
  let window: { start?: number; end?: number };
  if (course.restrict_enrollments_to_course_dates && (courseStart !== undefined || courseEnd !== undefined))
    window = { start: courseStart ?? termStart, end: courseEnd ?? termEnd };
  else if (termStart !== undefined || termEnd !== undefined) window = { start: termStart, end: termEnd };
  // Canvas's own dates always beat a date guessed from the term's name.
  else if (courseStart !== undefined || courseEnd !== undefined) window = { start: courseStart, end: courseEnd };
  else if (parsed) window = approximateTerm(parsed);
  else window = {};
  const now = currentTime.getTime();
  if (window.start !== undefined && window.start > now) return "future";
  if (window.end !== undefined && window.end < now - TERM_GRACE_DAYS * DAY)
    return courseEnd !== undefined && courseEnd > now ? "extended" : "past";
  return window.start === undefined && window.end === undefined ? "unknown" : "current";
}
/** Canvas gives the term start and end, and they span no more than 400 days (not a catch-all term). */
export function academicTermDates(course: SelectableCanvasCourse): boolean {
  const start = Date.parse(course.term?.start_at ?? ""),
    end = Date.parse(course.term?.end_at ?? "");
  return Number.isFinite(start) && Number.isFinite(end) && end > start && end - start <= 400 * DAY;
}
/**
 * A UW Canvas course code's parts: "FA26 COMP SCI 400 001" → subject "COMP SCI", catalog "400",
 * sections ["001"]. Undefined when the code has no catalog number.
 */
export function canvasCourseCode(
  code: string | null | undefined,
): { subject: string; catalog: string; sections: string[] } | undefined {
  const text = (code ?? "")
    .toUpperCase()
    .replace(/^(?:FA|SP|SU)(?:20)?\d{2}[\s:_-]+/, "")
    .trim();
  const match = text.match(/^([A-Z][A-Z &/]*?)\s*(\d{3,4}[A-Z]?)\b((?:\s+\d{3})*)/);
  if (!match) return undefined;
  return {
    subject: match[1]!.trim().replace(/\s+/g, " "),
    catalog: match[2]!,
    sections: match[3]!.trim() ? match[3]!.trim().split(/\s+/) : [],
  };
}
export function parseAcademicTerm(
  input: string | null | undefined,
): { season: string; year: number; endYear: number; key: string } | null {
  const match = input?.match(
    /\b(fall|autumn|spring|summer|winter)\b[^\d]*(20\d{2}|19\d{2})(?:\s*(?:to|[-–/])\s*(20\d{2}|19\d{2}))?/i,
  );
  if (!match) return null;
  const season = match[1]!.toLowerCase().replace("autumn", "fall"),
    year = Number(match[2]),
    endYear = Number(match[3] ?? match[2]);
  if (endYear < year || endYear > year + 1) return null;
  return { season, year, endYear, key: `${season}:${year}` };
}
export function courseAccessState(
  course: SelectableCanvasCourse,
  currentTime = new Date(),
): "open" | "not_open" | "concluded" | "date_restricted" {
  if (
    course.concluded ||
    course.workflow_state === "completed" ||
    course.workflow_state === "deleted"
  )
    return "concluded";
  if (!course.access_restricted_by_date)
    return course.workflow_state === "unpublished" ? "not_open" : "open";
  const start = Date.parse(course.start_at ?? course.term?.start_at ?? ""),
    end = Date.parse(course.end_at ?? course.term?.end_at ?? "");
  if (Number.isFinite(start) && start > currentTime.getTime())
    return "not_open";
  if (Number.isFinite(end) && end < currentTime.getTime()) return "concluded";
  return course.workflow_state === "unpublished"
    ? "not_open"
    : "date_restricted";
}
export function courseSelection(
  course: SelectableCanvasCourse,
  options: CanvasSelectionOptions = {},
): { score: number; included: boolean; reasons: string[]; override?: boolean } {
  const reasons: string[] = [];
  let score = 0;
  const add = (points: number, reason: string) => {
    score += points;
    reasons.push(reason);
  };
  const student = course.enrollments?.some(
    (e) =>
      /^(?:student|StudentEnrollment)$/i.test(e.type ?? "") &&
      (!e.enrollment_state || e.enrollment_state === "active"),
  );
  if (student) add(1, "Active student enrollment");
  if (course.workflow_state === "available") add(0.5, "Published course");
  const term = parseAcademicTerm(course.term?.name);
  if (term) add(2, "Academic term with year");
  // A term whose name doesn't parse ("2026 Fall", "Academic Year 2026-2027", "Wintersession")
  // is still an academic term when Canvas dates it like one: at most 400 days long.
  else if (academicTermDates(course)) add(2, "Academic term dates");
  if (
    /\b[A-Z][A-Z &/]{1,30}[ -]?\d{3,4}[A-Z]?\b/.test(
      `${course.course_code ?? ""} ${course.name ?? ""}`,
    )
  )
    add(2, "Catalog course code");
  if (/\b(?:ongoing|default\s+term)\b/i.test(course.term?.name ?? ""))
    add(-1, "Nonacademic term");
  if (
    /\b(?:sandbox|training|orientation|template|demo|advising|career\s+fair|sorority|fraternity|society|certificate)\b/i.test(
      `${course.name ?? ""} ${course.course_code ?? ""}`,
    )
  )
    add(-3, "Site name suggests a noncourse space");
  if (!course.name?.trim()) add(-1, "Course name unavailable");
  let included = score >= 3;
  if (score < 3) reasons.push("Below academic course threshold (3)");
  if (course.enrollments?.length && !student) {
    included = false;
    reasons.push("No active student enrollment");
  }
  if (course.workflow_state === "unpublished") {
    included = false;
    reasons.push("Course has not been published");
  }
  if (course.access_restricted_by_date) {
    included = false;
    const access = courseAccessState(course, options.currentTime);
    reasons.push(
      access === "not_open"
        ? "Course has not opened yet"
        : access === "concluded"
          ? "Course concluded"
          : "Course access restricted by date; opening or conclusion date unavailable",
    );
  }
  if (
    course.concluded ||
    course.workflow_state === "completed" ||
    course.workflow_state === "deleted"
  ) {
    included = false;
    reasons.push("Course concluded");
  }
  if (course.historicalOnly) {
    included = false;
    reasons.push("Completed enrollment catalog; course metadata only");
  }
  // fix/current-courses-only. "This term" is Canvas's own term, by its dates: a published course
  // with the student's active enrollment whose term contains today (or ended within
  // TERM_GRACE_DAYS). A term-less site counts only when the student's UW enrollment names it.
  const timing = courseTiming(course, options.currentTime);
  const listedOpen =
    !!student &&
    course.workflow_state === "available" &&
    !course.access_restricted_by_date &&
    !course.historicalOnly &&
    !course.concluded;
  const enrolled = listedOpen && options.enrolledThisTerm?.(course) === true;
  const past = timing === "past" || !!course.historicalOnly || !!course.concluded ||
    course.workflow_state === "completed" || course.workflow_state === "deleted";
  if (timing === "past") {
    included = false;
    reasons.push(COURSE_REASONS.past);
  } else if (timing === "future") {
    included = false;
    reasons.push(COURSE_REASONS.future);
  } else if (timing === "extended") {
    included = false;
    reasons.push(COURSE_REASONS.stillOpen);
  } else if (!term && !academicTermDates(course)) {
    if (enrolled) {
      included = true;
      reasons.push(COURSE_REASONS.enrolled);
    } else {
      included = false;
      reasons.push(COURSE_REASONS.termless);
    }
  } else if (listedOpen && (included || enrolled)) {
    included = true;
    reasons.push(COURSE_REASONS.thisTerm);
    if (enrolled) reasons.push(COURSE_REASONS.enrolled);
  }
  const selected = parseAcademicTerm(options.selectedTerm);
  if (
    options.selectedTerm &&
    (selected
      ? selected.key !== term?.key
      : options.selectedTerm !== String(course.term?.id))
  ) {
    included = false;
    reasons.push("Outside selected term");
  }
  const override = options.courseOverrides?.find(
    (o) =>
      o.accountScope === options.accountScope &&
      o.courseId === String(course.id),
  );
  if (override && override.included !== null) {
    included = override.included;
    reasons.push(
      override.included ? "Included by student" : "Excluded by student",
    );
    // An include choice persists, but cannot turn inaccessible course evidence into an open course,
    // and old courses are never fetched (fix/current-courses-only).
    if (
      course.access_restricted_by_date ||
      course.workflow_state === "unpublished" ||
      course.historicalOnly ||
      (override.included && past)
    ) {
      included = false;
      reasons.push(course.historicalOnly || past
        ? "Saved include choice retained; historical content is not collected in this refresh"
        : "Saved include choice waits for course access");
    }
    return { score, included, reasons, override: override.included };
  }
  return { score, included, reasons };
}
// owner: T33 (this lane). Per-course freshness (plan D37, spec A4; architecture review F1, F7).
// Canvas has no per-course `updated_at`, so change is read from documented signals:
// - the hot tick (≤2 requests, every 5 min while present): `todo` and `upcoming_events`, whose
//   items carry their course, for dated work
// - the content probe (every 15 min and on app focus): per course, a hash of its module items and
//   its newest file and page (`sort=updated_at&order=desc&per_page=1`), plus one account-wide
//   activity stream whose items carry `course_id` (announcements and discussions)
// Only courses whose signature moved are warm-read.

/** courseId → signature; `account` holds items with no course. */
export type CourseSignatures = Record<string, string>;
export interface CourseProbeResult {
  /** Successfully observed signals; absent components remain unknown. */
  components?: Record<string, Record<string, string>>;
  status: "ok" | "partial" | "needs_sign_in";
  courses: CourseSignatures;
  requests: number;
}
const looseItem = z.record(z.string(), z.unknown());
async function listAll(
  http: CanvasHttp,
  url: string,
  signal: AbortSignal | undefined,
  count: { requests: number },
): Promise<unknown[]> {
  const items: unknown[] = [];
  const initial = url,
    seen = new Set<string>();
  let next: string | null = url;
  for (let page = 0; next && page < 20; page++) {
    if (seen.has(next)) throw new CanvasFailure("partial", "pagination_cycle");
    seen.add(next);
    count.requests++;
    const response = await http.request(next, signal);
    if (!Array.isArray(response.data))
      throw new CanvasFailure("partial", "expected_array");
    items.push(...response.data);
    next = canvasNextPage(response.link, next, initial, http.origin);
  }
  if (next) throw new CanvasFailure("partial", "page_limit");
  return items;
}
function courseOf(item: Record<string, unknown>): string {
  const assignment = item.assignment as Record<string, unknown> | undefined;
  const raw =
    item.course_id ??
    assignment?.course_id ??
    String(item.context_code ?? "").match(/^course_(\d+)$/)?.[1];
  return raw === undefined || raw === null || raw === ""
    ? "account"
    : String(raw);
}
/** Stable JSON: keys sorted, so a reordered response is not read as a change. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as object)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function group(rows: Array<{ course: string; key: string }>): CourseSignatures {
  const byCourse = new Map<string, string[]>();
  for (const row of rows) {
    const list = byCourse.get(row.course) ?? [];
    list.push(row.key);
    byCourse.set(row.course, list);
  }
  return Object.fromEntries(
    [...byCourse.entries()].map(([course, keys]) => [
      course,
      hashCanvas(keys.sort().join("\n")),
    ]),
  );
}
function failedStatus(http: CanvasHttp): "partial" | "needs_sign_in" {
  return http.needsSignIn ? "needs_sign_in" : "partial";
}
/** The hot tick: 2 requests (more only if a list pages), dated items grouped by course. */
export async function fetchCanvasHotProbe(
  http: CanvasHttp,
  signal?: AbortSignal,
): Promise<CourseProbeResult> {
  const count = { requests: 0 };
  try {
    const [todo, upcoming] = await Promise.all([
      listAll(http, `${http.origin}/api/v1/users/self/todo?per_page=100`, signal, count),
      listAll(
        http,
        `${http.origin}/api/v1/users/self/upcoming_events?per_page=100`,
        signal,
        count,
      ),
    ]);
    const rows = [
      ...todo.map((raw) => ["todo", raw] as const),
      ...upcoming.map((raw) => ["event", raw] as const),
    ].flatMap(([list, raw]) => {
      const item = looseItem.safeParse(raw);
      return item.success
        ? [{ course: courseOf(item.data), key: `${list}:${stable(item.data)}` }]
        : [];
    });
    return { status: "ok", courses: group(rows), requests: count.requests };
  } catch {
    signal?.throwIfAborted();
    return { status: failedStatus(http), courses: {}, requests: count.requests };
  }
}
/**
 * The content probe for the given courses: 1 account-wide activity-stream request, then per
 * course its module items (1 request, include[]=items) and its newest file and page (1 each).
 * A list the student cannot read (for example a hidden Pages tab) contributes a stable marker.
 */
export async function fetchCanvasContentProbe(
  http: CanvasHttp,
  courseIds: string[],
  signal?: AbortSignal,
  concurrency = 4,
  moduleRun?: CanvasModuleRun,
): Promise<CourseProbeResult> {
  const count = { requests: 0 };
  let partial = false;
  /** A list the student can't see is a stable marker; any other failure leaves the course out. */
  const TRANSIENT = "\u0000transient";
  const marker = (error: unknown) => {
    signal?.throwIfAborted();
    if (http.needsSignIn) throw new CanvasFailure("needs_sign_in");
    if (error instanceof CanvasFailure && error.status === "inaccessible")
      return `inaccessible:${error.code}`;
    partial = true;
    return TRANSIENT;
  };
  try {
    let stream: CourseSignatures = {};
    let streamKnown = true;
    try {
      const items = await listAll(
        http,
        `${http.origin}/api/v1/users/self/activity_stream?per_page=100&only_active_courses=true`,
        signal,
        count,
      );
      stream = group(
        items.flatMap((raw) => {
          const item = looseItem.safeParse(raw);
          if (!item.success) return [];
          // Read state is excluded: the student reading an announcement is not a course change.
          const { id, type, updated_at, created_at, title } = item.data;
          return [
            {
              course: courseOf(item.data),
              key: stable({ id, type, updated_at, created_at, title }),
            },
          ];
        }),
      );
    } catch (error) {
      streamKnown = marker(error) !== TRANSIENT;
    }
    const courses: CourseSignatures = {};
    const components: Record<string, Record<string, string>> = {};
    let next = 0;
    const one = async (courseId: string) => {
      const prefix = `${http.origin}/api/v1/courses/${courseId}`;
      const part = async (read: () => Promise<string>) => {
        try {
          return await read();
        } catch (error) {
          return marker(error);
        }
      };
      const newest = (kind: "files" | "pages") =>
        part(async () => {
          count.requests++;
          const response = await http.request(
            `${prefix}/${kind}?sort=updated_at&order=desc&per_page=1`,
            signal,
          );
          if (!Array.isArray(response.data)) throw new CanvasFailure("partial", "expected_array");
          if (!response.data.length) return "empty";
          const first = looseItem.safeParse(response.data[0]);
          if (!first.success) throw new CanvasFailure("partial", "invalid_newest_row");
          const id = first.data.id ?? first.data.page_id ?? first.data.url;
          if ((typeof id !== "string" && typeof id !== "number") ||
              typeof first.data.updated_at !== "string" || !Number.isFinite(Date.parse(first.data.updated_at)))
            throw new CanvasFailure("partial", "invalid_newest_row");
          return stable({ id, updated_at: first.data.updated_at });
        });
      const [modules, file, page] = await Promise.all([
        part(async () => {
          const reused = moduleRun?.results.has(`${http.origin}\n${courseId}`) ?? false;
          const acquisition = await readCanvasModules(http, courseId, signal, moduleRun);
          if (!reused) count.requests += acquisition.requests;
          if (!acquisition.complete) throw new CanvasFailure(
            acquisition.status === "inaccessible" ? "inaccessible" : "partial",
            acquisition.diagnostics[0] ?? "incomplete_modules",
          );
          return moduleItemsHash(acquisition.modules.map(entry => ({ ...entry.module, items: entry.items })));
        }),
        newest("files"),
        newest("pages"),
      ]);
      components[courseId] = Object.fromEntries(Object.entries({modules, file, page,
        stream: streamKnown ? stream[courseId] ?? "none" : TRANSIENT}).filter(([,value]) => value !== TRANSIENT));
      if (!streamKnown || [modules, file, page].includes(TRANSIENT)) return;
      courses[courseId] = hashCanvas(
        [modules, file, page, stream[courseId] ?? "none"].join("\n"),
      );
    };
    await Promise.all(
      Array.from(
        { length: Math.max(1, Math.min(concurrency, courseIds.length)) },
        async () => {
          for (;;) {
            const courseId = courseIds[next++];
            if (courseId === undefined) return;
            await one(courseId);
          }
        },
      ),
    );
    return {
      status: partial ? "partial" : "ok",
      courses,
      components,
      requests: count.requests,
    };
  } catch {
    signal?.throwIfAborted();
    return { status: failedStatus(http), courses: {}, requests: count.requests };
  }
}
// The comparison lives with the scheduler: movedCourses in packages/core/src/refresh.ts.
// end owner: T33
