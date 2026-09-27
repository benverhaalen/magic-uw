/**
 * The `pack` Command handler for study generation (T45 items, the flashcards pack; T13 runner).
 * Code picks the passages, decides consent, runs one checked call through the student's own
 * client, then runs the learning engines' checked-item pipeline (N06) on every item and writes
 * the accepted versions into the N24 LearningStore, where N25's `study.plan` selects them.
 * A repeat with unchanged content is a cache hit: 0 tokens and a 0-token ledger row.
 */
import { aiRecipientSchema, type CourseCoreStore, type PackScope, type Resource, type Store } from "@magic/contracts";
import { maySend } from "@magic/domain";
import { effectiveCoursePolicy } from "../../domain/src/course-intelligence";
import type { BackendCall, ModelRunner } from "../../runner/src/index";
// owner: ai-paths
import { createClaudeBackend, createSessionPool, type CliCommand, type PoolOptions, type SessionPool } from "../../runner/src/index";
import { GUIDE_PACKS } from "../../packs/guide/src/index";
// end owner: ai-paths
import { courseFactsPack } from "./course-facts/extractor"; // owner: course-facts
import { createCourseBriefs, type CourseBriefSource } from "./course-facts/brief"; // owner: course-facts
import { BRIEF_POLICY_POINTER, briefHoldsPolicy, coursePrefixes } from "./course-facts/prefix"; // owner: course-facts
import { buildPrompt, packCacheKey, type ArtifactStore, type CourseFrame, type LedgerStore, type PackSpec, type Passage } from "../../packs/core/src/index";
import { learningArtifactStore, sqlLedgerStore } from "../../packs/core/src/learning-stores";
import { quizDrafts, quizPack, type Draft, type GenerationInput } from "../../packs/items/src/index";
import { cardDrafts, cardsPack, reverseCards } from "../../packs/cards/src/index";
import { subjectFamily } from "../../notes/src/templates/index";
// owner: exam-prep. Step-by-step problems: authored by the model, checked by code, stored as problems.
import { isProblemDraft, problemDrafts, problemsPack } from "../../packs/problems/src/index";
import { checkAuthored, putProblem } from "../../learning/src/exam/problems";
// end owner: exam-prep
import { runPipeline, type CandidateItem, type PipelineResource, type StageName } from "../../learning/src/items";
import { conceptId, normaliseLabel } from "../../learning/src/concepts";
import { newCard } from "../../learning/src/fsrs";
import type { Concept, LearningStore } from "../../learning/src/store";
import { eligibleStudySource } from "../../learning/src/router";
import { findQuote } from "../../retrieval/src/quotes";
import { contentCategories, courseInclusion } from "./access";
import { rosterFor, toOriginalSpan } from "./identity";
import { classOf, protectedPayloadScrubber, protectionCounts } from "./privacy/protect"; // owner: privacy
import { buildReceipt, egressFor, payloadHash } from "./egress";
import { runPack } from "./jobs/pack";
// owner: guides
import { generateGuide, guideView, isGuideKind, type GuideRunResult, type GuideViewResult } from "../../packs/guide/src/index";
// end owner: guides
// owner: mastery
import { buildStrategy } from "../../packs/strategy/src/index";
// end owner: mastery

export type GenerationPackName = "quiz" | "cards" | "problems";
/** Command pack names the handler answers to. */
export const GENERATION_PACKS: Record<string, GenerationPackName> = { quiz: "quiz", items: "quiz", cards: "cards", flashcards: "cards", problems: "problems", solve: "problems" };
export const DEFAULT_COUNT: Record<GenerationPackName, number> = { quiz: 8, cards: 10, problems: 4 };
const NOUN: Record<GenerationPackName, string> = { quiz: "questions", cards: "cards", problems: "problems" };
const PURPOSE: Record<GenerationPackName, string> = {
  quiz: "Generate quiz questions from course materials",
  cards: "Generate flashcards from course materials",
  problems: "Generate step-by-step practice problems from course materials",
};
/** A problem check's reason ("restraint: …") as the pipeline stage it corresponds to. */
const PROBLEM_STAGE: Record<string, StageName> = {
  policy: "policy", open_graded: "policy", quote: "quote", verbatim: "quote", tags: "tags", schema: "schema", parse: "schema",
  units: "schema", recompute: "executed", restraint: "flaws", distractors: "flaws",
};
/** Passages sent per call, by the store's token estimate. */
export const PASSAGE_TOKEN_BUDGET = 6000;
const MAX_PASSAGES = 24;
class PackEgressBlocked extends Error {}
const MAP_VERSION = "generated-v1";

