/**
 * owner: study-prep. The study actions' generation, through the existing `pack` command
 * (`study-prep-guide`, `study-prep-cards-exam`, …): one checked call on the student's own client for
 * every kind asked together, cached, consented and receipted like every pack. And the grounded
 * ask (`notebook.ask`), the existing ask limited to the item's ticked sources.
 *
 * Infrastructure decisions (see also records.ts and the pack):
 * 1. Retrieval, not whole documents: the context is FTS/BM25 passages over the ticked sources (the
 *    item and its stated scope first, then each topic, then round-robin), within
 *    PREP_PASSAGE_BUDGET tokens.
 * 2. The course brief (syllabus.md) is the byte-stable system prefix, shared with every pack.
 * 3. Kinds asked together share one call; kinds asked apart reuse the same stored passage set, so
 *    everything before the pack's `## Write` section is byte-identical.
 * 4. Results are kept per (item, source-set hash, kind); a kind whose sources' content hashes are
 *    unchanged is served at 0 tokens without a call.
 * 5. Nothing runs until the student asks; the query never calls a model.
 * 6. Everything carries its passage ids and quotes, checked by code (the quote exists verbatim; a
 *    multiple-choice key is one of its options; numbers recompute; expressions prove equivalent;
 *    a problem never nearly copies a past exam or the assigned work; exam points add up).
 */
import { aiRecipientSchema, ITEM_SPACE, type LearningResult, type PackScope, type Resource, type StudyPrepExamProblem, type StudyPrepGuide, type StudyPrepKind, type StudyPrepOutline, type StudyPrepQuote } from "@magic/contracts";
import { maySend } from "@magic/domain";
import type { BackendCall, ModelRunner } from "../../../runner/src/index";
import { buildPrompt, packCacheKey, type ArtifactStore, type CourseFrame, type LedgerStore, type Passage } from "../../../packs/core/src/index";
import { OPTION_IDS, quizDrafts, type Draft } from "../../../packs/items/src/index";
import { cardDrafts, reverseCards } from "../../../packs/cards/src/index";
import { reviewGuide, type Resolve } from "../../../packs/guide/src/index";
import {
  guideInputOf,
  nearCopyOf,
  outlineProblems,
  problemErrors,
  studyPrepPack,
  STUDY_PREP_PACK_VERSION,
  type PrepInput,
  type ProblemOutput,
  type StudyPrepOutput,
} from "../../../packs/study-prep/src/index";
import { subjectFamily } from "../../../notes/src/templates/index";
import { normaliseLabel } from "../../../learning/src/concepts";
import { findQuote } from "../../../retrieval/src/quotes";
import type { StageName } from "../../../learning/src/items";
import { runPack } from "../jobs/pack";
import { buildReceipt, egressFor, payloadHash } from "../egress";
import { contentCategories } from "../access";
import { rosterFor, toOriginalSpan } from "../identity";
import { classOf, protectedPayloadScrubber, protectionCounts } from "../privacy/protect"; // owner: privacy
import type { CoursePrefixSource } from "../course-facts/prefix"; // owner: course-facts
import { BRIEF_POLICY_POINTER, briefHoldsPolicy } from "../course-facts/brief"; // owner: course-facts
import { groundedAsk, NOT_IN_MATERIALS } from "../intent/ask";
import { intentProtection } from "../privacy/intent";
import { clip, collapse, courseScope, loadPrep, selectScope, sha, type Prep, type PrepStore, type Selection } from "./scope";
import { readPassageSet, readRecord, writePassageSet, writeRecord, type PrepRecord } from "./records";
import { changedSince } from "./query";
import { addLinks, type ItemLinks } from "./links";

/** Passage tokens per call (the store's estimate): the context budget for retrieval. */
export const PREP_PASSAGE_BUDGET = 7000;
const MAX_PASSAGES = 40;
const PER_QUERY = 2;
const MAX_QUERIES = 24;
const FACT_CHARS = 3000;
export const PREP_COUNTS = { quiz: 10, cards: 12, problems: 5 };
const NOT_SPLIT = "The course material hasn't been split into passages yet. Try again after it syncs.";
const NOUN: Record<StudyPrepKind, string> = { guide: "study guide", quiz: "practice quiz", cards: "flashcards", exam: "practice exam", problems: "practice problems", outline: "outline coach" };

