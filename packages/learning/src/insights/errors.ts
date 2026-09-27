// P12: error patterns (PI-20). Frequent distractors: wrong options chosen at
// least twice, with the "why it's tempting" line and the anchor of the passage
// that settles it. Confusable pairs: "A answered as B" at least twice, when the
// chosen distractor is tagged to another concept, with both concepts' anchors
// and a compare session that interleaves A and B. Disputed or contested
// attempts are excluded; untagged options never form a pair.
import type { Concept, Dispute, LearningAttempt, StoredItem } from "../store";
import type { OptionTag } from "../practice/store";

export const MIN_OCCURRENCES = 2;

export interface PatternAnchor {
  resourceId: string;
  start: number;
  end: number;
  quote: string;
}

export interface FrequentDistractor {
  itemId: string;
  optionId: string;
  optionText: string;
  count: number;
  tempting: string | null;
  anchors: PatternAnchor[];
  evidenceIds: string[];
}

export interface ConfusablePair {
  asked: string;
  answeredAs: string;
  count: number;
  anchors: { asked: PatternAnchor[]; answeredAs: PatternAnchor[] };
  /** A compare session: items of both concepts, alternating. */
  compare: string[];
  evidenceIds: string[];
}

function chosenOption(a: LearningAttempt): string | null {
  if (a.optionId) return a.optionId;
  const r = a.response as { optionId?: unknown } | null;
  return r && typeof r.optionId === "string" ? r.optionId : null;
}

function counted(attempts: LearningAttempt[], disputes: Dispute[]): LearningAttempt[] {
  const open = disputes.filter((d) => d.status === "open");
  const items = new Set(open.filter((d) => d.targetKind === "item").map((d) => d.targetId));
  const grades = new Set(open.filter((d) => d.targetKind === "grade").map((d) => d.targetId));
  return attempts.filter((a) => !items.has(a.itemId) && !grades.has(a.id) && a.score < 1 && (a.format === "mc" || a.format === "tf"));
}

const itemAnchors = (s: StoredItem | undefined): PatternAnchor[] =>
  (s?.sources ?? []).filter((x) => x.quoteValid).map((x) => ({ resourceId: x.resourceId, start: x.start, end: x.end, quote: x.quote }));
const conceptAnchors = (c: Concept | undefined): PatternAnchor[] =>
  (c?.sources ?? []).filter((x) => x.quoteValid).map((x) => ({ resourceId: x.resourceId, start: x.start, end: x.end, quote: x.quote }));

export function frequentDistractors(attempts: LearningAttempt[], items: StoredItem[], disputes: Dispute[] = []): FrequentDistractor[] {
  const byKey = new Map(items.map((s) => [`${s.item.id}@${s.item.version}`, s]));
  const groups = new Map<string, LearningAttempt[]>();
  for (const a of counted(attempts, disputes)) {
    const o = chosenOption(a);
    if (!o) continue;
    const k = `${a.itemId}@${a.itemVersion}|${o}`;
    groups.set(k, [...(groups.get(k) ?? []), a]);
  }
  const out: FrequentDistractor[] = [];
  for (const [k, list] of groups) {
    if (list.length < MIN_OCCURRENCES) continue;
    const [itemKey, optionId] = k.split("|") as [string, string];
    const s = byKey.get(itemKey);
    if (!s || String(s.item.key) === optionId) continue;
    out.push({
      itemId: s.item.id,
      optionId,
      optionText: s.item.options?.find((o) => o.id === optionId)?.text ?? optionId,
      count: list.length,
      tempting: s.item.tempting[optionId] ?? null,
      anchors: itemAnchors(s),
      evidenceIds: list.map((a) => a.id),
    });
  }
  return out.sort((a, b) => b.count - a.count || (a.itemId < b.itemId ? -1 : 1));
}

export function confusablePairs(
  attempts: LearningAttempt[],
  items: StoredItem[],
  optionTags: OptionTag[],
  map: Concept[],
  disputes: Dispute[] = [],
): ConfusablePair[] {
  const tagOf = new Map(optionTags.map((t) => [`${t.itemId}@${t.itemVersion}|${t.optionId}`, t.conceptId]));
  const byId = new Map(map.map((c) => [c.id, c]));
  const groups = new Map<string, LearningAttempt[]>();
  for (const a of counted(attempts, disputes)) {
    const o = chosenOption(a);
    const b = o ? tagOf.get(`${a.itemId}@${a.itemVersion}|${o}`) : undefined;
    if (!b || b === a.primaryConceptId) continue;
    const k = `${a.primaryConceptId}|${b}`;
    groups.set(k, [...(groups.get(k) ?? []), a]);
  }
  const primaryOf = (s: StoredItem) => s.tags.find((t) => t.primary)?.conceptId;
  const active = items.filter((s) => s.item.status === "active");
  const out: ConfusablePair[] = [];
  for (const [k, list] of groups) {
    if (list.length < MIN_OCCURRENCES) continue;
    const [asked, answeredAs] = k.split("|") as [string, string];
    const aItems = active.filter((s) => primaryOf(s) === asked).map((s) => s.item.id);
    const bItems = active.filter((s) => primaryOf(s) === answeredAs).map((s) => s.item.id);
    const compare: string[] = [];
    for (let i = 0; i < Math.max(aItems.length, bItems.length); i++) {
      if (aItems[i]) compare.push(aItems[i]!);
      if (bItems[i]) compare.push(bItems[i]!);
    }
    out.push({
      asked,
      answeredAs,
      count: list.length,
      anchors: { asked: conceptAnchors(byId.get(asked)), answeredAs: conceptAnchors(byId.get(answeredAs)) },
      compare: [...new Set(compare)],
      evidenceIds: list.map((a) => a.id),
    });
  }
  return out.sort((a, b) => b.count - a.count);
}
