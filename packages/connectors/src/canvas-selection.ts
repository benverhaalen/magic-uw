// owner: T33 (this lane): the freshness probes at the end of this file.
import { z } from "zod";
import { CanvasFailure, canvasNextPage, type CanvasHttp } from "./canvas-http";
import { hashCanvas } from "./canvas-models";
import { moduleItemsHash, moduleWithItemsSchema } from "./canvas-inventory";
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
    // An include choice persists, but cannot turn inaccessible course evidence into an open course.
    if (
      course.access_restricted_by_date ||
      course.workflow_state === "unpublished" ||
      course.historicalOnly
    ) {
      included = false;
      reasons.push(course.historicalOnly
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
      // Without the stream no course can be compared this time.
      if (marker(error) === TRANSIENT)
        return { status: "partial", courses: {}, requests: count.requests };
    }
    const courses: CourseSignatures = {};
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
          const first = Array.isArray(response.data)
            ? looseItem.safeParse(response.data[0])
            : undefined;
          return first?.success
            ? stable({
                id: first.data.id ?? first.data.page_id ?? first.data.url,
                updated_at: first.data.updated_at,
              })
            : "empty";
        });
      const [modules, file, page] = await Promise.all([
        part(async () => {
          const rows = await listAll(
            http,
            `${prefix}/modules?per_page=100&include[]=items&include[]=content_details`,
            signal,
            count,
          );
          return moduleItemsHash(
            rows.flatMap((raw) => {
              const parsed = moduleWithItemsSchema.safeParse(raw);
              return parsed.success ? [parsed.data] : [];
            }),
          );
        }),
        newest("files"),
        newest("pages"),
      ]);
      if ([modules, file, page].includes(TRANSIENT)) return;
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
      requests: count.requests,
    };
  } catch {
    signal?.throwIfAborted();
    return { status: failedStatus(http), courses: {}, requests: count.requests };
  }
}
// The comparison lives with the scheduler: movedCourses in packages/core/src/refresh.ts.
// end owner: T33
