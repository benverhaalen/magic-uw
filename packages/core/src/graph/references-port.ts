/**
 * The pipeline's `ReferencesPort` for practice analytics (packages/learning/src/router-types.ts).
 * `references` is the graph's `references(assignmentId)`, limited to captured resources in the
 * same course (external-only links have no resource ID and are left out); covers facts come last,
 * quoted ones before structural ones. `assessmentsFor` is its exact inverse over the course's
 * subjects. Exam dates, and anything keyed by a course-map assessment row rather than a captured
 * resource, come from analytics' own adapter, so the two never disagree on what an exam is.
 * Build one per request (it caches per course).
 */
import type { Store } from "@magic/contracts";
import type { AssessmentLink, ExamDate, MaterialLink, ReferencesPort } from "../../../learning/src/router-types";
import { createCurrentReferences, examKind } from "../../../learning/src/analytics/references";
import { canonicalAssessment, references } from "./references";
import { courseIndex, courseOfSource, type PipelineStore } from "./course-index";

export function createPipelineReferences(store: PipelineStore): ReferencesPort {
  const fallback = createCurrentReferences(store as Store & PipelineStore);
  const refs = new Map<string, MaterialLink[]>();
  const served = new Map<string, Map<string, AssessmentLink[]>>();
  const examsByCourse = new Map<string, ExamDate[]>();
  const examDates = (courseId: string) => {
    let exams = examsByCourse.get(courseId);
    if (!exams) examsByCourse.set(courseId, (exams = fallback.examDates(courseId)));
    return exams;
  };

  function assignment(assignmentId: string) {
    const r = store.resource(assignmentId);
    if (r && !r.deleted) return { id: r.id, title: r.title, courseId: r.courseId };
    return fallback.assignment(assignmentId);
  }

  function materialLinks(assignmentId: string): MaterialLink[] {
    const cached = refs.get(assignmentId);
    if (cached) return cached;
    const self = store.resource(assignmentId);
    let list: MaterialLink[];
    if (!self || self.deleted) list = fallback.references(assignmentId);
    else {
      const out = new Map<string, MaterialLink>();
      const course = courseOfSource(store, self.sourceId);
      const index = course ? courseIndex(store, course) : undefined;
      const indexed = index?.resources.get(self.id);
      const canonical = index && indexed ? canonicalAssessment(index, indexed) : self;
      if (canonical.kind === "assignment" && canonical.text.trim())
        out.set(canonical.id, { resourceId: canonical.id, title: canonical.title, reason: "The assignment's own page." });
      for (const ref of references(store, assignmentId)) {
        if (!ref.resourceId || out.has(ref.resourceId)) continue;
        const target = store.resource(ref.resourceId);
        if (!target || target.deleted || target.courseId !== self.courseId) continue;
        out.set(ref.resourceId, { resourceId: ref.resourceId, title: ref.title, reason: sentence(ref.reason) });
      }
      list = [...out.values()];
    }
    refs.set(assignmentId, list);
    return list;
  }

  function assessmentsFor(materialId: string): AssessmentLink[] {
    const material = store.resource(materialId);
    if (!material || material.deleted) return [];
    const course = courseOfSource(store, material.sourceId);
    if (!course) return [];
    const key = `${course.accountScope}\u0000${course.courseId}`;
    let byMaterial = served.get(key);
    if (!byMaterial) {
      byMaterial = new Map();
      const index = courseIndex(store, course);
      const exams = examDates(material.courseId);
      const examByRef = new Map(exams.map((e) => [e.resourceId ?? e.assessmentId, e]));
      const subjects: { id: string; link: AssessmentLink }[] = [];
      for (const a of index.assignmentById.values()) {
        if (examByRef.has(a.id)) continue;
        const kind = examKind(a.title, a.submissionTypes ?? []);
        subjects.push({ id: a.id, link: { assessmentId: a.id, title: a.title, kind: kind ?? "assignment" } });
      }
      for (const e of exams) subjects.push({ id: e.resourceId ?? e.assessmentId, link: { assessmentId: e.assessmentId, title: e.title, kind: e.kind } });
      for (const s of subjects)
        for (const m of materialLinks(s.id)) byMaterial.set(m.resourceId, [...(byMaterial.get(m.resourceId) ?? []), s.link]);
      served.set(key, byMaterial);
    }
    return byMaterial.get(materialId) ?? [];
  }

  return { assignment, references: materialLinks, assessmentsFor, examDates };
}

/** The graph's reasons are lower-case clauses; the port shows a sentence. */
function sentence(reason: string): string {
  const text = reason.charAt(0).toUpperCase() + reason.slice(1);
  return /[.!?"]$/.test(text) ? text : `${text}.`;
}