export type PackRunStatus = "done" | "needs_student" | "blocked" | "paused" | "failed" | "no_client" | "empty" | "unknown_pack";
export interface PackDrop {
  index: number;
  stage: StageName;
  reason: string;
}
/** The `pack` command's result (CommandResult.pack). */
export interface PackRunResult {
  status: PackRunStatus;
  message: string;
  pack: string;
  courseRef: string | null;
  artifactIds: string[];
  itemIds: string[];
  cached: boolean;
  /** Tokens this command spent (0 on a cache hit). */
  tokens: { in: number; cached: number; out: number };
  counts: { generated: number; accepted: number; dropped: number; droppedBy: Partial<Record<StageName, number>> };
  drops: PackDrop[];
  receiptIds: string[];
  /** needs_student: what the student can do next. */
  options?: ("retry" | "narrow_scope" | "skip")[];
  checkErrors?: string[];
}

export type WorkspaceStore = Store & CourseCoreStore & { learning: LearningStore };
export interface PackHandlerDeps {
  store: WorkspaceStore;
  /** The student's own client, or null. A cache hit never calls its provider. */
  runner: () => ModelRunner | null | Promise<ModelRunner | null>;
  artifacts?: ArtifactStore;
  ledger?: LedgerStore;
  now?: () => Date;
  /**
   * owner: course-facts. The course brief (`syllabus.md`) that opens every prompt about the course.
   * Default: rendered from the store (no file). `null` turns it off (the old prefix).
   */
  brief?: CourseBriefSource | null;
}
export interface GenerateOptions {
  count?: number;
  /** `interactive` when the student asked (default); `background` is budgeted and pausable. */
  lane?: "interactive" | "background";
  passageTokenBudget?: number;
}

const sourceIdOf = (pid: number) => `p${pid}`;

interface Scoped {
  accountScope: string;
  courseId: string;
  courseRef: string;
  label: string;
  resources: Resource[];
  restricted: boolean;
  /** The effective course policy (profile claims first; a restriction wins), as tutoring reads it. */
  policy: { mode: string; evidence: string } | undefined;
  /** The subject family code derives from the course code and title (plan D35); "unknown" when it can't tell. */
  family: string;
  /** owner: course-facts. The resources the course brief in the prompt draws on (receipts and grants). */
  briefResourceIds?: string[];
}

/** The course (and optional module or resources) the scope names, with only eligible, included study sources. */
function resolveScope(store: WorkspaceStore, scope: PackScope): Scoped | null {
  const sources = new Map(store.sources().map((s) => [s.id, s]));
  const included = courseInclusion(store);
  const inCourse = store.resources().filter((r) => !r.deleted && r.courseId === scope.courseId && sources.has(r.sourceId));
  const accountScope = inCourse.map((r) => sources.get(r.sourceId)!.accountScope).sort()[0];
  if (!accountScope) return null;
  const course = inCourse.filter((r) => sources.get(r.sourceId)!.accountScope === accountScope);
  // Conservative: any restricted statement in the course blocks AI-made practice (N06 stage 1).
  // One policy source with tutoring: the course profile's claims, where a restriction wins.
  const profile = store
    .courseIntelligence()
    .filter((ci) => ci.accountScope === accountScope && ci.courseId === scope.courseId)
    .sort((a, b) => b.version - a.version)[0];
  const policies = course.map((r) => effectiveCoursePolicy(profile, r));
  const restricted = policies.some((p) => p.mode === "restricted");
  const resources = course
    .filter((r) => included(r) && eligibleStudySource(r) && r.text.trim().length > 0)
    .filter((r) => !scope.resourceIds?.length || scope.resourceIds.includes(r.id))
    .filter((r) => !scope.moduleId || r.module?.id === scope.moduleId)
    .sort((a, b) => a.id.localeCompare(b.id));
  const label = resources.find((r) => r.courseName)?.courseName ?? scope.courseId;
  const courseCode = course.find((r) => r.course?.courseCode)?.course?.courseCode ?? null;
  const family = subjectFamily({ courseName: course.find((r) => r.courseName)?.courseName ?? label, courseCode }).family;
  return {
    accountScope,
    courseId: scope.courseId,
    courseRef: `${accountScope}:${scope.courseId}`,
    label,
    resources,
    restricted,
    policy: policies.find((p) => p.mode !== "unknown") ?? policies[0],
    family,
  };
}

