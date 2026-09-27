/**
 * owner: study-prep. One work item as its space shows it: what it is (its type, by code), what the
 * student needs for it, and the student's selection of those sources. Code only, local reads only,
 * 0 tokens.
 *
 * An exam or quiz's coverage comes from the exam blueprint (N15: stated scope with its quote, the
 * syllabus row, the schedule window, the course map) plus the course's own links: materials linked
 * to it or naming it in a `covers` fact, materials under the modules and topics in scope, the
 * instructor's practice exams, review sheets and solutions for it, and past-due homework in its
 * window. An assignment's comes from the materials its instructions link to, the course map's links
 * from it, and its module. A material's is itself and its module. Only eligible study sources count
 * (the same rule as every pack: open graded work is never sent to an AI). When nothing ties a
 * material to the item, every eligible material in the course is a source, and the space says so.
 */
import type { Assessment, CourseCoreStore, ItemType, MaterialFact, Resource, Store, StudyPrepItemKind, StudyPrepQuote, StudyPrepScopeItem, StudyPrepSource, StudyPrepSourceRole } from "@magic/contracts";
import { resolveDeadline } from "@magic/domain";
import { courseFramePolicy, effectiveCoursePolicy } from "../../../domain/src/course-intelligence";
import type { LearningStore, Concept } from "../../../learning/src/store";
import { eligibleStudySource } from "../../../learning/src/router";
import { createExamEvidence, assessmentKey, type ExamAssessment, type ExamEvidence } from "../../../learning/src/exam/evidence";
import { classifyDocs, deriveBlueprint, type ClassifiedDoc } from "../../../learning/src/exam/blueprint";
import type { ExamBlueprint } from "../../../learning/src/exam/types";
import { examKind } from "../../../learning/src/analytics/references";
import { courseInclusion } from "../access";
import { codeType, decideType, readTypes, type TypeDecision } from "./item-type";
import { sha } from "./scope-hash";

export { sha };

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

export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
export const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
const DAY = 86_400_000;

export interface PrepSource extends StudyPrepSource {
  resource: Resource;
}
export interface Subject {
  id: string;
  kind: StudyPrepItemKind;
  type: ItemType;
  typeReason: string;
  typeBasis: TypeDecision["basis"];
  title: string;
  /** The Canvas resource, when there is one. */
  resource: Resource | null;
  /** The course-map row, when there is one. */
  row: Assessment | null;
  date: string | null;
}
export interface Prep {
  accountScope: string;
  courseId: string;
  courseRef: string;
  label: string;
  subject: Subject;
  /** Exams and quizzes: the evidence and the blueprint. Null for other items. */
  evidence: ExamEvidence | null;
  blueprint: ExamBlueprint | null;
  docs: ClassifiedDoc[];
  /** Eligible study sources linked to the item, course order. */
  sources: PrepSource[];
  items: StudyPrepScopeItem[];
  /** Whether the sources fell back to the whole course. */
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
  /** The coverage window: from (exclusive) and to, as ms; null ends are open. */
  window: { start: number | null; end: number | null };
  /** Every live resource of the course (decoded once per inventory). */
  resources: Resource[];
  syllabusId: string | null;
  moduleLabelOf: (r: Resource) => string | null;
}

/**
 * A course's live resources, decoded once per inventory: `courseInventoryHash` covers every live
 * resource's id and content hash (the hash of its whole captured record), so an unchanged hash
 * means the same rows. Decoding a large course's texts is most of a cold query's time.
 */
const decoded = new WeakMap<object, Map<string, { hash: string; rows: Resource[] }>>();
export function courseRows(store: PrepStore, course: { accountScope: string; courseId: string }): Resource[] {
  const inventory = (store as { courseInventoryHash?(c: typeof course): string }).courseInventoryHash;
  if (!store.courseResources) return store.resources();
  if (!inventory) return store.courseResources(course);
  const hash = inventory.call(store, course);
  let byCourse = decoded.get(store);
  if (!byCourse) decoded.set(store, (byCourse = new Map()));
  const key = `${course.accountScope}:${course.courseId}`;
  const hit = byCourse.get(key);
  if (hit && hit.hash === hash) return hit.rows;
  const rows = store.courseResources(course);
  byCourse.set(key, { hash, rows });
  return rows;
}

/** Without an explicit account target, a shared course ID must resolve uniquely. */
export function courseScope(store: Store, courseId: string): string | null {
  const accounts = new Set(store.sources().filter((s) => s.courseId === courseId && s.accountScope).map((s) => s.accountScope));
  return accounts.size === 1 ? [...accounts][0]! : null;
}

