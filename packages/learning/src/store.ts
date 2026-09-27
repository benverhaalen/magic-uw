// N11: the LearningStore interface (spec §7.4, amended by course-backend §L and
// D17: no passage or job methods; coverage keys to assessments; concept aliases).
// Record shapes mirror the spec §7.2 tables; the SQL store (N24) implements the
// same interface.
import type { Bloom, ItemFormat } from "./config";

/** `accountScope:courseId` (learning_courses.id). */
export type CourseRef = string;

export interface LearningCourse {
  id: CourseRef;
  accountScope: string;
  courseId: string;
  label: string;
  term: string | null;
  createdAt: string;
}

export type ConceptOrigin = "code" | "model" | "student";
export type ConceptStatus = "active" | "merged" | "hidden";

export interface ConceptSource {
  resourceId: string;
  contentHash: string;
  start: number;
  end: number;
  quote: string;
  quoteValid: boolean;
}

export interface Concept {
  id: string;
  courseRef: CourseRef;
  parentId: string | null;
  label: string;
  kind: "unit" | "concept";
  position: number;
  origin: ConceptOrigin;
  status: ConceptStatus;
  mergedInto: string | null;
  studentLabel: string | null;
  mapVersion: string;
  sources: ConceptSource[];
}

export type ConceptEdit =
  | { kind: "rename"; label: string }
  | { kind: "merge"; intoId: string }
  | { kind: "hide" }
  | { kind: "restore" };

export interface ConceptAlias {
  conceptId: string;
  alias: string;
  origin: "code" | "jev" | "student";
}

export type ItemKind = ItemFormat | "card";
export type ItemStatus = "active" | "quarantined" | "stale";
export type ItemOrigin = "generated" | "instructor" | "mistake" | "note" | "student";
export type Tier = "T1" | "T2" | "T3" | "T4";

export interface ItemOption {
  id: string;
  text: string;
}

export interface KeyIdea {
  idea: string;
  /** Accepted alternative phrasings, matched by code after normalisation. */
  synonyms: string[];
  required: boolean;
}

export interface LearningItem {
  id: string;
  version: number;
  courseRef: CourseRef;
  familyId: string;
  kind: ItemKind;
  stem: string;
  options: ItemOption[] | null;
  /** MC/T/F: the option id; typed/cloze: the answer text; numeric: the number. */
  key: string | number;
  unit?: string;
  keyIdeas: KeyIdea[];
  explanation: string | null;
  tempting: Record<string, string>;
  bloom: Bloom;
  bPrior: number;
  tier: Tier;
  sourceTerm: string | null;
  origin: ItemOrigin;
  status: ItemStatus;
  statusReason: string | null;
  generator: { client: string; model: string; promptVersion: string } | null;
  createdAt: string;
}

export interface ItemSource {
  resourceId: string;
  contentHash: string;
  textHash: string;
  start: number;
  end: number;
  quote: string;
  quoteValid: boolean;
}

export interface ItemTag {
  conceptId: string;
  weight: number;
  primary: boolean;
}

export interface ItemCheck {
  check: string;
  method: "code" | "jev" | `model:${string}` | "human";
  outcome: "pass" | "fail" | "abstain" | "not_run";
  detail?: unknown;
  createdAt: string;
}

export interface StoredItem {
  item: LearningItem;
  sources: ItemSource[];
  tags: ItemTag[];
  checks: ItemCheck[];
}

export interface ItemFilter {
  courseRef?: CourseRef;
  familyId?: string;
  conceptId?: string;
  status?: ItemStatus;
  ids?: string[];
}

/** The ts-fsrs Card fields, stored as ISO strings. */
export interface FsrsCardState {
  due: string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: number;
  last_review: string | null;
}

export interface LearningCard {
  id: string;
  itemId: string;
  /** Pinned source item version; absent for concept-only tracks. */
  itemVersion?: number;
  courseRef: CourseRef;
  conceptId: string;
  fsrs: FsrsCardState;
  fsrsVersion: string;
  paramsHash: string;
  isConceptTrack: boolean;
}

export interface CardFilter {
  courseRef?: CourseRef;
  conceptId?: string;
  itemId?: string;
  dueBefore?: string;
}

export interface LearningReview {
  id: string;
  cardId: string;
  rating: 1 | 2 | 3 | 4;
  stateBefore: FsrsCardState;
  stateAfter: FsrsCardState;
  reviewMs: number;
  localDay: string;
  undoesReviewId: string | null;
  createdAt: string;
}

export type Assistance = "none" | "hint" | "explained";
export type AttemptMode = "learn" | "test" | "exam" | "review" | "diagnostic" | "write";

export interface LearningAttempt {
  id: string;
  courseRef: CourseRef;
  itemId: string;
  itemVersion: number;
  sourceResourceId: string | null;
  primaryConceptId: string;
  correct: boolean;
  assistance: Assistance;
  seenBefore: boolean;
  confidence: number | null;
  createdAt: string;
  format: ItemFormat;
  mode: AttemptMode;
  response: unknown;
  score: number;
  gradingMethod: string;
  responseMs: number;
  conceptTags: ItemTag[];
  sessionId: string;
  localDay: string;
  /** For MC: the option chosen (P12 error patterns). */
  optionId?: string;
}

