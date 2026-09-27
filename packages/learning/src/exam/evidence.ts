/**
 * The exam evidence port (owner: exam-prep): what the blueprint reads about one assessment, as
 * plain data. `createExamEvidence` is the adapter over the coursework store (Store and
 * CourseCoreStore satisfy `ExamEvidenceSources`); the router builds one per request. Every read
 * is synchronous, code-only, and stays inside the named account scope and course.
 */
import type {
  Assessment,
  AssessmentScope,
  CourseBrief,
  MapLink,
  MaterialFact,
  Resource,
  SourceHealth,
} from "@magic/contracts";
import { resolveDeadline } from "@magic/domain";
import { examKind } from "../analytics/references";

export interface ExamAssessment {
  id: string;
  title: string;
  kind: string;
  /** ISO date or instant; null when no date is known (never invented). */
  date: string | null;
  /** Percent of the course grade, when stated. */
  weight: number | null;
  /** A stated format ("75 minutes, multiple choice and short answer"), as recorded. */
  format: string | null;
  resourceId: string | null;
  origin: string;
}

export interface ExamMaterial {
  id: string;
  title: string;
  kind: Resource["kind"];
  text: string;
  contentHash: string;
  /** The material pipeline's role fact (syllabus, lecture, exam, solutions, …), when analysed. */
  role: string | null;
  moduleTitles: string[];
  /** `covers` fact values: an assessment ID, or the phrase the material states. */
  covers: string[];
  /** Graded work: a Canvas assignment or quiz. Never a source of practice problems. */
  graded: boolean;
  createdAt: string | null;
}

export interface ExamEvidence {
  courseId: string;
  termName: string | null;
  assessment: ExamAssessment;
  /** Every assessment in the course, for the schedule window. */
  assessments: ExamAssessment[];
  scopes: {
    stated: string;
    evidence: { resourceId: string; quote: string; start: number; end: number } | null;
    windowStart: string | null;
    windowEnd: string | null;
    status: string;
  }[];
  /** The syllabus brief's row for this assessment, when one matches by title. */
  brief: {
    syllabusResourceId: string;
    title: string;
    weight: number | null;
    scope: string | null;
    quote: string;
    start: number;
    end: number;
  } | null;
  materials: ExamMaterial[];
  /** Course-map links from this assessment (practice, covers, reading), current and not rejected. */
  links: { resourceId: string; kind: string; tier: string; reason: string }[];
}

export interface ExamEvidencePort {
  /** The course's exams and quizzes, as the blueprint can name them. */
  assessments(accountScope: string, courseId: string): ExamAssessment[];
  /** The evidence for one assessment (a course-map assessment ID or its Canvas resource ID); null when unknown in this course. */
  evidence(accountScope: string, courseId: string, assessmentId: string): ExamEvidence | null;
  /** The course's documents with their roles, for problems outside any one assessment. */
  materials(accountScope: string, courseId: string): ExamMaterial[];
}

/** The parts of the coursework store the adapter reads. */
export interface ExamEvidenceSources {
  resources(): Resource[];
  sources(): SourceHealth[];
  /** One course's live resources, filtered in SQL (the Store's graph read); preferred over a full `resources()` scan. */
  courseResources?(course: { accountScope: string; courseId: string }): Resource[];
  assessments?(course?: { accountScope: string; courseId: string }): Assessment[];
  assessmentScopes?(assessmentId: string): AssessmentScope[];
  courseBrief?(course: { accountScope: string; courseId: string }): CourseBrief | undefined;
  materialFacts?(resourceId: string): MaterialFact[];
  mapLinks?(course?: { accountScope: string; courseId: string }): MapLink[];
}

const EXAM_LIKE = new Set(["exam", "midterm", "final", "quiz"]);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** "Midterm 1" / "Exam #2" / "Final": the kind word and number a title names, for matching two records. */
export function assessmentKey(title: string): string | null {
  const m = /\b(midterm|mid term|exam|test|quiz|final)\b\s*#?\s*(\d{1,2}|i{1,3}|iv)?\b/i.exec(title);
  if (!m) return null;
  const roman: Record<string, string> = { i: "1", ii: "2", iii: "3", iv: "4" };
  const word = m[1]!.toLowerCase().replace(/\s+/, "");
  const n = m[2] ? (roman[m[2].toLowerCase()] ?? m[2]) : "";
  return `${word === "test" ? "exam" : word}${n ? ` ${n}` : ""}`;
}

function assignmentDate(r: Resource): string | null {
  const due = resolveDeadline(r.deadlines);
  if (!due.conflict && due.dueAt) return due.dueAt;
  return r.dueAt ?? null;
}

