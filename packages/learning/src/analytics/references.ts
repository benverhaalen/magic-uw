// The assignment → references graph behind practice analytics, as a small port. The pipeline's
// `references(assignmentId)` and material coverage (feat/material-pipeline) replace the adapter
// below without touching the rollups. Every link carries the reason code found it.
import type { Assessment, Link, MapLink, Resource } from "@magic/contracts";
import { resolveDeadline } from "@magic/domain";
import type { ExamRef } from "../router-types";

export interface MaterialLink {
  resourceId: string;
  title: string;
  reason: string;
}

export interface AssessmentLink {
  assessmentId: string;
  title: string;
  /** `assignment`: graded work that is not an exam or quiz. */
  kind: ExamRef["kind"] | "assignment";
}

export interface ExamDate {
  assessmentId: string;
  title: string;
  kind: ExamRef["kind"];
  /** Null: no date is known; never invented. */
  at: string | null;
  dateSource: ExamRef["dateSource"];
  /** The captured resource the exam is, when there is one. */
  resourceId: string | null;
}

export interface ReferencesPort {
  /** The assignment (or exam) as captured, or null when unknown. */
  assignment(assignmentId: string): { id: string; title: string; courseId: string } | null;
  /** The materials an assignment or exam references. */
  references(assignmentId: string): MaterialLink[];
  /** The assignments and exams a material serves. */
  assessmentsFor(materialId: string): AssessmentLink[];
  /** The course's exams and quizzes, dated where code can date them. */
  examDates(courseId: string): ExamDate[];
}

/** The parts of the coursework store the current adapter reads (Store & CourseCoreStore satisfy it). */
export interface CurrentReferenceSources {
  resources(): Resource[];
  links?(): Link[];
  assessments?(): Assessment[];
  mapLinks?(): MapLink[];
}

const EXAM_KINDS = new Set<ExamRef["kind"]>(["exam", "midterm", "final", "quiz"]);
const NOT_AN_EXAM =
  /\b(practice|review|solutions?|sample|study guide|prep|makeup|make-up|conflict|accommodations?|regrade|re-grade|topics|info|information|reflection|corrections?|wrapper)\b/i;

/** The exam kind a title names, or null. Code-only; conservative on purpose. */
export function examKind(title: string, submissionTypes: string[] = []): ExamRef["kind"] | null {
  if (NOT_AN_EXAM.test(title)) return null;
  if (/\bfinal exam(ination)?\b/i.test(title)) return "final";
  if (/\bmid-?term\b/i.test(title)) return "midterm";
  if (/\bexam(ination)?\b/i.test(title)) return "exam";
  if (/\bquiz\b/i.test(title) || submissionTypes.includes("online_quiz")) return "quiz";
  return null;
}

