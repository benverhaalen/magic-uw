/**
 * owner: study-prep. What a work item is, decided by code, with the reason. Structural Canvas
 * signals first (quiz submission, discussion topic, points and grading type, module header, file
 * type, the material pipeline's role), then title patterns. A student's correction wins; their AI
 * types only the leftovers (one batched titles-only call). Corrections and AI answers are kept in
 * one learning artifact per course (no new table).
 */
import type { Assessment, MaterialFact, Resource } from "@magic/contracts";
import type { ItemType } from "@magic/contracts";
import type { ArtifactKind, LearningStore } from "../../../learning/src/store";
import { sha } from "./scope-hash";

export interface TypeDecision {
  type: ItemType | null;
  reason: string;
  basis: "code" | "student" | "ai" | "default";
}

const TITLE: [RegExp, ItemType, string][] = [
  [/\b(?:mid-?terms?|final exam|finals?\b(?!\s*(?:project|paper|report|presentation|draft))|exam(?:ination)?s?\b|test\s*#?\d)/i, "exam", "exam"],
  [/\bquiz(?:zes)?\b/i, "quiz", "quiz"],
  [/\b(?:attendance|participation|clicker|iclicker|top ?hat|sign-?in|check-?in)\b/i, "participation", "participation"],
  [/\b(?:discussion|forum|discussion post|reply to)\b/i, "discussion_post", "discussion"],
  [/\b(?:pre-?lab|post-?lab|lab(?:oratory)?\s*(?:report|#?\d|\b))/i, "lab", "lab"],
  [/\b(?:essay|paper|reflection|response paper|memo|op-?ed|thesis|annotated bibliography|literature review|close reading)\b/i, "essay", "essay"],
  [/\b(?:presentation|pitch|poster|slide deck|talk)\b/i, "presentation", "presentation"],
  [/\b(?:project|milestone|proposal|deliverable|capstone|prototype|design review)\b/i, "project", "project"],
  [/\b(?:problem sets?|psets?|homework|hw\s*#?\d|hw\b|exercises?|worksheet|problems?\s*#?\d|assignment\s*#?\d)\b/i, "problem_set", "homework"],
  [/\b(?:reading|chapter|ch\.\s*\d|article|textbook)\b/i, "reading", "reading"],
  [/\b(?:lecture|lec\s*#?\d|slides?|notes)\b/i, "lecture", "lecture"],
];
const MODULE: [RegExp, ItemType][] = [
  [/\b(?:exams?|midterms?)\b/i, "exam"],
  [/\bquiz(?:zes)?\b/i, "quiz"],
  [/\blabs?\b/i, "lab"],
  [/\b(?:problem sets?|homeworks?|psets?)\b/i, "problem_set"],
  [/\b(?:essays?|papers?|writing)\b/i, "essay"],
  [/\bprojects?\b/i, "project"],
  [/\bdiscussions?\b/i, "discussion_post"],
  [/\breadings?\b/i, "reading"],
  [/\blectures?\b/i, "lecture"],
];
const ASSESSMENT_KIND: Partial<Record<Assessment["kind"], ItemType>> = {
  exam: "exam", midterm: "exam", final: "exam", quiz: "quiz", project: "project", paper: "essay", lab: "lab", homework: "problem_set", presentation: "presentation", participation: "participation",
};
const ROLE: Record<string, ItemType | undefined> = { lecture: "lecture", reading: "reading", lab: "lab", exam: "exam", homework: "problem_set" };

const first = <T,>(rules: [RegExp, T, ...unknown[]][], text: string) => rules.find(([re]) => re.test(text));

/** Code's type for a work item, or null when nothing decides it (then the AI or the default). */
export function codeType(input: { assessment?: Pick<Assessment, "kind" | "title"> | null; resource?: Resource | null; facts?: MaterialFact[]; moduleTitle?: string | null }): TypeDecision {
  const { assessment, resource: r } = input;
  const title = r?.title ?? assessment?.title ?? "";
  if (assessment && ASSESSMENT_KIND[assessment.kind]) return { type: ASSESSMENT_KIND[assessment.kind]!, reason: `The course map lists it as a ${assessment.kind}`, basis: "code" };
  if (r) {
    const subs = (r.submissionTypes ?? []).map((s) => s.toLowerCase());
    const item = r.moduleItem?.type?.toLowerCase() ?? "";
    if (subs.includes("online_quiz") || item === "quiz")
      return /\b(?:mid-?term|final|exam)\b/i.test(title) ? { type: "exam", reason: "A Canvas quiz named as an exam", basis: "code" } : { type: "quiz", reason: "A Canvas quiz", basis: "code" };
    if (subs.includes("discussion_topic") || item === "discussion") return { type: "discussion_post", reason: "A Canvas discussion", basis: "code" };
    if (r.kind === "assignment" && (subs.includes("not_graded") || (r.points === 0 && (subs.includes("none") || subs.includes("on_paper") || !subs.length))) && !first(TITLE, title))
      return { type: "participation", reason: "Ungraded, with nothing to submit", basis: "code" };
    const role = input.facts?.find((f) => f.kind === "role")?.value;
    if (r.kind === "material" && role && ROLE[role]) return { type: ROLE[role]!, reason: `The course materials call it a ${role}`, basis: "code" };
  }
  const t = first(TITLE, title);
  if (t) return { type: t[1], reason: `Its title says ${t[2]}`, basis: "code" };
  if (input.moduleTitle) {
    const m = first(MODULE, input.moduleTitle);
    if (m) return { type: m[1], reason: `It sits in the module "${input.moduleTitle}"`, basis: "code" };
  }
  if (r) {
    const role = input.facts?.find((f) => f.kind === "role")?.value;
    if (role && ROLE[role]) return { type: ROLE[role]!, reason: `The course materials call it ${role}`, basis: "code" };
    if (r.kind === "material") {
      const ct = r.contentType ?? "";
      if (/presentation|powerpoint|pptx?|keynote/i.test(ct) || /\.pptx?\b/i.test(r.url)) return { type: "lecture", reason: "A slide file", basis: "code" };
      return { type: "reading", reason: "Course material", basis: "code" };
    }
    if (r.kind === "event") return { type: "participation", reason: "A calendar event", basis: "code" };
  }
  return { type: null, reason: "Nothing in Canvas or the title decides it", basis: "code" };
}

// ---------- The student's corrections and the AI's answers, per course ----------
export interface TypeRecord {
  type: ItemType;
  reason: string;
  basis: "student" | "ai";
  at: string;
}
const key = (courseRef: string) => `study-item-types-v1-${sha(courseRef).slice(0, 40)}`;
export function readTypes(learning: LearningStore, courseRef: string): Record<string, TypeRecord> {
  const body = learning.artifact(key(courseRef))?.body as { items?: Record<string, TypeRecord> } | undefined;
  return body?.items && typeof body.items === "object" ? body.items : {};
}
export function writeTypes(learning: LearningStore, courseRef: string, add: Record<string, TypeRecord>, at: string): void {
  const items = { ...readTypes(learning, courseRef) };
  // A student's answer is never replaced by the AI's.
  for (const [id, rec] of Object.entries(add)) if (!(items[id]?.basis === "student" && rec.basis === "ai")) items[id] = rec;
  learning.putArtifact({
    id: key(courseRef), courseRef, kind: "pack" as ArtifactKind, scope: { pointer: "study-item-types" }, cacheKey: key(courseRef),
    body: { v: 1, items }, removedCount: 0, status: "ready", generator: null, pack: "study-item-types", packVersion: "v1", createdAt: at, sources: [],
  });
}

/** The decision shown: the student's, then code's, then the AI's, then a default by what it is. */
export function decideType(code: TypeDecision, stored: TypeRecord | undefined, fallback: ItemType): TypeDecision & { type: ItemType } {
  if (stored?.basis === "student") return { type: stored.type, reason: "You set this", basis: "student" };
  if (code.type) return { ...code, type: code.type };
  if (stored?.basis === "ai") return { type: stored.type, reason: stored.reason, basis: "ai" };
  return { type: fallback, reason: code.reason, basis: "default" };
}
