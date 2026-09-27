import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "../packages/learning/src/config";
import { conceptState } from "../packages/learning/src/knowledge/state";
import { LABEL } from "../packages/learning/src/labels";
import { createMemoryLearningStore } from "../packages/learning/src/memory-store";
import { createMemoryPracticeStore } from "../packages/learning/src/practice/memory-store";
import { createOwnCard, editCard } from "../packages/learning/src/practice/own-cards";
import { applyFilter, setStar, type FilterEntry } from "../packages/learning/src/practice/stars";
import type { Concept, LearningAttempt } from "../packages/learning/src/store";
import { exactValidate } from "./learning-fixtures";

const T = "2026-09-20T12:00:00.000Z";
const REF = "acct:SYN101";
const concept = (id: string): Concept => ({ id, courseRef: REF, parentId: null, label: id, kind: "concept", position: 0, origin: "code", status: "active", mergedInto: null, studentLabel: null, mapVersion: "m", sources: [] });
const MAP = [concept("c1"), concept("c2")];
const lecture = { id: "lec3", version: 1, title: "Lecture 3: Hashing", contentHash: "h1", text: "Chaining stores colliding keys in a linked list at each bucket. The load factor alpha is keys over buckets." };

function setup() {
  const learning = createMemoryLearningStore(() => T);
  learning.course("acct", "SYN101");
  learning.putConceptMap(REF, MAP, "m");
  const practice = createMemoryPracticeStore(learning);
  return { learning, practice };
}

test("a card from a notebook selection stores its anchor; a blank card has none; both can be tagged to 1–3 concepts", () => {
  const selected = createOwnCard({ id: "own1", courseRef: REF, front: "What does chaining do?", back: "Keeps colliding keys in a list", anchor: { resourceId: "lec3", version: 1, start: 0, end: 62 }, tags: [{ conceptId: "c1", primary: true }] }, { resources: [lecture], map: MAP, now: new Date(T) });
  assert.equal(selected.sources[0]!.quote, lecture.text.slice(0, 62));
  assert.deepEqual(selected.labels, ["Your card · from Lecture 3: Hashing", LABEL.quoteFound]);
  assert.equal(selected.item.origin, "student");
  const blank = createOwnCard({ id: "own2", courseRef: REF, front: "Load factor", back: "keys / buckets" }, { resources: [lecture], map: MAP, now: new Date(T) });
  assert.deepEqual(blank.sources, []);
  assert.deepEqual(blank.labels, ["Your card · no source"]);
  assert.throws(() => createOwnCard({ id: "x", courseRef: REF, front: "f", back: "b", tags: [{ conceptId: "c1", primary: true }, { conceptId: "c2", primary: true }] }, { resources: [], map: MAP, now: new Date(T) }));
  assert.throws(() => createOwnCard({ id: "x", courseRef: REF, front: "f", back: "b", anchor: { resourceId: "lec3", version: 2, start: 0, end: 20 } }, { resources: [lecture], map: MAP, now: new Date(T) }), /another version/);
});

test("an edit creates a new student version, re-runs the checks, and evidence stays on its version", () => {
  const { learning } = setup();
  const made = createOwnCard({ id: "own1", courseRef: REF, front: "What does chaining do?", back: "Keeps colliding keys in a list", anchor: { resourceId: "lec3", version: 1, start: 0, end: 62 }, tags: [{ conceptId: "c1", primary: true }] }, { resources: [lecture], map: MAP, now: new Date(T) });
  learning.putItem(made.item, made.sources, made.tags, []);
  learning.addAttempt({ id: "a1", courseRef: REF, itemId: "own1", itemVersion: 1, sourceResourceId: "lec3", primaryConceptId: "c1", correct: true, assistance: "none", seenBefore: false, confidence: null, createdAt: T, format: "typed", mode: "review", response: null, score: 1, gradingMethod: "self", responseMs: 1, conceptTags: made.tags, sessionId: "s", localDay: "2026-09-20" });
  const edited = editCard(learning.items({ ids: ["own1"] })[0]!, { back: "Stores colliding keys in a linked list" }, { resources: [lecture], validate: exactValidate, map: MAP, now: new Date(T) });
  assert.equal(edited.item.version, 2);
  assert.equal(edited.item.origin, "student");
  assert.ok(edited.labels.includes(LABEL.editedByYou));
  assert.ok(edited.labels.includes(LABEL.quoteFound));
  learning.putItem(edited.item, edited.sources, edited.tags, []);
  assert.deepEqual(learning.evidence(REF).attempts.map((a) => a.itemVersion), [1]);
  assert.equal(learning.items({ ids: ["own1"] }).length, 2);
});