/** A comparable key for a Canvas or web URL: host and path, without query, hash, `/download` or `/preview`. */
export function urlKey(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  let path = decodeURIComponent(u.pathname)
    .replace(/\/(download|preview)$/i, "")
    .replace(/\/+$/, "")
    .replace(/\/wiki\//, "/pages/");
  path = path.replace(/^(\/courses\/[^/]+\/files\/\d+).*$/, "$1");
  return `${u.host.toLowerCase().replace(/^www\./, "")}${path.toLowerCase()}`;
}

const linkUrl = (l: NonNullable<Resource["links"]>[number]) => (typeof l === "string" ? l : l.url);
const isModuleHeader = (r: Resource) => !!r.module && !r.moduleItem;
const LINKABLE = new Set<Resource["kind"]>(["material", "assignment"]);

/** Exam date for a Canvas assignment: its resolved due date, else the captured due field. */
function assignmentDate(r: Resource): string | null {
  const due = resolveDeadline(r.deadlines);
  if (!due.conflict && due.dueAt) return due.dueAt;
  return r.dueAt ?? null;
}

/**
 * The adapter over what exists today: an assignment's description links (resolved to captured
 * resources in the same course, through a module item to its page, file or assignment), stored
 * `links` that are not rejected, and current course-map links. Exam dates come from the course
 * map's assessments, Canvas assignments and quizzes, and calendar events. Build one per request.
 */
export function createCurrentReferences(src: CurrentReferenceSources): ReferencesPort {
  let built: ReturnType<typeof build> | null = null;
  const index = () => (built ??= build());

  function build() {
    const all = src.resources().filter((r) => !r.deleted);
    const byId = new Map(all.map((r) => [r.id, r]));
    const byUrl = new Map<string, Resource>();
    for (const r of all) {
      const key = `${r.courseId}|${urlKey(r.url) ?? ""}`;
      // A module item and its target can share nothing; the first captured resource wins a URL.
      if (!byUrl.has(key) || (byUrl.get(key)!.moduleItem && !r.moduleItem)) byUrl.set(key, r);
    }
    const links = (src.links?.() ?? []).filter((l) => l.status !== "rejected" && l.type !== "same_as");
    const assessments = src.assessments?.() ?? [];
    const mapLinks = (src.mapLinks?.() ?? []).filter((l) => l.current && l.status !== "rejected");
    return { all, byId, byUrl, links, assessments, mapLinks, refs: new Map<string, MaterialLink[]>(), served: new Map<string, Map<string, AssessmentLink[]>>() };
  }

  /** A module item's own target: its page, file, assignment or quiz, when captured. */
  function moduleTarget(item: Resource): Resource | null {
    const ix = index();
    const mi = item.moduleItem!;
    const base = urlKey(item.url)?.replace(/\/modules\/items\/[^/]+$/, "");
    if (!base) return null;
    const path =
      mi.type === "File" && mi.contentId
        ? `/files/${mi.contentId}`
        : mi.type === "Assignment" && mi.contentId
          ? `/assignments/${mi.contentId}`
          : mi.type === "Quiz" && mi.contentId
            ? `/quizzes/${mi.contentId}`
            : mi.type === "Page" && mi.pageUrl
              ? `/pages/${mi.pageUrl.toLowerCase()}`
              : null;
    return path ? (ix.byUrl.get(`${item.courseId}|${base}${path}`) ?? null) : null;
  }

  function references(assignmentId: string): MaterialLink[] {
    const ix = index();
    const cached = ix.refs.get(assignmentId);
    if (cached) return cached;
    const self = ix.byId.get(assignmentId);
    const out = new Map<string, MaterialLink>();
    const add = (r: Resource | null | undefined, reason: string) => {
      if (!r || r.id === assignmentId || out.has(r.id) || !LINKABLE.has(r.kind) || isModuleHeader(r)) return;
      if (self && r.courseId !== self.courseId) return;
      if (r.moduleItem) {
        const target = moduleTarget(r);
        if (target) return add(target, reason);
      }
      out.set(r.id, { resourceId: r.id, title: r.title, reason });
    };
    if (self) {
      if (self.kind === "assignment" && self.text.trim()) out.set(self.id, { resourceId: self.id, title: self.title, reason: "The assignment's own page." });
      for (const l of self.links ?? []) {
        const key = urlKey(linkUrl(l));
        if (key) add(ix.byUrl.get(`${self.courseId}|${key}`), "Linked in the description.");
      }
    }
    for (const l of ix.links) {
      if (l.fromId === assignmentId) add(ix.byId.get(l.toId), `Link (${l.type}): ${l.reason}`);
      else if (l.toId === assignmentId) add(ix.byId.get(l.fromId), `Link (${l.type}): ${l.reason}`);
    }
    const fromIds = new Set([assignmentId, ...ix.assessments.filter((a) => a.resourceId === assignmentId).map((a) => a.id)]);
    for (const l of ix.mapLinks) if (fromIds.has(l.fromId)) add(ix.byId.get(l.toResourceId), `Course map (${l.kind}): ${l.reason}`);
    const list = [...out.values()];
    ix.refs.set(assignmentId, list);
    return list;
  }

  function examDates(courseId: string): ExamDate[] {
    const ix = index();
    const rank = { assessment: 0, assignment: 1, calendar: 2 } as const;
    const out = new Map<string, ExamDate>();
    const put = (e: ExamDate) => {
      const key = `${e.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()}|${e.at?.slice(0, 10) ?? ""}`;
      const had = out.get(key);
      if (!had || rank[e.dateSource] < rank[had.dateSource]) out.set(key, e);
    };
    for (const a of ix.assessments)
      if (a.courseId === courseId && EXAM_KINDS.has(a.kind as ExamRef["kind"]))
        put({ assessmentId: a.id, title: a.title, kind: a.kind as ExamRef["kind"], at: a.date, dateSource: "assessment", resourceId: a.resourceId });
    for (const r of ix.all) {
      if (r.courseId !== courseId) continue;
      if (r.kind === "assignment") {
        const kind = examKind(r.title, r.submissionTypes ?? []);
        if (kind) put({ assessmentId: r.id, title: r.title, kind, at: assignmentDate(r), dateSource: "assignment", resourceId: r.id });
      } else if (r.kind === "event" && r.calendar?.start) {
        const kind = examKind(r.title);
        if (kind) put({ assessmentId: r.id, title: r.title, kind, at: r.calendar.start, dateSource: "calendar", resourceId: r.id });
      }
    }
    // Dated first, by date; undated last.
    const time = (e: ExamDate) => (e.at === null ? Infinity : Date.parse(e.at) || Infinity);
    return [...out.values()].sort((a, b) => time(a) - time(b) || (a.assessmentId < b.assessmentId ? -1 : 1));
  }

  function assessmentsFor(materialId: string): AssessmentLink[] {
    const ix = index();
    const material = ix.byId.get(materialId);
    if (!material) return [];
    let served = ix.served.get(material.courseId);
    if (!served) {
      served = new Map();
      const exams = examDates(material.courseId);
      const examByRef = new Map(exams.map((e) => [e.resourceId ?? e.assessmentId, e]));
      const subjects: AssessmentLink[] = [
        ...ix.all
          .filter((r) => r.courseId === material.courseId && r.kind === "assignment" && !examByRef.has(r.id))
          .map((r) => ({ assessmentId: r.id, title: r.title, kind: "assignment" as const })),
        ...exams.map((e) => ({ assessmentId: e.assessmentId, title: e.title, kind: e.kind })),
      ];
      for (const s of subjects) {
        const exam = exams.find((e) => e.assessmentId === s.assessmentId);
        // An exam's references: its captured resource's, and a map scope keyed to the assessment row itself.
        const ids = new Set(
          [exam?.resourceId ?? s.assessmentId, s.assessmentId].flatMap((id) => references(id).map((m) => m.resourceId)),
        );
        for (const id of ids) served.set(id, [...(served.get(id) ?? []), s]);
      }
      ix.served.set(material.courseId, served);
    }
    return served.get(materialId) ?? [];
  }

  function assignment(assignmentId: string) {
    const r = index().byId.get(assignmentId);
    return r ? { id: r.id, title: r.title, courseId: r.courseId } : null;
  }

  return { assignment, references, assessmentsFor, examDates };
}
