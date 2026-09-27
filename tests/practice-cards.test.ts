import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "../packages/learning/src/config";
import { newCard, review } from "../packages/learning/src/fsrs";
import { conceptState } from "../packages/learning/src/knowledge/state";
import { createLearnRound, nextQuestion, recordAnswer } from "../packages/learning/src/learn";
import { cardFace, learnOptions, MC_ONLY_LABEL, ratingToSave, shuffleDue, suggestRating } from "../packages/learning/src/practice/cards-ui-logic";
import type { LearningAttempt } from "../packages/learning/src/store";

test("shuffle stays within the due set and is replayable", () => {
  const due = ["k1", "k2", "k3", "k4", "k5", "k6"];
  const a = shuffleDue(due, 42);
  assert.deepEqual([...a].sort(), due);
  assert.deepEqual(shuffleDue(due, 42), a);
  assert.notDeepEqual(shuffleDue(due, 43), due);
});

test("negative: swapping sides never creates a second FSRS card", () => {
  const card = newCard({ id: "k1", itemId: "i1", courseRef: "r", conceptId: "c1" }, new Date("2026-09-20T12:00:00Z"));
  const front = cardFace({ id: "k1", front: "Load factor", back: "keys / buckets" }, false);
  const back = cardFace({ id: "k1", front: "Load factor", back: "keys / buckets" }, true);
  assert.equal(front.cardId, back.cardId);
  assert.equal(back.prompt, "keys / buckets");
  // A review made from the swapped face updates the one card.
  const r = review(card, 3, new Date("2026-09-20T12:01:00Z"), { id: "v1", reviewMs: 800, localDay: "2026-09-20" });
  assert.equal(r.review.cardId, back.cardId);
});

test("type the answer suggests a rating; negative: a suggestion is never saved without the student's own rating", () => {
  const face = cardFace({ id: "k1", front: "What is a collision?", back: "Two keys map to the same bucket" }, false);
  assert.equal(suggestRating(face, "two keys map to the same bucket.").suggested, 3);
  const ideas = [{ idea: "two keys", synonyms: [], required: true }, { idea: "same bucket", synonyms: [], required: true }];
  assert.equal(suggestRating(face, "two keys collide somewhere", ideas).suggested, 2);
  assert.equal(suggestRating(face, "a resize").suggested, 1);
  assert.equal(ratingToSave(3, undefined), null);
  assert.equal(ratingToSave(3, 1), 1, "the student's rating wins");
});

test("Learn rounds of 5, 7 or 10; multiple choice only carries its label", () => {
  assert.equal(learnOptions({ roundSize: 5 }).roundSize, 5);
  assert.throws(() => learnOptions({ roundSize: 6 }));
  const mc = learnOptions({ mcOnly: true });
  assert.equal(mc.label, MC_ONLY_LABEL);
  assert.match(MC_ONLY_LABEL, /Recognition only/);
  assert.equal(learnOptions({}).label, null);
});

test("negative: in multiple choice only, a concept still can't reach Solid on recognition alone", () => {
  const families = Array.from({ length: 10 }, (_, i) => ({
    familyId: `f${i}`,
    recognition: { id: `mc${i}`, version: 1, kind: "mc" as const, stem: `Q${i}`, options: [{ id: "a", text: "a" }, { id: "b", text: "b" }, { id: "c", text: "c" }, { id: "d", text: "d" }], key: "a", keyIdeas: [], bPrior: -0.5 },
    recall: { id: `ty${i}`, version: 1, kind: "typed" as const, stem: `T${i}`, options: null, key: "x", keyIdeas: [], bPrior: 0.5 },
  }));
  const attempts: LearningAttempt[] = [];
  const items = new Map<string, { bPrior: number; options: number; status: "active" }>();
  for (let round = 0; round < 6; round++) {
    let state = createLearnRound(families, { size: 10, mcOnly: true });
    for (let q = nextQuestion(state); q; q = nextQuestion(state)) {
      const r = recordAnswer(state, q, "right");
      state = r.state;
      const id = `${round}-${r.attempt.itemId}`;
      items.set(`${id}@1`, { bPrior: r.attempt.bPrior, options: 4, status: "active" });
      attempts.push({ id: `a-${id}`, courseRef: "r", itemId: id, itemVersion: 1, sourceResourceId: null, primaryConceptId: "c1", correct: true, assistance: "none", seenBefore: false, confidence: null, createdAt: `2026-09-2${round}T10:00:${String(attempts.length % 60).padStart(2, "0")}.000Z`, format: r.attempt.format, mode: "learn", response: null, score: 1, gradingMethod: "exact", responseMs: 1, conceptTags: [{ conceptId: "c1", weight: 1, primary: true }], sessionId: `s${round}`, localDay: `2026-09-2${round}` });
    }
  }
  assert.equal(attempts.length, 60);
  assert.ok(attempts.every((a) => a.format === "mc"));
  const map = [{ id: "c1", courseRef: "r", parentId: null, label: "c1", kind: "concept" as const, position: 0, origin: "code" as const, status: "active" as const, mergedInto: null, studentLabel: null, mapVersion: "m", sources: [] }];
  const m = conceptState({ attempts, reviews: [], selfRatings: [], disputes: [], items, cards: new Map() }, map, CONFIG, new Date("2026-09-27T00:00:00Z"))[0]!;
  assert.notEqual(m.band, "solid");
});
