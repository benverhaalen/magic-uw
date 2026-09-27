// owner: study-prep. One unified space per work item (an assignment, a quiz or an exam): what it
// is and when, what the student needs for it (its instructions, the linked materials with the
// reason each is linked, lecture sessions and announcements), and three study actions: a study
// guide, flashcards and a test (a practice exam for an exam; a practice quiz on the concepts for an
// assignment or quiz). The `study.prep` query reads the local database only (0 tokens);
// generation is the existing `pack` command with the pack name `study-prep-<kinds>`.
import { z } from "zod";

const id = z.string().min(1).max(256);
export const studyPrepRequestSchema = z
  .object({
    view: z.literal("study.prep"),
    /** Omitted with no item: every included course's upcoming exams and quizzes (Study & Learn). */
    courseId: id.optional(),
    /** The work item: a course-map assessment, or a Canvas assignment, quiz or exam resource. Omitted: the course's list. */
    itemId: id.optional(),
    /** Deprecated name for `itemId`. */
    assessmentId: id.optional(),
    /** The ticked sources; omitted means every source linked to the item. */
    resourceIds: z.array(id).max(200).optional(),
    /** Topics the student narrowed to; omitted means all. */
    topicIds: z.array(id).max(50).optional(),
  })
  .strict();
export type StudyPrepRequest = z.infer<typeof studyPrepRequestSchema>;

/**
 * What the student's AI can make for an item. guide: a study guide, summary or key points · cards:
 * flashcards · quiz: a practice quiz · exam: a practice exam modelled on past exams · problems:
 * practice problems like (never the same as) the assigned ones · outline: an outline coach
 * (questions and structure; it never writes the text).
 */
export const STUDY_PREP_KINDS = ["guide", "quiz", "cards", "exam", "problems", "outline"] as const;
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

export type StudyPrepSourceRole = "lecture" | "slides" | "reading" | "file" | "page" | "homework" | "solutions" | "practice_exam" | "review_sheet" | "past_exam" | "syllabus" | "other";
/** A linked material: in "What you need", ticked by default as a source for the study actions. */
export interface StudyPrepSource {
  resourceId: string;
  title: string;
  url: string | null;
  role: StudyPrepSourceRole;
  moduleId: string | null;
  moduleLabel: string | null;
  /** Why code linked it to this item, in plain words. */
  reason: string;
  /** Ticked (used by the study actions and the ask). */
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
  /** The FSRS card, once it has been reviewed; null before (the review creates it). */
  cardId: string | null;
  itemId: string;
  kind: "card" | "cloze";
  front: string;
  back: string;
  topics: string[];
  /** Due by the end of today (never reviewed counts as due). */
  due: boolean;
  dueAt: string | null;
  source: StudyPrepQuote;
}
/** One problem of a practice exam, with its worked solution (TeX) and the passages behind it. */
export interface StudyPrepExamProblem {
  id: string;
  number: string;
  section: string | null;
  points: number | null;
  format: string;
  topic: string;
  prompt: string;
  /** Multiple choice only. */
  options: { id: string; text: string }[] | null;
  /** The answer the app checks: an option id, a number with its unit, or an expression; null when marked by the student against the solution. */
  answer: { kind: "choice"; key: string } | { kind: "numeric"; value: number; unit: string | null } | { kind: "expression"; expr: string } | null;
  solution: string;
  /** How code verified the answer: recomputed, symbolic, key among options, or not checkable by code. */
  verified: "recomputed" | "symbolic" | "key" | "self_marked";
  sources: StudyPrepQuote[];
}
export interface StudyPrepExam {
  title: string;
  minutes: number | null;
  totalPoints: number | null;
  /** What it mirrors, in plain words ("Modelled on Midterm 2 Practice Exam: 2 sections, 4 problems, 20 points"). */
  basis: string;
  problems: StudyPrepExamProblem[];
}
export interface StudyPrepMaterial {
  kind: StudyPrepKind;
  status: StudyPrepStatus;
  /** Sections, questions, cards or problems. */
  count: number;
  generatedAt: string | null;
  message: string | null;
  /** stale: the sources whose content changed since it was made. */
  changed: string[];
  guide: StudyPrepGuide | null;
  quiz: StudyPrepQuizItem[] | null;
  cards: StudyPrepCard[] | null;
  exam: StudyPrepExam | null;
  problems: StudyPrepExamProblem[] | null;
  outline: StudyPrepOutline | null;
}
/** The outline coach: questions to answer and a structure to fill; it never writes the text. */
export interface StudyPrepOutline {
  title: string;
  /** Questions that sharpen the thesis or main point. */
  focus: string[];
  sections: { heading: string; questions: string[]; evidence: { hint: string; source: StudyPrepQuote }[] }[];
}

export type StudyPrepItemKind = "assessment" | "quiz" | "assignment" | "material";

