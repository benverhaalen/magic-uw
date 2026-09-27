// N07: the evidence filter (spec §5.2). Turns stored attempts into ordered
// knowledge events with an exposure weight, or an exclusion reason. Only
// unassisted, undisputed, non-quarantined, first-in-session answers move θ.
import type { ItemFormat } from "../config";
import type { Dispute, ItemTag, LearningAttempt, LearningReview } from "../store";

export interface ItemInfo {
  bPrior: number;
  /** Number of options, for the guessing floor. */
  options: number;
  status: "active" | "quarantined" | "stale";
}

export type Exclusion = "assisted" | "disputed_item" | "disputed_grade" | "quarantined" | "same_session_repeat";

export interface KnowledgeEvent {
  id: string;
  itemId: string;
  tags: ItemTag[];
  format: ItemFormat;
  options: number;
  b: number;
  /** Outcome: 1/0, or found/required for typed answers. */
  y: number;
  /** Exposure weight: 1 first time, 0.5 for an item seen in an earlier session. */
  v: number;
  assisted: boolean;
  confidence: number | null;
  createdAt: string;
  localDay: string;
  sessionId: string;
  excluded: Exclusion | null;
}

export interface CardInfo {
  conceptId: string;
  isConceptTrack: boolean;
}

export interface ReviewEvent {
  id: string;
  cardId: string;
  conceptId: string;
  rating: 1 | 2 | 3 | 4;
  /** FSRS state before the review (2 = Review). */
  stateBefore: number;
  createdAt: string;
  localDay: string;
}

const itemKey = (id: string, v: number) => `${id}@${v}`;

/** Order attempts, weight them, and mark exclusions. Pure. */
export function knowledgeEvents(attempts: LearningAttempt[], items: Map<string, ItemInfo>, disputes: Dispute[]): KnowledgeEvent[] {
  const open = disputes.filter((d) => d.status === "open");
  const disputedItems = new Set(open.filter((d) => d.targetKind === "item").map((d) => d.targetId));
  const disputedGrades = new Set(open.filter((d) => d.targetKind === "grade").map((d) => d.targetId));
  const sorted = [...attempts].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
  const sessionsByItem = new Map<string, Set<string>>();
  const out: KnowledgeEvent[] = [];
  for (const a of sorted) {
    const info = items.get(itemKey(a.itemId, a.itemVersion));
    const sessions = sessionsByItem.get(a.itemId) ?? new Set<string>();
    let excluded: Exclusion | null = null;
    if (a.assistance !== "none") excluded = "assisted";
    else if (disputedItems.has(a.itemId) || disputedItems.has(itemKey(a.itemId, a.itemVersion))) excluded = "disputed_item";
    else if (disputedGrades.has(a.id)) excluded = "disputed_grade";
    else if (info?.status === "quarantined") excluded = "quarantined";
    else if (sessions.has(a.sessionId)) excluded = "same_session_repeat";
    const seenEarlier = a.seenBefore || [...sessions].some((s) => s !== a.sessionId);
    sessions.add(a.sessionId);
    sessionsByItem.set(a.itemId, sessions);
    out.push({
      id: a.id,
      itemId: a.itemId,
      tags: a.conceptTags,
      format: a.format,
      options: info?.options ?? 0,
      b: info?.bPrior ?? 0,
      y: Math.max(0, Math.min(1, a.score)),
      v: seenEarlier ? 0.5 : 1,
      assisted: a.assistance !== "none",
      confidence: a.confidence,
      createdAt: a.createdAt,
      localDay: a.localDay,
      sessionId: a.sessionId,
      excluded,
    });
  }
  return out;
}

/** Card reviews that still count: undo rows and undone reviews are dropped. */
export function reviewEvents(reviews: LearningReview[], cards: Map<string, CardInfo>): ReviewEvent[] {
  const undone = new Set(reviews.filter((r) => r.undoesReviewId).map((r) => r.undoesReviewId!));
  return reviews
    .filter((r) => !r.undoesReviewId && !undone.has(r.id))
    .flatMap((r) => {
      const card = cards.get(r.cardId);
      if (!card || card.isConceptTrack) return [];
      return [{ id: r.id, cardId: r.cardId, conceptId: card.conceptId, rating: r.rating, stateBefore: r.stateBefore.state, createdAt: r.createdAt, localDay: r.localDay }];
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
}
