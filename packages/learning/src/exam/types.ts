/**
 * Exam prep contract types (owner: exam-prep). The blueprint, the practice exam, interactive
 * solving and their router views. Every value here is decided by code over stored course
 * evidence; a model only authors problems and hints through the pack path, and code checks
 * them before they are stored. None of these carries an ability value, a probability, a
 * percentage of mastery or a predicted score (KM-6, spec H4/H8). Answer keys never appear in a
 * view before the step is settled (answered in practice, or the exam submitted).
 */
import type { StudyCitation } from "@magic/contracts";
import type { Bloom } from "../config";
import type { Tier } from "../store";
import type { ConceptStateName } from "../types";

// ---------- Blueprint ----------

/** Item formats as a real exam uses them; read from the course's own documents, never assumed. */
export type ExamFormat =
  | "multiple_choice"
  | "true_false"
  | "numeric"
  | "symbolic"
  | "short_answer"
  | "essay"
  | "proof"
  | "code_writing"
  | "code_tracing"
  | "diagram";

/** Bloom's levels; `create` is kept apart from the item model's five-level `Bloom`. */
export type CognitiveLevel = Bloom | "create";

/** What a piece of blueprint evidence is. */
export type EvidenceKind =
  | "practice_exam"
  | "review_sheet"
  | "past_exam"
  | "solutions"
  | "scope_statement"
  | "syllabus"
  | "assessment_record"
  | "course_structure";

/** One piece of evidence behind a blueprint value: the exact span of a stored resource version, or a structural record. */
export interface BlueprintEvidence {
  kind: EvidenceKind;
  resourceId: string | null;
  title: string;
  /** The exact text code read; null for structural records (an assessment row, a module). */
  quote: string | null;
  start: number | null;
  end: number | null;
  /** `text`: offsets into the resource text. `title`: into its title. `structure`: a stored record. */
  basis: "text" | "title" | "structure";
  contentHash: string | null;
}

export interface FormatShare {
  format: ExamFormat;
  /** Questions of this format the evidence shows (null when the evidence names the format without a count). */
  items: number | null;
  /** Points the evidence gives these questions, when it states them. */
  points: number | null;
  evidence: BlueprintEvidence[];
}

export interface LevelShare {
  level: CognitiveLevel;
  items: number;
  /** The verb that set the level, quoted. */
  evidence: BlueprintEvidence[];
}

export interface BlueprintSection {
  id: string;
  label: string;
  formats: FormatShare[];
  levels: LevelShare[];
  items: number | null;
  points: number | null;
  /** The heading or statement the section came from. */
  evidence: BlueprintEvidence[];
  /** True when code grouped unlabelled questions into this section (the course named no sections). */
  grouped: boolean;
  /** The section's questions in order, as (format, level) pairs; a stated format without questions appears once. */
  profile: { format: ExamFormat; level: CognitiveLevel | null }[];
}

export interface BlueprintConcept {
  conceptId: string;
  label: string;
  moduleLabel: string | null;
  /** κ_c: the concept's coverage weight (the weights sum to 1). A course fact, not a student value. */
  weight: number;
  basis: "stated" | "schedule_window" | "mapped" | "module" | "course";
}

export interface ExamBlueprint {
  assessmentId: string;
  title: string;
  kind: string;
  date: string | null;
  /** Percent of the course grade, when the course states it. */
  weight: { percent: number; evidence: BlueprintEvidence[] } | null;
  tier: Tier;
  tierLabel: string;
  /** Where the format came from, in words the student sees. */
  basis: string;
  scope: {
    statements: BlueprintEvidence[];
    window: { start: string | null; end: string | null; basis: "stated" | "previous_assessment" | "none" };
    modules: { label: string; evidence: BlueprintEvidence[] }[];
    concepts: BlueprintConcept[];
    /** `none`: no scope was found; the whole course is used and the warning says so. */
    basis: "stated" | "schedule_window" | "mapped" | "none";
  };
  length: { minutes: number; evidence: BlueprintEvidence[] } | null;
  totalPoints: { value: number; evidence: BlueprintEvidence[] } | null;
  sections: BlueprintSection[];
  formatMix: FormatShare[];
  levelMix: LevelShare[];
  /** The course documents the format was read from (practice exams, review sheets, past exams). */
  formatSources: BlueprintEvidence[];
  /** True when the course shows no exam format: sections are empty and nothing is imitated. */
  thin: boolean;
  warnings: string[];
  /** Resources that are graded work (real quizzes, exams, assignments): never a source of practice. */
  excludedResourceIds: string[];
}

