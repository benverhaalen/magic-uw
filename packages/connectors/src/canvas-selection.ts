export interface SelectableCanvasCourse {
  id: string | number;
  name?: string | null;
  course_code?: string | null;
  workflow_state?: string;
  access_restricted_by_date?: boolean;
  concluded?: boolean;
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
      course.workflow_state === "unpublished"
    ) {
      included = false;
      reasons.push("Saved include choice waits for course access");
    }
    return { score, included, reasons, override: override.included };
  }
  return { score, included, reasons };
}