// ---------- Item types: one shell, sections and actions catered to what the item is ----------
export const ITEM_TYPES = ["exam", "quiz", "problem_set", "essay", "lab", "project", "discussion_post", "presentation", "reading", "lecture", "participation"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];
export type ItemSectionId =
  | "blueprint" | "past_exams" | "readiness" | "topics" | "cards_due" | "instructions" | "worked_examples" | "formulas"
  | "rubric" | "readings" | "citation_style" | "safety" | "milestones" | "contacts" | "material" | "when_where" | "materials" | "sessions" | "announcements";
/** A study action: a generation kind (with the item type's style), or a code action (0 tokens). */
export type ItemActionId = StudyPrepKind | "review" | "rubric_check" | "milestone_plan" | "ask";
export interface ItemAction {
  id: ItemActionId;
  label: string;
  /** Keyboard shortcut (one letter). */
  key: string;
  /** One line under the label: what the action gives the student. */
  hint: string;
}
export interface ItemTypeConfig {
  label: string;
  sections: ItemSectionId[];
  actions: ItemAction[];
  /** Ask before opening Canvas ("Want to prep first?"). */
  prepFirst: boolean;
  /** Graded work the student authors: study material coaches the concepts and never does the task. */
  authored: boolean;
}
const A = {
  guide: { id: "guide", label: "Study guide", key: "g", hint: "The key ideas, grounded in your sources" },
  summary: { id: "guide", label: "Summary", key: "g", hint: "The main points of this material" },
  keyPoints: { id: "guide", label: "Key points", key: "k", hint: "What the readings argue, point by point" },
  cards: { id: "cards", label: "Cards", key: "c", hint: "Flashcards from your sources" },
  conceptCards: { id: "cards", label: "Concept cards", key: "c", hint: "Definitions, formulas and results" },
  readingCards: { id: "cards", label: "Reading cards", key: "c", hint: "Claims, terms and sources from the readings" },
  prelabCards: { id: "cards", label: "Prelab cards", key: "c", hint: "Procedure, equipment and the ideas behind them" },
  practiceExam: { id: "exam", label: "Practice exam", key: "t", hint: "A new exam like the past ones, with a worked key" },
  practiceQuiz: { id: "quiz", label: "Practice quiz", key: "t", hint: "Questions on the topics it covers" },
  conceptQuiz: { id: "quiz", label: "Concept quiz", key: "t", hint: "Check the ideas before the lab" },
  quickQuiz: { id: "quiz", label: "Quick quiz", key: "t", hint: "A few questions on this material" },
  problems: { id: "problems", label: "Practice problems", key: "p", hint: "Similar problems with worked solutions, never the assigned ones" },
  outline: { id: "outline", label: "Outline coach", key: "o", hint: "Questions and a structure; you write the text" },
  review: { id: "review", label: "Quick review", key: "r", hint: "Cards due for its topics" },
  rubric: { id: "rubric_check", label: "Rubric checklist", key: "b", hint: "Each criterion to check before you submit" },
  milestones: { id: "milestone_plan", label: "Milestone plan", key: "m", hint: "Deliverables and dates, in order" },
  explain: { id: "ask", label: "Explain a concept", key: "e", hint: "Ask about the linked materials" },
} satisfies Record<string, ItemAction>;
/** The per-type table: adding a type is a row here, not a new page. */
export const ITEM_SPACE: Record<ItemType, ItemTypeConfig> = {
  exam: { label: "Exam", sections: ["blueprint", "readiness", "past_exams", "materials", "sessions", "announcements"], actions: [A.guide, A.cards, A.practiceExam], prepFirst: true, authored: false },
  quiz: { label: "Quiz", sections: ["topics", "cards_due", "materials", "announcements"], actions: [A.review, A.practiceQuiz, A.guide], prepFirst: true, authored: false },
  problem_set: { label: "Problem set", sections: ["instructions", "worked_examples", "formulas", "materials", "announcements"], actions: [A.conceptCards, A.problems, A.explain], prepFirst: false, authored: true },
  essay: { label: "Essay", sections: ["instructions", "rubric", "readings", "citation_style", "announcements"], actions: [A.readingCards, A.outline, A.rubric], prepFirst: false, authored: true },
  lab: { label: "Lab", sections: ["instructions", "safety", "materials", "announcements"], actions: [A.prelabCards, A.conceptQuiz], prepFirst: false, authored: true },
  project: { label: "Project", sections: ["instructions", "milestones", "contacts", "materials", "announcements"], actions: [A.milestones, A.conceptCards], prepFirst: false, authored: true },
  discussion_post: { label: "Discussion post", sections: ["instructions", "readings", "announcements"], actions: [A.readingCards, A.keyPoints], prepFirst: false, authored: true },
  presentation: { label: "Presentation", sections: ["instructions", "rubric", "materials", "announcements"], actions: [A.outline, A.conceptCards], prepFirst: false, authored: true },
  reading: { label: "Reading", sections: ["material", "materials"], actions: [A.summary, A.cards, A.quickQuiz], prepFirst: false, authored: false },
  lecture: { label: "Lecture", sections: ["material", "materials"], actions: [A.summary, A.cards, A.quickQuiz], prepFirst: false, authored: false },
  participation: { label: "Participation", sections: ["when_where"], actions: [], prepFirst: false, authored: false },
};

