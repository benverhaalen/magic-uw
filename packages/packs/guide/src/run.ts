/**
 * Generation and the view. `generateGuide` runs one checked call through the same job the quiz
 * and cards packs use (cache first, consent via `maySend`, receipts, the ledger, retry and
 * escalation). `guideView` never takes a runner: it re-selects the inputs, reads the cached
 * artifact, re-runs the code checks and personalises it at 0 tokens.
 */
import { aiRecipientSchema, type PackScope } from "@magic/contracts";
import { maySend } from "@magic/domain";
import type { BackendCall, ModelRunner } from "../../../runner/src/index";
import { buildPrompt, packCacheKey, type ArtifactStore, type LedgerStore, type PackSpec } from "../../core/src/index";
import { runPack } from "../../../core/src/jobs/pack";
import { buildReceipt, egressFor, payloadHash } from "../../../core/src/egress";
import { contentCategories } from "../../../core/src/access";
import { rosterFor, toOriginalSpan } from "../../../core/src/identity";
import { classOf, protectedPayloadScrubber, protectionCounts } from "../../../core/src/privacy/protect"; // owner: privacy
import { findQuote } from "../../../retrieval/src/quotes";
import { conceptState, toView } from "../../../learning/src/knowledge/state";
import { confusablePairs, frequentDistractors } from "../../../learning/src/insights/errors";
import { tagOptions } from "../../../learning/src/insights/option-tags";
import { GUIDE_PACKS } from "./packs";
import { reviewAny, type ConceptMapDoc, type DropCode, type GuideDoc, type GuideDrop, type ReviewStats } from "./review";
import { personalize, type ConceptMapView, type GuideView, type PersonalSignals } from "./personalize";
import { selectGuideInputs, type GuideSelection, type GuideStore } from "./inputs";
import { changedSources, putLatest, readLatest, withoutChangedSpans, type SourceChange } from "./latest";
import type { ConceptMapOutput, GuideInput, GuideKind, GuideOutput } from "./schema";

export type GuideRunStatus = "done" | "needs_student" | "blocked" | "paused" | "failed" | "no_client" | "empty";
/** The `pack` command's result for a guide kind. */
export interface GuideRunResult {
  status: GuideRunStatus;
  message: string;
  pack: GuideKind;
  courseRef: string | null;
  artifactIds: string[];
  cached: boolean;
  tokens: { in: number; cached: number; out: number };
  counts: { generated: number; accepted: number; dropped: number; droppedBy: Partial<Record<DropCode, number>> };
  drops: GuideDrop[];
  stats: ReviewStats | null;
  receiptIds: string[];
  /** The checked document (not personalised; `guide-view` personalises it). */
  doc: GuideDoc | ConceptMapDoc | null;
  options?: ("retry" | "narrow_scope" | "skip")[];
  checkErrors?: string[];
}
export interface GuideDeps {
  store: GuideStore;
  runner: () => ModelRunner | null | Promise<ModelRunner | null>;
  artifacts: ArtifactStore;
  ledger: LedgerStore;
  now?: () => Date;
}

const empty = (pack: GuideKind, status: GuideRunStatus, message: string, courseRef: string | null = null): GuideRunResult => ({
  status,
  message,
  pack,
  courseRef,
  artifactIds: [],
  cached: false,
  tokens: { in: 0, cached: 0, out: 0 },
  counts: { generated: 0, accepted: 0, dropped: 0, droppedBy: {} },
  drops: [],
  stats: null,
  receiptIds: [],
  doc: null,
});
const NOUN: Record<GuideKind, string> = { guide: "study guide", briefing: "briefing", faq: "FAQ", timeline: "timeline", compare: "comparison tables", conceptmap: "concept map" };

function reviewed(kind: GuideKind, sel: GuideSelection, output: unknown) {
  const r = reviewAny(kind, output, sel.input, sel.passages, sel.resolve);
  const droppedBy: Partial<Record<DropCode, number>> = {};
  for (const d of r.drops) droppedBy[d.code] = (droppedBy[d.code] ?? 0) + 1;
  return { ...r, counts: { generated: r.stats.generated, accepted: r.stats.accepted, dropped: r.drops.length, droppedBy } };
}

class GuideEgressBlocked extends Error {}
const RECIPIENT: Record<string, string> = { local: "local", claude: "claude", anthropic: "claude", codex: "codex", openai: "chatgpt", openrouter: "openrouter", gemini: "gemini" };

