/**
 * Result shapes of the course practice ops (owner: study-backend). The renderer casts
 * `LearningResult.data` here, in one place. None of these carries an ability value, a
 * probability or a percentage (KM-6, spec H4/H8): a topic's level is its evidence-defined state.
 */
import type { StudyCitation, StudySessionView } from "@magic/contracts";
import type { ConceptStateName } from "./types";

export type PracticeAvailability = "current" | "stale" | "blocked";

/** A topic as shown on a question, a card or a picker chip. */
export interface TopicChip {
  conceptId: string;
  label: string;
  primary: boolean;
}

/** One topic's state: the four H4 states under their student-facing labels, with the reasons. */
export interface TopicStateView {
  conceptId: string;
  label: string;
  moduleId: string | null;
  moduleLabel: string | null;
  state: ConceptStateName;
  /** STATE_LABEL: Mastered · Getting there · Iffy · Not seen yet. */
  stateLabel: string;
  reasons: { text: string; clearsWhen: string }[];
  counts: { answers: number; correct: number; cardReviews: number; selfRatings: number };
  /** Checked questions and cards on this topic that practice can use now. */
  practiceItems: number;
}

/** A module (a `unit` concept) with the topics under it: a quiz section. */
export interface ModuleView {
  moduleId: string;
  label: string;
  position: number;
  topicIds: string[];
  questions: number;
  cards: number;
}

export interface OpenPracticeSession {
  sessionId: string;
  mode: "flashcards" | "learn" | "test";
  goal: string;
  updatedAt: string;
}

/** `practice.path`: the course's practice home. `status: "unavailable"` with this data when nothing is prepared. */
export interface PracticePathData {
  courseId: string;
  availability: PracticeAvailability;
  reason: string;
  /** False when no checked question or card exists for the course's current sources. */
  ready: boolean;
  questions: number;
  cards: { total: number; dueToday: number };
  modules: ModuleView[];
  /** Topics not under any module; they still appear in `topics`. */
  unsectionedTopicIds: string[];
  topics: TopicStateView[];
  /** Spec H: "Mastered n of m topics". */
  mastered: { count: number; of: number };
  openSessions: OpenPracticeSession[];
}

/** `knowledge.state` with `anchorIds`: per-topic state for the course, or for chosen topics/modules. */
export interface KnowledgeStateData {
  courseId: string;
  topics: TopicStateView[];
  mastered: { count: number; of: number };
}

export interface FlashcardView {
  cardId: string;
  itemId: string;
  itemVersion: number;
  front: string;
  back: string;
  topics: TopicChip[];
  citations: StudyCitation[];
  /** Never reviewed before this session. */
  isNew: boolean;
}

export interface FlashcardReviewRow {
  cardId: string;
  reviewId: string;
  rating: 1 | 2 | 3 | 4;
  undone: boolean;
}

export interface FlashcardSessionView {
  id: string;
  courseId: string;
  revision: number;
  availability: PracticeAvailability;
  reason: string;
  status: "active" | "complete";
  current?: FlashcardView;
  /** Cards left in this session, the current one included. */
  remaining: number;
  /** Due today across the scope when the session was read ("12 due today"). */
  dueToday: number;
  reviewed: FlashcardReviewRow[];
  topicIds: string[];
}

/** `practice.target` (flashcards), `study.review`, `study.undoReview`, `study.session` on a card session. */
export interface FlashcardData {
  flashcards: FlashcardSessionView;
}

export interface PracticeSection {
  /** Null: the topics outside every module. */
  moduleId: string | null;
  label: string;
  itemIds: string[];
}

export interface PracticeSessionMeta {
  mode: "learn" | "test";
  topicIds: string[];
  sections: PracticeSection[];
  /** Keyed by `${itemId}@${version}`: the topic chips shown on every question. */
  topicsByItem: Record<string, TopicChip[]>;
}

/**
 * `practice.target` (learn, test), and every saved-session op (`study.session`, `study.resume`,
 * `study.answer`, `study.hint`, `study.advance`, `study.draft`) on a course practice session:
 * the canonical session view plus its practice meta.
 */
export interface PracticeRoundData {
  session: StudySessionView;
  practice: PracticeSessionMeta;
}

export interface TopicResult {
  conceptId: string;
  label: string;
  moduleLabel: string | null;
  before: ConceptStateName | null;
  after: ConceptStateName;
  afterLabel: string;
  /** Direction only (H4/H8): no number. `new`: the topic had no evidence before. */
  direction: "up" | "down" | "same" | "new";
  answered: number;
  correct: number;
}

