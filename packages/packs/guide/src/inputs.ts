/**
 * Code selects every prompt input within a token budget: the course intelligence profile (in
 * the byte-stable prefix), material_facts when the pipeline has filled them (empty is fine),
 * and the top passages per topic for the scope. No new extractor runs here.
 */
import type { CourseCoreStore, PackScope, Resource, Store } from "@magic/contracts";
import { effectiveCoursePolicy } from "../../../domain/src/course-intelligence";
import type { CourseFrame, Passage } from "../../core/src/index";
import type { Concept, LearningStore } from "../../../learning/src/store";
import { normaliseLabel } from "../../../learning/src/concepts";
import { eligibleStudySource } from "../../../learning/src/router";
import { findQuote } from "../../../retrieval/src/quotes";
import { courseInclusion } from "../../../core/src/access";
import type { CoursePrefixSource } from "../../../core/src/course-facts/prefix"; // owner: course-facts
import { BRIEF_POLICY_POINTER, briefHoldsPolicy } from "../../../core/src/course-facts/brief"; // owner: course-facts
import { readOnce } from "../../../core/src/graph/read-once";
import type { Resolve } from "./review";
import type { GuideInput, GuideKind } from "./schema";

export type GuideStore = Store & CourseCoreStore & { learning: LearningStore };

/** Passage tokens per call (the store's estimate). */
export const GUIDE_PASSAGE_BUDGET = 8000;
const MAX_PASSAGES = 60;
const PER_TOPIC = 2;
const MAX_TOPICS = 24;
const FACT_CHARS = 4800;
const PROFILE_CHARS = 3200;

export interface GuideSelection {
  accountScope: string;
  courseId: string;
  courseRef: string;
  label: string;
  resources: Resource[];
  /** owner: course-facts. The resources the course brief in the prompt draws on (receipts and grants). */
  briefResourceIds: string[];
  frame: CourseFrame;
  input: GuideInput;
  passages: Passage[];
  resourceOf: Map<string, string>;
  /** The course-map concepts the scope covers, for personalisation. */
  concepts: Concept[];
  resolve: Resolve;
}
export type SelectionResult = { ok: true; selection: GuideSelection } | { ok: false; status: "empty" | "blocked"; message: string; courseRef: string | null };

const collapse = (t: string) => t.replace(/\s+/g, " ").trim();
const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
/** A local calendar day for an instant; a date-only value stays as written. */
export const localDay = (value: string): string | null => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString("en-CA") : null;
};

type Failure = Extract<SelectionResult, { ok: false }>;
const EMPTY = "There's no course material in this scope to study from yet.";
const NOT_SPLIT = "The course material hasn't been split into passages yet. Try again after it syncs.";

