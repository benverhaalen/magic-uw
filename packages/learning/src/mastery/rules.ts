// Course mastery rules (D57), on top of the knowledge model's bands (N07), all by code:
// 1. Two tiers. "Mastered" needs the model's Solid band AND delayed recall: an unassisted correct
//    recall-format answer (typed, cloze, numeric), or a card rated Good or Easy from FSRS's Review
//    state, on a local day after the topic's first evidence. Solid without it shows as Getting there.
// 2. Wrong answers demote through the model's own rules (R1, R3, R4) and estimate.
// 3. Time decay is a flag: FSRS retrievability below the review threshold marks a topic the student
//    has recalled at least once "due for review"; the shown state is never lowered by time alone.
import { CONFIG, params, type KnowledgeConfig } from "../config";
import { conceptR, newCardState, review as reviewCard } from "../fsrs";
import { knowledgeEvents, type KnowledgeEvent } from "../knowledge/events";
import { conceptState, type KnowledgeEvidence } from "../knowledge/state";
import type { Concept, LearningCard } from "../store";
import type { ConceptStateName } from "../types";

const RECALL = new Set(["typed", "cloze", "numeric"]);

export interface TopicExtras {
  firstDay: string | null;
  lastDay: string | null;
  evidenceCount: number;
  /** Recalled at least once (a right answer, or a card passed): only what was recalled can be forgotten. */
  recalled: boolean;
  confirmed: boolean;
  r: number | null;
  dueForReview: boolean;
}

/** The review threshold: the same line the model's Fading rule (R5) uses, request retention minus its margin. */
export function reviewThreshold(config: KnowledgeConfig = CONFIG): number {
  const p = params(config);
  return p.r5RequestRetention - p.r5Margin;
}

export function resolver(map: Concept[]): (id: string) => string {
  const byId = new Map(map.map((c) => [c.id, c]));
  return (id) => {
    let cur = byId.get(id);
    for (let hops = 0; cur?.mergedInto && hops < 20; hops++) cur = byId.get(cur.mergedInto) ?? cur;
    return cur?.id ?? id;
  };
}

/** The topics an event is evidence for, for the mastery rules: its primary tag (or its only tag). */
function primaryTopics(e: KnowledgeEvent, resolve: (id: string) => string): string[] {
  const tags = e.tags.length === 1 ? e.tags : e.tags.filter((t) => t.primary);
  return [...new Set(tags.map((t) => resolve(t.conceptId)))];
}

/**
 * A topic's retrievability when no card of its own was reviewed: the concept track (spec §5.4),
 * replayed from the first scored answer on each local day (right → Good, wrong → Again). Nothing is stored.
 */
