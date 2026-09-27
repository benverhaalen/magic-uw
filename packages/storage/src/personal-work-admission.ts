import type { CourseOverride, Resource, SourceHealth } from "@magic/contracts";
import type { PersonalWorkResource } from "./personal-work";

type WorkSource = Pick<SourceHealth, "id" | "accountScope" | "courseId" | "scope" | "status">;
const key = (account: string, course: string) => JSON.stringify([account, course]);
/** Module-only assessments are actual captured tasks; arbitrary library files are not. */
export function personalWorkCheckable(resource: Resource, directlyAssigned: boolean): boolean {
  const module = resource.moduleItem;
  return resource.kind === "assignment" || (resource.kind === "material" && (
    !!module?.completionRequirement || directlyAssigned ||
    (!!module?.contentId && (module.type === "Quiz" || module.type === "Assignment"))
  ));
}
/** One immutable index per synchronous snapshot. Never retained across a write, capture or access change. */
export function personalWorkAdmission(
  resources: readonly Resource[], sources: readonly WorkSource[], overrides: readonly CourseOverride[], selectedTerm: string | null,
): (id: string) => PersonalWorkResource | undefined {
  const sourceById = new Map(sources.map(source => [source.id, source]));
  const resourceById = new Map(resources.filter(resource => !resource.deleted).map(resource => [resource.id, resource]));
  const courseByScope = new Map<string, NonNullable<Resource["course"]>>();
  const overrideByScope = new Map(overrides.map(override => [key(override.accountScope, override.courseId), override.included]));
  for (const resource of resources) {
    const source = sourceById.get(resource.sourceId);
    if (resource.deleted || resource.kind !== "course" || !resource.course || !source || source.status === "inaccessible" || source.scope !== "course" || source.courseId !== resource.courseId) continue;
    const scope = key(source.accountScope, resource.courseId);
    if (!courseByScope.has(scope)) courseByScope.set(scope, resource.course);
  }
  const admitted = new Map<string, Omit<PersonalWorkResource, "checkable">>();
  const assignedUrls = new Map<string, Set<string>>();
  for (const resource of resources) {
    const source = sourceById.get(resource.sourceId);
    if (resource.deleted || !source || source.status === "inaccessible") continue;
    const scope = key(source.accountScope, resource.courseId), course = courseByScope.get(scope);
    if (!course || course.accessRestricted || (course.accessState && course.accessState !== "open") ||
        course.selection?.reasons.some(reason => /absent|no longer|not returned/i.test(reason)) ||
        (selectedTerm && selectedTerm !== course.termName && selectedTerm !== course.termId)) continue;
    const override = overrideByScope.get(scope);
    if (override !== undefined ? !override : course.selection?.included === false) continue;
    admitted.set(resource.id, {resource, accountScope: source.accountScope, termKey: course.termId ?? course.termName ?? "unknown-term"});
    if (resource.kind === "assignment") {
      const urls = assignedUrls.get(scope) ?? new Set<string>();
      for (const link of resource.links ?? []) urls.add(typeof link === "string" ? link : link.url);
      assignedUrls.set(scope, urls);
    }
  }
  return id => {
    // The lookup is bounded regardless of how many materials are projected.
    if (!resourceById.has(id)) return undefined;
    const current = admitted.get(id);
    return current && {...current, checkable: personalWorkCheckable(current.resource,
      assignedUrls.get(key(current.accountScope, current.resource.courseId))?.has(current.resource.url) ?? false)};
  };
}