test("negative: an edited card loses 'Quote found in source' once its quote no longer validates; a source change never deletes an own card", () => {
  const { learning } = setup();
  const made = createOwnCard({ id: "own1", courseRef: REF, front: "What does chaining do?", back: "A list per bucket", anchor: { resourceId: "lec3", version: 1, start: 0, end: 62 } }, { resources: [lecture], map: MAP, now: new Date(T) });
  learning.putItem(made.item, made.sources, made.tags, []);
  const changedText = { ...lecture, version: 2, contentHash: "h2", text: "Separate chaining keeps a list of keys per bucket." };
  const edited = editCard(learning.items({ ids: ["own1"] })[0]!, { front: "Chaining?" }, { resources: [changedText], validate: exactValidate, map: MAP, now: new Date(T) });
  assert.ok(!edited.labels.includes(LABEL.quoteFound));
  assert.equal(edited.item.statusReason, "source changed");
  const report = learning.markStale("lec3", "h2", (q) => changedText.text.includes(q));
  assert.deepEqual(report.quarantined, [{ id: "own1", version: 1 }]);
  const kept = learning.items({ ids: ["own1"] })[0]!;
  assert.equal(kept.item.statusReason, "source changed");
});

const entries: FilterEntry[] = [
  { id: "i1", itemId: "i1", targetKind: "item", tags: [{ conceptId: "c1", weight: 1, primary: true }] },
  { id: "i2", itemId: "i2", targetKind: "item", tags: [{ conceptId: "c2", weight: 1, primary: true }] },
  { id: "k3", itemId: "i3", targetKind: "card", tags: [{ conceptId: "c2", weight: 1, primary: true }] },
];

test("star and unstar items, cards and concepts; the all, starred, missed and Iffy filters", () => {
  const { learning, practice } = setup();
  for (const id of ["i1", "i2", "i3"]) {
    learning.putItem({ id, version: 1, courseRef: REF, familyId: id, kind: "card", stem: "front", options: null, key: "back", keyIdeas: [], explanation: null, tempting: {}, bloom: "remember", bPrior: 0, tier: "T4", sourceTerm: null, origin: "generated", status: "active", statusReason: null, generator: null, createdAt: T }, [], [{ conceptId: "c1", weight: 1, primary: true }], []);
  }
  learning.putCard({ id: "k3", itemId: "i3", courseRef: REF, conceptId: "c2", fsrs: { due: T, stability: 0, difficulty: 0, elapsed_days: 0, scheduled_days: 0, learning_steps: 0, reps: 0, lapses: 0, state: 0, last_review: null }, fsrsVersion: "5.4.2", paramsHash: "p", isConceptTrack: false });
  const miss: LearningAttempt = { id: "a1", courseRef: REF, itemId: "i2", itemVersion: 1, sourceResourceId: null, primaryConceptId: "c2", correct: false, assistance: "none", seenBefore: false, confidence: null, createdAt: T, format: "mc", mode: "learn", response: null, score: 0, gradingMethod: "exact", responseMs: 1, conceptTags: [], sessionId: "s", localDay: "2026-09-20" };
  const ctx = { courseRef: REF, practice, mistakes: [], attempts: [miss], today: "2026-09-22", bandOf: (c: string) => (c === "c1" ? ("iffy" as const) : ("getting_there" as const)) };
  setStar(practice, REF, "card", "k3", true, T);
  assert.deepEqual(applyFilter(entries, "starred", ctx).items.map((e) => e.id), ["k3"]);
  setStar(practice, REF, "concept", "c1", true, T);
  assert.deepEqual(applyFilter(entries, "starred", ctx).items.map((e) => e.id), ["i1", "k3"]);
  setStar(practice, REF, "card", "k3", false, T);
  assert.deepEqual(applyFilter(entries, "starred", ctx).items.map((e) => e.id), ["i1"]);
  assert.deepEqual(applyFilter(entries, "missed", ctx).items.map((e) => e.id), ["i2"]);
  assert.deepEqual(applyFilter(entries, "iffy", ctx).items.map((e) => e.id), ["i1"]);
  assert.equal(applyFilter(entries, "all", ctx).items.length, 3);
});

test("negative: an empty filter says so and never falls back silently; starring never changes the knowledge model", () => {
  const { learning, practice } = setup();
  const ctx = { courseRef: REF, practice, mistakes: [], attempts: [], today: "2026-09-22", bandOf: () => "not_seen" as const };
  const r = applyFilter(entries, "starred", ctx);
  assert.deepEqual(r.items, []);
  assert.equal(r.empty, true);
  assert.match(r.message!, /Nothing starred/);
  const before = conceptState({ ...learning.evidence(REF), items: new Map(), cards: new Map() }, MAP, CONFIG, new Date(T));
  setStar(practice, REF, "concept", "c1", true, T);
  const after = conceptState({ ...learning.evidence(REF), items: new Map(), cards: new Map() }, MAP, CONFIG, new Date(T));
  assert.deepEqual(after, before);
});
