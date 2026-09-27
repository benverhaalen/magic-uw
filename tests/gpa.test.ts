import test from "node:test";
import assert from "node:assert/strict";
import type { PlanningCourseHistory, PlanningProvenance } from "../packages/contracts/src/planning";
import { gpaBySemester, gradesNeeded, whatIfGpa } from "../packages/domain/src/gpa";

// Synthetic history only, per docs/data-and-fixtures rules.
const provenance: PlanningProvenance = {
  sourceUrl: "https://enroll.wisc.edu/", observedAt: "2026-09-26T12:00:00Z",
  scope: { kind: "degree_plan", key: "synthetic" },
};
let counter = 0;
const attempt = (overrides: Partial<PlanningCourseHistory> = {}): PlanningCourseHistory => ({
  id: `attempt-${++counter}`, kind: "course_history", provenance,
  courseKey: "uw:266:300", termCode: "1262", state: "completed", credits: 3, grade: "A", gpaEligible: true,
  ...overrides,
});

test("gpaBySemester: worked example across two terms", () => {
  // Fall 2025 (1262): A (4) x3cr, B (3) x3cr -> 21/6 = 3.500
  // Spring 2026 (1264): AB (3.5) x4cr -> cumulative (21+14)/(6+4) = 3.500
  const history = [
    attempt({ courseKey: "uw:266:300", termCode: "1262", grade: "A", credits: 3 }),
    attempt({ courseKey: "uw:600:222", termCode: "1262", grade: "B", credits: 3 }),
    attempt({ courseKey: "uw:266:400", termCode: "1264", grade: "AB", credits: 4 }),
  ];
  const result = gpaBySemester(history);
  assert.equal(result.length, 2);
  assert.equal(result[0].termCode, "1262");
  assert.equal(result[0].termGpa, 3.5);
  assert.equal(result[0].termCredits, 6);
  assert.equal(result[0].cumulativeGpa, 3.5);
  assert.equal(result[1].termCode, "1264");
  assert.equal(result[1].termGpa, 3.5);
  assert.equal(result[1].cumulativeCredits, 10);
  assert.equal(result[1].cumulativeGpa, 3.5);
});

test("gpaBySemester: excludes non-GPA grades (S/U, CR/N, P, I, NR) from the term average", () => {
  const history = [
    attempt({ termCode: "1262", grade: "A", credits: 3 }),
    attempt({ courseKey: "uw:600:100", termCode: "1262", grade: "S", credits: 1, gpaEligible: false }),
    attempt({ courseKey: "uw:600:101", termCode: "1262", grade: "CR", credits: 1, gpaEligible: false }),
    attempt({ courseKey: "uw:600:102", termCode: "1262", grade: "P", credits: 1, gpaEligible: false }),
    attempt({ courseKey: "uw:600:103", termCode: "1262", grade: "I", credits: 0, state: "in_progress", gpaEligible: null }),
    attempt({ courseKey: "uw:600:104", termCode: "1262", grade: "NR", credits: 3, gpaEligible: null }),
  ];
  const result = gpaBySemester(history);
  assert.equal(result.length, 1);
  // Only the single A-grade, 3-credit attempt counts toward the term GPA.
  assert.equal(result[0].termGpa, 4);
  assert.equal(result[0].termCredits, 3);
  assert.equal(result[0].termIncludedAttempts, 1);
});

test("gpaBySemester: unknown credits keep the attempt out of the GPA and mark the term partial", () => {
  const history = [
    attempt({ termCode: "1262", grade: "A", credits: 3 }),
    attempt({ courseKey: "uw:600:222", termCode: "1262", grade: "B", credits: null }),
  ];
  const result = gpaBySemester(history);
  assert.equal(result[0].termGpa, 4);
  assert.equal(result[0].termCredits, 3);
  assert.equal(result[0].termUnknownAttempts, 1);
  assert.equal(result[0].cumulativeHasUnknowns, true);
});

test("whatIfGpa: worked example projecting this term's grades onto prior history", () => {
  // Prior: A x3cr (12 quality points, 3 credits).
  // Hypothetical this term: B x3cr, BC x3cr -> 9+7.5=16.5 quality points / 6 credits = 2.750
  // Cumulative: (12+16.5)/(3+6) = 28.5/9 = 3.1666... -> 3.167
  const history = [attempt({ termCode: "1262", grade: "A", credits: 3 })];
  const result = whatIfGpa(history, [
    { courseKey: "uw:266:400", credits: 3, grade: "B" },
    { courseKey: "uw:600:300", credits: 3, grade: "BC" },
  ]);
  assert.equal(result.term.gpa, 2.75);
  assert.equal(result.term.credits, 6);
  assert.equal(result.cumulative.gpa, 3.167);
  assert.equal(result.cumulative.credits, 9);
});

