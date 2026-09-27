// P07: flashcard quality of life and Learn options (PI-9, PI-10). Shuffle within
// the due set, swap front and back (the same FSRS card: a view, never a second
// card), and "type the answer" with a suggested rating the student confirms.
import { gradeTyped, normaliseAnswer } from "../grade";
import { ROUND_SIZES } from "../learn";
import { STATE_LABEL } from "../types";
import type { KeyIdea } from "../store";

export type Rating = 1 | 2 | 3 | 4;

/** Deterministic shuffle (mulberry32), so a session can be replayed. Only the due set is shuffled. */
export function shuffleDue<T>(due: T[], seed: number): T[] {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...due];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export interface CardFace {
  cardId: string;
  prompt: string;
  answer: string;
  swapped: boolean;
}

/** Front/back swap is a presentation of the same card: the card ID (and its FSRS state) doesn't change. */
export function cardFace(card: { id: string; front: string; back: string }, swapped: boolean): CardFace {
  return { cardId: card.id, prompt: swapped ? card.back : card.front, answer: swapped ? card.front : card.back, swapped };
}

/**
 * "Type the answer": code compares the typed text with the answer side and
 * suggests a rating (Good for a match, Hard when some key ideas are found,
 * Again otherwise; never Easy). It's only a suggestion.
 */
export function suggestRating(face: CardFace, typed: string, keyIdeas: KeyIdea[] = []): { suggested: Rating; basis: string } {
  if (normaliseAnswer(typed) && normaliseAnswer(typed) === normaliseAnswer(face.answer)) return { suggested: 3, basis: "Your answer matches the card." };
  const g = gradeTyped({ id: face.cardId, key: face.answer, keyIdeas }, typed);
  if (g.outcome === "correct") return { suggested: 3, basis: "Your answer has every key idea." };
  if (g.keyIdeas.some((i) => i.found)) return { suggested: 2, basis: "Your answer has some of the key ideas." };
  return { suggested: 1, basis: "Your answer doesn't match the card." };
}

/**
 * The rating to save is always the student's own. A suggestion alone is never
 * saved: without the student's rating there's nothing to save.
 */
export function ratingToSave(_suggested: Rating | null, studentRating: Rating | null | undefined): Rating | null {
  return studentRating ?? null;
}

export type RoundSize = (typeof ROUND_SIZES)[number];

export interface LearnOptions {
  roundSize: RoundSize;
  mcOnly: boolean;
}

export const MC_ONLY_LABEL = `Recognition only: these answers won't make a topic ${STATE_LABEL.solid}`;

export function learnOptions(input: { roundSize?: number; mcOnly?: boolean }): LearnOptions & { label: string | null } {
  const size = input.roundSize ?? 7;
  if (!(ROUND_SIZES as readonly number[]).includes(size)) throw new Error(`a Learn round is 5, 7 or 10 families, not ${size}`);
  const mcOnly = input.mcOnly ?? false;
  return { roundSize: size as RoundSize, mcOnly, label: mcOnly ? MC_ONLY_LABEL : null };
}
