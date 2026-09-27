/**
 * `selectSyllabus(courseId)`: the course's syllabus, found by code (D34). The tier rules live in the
 * domain compiler so the stored profile and this job pick the same sources; this adds the material
 * pipeline's `syllabus` role (material_facts) as one more tier-2 signal.
 */
import type { CourseCoreStore, Resource, SourceHealth, Store } from "@magic/contracts";
import {
  selectSyllabus as selectFrom,
  type SyllabusSelectionResult,
} from "../../../domain/src/course-intelligence";

export interface CourseKey {
  accountScope: string;
  courseId: string;
}

export function courseMaterial(store: Store, course: CourseKey): { sources: SourceHealth[]; resources: Resource[] } {
  const sources = store
    .sources()
    .filter((s) => s.accountScope === course.accountScope && s.courseId === course.courseId);
  const ids = new Set(sources.map((s) => s.id));
  const resources = store.resources().filter((r) => !r.deleted && ids.has(r.sourceId));
  return { sources, resources };
}

/** Resource ids the material pipeline classified with the role `syllabus`: one query where the store has it. */
export function syllabusRoles(store: Store, resources: Resource[], course?: CourseKey): Set<string> {
  const s = store as Partial<Pick<CourseCoreStore, "materialFacts" | "syllabusRoleIds">>;
  if (course && typeof s.syllabusRoleIds === "function") {
    const live = new Set(resources.map((r) => r.id));
    return new Set(s.syllabusRoleIds.call(store, course).filter((id) => live.has(id)));
  }
  const roles = new Set<string>();
  if (typeof s.materialFacts !== "function") return roles;
  for (const r of resources)
    if (s.materialFacts.call(store, r.id).some((f) => f.kind === "role" && f.value === "syllabus")) roles.add(r.id);
  return roles;
}

export function selectSyllabus(
  store: Store,
  course: CourseKey,
  at: string = new Date().toISOString(),
): SyllabusSelectionResult & { resources: Resource[] } {
  const { sources, resources } = courseMaterial(store, course);
  return { ...selectFrom(resources, sources, { at, roles: syllabusRoles(store, resources, course) }), resources };
}