const ROLE_WORDS: [RegExp, StudyPrepSourceRole][] = [
  [/\bsyllabus\b/i, "syllabus"],
  [/\b(?:solutions?|solns?|answer key)\b/i, "solutions"],
  [/\bslides?\b|\.pptx?\b|\bdeck\b/i, "slides"],
  [/\b(?:lecture|lec)\b/i, "lecture"],
  [/\b(?:reading|chapter|textbook|notes|article)\b/i, "reading"],
];
function roleOf(r: Resource, fact: string | null, doc: ClassifiedDoc | undefined, syllabusId: string | null): StudyPrepSourceRole {
  if (r.id === syllabusId || fact === "syllabus") return "syllabus";
  if (doc) return doc.kind === "exam_info" ? "review_sheet" : doc.kind;
  if (r.kind === "assignment") return "homework";
  if (fact === "solutions") return "solutions";
  if (fact === "lecture") return "lecture";
  if (fact === "reading") return "reading";
  for (const [re, role] of ROLE_WORDS) if (re.test(r.title)) return role;
  if (r.contentType && !/html/i.test(r.contentType)) return "file";
  if (r.moduleItem?.type === "Page") return "page";
  return "other";
}

/**
 * "Room 1100", "held in Synthetic Hall": a location the course states, with its quote. The
 * item's own record is read first; in the syllabus only a line naming the item counts, so another
 * exam's room is never shown. A stated room wins over "in class".
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
const ROLE_ORDER: StudyPrepSourceRole[] = ["lecture", "slides", "reading", "page", "file", "other", "homework", "review_sheet", "practice_exam", "solutions", "past_exam", "syllabus"];
const FALLBACK_TYPE: Record<StudyPrepItemKind, ItemType> = { assessment: "exam", quiz: "quiz", assignment: "problem_set", material: "reading" };

export const dueOf = (r: Resource): string | null => resolveDeadline(r.deadlines).dueAt ?? r.dueAt ?? null;

/**
 * Everything the query and generation need about one item. Reads the course's resources once
 * (SQL-filtered when the store can, and decoded once per inventory), and each material's facts once.
 */
