// N07: per-concept state (spec §5.3–§5.6). conceptState is a pure fold over
// the ordered evidence, the configuration and "now" (KM-4). Hysteresis uses the
// band and R1 state computed after the prior event. The internal model (θ, p̂,
// margins) stays here; the student-facing ConceptView carries none of it (KM-6).
import { CONFIG, params, type KmParams, type KnowledgeConfig } from "../config";
import type { Concept, Dispute, LearningAttempt, LearningReview, SelfRating } from "../store";
import type { ConceptCounts, ConceptStateName, ConceptView, Reason } from "../types";
import { applyEvent, summaries, type Ability } from "./elo";
import { knowledgeEvents, reviewEvents, type CardInfo, type ItemInfo, type KnowledgeEvent, type ReviewEvent } from "./events";
import { accuracyWindow, dayAge, r1, r2, r3, r4, r5, r6, type RuleInput } from "./rules";

export interface AssessmentCoverage {
  id: string;
  title: string;
  /** ISO instant of the assessment. */
  at: string;
  conceptIds: string[];
}

export interface KnowledgeEvidence {
  attempts: LearningAttempt[];
  reviews: LearningReview[];
  selfRatings: SelfRating[];
  disputes: Dispute[];
  /** `itemId@version` → prior, option count and status. */
  items: Map<string, ItemInfo>;
  cards: Map<string, CardInfo>;
  assessments?: AssessmentCoverage[];
}

/** Internal state. Never serialised to the student. */
export interface ConceptModel {
  conceptId: string;
  theta: number;
  n: number;
  s: number;
  pHat: number;
  pLow: number;
  pHigh: number;
  acc: number | null;
  r: number | null;
  band: ConceptStateName;
  r1Active: boolean;
  reasons: Reason[];
  counts: ConceptCounts;
  coveredBy: { assessmentId: string; title: string; daysAway: number }[];
  configVersion: string;
}

const RECALL = new Set(["typed", "cloze", "numeric"]);

/** Follow merges so that evidence on a merged concept counts toward its target. */
function resolver(map: Concept[]): (id: string) => string {
  const byId = new Map(map.map((c) => [c.id, c]));
  return (id) => {
    let cur = byId.get(id);
    for (let hops = 0; cur?.mergedInto && hops < 20; hops++) cur = byId.get(cur.mergedInto) ?? cur;
    return cur?.id ?? id;
  };
}

function coverage(conceptId: string, assessments: AssessmentCoverage[], today: string) {
  return assessments
    .filter((a) => a.conceptIds.includes(conceptId))
    .map((a) => ({ assessmentId: a.id, title: a.title, daysAway: -dayAge(a.at.slice(0, 10), today) }))
    .filter((a) => a.daysAway >= 0)
    .sort((a, b) => a.daysAway - b.daysAway);
}