export interface PracticeResults {
  sessionId: string;
  mode: "learn" | "test";
  complete: boolean;
  answered: number;
  correct: number;
  /** Answers code could not settle: kept, never scored. */
  unscored: number;
  skipped: number;
  topics: TopicResult[];
  /** At most three (Study & Learn ≤3). */
  studyNext: { conceptId: string; label: string; state: ConceptStateName; reason: string }[];
}

/** `study.submit` on a course practice session: per-topic states and "study this next". Read-only. */
export interface PracticeResultsData {
  results: PracticeResults;
}

/** The ops the course practice surface calls, with the `data` each returns. */
export interface PracticeOpData {
  "practice.path": PracticePathData;
  "knowledge.state": KnowledgeStateData;
  "practice.target": FlashcardData | PracticeRoundData;
  "study.review": FlashcardData;
  "study.undoReview": FlashcardData;
  "study.submit": PracticeResultsData;
}

/** Message of the honest empty-pool answer; the renderer offers the `pack` command beside it. */
export const EMPTY_POOL_MESSAGE = "No practice items yet. Generate them from this course's materials.";

// owner: analytics. Practice analytics (additive). Code-only rollups of the stored evidence along
// item → topics → source materials → the assignments and exams those materials serve (0 tokens).
// Direction and state only: no score, probability, percentage or grade prediction (spec H4/H8).

/** Topics per state: counts of the four H4 states. */
export interface StateDistribution {
  solid: number;
  getting_there: number;
  iffy: number;
  not_seen: number;
}

/** An upcoming exam or quiz, dated by code. */
export interface ExamRef {
  assessmentId: string;
  title: string;
  kind: "exam" | "midterm" | "final" | "quiz";
  /** ISO date or instant. */
  at: string;
  daysAway: number;
  /** Where the date came from: the course map's assessments, a Canvas assignment or quiz, or the calendar. */
  dateSource: "assessment" | "assignment" | "calendar";
}

/** A topic in an analytics view: its state, reasons and evidence counts, plus the exam that makes it urgent. */
export interface AnalyticsTopic {
  conceptId: string;
  label: string;
  moduleId: string | null;
  moduleLabel: string | null;
  state: ConceptStateName;
  stateLabel: string;
  reasons: { text: string; clearsWhen: string }[];
  counts: { answers: number; correct: number; cardReviews: number; selfRatings: number };
  /** Checked practice items whose primary topic this is. */
  practiceItems: number;
  /** The course materials that tie this topic to the view (resource IDs). */
  materialIds: string[];
  nextExam: Omit<ExamRef, "dateSource"> | null;
}

/** "Study this next": ordered by weakness × exam proximity × scope share (the number stays internal). */
export interface StudyNextRow {
  conceptId: string;
  label: string;
  state: ConceptStateName;
  stateLabel: string;
  reason: string;
  exam: Omit<ExamRef, "dateSource"> | null;
  practiceItems: number;
}

/** Topics with any evidence out of the topics linked to the view. */
export interface TopicCoverage {
  withEvidence: number;
  of: number;
  text: string;
}

export type AnalyticsCalibration =
  | { status: "not_enough"; rated: number; needed: number; text: string }
  | { status: "ready"; rated: number; flags: { conceptId: string; label: string; wrong: number; total: number; text: string }[] };

export interface EvidenceCounts {
  answers: number;
  correct: number;
  cardReviews: number;
  selfRatings: number;
  sessions: number;
}

/** A material the view links to, with the reason code found the link. */
export interface LinkedMaterial {
  resourceId: string;
  title: string;
  reason: string;
}

/** `analytics.assignment`: readiness on the topics behind one assignment's references. */
export interface AssignmentAnalyticsData {
  courseId: string;
  assignmentId: string;
  title: string;
  /** `linked`: materials and topics found. Otherwise `reason` says which link of the chain is missing. */
  linkage: "linked" | "no_materials" | "no_topics";
  reason: string;
  materials: LinkedMaterial[];
  topics: AnalyticsTopic[];
  distribution: StateDistribution;
  coverage: TopicCoverage;
  calibration: AnalyticsCalibration;
  /** At most three (Study & Learn ≤3). */
  studyNext: StudyNextRow[];
  evidence: EvidenceCounts;
  note: string;
}

/** A module (a `unit` concept) rolled up. `moduleId: null`: the topics outside every module. */
export interface ModuleRollup {
  moduleId: string | null;
  label: string;
  topicIds: string[];
  distribution: StateDistribution;
  coverage: TopicCoverage;
}

/** An upcoming exam rolled up over its scope. `scope: "not_linked"` when no topic reaches it yet. */
export interface ExamRollup extends ExamRef {
  scope: "linked" | "not_linked";
  topicIds: string[];
  distribution: StateDistribution;
  coverage: TopicCoverage;
  studyNext: StudyNextRow[];
}

