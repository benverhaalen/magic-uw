/**
 * The agenda's facts, read from the local database through scoped reads: only the sources whose
 * scope holds dated work (assignments, quizzes), the assignment groups and the course rows, never
 * the whole workspace. Code decides every field; nothing here calls the network or a model.
 */
import type { Assessment, Resource, SourceHealth, Store } from "@magic/contracts";
import { gradeShareDetail, type GradeShareDetail, type GradeShareResource } from "@magic/domain";
import { examKind } from "../../../learning/src/analytics/references";
import { courseInclusion } from "../access";
import { isPipelineStore } from "../graph/course-index";
import { codeAssignmentKind } from "../queries";
import { dayStart } from "../graph/agenda";

export type AgendaKind = "assignment" | "quiz" | "exam" | "discussion";
/** One open-or-done dated item as code sees it, before ranking. */
export interface AgendaFact {
  id: string;
  resourceId: string | null;
  kind: AgendaKind;
  title: string;
  accountScope: string;
  courseId: string;
  courseName: string;
  url: string | null;
  contentHash: string | null;
  dueAt: string | null;
  lockAt: string | null;
  unlockAt: string | null;
  points: number | null;
  /** Canvas group weight detail (FDB-001), or the syllabus's stated weight for an assessment. */
  grade: { basis: "listed" | "computed"; percent: number; source: "canvas_group" | "syllabus" } | null;
  /** Submitted, graded, excused or marked done: drops out. */
  done: boolean;
  /** Canvas's own missing flag. */
  canvasMissing: boolean;
  /** Canvas expects an online submission (so an empty one past due is missing). */
  needsSubmission: boolean;
  /** Inputs for the code estimate. */
  features: {
    questionCount: number | null;
    rubricCriteria: number;
    instructionChars: number;
  };
}
export interface CourseRow {
  accountScope: string;
  courseId: string;
  courseName: string;
  included: boolean;
}
export interface AgendaFacts {
  facts: AgendaFact[];
  courses: CourseRow[];
  sources: SourceHealth[];
}

const WORK_SCOPES = new Set(["assignments", "quizzes"]);
const doneStates = new Set(["submitted", "graded", "pending_review", "complete"]);
const noSubmission = new Set(["none", "not_graded", "on_paper", "external_tool"]);
const EXAM_ASSESSMENTS = new Set(["exam", "midterm", "final", "quiz"]);
/** "10 questions", "12-question quiz": a stated count, not a guess. */
const QUESTIONS = /\b(\d{1,3})[\s-]*(?:multiple[\s-]choice\s+)?questions?\b/i;

export function statedQuestionCount(text: string): number | null {
  const m = QUESTIONS.exec(text);
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n > 0 && n <= 200 ? n : null;
}

const scopeOf = (s: SourceHealth) => s.scope.split(":")[0]!;

/** A source's live resources: one source's rows on the pipeline store; a filtered full read otherwise. */
function reader(store: Store) {
  if (isPipelineStore(store)) return (source: SourceHealth) => store.sourceResources(source.id);
  let all: Resource[] | undefined;
  return (source: SourceHealth) => (all ??= store.resources()).filter((r) => r.sourceId === source.id && !r.deleted);
}

/**
 * Reads the agenda's facts. `course` limits the read to one course's sources (the background job).
 * Course inclusion reuses `courseInclusion` over only the course rows, so it can't drift from it.
 */