export function conceptState(
  evidence: KnowledgeEvidence,
  map: Concept[],
  config: KnowledgeConfig = CONFIG,
  now: Date = new Date(),
  rByConcept?: Map<string, number | null> | Record<string, number | null>,
  opts: { today?: string } = {},
): ConceptModel[] {
  const p: KmParams = params(config);
  const resolve = resolver(map);
  const today = opts.today ?? now.toISOString().slice(0, 10);
  const rOf = (c: string): number | null =>
    rByConcept instanceof Map ? (rByConcept.get(c) ?? null) : rByConcept ? (rByConcept[c] ?? null) : null;

  const events: KnowledgeEvent[] = knowledgeEvents(
    evidence.attempts.map((a) => ({ ...a, conceptTags: mergeTags(a.conceptTags.map((t) => ({ ...t, conceptId: resolve(t.conceptId) }))) })),
    evidence.items,
    evidence.disputes,
  );
  const included = events.filter((e) => e.excluded === null);
  const cards = new Map([...evidence.cards].map(([id, c]) => [id, { ...c, conceptId: resolve(c.conceptId) }] as [string, CardInfo]));
  const reviews: ReviewEvent[] = reviewEvents(evidence.reviews, cards);
  const assessments = evidence.assessments ?? [];

  const abilities = new Map<string, Ability>();
  const prev = new Map<string, { band: ConceptStateName; r1: boolean }>();

  const evaluate = (conceptId: string, time: string, day: string, r: number | null): ConceptModel => {
    const a = abilities.get(conceptId) ?? { theta: 0, n: 0 };
    const sum = summaries(a, p);
    const mine = included.filter((e) => e.createdAt <= time && e.tags.some((t) => t.conceptId === conceptId));
    const myReviews = reviews.filter((rv) => rv.conceptId === conceptId && rv.createdAt <= time);
    const before = prev.get(conceptId) ?? { band: "not_seen" as ConceptStateName, r1: false };
    const coveredBy = coverage(conceptId, assessments, day);
    const input: RuleInput = {
      today: day,
      n: a.n,
      pHat: sum.pHat,
      events: mine,
      allEvents: included.filter((e) => e.createdAt <= time),
      reviews: myReviews,
      r,
      prevR1: before.r1,
      coveredBy,
    };
    const rule1 = r1(input, p);
    const reasons = [rule1.reason, r2(input, p), r3(input, p), r4(input, p), r5(input, p), r6(input, p)].filter((x): x is Reason => x !== null);
    const recallRight = mine.filter((e) => RECALL.has(e.format) && e.y >= 1).length;
    let band: ConceptStateName;
    if (a.n === 0 && myReviews.length === 0) band = "not_seen";
    else if (reasons.length) band = "iffy";
    else {
      const bar = before.band === "solid" ? p.solidExitPLow : p.solidEnterPLow;
      const solid = a.n >= p.solidMinN && sum.pLow >= bar && (r === null || r >= p.solidMinR) && recallRight >= p.solidMinRecall;
      band = solid ? "solid" : "getting_there";
    }
    const all = events.filter((e) => e.createdAt <= time && e.tags.some((t) => t.conceptId === conceptId) && e.excluded !== "disputed_item" && e.excluded !== "disputed_grade" && e.excluded !== "quarantined");
    const unassisted = all.filter((e) => !e.assisted);
    return {
      conceptId,
      theta: a.theta,
      n: a.n,
      ...sum,
      acc: accuracyWindow(mine, p.accWindow).acc,
      r,
      band,
      r1Active: rule1.active,
      reasons,
      counts: {
        answers: all.length,
        unassisted: unassisted.length,
        correct: unassisted.filter((e) => e.y >= 1).length,
        cardReviews: myReviews.length,
        selfRatings: evidence.selfRatings.filter((s) => resolve(s.conceptId) === conceptId && s.createdAt <= time).length,
      },
      coveredBy,
      configVersion: config.version,
    };
  };

  // The fold: apply each event, then re-evaluate the concepts it touched at its own time.
  type Step = { kind: "attempt"; e: KnowledgeEvent } | { kind: "review"; rv: ReviewEvent };
  const steps: Step[] = [
    ...included.map((e) => ({ kind: "attempt" as const, e })),
    ...reviews.map((rv) => ({ kind: "review" as const, rv })),
  ].sort((x, y) => {
    const tx = x.kind === "attempt" ? x.e.createdAt : x.rv.createdAt;
    const ty = y.kind === "attempt" ? y.e.createdAt : y.rv.createdAt;
    return tx < ty ? -1 : tx > ty ? 1 : 0;
  });
  for (const step of steps) {
    let touched: string[];
    let time: string;
    let day: string;
    if (step.kind === "attempt") {
      applyEvent(abilities, step.e, p);
      touched = step.e.tags.map((t) => t.conceptId);
      time = step.e.createdAt;
      day = step.e.localDay;
    } else {
      touched = [step.rv.conceptId];
      time = step.rv.createdAt;
      day = step.rv.localDay;
    }
    for (const c of touched) {
      const m = evaluate(c, time, day, null);
      prev.set(c, { band: m.band, r1: m.r1Active });
    }
  }

  const nowIso = now.toISOString();
  return map.map((c) => evaluate(c.id, nowIso, today, rOf(c.id)));
}

/** Merge duplicate tags created by resolving merged concepts (keep the primary's weight). */
function mergeTags<T extends { conceptId: string; weight: number; primary: boolean }>(tags: T[]): T[] {
  const out = new Map<string, T>();
  for (const t of tags) {
    const had = out.get(t.conceptId);
    if (!had || (t.primary && !had.primary)) out.set(t.conceptId, t);
  }
  return [...out.values()];
}

/** The student-facing view (KM-6): state, reasons, counts; no ability, probability or percentage. */
export function toView(m: ConceptModel, map: Concept[]): ConceptView {
  const byId = new Map(map.map((c) => [c.id, c]));
  const c = byId.get(m.conceptId);
  const parent = c?.parentId ? byId.get(c.parentId) : undefined;
  return {
    conceptId: m.conceptId,
    label: c ? (c.studentLabel ?? c.label) : m.conceptId,
    unit: parent ? (parent.studentLabel ?? parent.label) : null,
    state: m.band,
    reasons: m.reasons.map((r) => ({ ...r, eventIds: [...r.eventIds] })),
    counts: { ...m.counts },
    coveredBy: m.coveredBy.map((x) => ({ ...x })),
    configVersion: m.configVersion,
  };
}