// ---------- Interactive solving ----------

export type StepAnswer =
  | { kind: "numeric"; value: number; unit: string | null; relTol: number; absTol: number }
  | { kind: "symbolic"; expr: string; variables: string[]; form: "any" | "expanded" | "factored" }
  | { kind: "choice"; options: { id: string; text: string }[]; key: string }
  | { kind: "text"; key: string; keyIdeas: { idea: string; synonyms: string[]; required: boolean }[] }
  | { kind: "parsons"; blocks: { id: string; text: string; indent: number }[]; solution: string[]; alternatives: string[][]; distractors: string[]; indented: boolean }
  /** The instructor's problem: the student writes their work, sees the instructor's solution, then marks it. */
  | { kind: "self"; solution: StudyCitation | null };

export interface SolveStep {
  id: string;
  prompt: string;
  answer: StepAnswer;
  /** Hint ladder rung 1: a nudge that never states the answer (code checks that). */
  nudge: string | null;
  /** Rung 2: this step worked, with its answer. */
  worked: string | null;
  /** Optional self-explanation prompt after the step (graded by key ideas, never required). */
  explain: { prompt: string; keyIdeas: { idea: string; synonyms: string[]; required: boolean }[] } | null;
}

export interface SolveProblem {
  /** `item`: a checked practice item (one step); `problem`: an instructor, code-made or authored problem. */
  kind: "item" | "problem";
  id: string;
  version: number;
  courseRef: string;
  stem: string;
  format: ExamFormat;
  level: CognitiveLevel | null;
  conceptIds: string[];
  steps: SolveStep[];
  /** Rung 3: the full worked example, one line per step. */
  workedExample: string[];
  source: StudyCitation;
  origin: "instructor" | "generated" | "code";
  tier: Tier;
  points: number | null;
  /** The checks that ran and passed, by name (quote, policy, open_graded, recompute, parse, restraint, verbatim). */
  checks: string[];
  generator: { client: string; model: string; promptVersion: string } | null;
}

export type HintRung = "nudge" | "step" | "worked";

/** One checked step answer, as the student sees it after the check. */
export interface StepFeedback {
  outcome: "correct" | "incorrect" | "partial" | "undecided";
  /** A specific reason code found ("Equivalent, but not factored yet.", "Wrong unit: expected a speed."). */
  message: string;
  /** Parsons: the blocks out of place (by block ID). */
  misplaced?: string[];
  checks: string[];
}

// ---------- Practice exam ----------

export type QuestionSource =
  | { kind: "item"; itemId: string; itemVersion: number }
  | { kind: "problem"; problemId: string; problemVersion: number };

export interface ExamQuestionPlan {
  id: string;
  source: QuestionSource;
  sectionId: string;
  format: ExamFormat;
  level: CognitiveLevel | null;
  points: number | null;
  conceptIds: string[];
  tier: Tier;
  provenance: string;
  /** Set when the question's format differs from its section's (the pool had nothing closer). */
  substitute: string | null;
  /** T3 outside this term's coverage: labelled, never silently kept. */
  mayNotApply: boolean;
}

