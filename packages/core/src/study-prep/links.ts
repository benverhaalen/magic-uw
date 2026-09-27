/**
 * owner: study-prep. What each generated question and card was made for: the item (exam, quiz,
 * assignment or material), the assignments, modules and topics of its source, and the passage it
 * was drawn from. Kept in one learning artifact per course (no new table), written when Study
 * prep accepts an item. Items made elsewhere are linked at read time from what the course map
 * knows: their source is one of the item's sources, or their main topic is in its scope.
 */
import type { ArtifactKind, LearningCard, LearningStore, StoredItem } from "../../../learning/src/store";
import type { StudyPrepReview } from "@magic/contracts";
import { sha } from "./scope-hash";

export interface ItemLinks {
  /** The work items (exam, quiz, assignment, material) it was made for. */
  forItems: string[];
  assignmentIds: string[];
  moduleIds: string[];
  topicIds: string[];
  passageIds: string[];
}

const key = (courseRef: string) => `study-links-v1-${sha(courseRef).slice(0, 40)}`;
const merge = (a: string[], b: string[]) => [...new Set([...a, ...b])];

export function readLinks(learning: LearningStore, courseRef: string): Record<string, ItemLinks> {
  const body = learning.artifact(key(courseRef))?.body as { items?: Record<string, ItemLinks> } | undefined;
  return body?.items && typeof body.items === "object" ? body.items : {};
}

export function addLinks(learning: LearningStore, courseRef: string, add: Record<string, ItemLinks>, at: string): void {
  const items = { ...readLinks(learning, courseRef) };
  for (const [id, l] of Object.entries(add)) {
    const prev = items[id];
    items[id] = prev
      ? { forItems: merge(prev.forItems, l.forItems), assignmentIds: merge(prev.assignmentIds, l.assignmentIds), moduleIds: merge(prev.moduleIds, l.moduleIds), topicIds: merge(prev.topicIds, l.topicIds), passageIds: merge(prev.passageIds, l.passageIds) }
      : l;
  }
  learning.putArtifact({
    id: key(courseRef), courseRef, kind: "pack" as ArtifactKind, scope: { pointer: "study-links" }, cacheKey: key(courseRef),
    body: { v: 1, items }, removedCount: 0, status: "ready", generator: null, pack: "study-links", packVersion: "v1", createdAt: at, sources: [],
  });
}

export const CARD_KINDS = new Set(["card", "cloze"]);
export const QUESTION_KINDS = new Set(["mc", "tf", "numeric"]);
const endOfLocalDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).toISOString();

/** The latest live version of each of the course's items. */
export function latestItems(learning: LearningStore, courseRef: string): Map<string, StoredItem> {
  const out = new Map<string, StoredItem>();
  for (const x of learning.items({ courseRef })) {
    const prev = out.get(x.item.id);
    if (!prev || prev.item.version < x.item.version) out.set(x.item.id, x);
  }
  for (const [id, x] of out) if (x.item.status === "quarantined") out.delete(id);
  return out;
}

export interface LinkQuery {
  itemId: string;
  /** Sources the item's review may draw on (its selection). */
  resourceIds: ReadonlySet<string>;
  /** Topics in the item's scope (its coverage, or the student's focus). */
  topicIds: ReadonlySet<string>;
  /** The whole linked set (no narrowing): topic links count too. */
  whole: boolean;
}

/** Which of the course's items belong to an item's space, and how many of its cards are due today. */
export function linkedReview(items: Map<string, StoredItem>, cards: LearningCard[], links: Record<string, ItemLinks>, q: LinkQuery, now: Date): StudyPrepReview {
  const cardOf = new Map<string, LearningCard>();
  for (const c of cards) if (!c.isConceptTrack) cardOf.set(c.itemId, c);
  const cutoff = endOfLocalDay(now);
  const cardIds: { id: string; due: boolean; at: string }[] = [];
  const questionIds: string[] = [];
  for (const [id, x] of items) {
    const l = links[id];
    const source = x.sources[0]?.resourceId;
    const primary = x.tags.find((t) => t.primary)?.conceptId ?? x.tags[0]?.conceptId;
    const explicit = !!l && l.forItems.includes(q.itemId) && (q.whole || (!!source && q.resourceIds.has(source)) || l.topicIds.some((t) => q.topicIds.has(t)));
    const bySource = !!source && q.resourceIds.has(source);
    const byTopic = q.whole && !!primary && q.topicIds.has(primary);
    if (!explicit && !bySource && !byTopic) continue;
    if (CARD_KINDS.has(x.item.kind)) {
      const card = cardOf.get(id);
      const at = card?.fsrs.due ?? "";
      cardIds.push({ id, due: !card || at <= cutoff, at });
    } else if (QUESTION_KINDS.has(x.item.kind)) questionIds.push(id);
  }
  cardIds.sort((a, b) => Number(b.due) - Number(a.due) || a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  return {
    cards: cardIds.length,
    due: cardIds.filter((c) => c.due).length,
    questions: questionIds.length,
    cardItemIds: cardIds.slice(0, 200).map((c) => c.id),
    questionItemIds: questionIds.slice(0, 200),
  };
}
