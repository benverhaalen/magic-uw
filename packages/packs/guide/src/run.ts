/**
 * Generation and the view. `generateGuide` runs one checked call through the same job the quiz
 * and cards packs use (cache first, consent via `maySend`, receipts, the ledger, retry and
 * escalation). `guideView` never takes a runner: it re-selects the inputs, reads the cached
 * artifact, re-runs the code checks and personalises it at 0 tokens.
 */
import { aiRecipientSchema, type PackScope } from "@magic/contracts";
import { maySend } from "@magic/domain";
import type { ModelRunner } from "../../../runner/src/index";
import { buildPrompt, packCacheKey, type ArtifactStore, type LedgerStore, type PackSpec } from "../../core/src/index";
import { readPackArtifact, runPack } from "../../../core/src/jobs/pack";
import { buildReceipt, egressFor } from "../../../core/src/egress";
import { conceptState, toView } from "../../../learning/src/knowledge/state";
import { confusablePairs, frequentDistractors } from "../../../learning/src/insights/errors";
import { tagOptions } from "../../../learning/src/insights/option-tags";
import { GUIDE_PACKS } from "./packs";
import { reviewAny, type ConceptMapDoc, type DropCode, type GuideDoc, type GuideDrop, type ReviewStats } from "./review";
import { personalize, type ConceptMapView, type GuideView, type PersonalSignals } from "./personalize";
import { selectGuideInputs, type GuideSelection, type GuideStore } from "./inputs";
import { changedSources, putLatest, readLatest, withoutChangedSpans, type SourceChange } from "./latest";
import type { GuideInput, GuideKind } from "./schema";

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

export async function generateGuide(
  deps: GuideDeps,
  kind: GuideKind,
  scope: PackScope,
  options: { lane?: "interactive" | "background"; signal?: AbortSignal; passageTokenBudget?: number } = {},
): Promise<GuideRunResult> {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  const at = () => now().toISOString();
  const picked = selectGuideInputs(store, kind, scope, options.passageTokenBudget);
  if (!picked.ok) return empty(kind, picked.status, picked.message, picked.courseRef);
  const sel = picked.selection;
  store.learning.course(sel.accountScope, sel.courseId, sel.label);
  const pack = GUIDE_PACKS[kind] as PackSpec<GuideInput, unknown>;
  const receiptIds: string[] = [];
  const base = { ...empty(kind, "done", "", sel.courseRef), receiptIds };
  const cacheKey = packCacheKey(pack, buildPrompt(pack, sel.frame, sel.input, sel.passages).systemPrompt, sel.input, sel.passages);
  const finish = (artifact: { id: string; output: unknown; usage: GuideRunResult["tokens"]; createdAt?: string }, cached: boolean): GuideRunResult => {
    const r = reviewed(kind, sel, artifact.output);
    // The scope's latest guide: served marked stale if its material changes, until regenerated.
    const byId = new Map(sel.resources.map((x) => [x.id, x]));
    putLatest(store.learning, sel.courseRef, scope, {
      v: 1,
      kind,
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

  // Study-time rule: a cache hit is served without the runner, so it costs 0 tokens.
  const hit = readPackArtifact(deps.artifacts, pack, sel.frame, sel.input, sel.passages);
  if (hit) {
    deps.ledger.append({ at: at(), pack: pack.id, packVersion: pack.version, courseId: sel.frame.courseId, cacheKey, outcome: "cache_hit", usage: { in: 0, cached: 0, out: 0 } });
    return finish(hit, true);
  }
  const runner = await deps.runner();
  if (!runner) return empty(kind, "no_client", "Connect your AI first: choose Claude or Codex in Settings and sign in, then try again.", sel.courseRef);

  const prompt = buildPrompt(pack, sel.frame, sel.input, sel.passages);
  const lane = options.lane ?? "interactive";
  const authorize = (recipient: string, categories: string[]) => {
    const parsed = aiRecipientSchema.safeParse(recipient);
    if (!parsed.success) return { allowed: false, reason: "This recipient is not supported." };
    const permission = maySend(store.privacy(), recipient, categories);
    const m = {
      recipient: parsed.data,
      purpose: `Generate a ${NOUN[kind]} from course materials`,
      categories,
      resourceIds: [...new Set(sel.resourceOf.values())],
      characters: prompt.systemPrompt.length + prompt.input.length,
      allowed: permission.allowed,
      reason: permission.reason,
      payload: { course: sel.label, title: kind, text: prompt.input, policy: sel.frame.policy },
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
  const result = await runPack(
    { runner, artifacts: deps.artifacts, ledger: deps.ledger, authorize, now: () => now().getTime() },
    pack,
    sel.frame,
    sel.input,
    sel.passages,
    { lane, scope: scope.assessmentId ?? scope.moduleId ?? "course", ...(options.signal ? { signal: options.signal } : {}) },
  );
  if (result.status === "blocked") return { ...base, status: "blocked", message: result.reason };
  if (result.status === "paused" || result.status === "failed") return { ...base, status: result.status, message: result.message };
  if (result.status === "needs_student")
    return { ...base, status: "needs_student", message: result.question, options: result.options, checkErrors: result.checkErrors };
  return finish(result.artifact, result.cached);
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
export function guideView(deps: Pick<GuideDeps, "store" | "artifacts" | "now">, kind: GuideKind, scope: PackScope): GuideViewResult {
  const picked = selectGuideInputs(deps.store, kind, scope);
  if (!picked.ok) return { op: "guide.view", status: picked.status, pack: kind, courseRef: picked.courseRef, message: picked.message, modelCalls: 0 };
  const sel = picked.selection;
  const at = (deps.now ?? (() => new Date()))();
  const used = [...new Set(sel.resourceOf.values())];
  const hit = readPackArtifact(deps.artifacts, GUIDE_PACKS[kind] as PackSpec<GuideInput, unknown>, sel.frame, sel.input, sel.passages);
  if (hit) {
    const r = reviewed(kind, sel, hit.output);
    const signals = personalSignals(deps.store, sel.courseRef, at, used);
    return { op: "guide.view", status: "ready", pack: kind, courseRef: sel.courseRef, artifactId: hit.id, stale: false, changedSources: [], view: personalize(r.doc, signals), drops: r.drops, modelCalls: 0 };
  }
  const latest = readLatest(deps.store.learning, kind, sel.courseRef, scope);
  if (!latest)
    return { op: "guide.view", status: "missing", pack: kind, courseRef: sel.courseRef, message: `There's no ${NOUN[kind]} for this material yet. Generate one first.`, modelCalls: 0 };
  const changes = changedSources(
    latest,
    (id) => {
      const r = deps.store.resource(id);
      return r && { contentHash: r.contentHash, title: r.title, deleted: r.deleted };
    },
    sel.resources.map((r) => ({ id: r.id, title: r.title })),
  );
  const changed = new Set(changes.filter((c) => c.change !== "added").map((c) => c.resourceId));
  const signals = personalSignals(deps.store, sel.courseRef, at, latest.sources.map((s) => s.resourceId).filter((id) => !changed.has(id)));
  return {
    op: "guide.view",
    status: "stale",
    pack: kind,
    courseRef: sel.courseRef,
    artifactId: latest.artifactId,
    stale: true,
    changedSources: changes,
    view: personalize(withoutChangedSpans(latest.doc, changed), signals),
    drops: latest.drops,
    modelCalls: 0,
  };
}
