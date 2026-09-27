/**
 * owner: study-prep. What one assessment covers, as Study prepper's Sources panel shows it, and
 * the student's selection of it. Code only, local reads only, 0 tokens.
 *
 * Coverage comes from the exam blueprint (N15: stated scope with its quote, the syllabus row, the
 * schedule window, the course map) plus the course's own links: materials linked to the
 * assessment or naming it in a `covers` fact, materials under the modules and topics in scope,
 * the instructor's practice exams, review sheets and solutions for it, and past-due homework in
 * its window. Only eligible study sources count (the same rule as every pack). When nothing ties
 * a material to the assessment, every eligible material in the course is a source, and the
 * overview says so.
 */
import { createHash } from "node:crypto";
import type { CourseCoreStore, MaterialFact, Resource, Store, StudyPrepQuote, StudyPrepScopeItem, StudyPrepSource, StudyPrepSourceRole } from "@magic/contracts";
import { resolveDeadline } from "@magic/domain";
import { effectiveCoursePolicy } from "../../../domain/src/course-intelligence";
import type { LearningStore, Concept } from "../../../learning/src/store";
import { eligibleStudySource } from "../../../learning/src/router";
import { createExamEvidence, assessmentKey, type ExamEvidence } from "../../../learning/src/exam/evidence";
import { classifyDocs, deriveBlueprint, type ClassifiedDoc } from "../../../learning/src/exam/blueprint";
import type { ExamBlueprint } from "../../../learning/src/exam/types";
import { examKind } from "../../../learning/src/analytics/references";
import { courseInclusion } from "../access";

export type PrepStore = Store &
  CourseCoreStore & {
    learning: LearningStore;
    courseResources?(course: { accountScope: string; courseId: string }): Resource[];
    resourceRefs?(fromResourceId: string): { toResourceId: string | null }[];
  };

export const isPrepStore = (store: Store): store is PrepStore => {
  const s = store as Partial<PrepStore>;
  return typeof s.learning === "object" && s.learning !== null && typeof s.assessments === "function" && typeof s.passage === "function" && typeof s.materialFacts === "function";
};

export const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

export interface PrepSource extends StudyPrepSource {
  resource: Resource;
}
export interface Prep {
  accountScope: string;
  courseId: string;
  courseRef: string;
  label: string;
  evidence: ExamEvidence;
  blueprint: ExamBlueprint;
  docs: ClassifiedDoc[];
  /** Eligible study sources in the assessment's coverage, course order. */
  sources: PrepSource[];
  items: StudyPrepScopeItem[];
  /** Whether coverage fell back to the whole course. */
  wholeCourse: boolean;
  concepts: Concept[];
  topics: { id: string; label: string; moduleId: string | null }[];
  facts: (id: string) => MaterialFact[];
  restricted: boolean;
  policy: { mode: string; evidence: string } | undefined;
  /** Course resources the study resolver accepts as anchors. */
  anchorIds: string[];
  where: StudyPrepQuote | null;
  resourceById: Map<string, Resource>;
}

/** The course's account scope, as the pack handler decides it (the first scope with this course). */
export function courseScope(store: Store, courseId: string): string | null {
  return store.sources().filter((s) => s.courseId === courseId).map((s) => s.accountScope).sort()[0] ?? null;
}

const ROLE_WORDS: [RegExp, StudyPrepSourceRole][] = [
  [/\bsyllabus\b/i, "syllabus"],
  [/\b(?:solutions?|solns?|answer key)\b/i, "solutions"],
  [/\bslides?\b|\.pptx?\b|\bdeck\b/i, "slides"],
  [/\b(?:lecture|lec)\b/i, "lecture"],
  [/\b(?:reading|chapter|textbook|notes)\b/i, "reading"],
];
function roleOf(r: Resource, fact: string | null, doc: ClassifiedDoc | undefined, syllabusId: string | null): StudyPrepSourceRole {
  if (r.id === syllabusId || fact === "syllabus") return "syllabus";
  if (doc) return doc.kind === "exam_info" ? "review_sheet" : doc.kind;
  if (r.kind === "assignment") return "homework";
  if (fact === "solutions") return "solutions";
  if (fact === "lecture") return "lecture";
  if (fact === "reading") return "reading";
  for (const [re, role] of ROLE_WORDS) if (re.test(r.title)) return role;
  return "other";
}

/**
 * "Room 1100", "held in Synthetic Hall": a location the course states, with its quote. The
 * assessment's own record is read first; in the syllabus only a line naming the assessment counts,
 * so another exam's room is never shown. A stated room wins over "in class".
 */