export interface TrendRow {
  conceptId: string;
  label: string;
  day: string;
  from: ConceptStateName;
  to: ConceptStateName;
  /** `new`: the topic's first evidence. */
  direction: "up" | "down" | "new";
  text: string;
}

/** `analytics.course`: per-module and per-upcoming-exam rollups, trend and the top priorities. */
export interface CourseAnalyticsData {
  courseId: string;
  modules: ModuleRollup[];
  exams: ExamRollup[];
  /** Exams with no date are listed apart; they never get an invented one. */
  undatedExams: { assessmentId: string; title: string }[];
  distribution: StateDistribution;
  coverage: TopicCoverage;
  /** State transitions over the last `sessions` practice sessions. */
  trend: { sessions: number; since: string | null; transitions: TrendRow[] };
  studyNext: StudyNextRow[];
  evidence: EvidenceCounts;
  note: string;
}

/** One agenda hint: "Study X before <exam>", sized from the topic's practice items. */
export interface AgendaHint {
  conceptId: string;
  label: string;
  state: ConceptStateName;
  exam: Omit<ExamRef, "dateSource">;
  /** Practice items the hint's minutes are counted from (capped). */
  items: number;
  /** Null when the topic has no practice items yet: the hint says to generate them. */
  minutes: number | null;
  text: string;
}

/** `analytics.agendaHints`: at most three hints for the agenda. */
export interface AgendaHintsData {
  courseId: string;
  hints: AgendaHint[];
}

/**
 * The assignment → references graph behind practice analytics: the port the material pipeline's
 * adapter implements (`feat/material-pipeline`: `references(assignmentId)` and `material_facts`).
 * Today's adapter is `createCurrentReferences` in `analytics/references.ts`. The router takes a
 * factory (`LearningRouterDependencies.analyticsReferences`) and builds one port per request, so an
 * adapter may index eagerly and cache freely within that request. Every method is synchronous,
 * code-only and reads only the student's own coursework store.
 */
export interface ReferencesPort {
  /**
   * The assignment or exam as captured: its resource ID, title and Canvas course ID. Null when the
   * ID is unknown. The router answers `unavailable` when this is null or its `courseId` isn't
   * the request's course, so the port must never resolve an ID into another course.
   */
  assignment(assignmentId: string): { id: string; title: string; courseId: string } | null;
  /**
   * The materials an assignment or exam references, each with the reason it was linked (shown
   * to the student). IDs are resource IDs in the same course. An assignment's own resource may be
   * included when its text can source topics. Unknown ID or no links: an empty list, never a guess.
   * Exams are passed by their `ExamDate.resourceId` when they have one, else by `assessmentId`.
   */
  references(assignmentId: string): MaterialLink[];
  /**
   * The inverse: the assignments and exams that reference a material (`kind: "assignment"` for
   * graded work that isn't an exam or quiz). It must agree with `references`: a material is
   * listed under a subject iff `references(subject)` lists that material. Exam proximity and
   * scope share in the priority come from this.
   */
  assessmentsFor(materialId: string): AssessmentLink[];
  /**
   * The course's exams and quizzes, dated where code can date them, with where the date came
   * from. `at: null` when no date is known: never invented; such exams are listed apart as
   * undated. Duplicates across sources (the same title and day) appear once. Sorted: dated first,
   * by date. `courseId` is the Canvas course ID.
   */
  examDates(courseId: string): ExamDate[];
}

/** A material an assignment or exam references. */
export interface MaterialLink {
  resourceId: string;
  title: string;
  /** Why it is linked, shown to the student ("Linked in the description.", "In the same module: …"). */
  reason: string;
}

/** An assignment or exam a material serves. */
export interface AssessmentLink {
  assessmentId: string;
  title: string;
  /** `assignment`: graded work that is not an exam or quiz. */
  kind: ExamRef["kind"] | "assignment";
}

/** An exam or quiz with its date, when code can date it. */
export interface ExamDate {
  assessmentId: string;
  title: string;
  kind: ExamRef["kind"];
  /** ISO date or instant. Null: no date is known; never invented. */
  at: string | null;
  dateSource: ExamRef["dateSource"];
  /** The captured resource the exam is, when there is one. */
  resourceId: string | null;
}

export type AnalyticsOp = "analytics.assignment" | "analytics.course" | "analytics.agendaHints";

export interface AnalyticsOpData {
  "analytics.assignment": AssignmentAnalyticsData;
  "analytics.course": CourseAnalyticsData;
  "analytics.agendaHints": AgendaHintsData;
}

/** The analytics answer, shaped like `LearningResult`. */
export interface AnalyticsResult {
  op: AnalyticsOp;
  status: "ok" | "not_built" | "unavailable" | "failed";
  message?: string;
  data?: AnalyticsOpData[AnalyticsOp];
}
// end owner: analytics
