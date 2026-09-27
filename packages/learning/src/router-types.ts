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