test("whatIfGpa: a hypothetical with unusable credits is excluded and counted as unknown", () => {
  const history = [attempt({ termCode: "1262", grade: "A", credits: 3 })];
  const result = whatIfGpa(history, [
    { courseKey: "uw:266:400", credits: 3, grade: "A" },
    { courseKey: "uw:600:300", credits: 0, grade: "A" },
  ]);
  assert.equal(result.term.includedCount, 1);
  assert.equal(result.term.unknownCount, 1);
  assert.equal(result.term.credits, 3);
});

test("gradesNeeded: worked example, a reachable target", () => {
  // Prior: A x3cr, B x3cr -> 21 quality points / 6 credits.
  // Current term: two 3-credit classes (6 credits). Target cumulative 3.5.
  // Needed quality points this term = 3.5*(6+6) - 21 = 42 - 21 = 21 -> 21/6 = 3.5 points/credit -> needs AB (3.5).
  const history = [
    attempt({ termCode: "1262", grade: "A", credits: 3 }),
    attempt({ courseKey: "uw:600:222", termCode: "1262", grade: "B", credits: 3 }),
  ];
  const result = gradesNeeded(history, [
    { courseKey: "uw:266:400", credits: 3 },
    { courseKey: "uw:600:300", credits: 3 },
  ], 3.5);
  assert.equal(result.status, "reachable");
  if (result.status === "reachable") {
    assert.equal(result.neededGrade, "AB");
    assert.equal(result.requiredPoints, 3.5);
    assert.equal(result.achievableCumulative, 3.5);
  }
});

test("gradesNeeded: an unreachable target reports the best achievable grade instead", () => {
  // Prior: F x12cr -> 0 quality points / 12 credits. Current term: one 3-credit class. Target 3.9.
  // Even straight A's this term can't reach 3.9 cumulative.
  const history = [attempt({ termCode: "1262", grade: "F", credits: 12 })];
  const result = gradesNeeded(history, [{ courseKey: "uw:266:400", credits: 3 }], 3.9);
  assert.equal(result.status, "unreachable");
  if (result.status === "unreachable") {
    assert.equal(result.bestGrade, "A");
    // (0 + 4*3) / 15 = 0.8
    assert.equal(result.bestAchievableCumulative, 0.8);
  }
});

test("gradesNeeded: missing current-class credits is reported as unknown, not guessed", () => {
  const history = [attempt({ termCode: "1262", grade: "A", credits: 3 })];
  const result = gradesNeeded(history, [{ courseKey: "uw:266:400", credits: Number.NaN }], 3.5);
  assert.equal(result.status, "unknown");
});

test("gpaBySemester: our computed GPA can disagree with the student record's reported GPA", () => {
  // The reported GPA lives on a separate student_summary record entirely; this function never
  // reads or overrides it. A caller who has both must show them side by side, not merge them.
  const history = [
    attempt({ termCode: "1262", grade: "A", credits: 3 }),
    attempt({ courseKey: "uw:600:222", termCode: "1262", grade: "F", credits: 3 }),
  ];
  const result = gpaBySemester(history);
  const reportedGpa = 3.8; // A stand-in for a student_summary.cumulativeGpa that omits a transfer exclusion.
  assert.notEqual(result[0].cumulativeGpa, reportedGpa);
  assert.equal(result[0].cumulativeGpa, 2);
});

test("round-trip float rounding matches UW's three-decimal reporting", () => {
  const history = [
    attempt({ termCode: "1262", grade: "A", credits: 3 }),
    attempt({ courseKey: "uw:600:222", termCode: "1262", grade: "AB", credits: 3 }),
    attempt({ courseKey: "uw:320:210", termCode: "1262", grade: "B", credits: 1 }),
  ];
  // (4*3 + 3.5*3 + 3*1) / 7 = (12+10.5+3)/7 = 25.5/7 = 3.642857...
  const result = gpaBySemester(history);
  assert.equal(result[0].termGpa, 3.643);
});
