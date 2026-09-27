/**
 * `courseGraph(course)`: modules → items → resources → passage counts, the course's assessments,
 * the references between them, and a coverage report of what the pipeline could not connect.
 */
import type { CourseRef } from "../../../contracts/src/course-core";
import { courseIndex, type PipelineStore } from "./course-index";
import { references } from "./references";
import { hasLinks, isMaterial } from "./write";

export interface CourseGraph {
  course: CourseRef;
  modules: {
    id: string;
    title: string;
    position: number;
    items: { itemId: string; title: string; type: string; resourceId: string | null; externalUrl: string | null; passages: number; role: string | null }[];
  }[];
  resources: { total: number; materials: number; withText: number; passages: number; byType: Record<string, number> };
  assessments: { resourceId: string; title: string; type: string; dueAt: string | null; role: string | null }[];
  references: { direct: number; named: number; external: number; unresolved: number; externalRecords: number };
  coverage: {
    /** Materials with text but no passage of their current version. */
    withoutPassages: string[];
    /** Materials without a role fact (not yet analysed, or left for judgment). */
    withoutRole: string[];
    needsJudgment: string[];
    assignmentsWithoutReferences: string[];
    unresolvedLinks: { fromResourceId: string; target: string; kind: string }[];
  };
}

export function courseGraph(store: PipelineStore, course: CourseRef): CourseGraph {
  const index = courseIndex(store, course);
  const counts = new Map(store.graphCounts(course).map((c) => [c.resourceId, c]));
  const roleOf = new Map<string, string | null>();
  const needsJudgment: string[] = [];
  const withoutRole: string[] = [];
  const withoutPassages: string[] = [];
  const byType: Record<string, number> = {};
  let materials = 0,
    withText = 0,
    passages = 0;
  for (const r of index.resources.values()) {
    passages += counts.get(r.id)?.passages ?? 0;
    if (!isMaterial(index, r)) continue;
    materials++;
    const type = index.contentType(r)!;
    byType[type] = (byType[type] ?? 0) + 1;
    if (r.text) {
      withText++;
      if (!(counts.get(r.id)?.passages ?? 0)) withoutPassages.push(r.id);
    }
    const facts = store.materialFacts(r.id);
    const role = facts.find((f) => f.kind === "role")?.value ?? null;
    roleOf.set(r.id, role);
    if (facts.some((f) => f.kind === "needs_judgment" && f.value === "role")) needsJudgment.push(r.id);
    if (!role) withoutRole.push(r.id);
  }
  const refTotals = { direct: 0, named: 0, external: 0, unresolved: 0, externalRecords: store.externalRefs(course).length };
  const unresolvedLinks: CourseGraph["coverage"]["unresolvedLinks"] = [];
  for (const r of index.resources.values()) {
    if (!hasLinks(r)) continue;
    for (const ref of store.resourceRefs(r.id)) {
      if (ref.strength === "direct") refTotals.direct++;
      else refTotals.named++;
      if (ref.kind === "external") refTotals.external++;
      else if (!ref.toResourceId) {
        refTotals.unresolved++;
        unresolvedLinks.push({ fromResourceId: r.id, target: ref.target, kind: ref.kind });
      }
    }
  }
  const assessments: CourseGraph["assessments"] = [];
  const assignmentsWithoutReferences: string[] = [];
  for (const r of new Set([...index.assignmentById.values(), ...index.quizById.values()])) {
    const type = index.contentType(r) ?? (r.kind === "assignment" ? "assignment" : "quiz");
    assessments.push({ resourceId: r.id, title: r.title, type, dueAt: r.dueAt ?? r.moduleItem?.dueAt ?? null, role: roleOf.get(r.id) ?? null });
    if (r.kind === "assignment" && !references(store, r.id).length) assignmentsWithoutReferences.push(r.id);
  }
  const modules = [...index.modules.values()]
    .sort((a, b) => a.position - b.position)
    .map((m) => ({
      id: m.id,
      title: m.title,
      position: m.position,
      items: m.items.map((item) => {
        const target = index.itemTarget(item);
        return {
          itemId: item.id,
          title: item.moduleItem?.title ?? item.title,
          type: item.moduleItem?.type ?? "",
          resourceId: target?.id ?? null,
          externalUrl: item.moduleItem?.externalUrl ?? null,
          passages: target ? (counts.get(target.id)?.passages ?? 0) : 0,
          role: target ? (roleOf.get(target.id) ?? null) : (roleOf.get(item.id) ?? null),
        };
      }),
    }));
  return {
    course,
    modules,
    resources: { total: index.resources.size, materials, withText, passages, byType },
    assessments,
    references: refTotals,
    coverage: { withoutPassages, withoutRole, needsJudgment, assignmentsWithoutReferences, unresolvedLinks },
  };
}
