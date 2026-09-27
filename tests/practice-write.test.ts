import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "../packages/learning/src/config";
import { conceptState } from "../packages/learning/src/knowledge/state";
import { createMemoryLearningStore } from "../packages/learning/src/memory-store";
import { attemptStatus, contest, gradeWrite, withdrawContest, writePrompt } from "../packages/learning/src/practice/write";
import type { LearningAttempt, LearningStore } from "../packages/learning/src/store";

const ideas = [
  { idea: "two keys", synonyms: ["distinct keys"], required: true },
  { idea: "same bucket", synonyms: ["same slot"], required: true },
];
const mcOnlyFamily = {
  familyId: "f1",
  recognition: { id: "mc1", version: 1, kind: "mc" as const, stem: "What is a collision?", options: [{ id: "a", text: "Two keys map to the same bucket" }, { id: "b", text: "A resize" }, { id: "c", text: "A deletion" }], key: "a", keyIdeas: ideas, bPrior: -0.5 },
};

test("typed recall for every family, graded by key ideas, with found and missing ideas listed", () => {
  const typedFamily = { ...mcOnlyFamily, recall: { id: "ty1", version: 1, kind: "typed" as const, stem: "Define a collision.", options: null, key: "Two keys map to the same bucket", keyIdeas: ideas, bPrior: 0.5 } };
  assert.equal(writePrompt(typedFamily)!.itemId, "ty1");
  const p = writePrompt(mcOnlyFamily)!;
  assert.equal(p.itemId, "mc1");
  assert.equal(p.key, "Two keys map to the same bucket");
  assert.equal("options" in p, false);
  const fb = gradeWrite(p, "distinct keys end up together");
  assert.deepEqual(fb.found, ["two keys"]);
  assert.deepEqual(fb.notChecked, ["same bucket"]);
  const blank = gradeWrite(p, "");
  assert.deepEqual(blank.missing, ["two keys", "same bucket"]);
});

function seeded(): { store: LearningStore; ref: string; wrong: LearningAttempt } {
  const store = createMemoryLearningStore(() => "2026-09-20T12:00:00Z");
  const ref = store.course("acct", "SYN101").id;
  const mk = (id: string, score: number, i: number): LearningAttempt => ({
    id, courseRef: ref, itemId: `item-${id}`, itemVersion: 1, sourceResourceId: null, primaryConceptId: "c1", correct: score >= 1, assistance: "none",
    seenBefore: false, confidence: null, createdAt: `2026-09-20T12:0${i}:00.000Z`, format: "typed", mode: "write", response: { text: "x" }, score,
    gradingMethod: "code", responseMs: 5000, conceptTags: [{ conceptId: "c1", weight: 1, primary: true }], sessionId: "s1", localDay: "2026-09-20",
  });
  store.addAttempt(mk("a1", 1, 1));
  store.addAttempt(mk("a2", 1, 2));
  const wrong = mk("a3", 0, 3);
  store.addAttempt(wrong);
  return { store, ref, wrong };
}

const map = [{ id: "c1", courseRef: "acct:SYN101", parentId: null, label: "c1", kind: "concept" as const, position: 0, origin: "code" as const, status: "active" as const, mergedInto: null, studentLabel: null, mapVersion: "m", sources: [] }];
function model(store: LearningStore, ref: string) {
  const ev = store.evidence(ref);
  const items = new Map(ev.attempts.map((a) => [`${a.itemId}@1`, { bPrior: 0.5, options: 0, status: "active" as const }]));
  return conceptState({ ...ev, items, cards: new Map() }, map, CONFIG, new Date("2026-09-21T00:00:00Z"))[0]!;
}

test("contest stores a grade dispute and removes the attempt from the knowledge model; withdrawing restores it", () => {
  const { store, ref, wrong } = seeded();
  const before = model(store, ref);
  const d = contest(store, wrong, "2026-09-20T12:10:00Z", "I wrote the same thing");
  assert.equal(attemptStatus(wrong, store.evidence(ref).disputes), "contested");
  const contested = model(store, ref);
  assert.notEqual(contested.theta, before.theta);
  assert.equal(contested.counts.answers, 2);
  withdrawContest(store, d.id, "2026-09-20T12:20:00Z");
  assert.equal(attemptStatus(wrong, store.evidence(ref).disputes), "counted");
  assert.deepEqual(model(store, ref), before);
});

test("negative: a contest never makes an attempt count as correct; it's excluded, never flipped", () => {
  const { store, ref, wrong } = seeded();
  contest(store, wrong, "2026-09-20T12:10:00Z");
  const stored = store.evidence(ref).attempts.find((a) => a.id === wrong.id)!;
  assert.equal(stored.correct, false);
  assert.equal(stored.score, 0);
  const excluded = model(store, ref);
  // Flipping it would count 3 right answers; exclusion counts 2.
  assert.equal(excluded.counts.correct, 2);
});