export function readAgendaFacts(
  store: Store,
  timeZone: string,
  course?: { accountScope: string; courseId: string },
  sources: SourceHealth[] = store.sources(),
): AgendaFacts {
  const read = reader(store);
  const inCourse = (s: SourceHealth) => !course || (s.accountScope === course.accountScope && s.courseId === course.courseId);
  const courseSources = sources.filter((s) => s.scope === "course" && inCourse(s));
  const courseResources = courseSources.flatMap(read);
  // courseInclusion reads the settings for every resource it checks; one read serves this pass.
  const settings = store.ingestionSettings();
  const narrowed = Object.create(store, {
    resources: { value: () => courseResources },
    sources: { value: () => sources },
    ingestionSettings: { value: () => settings },
  }) as Store;
  const included = courseInclusion(narrowed);
  const byId = new Map(sources.map((s) => [s.id, s]));

  const courses = new Map<string, CourseRow>();
  for (const r of courseResources) {
    const s = byId.get(r.sourceId)!;
    courses.set(`${s.accountScope}\n${r.courseId}`, { accountScope: s.accountScope, courseId: r.courseId, courseName: r.courseName, included: included(r) });
  }

  const work: (Resource & { source: SourceHealth })[] = [];
  const groups: GradeShareResource[] = [];
  const complete = new Set<string>();
  for (const s of sources) {
    if (!inCourse(s)) continue;
    const scope = scopeOf(s);
    if (scope === "assignment-groups") {
      for (const g of read(s)) groups.push({ ...g, accountScope: s.accountScope });
    } else if (WORK_SCOPES.has(scope)) {
      // Coverage for a computed grade share: a complete, successful assignments read.
      if (scope === "assignments" && s.complete && s.status === "ok") complete.add(`${s.accountScope}\n${s.courseId}`);
      for (const r of read(s)) work.push({ ...r, source: s });
    }
  }
  const courseRow = (accountScope: string, courseId: string, fallbackName: string): CourseRow =>
    courses.get(`${accountScope}\n${courseId}`) ?? { accountScope, courseId, courseName: fallbackName, included: true };

  const share = gradeShareDetail(
    [...groups, ...work.map((r) => ({ ...r, accountScope: r.source.accountScope }))],
    { complete: (accountScope, courseId) => complete.has(`${accountScope ?? ""}\n${courseId}`) },
  );
  const assessments = (store as Store & { assessments?: () => Assessment[] }).assessments?.() ?? [];
  const assessmentOf = new Map(assessments.filter((a) => a.resourceId).map((a) => [a.resourceId!, a]));

  const facts: AgendaFact[] = [];
  const seen = new Map<string, AgendaFact>();
  for (const r of work) {
    const row = courseRow(r.source.accountScope, r.courseId, r.courseName);
    if (!included(r)) continue;
    const quizScope = scopeOf(r.source) === "quizzes";
    const exact = codeAssignmentKind(r);
    const exam = examKind(r.title, r.submissionTypes ?? []);
    const stated = assessmentOf.get(r.id);
    const kind: AgendaKind =
      (exam && exam !== "quiz") || (stated && EXAM_ASSESSMENTS.has(stated.kind) && stated.kind !== "quiz")
        ? "exam"
        : exact === "quiz" || quizScope || exam === "quiz"
          ? "quiz"
          : exact === "discussion"
            ? "discussion"
            : "assignment";
    const due = r.dueAt ?? r.deadlines.find((d) => d.kind === "due")?.value ?? null;
    const sub = r.submission;
    const detail: GradeShareDetail = share({ ...r, accountScope: r.source.accountScope });
    const fact: AgendaFact = {
      id: r.id,
      resourceId: r.id,
      kind,
      title: r.title,
      accountScope: r.source.accountScope,
      courseId: r.courseId,
      courseName: row.courseName,
      url: r.url,
      contentHash: r.contentHash,
      dueAt: due,
      lockAt: r.lockAt ?? null,
      unlockAt: r.unlockAt ?? null,
      points: r.points ?? null,
      grade:
        detail.basis !== "unknown"
          ? { basis: detail.basis, percent: detail.percent!, source: "canvas_group" }
          : stated?.weight != null
            ? { basis: "listed", percent: stated.weight, source: "syllabus" }
            : null,
      done:
        r.submitted === true || r.completed || !!sub?.submittedAt || doneStates.has(sub?.workflowState ?? "") || sub?.excused === true,
      canvasMissing: sub?.missing === true,
      needsSubmission: (r.submissionTypes ?? []).some((t) => !noSubmission.has(t)),
      features: {
        questionCount: kind === "quiz" ? statedQuestionCount(r.text) : null,
        rubricCriteria: r.rubric?.length ?? 0,
        instructionChars: r.text.length,
      },
    };
    // A quiz listed both as a quiz and as its assignment is one item: the assignment row wins.
    const key = `${fact.accountScope}\n${fact.courseId}\n${fact.title.trim().toLowerCase()}\n${fact.dueAt ?? ""}`;
    const had = seen.get(key);
    if (had) {
      if (quizScope) continue;
      facts.splice(facts.indexOf(had), 1);
    }
    seen.set(key, fact);
    facts.push(fact);
  }

  // Exams named only in the syllabus (a stored assessment with no captured Canvas item).
  const captured = new Set(facts.map((f) => f.resourceId));
  for (const a of assessments) {
    if (!a.date || !EXAM_ASSESSMENTS.has(a.kind) || (a.resourceId && captured.has(a.resourceId))) continue;
    if (course && (a.accountScope !== course.accountScope || a.courseId !== course.courseId)) continue;
    const row = courseRow(a.accountScope, a.courseId, a.courseId);
    if (!row.included) continue;
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(a.date);
    facts.push({
      id: `assessment:${a.id}`,
      resourceId: null,
      kind: a.kind === "quiz" ? "quiz" : "exam",
      title: a.title,
      accountScope: a.accountScope,
      courseId: a.courseId,
      courseName: row.courseName,
      url: null,
      contentHash: null,
      // A date-only exam is placed at the start of that local day: the earliest it could be.
      dueAt: dateOnly ? new Date(dayStart(a.date, timeZone)).toISOString() : a.date,
      lockAt: null,
      unlockAt: null,
      points: null,
      grade: a.weight != null ? { basis: "listed", percent: a.weight, source: "syllabus" } : null,
      done: false,
      canvasMissing: false,
      needsSubmission: false,
      features: { questionCount: null, rubricCriteria: 0, instructionChars: 0 },
    });
  }
  return { facts, courses: [...courses.values()], sources };
}