export interface StudyPrepItem {
  /** The id the item is opened by (a course-map assessment id or a resource id). */
  id: string;
  kind: StudyPrepItemKind;
  /** What the item is, decided by code (or the student's correction, or their AI for leftovers). */
  type: ItemType;
  typeReason: string;
  typeBasis: "code" | "student" | "ai" | "default";
  /** The Canvas resource, when there is one. */
  resourceId: string | null;
  title: string;
  courseId: string;
  courseName: string;
  /** ISO date or instant; null when no date is known (never invented). */
  date: string | null;
  daysAway: number | null;
  where: string | null;
  points: number | null;
  /** Percent of the course grade, or of its group, as the course lists it. */
  weight: { percent: number; of: "course" | "group"; group: string | null } | null;
  status: { submitted: boolean; graded: string | null; missing: boolean; availability: "open" | "closed" | "not_yet_open" | "unknown" };
  /** The Canvas page, for "Open in Canvas". */
  url: string | null;
}
/** The zero-token overview: what is covered, key terms, dates and format, all code. */
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
/** Evidence-defined mastery; never a grade prediction or a percentage. */
export interface StudyPrepMastery {
  label: string;
  counts: { solid: number; getting_there: number; iffy: number; not_seen: number };
  total: number;
}
/** Cards and questions linked to the item (made for it, or on its sources and topics), for review. */
export interface StudyPrepReview {
  cards: number;
  due: number;
  questions: number;
  /** The linked cards, due first, for a review session scoped to exactly them. */
  cardItemIds: string[];
  questionItemIds: string[];
}

export type StudyPrepResult =
  | {
      view: "study.prep";
      status: "ok";
      courseId: string;
      courseRef: string;
      item: StudyPrepItem;
      /** The item's type row: its sections and study actions, in order. */
      config: ItemTypeConfig;
      /** The item's own instructions, in full (shown here; sent to an AI only once past due). */
      instructions: { text: string; resourceId: string } | null;
      /** Section payloads the item's type shows (code only). */
      sections: StudyPrepSections;
      sources: StudyPrepSource[];
      scopeItems: StudyPrepScopeItem[];
      sessions: { date: string; title: string }[];
      announcements: { resourceId: string; title: string; date: string | null; excerpt: string }[];
      /** The resources and topics this answer's materials are for (after validation). */
      scope: { all: boolean; resourceIds: string[]; topicIds: string[]; hash: string };
      overview: StudyPrepOverview;
      materials: Record<StudyPrepKind, StudyPrepMaterial>;
      mastery: StudyPrepMastery | null;
      review: StudyPrepReview;
      /** Course resources the learning router's trusted resolver accepts as anchors (FSRS review sessions). */
      anchorIds: string[];
      restricted: boolean;
      modelCalls: 0;
      ms: number;
    }
  | {
      view: "study.prep";
      status: "list";
      /** Null: every included course (Study & Learn). */
      courseId: string | null;
      upcoming: StudyPrepUpcoming[];
      /** Course lists only: each assignment's study state, for its row. */
      assignments: Record<string, StudyPrepItemState>;
      modelCalls: 0;
      ms: number;
    }
  | { view: "study.prep"; status: "missing" | "empty"; courseId: string | null; message: string; modelCalls: 0; ms: number };

/** What the catered sections show; each is filled only for the types that list it. */
export interface StudyPrepSections {
  readiness?: { topicId: string; label: string; state: "solid" | "getting_there" | "iffy" | "not_seen"; stateLabel: string }[];
  pastExams?: { resourceId: string; title: string; role: StudyPrepSourceRole; saved: { status: "saved" | "pending" | "failed" | "waiting_for_text"; at: string | null; problems: number } }[];
  workedExamples?: { text: string; source: StudyPrepQuote }[];
  rubric?: { criterion: string; detail: string | null; points: number | null; ratings: { label: string; points: number | null }[] }[];
  citationStyle?: { style: string; source: StudyPrepQuote } | null;
  safety?: { text: string; source: StudyPrepQuote }[];
  milestones?: { resourceId: string; title: string; date: string | null; done: boolean }[];
  contacts?: { name: string; role: string }[];
  material?: { resourceId: string; title: string; text: string; url: string | null } | null;
}

/** An upcoming exam or quiz in a list, with its readiness and what is prepared. */
export interface StudyPrepUpcoming extends StudyPrepItem {
  mastery: StudyPrepMastery | null;
  state: StudyPrepItemState;
}
/** What is prepared for an item, for a row's compact icon badges. */
export interface StudyPrepItemState {
  materials: Record<StudyPrepKind, { status: StudyPrepStatus; count: number }>;
  cards: number;
  due: number;
  questions: number;
}
// end owner: study-prep
