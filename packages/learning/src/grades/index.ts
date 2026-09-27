// The grade bank (D57). One implementation of the grade math for every consumer: course mastery,
// the pages builder's study offers and the strategy observations. 0 tokens; facts only, no forecast.
import { assignmentShare, courseGrade, resolveWeights } from "./math";
import { gradeTrajectory, TREND } from "./trajectory";
import type { CourseGradeInput, CourseGrades, HighWeightItem } from "./types";

export { assignmentShare, courseGrade, groupResult, labelMatches, resolveWeights, syllabusWeights, weightedPercent } from "./math";
export { gradeTrajectory, trend, TREND } from "./trajectory";
export { gradeInputs, type GradeSources } from "./inputs";
export type * from "./types";

/** Starting values, not validated. */
export const GRADE_CONFIG = {
  /** An item's share of the grade (or, when its share isn't known, its exam's group weight) at or above this is "high weight". */
  highWeight: 20,
  /** Upcoming items listed, at most. */
  maxUpcoming: 3,
} as const;

const NOTE = "From your captured Canvas scores and the course's listed weights. Not a grade prediction.";

/** Every grade figure for one account's course, and the upcoming items that carry the most weight. */
export function courseGrades(input: CourseGradeInput, now: Date, t = TREND): CourseGrades {
  const weights = resolveWeights(input);
  const { grade, groups } = courseGrade(input, weights);
  const trajectory = gradeTrajectory(input, weights, t);
  const nowIso = now.toISOString();
  const groupById = new Map(input.groups.map((g) => [g.id, g]));
  const upcomingHighWeight: HighWeightItem[] = input.items
    .filter((x) => x.dueAt !== null && x.dueAt >= nowIso && x.score === null && x.submitted !== true && !x.excused)
    .map((x) => {
      const share = assignmentShare(input, x.id, weights);
      return {
        itemId: x.id,
        title: x.title,
        dueAt: x.dueAt,
        groupTitle: x.groupId ? (groupById.get(x.groupId)?.title ?? null) : null,
        weight: share.status === "unknown" ? null : { share: share.status === "known" ? share.share : null, group: share.groupWeight, source: share.source },
        examKind: x.examKind,
      };
    })
    // High weight: a known share at the line, or an exam whose share isn't known (its group's weight is stated instead).
    .filter((x) => (x.weight?.share ?? 0) >= GRADE_CONFIG.highWeight || (x.weight?.share == null && x.examKind !== null && x.examKind !== "quiz"))
    .sort((a, b) => (b.weight?.share ?? b.weight?.group ?? 0) - (a.weight?.share ?? a.weight?.group ?? 0) || (a.dueAt ?? "").localeCompare(b.dueAt ?? "") || a.itemId.localeCompare(b.itemId))
    .slice(0, GRADE_CONFIG.maxUpcoming);
  return {
    accountScope: input.accountScope,
    courseId: input.courseId,
    courseName: input.courseName,
    coverage: input.coverage,
    weights: weights.status === "known" ? { status: "known", source: weights.source, text: weights.text } : { status: "unknown", reason: weights.reason },
    grade,
    groups,
    trajectory,
    upcomingHighWeight,
    note: NOTE,
  };
}