/** Passages within the token budget: search hits for chosen topics, otherwise round-robin by resource. */
function pickPassages(store: WorkspaceStore, s: Scoped, focus: string[], budget: number): { passages: Passage[]; resourceOf: Map<string, string> } {
  const allowed = new Set(s.resources.map((r) => r.id));
  let pids: number[] = [];
  if (focus.length) {
    const hits = store.searchPassages({ query: focus.join(" "), courses: [{ accountScope: s.accountScope, courseId: s.courseId }], k: 20 });
    pids = hits.hits.filter((h) => allowed.has(h.resourceId)).map((h) => h.pid);
  }
  if (!pids.length) {
    const lists = s.resources.map((r) => store.passages(r.id).filter((p) => !p.redacted));
    for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (l[i]) pids.push(l[i]!.pid);
  }
  const passages: Passage[] = [];
  const resourceOf = new Map<string, string>();
  let used = 0;
  for (const pid of pids) {
    if (passages.length >= MAX_PASSAGES) break;
    const p = store.passage(pid);
    if (!p || p.passage.redacted || !allowed.has(p.passage.resourceId) || !p.text.trim()) continue;
    if (used + p.passage.tokEst > budget && passages.length) continue;
    used += p.passage.tokEst;
    passages.push({ sourceId: sourceIdOf(pid), text: p.text });
    resourceOf.set(sourceIdOf(pid), p.passage.resourceId);
  }
  return { passages, resourceOf };
}

function frameFor(s: Scoped, units: Concept[]): CourseFrame {
  const policy = s.policy;
  return {
    courseId: s.courseRef,
    course: s.label,
    skeleton: [`Course: ${s.label}`, ...units.map((u) => `Section: ${u.studentLabel ?? u.label}`)].join("\n"),
    policy: policy ? `${policy.mode}: ${policy.evidence}` : "",
  };
}

const empty = (pack: string, status: PackRunStatus, message: string, courseRef: string | null = null): PackRunResult => ({
  status,
  message,
  pack,
  courseRef,
  artifactIds: [],
  itemIds: [],
  cached: false,
  tokens: { in: 0, cached: 0, out: 0 },
  counts: { generated: 0, accepted: 0, dropped: 0, droppedBy: {} },
  drops: [],
  receiptIds: [],
});

