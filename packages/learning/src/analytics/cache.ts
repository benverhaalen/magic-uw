// Per-topic state for analytics, cached in the existing rebuildable `learning_concept_state`
// table (no schema change). A topic's row is recomputed only when its own evidence mark changes
// (a new attempt, card review or self-rating on it), when a course-wide input changes (disputes,
// item status, the concept map), on a new day (the rules have day windows) or on a new config.
// Recomputing folds only the evidence of the affected topics' connected component (topics that
// share an attempt or an item), which is exact: a topic's ability moves only with events tagged
// with it, and the rules look at other events only on the same item.
import { createHash } from "node:crypto";
import { CONFIG, type KnowledgeConfig } from "../config";
import { conceptState, type KnowledgeEvidence } from "../knowledge/state";
import type { Concept, ConceptStateRow, CourseRef, LearningCard, LearningStore, StoredItem } from "../store";
import type { ConceptCounts, ConceptStateName, Reason } from "../types";

/** The internal per-topic model analytics needs. Never serialised to the student. */
export interface TopicModel {
  conceptId: string;
  n: number;
  pHat: number;
  band: ConceptStateName;
  reasons: Reason[];
  counts: ConceptCounts;
}

export interface TopicStates {
  models: Map<string, TopicModel>;
  /** Topics whose state was recomputed on this call, and those served from the cache. */
  recomputed: string[];
  reused: string[];
}

interface CachedCounts extends ConceptCounts {
  /** The evidence mark the row was computed from. */
  mark: string;
}

const itemKey = (id: string, v: number) => `${id}@${v}`;
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** The course's knowledge evidence, as the router's topic models build it. */
export function courseEvidence(store: LearningStore, ref: CourseRef, read: { items?: StoredItem[]; cards?: LearningCard[] } = {}): KnowledgeEvidence {
  const evidence = store.evidence(ref);
  return {
    ...evidence,
    items: new Map(
      (read.items ?? store.items({ courseRef: ref })).map((x) => [
        itemKey(x.item.id, x.item.version),
        { bPrior: x.item.bPrior, options: x.item.options?.length ?? 0, status: x.item.status },
      ]),
    ),
    cards: new Map((read.cards ?? store.cards({ courseRef: ref })).map((x) => [x.id, { conceptId: x.conceptId, isConceptTrack: x.isConceptTrack }])),
  };
}

function resolver(map: Concept[]): (id: string) => string {
  const byId = new Map(map.map((c) => [c.id, c]));
  return (id) => {
    let cur = byId.get(id);
    for (let hops = 0; cur?.mergedInto && hops < 20; hops++) cur = byId.get(cur.mergedInto) ?? cur;
    return cur?.id ?? id;
  };
}

/** Per-topic evidence marks: own evidence counts plus a course-wide fingerprint. */
function marks(ev: KnowledgeEvidence, map: Concept[], resolve: (id: string) => string, config: KnowledgeConfig): Map<string, string> {
  const course = hash(
    JSON.stringify([
      config.version,
      ev.disputes.map((d) => `${d.id}:${d.status}`).sort(),
      [...ev.items].filter(([, i]) => i.status !== "active").map(([k, i]) => `${k}:${i.status}`).sort(),
      map.map((c) => `${c.id}:${c.status}:${c.mergedInto ?? ""}`).sort(),
    ]),
  );
  const own = new Map<string, [number, number, number]>();
  const bump = (id: string, i: 0 | 1 | 2) => {
    const row = own.get(id) ?? [0, 0, 0];
    row[i]++;
    own.set(id, row);
  };
  for (const a of ev.attempts) for (const id of new Set(a.conceptTags.map((t) => resolve(t.conceptId)))) bump(id, 0);
  for (const r of ev.reviews) {
    const card = ev.cards.get(r.cardId);
    if (card) bump(resolve(card.conceptId), 1);
  }
  for (const s of ev.selfRatings) bump(resolve(s.conceptId), 2);
  return new Map(map.map((c) => [c.id, `${(own.get(c.id) ?? [0, 0, 0]).join(".")}|${course}`]));
}

