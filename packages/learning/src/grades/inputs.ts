// Grade inputs from captured Canvas records for ONE account's course (FDB-001: the account boundary).
// The same Canvas assignment can be captured by several scopes (assignments, to-do, submissions);
// it is merged into one item, with the most recent captured submission that carries a score.
import type { Resource, SourceHealth } from "@magic/contracts";
import { examKind } from "../analytics/references";
import { syllabusWeights } from "./math";
import type { CourseGradeInput, GradeGroup, GradeItem } from "./types";

export interface GradeSources {
  resources(): Resource[];
  sources(): SourceHealth[];
  /** Course-scoped read, when the store has it (faster than every resource). */
  courseResources?(course: { accountScope: string; courseId: string }): Resource[];
}

/** Scope preference for the assignment record itself (points, group); the submission is merged separately. */
const SCOPE_RANK = ["assignments", "quizzes", "account-todo", "account-upcoming-events", "account-activity", "submissions"];
const scopeRank = (scope: string) => {
  const i = SCOPE_RANK.indexOf(scope.split(":")[0]!);
  return i < 0 ? SCOPE_RANK.length : i;
};

export function gradeInputs(src: GradeSources, course: { accountScope: string; courseId: string }): CourseGradeInput {
  const mine = src.sources().filter((s) => s.accountScope === course.accountScope && s.courseId === course.courseId);
  const scopeOf = new Map(mine.map((s) => [s.id, s.scope]));
  const all = (src.courseResources ? src.courseResources(course) : src.resources()).filter(
    (r) => !r.deleted && r.courseId === course.courseId && scopeOf.has(r.sourceId),
  );
  const groups = new Map<string, GradeGroup>();
  for (const r of all) {
    if (!r.assignmentGroup) continue;
    const id = r.externalId;
    if (groups.has(id)) continue;
    const rules = r.assignmentGroup.rules;
    groups.set(id, {
      id,
      title: r.title,
      weight: typeof r.assignmentGroup.weight === "number" ? r.assignmentGroup.weight : null,
      position: r.assignmentGroup.position ?? 0,
      dropLowest: rules?.dropLowest ?? 0,
      dropHighest: rules?.dropHighest ?? 0,
      neverDrop: rules?.neverDrop ?? [],
    });
  }
  const byExternal = new Map<string, Resource[]>();
  for (const r of all) if (r.kind === "assignment") byExternal.set(r.externalId, [...(byExternal.get(r.externalId) ?? []), r]);
  const items: GradeItem[] = [];
  for (const copies of byExternal.values()) {
    const base = [...copies].sort((a, b) => scopeRank(scopeOf.get(a.sourceId)!) - scopeRank(scopeOf.get(b.sourceId)!) || b.observedAt.localeCompare(a.observedAt))[0]!;
    const withScore = copies
      .filter((r) => r.submission && typeof r.submission.score === "number")
      .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
    const sub = withScore?.submission ?? base.submission ?? null;
    const groupId = base.assignmentGroupId ?? copies.find((r) => r.assignmentGroupId)?.assignmentGroupId ?? null;
    const points = base.points ?? copies.find((r) => r.points !== null)?.points ?? null;
    const submittedAt = sub?.submittedAt ?? null;
    items.push({
      id: base.id,
      externalId: base.externalId,
      title: base.title,
      groupId,
      points,
      score: typeof sub?.score === "number" ? sub.score : null,
      excused: sub?.excused === true,
      missing: sub?.missing === true,
      late: sub?.late === true,
      submitted: base.submitted,
      dueAt: base.dueAt ?? null,
      submittedAt,
      at: submittedAt ?? base.dueAt ?? null,
      examKind: examKind(base.title, base.submissionTypes ?? []),
    });
  }
  items.sort((a, b) => (a.at ?? "~").localeCompare(b.at ?? "~") || a.id.localeCompare(b.id));
  const syllabus = all.find((r) => r.externalId === "syllabus" && scopeOf.get(r.sourceId) === "syllabus");
  const partial = mine.filter((s) => s.status !== "ok" || !s.complete);
  return {
    accountScope: course.accountScope,
    courseId: course.courseId,
    courseName: all.find((r) => r.courseName)?.courseName ?? course.courseId,
    groups: [...groups.values()],
    items,
    syllabusWeights: syllabus ? syllabusWeights(syllabus.text, syllabus.id) : [],
    coverage: !mine.length || !items.length
      ? { status: "none", reasons: ["No graded Canvas work was captured for this course."] }
      : partial.length
        ? { status: "partial", reasons: partial.map((s) => `${s.label}: ${s.status === "ok" ? "incomplete" : s.status.replace(/_/g, " ")}`) }
        : { status: "complete", reasons: [] },
  };
}