export function createPackHandler(deps: PackHandlerDeps) {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  const courseOf = (ref: string) => {
    const s = store.sources().find((x) => `${x.accountScope}:${x.courseId}` === ref);
    return s ? { accountScope: s.accountScope, courseId: s.courseId } : null;
  };
  const sourceOf = (sourceId: string) => {
    const pid = Number(sourceId.slice(1));
    const p = Number.isSafeInteger(pid) ? store.passage(pid) : undefined;
    const r = p && store.resource(p.passage.resourceId);
    return r ? { resourceId: r.id, contentHash: r.contentHash } : null;
  };
  const artifacts = deps.artifacts ?? learningArtifactStore(store.learning, sourceOf);
  // owner: course-facts
  const courseBrief: CourseBriefSource | null = deps.brief === undefined ? createCourseBriefs({ store }).courseBrief : deps.brief;
  const coursePrefix = coursePrefixes(courseBrief);
  // end owner: course-facts
  const ledger = deps.ledger ?? sqlLedgerStore(store, courseOf);

  /** Topic and section labels → concept tags; new labels become model-origin concepts under their section. */
  function tagsFor(courseRef: string, drafts: Draft[]): Map<number, { conceptId: string; primary: boolean }[]> {
    const map = store.learning.concepts(courseRef);
    const live = (kind: Concept["kind"]) => map.filter((c) => c.kind === kind && c.status === "active");
    const find = (kind: Concept["kind"], label: string) =>
      live(kind).find((c) => normaliseLabel(c.studentLabel ?? c.label) === normaliseLabel(label) || normaliseLabel(c.label) === normaliseLabel(label));
    const added: Concept[] = [];
    const add = (kind: Concept["kind"], label: string, parentId: string | null): Concept => {
      const id = conceptId(courseRef, kind, label);
      const existing = map.find((c) => c.id === id) ?? added.find((c) => c.id === id);
      if (existing) return existing;
      const c: Concept = { id, courseRef, parentId, label, kind, position: map.length + added.length, origin: "model", status: "active", mergedInto: null, studentLabel: null, mapVersion: MAP_VERSION, sources: [] };
      added.push(c);
      return c;
    };
    const out = new Map<number, { conceptId: string; primary: boolean }[]>();
    for (const d of drafts) {
      if (!d.section || !d.topics.length || !normaliseLabel(d.section)) continue;
      const unit = find("unit", d.section) ?? add("unit", d.section, null);
      const ids: string[] = [];
      for (const label of d.topics.slice(0, 3)) {
        if (!normaliseLabel(label)) continue;
        const c = find("concept", label) ?? add("concept", label, unit.id);
        if (!ids.includes(c.id)) ids.push(c.id);
      }
      if (ids.length) out.set(d.index, ids.map((id, i) => ({ conceptId: id, primary: i === 0 })));
    }
    if (added.length) store.learning.putConceptMap(courseRef, added, MAP_VERSION);
    return out;
  }

  /** N06 on every draft; accepted versions go to the LearningStore (idempotent for a cache hit). */
  function accept(
    s: Scoped,
    packId: string,
    cacheKey: string,
    drafts: Draft[],
    resourceOf: Map<string, string>,
    generator: { client: string; model: string; promptVersion: string },
  ) {
    const at = now();
    const byId = new Map(s.resources.map((r) => [r.id, r]));
    const eligible = new Set(s.resources.map((r) => r.id));
    const resources: PipelineResource[] = s.resources.map((r) => ({ id: r.id, kind: r.kind, text: r.text, contentHash: r.contentHash }));
    const tags = tagsFor(s.courseRef, drafts);
    const map = store.learning.concepts(s.courseRef);
    const prefix = `${packId}-${cacheKey.slice(0, 16)}`;
    const existing = store.learning.items({ courseRef: s.courseRef });
    const seen = existing.filter((x) => !x.item.id.startsWith(prefix)).map((x) => x.item.stem);
    const itemIds: string[] = [];
    const drops: PackDrop[] = [];
    for (const d of drafts) {
      // A code-derived card (a language card's reverse) is named after the card it comes from.
      const id = d.derivedFrom === undefined ? `${prefix}-${d.index}` : `${prefix}-${d.derivedFrom}r`;
      if (d.problem) {
        drops.push({ index: d.index, stage: "schema", reason: d.problem });
        continue;
      }
      // owner: exam-prep. A problem draft is checked by the exam engine and stored as a problem.
      if (isProblemDraft(d)) {
        const resourceId = resourceOf.get(d.sourceId) ?? "";
        const r = byId.get(resourceId);
        const found = r ? findQuote(r.text, d.quote) : null;
        const checked = checkAuthored(d.solve, {
          id,
          courseRef: s.courseRef,
          resource: r ? { id: r.id, kind: r.kind, text: r.text, contentHash: r.contentHash } : { id: resourceId, kind: "material", text: "", contentHash: "" },
          span: r && found?.status === "unique" ? { start: found.start, end: found.end } : null,
          courseRestricted: s.restricted,
          openGraded: !r || !eligible.has(r.id),
          conceptIds: (tags.get(d.index) ?? []).map((t) => t.conceptId),
          generator,
        });
        if (!checked.problem) {
          const first = checked.reasons[0] ?? "schema: rejected";
          drops.push({ index: d.index, stage: PROBLEM_STAGE[first.split(":")[0]!] ?? "schema", reason: checked.reasons.join("; ") });
          continue;
        }
        putProblem(store.learning, checked.problem, at.toISOString());
        itemIds.push(id);
        continue;
      }
      // end owner: exam-prep
      // Code grounds the quote: the stored quote is the exact span of the current resource text.
      const resourceId = resourceOf.get(d.sourceId) ?? "";
      const r = byId.get(resourceId);
      const found = r ? findQuote(r.text, d.quote) : null;
      const quote = r && found?.status === "unique" ? r.text.slice(found.start, found.end) : d.quote;
      const citation = { resourceId, quote };
      const candidate: CandidateItem = {
        id,
        version: 1,
        familyId: id,
        courseRef: s.courseRef,
        kind: d.kind,
        stem: d.stem,
        options: d.options,
        key: d.key,
        ...(d.unit ? { unit: d.unit } : {}),
        ...(d.formula ? { formula: d.formula } : {}),
        keyIdeas: d.keyIdeas,
        explanation: d.explanation ? { text: d.explanation, citation } : null,
        tempting: {},
        bloom: d.bloom,
        tier: "T4",
        sourceTerm: null,
        origin: "generated",
        generator,
        sources: [citation],
        tags: tags.get(d.index) ?? [],
      };
      const result = runPipeline(candidate, {
        courseRestricted: s.restricted,
        resources,
        validate: findQuote,
        map,
        seenStems: seen,
        now: at,
        isOpenGraded: (res) => !eligible.has(res.id),
      });
      if (!result.accepted || !result.item) {
        drops.push({ index: d.index, stage: result.dropped!.name, reason: result.dropped!.reason });
        continue;
      }
      seen.push(result.item.stem);
      itemIds.push(id);
      if (existing.some((x) => x.item.id === id && x.item.version === 1)) continue;
      store.learning.putItem(result.item, result.sources, result.tags, result.checks);
      if (result.item.kind === "card" && !store.learning.cards({ itemId: id }).length)
        store.learning.putCard({
          ...newCard({ id: `card-${id}`, itemId: id, courseRef: s.courseRef, conceptId: result.tags.find((t) => t.primary)!.conceptId }, at),
          itemVersion: 1,
        });
    }
    return { itemIds, drops };
  }

  async function run(packName: string, scope: PackScope, signal?: AbortSignal, options: GenerateOptions = {}): Promise<PackRunResult> {
    const name = GENERATION_PACKS[packName];
    if (!name) return empty(packName, "unknown_pack", `There's no ${packName} pack.`);
    const s = resolveScope(store, scope);
    if (!s || !s.resources.length)
      return empty(name, "empty", "There's no course material in this scope to study from yet.", s?.courseRef ?? null);
    if (s.restricted) return empty(name, "blocked", "This course restricts AI-made practice, so nothing was generated.", s.courseRef);
    store.learning.course(s.accountScope, s.courseId, s.label);
    // The prompt reads only the course's own map (code- or student-made), never the concepts
    // earlier generations added, so a repeat with unchanged content keeps its cache key.
    const concepts = store.learning.concepts(s.courseRef).filter((c) => c.status === "active" && c.origin !== "model");
    const units = concepts.filter((c) => c.kind === "unit").sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
    const focus = concepts.filter((c) => scope.topicIds?.includes(c.id)).map((c) => c.studentLabel ?? c.label);
    const { passages, resourceOf } = pickPassages(store, s, focus, options.passageTokenBudget ?? PASSAGE_TOKEN_BUDGET);
    if (!passages.length) return empty(name, "empty", "The course material hasn't been split into passages yet. Try again after it syncs.", s.courseRef);
    const input: GenerationInput = {
      count: Math.max(1, Math.min(30, options.count ?? DEFAULT_COUNT[name])),
      sections: units.map((u) => u.studentLabel ?? u.label),
      topics: concepts.filter((c) => c.kind === "concept").map((c) => c.studentLabel ?? c.label).slice(0, 60),
      focus,
      ...(s.family !== "unknown" ? { subject: s.family } : {}),
    };
    // owner: course-facts. The course prefix (brief + pack catalogue); the policy line points at the
    // brief's AI section only when the brief holds every quote behind the policy.
    const prefix = coursePrefix(s.courseRef);
    const base = frameFor(s, units);
    const frame: CourseFrame = prefix
      ? { ...base, brief: prefix.text, ...(s.policy && briefHoldsPolicy(s.policy.evidence, prefix.text) ? { policy: `${s.policy.mode}: ${BRIEF_POLICY_POINTER}` } : {}) }
      : base;
    // end owner: course-facts
    return name === "quiz"
      ? execute(quizPack, quizDrafts, name, scope, { ...s, briefResourceIds: prefix?.resourceIds ?? [] }, passages, resourceOf, input, frame, signal, options)
      : name === "cards"
        ? execute(cardsPack, cardDrafts, name, scope, { ...s, briefResourceIds: prefix?.resourceIds ?? [] }, passages, resourceOf, input, frame, signal, options)
        : execute(problemsPack, problemDrafts, name, scope, { ...s, briefResourceIds: prefix?.resourceIds ?? [] }, passages, resourceOf, input, frame, signal, options); // owner: exam-prep
  }

  async function execute<O>(
    pack: PackSpec<GenerationInput, O>,
    toDrafts: (output: O, passages?: readonly Passage[]) => Draft[],
    name: GenerationPackName,
    scope: PackScope,
    s: Scoped,
    passages: Passage[],
    resourceOf: Map<string, string>,
    input: GenerationInput,
    frame: CourseFrame,
    signal: AbortSignal | undefined,
    options: GenerateOptions,
  ): Promise<PackRunResult> {
    const snapshot = () => payloadHash({
      scope: resolveScope(store, scope), sources: store.sources(), roster: rosterFor(store, s.courseId, s.accountScope).version,
      privacy: store.privacy(), consents: store.consents?.(), concepts: store.learning.concepts(s.courseRef).filter((c) => c.origin !== "model"),
    });
    const fingerprint = snapshot();
    const validate = () => {
      if (signal?.aborted || snapshot() !== fingerprint) throw new PackEgressBlocked("Course evidence or sharing permissions changed. Try again with the current material.");
    };
    const runner = await deps.runner();
    try { validate(); } catch (error) { return empty(name, "blocked", (error as Error).message, s.courseRef); }
    const hosted = runner ? runner.client !== "local" : store.privacy().mode !== "local_only";
    // owner: privacy: the protection pass (roster + code detectors + per-request pseudonyms).
    const scrubber = protectedPayloadScrubber(store, hosted, s.accountScope, `pack:${s.courseRef}`);
    // Course labels, the frame and the assembled prompt are teaching text; a passage is its resource's class.
    const scrub = (value: string) => scrubber.field(value, s.courseId, "teaching");
    const passageClass = (sourceId: string) => { const r = store.resource(resourceOf.get(sourceId) ?? ""); return r ? classOf(r) : "personal"; };
    scrubber.prime([...passages.map((p): [string, "teaching" | "personal"] => [p.text, passageClass(p.sourceId)]), ...[...input.sections, ...input.topics, ...input.focus, frame.course, frame.skeleton, frame.policy].map((t): [string, "teaching"] => [t, "teaching"])], s.courseId);
    // Freeze the exact passage projection; output citations may never search outside it.
    const frozen = new Map(passages.map((p) => [p.sourceId, {
      original: p.text, result: scrubber.text(p.text, s.courseId, passageClass(p.sourceId)),
    }]));
    // The passages as the model saw them: an abbreviated quote is restored against these.
    const seen = [...frozen].map(([sourceId, f]) => ({ sourceId, text: f.result.text }));
    const draftsOf = (output: O) => toDrafts(output, seen).slice(0, input.count).map((d) => {
      const p = frozen.get(d.sourceId);
      const start = p?.result.text.indexOf(d.quote) ?? -1;
      if (!p || !d.quote || start < 0 || p.result.text.indexOf(d.quote, start + 1) >= 0)
        return { ...d, quote: "" };
      const span = toOriginalSpan(p.result, start, start + d.quote.length);
      return span ? { ...d, quote: p.original.slice(span.start, span.end) }
        : { ...d, quote: "" };
    });
    passages = passages.map((p) => ({ ...p, text: frozen.get(p.sourceId)!.result.text }));
    input = { ...input, sections: input.sections.map(scrub), topics: input.topics.map(scrub), focus: input.focus.map(scrub) };
    frame = { ...frame, course: scrub(frame.course), skeleton: scrub(frame.skeleton), policy: scrub(frame.policy), ...(frame.brief !== undefined ? { brief: scrub(frame.brief) } : {}) };
    const prompt = buildPrompt(pack, frame, input, passages);
    const cacheKey = payloadHash({ version: "pack-projection-v1", route: runner?.client ?? store.privacy().hostedProvider, fingerprint, key: packCacheKey(pack, prompt.systemPrompt, input, passages) });
    const receiptIds: string[] = [];
    const lane = options.lane ?? "interactive";

    const at = () => now().toISOString();
    const base = { ...empty(name, "done", "", s.courseRef), receiptIds };
    const finish = (artifact: { id: string; cacheKey: string; client: string; model: string; output: O; usage: PackRunResult["tokens"] }, cached: boolean): PackRunResult => {
      const written = draftsOf(artifact.output);
      // Languages: vocabulary in both directions (plan D35), derived by code at 0 tokens.
      const drafts = name === "cards" && s.family === "languages" ? [...written, ...reverseCards(written)] : written;
      const generator = { client: artifact.client, model: artifact.model, promptVersion: `${pack.id}@${pack.version}` };
      const { itemIds, drops } = accept(s, pack.id, artifact.cacheKey, drafts, resourceOf, generator);
      const droppedBy: Partial<Record<StageName, number>> = {};
      for (const d of drops) droppedBy[d.stage] = (droppedBy[d.stage] ?? 0) + 1;
      return {
        ...base,
        message: `${itemIds.length} ${NOUN[name]} ready${drops.length ? `; ${drops.length} dropped by the checks` : ""}.`,
        artifactIds: [artifact.id],
        itemIds,
        cached,
        tokens: cached ? { in: 0, cached: 0, out: 0 } : artifact.usage,
        counts: { generated: drafts.length, accepted: itemIds.length, dropped: drops.length, droppedBy },
        drops,
      };
    };

    // Study-time rule (spec §2): a cache hit makes no provider call and costs 0 tokens.
    const stored = artifacts.get(cacheKey);
    const parsedHit = stored && pack.schema.safeParse(stored.output);
    const hit = stored && parsedHit?.success ? { ...stored, output: parsedHit.data } : null;
    if (hit) {
      ledger.append({ at: at(), pack: pack.id, packVersion: pack.version, courseId: frame.courseId, cacheKey, outcome: "cache_hit", usage: { in: 0, cached: 0, out: 0 } });
      return finish(hit, true);
    }
    if (!runner) return empty(name, "no_client", "Connect your AI first: choose Claude or Codex in Settings and sign in, then try again.", s.courseRef);

    const authorize = (recipient: string, categories: string[], payload?: unknown) => {
      validate();
      // owner: course-facts: the brief's sources are sent too, so their categories are checked and receipted.
      const briefResources = (s.briefResourceIds ?? []).flatMap((id) => store.resource(id) ?? []);
      categories = [...new Set([...categories, ...s.resources.flatMap(contentCategories), ...briefResources.flatMap(contentCategories)])];
      const parsed = aiRecipientSchema.safeParse(recipient);
      if (!parsed.success) return { allowed: false, reason: "This recipient is not supported." };
      const permission = maySend(store.privacy(), recipient, categories);
      // Generic job checks permissions without consuming a one-shot payload approval.
      if (payload === undefined && permission.allowed) return permission;
      const m = {
        recipient: parsed.data,
        purpose: PURPOSE[name],
        categories,
        resourceIds: [...new Set([...s.resources.map((r) => r.id), ...(s.briefResourceIds ?? [])])],
        characters: JSON.stringify(payload ?? {}).length,
        allowed: permission.allowed,
        reason: permission.reason,
        payload,
        ...(hosted ? { protection: protectionCounts(payload) } : {}), // owner: privacy
      };
      const decision = egressFor(store).check(m, { at: at(), background: lane === "background" });
      if (decision.status === "blocked") {
        receiptIds.push(decision.receiptId);
        return { allowed: false, reason: decision.reason };
      }
      if (decision.status === "preview_required") {
        receiptIds.push(decision.previewId);
        return { allowed: false, reason: decision.reason };
      }
      const receipt = buildReceipt(m, "sent", at());
      store.addReceipt(receipt);
      receiptIds.push(receipt.id);
      return { allowed: true, reason: permission.reason };
    };
    const beforeCall = (call: BackendCall): BackendCall => {
      const outgoing = { ...call, courseId: hosted ? undefined : call.courseId, systemPrompt: scrub(call.systemPrompt), input: scrub(call.input) };
      const recipients = { local: "local", claude: "claude", anthropic: "claude", codex: "codex", openai: "chatgpt", openrouter: "openrouter", gemini: "gemini" };
      const permission = authorize(recipients[runner.client], pack.categories, { systemPrompt: outgoing.systemPrompt, input: outgoing.input, jsonSchema: outgoing.jsonSchema });
      if (!permission.allowed) throw new PackEgressBlocked(permission.reason);
      return outgoing;
    };
    try {
      const result = await runPack(
        { runner, artifacts, ledger, authorize, beforeCall, validate, cacheKey, now: () => now().getTime() },
        pack,
        frame,
        input,
        passages,
        { lane, scope: scope.moduleId ?? (scope.resourceIds?.length ? "resources" : "course"), ...(signal ? { signal } : {}) },
      );
      if (result.status === "blocked") return { ...base, status: "blocked", message: result.reason };
      if (result.status === "paused" || result.status === "failed") return { ...base, status: result.status, message: result.message };
      if (result.status === "needs_student")
        return { ...base, status: "needs_student", message: result.question, options: result.options, checkErrors: result.checkErrors };
      validate();
      return finish(result.artifact, result.cached);
    } catch (error) {
      if (error instanceof PackEgressBlocked) return { ...base, status: "blocked", message: error.message };
      throw error;
    }
  }
  // owner: guides. The study-guide kinds (guide, briefing, faq, timeline, compare, conceptmap)
  // and `<kind>-view`, the 0-token personalised view (op "guide.view"), answer through this seam.
  const guideDeps = { store, runner: deps.runner, artifacts, ledger, now, prefix: coursePrefix /* owner: course-facts */ };
  function guides(packName: string, scope: PackScope, signal?: AbortSignal): Promise<GuideRunResult | GuideViewResult> | null {
    if (isGuideKind(packName)) return generateGuide(guideDeps, packName, scope, signal ? { signal } : {});
    const viewOf = /^([a-z]+)-view$/.exec(packName)?.[1];
    if (viewOf && isGuideKind(viewOf)) return Promise.resolve(guideView(guideDeps, viewOf, scope));
    return null;
  }
  // end owner: guides
  // owner: mastery (D57). "Build my strategy": one checked call over code-derived observations.
  const strategy = (scope: PackScope, signal?: AbortSignal) => buildStrategy({ store, runner: deps.runner, artifacts, ledger, now }, scope, signal);
  // end owner: mastery
  return {
    run,
    guides, // owner: guides
    coursePrefix, // owner: course-facts: the same prefix for ask
    /** The CoreSeams.pack signature. */
    pack: (packName: string, scope: PackScope, signal: AbortSignal, options?: { count?: number }) =>
      (packName === "strategy" ? strategy(scope, signal) /* owner: mastery */ : null) ?? guides(packName, scope, signal) /* owner: guides */ ?? run(packName, scope, signal, options?.count ? { count: options.count } : {}),
  };
}