const WHERE = /\b(?:room|location|held in|takes place in|will be in)\b\s*[:\-]?\s*([A-Z0-9][^.\n;]{1,60})/i;
const IN_CLASS = /\bin[- ]class\b/i;
function whereOf(candidates: { r: Resource | undefined; about: string | null }[]): StudyPrepQuote | null {
  const spans = candidates.flatMap(({ r, about }) => {
    if (!r) return [];
    let offset = 0;
    return r.text.split("\n").flatMap((line) => {
      const at = offset;
      offset += line.length + 1;
      return !about || norm(line).includes(about) ? [{ r, line, at }] : [];
    });
  });
  for (const re of [WHERE, IN_CLASS])
    for (const { r, line, at } of spans) {
      const m = re.exec(line);
      if (!m) continue;
      const quote = m[0].trim();
      return { resourceId: r.id, title: r.title, url: r.url, quote, start: at + m.index, end: at + m.index + quote.length };
    }
  return null;
}

const SYLLABUS_TITLE = /\bsyllabus\b/i;
const ROLE_ORDER: StudyPrepSourceRole[] = ["lecture", "slides", "reading", "other", "homework", "review_sheet", "practice_exam", "solutions", "past_exam", "syllabus"];

/**
 * Everything the query and generation need about one assessment. Reads the course's resources
 * once (SQL-filtered when the store can), and each material's facts once.
 */