function trackR(events: KnowledgeEvent[], now: Date): number | null {
  const firstPerDay = new Map<string, KnowledgeEvent>();
  for (const e of events) if (!firstPerDay.has(e.localDay)) firstPerDay.set(e.localDay, e);
  if (!firstPerDay.size) return null;
  const days = [...firstPerDay.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let card: LearningCard = {
    id: "track",
    itemId: "track",
    courseRef: "",
    conceptId: "",
    fsrs: newCardState(new Date(days[0]!.createdAt)),
    fsrsVersion: CONFIG.fsrsVersion,
    paramsHash: "",
    isConceptTrack: true,
  };
  for (const e of days) card = reviewCard(card, (e.y >= 1 ? 3 : 1) as 1 | 3, new Date(e.createdAt), { id: e.id, reviewMs: 0, localDay: e.localDay }).card;
  return conceptR([card], now);
}

/**
 * The per-topic facts the mastery rules need, from the course's evidence up to `until` (default: all).
 * Linear in the evidence; no model state is refolded here.
 */
export function topicExtras(
  evidence: KnowledgeEvidence,
  map: Concept[],
  cards: LearningCard[],
  now: Date,
  config: KnowledgeConfig = CONFIG,
  until?: string,
): Map<string, TopicExtras> {
  const resolve = resolver(map);
  const inTime = <T extends { createdAt: string }>(x: T) => !until || x.createdAt <= until;
  const events = knowledgeEvents(evidence.attempts.filter(inTime), evidence.items, evidence.disputes).filter((e) => e.excluded === null);
  const undone = new Set(evidence.reviews.filter((r) => r.undoesReviewId).map((r) => r.undoesReviewId!));
  const reviews = evidence.reviews.filter((r) => inTime(r) && !r.undoesReviewId && !undone.has(r.id));
  const out = new Map<string, TopicExtras>();
  const get = (t: string) => {
    let x = out.get(t);
    if (!x) out.set(t, (x = { firstDay: null, lastDay: null, evidenceCount: 0, recalled: false, confirmed: false, r: null, dueForReview: false }));
    return x;
  };
  const touch = (x: TopicExtras, day: string) => {
    if (!x.firstDay || day < x.firstDay) x.firstDay = day;
    if (!x.lastDay || day > x.lastDay) x.lastDay = day;
    x.evidenceCount++;
  };
  const byTopic = new Map<string, KnowledgeEvent[]>();
  for (const e of events)
    for (const t of primaryTopics(e, resolve)) {
      touch(get(t), e.localDay);
      if (e.y >= 1) get(t).recalled = true;
      byTopic.set(t, [...(byTopic.get(t) ?? []), e]);
    }
  const cardTopic = new Map<string, string>();
  for (const [id, c] of evidence.cards) if (!c.isConceptTrack) cardTopic.set(id, resolve(c.conceptId));
  const topicReviews = new Map<string, typeof reviews>();
  for (const r of reviews) {
    const t = cardTopic.get(r.cardId);
    if (!t) continue;
    touch(get(t), r.localDay);
    if (r.rating >= 2) get(t).recalled = true;
    topicReviews.set(t, [...(topicReviews.get(t) ?? []), r]);
  }
  // Delayed recall: after the first day of evidence on the topic.
  for (const [t, x] of out) {
    const first = x.firstDay!;
    x.confirmed =
      (byTopic.get(t) ?? []).some((e) => RECALL.has(e.format) && e.y >= 1 && e.localDay > first) ||
      (topicReviews.get(t) ?? []).some((r) => r.rating >= 3 && r.stateBefore.state === 2 && r.localDay > first);
  }
  // Retrievability now (a past cut needs states only): the median over the topic's reviewed cards,
  // else its replayed concept track.
  if (until) return out;
  const cardsByTopic = new Map<string, LearningCard[]>();
  for (const c of cards) {
    if (c.isConceptTrack) continue;
    const t = resolve(c.conceptId);
    cardsByTopic.set(t, [...(cardsByTopic.get(t) ?? []), c]);
  }
  const threshold = reviewThreshold(config);
  for (const [t, x] of out) {
    x.r = conceptR(cardsByTopic.get(t) ?? [], now) ?? trackR(byTopic.get(t) ?? [], now);
    x.dueForReview = x.recalled && x.r !== null && x.r < threshold;
  }
  return out;
}

/** The shown state: Solid is Mastered only once confirmed by delayed recall. */
export function shownState(band: ConceptStateName, extras: TopicExtras | undefined): ConceptStateName {
  return band === "solid" && !extras?.confirmed ? "getting_there" : band;
}

/** Topic bands as of an instant (end of a day, or an exam's date), replayed from the evidence stored up to then. */
export function bandsAsOf(evidence: KnowledgeEvidence, map: Concept[], at: string, config: KnowledgeConfig = CONFIG): Map<string, ConceptStateName> {
  const cut: KnowledgeEvidence = {
    ...evidence,
    attempts: evidence.attempts.filter((a) => a.createdAt <= at),
    reviews: evidence.reviews.filter((r) => r.createdAt <= at),
    selfRatings: evidence.selfRatings.filter((s) => s.createdAt <= at),
  };
  const day = at.slice(0, 10);
  return new Map(conceptState(cut, map, config, new Date(at), undefined, { today: day }).map((m) => [m.conceptId, m.band]));
}