export type PrepRunStatus = "done" | "needs_student" | "blocked" | "paused" | "failed" | "no_client" | "empty";
export interface PrepKindCounts {
  generated: number;
  accepted: number;
  dropped: number;
}
/** The `pack` command's result for a study-prep pack. */
export interface StudyPrepRunResult {
  status: PrepRunStatus;
  message: string;
  pack: string;
  courseRef: string | null;
  kinds: StudyPrepKind[];
  /** Kinds already current for this selection: served without a call. */
  current: StudyPrepKind[];
  cached: boolean;
  tokens: { in: number; cached: number; out: number };
  counts: Partial<Record<StudyPrepKind, PrepKindCounts>>;
  drops: { kind: StudyPrepKind; at: string; reason: string; stage?: StageName }[];
  receiptIds: string[];
  /** The assembled prompt's size (characters, and characters / 4 as a token estimate), for the efficiency report. */
  prompt: { chars: number; tokensEst: number; passages: number; prefixChars: number; reusedPassages: boolean } | null;
  scopeHash: string | null;
  options?: ("retry" | "narrow_scope" | "skip")[];
  checkErrors?: string[];
}

type Accept = (
  s: { courseRef: string; resources: Resource[]; restricted: boolean },
  packId: string,
  cacheKey: string,
  drafts: Draft[],
  resourceOf: Map<string, string>,
  generator: { client: string; model: string; promptVersion: string },
) => { itemIds: string[]; drops: { index: number; stage: StageName; reason: string }[] };

export interface StudyPrepDeps {
  store: PrepStore;
  runner: () => ModelRunner | null | Promise<ModelRunner | null>;
  artifacts: ArtifactStore;
  ledger: LedgerStore;
  now: () => Date;
  prefix: CoursePrefixSource;
  /** The pack handler's checked-item pipeline (N06) and LearningStore writer. */
  accept: Accept;
}

class PrepEgressBlocked extends Error {}
const RECIPIENT: Record<string, string> = { local: "local", claude: "claude", anthropic: "claude", codex: "codex", openai: "chatgpt", openrouter: "openrouter", gemini: "gemini" };
const zero = () => ({ in: 0, cached: 0, out: 0 });

/**
 * The passages for a selection: search hits for the item (and its stated scope) and each topic,
 * then round-robin by source, within the budget. Stored per (selection, source content), so every
 * later kind on the same selection sends exactly the same passages, even when other course material
 * shifts the search ranking.
 */
export function prepPassages(store: PrepStore, prep: Prep, sel: Selection, focus: string[], topics: string[], budget: number, at: string): { passages: Passage[]; resourceOf: Map<string, string>; reused: boolean } {
  const allowed = new Set(sel.resourceIds);
  const ref = { accountScope: prep.accountScope, courseId: prep.courseId };
  const content = sha([sel.resources.map((r) => [r.id, r.contentHash]), focus, budget]);
  const build = (pids: number[]) => {
    const passages: Passage[] = [];
    const resourceOf = new Map<string, string>();
    for (const pid of pids) {
      const p = store.passage(pid);
      if (!p || p.passage.redacted || !allowed.has(p.passage.resourceId) || !p.text.trim()) return null;
      passages.push({ sourceId: `p${pid}`, text: p.text });
      resourceOf.set(`p${pid}`, p.passage.resourceId);
    }
    return { passages, resourceOf };
  };
  const stored = readPassageSet(store.learning, prep.courseRef, prep.subject.id, sel.hash, content);
  const again = stored && stored.length ? build(stored) : null;
  if (again) return { ...again, reused: true };

  const pids: number[] = [];
  const statements = (prep.blueprint?.scope.statements ?? []).map((s) => s.quote ?? "").filter(Boolean);
  const queries = [[prep.subject.title, ...statements].join(" "), ...(focus.length ? focus : topics)].slice(0, MAX_QUERIES);
  for (const q of queries) {
    const hits = store.searchPassages({ query: clip(q, 500), courses: [ref], k: 8 });
    let taken = 0;
    for (const h of hits.hits)
      if (taken < PER_QUERY && allowed.has(h.resourceId) && !pids.includes(h.pid)) {
        pids.push(h.pid);
        taken++;
      }
  }
  const lists = sel.resources.map((r) => store.passages(r.id).filter((p) => !p.redacted));
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (l[i] && !pids.includes(l[i]!.pid)) pids.push(l[i]!.pid);
  const chosen: number[] = [];
  let used = 0;
  for (const pid of pids) {
    if (chosen.length >= MAX_PASSAGES) break;
    const p = store.passage(pid);
    if (!p || p.passage.redacted || !allowed.has(p.passage.resourceId) || !p.text.trim()) continue;
    if (used + p.passage.tokEst > budget && chosen.length) continue;
    used += p.passage.tokEst;
    chosen.push(pid);
  }
  // Course order within the set, so the prompt reads like the course.
  const rank = new Map(sel.resources.map((r, i) => [r.id, i]));
  chosen.sort((x, y) => {
    const px = store.passage(x)!.passage, py = store.passage(y)!.passage;
    return rank.get(px.resourceId)! - rank.get(py.resourceId)! || px.start - py.start;
  });
  if (chosen.length) writePassageSet(store.learning, prep.courseRef, prep.subject.id, sel.hash, content, chosen, at);
  return { ...(build(chosen) ?? { passages: [], resourceOf: new Map() }), reused: false };
}

