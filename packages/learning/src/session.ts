// N10: the session builder (ST-7, KM-7). Blocks fill in order until the
// minutes run out: R4 items (≤3) → due mistakes → due cards → Learn items on
// the highest-priority concepts (Iffy, then Getting there, then Not seen yet in
// module order). Difficulty is a preference, not a filter: among eligible items
// the one whose predicted P is nearest the band is chosen, so a thin pool never
// empties a block. With no evidence, the plan is a labelled diagnostic of ≤8
// items. A plan never exceeds the minutes by more than one item.
import { CONFIG, params, type Difficulty, type ItemFormat, type KnowledgeConfig } from "./config";
import type { ConceptModel } from "./knowledge/state";
import type { MistakeEntry } from "./mistakes";
import { bandDistance, conceptPriority, predictedSuccess } from "./priority";
import type { Concept, ItemTag } from "./store";
import type { SessionPlan } from "./types";

export interface PoolItem {
  id: string;
  kind: ItemFormat | "card";
  options: number;
  bPrior: number;
  tags: ItemTag[];
}

export interface DueCard {
  cardId: string;
  conceptId: string;
  due: string;
  r: number | null;
}

export interface SessionInput {
  sessionId: string;
  minutes: number;
  difficulty: Difficulty;
  concepts: Concept[];
  models: ConceptModel[];
  pool: PoolItem[];
  mistakes: MistakeEntry[];
  dueCards: DueCard[];
  config?: KnowledgeConfig;
}

export const DIAGNOSTIC_REASON = "Placement: helps pick where to start. It isn't a grade.";
export const DIAGNOSTIC_MAX = 8;

const primaryOf = (tags: ItemTag[]) => tags.find((t) => t.primary)?.conceptId ?? tags[0]?.conceptId ?? "";

export function buildSession(input: SessionInput): SessionPlan & { plannedMinutes: number } {
  const p = params(input.config ?? CONFIG);
  const minutesOf = (kind: ItemFormat | "card") => p.minutesPerItem[kind];
  const poolById = new Map(input.pool.map((i) => [i.id, i]));
  const models = new Map(input.models.map((m) => [m.conceptId, m]));
  const used = new Set<string>();
  let total = 0;
  const full = () => total >= input.minutes;
  const take = (id: string, kind: ItemFormat | "card") => {
    used.add(id);
    total += minutesOf(kind);
  };
  const blocks: SessionPlan["blocks"] = [];
  const push = (kind: SessionPlan["blocks"][number]["kind"], itemIds: string[], reason: string) => {
    if (itemIds.length) blocks.push({ kind, itemIds, reason });
  };

  const noEvidence = input.models.every((m) => m.band === "not_seen") && !input.mistakes.length && !input.dueCards.length;
  if (noEvidence) {
    const ids = diagnostic(input, (id, kind) => {
      if (full()) return false;
      take(id, kind);
      return true;
    });
    push("diagnostic", ids, DIAGNOSTIC_REASON);
    return { sessionId: input.sessionId, minutes: input.minutes, blocks, plannedMinutes: total };
  }

  // 1. R4 items: confident misses, up to 3.
  const r4: string[] = [];
  for (const m of input.mistakes.filter((x) => x.confident)) {
    const item = poolById.get(m.itemId);
    if (!item || full() || r4.length >= 3) continue;
    take(item.id, item.kind);
    r4.push(item.id);
  }
  push("confident_misses", r4, "Questions you were sure about and missed. Answering them again helps fix the mix-up.");

  // 2. Due mistakes.
  const due: string[] = [];
  for (const m of input.mistakes.filter((x) => x.due && !used.has(x.itemId))) {
    const item = poolById.get(m.itemId);
    if (!item || full()) continue;
    take(item.id, item.kind);
    due.push(item.id);
  }
  push("mistakes", due, "Questions you missed before, due again.");

  // 3. Due cards: by covered-assessment date, then concept priority, then lowest R.
  const nextExam = (c: string) => models.get(c)?.coveredBy.filter((a) => a.daysAway >= 0).map((a) => a.daysAway).sort((a, b) => a - b)[0] ?? Infinity;
  const prio = (c: string) => (models.get(c) ? conceptPriority(models.get(c)!, input.config) : 0);
  const cards = [...input.dueCards].sort(
    (a, b) => nextExam(a.conceptId) - nextExam(b.conceptId) || prio(b.conceptId) - prio(a.conceptId) || (a.r ?? 1) - (b.r ?? 1) || (a.cardId < b.cardId ? -1 : 1),
  );
  const cardIds: string[] = [];
  for (const c of cards) {
    if (full()) break;
    take(c.cardId, "card");
    cardIds.push(c.cardId);
  }
  push("due_cards", cardIds, "Cards due for review, soonest assessment first.");

  // 4. Learn: concepts by group (Iffy, Getting there, Not seen yet), then priority, then module order; interleaved.
  const band = p.difficultyBands[input.difficulty];
  const group = { iffy: 0, getting_there: 1, not_seen: 2, solid: 3 } as const;
  const position = new Map(input.concepts.map((c) => [c.id, c.position]));
  const ordered = input.models
    .filter((m) => m.band !== "solid")
    .sort((a, b) => group[a.band] - group[b.band] || (a.band === "not_seen" ? (position.get(a.conceptId) ?? 0) - (position.get(b.conceptId) ?? 0) : conceptPriority(b, input.config) - conceptPriority(a, input.config)) || (a.conceptId < b.conceptId ? -1 : 1));
  const learn: string[] = [];
  let progressed = true;
  while (!full() && progressed) {
    progressed = false;
    for (const m of ordered) {
      if (full()) break;
      const eligible = input.pool.filter((i) => !used.has(i.id) && i.kind !== "card" && primaryOf(i.tags) === m.conceptId);
      if (!eligible.length) continue;
      const best = eligible
        .map((i) => ({ i, d: bandDistance(predictedSuccess(models, i), band) }))
        .sort((a, b) => a.d - b.d || (a.i.id < b.i.id ? -1 : 1))[0]!.i;
      take(best.id, best.kind);
      learn.push(best.id);
      progressed = true;
    }
  }
  push("learn", learn, "Practice on your Iffy topics first, then Getting there, then Not seen yet.");
  return { sessionId: input.sessionId, minutes: input.minutes, blocks, plannedMinutes: total };
}

/** One item per unit in module order, ≤8, skippable by the student at any point (KM-9). */
function diagnostic(input: SessionInput, add: (id: string, kind: ItemFormat | "card") => boolean): string[] {
  const byId = new Map(input.concepts.map((c) => [c.id, c]));
  const unitOf = (conceptId: string) => {
    const c = byId.get(conceptId);
    return c?.kind === "unit" ? c : c?.parentId ? byId.get(c.parentId) : c;
  };
  const units = new Map<string, { position: number; items: PoolItem[] }>();
  for (const i of input.pool) {
    if (i.kind === "card") continue;
    const u = unitOf(primaryOf(i.tags));
    if (!u) continue;
    const entry = units.get(u.id) ?? { position: u.position, items: [] };
    entry.items.push(i);
    units.set(u.id, entry);
  }
  const out: string[] = [];
  for (const [, u] of [...units].sort((a, b) => a[1].position - b[1].position || (a[0] < b[0] ? -1 : 1))) {
    if (out.length >= DIAGNOSTIC_MAX) break;
    const item = [...u.items].sort((a, b) => Math.abs(a.bPrior) - Math.abs(b.bPrior) || (a.id < b.id ? -1 : 1))[0]!;
    if (!add(item.id, item.kind)) break;
    out.push(item.id);
  }
  return out;
}