export function createExamEvidence(src: ExamEvidenceSources): ExamEvidencePort {
  function courseResources(accountScope: string, courseId: string): Resource[] {
    if (src.courseResources) return src.courseResources({ accountScope, courseId }).filter((r) => !r.deleted && r.courseId === courseId);
    const sources = new Map(src.sources().map((s) => [s.id, s]));
    return src
      .resources()
      .filter((r) => !r.deleted && r.courseId === courseId && sources.get(r.sourceId)?.accountScope === accountScope);
  }
  function assessments(accountScope: string, courseId: string, loaded?: Resource[]): ExamAssessment[] {
    const course = { accountScope, courseId };
    const mapped = (src.assessments?.(course) ?? [])
      .filter((a) => a.accountScope === accountScope && a.courseId === courseId && EXAM_LIKE.has(a.kind))
      .map((a): ExamAssessment => ({
        id: a.id,
        title: a.title,
        kind: a.kind,
        date: a.date,
        weight: a.weight,
        format: a.format,
        resourceId: a.resourceId,
        origin: a.origin,
      }));
    const known = new Set(mapped.flatMap((a) => (a.resourceId ? [a.resourceId] : [])));
    const keys = new Set(mapped.flatMap((a) => assessmentKey(a.title) ?? []));
    // Canvas exams and quizzes the course map hasn't named yet: dated by code, never guessed.
    const canvas = (loaded ?? courseResources(accountScope, courseId))
      .filter((r) => r.kind === "assignment" && !known.has(r.id))
      .flatMap((r): ExamAssessment[] => {
        const kind = examKind(r.title, r.submissionTypes ?? []);
        const key = assessmentKey(r.title);
        if (!kind || (key && keys.has(key))) return [];
        return [{ id: r.id, title: r.title, kind, date: assignmentDate(r), weight: null, format: null, resourceId: r.id, origin: "canvas" }];
      });
    return [...mapped, ...canvas].sort(
      (a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999") || a.title.localeCompare(b.title),
    );
  }
  function materials(accountScope: string, courseId: string, loaded?: Resource[]): ExamMaterial[] {
    return (loaded ?? courseResources(accountScope, courseId))
      .filter((r) => r.kind === "material" || r.kind === "assignment" || r.kind === "course")
      .map((r): ExamMaterial => {
        // The pipeline replaces a resource's facts when its text changes, so the stored set is current.
        const facts = src.materialFacts?.(r.id) ?? [];
        return {
          id: r.id,
          title: r.title,
          kind: r.kind,
          text: r.text,
          contentHash: r.contentHash,
          role: facts.find((f) => f.kind === "role")?.value ?? null,
          moduleTitles: facts.filter((f) => f.kind === "module").map((f) => f.quote ?? f.value),
          covers: facts.filter((f) => f.kind === "covers").map((f) => f.value),
          graded: r.kind === "assignment",
          createdAt: r.createdAt ?? null,
        };
      });
  }
  return {
    assessments: (accountScope, courseId) => assessments(accountScope, courseId),
    materials: (accountScope, courseId) => materials(accountScope, courseId),
    evidence(accountScope, courseId, assessmentId) {
      // One course read per call, shared by the schedule, the term and the materials.
      const resources = courseResources(accountScope, courseId);
      const all = assessments(accountScope, courseId, resources);
      const assessment = all.find((a) => a.id === assessmentId || a.resourceId === assessmentId);
      if (!assessment) return null;
      const termName = resources.find((r) => r.course?.termName)?.course?.termName ?? null;
      const scopes = (src.assessmentScopes?.(assessment.id) ?? [])
        .filter((s) => s.status !== "flagged")
        .map((s) => ({
          stated: s.stated,
          evidence: s.evidence ? { resourceId: s.evidence.resourceId, quote: s.evidence.quote, start: s.evidence.start, end: s.evidence.end } : null,
          windowStart: s.windowStart,
          windowEnd: s.windowEnd,
          status: s.status,
        }));
      const briefRecord = src.courseBrief?.({ accountScope, courseId });
      const key = assessmentKey(assessment.title);
      const row = briefRecord?.brief.assessments.find(
        (a) => norm(a.title) === norm(assessment.title) || (!!key && assessmentKey(a.title) === key),
      );
      const brief =
        briefRecord && row
          ? {
              syllabusResourceId: briefRecord.syllabusResourceId,
              title: row.title,
              weight: row.weight,
              scope: row.scope,
              quote: row.quote,
              start: row.start,
              end: row.end,
            }
          : null;
      const docs = materials(accountScope, courseId, resources);
      const links = (src.mapLinks?.({ accountScope, courseId }) ?? [])
        .filter(
          (l) =>
            l.current &&
            l.status !== "rejected" &&
            l.fromKind === "assessment" &&
            (l.fromId === assessment.id || (!!assessment.resourceId && l.fromId === assessment.resourceId)),
        )
        .map((l) => ({ resourceId: l.toResourceId, kind: l.kind, tier: l.tier, reason: l.reason }));
      return { courseId, termName, assessment, assessments: all, scopes, brief, materials: docs, links };
    },
  };
}