export interface SelfRating {
  id: string;
  conceptId: string;
  rating: "dont_know" | "shaky" | "know_it";
  delayed: boolean;
  localDay: string;
  createdAt: string;
}

export type DisputeTarget = "citation" | "item" | "grade" | "concept_tag";
export type DisputeStatus = "open" | "undone" | "resolved";

export interface Dispute {
  id: string;
  courseRef: CourseRef;
  targetKind: DisputeTarget;
  targetId: string;
  reason: string;
  note: string | null;
  status: DisputeStatus;
  createdAt: string;
  resolvedAt: string | null;
}

export type ArtifactKind =
  | "answer"
  | "study_guide"
  | "briefing"
  | "faq"
  | "glossary"
  | "timeline"
  | "mind_map"
  | "coverage"
  | "audio_script";

export interface LearningArtifact {
  id: string;
  courseRef: CourseRef;
  kind: ArtifactKind;
  scope: unknown;
  cacheKey: string;
  body: unknown;
  removedCount: number;
  status: "ready" | "stale" | "partial" | "failed";
  generator: unknown;
  pack?: string;
  packVersion?: string;
  createdAt: string;
  sources: { resourceId: string; contentHash: string }[];
}

export type CoverageStatus = "proposed" | "confirmed" | "flagged" | "rejected";

export interface CoverageRow {
  assessmentId: string;
  conceptId: string;
  basis: "stated" | "schedule_window" | "mapped";
  tier: Tier;
  evidenceResourceId: string | null;
  start: number | null;
  end: number | null;
  quote: string | null;
  status: CoverageStatus;
  /** True once the student decided; a later putCoverage never overwrites it. */
  decidedByStudent: boolean;
}

export interface LearningSession {
  id: string;
  courseRef: CourseRef | null;
  kind: string;
  plan: unknown;
  minutes: number;
  difficulty: string;
  startedAt: string;
  endedAt: string | null;
}

/** Cached per-concept state (a rebuildable cache; internal fields never leave the worker). */
export interface ConceptStateRow {
  conceptId: string;
  theta: number;
  n: number;
  s: number;
  pHat: number;
  r: number | null;
  band: string;
  reasons: unknown;
  counts: unknown;
  configVersion: string;
  computedAt: string;
}

export interface Evidence {
  attempts: LearningAttempt[];
  reviews: LearningReview[];
  selfRatings: SelfRating[];
  disputes: Dispute[];
}

export interface StaleReport {
  artifacts: string[];
  /** Items whose quote still validates at the new version: marked stale. */
  items: { id: string; version: number }[];
  /** Items whose quote no longer validates: quarantined "source changed" (NB-13). */
  quarantined: { id: string; version: number }[];
  cards: string[];
}

export interface LearningStore {
  // Courses
  course(accountScope: string, courseId: string, label?: string, term?: string | null): LearningCourse;
  // Concepts
  concepts(courseRef: CourseRef): Concept[];
  putConceptMap(courseRef: CourseRef, map: Concept[], mapVersion: string): void;
  editConcept(id: string, edit: ConceptEdit): Concept;
  aliases(conceptId: string): ConceptAlias[];
  addAlias(alias: ConceptAlias): void;
  // Items
  putItem(item: LearningItem, sources: ItemSource[], tags: ItemTag[], checks: ItemCheck[]): void;
  items(filter?: ItemFilter): StoredItem[];
  setItemStatus(id: string, version: number, status: ItemStatus, reason: string | null): void;
  // Cards
  cards(filter?: CardFilter): LearningCard[];
  putCard(card: LearningCard): void;
  addReview(review: LearningReview): void;
  // Evidence
  addAttempt(attempt: LearningAttempt): void;
  addSelfRating(rating: SelfRating): void;
  evidence(courseRef: CourseRef, since?: string): Evidence;
  // Disputes
  addDispute(dispute: Dispute): void;
  setDisputeStatus(id: string, status: DisputeStatus, at: string): void;
  // Artifacts and coverage
  artifact(cacheKey: string): LearningArtifact | null;
  putArtifact(artifact: LearningArtifact): void;
  /** `stillValid(quote)` re-runs the quote check against the new text (the caller supplies the validator). */
  markStale(resourceId: string, newHash: string, stillValid?: (quote: string) => boolean): StaleReport;
  coverage(assessmentId: string): CoverageRow[];
  putCoverage(rows: CoverageRow[]): void;
  decideCoverage(key: { assessmentId: string; conceptId: string }, status: CoverageStatus): void;
  // Sessions and state
  session(id: string): LearningSession | null;
  /** Atomically replace the session and optionally append scored evidence after revision CAS. */
  commitSession(session: LearningSession, expectedRevision: number | null, attempt?: LearningAttempt): boolean;
  putSession(session: LearningSession): void;
  sessions(courseRef: CourseRef | null): LearningSession[];
  conceptState(courseRef: CourseRef): ConceptStateRow[];
  putConceptState(rows: ConceptStateRow[]): void;
  // Purge analogue (KM-13)
  reset(): void;
}

/** Deterministic JSON with sorted keys, for content-equality checks on immutable rows. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}