const FORMAT_WORD: Record<string, string> = { multiple_choice: "multiple choice", true_false: "true/false", short_answer: "short answer", numeric: "numeric", problem: "worked problems", essay: "essay", code: "code", proof: "proofs", matching: "matching", fill_blank: "fill in the blank" };
/** The form a practice exam mirrors, from the blueprint (sections, formats, points, length). */
function examForm(prep: Prep): PrepInput["exam"] {
  const bp = prep.blueprint;
  if (!bp) return { form: "the question types this course uses", totalPoints: null, minutes: null, problems: 8 };
  const sections = bp.sections.map((s) => {
    const formats = s.formats.map((f) => FORMAT_WORD[f.format] ?? f.format).join(" and ");
    return `${s.label}: ${formats || "problems"}${s.items ? `, ${s.items} problem${s.items === 1 ? "" : "s"}` : ""}${s.points !== null ? `, ${s.points} points` : ""}`;
  });
  const items = bp.sections.reduce((n, s) => n + (s.items ?? 0), 0);
  const form = [sections.length ? sections.join("; ") : "the question types this course uses", bp.length ? `${bp.length.minutes} minutes` : "", bp.totalPoints ? `${bp.totalPoints.value} points in total` : ""].filter(Boolean).join(". ");
  return { form, totalPoints: bp.totalPoints?.value ?? null, minutes: bp.length?.minutes ?? null, problems: items >= 2 && items <= 30 ? items : 8 };
}