export function loadPrep(store: PrepStore, courseId: string, itemId: string, now: Date): Prep | { status: "missing" | "empty"; message: string } {
  const accountScope = courseScope(store, courseId);
  if (!accountScope) return { status: "empty", message: "This course has no saved material yet." };
  const course = { accountScope, courseId };
  const sourcesById = new Map(store.sources().map((s) => [s.id, s]));
  const resources = courseRows(store, course).filter((r) => !r.deleted && r.courseId === courseId && sourcesById.get(r.sourceId)?.accountScope === accountScope);
  const byId = new Map(resources.map((r) => [r.id, r]));
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
  const courseRef = `${accountScope}:${courseId}`;
  const label = resources.find((r) => r.courseName)?.courseName ?? courseId;
  const moduleLabelOf = (r: Resource): string | null => {
    const fact = facts(r.id).find((f) => f.kind === "module");
    if (fact) return fact.quote ?? fact.value;
    const t = allTopics.find((t) => t.moduleLabel && t.c.sources.some((s) => s.resourceId === r.id));
    return t?.moduleLabel ?? null;
  };

  // The course map: topics under their modules (units).
  const concepts = store.learning.concepts(courseRef).filter((c) => c.status === "active");
  const units = concepts.filter((c) => c.kind === "unit").sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const nameOf = (c: Concept) => c.studentLabel ?? c.label;
  const unitOf = (c: Concept) => units.find((u) => u.id === c.parentId) ?? null;
  const allTopics = concepts
    .filter((c) => c.kind === "concept")
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
    .map((c) => ({ c, id: c.id, label: nameOf(c), moduleId: unitOf(c)?.id ?? null, moduleLabel: unitOf(c) ? nameOf(unitOf(c)!) : null }));

  // ---- The subject: an exam or quiz (with evidence), else an assignment, a course-map item or a material ----
  const evidence = port.evidence(accountScope, courseId, itemId);
  const row = store.assessments(course).find((a) => a.id === itemId) ?? null;
  let resource: Resource | null = null;
  let kind: StudyPrepItemKind;
  let a: ExamAssessment | null = null;
  if (evidence) {
    a = evidence.assessment;
    resource = a.resourceId ? (byId.get(a.resourceId) ?? null) : null;
    kind = a.kind === "quiz" ? "quiz" : "assessment";
  } else {
    resource = byId.get(itemId) ?? (row?.resourceId ? (byId.get(row.resourceId) ?? null) : null);
    if (!resource && !row) return { status: "missing", message: "That item isn't in this course's saved records." };
    kind = resource?.kind === "material" || resource?.kind === "course" ? "material" : "assignment";
  }
  const title = a?.title ?? row?.title ?? resource?.title ?? itemId;
  const code = codeType({
    assessment: row ?? (a ? { kind: a.kind as Assessment["kind"], title: a.title } : null),
    resource,
    facts: resource ? facts(resource.id) : [],
    moduleTitle: resource ? moduleLabelOf(resource) : null,
  });
  const decided = decideType(code, readTypes(store.learning, courseRef)[itemId], FALLBACK_TYPE[kind]);
  const date = a?.date ?? row?.date ?? (resource ? dueOf(resource) : null);

  const blueprint = evidence
    ? deriveBlueprint({
        evidence,
        topics: allTopics.map(({ id, label, moduleId, moduleLabel }) => ({ id, label, moduleId, moduleLabel })),
        modules: units.map((u) => ({ id: u.id, label: nameOf(u) })),
        coverage: store.learning.coverage(evidence.assessment.id),
        now,
      })
    : null;
  const docs = evidence ? classifyDocs(evidence, now) : [];

  // Policy: a restriction anywhere in the course blocks AI-made practice (as every pack).
  const intelligence = store
    .courseIntelligence()
    .filter((ci) => ci.accountScope === accountScope && ci.courseId === courseId)
    .sort((x, y) => y.version - x.version)[0];
  const policies = resources.map((r) => effectiveCoursePolicy(intelligence, r));
  const restricted = policies.some((p) => p.mode === "restricted");

  const included = courseInclusion(store, resources);
  const at = now.getTime();
  const eligible = resources.filter((r) => included(r) && eligibleStudySource(r, at) && r.text.trim().length > 0);
  const eligibleIds = new Set(eligible.map((r) => r.id));
  // The syllabus: the course brief's, else the material the pipeline or its title calls one.
  const syllabusId =
    evidence?.brief?.syllabusResourceId ??
    resources.find((r) => r.kind === "material" && facts(r.id).some((f) => f.kind === "role" && f.value === "syllabus"))?.id ??
    resources.find((r) => r.kind === "material" && SYLLABUS_TITLE.test(r.title))?.id ??
    null;

  // Coverage, with the reason code found for each resource (first reason wins).
  const reasons = new Map<string, string>();
  const add = (id: string, reason: string) => {
    if (eligibleIds.has(id) && id !== syllabusId && !reasons.has(id) && (kind === "material" || id !== resource?.id)) reasons.set(id, reason);
  };
  const refsOf = (id: string) => (store.resourceRefs ? store.resourceRefs(id).flatMap((x) => (x.toResourceId ? [x.toResourceId] : [])) : []);
  const isHomework = (r: Resource) => r.kind === "assignment" && !examKind(r.title, r.submissionTypes ?? []) && !assessmentKey(r.title);
  const dueMs = (r: Resource) => {
    const d = dueOf(r);
    return d ? Date.parse(d) : NaN;
  };
  const end = date ? Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T23:59:59` : date) : null;
  let start: number | null = null;
  if (evidence && a && blueprint) {
    for (const l of evidence.links) add(l.resourceId, l.reason || `Linked to ${a.title} on the course map`);
    for (const m of evidence.materials) if (m.covers.includes(a.id) || (!!a.resourceId && m.covers.includes(a.resourceId))) add(m.id, `States that it covers ${a.title}`);
    for (const d of docs) if (d.relevance >= 1 && d.kind !== "past_exam") add(d.material.id, d.kind === "solutions" ? `Solutions for ${a.title}` : d.kind === "review_sheet" ? `Review sheet for ${a.title}` : d.kind === "exam_info" ? `About ${a.title}` : `Practice exam for ${a.title}`);
    const scopeTopicIds = new Set(blueprint.scope.basis === "none" ? [] : blueprint.scope.concepts.map((c) => c.conceptId));
    const scopeModules = new Set(blueprint.scope.modules.map((m) => norm(m.label)));
    for (const r of eligible) {
      const mod = moduleLabelOf(r);
      if (mod && scopeModules.has(norm(mod))) add(r.id, `In ${mod}, which ${a.title} covers`);
    }
    for (const t of allTopics) if (scopeTopicIds.has(t.id)) for (const s of t.c.sources) add(s.resourceId, `Teaches ${t.label}, in ${a.title}'s scope`);
    for (const d of docs) if (d.kind === "past_exam" && d.relevance >= 1) add(d.material.id, `A past ${a.title}`);
    start = blueprint.scope.window.start ? Date.parse(blueprint.scope.window.start) : null;
    if (reasons.size && end !== null)
      for (const r of eligible.filter(isHomework)) {
        const due = dueMs(r);
        if (Number.isFinite(due) && due <= end && (start === null || due > start)) add(r.id, `Homework due before ${a.title}`);
      }
  } else if (resource) {
    for (const id of refsOf(resource.id)) add(id, "Linked in the instructions");
    for (const l of store.mapLinks(course)) if (l.fromId === resource.id && l.status !== "rejected" && l.current) add(l.toResourceId, l.reason);
    const moduleId = resource.moduleItem?.moduleId ?? resource.module?.id ?? null;
    const moduleName = moduleLabelOf(resource);
    for (const r of eligible)
      if ((moduleId && (r.moduleItem?.moduleId ?? r.module?.id) === moduleId) || (moduleName && moduleLabelOf(r) === moduleName))
        add(r.id, moduleName ? `In the same module: ${moduleName}` : "In the same module");
    if (kind === "material") add(resource.id, "This material");
    start = end !== null ? end - 14 * DAY : null;
  }
  const wholeCourse = reasons.size === 0 && decided.type !== "participation";
  if (wholeCourse) for (const r of eligible) if (r.kind !== "assignment" || isHomework(r)) add(r.id, "Nothing links a material to this item yet, so every course material is a source");

  const docOf = new Map(docs.map((d) => [d.material.id, d]));
  // Assignments in the window (open or past), as filter chips selecting what they reference.
  const assignmentRows = resources
    .filter((r) => isHomework(r) && r.id !== resource?.id)
    .filter((r) => {
      const due = dueMs(r);
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
  const scopeTopics = blueprint && blueprint.scope.basis !== "none" ? new Set(blueprint.scope.concepts.map((c) => c.conceptId)) : null;
  const topicList = scopeTopics ? allTopics.filter((t) => scopeTopics.has(t.id)) : allTopics.filter((t) => t.c.sources.some((s) => inList.has(s.resourceId)));
  for (const t of topicList)
    items.push({ kind: "topic", id: t.id, title: t.label, resourceIds: t.c.sources.map((s) => s.resourceId).filter((id) => inList.has(id)) });

  const anchorIds = [...eligible.filter((r) => r.kind === "material"), ...eligible.filter((r) => r.kind !== "material")].slice(0, 50).map((r) => r.id);
  return {
    accountScope,
    courseId,
    courseRef,
    label,
    subject: { id: itemId, kind, type: decided.type, typeReason: decided.reason, typeBasis: decided.basis, title, resource, row, date },
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
    policy: courseFramePolicy(policies),
    anchorIds,
    where: whereOf([
      { r: resource ?? undefined, about: null },
      { r: syllabusId ? byId.get(syllabusId) : undefined, about: norm(title) },
    ]),
    resourceById: byId,
    window: { start, end },
    resources,
    syllabusId,
    moduleLabelOf,
  };
}

export interface Selection {
  all: boolean;
  resourceIds: string[];
  topicIds: string[];
  /** Identifies (item, source set, topics). "Everything linked" keeps one hash as links grow. */
  hash: string;
  resources: Resource[];
}
/** The hash of an item's "everything linked" selection with no topic filter (list badges read it without loading the item). */
export const allScopeHash = (courseRef: string, itemId: string) => sha(["study-prep-scope-v1", courseRef, itemId, "all", []]).slice(0, 32);

/** The student's selection, validated against the item's sources: unknown ids are dropped, never widened. */
export function selectScope(prep: Prep, request: { resourceIds?: string[]; topicIds?: string[] }): Selection {
  const known = prep.sources.map((s) => s.resourceId);
  const wanted = request.resourceIds ? new Set(request.resourceIds) : null;
  const ids = wanted ? known.filter((id) => wanted.has(id)) : known;
  const all = !wanted || ids.length === known.length;
  const topicSet = new Set(prep.topics.map((t) => t.id));
  const topicIds = [...new Set(request.topicIds ?? [])].filter((id) => topicSet.has(id)).sort();
  const resourceIds = [...ids].sort();
  const hash = all && !topicIds.length ? allScopeHash(prep.courseRef, prep.subject.id) : sha(["study-prep-scope-v1", prep.courseRef, prep.subject.id, all ? "all" : resourceIds, topicIds]).slice(0, 32);
  return { all, resourceIds, topicIds, hash, resources: resourceIds.map((id) => prep.resourceById.get(id)!).filter(Boolean) };
}