export function loadPrep(store: PrepStore, courseId: string, assessmentId: string, now: Date): Prep | { status: "missing" | "empty"; message: string } {
  const accountScope = courseScope(store, courseId);
  if (!accountScope) return { status: "empty", message: "This course has no saved material yet." };
  const course = { accountScope, courseId };
  const sources = new Map(store.sources().map((s) => [s.id, s]));
  const resources = (store.courseResources ? store.courseResources(course) : store.resources())
    .filter((r) => !r.deleted && r.courseId === courseId && sources.get(r.sourceId)?.accountScope === accountScope);
  const factMemo = new Map<string, MaterialFact[]>();
  const facts = (id: string) => {
    let f = factMemo.get(id);
    if (!f) factMemo.set(id, (f = store.materialFacts(id)));
    return f;
  };
  const port = createExamEvidence({
    resources: () => resources,
    sources: () => store.sources(),
    courseResources: () => resources,
    assessments: (c) => store.assessments(c),
    assessmentScopes: (id) => store.assessmentScopes(id),
    courseBrief: (c) => store.courseBrief(c),
    materialFacts: facts,
    mapLinks: (c) => store.mapLinks(c),
  });
  const evidence = port.evidence(accountScope, courseId, assessmentId);
  if (!evidence) return { status: "missing", message: "That exam or quiz isn't on this course's map yet." };
  const courseRef = `${accountScope}:${courseId}`;
  const label = resources.find((r) => r.courseName)?.courseName ?? courseId;

  // The course map: topics under their modules (units).
  const concepts = store.learning.concepts(courseRef).filter((c) => c.status === "active");
  const units = concepts.filter((c) => c.kind === "unit").sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const nameOf = (c: Concept) => c.studentLabel ?? c.label;
  const unitOf = (c: Concept) => units.find((u) => u.id === c.parentId) ?? null;
  const allTopics = concepts
    .filter((c) => c.kind === "concept")
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
    .map((c) => ({ c, id: c.id, label: nameOf(c), moduleId: unitOf(c)?.id ?? null, moduleLabel: unitOf(c) ? nameOf(unitOf(c)!) : null }));
  const blueprint = deriveBlueprint({
    evidence,
    topics: allTopics.map(({ id, label, moduleId, moduleLabel }) => ({ id, label, moduleId, moduleLabel })),
    modules: units.map((u) => ({ id: u.id, label: nameOf(u) })),
    coverage: store.learning.coverage(evidence.assessment.id),
    now,
  });
  const docs = classifyDocs(evidence, now);

  // Policy: a restriction anywhere in the course blocks AI-made practice (as every pack).
  const intelligence = store
    .courseIntelligence()
    .filter((ci) => ci.accountScope === accountScope && ci.courseId === courseId)
    .sort((a, b) => b.version - a.version)[0];
  const policies = resources.map((r) => effectiveCoursePolicy(intelligence, r));
  const restricted = policies.some((p) => p.mode === "restricted");

  const included = courseInclusion(store, resources);
  const at = now.getTime();
  const eligible = resources.filter((r) => included(r) && eligibleStudySource(r, at) && r.text.trim().length > 0);
  const eligibleIds = new Set(eligible.map((r) => r.id));
  const byId = new Map(resources.map((r) => [r.id, r]));
  const a = evidence.assessment;
  // The syllabus: the course brief's, else the material the pipeline or its title calls one.
  const syllabusId =
    evidence.brief?.syllabusResourceId ??
    resources.find((r) => r.kind === "material" && facts(r.id).some((f) => f.kind === "role" && f.value === "syllabus"))?.id ??
    resources.find((r) => r.kind === "material" && SYLLABUS_TITLE.test(r.title))?.id ??
    null;

  // Coverage, with the reason code found for each resource (first reason wins).
  const reasons = new Map<string, string>();
  const add = (id: string, reason: string) => {
    if (eligibleIds.has(id) && id !== syllabusId && id !== a.resourceId && !reasons.has(id)) reasons.set(id, reason);
  };
  for (const l of evidence.links) add(l.resourceId, l.reason || `Linked to ${a.title} on the course map`);
  for (const m of evidence.materials) if (m.covers.includes(a.id) || (!!a.resourceId && m.covers.includes(a.resourceId))) add(m.id, `States that it covers ${a.title}`);
  for (const d of docs) if (d.relevance >= 1 && d.kind !== "past_exam") add(d.material.id, d.kind === "solutions" ? `Solutions for ${a.title}` : d.kind === "review_sheet" ? `Review sheet for ${a.title}` : d.kind === "exam_info" ? `About ${a.title}` : `Practice exam for ${a.title}`);
  const scopeTopicIds = new Set(blueprint.scope.basis === "none" ? [] : blueprint.scope.concepts.map((c) => c.conceptId));
  const scopeModules = new Set(blueprint.scope.modules.map((m) => norm(m.label)));
  const moduleLabelOf = (r: Resource): string | null => {
    const fact = facts(r.id).find((f) => f.kind === "module");
    if (fact) return fact.quote ?? fact.value;
    const t = allTopics.find((t) => t.moduleLabel && t.c.sources.some((s) => s.resourceId === r.id));
    return t?.moduleLabel ?? null;
  };
  for (const r of eligible) {
    const mod = moduleLabelOf(r);
    if (mod && scopeModules.has(norm(mod))) add(r.id, `In ${mod}, which ${a.title} covers`);
  }
  for (const t of allTopics) if (scopeTopicIds.has(t.id)) for (const s of t.c.sources) add(s.resourceId, `Teaches ${t.label}, in ${a.title}'s scope`);
  for (const d of docs) if (d.kind === "past_exam" && d.relevance >= 1) add(d.material.id, `A past ${a.title}`);
  // Past-due homework in the assessment's window.
  const start = blueprint.scope.window.start ? Date.parse(blueprint.scope.window.start) : null;
  const end = a.date ? Date.parse(a.date) : null;
  const homework = eligible.filter((r) => r.kind === "assignment" && !examKind(r.title, r.submissionTypes ?? []) && !assessmentKey(r.title));
  const dueOf = (r: Resource) => {
    const d = resolveDeadline(r.deadlines).dueAt ?? r.dueAt ?? null;
    return d ? Date.parse(d) : NaN;
  };
  if (reasons.size && end !== null)
    for (const r of homework) {
      const due = dueOf(r);
      if (Number.isFinite(due) && due <= end && (start === null || due > start)) add(r.id, `Homework due before ${a.title}`);
    }
  const wholeCourse = reasons.size === 0;
  if (wholeCourse) for (const r of eligible) if (r.kind !== "assignment" || homework.includes(r)) add(r.id, "No coverage statement found, so every course material is a source");

  const docOf = new Map(docs.map((d) => [d.material.id, d]));
  const refsOf = (id: string) => (store.resourceRefs ? store.resourceRefs(id).flatMap((x) => (x.toResourceId ? [x.toResourceId] : [])) : []);
  // Assignments in the window (open or past), as filter chips selecting what they reference.
  const assignmentRows = resources
    .filter((r) => r.kind === "assignment" && !examKind(r.title, r.submissionTypes ?? []) && !assessmentKey(r.title))
    .filter((r) => {
      const due = dueOf(r);
      return end !== null && Number.isFinite(due) && due <= end && (start === null || due > start);
    })
    .map((r) => ({ r, targets: new Set([r.id, ...refsOf(r.id)]) }));
  const order = (r: Resource) => [r.module?.position ?? 9999, r.moduleItem?.position ?? 9999] as const;
  const list: PrepSource[] = [...reasons.entries()]
    .map(([id, reason]) => {
      const r = byId.get(id)!;
      const role = roleOf(r, facts(r.id).find((f) => f.kind === "role")?.value ?? null, docOf.get(id), syllabusId);
      const mod = moduleLabelOf(r);
      const unit = mod ? units.find((u) => norm(nameOf(u)) === norm(mod)) : undefined;
      return {
        resourceId: r.id,
        title: r.title,
        url: r.url || null,
        role,
        moduleId: unit?.id ?? (mod ? `module:${norm(mod)}` : null),
        moduleLabel: mod,
        reason,
        checked: true,
        topicIds: allTopics.filter((t) => t.c.sources.some((s) => s.resourceId === r.id)).map((t) => t.id),
        assignmentIds: assignmentRows.filter((x) => x.targets.has(r.id)).map((x) => x.r.id),
        passages: store.passages(r.id).length,
        resource: r,
      };
    })
    .sort((x, y) => {
      const [a1, a2] = order(x.resource);
      const [b1, b2] = order(y.resource);
      return ROLE_ORDER.indexOf(x.role) - ROLE_ORDER.indexOf(y.role) || a1 - b1 || a2 - b2 || x.title.localeCompare(y.title, undefined, { numeric: true }) || x.resourceId.localeCompare(y.resourceId);
    });
  const inList = new Set(list.map((s) => s.resourceId));

  const items: StudyPrepScopeItem[] = [];
  for (const x of assignmentRows) {
    const ids = [...x.targets].filter((id) => inList.has(id));
    items.push({ kind: "assignment", id: x.r.id, title: x.r.title, resourceIds: ids });
  }
  const modules = new Map<string, { title: string; ids: string[] }>();
  for (const s of list)
    if (s.moduleId) {
      const m = modules.get(s.moduleId) ?? { title: s.moduleLabel!, ids: [] };
      m.ids.push(s.resourceId);
      modules.set(s.moduleId, m);
    }
  for (const [id, m] of modules) items.push({ kind: "module", id, title: m.title, resourceIds: m.ids });
  const topicList = blueprint.scope.basis === "none" ? allTopics.filter((t) => t.c.sources.some((s) => inList.has(s.resourceId))) : allTopics.filter((t) => scopeTopicIds.has(t.id));
  for (const t of topicList)
    items.push({ kind: "topic", id: t.id, title: t.label, resourceIds: t.c.sources.map((s) => s.resourceId).filter((id) => inList.has(id)) });

  const anchorIds = [...eligible.filter((r) => r.kind === "material"), ...eligible.filter((r) => r.kind !== "material")].slice(0, 50).map((r) => r.id);
  return {
    accountScope,
    courseId,
    courseRef,
    label,
    evidence,
    blueprint,
    docs,
    sources: list,
    items,
    wholeCourse,
    concepts,
    topics: topicList.map(({ id, label, moduleId }) => ({ id, label, moduleId })),
    facts,
    restricted,
    policy: policies.find((p) => p.mode !== "unknown") ?? policies[0],
    anchorIds,
    where: whereOf([
      { r: a.resourceId ? byId.get(a.resourceId) : undefined, about: null },
      { r: syllabusId ? byId.get(syllabusId) : undefined, about: norm(a.title) },
    ]),
    resourceById: byId,
  };
}

export interface Selection {
  all: boolean;
  resourceIds: string[];
  topicIds: string[];
  /** Identifies (assessment, source set, topics). "All coverage" keeps one hash as coverage grows. */
  hash: string;
  resources: Resource[];
}
/** The student's selection, validated against the coverage: unknown ids are dropped, never widened. */
export function selectScope(prep: Prep, request: { resourceIds?: string[]; topicIds?: string[] }): Selection {
  const known = prep.sources.map((s) => s.resourceId);
  const wanted = request.resourceIds ? new Set(request.resourceIds) : null;
  const ids = wanted ? known.filter((id) => wanted.has(id)) : known;
  const all = !wanted || ids.length === known.length;
  const topicSet = new Set(prep.topics.map((t) => t.id));
  const topicIds = [...new Set(request.topicIds ?? [])].filter((id) => topicSet.has(id)).sort();
  const resourceIds = [...ids].sort();
  const hash = sha(["study-prep-scope-v1", prep.courseRef, prep.evidence.assessment.id, all ? "all" : resourceIds, topicIds]).slice(0, 32);
  return { all, resourceIds, topicIds, hash, resources: resourceIds.map((id) => prep.resourceById.get(id)!).filter(Boolean) };
}

export const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
export { collapse };
