import { OUTLOOK_CALENDAR_COURSE_ID, type McpCategory, type Resource, type Store } from "@magic/contracts";

/** Inclusion is checked at use time, not only when the connector first sees a course. */
export function courseIncluded(store: Store, resource: Resource): boolean {
  return courseInclusion(store)(resource);
}
/**
 * A course resource's inclusion now, reading only that course's row instead of the workspace:
 * the same answer as `courseInclusion(store)(course)` for a per-item recheck in a long run.
 */
export function courseRowIncluded(store: Store, course: Resource): boolean {
  const current = store.resource(course.id);
  return courseInclusion(store, current ? [current] : [])(course);
}
/** `resources` lets a caller that already loaded the workspace skip a second full read. */
export function courseInclusion(
  store: Store,
  resources: Resource[] = store.resources(),
): (resource: Resource) => boolean {
  const sources = new Map(store.sources().map((s) => [s.id, s]));
  const overrides = new Map(
    store
      .courseOverrides()
      .map((o) => [`${o.accountScope}:${o.courseId}`, o.included]),
  );
  const courses = new Map(
    resources
      .filter(
        (r) =>
          r.kind === "course" &&
          !r.deleted &&
          sources.get(r.sourceId)?.scope === "course",
      )
      .map((r) => [
        `${sources.get(r.sourceId)?.accountScope}:${r.courseId}`,
        r.course,
      ]),
  );
  // One read per inclusion map: the settings cannot change while one call uses it.
  const selectedTerm = store.ingestionSettings().selectedTerm;
  return (resource) => {
    const source = sources.get(resource.sourceId);
    if (!source) return false;
    const key = `${source.accountScope}:${resource.courseId}`;
    const course = courses.get(key);
    if (
      course?.accessRestricted ||
      (course?.accessState && course.accessState !== "open")
    )
      return false;
    if (
      selectedTerm &&
      course &&
      selectedTerm !== course.termName &&
      selectedTerm !== course.termId
    )
      return false;
    if (
      course?.selection?.reasons.some((reason) =>
        /absent|no longer|not returned/i.test(reason),
      )
    )
      return false;
    const override = overrides.get(key);
    if (override !== undefined && override !== null) return override;
    return course?.selection?.included ?? true;
  };
}
export function contentCategories(resource: Resource): McpCategory[] {
  // Messages and GitLab student-authored work cannot inherit the less restrictive course-text gate.
  if (resource.kind === "message") return ["communications"];
  // A personal calendar is the student's own schedule, not course text.
  if (resource.courseId === OUTLOOK_CALENDAR_COURSE_ID) return ["communications"];
  if (resource.gitlab) return ["student_work"];
  return ["course_text"];
}
