// owner: page-views. Three page views, each one composite read-only query (the `query` channel):
// `assignment.workspace`, `lecture.session` and `assessment.page`. Code decides and ranks; every
// item carries its reason and its evidence (a quote and its source); a field nothing supports is
// listed in `missing` with a sentence, never filled in. The optional "how to approach it"
// paragraph is generated only on request (the `pack` command, pack "page-approach"); the query
// reads it from the cache by the page's fact hash and never calls a model.
import { z } from "zod";
import type { AccessState, AgendaGroup } from "./course-core";
import type { DeadlineResolution, EffectiveCoursePolicy } from "./index";
import type { NoteBlock, NoteSummary, SessionType } from "./notes";

const id = z.string().min(1).max(256);
export const pageViewRequestSchemas = [
  z.object({ view: z.literal("assignment.workspace"), resourceId: id }).strict(),
  z
    .object({
      view: z.literal("lecture.session"),
      courseId: id,
      accountScope: id.optional(),
      /** A notes session ID (`<courseId>/<date>:<type>`); or give `date` (and optionally `type`). */
      sessionId: z.string().min(1).max(500).optional(),
      date: z.iso.date().optional(),
      type: z.enum(["lecture", "discussion", "lab", "other"]).optional(),
    })
    .strict(),
  /** A stored assessment row ID, or the resource ID of a Canvas exam, quiz or assignment. */
  z.object({ view: z.literal("assessment.page"), assessmentId: id }).strict(),
  /** One course's grade bank and study offers for its upcoming graded items (code only, 0 tokens). */
  z
    .object({
      view: z.literal("study.offers"),
      courseId: id,
      accountScope: id.optional(),
      days: z.number().int().min(1).max(120).optional(),
    })
    .strict(),
] as const;

// ---------- The grade bank and study offers (code only; never a grade prediction) ----------
export interface GradeGroupRow {
  groupId: string;
  title: string;
  /** Percent of the final grade, as listed (Canvas group weight, or the syllabus when Canvas lists none). */
  weight: number | null;
  weightBasis: "canvas" | "syllabus" | "none";
  drops: { lowest: number; highest: number };
  /** From the grades captured in Canvas; null when nothing is graded yet. */
  standing: { earned: number; possible: number; percent: number; graded: number; items: number } | null;
  evidence: PageEvidence[];
}
export interface GradeShare {
  resourceId: string | null;
  title: string;
  /** computed: complete capture, weights to 100%, no drops; listed: only the group's weight is known;
   *  syllabus: the syllabus states this item's weight; unknown: nothing supports a number. */
  basis: "computed" | "listed" | "syllabus" | "unknown";
  /** This item's share of the final grade (computed or syllabus only). */
  sharePercent: number | null;
  /** The most this item can move the final grade, in percentage points (listed: the group's whole weight, an upper bound). */
  maxMovePercent: number | null;
  groupId: string | null;
  /** Why no computed share (partial_capture, drop_rules, weights_do_not_total_100, ...). */
  reason: string | null;
  text: string;
  evidence: PageEvidence[];
}
export interface GradeBank {
  status: "complete" | "partial" | "unknown";
  reason: string | null;
  weighting: "weighted" | "unweighted" | "unknown";
  groups: GradeGroupRow[];
  /** Canvas's own calculation, when captured; never an official grade. */
  canvasScore: { currentScore: number | null; currentGrade: string | null; note: string } | null;
  note: string;
}
export interface StudyOffer {
  id: "cards" | "review_sheet" | "study_plan" | "practice_exam" | "formula_sheet";
  label: string;
  status: "ready" | "not_built" | "not_allowed" | "not_stated";
  reason: string;
  /** The exact command it would run (the `pack`, `learning` or `query` channel); the query runs nothing. */
  command: Record<string, unknown> | null;
  scope: { resourceIds: string[]; topicIds: string[] };
}
export interface OfferItem {
  resourceId: string | null;
  assessmentId: string;
  title: string;
  kind: string | null;
  dueAt: string | null;
  stakes: "low" | "medium" | "high";
  grade: GradeShare;
  /** Code's order for "what matters next": grade impact × time until due × weakness of its topics. */
  critical: { score: number; impact: number; urgency: number; weakness: number; text: string };
  offers: StudyOffer[];
}
export interface StudyOffers {
  view: "study.offers";
  generatedAt: string;
  course: PageCourse;
  gradeBank: GradeBank;
  /** Upcoming graded items, most critical first. */
  items: OfferItem[];
  missing: PageMissing[];
}

