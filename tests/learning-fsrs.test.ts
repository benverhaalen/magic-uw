import { test } from "node:test";
import assert from "node:assert/strict";
import { forgetting_curve, Rating } from "ts-fsrs";
import {
  conceptR,
  feedConceptTrack,
  newCard,
  preExamReviews,
  retrievability,
  review,
  scheduler,
  undo,
} from "../packages/learning/src/fsrs";
import { createMemoryLearningStore } from "../packages/learning/src/memory-store";

const DAY = 86_400_000;
const t0 = new Date("2026-09-01T14:00:00.000Z");
const at = (days: number) => new Date(t0.getTime() + days * DAY);
const base = { itemId: "i1", courseRef: "acct:SYN101", conceptId: "c1" };

function reviewed(id: string, ratings: Rating[]) {
  let card = newCard({ ...base, id }, t0);
  let day = 0;
  for (const [n, r] of ratings.entries()) {
    card = review(card, r as 1 | 2 | 3 | 4, at(day), { id: `${id}-v${n}`, reviewMs: 1000, localDay: "d" }).card;
    day = (Date.parse(card.fsrs.due) - t0.getTime()) / DAY;
  }
  return card;
}

test("wraps ts-fsrs at request retention 0.90; review() returns the new card and a frozen log row", () => {
  assert.equal(scheduler().parameters.request_retention, 0.9);
  const card = newCard({ ...base, id: "k1" }, t0);
  const out = review(card, Rating.Good, t0, { id: "v1", reviewMs: 1200, localDay: "2026-09-01" });
  assert.equal(out.review.stateBefore.reps, 0);
  assert.equal(out.card.fsrs.reps, 1);
  assert.deepEqual(out.review.stateAfter, out.card.fsrs);
  assert.throws(() => {
    (out.review as { rating: number }).rating = 1;
  }, TypeError);
  assert.equal(card.fsrs.reps, 0, "the input card isn't mutated");
});

test("retrievability matches the library's forgetting curve at the pinned version", () => {
  const card = reviewed("k1", [Rating.Good, Rating.Good, Rating.Good]);
  const last = new Date(card.fsrs.last_review!);
  const w = scheduler().parameters.w;
  for (const days of [1, 5, 20, 60]) {
    const expected = forgetting_curve(w, days, card.fsrs.stability);
    assert.ok(Math.abs(retrievability(card.fsrs, new Date(last.getTime() + days * DAY))! - expected) < 1e-9, `t=${days}`);
  }
  assert.equal(retrievability(newCard({ ...base, id: "fresh" }, t0).fsrs, t0), null);
});

test("conceptR is the median over reviewed cards, else the concept track, else null", () => {
  const a = reviewed("a", [Rating.Good]);
  const b = reviewed("b", [Rating.Good, Rating.Good]);
  const c = reviewed("c", [Rating.Again]);
  const now = at(30);
  const rs = [a, b, c].map((k) => retrievability(k.fsrs, now)!).sort((x, y) => x - y);
  assert.equal(conceptR([a, b, c, newCard({ ...base, id: "unreviewed" }, t0)], now), rs[1]);
  const track = newCard({ ...base, id: "track", isConceptTrack: true }, t0);
  const fed = feedConceptTrack(track, [], { correct: true, localDay: "2026-09-01", createdAt: t0.toISOString() }, "tv1")!;
  assert.equal(conceptR([fed.card], now), retrievability(fed.card.fsrs, now));
  assert.equal(feedConceptTrack(fed.card, [fed.review], { correct: false, localDay: "2026-09-01", createdAt: at(0.1).toISOString() }, "tv2"), null, "one feed per local day");
  assert.equal(conceptR([], now), null);
});

test("pre-exam review at max(now, assessment − 2 days) for covered cards due after assessment − 1 day, without editing FSRS state", () => {
  const card = reviewed("k1", [Rating.Good, Rating.Good, Rating.Easy]);
  const due = Date.parse(card.fsrs.due);
  const now = new Date(due - 20 * DAY);
  const before = structuredClone(card);
  const exam = { id: "exam2", at: new Date(now.getTime() + 10 * DAY).toISOString(), conceptIds: ["c1"] };
  const out = preExamReviews([card], [exam], now);
  assert.deepEqual(out, [{ cardId: "k1", assessmentId: "exam2", at: new Date(now.getTime() + 8 * DAY).toISOString() }]);
  assert.deepEqual(card, before);
  // An exam tomorrow: the review is now.
  assert.equal(preExamReviews([card], [{ ...exam, at: new Date(now.getTime() + DAY).toISOString() }], now)[0]!.at, now.toISOString());
  // Negative: outside 14 days, not covered, or already due before the exam.
  assert.deepEqual(preExamReviews([card], [{ ...exam, at: new Date(now.getTime() + 15 * DAY).toISOString() }], now), []);
  assert.deepEqual(preExamReviews([card], [{ ...exam, conceptIds: ["c2"] }], now), []);
  assert.deepEqual(preExamReviews([card], [{ ...exam, at: new Date(due + 2 * DAY).toISOString() }], new Date(due - 5 * DAY)), []);
});

test("negative: undo restores the previous state from the log and writes an undo row; nothing is deleted", () => {
  const store = createMemoryLearningStore();
  const ref = store.course("acct", "SYN101").id;
  store.putConceptMap(ref, [{ id: "c1", courseRef: ref, parentId: null, label: "C", kind: "concept", position: 0, origin: "code", status: "active", mergedInto: null, studentLabel: null, mapVersion: "m", sources: [] }], "m");
  store.putItem({ id: "i1", version: 1, courseRef: ref, familyId: "f", kind: "card", stem: "front", options: null, key: "back", keyIdeas: [], explanation: null, tempting: {}, bloom: "remember", bPrior: 0, tier: "T4", sourceTerm: null, origin: "generated", status: "active", statusReason: null, generator: null, createdAt: t0.toISOString() }, [], [{ conceptId: "c1", weight: 1, primary: true }], []);
  let card = reviewed("k1", [Rating.Good]);
  store.putCard(card);
  const before = structuredClone(card.fsrs);
  const r = review(card, Rating.Again, at(3), { id: "v-again", reviewMs: 800, localDay: "2026-09-04" });
  store.addReview(r.review);
  card = r.card;
  assert.notDeepEqual(card.fsrs, before);
  const u = undo(card, r.review, at(3.01), { id: "v-undo", reviewMs: 0, localDay: "2026-09-04" });
  store.addReview(u.review);
  assert.deepEqual(u.card.fsrs, before);
  assert.equal(u.review.undoesReviewId, "v-again");
  const log = store.evidence(ref).reviews.map((x) => x.id);
  assert.deepEqual(log, ["v-again", "v-undo"]);
  assert.throws(() => undo(u.card, u.review, at(3.02), { id: "v-x", reviewMs: 0, localDay: "d" }), /can't itself be undone/);
});
