// Course mastery (D57): the payload shapes. Every field is computed by code from stored evidence
// (0 tokens). None carries an ability value, a probability or a percentage (spec H4/H8, KM-6).
import type { ConceptStateName } from "../types";

export type StateCounts = Record<ConceptStateName, number>;

/** The exact command a next step runs. The renderer adds the course anchors and an operation ID. */
export type NextStepCommand =
  | {
      type: "learning";
      request: { op: "practice.target"; courseId: string; topicIds: string[]; mode: "test" | "flashcards"; count: number };
    }
  | { type: "pack"; pack: "quiz"; scope: { courseId: string; topicIds?: string[] } };

export interface NextStep {
  kind: "quiz" | "review" | "recall_check" | "generate";
  /** The button text: what runs, with its exact size. */
  label: string;
  /** One line: why this is first, and what the command does. */
  detail: string;
  topicIds: string[];
  /** `generate` uses the student's AI (the pack's own consent and receipts); every other kind is 0 tokens. */
  usesAi: boolean;
  command: NextStepCommand;
}

export interface MasteryTopic {
  topicId: string;
  label: string;
  moduleId: string | null;
  moduleLabel: string | null;
  /** The shown state, after the delayed-recall rule. */
  state: ConceptStateName;
  stateLabel: string;
  /** Mastered, and confirmed by a correct recall answer on a later day. */
  confirmed: boolean;
  /** The evidence meets every Mastered rule except delayed recall, so it shows as Getting there. */
  awaitingLaterRecall: boolean;
  /** FSRS retrievability is below the review threshold: time decay shown as a flag, never a silent demotion. */
  dueForReview: boolean;
  /** The student's local day of the latest answer or card review on it. */
  lastEvidenceDay: string | null;
  /** Answers and card reviews that count as evidence. */
  evidenceCount: number;
  /** Checked questions and cards on it that practice can use now. */
  practiceItems: number;
  /** One line on why it has this state. */
  why: string;
  reasons: { text: string; clearsWhen: string }[];
  /** Upcoming exams whose scope holds it, soonest first. */
  assessments: { assessmentId: string; title: string; daysAway: number }[];
}

export interface MasteryModule {
  moduleId: string | null;
  label: string;
  topicIds: string[];
  counts: StateCounts;
  dueForReview: number;
}

export interface MasteryAssessment {
  assessmentId: string;
  title: string;
  kind: "exam" | "midterm" | "final" | "quiz";
  at: string;
  daysAway: number;
  dateSource: "assessment" | "assignment" | "calendar";
  /** `not_linked`: no captured material or stated coverage ties topics to it yet. */
  scope: "linked" | "not_linked";
  topicIds: string[];
  counts: StateCounts;
  dueForReview: number;
  /** "Mastered 3 of 7 topics for Midterm 2". */
  label: string;
  nextStep: NextStep | null;
}

export interface SinceLastWeek {
  since: string;
  movedUp: number;
  movedDown: number;
  dueForReview: number;
  text: string;
}

export interface CourseMasteryData {
  courseId: string;
  /** `no_topics`: the course has no topic map yet. */
  status: "ok" | "no_topics";
  message: string | null;
  counts: StateCounts;
  total: number;
  /** "Mastered 4 of 12 topics". */
  label: string;
  sinceLastWeek: SinceLastWeek;
  nextStep: NextStep | null;
  /** Why there is no next step, when there is none. */
  nextStepNote: string | null;
  modules: MasteryModule[];
  topics: MasteryTopic[];
  assessments: MasteryAssessment[];
  undatedAssessments: { assessmentId: string; title: string }[];
  hidden: { topicId: string; label: string }[];
  note: string;
}

/** `mastery.assessment`: one upcoming exam's slice, for the assessment page to embed. */
export interface AssessmentMasteryData {
  courseId: string;
  assessment: MasteryAssessment;
  topics: MasteryTopic[];
  note: string;
}

/** `mastery.forItems`: the topics behind a day's due items, rolled up. */
export interface ItemsMasteryData {
  courseId: string;
  items: { itemId: string; title: string | null; topicIds: string[]; linkage: "linked" | "no_materials" | "no_topics" | "unknown_item" }[];
  topicIds: string[];
  counts: StateCounts;
  dueForReview: number;
  label: string;
  nextStep: NextStep | null;
  note: string;
}

/** One past exam: the topic states as of its date, its captured score, and what moved since. */
export interface PastExam {
  assessmentId: string;
  title: string;
  kind: "exam" | "midterm" | "final" | "quiz";
  at: string;
  topicIds: string[];
  /** States as of the exam date, recomputed from the evidence stored up to then. */
  asOf: { counts: StateCounts; topics: { topicId: string; label: string; state: ConceptStateName; stateLabel: string }[] };
  /** The score Canvas shows for it, when captured. */
  score: { earned: number; possible: number; text: string } | null;
  /** Topics whose state moved between the exam and now. */
  since: { up: { topicId: string; label: string; from: ConceptStateName; to: ConceptStateName }[]; down: { topicId: string; label: string; from: ConceptStateName; to: ConceptStateName }[] };
}

export interface ExamHistoryData {
  courseId: string;
  exams: PastExam[];
  note: string;
}

export interface ClaimData {
  topicId: string;
  /** What the student said, kept as a self-rating (it never changes the state by itself). */
  recorded: "know_it";
  /** The check: a practice session of up to 3 questions from the topic's pool, or null when it has none. */
  check: unknown | null;
  message: string;
  /** When the topic has no practice items: the command that generates them. */
  generate: NextStepCommand | null;
}

export interface HideData {
  topicId: string;
  hidden: boolean;
  message: string;
}
