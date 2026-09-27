// N09: Learn rounds (ST-3). A round holds up to 7 item families (5, 7 or 10
// with P07's options). Each family is linked variants sharing family_id: the
// multiple-choice form, then the typed form after one right answer. A miss
// drops one stage and the family comes back after at least 2 other families.
// Pure state transitions; the caller stores each returned attempt against the
// variant used, with that variant's format and prior.
import type { ItemFormat } from "./config";
import type { ItemOption, KeyIdea } from "./store";

export interface VariantRef {
  id: string;
  version: number;
  kind: ItemFormat;
  stem: string;
  options: ItemOption[] | null;
  key: string | number;
  keyIdeas: KeyIdea[];
  bPrior: number;
}

export interface LearnFamily {
  familyId: string;
  recognition?: VariantRef | undefined;
  recall?: VariantRef | undefined;
}

/** 0: recognition stage · 1: recall stage · 2: done this round. */
export type Stage = 0 | 1 | 2;

export interface LearnState {
  families: LearnFamily[];
  stage: Record<string, Stage>;
  /** Serves of other families still needed before this family can return. */
  cooldown: Record<string, number>;
  order: string[];
  mcOnly: boolean;
  flaggedItems: string[];
}

export const ROUND_SIZES = [5, 7, 10] as const;
export const RETURN_AFTER = 2;

export function createLearnRound(pool: LearnFamily[], opts: { size?: number; mcOnly?: boolean } = {}): LearnState {
  const size = opts.size ?? 7;
  const mcOnly = opts.mcOnly ?? false;
  const usable = pool.filter((f) => (mcOnly ? f.recognition : f.recognition || f.recall)).slice(0, size);
  const stage: Record<string, Stage> = {};
  for (const f of usable) stage[f.familyId] = f.recognition ? 0 : 1;
  return {
    families: usable,
    stage,
    cooldown: Object.fromEntries(usable.map((f) => [f.familyId, 0])),
    order: usable.map((f) => f.familyId),
    mcOnly,
    flaggedItems: [],
  };
}

export interface LearnQuestion {
  familyId: string;
  itemId: string;
  itemVersion: number;
  format: ItemFormat;
  stem: string;
  /** Present only in the recognition stage: the recall stage never exposes options. */
  options?: ItemOption[];
}

const variantFor = (f: LearnFamily, s: Stage) => (s === 0 ? f.recognition : f.recall);

function open(state: LearnState): string[] {
  return state.order.filter((id) => (state.stage[id] ?? 2) < 2);
}

/** The next question, or null when the round is done. Never blocked: a lone family is served even while cooling down. */
export function nextQuestion(state: LearnState): LearnQuestion | null {
  const ids = open(state);
  if (!ids.length) return null;
  const ready = ids.find((id) => (state.cooldown[id] ?? 0) === 0) ?? [...ids].sort((a, b) => state.cooldown[a]! - state.cooldown[b]!)[0]!;
  const f = state.families.find((x) => x.familyId === ready)!;
  const v = variantFor(f, state.stage[ready]!)!;
  return {
    familyId: ready,
    itemId: v.id,
    itemVersion: v.version,
    format: v.kind,
    stem: v.stem,
    ...(state.stage[ready] === 0 && v.options ? { options: v.options.map((o) => ({ ...o })) } : {}),
  };
}

export interface AttemptDraft {
  familyId: string;
  itemId: string;
  itemVersion: number;
  format: ItemFormat;
  bPrior: number;
  outcome: "right" | "wrong" | "undecided";
}

/** Record an answer to the question just served. Returns the new state and the attempt to store. */
export function recordAnswer(state: LearnState, q: LearnQuestion, outcome: AttemptDraft["outcome"]): { state: LearnState; attempt: AttemptDraft } {
  const f = state.families.find((x) => x.familyId === q.familyId);
  if (!f) throw new Error(`family ${q.familyId} isn't in this round`);
  const s = state.stage[q.familyId]!;
  const v = variantFor(f, s);
  if (!v || v.id !== q.itemId) throw new Error("the answer doesn't match the question served");
  const stage = { ...state.stage };
  const cooldown = { ...state.cooldown };
  for (const id of Object.keys(cooldown)) if (id !== q.familyId && cooldown[id]! > 0) cooldown[id]!--;
  if (outcome === "right") {
    const nextStage: Stage = s === 0 && f.recall && !state.mcOnly ? 1 : 2;
    stage[q.familyId] = nextStage;
    cooldown[q.familyId] = 0;
  } else if (outcome === "wrong") {
    stage[q.familyId] = s === 1 && f.recognition ? 0 : s;
    cooldown[q.familyId] = RETURN_AFTER;
  } else {
    cooldown[q.familyId] = RETURN_AFTER;
  }
  // Interleave: the family just served goes to the back.
  const order = [...state.order.filter((id) => id !== q.familyId), q.familyId];
  return {
    state: { ...state, stage, cooldown, order },
    attempt: { familyId: f.familyId, itemId: v.id, itemVersion: v.version, format: v.kind, bPrior: v.bPrior, outcome },
  };
}

/** A flagged or quarantined item takes its family out of the round at once (ST-9). */
export function flagItem(state: LearnState, itemId: string): LearnState {
  const gone = new Set(state.families.filter((f) => f.recognition?.id === itemId || f.recall?.id === itemId).map((f) => f.familyId));
  return { ...state, order: state.order.filter((id) => !gone.has(id)), flaggedItems: [...state.flaggedItems, itemId] };
}

export function roundDone(state: LearnState): boolean {
  return open(state).length === 0;
}