/** How a quote was read: a slice of the text or title, a structured Canvas field, or a stored row. */
export type PageEvidenceBasis = "text" | "title" | "structure" | "field";
export type PageOrigin =
  | "canvas"
  | "assignment_text"
  | "syllabus"
  | "announcement"
  | "page"
  | "file"
  | "module"
  | "calendar"
  | "mail"
  | "course_profile"
  | "course_map"
  | "material_facts"
  | "notes";
export interface PageEvidence {
  resourceId: string | null;
  /** The source's title, as captured. */
  source: string;
  origin: PageOrigin;
  /** The source's own https link (Canvas page, file, announcement), when it has one. */
  url: string | null;
  /** Exactly as stored: a slice of the text or title, or the structured value code read. */
  quote: string;
  basis: PageEvidenceBasis;
  /** The structured field a `field`/`structure` quote came from (for example `dueAt`). */
  field: string | null;
  /** Offsets into the source's text or title when the quote is a slice of it. */
  start: number | null;
  end: number | null;
  /** When the source said it (an announcement's post time), when known. */
  statedAt: string | null;
}
/** A field the view looked for and didn't find, said plainly ("no posted duration found"). */
export interface PageMissing {
  field: string;
  text: string;
}
/**
 * How to open an item. `app`: stored text, opened in the app's reader. `browser`: the default
 * browser (D40 link card). `canvas`: the Canvas page that holds it (an LTI tool is never launched
 * by the app). `none`: nothing to open (the tool starts on launch, or no link was captured).
 */