export function createStudyPrep(deps: StudyPrepDeps) {
  const { store, now } = deps;
  const at = () => now().toISOString();

  function empty(kinds: StudyPrepKind[], status: PrepRunStatus, message: string, courseRef: string | null = null): StudyPrepRunResult {
    return { status, message, pack: studyPrepPack.id, courseRef, kinds, current: [], cached: false, tokens: zero(), counts: {}, drops: [], receiptIds: [], prompt: null, scopeHash: null };
  }

  async function generate(kinds: StudyPrepKind[], scope: PackScope, signal?: AbortSignal, options: { lane?: "interactive" | "background"; passageTokenBudget?: number } = {}): Promise<StudyPrepRunResult> {
    if (!scope.assessmentId) return empty(kinds, "empty", "Choose an item first.");
    const prep = loadPrep(store, scope.courseId, scope.assessmentId, now());
    if ("status" in prep) return empty(kinds, "empty", prep.message);
    if (prep.restricted) return empty(kinds, "blocked", "This course restricts AI-made study material, so nothing was generated.", prep.courseRef);
    const config = ITEM_SPACE[prep.subject.type];
    const sel = selectScope(prep, { ...(scope.resourceIds ? { resourceIds: scope.resourceIds } : {}), ...(scope.topicIds ? { topicIds: scope.topicIds } : {}) });
    if (!sel.resources.length) return empty(kinds, "empty", "Tick at least one source to study from.", prep.courseRef);
    const itemId = prep.subject.id;
    const records = new Map(kinds.map((k) => [k, readRecord(store.learning, prep.courseRef, itemId, sel.hash, k)] as const));
    // Item 4: a kind made from the same source content is current; it costs nothing to serve.
    const current = kinds.filter((k) => {
      const r = records.get(k);
      return r?.status === "ready" && r.packVersion === STUDY_PREP_PACK_VERSION && !changedSince(r, sel).length;
    });
    const todo = kinds.filter((k) => !current.includes(k));
    const result = (partial: Partial<StudyPrepRunResult> & Pick<StudyPrepRunResult, "status" | "message">): StudyPrepRunResult => ({
      ...empty(kinds, partial.status, partial.message, prep.courseRef),
      current,
      scopeHash: sel.hash,
      ...partial,
    });
    if (!todo.length) return result({ status: "done", message: "Already made from the current sources.", cached: true });
    store.learning.course(prep.accountScope, prep.courseId, prep.label);

    // The prompt reads the course's own map only (never generation-made concepts), so a later
    // generation's new topics can't change the prompt of the next one.
    const own = prep.concepts.filter((c) => c.origin !== "model");
    const units = own.filter((c) => c.kind === "unit").sort((x, y) => x.position - y.position || x.id.localeCompare(y.id));
    const ownIds = new Set(own.map((c) => c.id));
    const topics = prep.topics.filter((t) => ownIds.has(t.id)).map((t) => t.label);
    const focus = prep.topics.filter((t) => sel.topicIds.includes(t.id)).map((t) => t.label);
    const { passages: original, resourceOf, reused } = prepPassages(store, prep, sel, focus, topics, options.passageTokenBudget ?? PREP_PASSAGE_BUDGET, at());
    if (!original.length) return result({ status: "empty", message: NOT_SPLIT });

    const s = prep.subject;
    const stated = (prep.blueprint?.scope.statements ?? []).map((x) => collapse(x.quote ?? "")).filter(Boolean);
    const facts: string[] = [];
    let factChars = 0;
    for (const r of sel.resources)
      for (const f of prep.facts(r.id)) {
        if (f.kind !== "term" && f.kind !== "definition" && f.kind !== "formula") continue;
        const line = `${f.kind}: ${clip(collapse(f.value), 200)}`;
        if (facts.includes(line) || factChars + line.length > FACT_CHARS) continue;
        facts.push(line);
        factChars += line.length;
      }
    const courseCode = sel.resources.find((r) => r.course?.courseCode)?.course?.courseCode ?? prep.resources.find((r) => r.course?.courseCode)?.course?.courseCode ?? null;
    const family = subjectFamily({ courseName: prep.label, courseCode }).family;
    let input: PrepInput = {
      kinds: todo,
      counts: PREP_COUNTS,
      itemType: s.type,
      authored: config.authored,
      scope: `${config.label}: ${s.title}${s.date ? ` (${s.date.slice(0, 10)})` : ""}${stated.length ? `. Stated scope: ${clip(stated.join(" "), 600)}` : ""}`,
      materials: sel.resources.map((r) => clip(collapse(r.title), 160)),
      sections: units.map((u) => u.studentLabel ?? u.label),
      topics,
      focus,
      facts,
      ...(family !== "unknown" ? { subject: family } : {}),
      exam: todo.includes("exam") ? examForm(prep) : null,
    };
    // owner: course-facts. The course prefix (brief + pack catalogue) opens the prompt.
    const prefix = deps.prefix(prep.courseRef);
    const policy = prep.policy;
    let frame: CourseFrame = {
      courseId: prep.courseRef,
      course: prep.label,
      skeleton: [`Course: ${prep.label}`, ...units.map((u) => `Section: ${u.studentLabel ?? u.label}`)].join("\n"),
      policy: policy ? `${policy.mode}: ${policy.evidence}` : "",
      ...(prefix ? { brief: prefix.text, ...(policy && briefHoldsPolicy(policy.evidence, prefix.text) ? { policy: `${policy.mode}: ${BRIEF_POLICY_POINTER}` } : {}) } : {}),
    };
    const briefResourceIds = prefix?.resourceIds ?? [];

    // As every pack: the evidence and permissions are fingerprinted; a change before the call blocks it.
    const snapshot = () =>
      payloadHash({
        scope: sel.resources.map((r) => {
          const x = store.resource(r.id);
          return [r.id, x?.contentHash, x?.deleted, x?.policy.mode];
        }),
        sources: store.sources(),
        roster: rosterFor(store, prep.courseId, prep.accountScope).version,
        privacy: store.privacy(),
        consents: store.consents?.(),
        concepts: own,
      });
    const fingerprint = snapshot();
    const validate = () => {
      if (signal?.aborted || snapshot() !== fingerprint) throw new PrepEgressBlocked("Course evidence or sharing permissions changed. Try again with the current material.");
    };
    const runner = await deps.runner();
    const hosted = runner ? runner.client !== "local" : store.privacy().mode !== "local_only";
    // owner: privacy: the protection pass (roster + code detectors + per-request pseudonyms).
    const scrubber = protectedPayloadScrubber(store, hosted, prep.accountScope, `study-prep:${prep.courseRef}`);
    const scrub = (value: string) => scrubber.field(value, prep.courseId, "teaching");
    const passageClass = (sourceId: string) => {
      const r = store.resource(resourceOf.get(sourceId) ?? "");
      return r ? classOf(r) : "personal";
    };
    scrubber.prime(
      [
        ...original.map((p): [string, "teaching" | "personal"] => [p.text, passageClass(p.sourceId)]),
        ...[input.scope, ...input.materials, ...input.sections, ...input.topics, ...input.focus, ...input.facts, input.exam?.form ?? "", frame.course, frame.skeleton, frame.policy].map((t): [string, "teaching"] => [t, "teaching"]),
      ],
      prep.courseId,
    );
    const frozen = new Map(original.map((p) => [p.sourceId, { original: p.text, result: scrubber.text(p.text, prep.courseId, passageClass(p.sourceId)) }]));
    const toOriginal = (sourceId: string | null, quote: string | null): string => {
      const p = sourceId ? frozen.get(sourceId) : undefined;
      if (!p || !quote) return quote ?? "";
      const found = findQuote(p.result.text, quote);
      const hit = found.status === "unique" ? found : found.status === "ambiguous" ? found.occurrences[0]! : null;
      const span = hit && toOriginalSpan(p.result, hit.start, hit.end);
      return span ? p.original.slice(span.start, span.end) : "";
    };
    const passages = original.map((p) => ({ ...p, text: frozen.get(p.sourceId)!.result.text }));
    input = {
      ...input,
      scope: scrub(input.scope),
      materials: input.materials.map(scrub),
      sections: input.sections.map(scrub),
      topics: input.topics.map(scrub),
      focus: input.focus.map(scrub),
      facts: input.facts.map(scrub),
      ...(input.exam ? { exam: { ...input.exam, form: scrub(input.exam.form) } } : {}),
    };
    frame = { ...frame, course: scrub(frame.course), skeleton: scrub(frame.skeleton), policy: scrub(frame.policy), ...(frame.brief !== undefined ? { brief: scrub(frame.brief) } : {}) };
    const prompt = buildPrompt(studyPrepPack, frame, input, passages);
    const cacheKey = payloadHash({ version: "study-prep-projection-v1", route: runner?.client ?? store.privacy().hostedProvider, fingerprint, key: packCacheKey(studyPrepPack, prompt.systemPrompt, input, passages) });
    const chars = prompt.systemPrompt.length + prompt.input.length;
    const promptInfo = { chars, tokensEst: Math.ceil(chars / 4), passages: passages.length, prefixChars: prompt.systemPrompt.length, reusedPassages: reused };
    const receiptIds: string[] = [];

    // Progress: each kind being made reads `generating` in the query until this call settles.
    const started = at();
    const prior = (k: StudyPrepKind) => {
      const r = records.get(k);
      if (!r) return null;
      const { previous, ...rest } = r;
      return r.status === "ready" ? rest : (previous ?? null);
    };
    const mark = (k: StudyPrepKind, patch: Partial<PrepRecord>) =>
      writeRecord(
        store.learning,
        prep.courseRef,
        itemId,
        sel.hash,
        { v: 1, kind: k, status: "generating", startedAt: started, generatedAt: null, message: null, packVersion: STUDY_PREP_PACK_VERSION, sources: [], guide: null, itemIds: [], dropped: 0, tokens: zero(), previous: prior(k), ...patch },
        at(),
      );
    for (const k of todo) mark(k, {});
    const fail = (status: PrepRunStatus, message: string, extra: Partial<StudyPrepRunResult> = {}) => {
      for (const k of todo) mark(k, { status: "failed", message });
      return result({ status, message, receiptIds, prompt: promptInfo, ...extra });
    };

    const byId = new Map(sel.resources.map((r) => [r.id, r]));
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
    const grounded = (sourceId: string, quote: string): StudyPrepQuote | null => {
      const span = resolve(sourceId, toOriginal(sourceId, quote));
      if (!span) return null;
      const r = byId.get(span.resourceId)!;
      return { resourceId: r.id, title: r.title, url: r.url || null, quote: span.quote, start: span.start, end: span.end };
    };
    // What a problem must never copy: the instructor's practice and past exams, and (for authored work) the assigned task.
    const references = [
      ...prep.docs.map((d) => ({ label: d.material.title, text: d.material.text })),
      ...prep.sources.filter((x) => x.role === "practice_exam" || x.role === "past_exam" || x.role === "solutions").map((x) => ({ label: x.title, text: x.resource.text })),
      ...(config.authored && s.resource ? [{ label: `${s.title} (the assigned work)`, text: s.resource.text }] : []),
    ];
    const scopeLabels = new Map(prep.topics.map((t) => [normaliseLabel(t.label), t.label]));

    const finish = (artifact: { id: string; cacheKey: string; client: string; model: string; output: StudyPrepOutput; usage: StudyPrepRunResult["tokens"] }, cached: boolean): StudyPrepRunResult => {
      const out = artifact.output;
      const generator = { client: artifact.client, model: artifact.model, promptVersion: `${studyPrepPack.id}@${studyPrepPack.version}` };
      const counts: StudyPrepRunResult["counts"] = {};
      const drops: StudyPrepRunResult["drops"] = [];
      const sources = sel.resources.map((r) => ({ resourceId: r.id, contentHash: r.contentHash, title: r.title }));
      const scoped = { courseRef: prep.courseRef, resources: sel.resources, restricted: prep.restricted };
      const context = { passages: original };
      const done = (k: StudyPrepKind, patch: Partial<PrepRecord>) => mark(k, { status: "ready", generatedAt: at(), sources, tokens: cached ? zero() : artifact.usage, previous: null, ...patch });
      if (todo.includes("guide")) {
        const g = out.guide ? { ...out.guide, sections: out.guide.sections.map((sec) => ({ ...sec, blocks: sec.blocks.map((b) => ({ ...b, quote: toOriginal(b.sourceId, b.quote) })) })) } : { title: "", sections: [] };
        const review = reviewGuide("guide", g, guideInputOf(input), original, resolve);
        const guide: StudyPrepGuide = {
          title: review.doc.title,
          sections: review.doc.sections.map((sec) => ({
            id: sec.id,
            title: sec.title,
            topics: sec.topics,
            blocks: sec.blocks.map((b) => {
              const r = b.source.resourceId ? byId.get(b.source.resourceId) : undefined;
              return { id: b.id, kind: b.kind as "point" | "definition" | "example", topic: b.topic, heading: b.heading, text: b.text, expression: b.expression, computed: b.computed, source: { resourceId: b.source.resourceId, title: r?.title ?? "", url: r?.url ?? null, quote: b.source.quote, start: b.source.start, end: b.source.end } };
            }),
          })),
        };
        counts.guide = { generated: review.stats.generated, accepted: review.stats.accepted, dropped: review.drops.length };
        for (const d of review.drops) drops.push({ kind: "guide", at: d.at, reason: d.reason });
        done("guide", { guide, dropped: review.drops.length, message: review.stats.accepted ? null : "Nothing in the guide passed the checks." });
      }
      const links: Record<string, ItemLinks> = {};
      const items = (k: "quiz" | "cards", drafts: Draft[]) => {
        const mapped = drafts.map((d) => ({ ...d, quote: toOriginal(d.sourceId, d.quote) }));
        const all = k === "cards" && family === "languages" ? [...mapped, ...reverseCards(mapped)] : mapped;
        const packId = `${studyPrepPack.id}-${k}`;
        const accepted = deps.accept(scoped, packId, artifact.cacheKey, all, resourceOf, generator);
        counts[k] = { generated: all.length, accepted: accepted.itemIds.length, dropped: accepted.drops.length };
        for (const d of accepted.drops) drops.push({ kind: k, at: `${k === "quiz" ? "question" : "card"} ${d.index + 1}`, reason: d.reason, stage: d.stage });
        // Links: the item it was made for, its source's assignments and module, its topics and passage.
        const prefixId = `${packId}-${artifact.cacheKey.slice(0, 16)}`;
        const stored = new Map(store.learning.items({ courseRef: prep.courseRef }).filter((x) => accepted.itemIds.includes(x.item.id)).map((x) => [x.item.id, x]));
        const parentOf = new Map(prep.concepts.map((c) => [c.id, c.parentId]));
        for (const d of all) {
          const id = d.derivedFrom === undefined ? `${prefixId}-${d.index}` : `${prefixId}-${d.derivedFrom}r`;
          const x = stored.get(id);
          if (!x) continue;
          const resourceId = resourceOf.get(d.sourceId) ?? null;
          const source = prep.sources.find((y) => y.resourceId === resourceId);
          const topicIds = x.tags.map((t) => t.conceptId);
          links[id] = {
            forItems: [itemId],
            assignmentIds: [...new Set([...(source?.assignmentIds ?? []), ...(source?.resource.kind === "assignment" ? [source.resourceId] : [])])],
            moduleIds: [...new Set([...topicIds.map((t) => parentOf.get(t)).filter((p): p is string => !!p), ...(source?.moduleId ? [source.moduleId] : [])])],
            topicIds,
            passageIds: [d.sourceId],
          };
        }
        done(k, { itemIds: accepted.itemIds, dropped: accepted.drops.length });
      };
      if (todo.includes("quiz")) items("quiz", out.quiz ? quizDrafts(out.quiz).slice(0, input.counts.quiz) : []);
      if (todo.includes("cards")) items("cards", out.cards ? cardDrafts(out.cards).slice(0, input.counts.cards) : []);
      if (Object.keys(links).length) addLinks(store.learning, prep.courseRef, links, at());

      const problems = (k: "exam" | "problems", list: ProblemOutput[]): StudyPrepExamProblem[] => {
        const kept: StudyPrepExamProblem[] = [];
        list.forEach((p, i) => {
          const where = `problem ${p.number}`;
          const mapped = { ...p, sources: p.sources.map((x) => ({ ...x, quote: toOriginal(x.sourceId, x.quote) })) };
          const errors = problemErrors(mapped, context);
          const copy = nearCopyOf(`${p.prompt}\n${(p.options ?? []).map((o) => o.text).join("\n")}`, references);
          if (copy) errors.push(`nearly copies ${copy}`);
          if (errors.length) return void drops.push({ kind: k, at: where, reason: errors.join("; ") });
          const quotes = mapped.sources.map((x) => grounded(x.sourceId, x.quote)).filter((q): q is StudyPrepQuote => !!q);
          const options = p.options ? p.options.map((o, j) => ({ id: OPTION_IDS[j] ?? `o${j}`, text: o.text })) : null;
          const key = p.options ? OPTION_IDS[p.options.findIndex((o) => o.correct)] : undefined;
          const verified = p.answer.kind === "choice" ? "key" : p.answer.kind === "numeric" && p.answer.formula ? "recomputed" : p.answer.kind === "expression" && p.answer.derivation ? "symbolic" : "self_marked";
          kept.push({
            id: `${k}-${i}`,
            number: p.number,
            section: p.section,
            points: p.points,
            format: p.format,
            topic: scopeLabels.get(normaliseLabel(p.topic)) ?? p.topic,
            prompt: p.prompt,
            options,
            answer:
              p.answer.kind === "choice" && key ? { kind: "choice", key } : p.answer.kind === "numeric" && p.answer.value !== null ? { kind: "numeric", value: p.answer.value, unit: p.answer.unit } : p.answer.kind === "expression" && p.answer.expr ? { kind: "expression", expr: p.answer.expr } : null,
            solution: p.solution,
            verified,
            sources: quotes,
          });
        });
        counts[k] = { generated: list.length, accepted: kept.length, dropped: list.length - kept.length };
        return kept;
      };
      if (todo.includes("exam")) {
        const kept = problems("exam", out.exam?.problems ?? []);
        const total = kept.reduce((n, p) => n + (p.points ?? 0), 0);
        const covered = new Set(kept.map((p) => normaliseLabel(p.topic)).filter((t) => scopeLabels.has(t)));
        const primary = prep.docs.find((d) => d.kind === "practice_exam") ?? prep.docs.find((d) => d.kind === "past_exam") ?? null;
        const basis = [
          primary ? `Modelled on ${primary.material.title}` : "Modelled on the course's exam format",
          `${kept.length} problem${kept.length === 1 ? "" : "s"}`,
          total ? `${total} points` : "",
          scopeLabels.size ? `covers ${covered.size} of ${scopeLabels.size} topics` : "",
        ].filter(Boolean).join(", ");
        done("exam", { exam: { title: out.exam?.title ?? `${s.title} practice exam`, minutes: out.exam?.minutes ?? input.exam?.minutes ?? null, totalPoints: total || null, basis, problems: kept }, dropped: counts.exam!.dropped });
      }
      if (todo.includes("problems")) {
        const kept = problems("problems", out.problems?.problems ?? []);
        done("problems", { problems: kept, dropped: counts.problems!.dropped });
      }
      if (todo.includes("outline")) {
        const o = out.outline;
        const issues = o ? outlineProblems(o) : ["nothing was returned"];
        const ask = (q: string) => q.trim().endsWith("?");
        const outline: StudyPrepOutline | null = o
          ? {
              title: o.title,
              focus: o.focus.filter(ask),
              sections: o.sections
                .filter((x) => x.heading.split(/\s+/).length <= 12)
                .map((x) => ({ heading: x.heading, questions: x.questions.filter(ask), evidence: x.evidence.flatMap((e) => { const q = grounded(e.sourceId, e.quote); return q ? [{ hint: e.hint, source: q }] : []; }) })),
            }
          : null;
        for (const i of issues) drops.push({ kind: "outline", at: "outline", reason: i });
        const n = outline ? outline.focus.length + outline.sections.reduce((m, x) => m + x.questions.length, 0) : 0;
        counts.outline = { generated: n + issues.length, accepted: n, dropped: issues.length };
        done("outline", { outline, dropped: issues.length });
      }
      const made = todo.map((k) => `${NOUN[k]} (${counts[k]?.accepted ?? 0})`).join(", ");
      return result({ status: "done", message: `Made ${made}${drops.length ? `; ${drops.length} dropped by the checks` : ""}.`, cached, tokens: cached ? zero() : artifact.usage, counts, drops, receiptIds, prompt: promptInfo });
    };

    // Study-time rule: a cache hit makes no provider call and costs 0 tokens.
    const storedArtifact = deps.artifacts.get(cacheKey);
    const parsed = storedArtifact && studyPrepPack.schema.safeParse(storedArtifact.output);
    if (storedArtifact && parsed?.success) {
      deps.ledger.append({ at: at(), pack: studyPrepPack.id, packVersion: studyPrepPack.version, courseId: frame.courseId, cacheKey, outcome: "cache_hit", usage: zero() });
      return finish({ ...storedArtifact, output: parsed.data }, true);
    }
    if (!runner) return fail("no_client", "Connect your AI first: choose Claude or Codex in Settings and sign in, then try again.");
    try {
      validate();
    } catch (error) {
      return fail("blocked", (error as Error).message);
    }
    const lane = options.lane ?? "interactive";
    const authorize = (recipient: string, categories: string[], payload?: unknown) => {
      validate();
      const briefResources = briefResourceIds.flatMap((id) => store.resource(id) ?? []);
      categories = [...new Set([...categories, ...sel.resources.flatMap(contentCategories), ...briefResources.flatMap(contentCategories)])];
      const parsedRecipient = aiRecipientSchema.safeParse(recipient);
      if (!parsedRecipient.success) return { allowed: false, reason: "This recipient is not supported." };
      const permission = maySend(store.privacy(), recipient, categories);
      if (payload === undefined && permission.allowed) return permission;
      const m = {
        recipient: parsedRecipient.data,
        purpose: `Make ${todo.map((k) => NOUN[k]).join(", ")} for ${s.title} from course materials`,
        categories,
        resourceIds: [...new Set([...sel.resources.map((r) => r.id), ...briefResourceIds])],
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
      const permission = authorize(RECIPIENT[runner.client] ?? runner.client, studyPrepPack.categories, { systemPrompt: outgoing.systemPrompt, input: outgoing.input, jsonSchema: outgoing.jsonSchema });
      if (!permission.allowed) throw new PrepEgressBlocked(permission.reason);
      return outgoing;
    };
    try {
      const run = await runPack(
        { runner, artifacts: deps.artifacts, ledger: deps.ledger, authorize, beforeCall, validate, cacheKey, now: () => now().getTime() },
        studyPrepPack,
        frame,
        input,
        passages,
        { lane, scope: `${itemId}:${sel.hash}`, ...(signal ? { signal } : {}) },
      );
      if (run.status === "blocked") return fail("blocked", run.reason);
      if (run.status === "paused" || run.status === "failed") return fail(run.status, run.message);
      if (run.status === "needs_student") return fail("needs_student", run.question, { options: run.options, checkErrors: run.checkErrors });
      validate();
      return finish(run.artifact, run.cached);
    } catch (error) {
      if (error instanceof PrepEgressBlocked) return fail("blocked", error.message);
      fail("failed", "Generation stopped unexpectedly. Try again.");
      throw error;
    }
  }

  /**
   * `notebook.ask` for an item's space: the existing grounded ask (retrieval, the coverage gate,
   * one checked call, every quote found in its passage), limited to the item's ticked sources.
   */
  async function ask(request: { courseId: string; question: string; scope?: { assessmentId?: string; resourceIds?: string[] } }, signal: AbortSignal): Promise<LearningResult> {
    const op = "notebook.ask" as const;
    let allowed: string[] | undefined = request.scope?.resourceIds;
    let ref: { accountScope: string; courseId: string; courseRef: string; label: string } | null = null;
    if (request.scope?.assessmentId) {
      const prep = loadPrep(store, request.courseId, request.scope.assessmentId, now());
      if ("status" in prep) return { op, status: "unavailable", message: prep.message };
      allowed = selectScope(prep, request.scope.resourceIds ? { resourceIds: request.scope.resourceIds } : {}).resourceIds;
      ref = { accountScope: prep.accountScope, courseId: prep.courseId, courseRef: prep.courseRef, label: prep.label };
    } else {
      const accountScope = courseScope(store, request.courseId);
      if (accountScope) {
        const label = store.resources().find((r) => r.courseId === request.courseId && r.courseName)?.courseName ?? request.courseId;
        ref = { accountScope, courseId: request.courseId, courseRef: `${accountScope}:${request.courseId}`, label };
      }
    }
    if (!ref) return { op, status: "ok", data: { text: NOT_IN_MATERIALS, citations: [], notFound: true, dropped: 0, path: "none", tokens: zero() } };
    if (allowed && !allowed.length) return { op, status: "unavailable", message: "Tick at least one source to ask about." };
    const answer = await groundedAsk(
      { store, runner: async () => deps.runner(), artifacts: deps.artifacts, ledger: deps.ledger, now, protection: intentProtection(store), coursePrefix: deps.prefix },
      request.question,
      [{ ref: ref.courseRef, accountScope: ref.accountScope, courseId: ref.courseId, code: null, name: ref.label }],
      signal,
      allowed ? { resourceIds: allowed } : {},
    );
    return answer.unavailable ? { op, status: "unavailable", message: answer.unavailable, data: answer } : { op, status: "ok", data: answer };
  }

  return { generate, ask };
}