/** Fold the evidence of the affected topics' component only, and return their models. */
function fold(ev: KnowledgeEvidence, map: Concept[], resolve: (id: string) => string, affected: Set<string>, config: KnowledgeConfig, now: Date): (TopicModel & { theta: number; s: number })[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a),
      rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const firstTagOfItem = new Map<string, string>();
  for (const a of ev.attempts) {
    const tags = a.conceptTags.map((t) => resolve(t.conceptId));
    for (const t of tags.slice(1)) union(tags[0]!, t);
    if (tags[0]) {
      const seen = firstTagOfItem.get(a.itemId);
      if (seen) union(seen, tags[0]);
      else firstTagOfItem.set(a.itemId, tags[0]);
    }
  }
  const roots = new Set([...affected].map(find));
  const inComponent = (id: string) => roots.has(find(resolve(id)));
  const evidence: KnowledgeEvidence = {
    ...ev,
    attempts: ev.attempts.filter((a) => a.conceptTags.some((t) => inComponent(t.conceptId))),
    reviews: ev.reviews.filter((r) => {
      const card = ev.cards.get(r.cardId);
      return !!card && inComponent(card.conceptId);
    }),
    selfRatings: ev.selfRatings.filter((s) => inComponent(s.conceptId)),
  };
  // Keep merged concepts and their targets so merges still resolve inside the fold.
  const targets = new Set(map.filter((c) => c.mergedInto).map((c) => c.mergedInto!));
  const subset = map.filter((c) => affected.has(c.id) || c.mergedInto !== null || targets.has(c.id));
  return conceptState(evidence, subset, config, now)
    .filter((m) => affected.has(m.conceptId))
    .map((m) => ({ conceptId: m.conceptId, theta: m.theta, s: m.s, n: m.n, pHat: m.pHat, band: m.band, reasons: m.reasons, counts: m.counts }));
}

/**
 * The course's topic states from the cache, recomputing only stale topics (and `force`d ones),
 * and writing the recomputed rows back. `map` is the whole concept map (merged ones included).
 */
export function topicStates(
  store: LearningStore,
  ref: CourseRef,
  map: Concept[],
  now: Date,
  opts: { force?: Iterable<string>; config?: KnowledgeConfig; evidence?: KnowledgeEvidence } = {},
): TopicStates {
  const config = opts.config ?? CONFIG;
  const active = map.filter((c) => c.status === "active");
  if (!active.length) return { models: new Map(), recomputed: [], reused: [] };
  const ev = opts.evidence ?? courseEvidence(store, ref);
  const resolve = resolver(map);
  const mark = marks(ev, map, resolve, config);
  const today = now.toISOString().slice(0, 10);
  const force = new Set(opts.force ?? []);
  const rows = new Map(store.conceptState(ref).map((r) => [r.conceptId, r]));
  const models = new Map<string, TopicModel>();
  const stale = new Set<string>();
  for (const c of active) {
    const row = rows.get(c.id);
    const counts = row?.counts as CachedCounts | undefined;
    if (
      !row ||
      !counts ||
      force.has(c.id) ||
      row.configVersion !== config.version ||
      row.computedAt.slice(0, 10) !== today ||
      counts?.mark !== mark.get(c.id)
    )
      stale.add(c.id);
    else
      models.set(c.id, {
        conceptId: c.id,
        n: row.n,
        pHat: row.pHat,
        band: row.band as ConceptStateName,
        reasons: (row.reasons as Reason[]) ?? [],
        counts: { answers: counts.answers, unassisted: counts.unassisted, correct: counts.correct, cardReviews: counts.cardReviews, selfRatings: counts.selfRatings },
      });
  }
  const reused = [...models.keys()];
  if (stale.size) {
    const fresh = fold(ev, map, resolve, stale, config, now);
    const at = now.toISOString();
    const out: ConceptStateRow[] = fresh.map((m) => ({
      conceptId: m.conceptId,
      theta: m.theta,
      n: m.n,
      s: m.s,
      pHat: m.pHat,
      r: null,
      band: m.band,
      reasons: m.reasons,
      counts: { ...m.counts, mark: mark.get(m.conceptId)! } satisfies CachedCounts,
      configVersion: config.version,
      computedAt: at,
    }));
    store.putConceptState(out);
    for (const { theta: _t, s: _s, ...m } of fresh) models.set(m.conceptId, m);
  }
  return { models, recomputed: [...stale], reused };
}