export interface PageOpen {
  how: "app" | "browser" | "canvas" | "none";
  url: string | null;
  resourceId: string | null;
  note: string | null;
}
export interface PageFreshness {
  observedAt: string | null;
  lastSuccessAt: string | null;
  /** The source read's state: `stale` after 24 hours without a successful read. */
  status: "current" | "partial" | "stale" | "failed" | "unknown";
}
export interface PageResource {
  resourceId: string | null;
  title: string;
  kind: string;
  /** The code-classified role (lecture, reading, homework, exam, solutions...), when known. */
  role: string | null;
  /** The strongest reason, in words ("linked in instructions", "same module", ...). */
  reason: string;
  /** Every reason code found, strongest first. */
  reasons: string[];
  /** direct, named, module, syllabus, covers, session, map, date. */
  strength: string;
  /** Code's rank score (higher first); only orders the list. */
  score: number;
  evidence: PageEvidence[];
  open: PageOpen;
  freshness: PageFreshness;
  /** Shown only because nothing stated the scope (the dossier floor). */
  provisional: boolean;
}
export interface PageTool {
  name: string;
  host: string;
  kind: string;
  url: string;
  accessState: AccessState;
  accessReason: string | null;
  /** Never launches an LTI tool: open in the browser, open its Canvas page, or nothing. */
  action: { kind: "open_in_browser" | "open_from_canvas" | "none"; url: string | null; note: string | null };
  launchEffect: string | null;
  reason: string;
  evidence: PageEvidence[];
}
export interface PageChange {
  kind: "announcement" | "discussion" | "mail" | "date_change" | "requirements_change";
  at: string | null;
  title: string;
  reason: string;
  evidence: PageEvidence[];
  oldValue: string | null;
  newValue: string | null;
  open: PageOpen;
}
export interface PageTopic {
  conceptId: string;
  label: string;
  moduleLabel: string | null;
  state: string;
  stateLabel: string;
  reason: string;
  practiceItems: number;
}
/** A learning-channel request the renderer can send as-is (the `learning` command). */
export interface PagePracticeTarget {
  label: string;
  request: Record<string, unknown>;
}
export interface PageReadiness {
  status: "ok" | "no_topics" | "unavailable";
  message: string;
  topics: PageTopic[];
  studyNext: { conceptId: string; label: string; reason: string }[];
  targets: PagePracticeTarget[];
  /** Always: this is not a grade prediction. */
  note: string;
}
export interface PageApproach {
  status: "ready" | "not_generated" | "unavailable";
  message: string;
  factHash: string;
  text: string | null;
  generatedAt: string | null;
  client: string | null;
  model: string | null;
  /** The code checks re-run on read: every date, number and quote against the page's facts. */
  checks: { passed: boolean; errors: string[] };
  /** The command that generates it on request (one checked call through the student's own AI). */
  request: { type: "pack"; pack: "page-approach"; scope: { courseId: string; resourceIds?: string[]; assessmentId?: string } };
}
export interface PageDated {
  at: string;
  evidence: PageEvidence[];
}
/** One posted detail with every source that states it; two disagreeing sources are both kept. */
export interface PageDetail {
  field: "date" | "location" | "duration" | "format" | "allowed_materials" | "weight";
  /** found: sources agree. changed: a later explicit change supersedes an earlier value (both shown).
   *  conflict: sources disagree and nothing settles it (value is null). missing: nothing found. */
  status: "found" | "changed" | "conflict" | "missing";
  value: string | null;
  claims: { value: string; evidence: PageEvidence; superseded: boolean }[];
  text: string;
}
export interface PageCourse {
  accountScope: string;
  courseId: string;
  courseName: string;
  url: string | null;
}

export interface AssignmentWorkspace {
  view: "assignment.workspace";
  generatedAt: string;
  factHash: string;
  course: PageCourse;
  header: {
    resourceId: string;
    title: string;
    url: string;
    kind: string | null;
    due: PageDated | null;
    lock: PageDated | null;
    unlock: PageDated | null;
    /** The deadline resolution over every source (Canvas, calendar, announcement, syllabus). */
    deadline: Pick<DeadlineResolution, "dueAt" | "conflict" | "reason" | "preferredAt" | "basis" | "notes">;
    points: { value: number; evidence: PageEvidence } | null;
    gradeWeight: {
      basis: "listed" | "computed" | "unknown";
      percent: number | null;
      text: string | null;
      evidence: PageEvidence[];
    };
    submissionTypes: string[];
    status: {
      state: "submitted" | "graded" | "missing" | "late" | "excused" | "not_submitted" | "no_submission" | "unknown";
      late: boolean | null;
      missing: boolean | null;
      submittedAt: string | null;
      evidence: PageEvidence[];
    };
    startBy: { at: string; basis: string } | null;
    effort: { lowMin: number; highMin: number; basis: string } | null;
    aiPolicy: {
      mode: EffectiveCoursePolicy["mode"];
      conflict: boolean;
      evidence: PageEvidence[];
      text: string;
    };
  };
  instructions: {
    /** The Canvas description, quoted (cut at a cap; `truncated` says so). */
    text: string;
    textLength: number;
    truncated: boolean;
    rubric: { criterion: string; points: number | null; ratings: { description: string; points: number | null }[] }[];
    canvas: PageOpen;
  };
  /** At most five (spec C5), best first. */
  resources: PageResource[];
  /** The rest, collapsed: "All linked (n)". */
  moreResources: { count: number; items: PageResource[] };
  tools: PageTool[];
  lectures: {
    materials: PageResource[];
    notes: (NoteSummary & { reason: string })[];
  };
  changes: PageChange[];
  readiness: PageReadiness;
  /** Its grade share and study offers (the `study.offers` row for this item). */
  grade: GradeShare;
  offers: StudyOffer[];
  approach: PageApproach;
  missing: PageMissing[];
}

