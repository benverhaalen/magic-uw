// owner: study frontend. Renderer-side shapes for the study panel.
// Practice shapes come from the study backend's router types. Analytics and guide shapes mirror
// origin/main c5f0231 (packages/learning/src/router-types.ts analytics section and
// packages/packs/guide/src/{personalize,review}.ts), because this integration base predates them.
// After the integrator merges main, these mirrors can be replaced by direct type imports.
export type {
  FlashcardData,
  FlashcardSessionView,
  FlashcardView,
  PracticePathData,
  PracticeResults,
  PracticeResultsData,
  PracticeRoundData,
  TopicStateView,
  OpenPracticeSession,
} from "../../../../../packages/learning/src/router-types";

export type ConceptStateName = "solid" | "getting_there" | "iffy" | "not_seen";

export interface ExamSummary {
  assessmentId: string;
  title: string;
  kind: "exam" | "midterm" | "final" | "quiz";
  at: string;
  daysAway: number;
}
export interface StudyNextRow {
  conceptId: string;
  label: string;
  state: ConceptStateName;
  stateLabel: string;
  reason: string;
  exam: ExamSummary | null;
  practiceItems: number;
}
export interface AnalyticsTopic {
  conceptId: string;
  label: string;
  moduleId: string | null;
  moduleLabel: string | null;
  state: ConceptStateName;
  stateLabel: string;
  reasons: { text: string; clearsWhen: string }[];
  counts: { answers: number; correct: number; cardReviews: number; selfRatings: number };
  practiceItems: number;
  materialIds: string[];
  nextExam: ExamSummary | null;
}
export interface LinkedMaterial {
  resourceId: string;
  title: string;
  reason: string;
}
/** `analytics.assignment` data (main only). */
export interface AssignmentAnalyticsData {
  courseId: string;
  assignmentId: string;
  title: string;
  linkage: "linked" | "no_materials" | "no_topics";
  reason: string;
  materials: LinkedMaterial[];
  topics: AnalyticsTopic[];
  coverage: { withEvidence: number; of: number; text: string };
  studyNext: StudyNextRow[];
  note: string;
}

export type TopicMark = "weak" | "developing" | "untested" | "solid";
export interface GroundedQuote {
  sourceId: string;
  quote: string;
  resourceId: string | null;
  start: number | null;
  end: number | null;
}
export interface GuideBlock {
  id: string;
  kind: "point" | "definition" | "example" | "question" | "event" | "row";
  topic: string;
  heading: string | null;
  text: string;
  expression: string | null;
  result: string | null;
  date: string | null;
  cells: string[] | null;
  source: GroundedQuote;
  computed: string | null;
}
export interface GuideSectionView {
  id: string;
  title: string;
  topics: string[];
  columns: string[] | null;
  blocks: GuideBlock[];
  mark: TopicMark;
  topicMarks: { topic: string; conceptId: string | null; mark: TopicMark }[];
}
export interface GuideStudyNext {
  conceptId: string;
  label: string;
  mark: TopicMark;
  anchor: { resourceId: string; version: number; start: number; end: number; label: string; valid: boolean };
  quote: string;
}
/** The personalised `guide` document view (kind "guide"). */
export interface GuideDocumentView {
  kind: "guide" | "briefing" | "faq" | "timeline" | "compare";
  title: string;
  sections: GuideSectionView[];
  confusions: { kind: string; text: string; count: number }[];
  studyNext: GuideStudyNext[];
  summary: { weak: number; developing: number; untested: number; solid: number };
}
/** The `guide` query result (main only). */
export interface GuideQueryResult {
  view: "guide";
  op: "guide.view";
  status: "ready" | "stale" | "missing" | "empty" | "blocked" | "unavailable";
  kind: string;
  courseRef: string | null;
  artifactId: string | null;
  stale: boolean;
  changedSources: { resourceId: string; title: string; change: "changed" | "removed" | "added" }[];
  message: string | null;
  modelCalls: 0;
  guide: { view: GuideDocumentView; drops: unknown[] } | null;
}

/** The `pack` command's result, for the fields the panel reads (quiz, cards and guide packs). */
export interface PackOutcome {
  status: "done" | "needs_student" | "blocked" | "paused" | "failed" | "no_client" | "empty" | "unknown_pack";
  message: string;
  pack: string;
  itemIds?: string[];
  cached: boolean;
  counts: { generated: number; accepted: number; dropped: number };
  receiptIds: string[];
}

/** A capability read: connected with data, honestly unavailable, not in this build, or failed. */
export type Capability<T> =
  | { state: "ok"; data: T }
  | { state: "unavailable"; message: string; data?: T }
  | { state: "unconnected" }
  | { state: "failed"; message: string };
