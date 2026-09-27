// owner: study-prep. "Study prepper": per upcoming exam or quiz, a NotebookLM-shaped workspace.
// Sources (the assessment's covered materials, all ticked by default) are the scope; the Studio
// makes a study guide, a practice quiz and flashcards from them on request, grounded in the
// student's own passages. The query reads the local database only (0 tokens); generation is the
// existing `pack` command with the pack name `study-prep-<kinds>` (no new transport).
import { z } from "zod";

const id = z.string().min(1).max(256);
export const studyPrepRequestSchema = z
  .object({
    view: z.literal("study.prep"),
    courseId: id,
    /** Omitted: the course's upcoming exams and quizzes only (the course page's entries). */
    assessmentId: id.optional(),
    /** The ticked sources; omitted means every source in the assessment's coverage. */
    resourceIds: z.array(id).max(200).optional(),
    /** Topics the student narrowed to ("quiz me on"); omitted means all. */
    topicIds: z.array(id).max(50).optional(),
  })
  .strict();
export type StudyPrepRequest = z.infer<typeof studyPrepRequestSchema>;

export const STUDY_PREP_KINDS = ["guide", "quiz", "cards"] as const;
export type StudyPrepKind = (typeof STUDY_PREP_KINDS)[number];
export const STUDY_PREP_PACK_PREFIX = "study-prep";
/** The pack command's name for a set of kinds, in a fixed order: `study-prep-guide-quiz-cards`. */
export function studyPrepPackName(kinds: readonly StudyPrepKind[]): string {
  const set = new Set(kinds);
  return [STUDY_PREP_PACK_PREFIX, ...STUDY_PREP_KINDS.filter((k) => set.has(k))].join("-");
}
/** The kinds a pack name asks for, or null when it isn't a study-prep pack. */
export function studyPrepKinds(pack: string): StudyPrepKind[] | null {
  if (!pack.startsWith(`${STUDY_PREP_PACK_PREFIX}-`)) return null;
  const parts = pack.slice(STUDY_PREP_PACK_PREFIX.length + 1).split("-");
  if (!parts.length || parts.some((p) => !(STUDY_PREP_KINDS as readonly string[]).includes(p))) return null;
  return STUDY_PREP_KINDS.filter((k) => parts.includes(k));
}

/** Where a quote sits in its source, checked by code; opening it shows the source at that span. */
export interface StudyPrepQuote {
  resourceId: string | null;
  title: string;
  url: string | null;
  quote: string;
  start: number | null;
  end: number | null;
}

export type StudyPrepSourceRole = "lecture" | "slides" | "reading" | "homework" | "solutions" | "practice_exam" | "review_sheet" | "past_exam" | "syllabus" | "other";
export interface StudyPrepSource {
  resourceId: string;
  title: string;
  url: string | null;
  role: StudyPrepSourceRole;
  moduleId: string | null;
  moduleLabel: string | null;
  /** Why code put it in this assessment's coverage. */
  reason: string;
  /** Ticked by default (every source in coverage). */
  checked: boolean;
  topicIds: string[];
  /** Assignments whose instructions reference this source. */
  assignmentIds: string[];
  passages: number;
}
/** A filter chip: an assignment, a module or a topic, each narrowing the ticked sources. */
export interface StudyPrepScopeItem {
  kind: "assignment" | "module" | "topic";
  id: string;
  title: string;
  /** The sources the chip selects. */
  resourceIds: string[];
}

export type StudyPrepStatus = "missing" | "generating" | "ready" | "stale" | "failed";
export interface StudyPrepGuideBlock {
  id: string;
  kind: "point" | "definition" | "example";
  topic: string;
  heading: string | null;
  /** May hold TeX in $…$ or $$…$$. */
  text: string;
  /** example: the expression and the value code recomputed. */
  expression: string | null;
  computed: string | null;
  source: StudyPrepQuote;
}
export interface StudyPrepGuide {
  title: string;
  sections: { id: string; title: string; topics: string[]; blocks: StudyPrepGuideBlock[] }[];
}
export interface StudyPrepQuizItem {
  itemId: string;
  version: number;
  kind: "mc" | "tf" | "numeric";
  stem: string;
  options: { id: string; text: string }[] | null;
  /** The key the pack gave and code checked; the UI grades by code against it. */
  key: string | number;
  unit: string | null;
  explanation: string | null;
  topics: string[];
  source: StudyPrepQuote;
}
export interface StudyPrepCard {
  /** The FSRS card; null for a cloze card, which practice uses as a recall item instead. */
  cardId: string | null;
  itemId: string;
  kind: "card" | "cloze";
  front: string;
  back: string;
  topics: string[];
  due: string | null;
  source: StudyPrepQuote;
}
export interface StudyPrepMaterial {
  kind: StudyPrepKind;
  status: StudyPrepStatus;
  /** Sections, questions or cards. */
  count: number;
  generatedAt: string | null;
  message: string | null;
  /** stale: the sources whose content changed since it was made. */
  changed: string[];
  guide: StudyPrepGuide | null;
  quiz: StudyPrepQuizItem[] | null;
  cards: StudyPrepCard[] | null;
}

export interface StudyPrepAssessment {
  id: string;
  title: string;
  kind: string;
  /** ISO date or instant; null when no date is known (never invented). */
  date: string | null;
  daysAway: number | null;
  where: string | null;
  weight: number | null;
}
/** The zero-token first view: what is covered, key terms, dates and format, all code. */
export interface StudyPrepOverview {
  covered: { text: string; source: StudyPrepQuote | null }[];
  modules: string[];
  topics: { id: string; label: string }[];
  keyTerms: { kind: "term" | "definition" | "formula"; value: string; source: StudyPrepQuote }[];
  dates: { label: string; date: string }[];
  format: string | null;
  length: string | null;
  warnings: string[];
}
/** Evidence-defined mastery for this assessment; never a grade prediction or a percentage. */
export interface StudyPrepMastery {
  label: string;
  counts: { solid: number; getting_there: number; iffy: number; not_seen: number };
  total: number;
}

export type StudyPrepResult =
  | {
      view: "study.prep";
      status: "ok";
      courseId: string;
      courseRef: string;
      assessment: StudyPrepAssessment;
      sources: StudyPrepSource[];
      scopeItems: StudyPrepScopeItem[];
      /** The resources and topics this answer's materials are for (after validation). */
      scope: { all: boolean; resourceIds: string[]; topicIds: string[]; hash: string };
      overview: StudyPrepOverview;
      materials: Record<StudyPrepKind, StudyPrepMaterial>;
      mastery: StudyPrepMastery | null;
      /** Course resources the learning router's trusted resolver accepts as anchors (FSRS review sessions). */
      anchorIds: string[];
      restricted: boolean;
      modelCalls: 0;
      ms: number;
    }
  | {
      view: "study.prep";
      status: "list";
      courseId: string;
      upcoming: StudyPrepAssessment[];
      modelCalls: 0;
      ms: number;
    }
  | { view: "study.prep"; status: "missing" | "empty"; courseId: string; message: string; modelCalls: 0; ms: number };
// end owner: study-prep
