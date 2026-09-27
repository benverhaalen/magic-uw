import {
  planningCourseHistorySchema,
  type PlanningCourseHistory,
  type UwGpaGrade,
} from "../../contracts/src/planning";
import { UW_GRADE_POINTS, calculateAttemptGpa, decodeUwTerm } from "./planning";

/** UW reports GPA to three decimal places; round only at the point of display/comparison. */
export function round3(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

const validAttempts = (history: PlanningCourseHistory[]): PlanningCourseHistory[] =>
  history.flatMap((row) => {
    const parsed = planningCourseHistorySchema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });

export type SemesterGpa = {
  termCode: string;
  label: string;
  termGpa: number | null;
  termCredits: number;
  termIncludedAttempts: number;
  termUnknownAttempts: number;
  cumulativeGpa: number | null;
  cumulativeCredits: number;
  /** True whenever this term or an earlier one has an attempt whose grade or eligibility isn't established. */
  cumulativeHasUnknowns: boolean;
};

/**
 * Term-by-term and running-cumulative GPA from source history. Attempts with no term code, or
 * that fail validation, are excluded from every term and noted only in the caller's own diagnostics
 * (this function reports on recognized terms only). Every attempt is counted once, in whatever term
 * the source recorded it in; repeats are not deduplicated because the history schema carries no
 * per-attempt "counts toward GPA under the repeat rule" flag, so this assumes UW policy exclusions
 * were already applied upstream in `gpaEligible`, not inferred here.
 */
export function gpaBySemester(history: PlanningCourseHistory[]): SemesterGpa[] {
  const attempts = validAttempts(history).filter((row) => row.termCode !== null);
  const byTerm = new Map<string, PlanningCourseHistory[]>();
  for (const attempt of attempts) {
    const list = byTerm.get(attempt.termCode as string) ?? [];
    list.push(attempt);
    byTerm.set(attempt.termCode as string, list);
  }
  // Term codes are fixed-width and chronological when sorted lexically (see encodeUwTerm/decodeUwTerm).
  const terms = [...byTerm.keys()].sort();
  let cumulativeQualityPoints = 0, cumulativeCredits = 0, cumulativeHasUnknowns = false;
  const result: SemesterGpa[] = [];
  for (const termCode of terms) {
    const termAttempts = byTerm.get(termCode)!;
    const termStats = calculateAttemptGpa(termAttempts);
    cumulativeQualityPoints += termStats.qualityPoints;
    cumulativeCredits += termStats.gpaCredits;
    if (termStats.status !== "known") cumulativeHasUnknowns = true;
    let label = termCode;
    try { label = decodeUwTerm(termCode).label; } catch { /* Keep the raw code if it fails to decode. */ }
    result.push({
      termCode, label,
      termGpa: termStats.gpa !== null ? round3(termStats.gpa) : null,
      termCredits: termStats.gpaCredits,
      termIncludedAttempts: termStats.includedAttempts,
      termUnknownAttempts: termStats.unknownAttempts,
      cumulativeGpa: cumulativeCredits > 0 ? round3(cumulativeQualityPoints / cumulativeCredits) : null,
      cumulativeCredits,
      cumulativeHasUnknowns,
    });
  }
  return result;
}

export type GpaHypothetical = { courseKey: string; credits: number; grade: UwGpaGrade };
export type WhatIfGpaResult = {
  term: { gpa: number | null; credits: number; qualityPoints: number; includedCount: number; unknownCount: number };
  cumulative: { gpa: number | null; credits: number; qualityPoints: number };
};

/**
 * Projects a hypothetical term (one grade per enrolled class) on top of completed history.
 * Hypotheticals with unusable credits or an unrecognized grade are excluded and counted as unknown;
 * they never silently default to a grade or to zero credits.
 */
export function whatIfGpa(history: PlanningCourseHistory[], hypotheticals: GpaHypothetical[]): WhatIfGpaResult {
  const prior = calculateAttemptGpa(validAttempts(history));
  let termQualityPoints = 0, termCredits = 0, includedCount = 0, unknownCount = 0;
  for (const hypothetical of hypotheticals) {
    const points = Object.hasOwn(UW_GRADE_POINTS, hypothetical.grade) ? UW_GRADE_POINTS[hypothetical.grade] : null;
    if (points === null || !Number.isFinite(hypothetical.credits) || hypothetical.credits <= 0) { unknownCount++; continue; }
    termQualityPoints += points * hypothetical.credits;
    termCredits += hypothetical.credits;
    includedCount++;
  }
  const cumulativeQualityPoints = prior.qualityPoints + termQualityPoints;
  const cumulativeCredits = prior.gpaCredits + termCredits;
  return {
    term: {
      gpa: termCredits > 0 ? round3(termQualityPoints / termCredits) : null,
      credits: termCredits, qualityPoints: termQualityPoints, includedCount, unknownCount,
    },
    cumulative: {
      gpa: cumulativeCredits > 0 ? round3(cumulativeQualityPoints / cumulativeCredits) : null,
      credits: cumulativeCredits, qualityPoints: cumulativeQualityPoints,
    },
  };
}

export type GradesNeededCourse = { courseKey: string; credits: number };
export type GradesNeededResult =
  | { status: "unknown"; reason: string }
  | { status: "already_met"; achievableCumulative: number }
  | { status: "reachable"; neededGrade: UwGpaGrade; requiredPoints: number; achievableCumulative: number }
  | { status: "unreachable"; bestGrade: UwGpaGrade; bestAchievableCumulative: number };

const gradesByPoints = (Object.entries(UW_GRADE_POINTS) as [UwGpaGrade, number][]).sort((a, b) => a[1] - b[1]);

/**
 * The minimum uniform grade needed across this term's current classes to reach a target cumulative
 * GPA, computed from exact quality-point algebra (never estimated). When the target can't be reached
 * this term even with straight A's, returns the best achievable cumulative instead of a grade.
 */
export function gradesNeeded(history: PlanningCourseHistory[], current: GradesNeededCourse[], targetCumulative: number): GradesNeededResult {
  if (!Number.isFinite(targetCumulative) || targetCumulative < 0 || targetCumulative > 4) {
    return { status: "unknown", reason: "Target cumulative GPA must be between 0 and 4." };
  }
  if (!current.length) return { status: "unknown", reason: "No current classes were given to project a grade onto." };
  if (current.some((course) => !Number.isFinite(course.credits) || course.credits <= 0)) {
    return { status: "unknown", reason: "One or more current classes is missing its credit count." };
  }
  const prior = calculateAttemptGpa(validAttempts(history));
  const termCredits = current.reduce((sum, course) => sum + course.credits, 0);
  const totalCredits = prior.gpaCredits + termCredits;
  if (totalCredits <= 0) return { status: "unknown", reason: "No GPA-eligible credits exist to compute a projection." };
  const requiredPoints = (targetCumulative * totalCredits - prior.qualityPoints) / termCredits;
  if (requiredPoints <= 0) {
    return { status: "already_met", achievableCumulative: round3(prior.qualityPoints / totalCredits) };
  }
  const bestPossible = gradesByPoints[gradesByPoints.length - 1];
  if (requiredPoints > bestPossible[1]) {
    return {
      status: "unreachable", bestGrade: bestPossible[0],
      bestAchievableCumulative: round3((prior.qualityPoints + bestPossible[1] * termCredits) / totalCredits),
    };
  }
  const needed = gradesByPoints.find(([, points]) => points >= requiredPoints)!;
  return {
    status: "reachable", neededGrade: needed[0], requiredPoints: round3(requiredPoints),
    achievableCumulative: round3((prior.qualityPoints + needed[1] * termCredits) / totalCredits),
  };
}
