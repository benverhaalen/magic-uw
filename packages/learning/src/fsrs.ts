// N14: the FSRS adapter (ts-fsrs 5.4.2, request retention 0.90), the pre-exam
// review (ST-2), undo by log, and per-concept retrievability (spec §5.4).
import { createEmptyCard, fsrs, type Card, type Grade, type FSRS } from "ts-fsrs";
import { CONFIG } from "./config";
import type { FsrsCardState, LearningCard, LearningReview } from "./store";

const DAY_MS = 86_400_000;

export const FSRS_VERSION = CONFIG.fsrsVersion;
export const REQUEST_RETENTION = CONFIG.r5RequestRetention.value;

/** Fuzz is off so that scheduling is a pure function of the log (KM-4). */
export function scheduler(): FSRS {
  return fsrs({ request_retention: REQUEST_RETENTION, enable_fuzz: false });
}

export function paramsHash(): string {
  const p = scheduler().parameters;
  return `rr=${p.request_retention};w=${[...p.w].join(",")}`;
}

export function toLibCard(s: FsrsCardState): Card {
  return {
    due: new Date(s.due),
    stability: s.stability,
    difficulty: s.difficulty,
    elapsed_days: s.elapsed_days,
    scheduled_days: s.scheduled_days,
    learning_steps: s.learning_steps,
    reps: s.reps,
    lapses: s.lapses,
    state: s.state,
    ...(s.last_review ? { last_review: new Date(s.last_review) } : {}),
  };
}

export function fromLibCard(c: Card): FsrsCardState {
  return {
    due: c.due.toISOString(),
    stability: c.stability,
    difficulty: c.difficulty,
    elapsed_days: c.elapsed_days,
    scheduled_days: c.scheduled_days,
    learning_steps: c.learning_steps,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state,
    last_review: c.last_review ? c.last_review.toISOString() : null,
  };
}

export function newCardState(now: Date): FsrsCardState {
  return fromLibCard(createEmptyCard(now));
}

export function newCard(init: { id: string; itemId: string; courseRef: string; conceptId: string; isConceptTrack?: boolean }, now: Date): LearningCard {
  return {
    ...init,
    isConceptTrack: init.isConceptTrack ?? false,
    fsrs: newCardState(now),
    fsrsVersion: FSRS_VERSION,
    paramsHash: paramsHash(),
  };
}

export interface ReviewMeta {
  id: string;
  reviewMs: number;
  localDay: string;
}

/** Review a card. Returns the new card and an immutable (frozen) log row. */
export function review(card: LearningCard, rating: Grade, now: Date, meta: ReviewMeta): { card: LearningCard; review: Readonly<LearningReview> } {
  const next = scheduler().next(toLibCard(card.fsrs), now, rating);
  const after = fromLibCard(next.card);
  const row: LearningReview = Object.freeze({
    id: meta.id,
    cardId: card.id,
    rating: rating as 1 | 2 | 3 | 4,
    stateBefore: Object.freeze({ ...card.fsrs }),
    stateAfter: Object.freeze({ ...after }),
    reviewMs: meta.reviewMs,
    localDay: meta.localDay,
    undoesReviewId: null,
    createdAt: now.toISOString(),
  });
  return { card: { ...card, fsrs: after }, review: row };
}

/**
 * Undo a review: restore the state from its log row and write an undo row.
 * Nothing is deleted; the undone review stays in the log.
 */
export function undo(card: LearningCard, undone: LearningReview, now: Date, meta: ReviewMeta): { card: LearningCard; review: Readonly<LearningReview> } {
  if (undone.cardId !== card.id) throw new Error("the review belongs to another card");
  if (undone.undoesReviewId) throw new Error("an undo row can't itself be undone");
  const row: LearningReview = Object.freeze({
    id: meta.id,
    cardId: card.id,
    rating: undone.rating,
    stateBefore: Object.freeze({ ...card.fsrs }),
    stateAfter: Object.freeze({ ...undone.stateBefore }),
    reviewMs: meta.reviewMs,
    localDay: meta.localDay,
    undoesReviewId: undone.id,
    createdAt: now.toISOString(),
  });
  return { card: { ...card, fsrs: { ...undone.stateBefore } }, review: row };
}

/** Retrievability now, from the library's forgetting curve; null for a card never reviewed. */
export function retrievability(state: FsrsCardState, now: Date): number | null {
  if (!state.last_review || state.reps === 0) return null;
  return scheduler().get_retrievability(toLibCard(state), now, false);
}

/**
 * R_c: the median R over the concept's reviewed cards; with none, the concept
 * track's R; otherwise null (spec §5.4).
 */
export function conceptR(cards: LearningCard[], now: Date): number | null {
  const rs = cards
    .filter((c) => !c.isConceptTrack)
    .map((c) => retrievability(c.fsrs, now))
    .filter((r): r is number => r !== null)
    .sort((a, b) => a - b);
  if (rs.length) {
    const mid = Math.floor(rs.length / 2);
    return rs.length % 2 ? rs[mid]! : (rs[mid - 1]! + rs[mid]!) / 2;
  }
  const track = cards.find((c) => c.isConceptTrack);
  return track ? retrievability(track.fsrs, now) : null;
}

/**
 * The concept track is fed by the first scored attempt on the concept each local
 * day (correct → Good, miss → Again). Returns null when the day already fed it.
 */
export function feedConceptTrack(
  track: LearningCard,
  trackReviews: LearningReview[],
  attempt: { correct: boolean; localDay: string; createdAt: string },
  id: string,
): { card: LearningCard; review: Readonly<LearningReview> } | null {
  if (!track.isConceptTrack) throw new Error("not a concept track");
  if (trackReviews.some((r) => r.cardId === track.id && r.localDay === attempt.localDay && !r.undoesReviewId)) return null;
  return review(track, (attempt.correct ? 3 : 1) as Grade, new Date(attempt.createdAt), { id, reviewMs: 0, localDay: attempt.localDay });
}

export interface AssessmentDate {
  id: string;
  at: string;
  conceptIds: string[];
}

export interface PreExamReview {
  cardId: string;
  assessmentId: string;
  at: string;
}

/**
 * For cards covering an assessment within 14 days whose FSRS due date is later
 * than (assessment − 1 day), add one review at max(now, assessment − 2 days).
 * The FSRS state is not edited; this is an extra entry in the queue (ST-2).
 */
export function preExamReviews(cards: LearningCard[], assessments: AssessmentDate[], now: Date): PreExamReview[] {
  const windowMs = CONFIG.preExamWindowDays.value * DAY_MS;
  const upcoming = assessments
    .map((a) => ({ ...a, t: Date.parse(a.at) }))
    .filter((a) => a.t >= now.getTime() && a.t - now.getTime() <= windowMs)
    .sort((a, b) => a.t - b.t);
  const out: PreExamReview[] = [];
  for (const card of cards) {
    if (card.isConceptTrack) continue;
    const a = upcoming.find((x) => x.conceptIds.includes(card.conceptId));
    if (!a) continue;
    if (Date.parse(card.fsrs.due) <= a.t - DAY_MS) continue;
    out.push({ cardId: card.id, assessmentId: a.id, at: new Date(Math.max(now.getTime(), a.t - 2 * DAY_MS)).toISOString() });
  }
  return out;
}
