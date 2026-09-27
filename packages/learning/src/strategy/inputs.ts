// One builder for the grades placement and the strategy call, so the observations the student sees
// are exactly the ones a strategy is grounded in.
import { courseGrades, gradeInputs, type GradeSources } from "../grades";
import type { CourseGrades } from "../grades/types";
import { createMastery, createMasteryMemo, type MasteryInput, type MasteryMemo } from "../mastery";
import type { CourseMasteryData } from "../mastery/types";
import { observationHash, strategyObservations, type Observation, type Overlap } from "./index";

export interface CourseGradesData {
  courseId: string;
  grades: CourseGrades;
  overlaps: (Overlap & { topicIds: string[] })[];
  observations: Observation[];
  /** The hash a strategy is cached by. */
  observationHash: string;
  note: string;
}

export function courseGradesData(
  input: MasteryInput,
  coursework: GradeSources,
  accountScope: string,
  memo: MasteryMemo = createMasteryMemo(),
): { data: CourseGradesData; mastery: CourseMasteryData } {
  const grades = courseGrades(gradeInputs(coursework, { accountScope, courseId: input.courseId }), input.now);
  const m = createMastery(input, memo);
  const mastery = m.course();
  const overlaps = m.overlaps(grades.upcomingHighWeight);
  const observations = strategyObservations(grades, mastery, overlaps);
  return {
    data: { courseId: input.courseId, grades, overlaps, observations, observationHash: observationHash(observations), note: grades.note },
    mastery,
  };
}
