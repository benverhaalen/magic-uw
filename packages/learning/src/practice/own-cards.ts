// P11: card editing (PI-15) and the student's own cards (PI-16). An edit makes
// a new item version with origin "student", re-runs the code checks and keeps
// evidence on the version it was earned on. A card made from a notebook
// selection stores its anchor; a blank card has none. "Quote found in source"
// appears only while the quote validates; a changed source marks the card
// "source changed" and never deletes it.
import { schemaProblem } from "../flaws";
import { LABEL } from "../labels";
import { locateQuote, QUOTE_MAX, QUOTE_MIN, type ValidateQuote } from "../quote-port";
import { validateTags, type ProposedTag } from "../tags";
import type { Concept, ItemSource, ItemTag, LearningItem, StoredItem } from "../store";

export interface OwnCardResource {
  id: string;
  version: number;
  title: string;
  text: string;
  contentHash: string;
}

export interface Anchor {
  resourceId: string;
  version: number;
  start: number;
  end: number;
}

export interface CardResult {
  item: LearningItem;
  sources: ItemSource[];
  tags: ItemTag[];
  labels: string[];
}

function tagsOrThrow(tags: ProposedTag[], courseRef: string, map: Concept[]): ItemTag[] {
  if (!tags.length) return [];
  const r = validateTags(tags, courseRef, map);
  if (!r.ok) throw new Error(r.reason);
  return r.tags;
}

function card(base: { id: string; version: number; courseRef: string; front: string; back: string; explanation: string | null; at: string; familyId?: string }): LearningItem {
  return {
    id: base.id,
    version: base.version,
    courseRef: base.courseRef,
    familyId: base.familyId ?? base.id,
    kind: "card",
    stem: base.front,
    options: null,
    key: base.back,
    keyIdeas: [],
    explanation: base.explanation,
    tempting: {},
    bloom: "remember",
    bPrior: -0.25,
    tier: "T4",
    sourceTerm: null,
    origin: "student",
    status: "active",
    statusReason: null,
    generator: null,
    createdAt: base.at,
  };
}

/** "Make a card": from a notebook selection (with its anchor) or blank. Own cards can be tagged to 1–3 concepts. */
export function createOwnCard(
  input: { id: string; courseRef: string; front: string; back: string; anchor?: Anchor; tags?: ProposedTag[] },
  ctx: { resources: OwnCardResource[]; map: Concept[]; now: Date },
): CardResult {
  const item = card({ id: input.id, version: 1, courseRef: input.courseRef, front: input.front, back: input.back, explanation: null, at: ctx.now.toISOString() });
  const problem = schemaProblem(item);
  if (problem) throw new Error(problem);
  const tags = tagsOrThrow(input.tags ?? [], input.courseRef, ctx.map);
  if (!input.anchor) return { item, sources: [], tags, labels: ["Your card · no source"] };
  const a = input.anchor;
  const r = ctx.resources.find((x) => x.id === a.resourceId);
  if (!r) throw new Error(`unknown resource ${a.resourceId}`);
  if (r.version !== a.version) throw new Error("the selection is from another version of this material");
  const quote = r.text.slice(a.start, a.end);
  if (a.start < 0 || a.end > r.text.length || quote.length < QUOTE_MIN || quote.length > QUOTE_MAX) {
    throw new Error(`a card's source selection is ${QUOTE_MIN}–${QUOTE_MAX} characters`);
  }
  const source: ItemSource = { resourceId: r.id, contentHash: r.contentHash, textHash: r.contentHash, start: a.start, end: a.end, quote, quoteValid: true };
  return { item, sources: [source], tags, labels: [`Your card · from ${r.title}`, LABEL.quoteFound] };
}

/**
 * Edit a card's front, back or explanation: a new version, origin "student",
 * labelled "Edited by you". Each source quote is checked again against the
 * current text; one that no longer validates loses "Quote found in source" and
 * marks the card "source changed". The card is kept either way.
 */
export function editCard(
  stored: StoredItem,
  changes: { front?: string; back?: string; explanation?: string },
  ctx: { resources: OwnCardResource[]; validate: ValidateQuote; map: Concept[]; now: Date },
): CardResult {
  const prev = stored.item;
  const item = card({
    id: prev.id,
    version: prev.version + 1,
    courseRef: prev.courseRef,
    familyId: prev.familyId,
    front: changes.front ?? prev.stem,
    back: changes.back ?? String(prev.key),
    explanation: changes.explanation ?? prev.explanation,
    at: ctx.now.toISOString(),
  });
  const problem = schemaProblem(item);
  if (problem) throw new Error(problem);
  const tags = stored.tags.length ? tagsOrThrow(stored.tags.map((t) => ({ conceptId: t.conceptId, primary: t.primary })), prev.courseRef, ctx.map) : [];
  const byId = new Map(ctx.resources.map((r) => [r.id, r]));
  let changed = false;
  const sources = stored.sources.map((s) => {
    const r = byId.get(s.resourceId);
    const at = r ? locateQuote(ctx.validate, r.text, s.quote) : null;
    if (!r || !at) {
      changed = true;
      return { ...s, quoteValid: false };
    }
    return { ...s, contentHash: r.contentHash, start: at.start, end: at.end, quoteValid: true };
  });
  if (changed) {
    item.status = "stale";
    item.statusReason = "source changed";
  }
  const labels: string[] = [LABEL.editedByYou];
  if (sources.length && sources.every((s) => s.quoteValid)) labels.push(LABEL.quoteFound);
  const titled = sources.map((s) => byId.get(s.resourceId)?.title).find(Boolean);
  labels.unshift(sources.length ? `Your card · from ${titled ?? "a source that changed"}` : "Your card · no source");
  return { item, sources, tags, labels };
}
