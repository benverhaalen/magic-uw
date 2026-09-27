// P05: quick study sessions sized to the minutes the student has (PI-7;
// course-backend §L: no XP). A 3-, 5- or 10-minute plan: at most one confident
// miss, due cards, and one Learn family on the top-priority concept. Plans use
// the existing pools only (no provider call), and never exceed their size by
// more than one item.
import { CONFIG, params, type KnowledgeConfig } from "../config";
import type { ConceptModel } from "../knowledge/state";
import type { MistakeEntry } from "../mistakes";
import { conceptPriority } from "../priority";
import type { DueCard, PoolItem } from "../session";
import type { SessionPlan } from "../types";

export const QUICK_SIZES = [3, 5, 10] as const;
export type QuickSize = (typeof QUICK_SIZES)[number];

export interface QuickInput {
  sessionId: string;
  size: QuickSize;
  models: ConceptModel[];
  pool: (PoolItem & { familyId: string })[];
  mistakes: MistakeEntry[];
  dueCards: DueCard[];
  config?: KnowledgeConfig;
}

const primaryOf = (i: PoolItem) => i.tags.find((t) => t.primary)?.conceptId ?? i.tags[0]?.conceptId ?? "";

export function quickSession(input: QuickInput): SessionPlan & { plannedMinutes: number } {
  if (!(QUICK_SIZES as readonly number[]).includes(input.size)) throw new Error(`a quick session is 3, 5 or 10 minutes, not ${input.size}`);
  const p = params(input.config ?? CONFIG);
  const mins = (k: PoolItem["kind"]) => p.minutesPerItem[k];
  const poolById = new Map(input.pool.map((i) => [i.id, i]));
  let total = 0;
  const blocks: SessionPlan["blocks"] = [];

  // One Learn family on the top-priority concept that has one (chosen first, so the cards leave it room).
  const ranked = input.models
    .filter((m) => m.band !== "solid")
    .sort((a, b) => conceptPriority(b, input.config) - conceptPriority(a, input.config) || (a.conceptId < b.conceptId ? -1 : 1));
  let family: (PoolItem & { familyId: string })[] = [];
  for (const m of ranked) {
    const variants = input.pool.filter((i) => i.kind !== "card" && primaryOf(i) === m.conceptId);
    if (!variants.length) continue;
    const fid = [...variants].sort((a, b) => (a.familyId < b.familyId ? -1 : 1))[0]!.familyId;
    // Recognition before recall, as in Learn.
    const order = { tf: 0, mc: 1, cloze: 2, numeric: 3, typed: 4, card: 5 } as const;
    family = variants.filter((v) => v.familyId === fid).sort((a, b) => order[a.kind] - order[b.kind]);
    break;
  }
  const reserve = family.length ? mins(family[0]!.kind) : 0;

  const miss = input.mistakes.find((m) => m.confident && poolById.has(m.itemId));
  if (miss) {
    total += mins(poolById.get(miss.itemId)!.kind);
    blocks.push({ kind: "confident_misses", itemIds: [miss.itemId], reason: "A question you were sure about and missed." });
  }

  const cards: string[] = [];
  for (const c of [...input.dueCards].sort((a, b) => (a.r ?? 1) - (b.r ?? 1) || (a.cardId < b.cardId ? -1 : 1))) {
    if (total >= input.size - reserve) break;
    total += mins("card");
    cards.push(c.cardId);
  }
  if (cards.length) blocks.push({ kind: "due_cards", itemIds: cards, reason: "Cards due for review." });

  const learn: string[] = [];
  for (const v of family) {
    if (total >= input.size) break;
    total += mins(v.kind);
    learn.push(v.id);
  }
  if (learn.length) blocks.push({ kind: "learn", itemIds: learn, reason: "One set of questions on the topic that needs it most." });
  return { sessionId: input.sessionId, minutes: input.size, blocks, plannedMinutes: total };
}

/** Minutes of day from "HH:MM". */
const mod = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/**
 * Suggest a size from the study windows the student set for today: the
 * minutes left in the current window, or the length of the next one; the
 * largest size that fits. Null when no window today fits 3 minutes.
 */
export function suggestSize(windows: { start: string; end: string }[], now: string): QuickSize | null {
  const t = mod(now);
  const spans = windows.map((w) => ({ s: mod(w.start), e: mod(w.end) })).filter((w) => w.e > w.s).sort((a, b) => a.s - b.s);
  const current = spans.find((w) => w.s <= t && t < w.e);
  const next = spans.find((w) => w.s > t);
  const available = current ? current.e - t : next ? next.e - next.s : 0;
  const fits = [...QUICK_SIZES].reverse().find((s) => s <= available);
  return fits ?? null;
}