/**
 * For the eval harness: generate one pack for a scope at scale, through the same path the app
 * uses (cache, consent, runner, N06, LearningStore). Content-hash cached, so reruns are free.
 */
export function generatePack(
  deps: PackHandlerDeps,
  request: { pack: GenerationPackName; scope: PackScope } & GenerateOptions,
  signal?: AbortSignal,
): Promise<PackRunResult> {
  const { pack, scope, ...options } = request;
  return createPackHandler(deps).run(pack, scope, signal, options);
}

// owner: ai-paths
/** Pack id → output schema for every generation pack: the warm pool's union schema. */
export function generationKinds(): PoolOptions["kinds"] {
  return Object.fromEntries([quizPack, cardsPack, problemsPack, ...Object.values(GUIDE_PACKS), courseFactsPack /* owner: course-facts */].map((p) => [p.id, p.schema as PoolOptions["kinds"][string]]));
}
/**
 * The Claude route with one warm session per lane (D38): a follow-up pack call reuses the live
 * process instead of paying a cold start. Other packs and a lane that fails twice go one-shot.
 */
export function pooledClaudeBackend(options: { command: CliCommand; workDir: string; env?: Record<string, string>; extraArgs?: readonly string[] /* owner: client-health */ }): SessionPool {
  // One pool per process: a new one (a client or profile change) closes the previous sessions.
  void currentPool?.close();
  // Generation keeps its session's turns (the pool's behaviour before `turns: "fresh"` became the
  // command bar's default); whether earlier generations should be re-sent is a separate decision.
  currentPool = createSessionPool({ ...options, kinds: generationKinds(), fallback: createClaudeBackend(options), turns: "conversation" });
  return currentPool;
}
let currentPool: SessionPool | null = null;
// end owner: ai-paths