/** Every `{sourceId, quote}` in the output, rewritten by `map` (a quote code can't map back becomes ""). */
function mapQuotes(kind: GuideKind, output: unknown, map: (sourceId: string | null, quote: string | null) => string | null): unknown {
  if (kind === "conceptmap") {
    const o = output as ConceptMapOutput;
    return {
      ...o,
      nodes: o.nodes.map((n) => ({ ...n, quote: n.quote === null ? null : map(n.sourceId, n.quote) })),
      edges: o.edges.map((e) => ({ ...e, quote: e.quote === null ? null : map(e.sourceId, e.quote) })),
    };
  }
  const o = output as GuideOutput;
  return { ...o, sections: o.sections.map((sec) => ({ ...sec, blocks: sec.blocks.map((b) => ({ ...b, quote: map(b.sourceId, b.quote) ?? "" })) })) };
}

export async function generateGuide(
  deps: GuideDeps,
  kind: GuideKind,
  scope: PackScope,
  options: { lane?: "interactive" | "background"; signal?: AbortSignal; passageTokenBudget?: number } = {},
): Promise<GuideRunResult> {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  const at = () => now().toISOString();
  const signal = options.signal;
  const picked = selectGuideInputs(store, kind, scope, options.passageTokenBudget);
  if (!picked.ok) return empty(kind, picked.status, picked.message, picked.courseRef);
  const sel = picked.selection;
  store.learning.course(sel.accountScope, sel.courseId, sel.label);
  const pack = GUIDE_PACKS[kind] as PackSpec<GuideInput, unknown>;
  const receiptIds: string[] = [];
  const base = { ...empty(kind, "done", "", sel.courseRef), receiptIds };

  // As the quiz and cards packs: a fingerprint of the evidence and the sharing permissions; a
  // change between selection and the call blocks it instead of sending stale or unconsented text.
  const snapshot = () =>
    payloadHash({
      scope: store.resources().filter((r) => r.courseId === sel.courseId).map((r) => [r.id, r.contentHash, r.deleted, r.policy.mode]),
      sources: store.sources(),
      roster: rosterFor(store, sel.courseId, sel.accountScope).version,
      privacy: store.privacy(),
      consents: store.consents?.(),
      concepts: store.learning.concepts(sel.courseRef).filter((c) => c.origin !== "model"),
    });
  const fingerprint = snapshot();
  const validate = () => {
    if (signal?.aborted || snapshot() !== fingerprint) throw new GuideEgressBlocked("Course evidence or sharing permissions changed. Try again with the current material.");
  };
  const runner = await deps.runner();
  const hosted = runner ? runner.client !== "local" : store.privacy().mode !== "local_only";
  // owner: privacy: the protection pass (roster + code detectors + per-request pseudonyms).
  const scrubber = protectedPayloadScrubber(store, hosted, sel.accountScope, `guide:${sel.courseRef}`);
  // Labels, facts, the frame and the assembled prompt are teaching text; a passage is its resource's class.
  const scrub = (value: string) => scrubber.field(value, sel.courseId, "teaching");
  const passageClass = (sourceId: string) => { const r = store.resource(sel.resourceOf.get(sourceId) ?? ""); return r ? classOf(r) : "personal"; };
  scrubber.prime([...sel.passages.map((p): [string, "teaching" | "personal"] => [p.text, passageClass(p.sourceId)]), ...[sel.input.scope, ...sel.input.materials, ...sel.input.topics, ...sel.input.facts, sel.frame.course, sel.frame.skeleton, sel.frame.policy].map((t): [string, "teaching"] => [t, "teaching"])], sel.courseId);
  // Freeze the exact passage projection; quotes map back to the original text through it.
  const frozen = new Map(sel.passages.map((p) => [p.sourceId, { original: p.text, result: scrubber.text(p.text, sel.courseId, passageClass(p.sourceId)) }]));
  const toOriginal = (sourceId: string | null, quote: string | null): string | null => {
    const p = sourceId ? frozen.get(sourceId) : undefined;
    if (!p) return quote;
    if (!quote) return quote;
    const found = findQuote(p.result.text, quote);
    const hit = found.status === "unique" ? found : found.status === "ambiguous" ? found.occurrences[0]! : null;
    const span = hit && toOriginalSpan(p.result, hit.start, hit.end);
    return span ? p.original.slice(span.start, span.end) : "";
  };
  const passages = sel.passages.map((p) => ({ ...p, text: frozen.get(p.sourceId)!.result.text }));
  const input: GuideInput = { ...sel.input, scope: scrub(sel.input.scope), materials: sel.input.materials.map(scrub), topics: sel.input.topics.map(scrub), facts: sel.input.facts.map(scrub) };
  const frame = { ...sel.frame, course: scrub(sel.frame.course), skeleton: scrub(sel.frame.skeleton), policy: scrub(sel.frame.policy) };
  const prompt = buildPrompt(pack, frame, input, passages);
  const cacheKey = payloadHash({ version: "guide-projection-v1", route: runner?.client ?? store.privacy().hostedProvider, fingerprint, key: packCacheKey(pack, prompt.systemPrompt, input, passages) });

  const finish = (artifact: { id: string; output: unknown; usage: GuideRunResult["tokens"]; createdAt?: string }, cached: boolean): GuideRunResult => {
    const r = reviewed(kind, sel, mapQuotes(kind, artifact.output, toOriginal));
    // The scope's latest guide: served marked stale if its material changes, until regenerated.
    const byId = new Map(sel.resources.map((x) => [x.id, x]));
    putLatest(store.learning, sel.courseRef, scope, {
      v: 1,
      kind,
      packVersion: pack.version,
      cacheKey,
      artifactId: artifact.id,
      createdAt: artifact.createdAt ?? at(),
      doc: r.doc,
      drops: r.drops,
      sources: [...new Set(sel.resourceOf.values())].flatMap((id) => {
        const x = byId.get(id);
        return x ? [{ resourceId: id, contentHash: x.contentHash, title: x.title }] : [];
      }),
      scopeResources: sel.resources.map((x) => x.id),
    });
    return {
      ...base,
      message: `Your ${NOUN[kind]} is ready${r.drops.length ? `; ${r.drops.length} parts were dropped by the checks` : ""}.`,
      artifactIds: [artifact.id],
      cached,
      tokens: cached ? { in: 0, cached: 0, out: 0 } : artifact.usage,
      counts: r.counts,
      drops: r.drops,
      stats: r.stats,
      doc: r.doc,
    };
  };

  // Study-time rule: a cache hit makes no provider call and costs 0 tokens.
  const stored = deps.artifacts.get(cacheKey);
  const parsedHit = stored && pack.schema.safeParse(stored.output);
  if (stored && parsedHit?.success) {
    deps.ledger.append({ at: at(), pack: pack.id, packVersion: pack.version, courseId: frame.courseId, cacheKey, outcome: "cache_hit", usage: { in: 0, cached: 0, out: 0 } });
    return finish({ ...stored, output: parsedHit.data }, true);
  }
  if (!runner) return empty(kind, "no_client", "Connect your AI first: choose Claude or Codex in Settings and sign in, then try again.", sel.courseRef);
  try {
    validate();
  } catch (error) {
    return empty(kind, "blocked", (error as Error).message, sel.courseRef);
  }

  const lane = options.lane ?? "interactive";
  const authorize = (recipient: string, categories: string[], payload?: unknown) => {
    validate();
    categories = [...new Set([...categories, ...sel.resources.flatMap(contentCategories)])];
    const parsed = aiRecipientSchema.safeParse(recipient);
    if (!parsed.success) return { allowed: false, reason: "This recipient is not supported." };
    const permission = maySend(store.privacy(), recipient, categories);
    // The job checks permission without consuming a one-shot payload approval.
    if (payload === undefined && permission.allowed) return permission;
    const m = {
      recipient: parsed.data,
      purpose: `Generate a ${NOUN[kind]} from course materials`,
      categories,
      resourceIds: sel.resources.map((r) => r.id),
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
    const permission = authorize(RECIPIENT[runner.client] ?? runner.client, pack.categories, { systemPrompt: outgoing.systemPrompt, input: outgoing.input, jsonSchema: outgoing.jsonSchema });
    if (!permission.allowed) throw new GuideEgressBlocked(permission.reason);
    return outgoing;
  };
  try {
    const result = await runPack(
      { runner, artifacts: deps.artifacts, ledger: deps.ledger, authorize, beforeCall, validate, cacheKey, now: () => now().getTime() },
      pack,
      frame,
      input,
      passages,
      { lane, scope: scope.assessmentId ?? scope.moduleId ?? "course", ...(signal ? { signal } : {}) },
    );
    if (result.status === "blocked") return { ...base, status: "blocked", message: result.reason };
    if (result.status === "paused" || result.status === "failed") return { ...base, status: result.status, message: result.message };
    if (result.status === "needs_student")
      return { ...base, status: "needs_student", message: result.question, options: result.options, checkErrors: result.checkErrors };
    validate();
    return finish(result.artifact, result.cached);
  } catch (error) {
    if (error instanceof GuideEgressBlocked) return { ...base, status: "blocked", message: error.message };
    throw error;
  }
}

/** The student's signals for the course, all computed by code from the learning store. */
export function personalSignals(store: GuideStore, courseRef: string, at: Date, resourceIds: string[] = []): PersonalSignals {
  const learning = store.learning;
  const map = learning.concepts(courseRef).filter((c) => c.status === "active");
  const evidence = learning.evidence(courseRef);
  const items = learning.items({ courseRef });
  const cards = learning.cards({ courseRef });
  const models = conceptState(
    {
      ...evidence,
      items: new Map(items.map((x) => [`${x.item.id}@${x.item.version}`, { bPrior: x.item.bPrior, options: x.item.options?.length ?? 0, status: x.item.status }])),
      cards: new Map(cards.map((x) => [x.id, { conceptId: x.conceptId, isConceptTrack: x.isConceptTrack }])),
    },
    map,
    undefined,
    at,
  );
  const states = models.map((m) => toView(m, map)).map((v) => ({ conceptId: v.conceptId, label: v.label, state: v.state }));
  const tags = items.flatMap((s) => tagOptions(s.item, map));
  const byItem = new Map(items.map((s) => [s.item.id, s]));
  const labels = Object.fromEntries(map.map((c) => [c.id, c.studentLabel ?? c.label]));
  const resources: PersonalSignals["resources"] = {};
  const anchors: PersonalSignals["anchors"] = {};
  const remember = (id: string) => {
    if (resources[id]) return true;
    const r = store.resource(id);
    if (!r || r.deleted) return false;
    resources[id] = { version: r.version, title: r.title };
    return true;
  };
  for (const id of resourceIds) remember(id);
  for (const c of map) {
    const s = c.sources.find((x) => x.quoteValid && remember(x.resourceId));
    if (s) anchors[c.id] = { resourceId: s.resourceId, start: s.start, end: s.end, quote: s.quote };
  }
  return {
    states,
    pairs: confusablePairs(evidence.attempts, items, tags, map, evidence.disputes),
    distractors: frequentDistractors(evidence.attempts, items, evidence.disputes).map((d) => {
      const s = byItem.get(d.itemId);
      return { ...d, stem: s?.item.stem ?? "", conceptId: s?.tags.find((t) => t.primary)?.conceptId ?? null };
    }),
    labels,
    resources,
    anchors,
  };
}

export type GuideViewResult =
  | {
      op: "guide.view";
      /** ready: made from the current material. stale: the last guide for this scope, made before its material changed. */
      status: "ready" | "stale";
      pack: GuideKind;
      courseRef: string;
      artifactId: string;
      stale: boolean;
      changedSources: SourceChange[];
      view: GuideView | ConceptMapView;
      drops: GuideDrop[];
      modelCalls: 0;
    }
  | { op: "guide.view"; status: "missing" | "empty" | "blocked"; pack: GuideKind; courseRef: string | null; message: string; modelCalls: 0 };

/**
 * `guide.view`: the personalised view of a cached guide. Takes no runner, so it cannot call a
 * model. When the material changed, the scope's last guide is served marked stale, listing the
 * changed sources; a new one is made only when the student asks (the pack command).
 */
export function guideView(deps: Pick<GuideDeps, "store" | "now">, kind: GuideKind, scope: PackScope): GuideViewResult {
  const picked = selectGuideInputs(deps.store, kind, scope);
  if (!picked.ok) return { op: "guide.view", status: picked.status, pack: kind, courseRef: picked.courseRef, message: picked.message, modelCalls: 0 };
  const sel = picked.selection;
  const latest = readLatest(deps.store.learning, kind, sel.courseRef, scope);
  if (!latest)
    return { op: "guide.view", status: "missing", pack: kind, courseRef: sel.courseRef, message: `There's no ${NOUN[kind]} for this material yet. Generate one first.`, modelCalls: 0 };
  // Freshness is decided by code from content hashes and the pack version, not by the model.
  const changes = changedSources(
    latest,
    (id) => {
      const r = deps.store.resource(id);
      return r && { contentHash: r.contentHash, title: r.title, deleted: r.deleted };
    },
    sel.resources.map((r) => ({ id: r.id, title: r.title })),
  );
  const stale = changes.length > 0 || latest.packVersion !== GUIDE_PACKS[kind].version;
  const changed = new Set(changes.filter((c) => c.change !== "added").map((c) => c.resourceId));
  const at = (deps.now ?? (() => new Date()))();
  const signals = personalSignals(deps.store, sel.courseRef, at, latest.sources.map((s) => s.resourceId).filter((id) => !changed.has(id)));
  return {
    op: "guide.view",
    status: stale ? "stale" : "ready",
    pack: kind,
    courseRef: sel.courseRef,
    artifactId: latest.artifactId,
    stale,
    changedSources: changes,
    view: personalize(withoutChangedSpans(latest.doc, changed), signals),
    drops: latest.drops,
    modelCalls: 0,
  };
}