/** The scope both paths share: the course, its policy, and the resources a guide may draw on. */
function guideScope(store: GuideStore, scope: PackScope) {
  const sources = new Map(store.sources().map((s) => [s.id, s]));
  // Every resource is read once; inclusion is built from the same list.
  const all = store.resources();
  const included = courseInclusion(readOnce(store, all));
  const inCourse = all.filter((r) => !r.deleted && r.courseId === scope.courseId && sources.has(r.sourceId));
  const accountScope = inCourse.map((r) => sources.get(r.sourceId)!.accountScope).sort()[0];
  if (!accountScope) return { ok: false, status: "empty", message: EMPTY, courseRef: null } satisfies Failure;
  const courseRef = `${accountScope}:${scope.courseId}`;
  const ref = { accountScope, courseId: scope.courseId };
  const course = inCourse.filter((r) => sources.get(r.sourceId)!.accountScope === accountScope);
  const label = course.find((r) => r.courseName)?.courseName ?? scope.courseId;
  // One policy source with tutoring and the quiz/cards packs: profile claims first, a restriction wins.
  const intelligence = store
    .courseIntelligence()
    .filter((ci) => ci.accountScope === accountScope && ci.courseId === scope.courseId)
    .sort((a, b) => b.version - a.version)[0];
  const policies = course.map((r) => effectiveCoursePolicy(intelligence, r));
  if (policies.some((p) => p.mode === "restricted"))
    return { ok: false, status: "blocked", message: "This course restricts AI-made study material, so nothing was generated.", courseRef } satisfies Failure;

  // The scope: a module, or an assessment (its linked materials, else the whole course, searched by its stated scope).
  let scopeText = "The whole course";
  let assessmentQuery = "";
  let linked: Set<string> | null = null;
  const assessment = scope.assessmentId ? store.assessments(ref).find((a) => a.id === scope.assessmentId) : undefined;
  if (scope.assessmentId) {
    if (!assessment) return { ok: false, status: "empty", message: "That assessment isn't on the course map yet.", courseRef } satisfies Failure;
    const stated = store
      .assessmentScopes(assessment.id)
      .filter((s) => s.status !== "flagged")
      .map((s) => collapse(s.stated));
    const links = store.mapLinks(ref).filter((l) => l.fromKind === "assessment" && l.fromId === assessment.id && l.status !== "rejected");
    if (links.length) linked = new Set(links.map((l) => l.toResourceId));
    const day = assessment.date ? localDay(assessment.date) : null;
    scopeText = `${assessment.kind === "other" ? "Assessment" : assessment.kind[0]!.toUpperCase() + assessment.kind.slice(1)}: ${assessment.title}${day ? ` (${day})` : ""}${stated.length ? `. Stated scope: ${clip(stated.join(" "), 600)}` : ""}`;
    assessmentQuery = [assessment.title, ...stated].join(" ");
  } else if (scope.moduleId) scopeText = `Module ${scope.moduleId}`;
  const resources = course
    .filter((r) => included(r) && eligibleStudySource(r) && r.text.trim().length > 0)
    .filter((r) => !scope.resourceIds?.length || scope.resourceIds.includes(r.id))
    .filter((r) => !scope.moduleId || r.module?.id === scope.moduleId)
    .filter((r) => !linked || linked.has(r.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (!resources.length) return { ok: false, status: "empty", message: EMPTY, courseRef } satisfies Failure;
  const allowed = new Set(resources.map((r) => r.id));
  return { ok: true as const, accountScope, courseRef, ref, label, intelligence, policies, scopeText, assessmentQuery, assessment, resources, allowed };
}
/** Whether any resource in scope has a usable passage: the check that ends `selectGuideInputs` empty. */
function hasPassage(store: GuideStore, resources: Resource[], allowed: Set<string>): boolean {
  for (const r of resources)
    for (const listed of store.passages(r.id)) {
      if (listed.redacted) continue;
      const p = store.passage(listed.pid);
      if (p && !p.passage.redacted && allowed.has(p.passage.resourceId) && p.text.trim()) return true;
    }
  return false;
}

/**
 * What the guide view needs (its course and resources), decided exactly as `selectGuideInputs`
 * decides it, without the topic searches, facts and passage text that only generation uses.
 * Any passage a topic search could return is also in its resource's own list, so emptiness is
 * the same.
 */
export function selectGuideScope(
  store: GuideStore,
  scope: PackScope,
): { ok: true; courseRef: string; resources: Resource[] } | Failure {
  const picked = guideScope(store, scope);
  if (!picked.ok) return picked;
  if (!hasPassage(store, picked.resources, picked.allowed))
    return { ok: false, status: "empty", message: NOT_SPLIT, courseRef: picked.courseRef };
  return { ok: true, courseRef: picked.courseRef, resources: picked.resources };
}

export function selectGuideInputs(
  store: GuideStore,
  kind: GuideKind,
  scope: PackScope,
  passageBudget = GUIDE_PASSAGE_BUDGET,
  /** owner: course-facts. The course prefix (brief + catalogue): it replaces the re-serialised profile. */
  coursePrefix: CoursePrefixSource | null = null,
): SelectionResult {
  const picked = guideScope(store, scope);
  if (!picked.ok) return picked;
  const { accountScope, courseRef, ref, label, intelligence, policies, scopeText, assessmentQuery, assessment, resources, allowed } = picked;

  // Topics: the course's own map (never generation-made concepts, so the key stays stable), the profile, the facts.
  const map = store.learning.concepts(courseRef).filter((c) => c.status === "active" && c.origin !== "model");
  const units = map.filter((c) => c.kind === "unit").sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const nameOf = (c: Concept) => c.studentLabel ?? c.label;
  const allConcepts = map.filter((c) => c.kind === "concept").sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const focus = scope.topicIds?.length ? allConcepts.filter((c) => scope.topicIds!.includes(c.id)) : [];
  const touching = allConcepts.filter((c) => c.sources.some((s) => allowed.has(s.resourceId)));
  const whole = !scope.moduleId && !scope.assessmentId && !scope.resourceIds?.length;
  const concepts = focus.length ? focus : touching.length || !whole ? touching : allConcepts;
  const profileTopics = (intelligence?.claims ?? [])
    .filter((c) => c.kind === "topic" && (whole || c.evidence.some((e) => allowed.has(e.resourceId))))
    .map((c) => collapse(String(c.value ?? c.label)))
    .filter((t) => t.length <= 80);
  const facts: string[] = [];
  const termTopics: string[] = [];
  let factChars = 0;
  for (const r of resources)
    for (const f of store.materialFacts(r.id)) {
      if (f.kind === "code" || f.kind === "example") continue;
      const line = `${f.kind}: ${clip(collapse(f.value), 200)}`;
      if (f.kind === "term" && f.value.length <= 80) termTopics.push(collapse(f.value));
      if (facts.includes(line) || factChars + line.length > FACT_CHARS) continue;
      facts.push(line);
      factChars += line.length;
    }
  const topics: string[] = [];
  for (const t of [...concepts.map(nameOf), ...profileTopics, ...termTopics])
    if (topics.length < MAX_TOPICS && normaliseLabel(t) && !topics.some((x) => normaliseLabel(x) === normaliseLabel(t))) topics.push(t);

  // Passages: the top hits per topic (and for the assessment's stated scope), then round-robin by resource.
  const pids: number[] = [];
  const queries = [...(assessmentQuery ? [assessmentQuery] : []), ...topics];
  for (const q of queries) {
    const hits = store.searchPassages({ query: clip(q, 500), courses: [ref], k: 8 });
    let taken = 0;
    for (const h of hits.hits)
      if (taken < PER_TOPIC && allowed.has(h.resourceId) && !pids.includes(h.pid)) {
        pids.push(h.pid);
        taken++;
      }
  }
  const lists = resources.map((r) => store.passages(r.id).filter((p) => !p.redacted));
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (l[i] && !pids.includes(l[i]!.pid)) pids.push(l[i]!.pid);
  const passages: Passage[] = [];
  const resourceOf = new Map<string, string>();
  let used = 0;
  for (const pid of pids) {
    if (passages.length >= MAX_PASSAGES) break;
    const p = store.passage(pid);
    if (!p || p.passage.redacted || !allowed.has(p.passage.resourceId) || !p.text.trim()) continue;
    if (used + p.passage.tokEst > passageBudget && passages.length) continue;
    used += p.passage.tokEst;
    passages.push({ sourceId: `p${pid}`, text: p.text });
    resourceOf.set(`p${pid}`, p.passage.resourceId);
  }
  if (!passages.length) return { ok: false, status: "empty", message: NOT_SPLIT, courseRef };

  // Canonical dates (timeline only, so a deadline change doesn't invalidate the other guides).
  const dates = new Set<string>();
  if (kind === "timeline") {
    const add = (v: string | null | undefined) => {
      const d = v ? localDay(v) : null;
      if (d) dates.add(d);
    };
    for (const a of store.assessments(ref)) if (!assessment || a.id === assessment.id) add(a.date);
    for (const s of store.courseSessions(ref)) add(s.date);
    const brief = store.courseBrief(ref);
    for (const s of brief?.brief.schedule ?? []) add(s.date);
    for (const a of brief?.brief.assessments ?? []) add(a.date);
    for (const r of resources) for (const d of r.deadlines) if (d.kind !== "lock") add(d.value);
  }
  const hierarchy =
    kind === "conceptmap"
      ? concepts.flatMap((c) => {
          const parent = map.find((p) => p.id === c.parentId);
          return parent ? [`${nameOf(c)} > ${nameOf(parent)}`] : [];
        })
      : [];

  // The prefix: course, sections and the profile (grading, assessments, topics), then the policy.
  const profile: string[] = [];
  let profileChars = 0;
  const prefix = coursePrefix?.(courseRef); // owner: course-facts: the brief carries the profile
  for (const c of prefix ? [] : (intelligence?.claims ?? [])) {
    if (c.kind === "ai_policy") continue;
    const line = `- ${c.kind}: ${clip(collapse(c.label), 120)}${c.value === null || c.value === "" ? "" : `: ${clip(collapse(String(c.value)), 200)}`}`;
    if (profileChars + line.length > PROFILE_CHARS) break;
    profile.push(line);
    profileChars += line.length;
  }
  const aiPolicy = intelligence?.claims.find((c) => c.kind === "ai_policy");
  const policy = policies.find((p) => p.mode !== "unknown") ?? policies[0];
  const frame: CourseFrame = {
    courseId: courseRef,
    course: label,
    skeleton: [`Course: ${label}`, ...units.map((u) => `Section: ${nameOf(u)}`), ...(profile.length ? ["Course profile:", ...profile] : [])].join("\n"),
    policy: aiPolicy ? `${aiPolicy.policyMode ?? "unknown"}: ${clip(collapse(String(aiPolicy.value ?? aiPolicy.label)), 600)}` : policy ? `${policy.mode}: ${policy.evidence}` : "",
    // owner: course-facts: the prefix, and a policy line pointing at the brief's quotes
    ...(prefix
      ? {
          brief: prefix.text,
          // Point at the brief only when it holds every quote behind the policy; otherwise keep the line above.
          ...(briefHoldsPolicy(policy?.evidence, prefix.text) ? { policy: `${aiPolicy?.policyMode ?? policy?.mode ?? "unknown"}: ${BRIEF_POLICY_POINTER}` } : {}),
        }
      : {}),
  };

  const byId = new Map(resources.map((r) => [r.id, r]));
  const resolve: Resolve = (sourceId, quote) => {
    const pid = Number(sourceId.slice(1));
    const p = Number.isSafeInteger(pid) ? store.passage(pid) : undefined;
    const r = p && byId.get(p.passage.resourceId);
    if (!p || !r) return null;
    const found = findQuote(p.text, quote);
    if (found.status !== "unique") return null;
    const start = p.passage.start + found.start;
    const end = p.passage.start + found.end;
    return { resourceId: r.id, start, end, quote: r.text.slice(start, end) };
  };

  return {
    ok: true,
    selection: {
      accountScope,
      courseId: scope.courseId,
      courseRef,
      label,
      resources,
      briefResourceIds: prefix?.resourceIds ?? [],
      frame,
      input: {
        kind,
        scope: scopeText,
        materials: resources.map((r) => clip(collapse(r.title), 160)),
        topics: [...topics, ...hierarchy],
        facts,
        dates: [...dates].sort(),
      },
      passages,
      resourceOf,
      concepts,
      resolve,
    },
  };
}