export interface PracticeExamPlan {
  assessmentId: string;
  title: string;
  tier: Tier;
  tierLabel: string;
  provenance: string;
  sections: { id: string; label: string; questionIds: string[]; evidence: BlueprintEvidence[] }[];
  questions: ExamQuestionPlan[];
  /** Per concept: κ, κ' (after lean) and the questions allocated. */
  allocation: { conceptId: string; label: string; weight: number; leaned: number; questions: number }[];
  lean: boolean;
  minutes: number | null;
  warnings: string[];
  dropped: { reason: string; count: number }[];
}

// ---------- Sessions and views ----------

export type ExamMode = "exam" | "practice";

export interface StepView {
  id: string;
  prompt: string;
  kind: StepAnswer["kind"];
  /** Choice options, or Parsons blocks shuffled by code (IDs only map to text). */
  options?: { id: string; text: string }[];
  blocks?: { id: string; text: string }[];
  indented?: boolean;
  unit?: string | null;
  variables?: string[];
  /** Worked by the fading schedule: shown with its answer, not asked. */
  shownWorked: string | null;
  status: "open" | "answered" | "correct" | "incorrect" | "partial" | "revealed" | "needs_mark";
  feedback: StepFeedback | null;
  hints: { rung: HintRung; text: string }[];
  /** The next rung available, or null (none left, or exam conditions hide hints). */
  nextHint: HintRung | null;
  /** Revealed once the step is settled: the key in display form. */
  answer: string | null;
  solution: StudyCitation | null;
  explain: string | null;
}

export interface QuestionView {
  id: string;
  sectionId: string;
  number: number;
  stem: string;
  format: ExamFormat;
  level: CognitiveLevel | null;
  points: number | null;
  topics: { conceptId: string; label: string; primary: boolean }[];
  tier: Tier;
  provenance: string;
  substitute: string | null;
  mayNotApply: boolean;
  citations: StudyCitation[];
  steps: StepView[];
  fade: { level: number; of: number } | null;
  confidence: number | null;
  status: "open" | "in_progress" | "done";
  workedExample: string[] | null;
}

export interface ExamSessionView {
  id: string;
  courseId: string;
  assessmentId: string | null;
  title: string;
  mode: ExamMode;
  examConditions: boolean;
  revision: number;
  availability: "current" | "stale" | "blocked";
  reason: string;
  tier: Tier | null;
  tierLabel: string | null;
  provenance: string;
  timer: { minutes: number; startedAt: string; endsAt: string; remainingSeconds: number; expired: boolean } | null;
  status: "active" | "submitted";
  sections: { id: string; label: string; questionIds: string[] }[];
  questions: QuestionView[];
  warnings: string[];
}

export interface ExamReviewTopic {
  conceptId: string;
  label: string;
  answered: number;
  correct: number;
  before: ConceptStateName | null;
  after: ConceptStateName;
}

/** `exam.submit`: the code-graded review. Observed counts only; no predicted score. */
export interface ExamReview {
  sessionId: string;
  answered: number;
  correct: number;
  partial: number;
  /** Marked by the student against the instructor's solution. */
  selfMarked: number;
  /** Still waiting for the student's mark (instructor problems). */
  needsMark: number;
  unanswered: number;
  bySection: { sectionId: string; label: string; answered: number; correct: number }[];
  topics: ExamReviewTopic[];
  /** Confident and wrong: review these first (Koriat-style calibration flags, counts only). */
  confidentMisses: { questionId: string; conceptIds: string[]; confidence: number }[];
  attemptsRecorded: number;
  note: string;
}

export interface BlueprintData {
  blueprint: ExamBlueprint;
}
export interface ExamSessionData {
  exam: ExamSessionView;
}
export interface ExamReviewData {
  exam: ExamSessionView;
  review: ExamReview;
}

/** The exam ops and the `data` each returns. */
export interface ExamOpData {
  "exam.blueprint": BlueprintData;
  "exam.build": ExamSessionData;
  "exam.solve": ExamSessionData;
  "exam.session": ExamSessionData | ExamReviewData;
  "exam.answer": ExamSessionData;
  "exam.hint": ExamSessionData;
  "exam.submit": ExamReviewData;
}