export interface LectureSession {
  view: "lecture.session";
  generatedAt: string;
  factHash: string;
  course: PageCourse;
  session: {
    id: string;
    type: SessionType;
    date: string;
    startMinute: number | null;
    endMinute: number | null;
    title: string;
    location: string | null;
    origin: string;
    typeBasis: string;
    module: { id: string | null; title: string; reason: string } | null;
  } | null;
  /** The notes scaffold (packages/notes): the head blocks, each source with code's reason. */
  scaffold: { blocks: NoteBlock[]; hash: string } | null;
  note: NoteSummary | null;
  slides: PageResource[];
  readings: PageResource[];
  recordings: PageResource[];
  keyTerms: { term: string; evidence: PageEvidence }[];
  dueSoon: { resourceId: string; title: string; dueAt: string; reason: string; evidence: PageEvidence[]; open: PageOpen }[];
  officeHours: { text: string; evidence: PageEvidence }[];
  missing: PageMissing[];
}

export interface AssessmentPage {
  view: "assessment.page";
  generatedAt: string;
  factHash: string;
  course: PageCourse;
  assessment: {
    id: string;
    resourceId: string | null;
    title: string;
    kind: string;
    url: string | null;
    origin: string;
  };
  /** 1. Posted details, each with its sources; two disagreeing sources are shown side by side. */
  details: PageDetail[];
  /** 2. Scope in the instructor's words, and the modules code maps it to. */
  scope: {
    stated: boolean;
    quotes: PageEvidence[];
    modules: { moduleId: string; title: string; reason: string }[];
    text: string;
  };
  /** 3. Relevant materials by tier (spec C5 caps), with the collapsed rest. */
  materials: {
    core: PageResource[];
    alsoUseful: PageResource[];
    practice: PageResource[];
    allInScope: { count: number; resourceIds: string[] };
    provisional: boolean;
  };
  /** 4. Practice: the blueprint and practice exam when built; otherwise topic practice targets. */
  practice: { blueprint: null; practiceExam: null; message: string; targets: PagePracticeTarget[] };
  /** 5. A formula or glossary sheet from quoted facts, only when the course allows notes or sheets. */
  sheet: {
    status: "allowed" | "not_allowed" | "not_stated";
    text: string;
    policy: PageEvidence[];
    entries: { kind: "formula" | "definition" | "term"; value: string; evidence: PageEvidence }[];
  };
  /** 6. Readiness per topic, and a day-by-day plan to the exam date (code). */
  readiness: PageReadiness;
  plan: {
    status: "ok" | "no_date" | "past" | "no_topics";
    text: string;
    days: { date: string; minutes: number; topics: { conceptId: string; label: string; minutes: number }[]; busy: number }[];
    minutesPerTopic: { state: string; minutes: number; basis: string }[];
  };
  /** 7. Office hours between now and the exam. */
  officeHours: { date: string; text: string; evidence: PageEvidence }[];
  grade: GradeShare;
  offers: StudyOffer[];
  /** The course-mastery builder's per-assessment slice (`course.mastery`); `not_built` until it lands on main. */
  mastery: PageMastery;
  approach: PageApproach;
  missing: PageMissing[];
}
/** A typed seam for the course-mastery builder's assessment slice; nothing fills it on this build. */
export type PageMastery =
  | { status: "not_built"; message: string; slice: null }
  | { status: "ok"; message: string; slice: unknown };

export type PageViewResult = AssignmentWorkspace | LectureSession | AssessmentPage | StudyOffers;
export type PageAgendaGroup = AgendaGroup;
// end owner: page-views
