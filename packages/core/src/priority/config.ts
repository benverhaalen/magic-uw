/**
 * Every constant the critical-action agenda (D49) uses, in one place. None of them is measured:
 * they are starting values chosen by reasoning about typical coursework, to be replaced by the
 * student's own corrections (the per-course calibration) and, later, measured durations.
 */
export interface AgendaConfig {
  /** Nothing here has been validated against real completion times. */
  validated: false;
  /** Kept between the latest start and the deadline: latest start = due − estimate − buffer. */
  bufferMinutes: number;
  /** A tie group takes every item within this many minutes of its least-slack item. */
  tieWindowMinutes: number;
  /** Past-due items still accepted stay ranked this long; older ones move to the flagged list. */
  overdueWindowDays: number;
  /** Items in the launch view and the default page. */
  topN: number;
  /** Items the model writes a "why now" line for, in one call per agenda change. */
  narrationTopN: number;
  /** Class meetings shown (display only, never ranked). */
  classWindowDays: number;
  /** The in-process fact cache is rebuilt at least this often (it also rebuilds on any sync). */
  memoMaxAgeMs: number;
  estimate: {
    minMinutes: number;
    maxMinutes: number;
    /** Starting effort by kind; an exam's is study time. */
    baseMinutes: Record<"assignment" | "quiz" | "exam" | "discussion", number>;
    /** Points add effort, capped: a 100-point item isn't 10× a 10-point one. */
    minutesPerPoint: number;
    pointsCapMinutes: number;
    /** A quiz's stated question count replaces its base: this per question, plus setup. */
    minutesPerQuestion: number;
    quizSetupMinutes: number;
    /** Rubric criteria beyond the first few each add work. */
    minutesPerRubricCriterion: number;
    rubricFreeCriteria: number;
    /** Reading the linked materials (passage token estimates), capped. */
    readingTokensPerMinute: number;
    materialCapMinutes: number;
    /** Reading the item's own instructions, capped. */
    instructionCharsPerMinute: number;
    instructionCapMinutes: number;
    /** The calibration (median of corrected ÷ replaced) is clamped to this range. */
    calibrationMin: number;
    calibrationMax: number;
    /** Instructions sent to the student's AI per item, and items per call. */
    modelTextChars: number;
    modelBatchMax: number;
  };
  narration: {
    /** A "why now" line longer than this is dropped. */
    maxChars: number;
  };
}

export const AGENDA_CONFIG: AgendaConfig = {
  validated: false,
  bufferMinutes: 120,
  tieWindowMinutes: 60,
  overdueWindowDays: 14,
  topN: 10,
  narrationTopN: 5,
  classWindowDays: 2,
  memoMaxAgeMs: 60_000,
  estimate: {
    minMinutes: 5,
    maxMinutes: 40 * 60,
    baseMinutes: { assignment: 60, quiz: 20, exam: 240, discussion: 30 },
    minutesPerPoint: 1,
    pointsCapMinutes: 180,
    minutesPerQuestion: 2,
    quizSetupMinutes: 5,
    minutesPerRubricCriterion: 15,
    rubricFreeCriteria: 2,
    readingTokensPerMinute: 300,
    materialCapMinutes: 240,
    instructionCharsPerMinute: 1000,
    instructionCapMinutes: 30,
    calibrationMin: 0.25,
    calibrationMax: 4,
    modelTextChars: 1500,
    modelBatchMax: 12,
  },
  narration: { maxChars: 160 },
};
