import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryLearningStore } from "../packages/learning/src/memory-store";
import type { Concept, LearningAttempt, LearningItem, LearningReview, LearningStore } from "../packages/learning/src/store";

const T = "2026-09-20T15:00:00.000Z";

function seed(): { store: LearningStore; ref: string } {
  const store = createMemoryLearningStore(() => T);
  const { id: ref } = store.course("acct", "SYN101", "Synthetic 101");
  const concept = (id: string, label: string): Concept => ({
    id, courseRef: ref, parentId: null, label, kind: "concept", position: 0, origin: "code",
    status: "active", mergedInto: null, studentLabel: null, mapVersion: "m1", sources: [],
  });
  store.putConceptMap(ref, [concept("c1", "Recurrences"), concept("c2", "Hashing")], "m1");
  return { store, ref };
}

function item(ref: string, id = "i1", version = 1, origin: LearningItem["origin"] = "generated"): LearningItem {
  return {
    id, version, courseRef: ref, familyId: "f1", kind: "mc", stem: "Which recurrence describes merge sort?",
    options: [{ id: "a", text: "T(n)=2T(n/2)+n" }, { id: "b", text: "T(n)=T(n-1)+1" }, { id: "c", text: "T(n)=T(n/2)+1" }],
    key: "a", keyIdeas: [], explanation: null, tempting: {}, bloom: "understand", bPrior: -0.5, tier: "T4",
    sourceTerm: null, origin, status: "active", statusReason: null, generator: null, createdAt: T,
  };
}

function attempt(ref: string, over: Partial<LearningAttempt> = {}): LearningAttempt {
  return {
    id: "a1", courseRef: ref, itemId: "i1", itemVersion: 1, sourceResourceId: "r1", primaryConceptId: "c1",
    correct: true, assistance: "none", seenBefore: false, confidence: null, createdAt: T, format: "mc", mode: "learn",
    response: { optionId: "a" }, score: 1, gradingMethod: "exact", responseMs: 4000,
    conceptTags: [{ conceptId: "c1", weight: 1, primary: true }], sessionId: "s1", localDay: "2026-09-20", ...over,
  };
}

const quote = "merge sort splits the array in half";
const src = (hash: string) => ({ resourceId: "r1", contentHash: hash, textHash: "t", start: 0, end: quote.length, quote, quoteValid: true });

test("items, cards, reviews and evidence round-trip by course", () => {
  const { store, ref } = seed();
  store.putItem(item(ref), [src("h1")], [{ conceptId: "c1", weight: 1, primary: true }], []);
  store.putCard({
    id: "k1", itemId: "i1", courseRef: ref, conceptId: "c1", fsrsVersion: "5.4.2", paramsHash: "p", isConceptTrack: false,
    fsrs: { due: T, stability: 0, difficulty: 0, elapsed_days: 0, scheduled_days: 0, learning_steps: 0, reps: 0, lapses: 0, state: 0, last_review: null },
  });
  store.addAttempt(attempt(ref));
  assert.equal(store.items({ conceptId: "c1" }).length, 1);
  assert.equal(store.cards({ courseRef: ref }).length, 1);
  assert.equal(store.evidence(ref).attempts.length, 1);
  // Returned rows are copies: mutating them doesn't change the store.
  store.items()[0]!.item.stem = "changed";
  assert.notEqual(store.items()[0]!.item.stem, "changed");
});

test("negative: an attempt with an existing ID and different content throws; the same content is idempotent", () => {
  const { store, ref } = seed();
  store.addAttempt(attempt(ref));
  assert.doesNotThrow(() => store.addAttempt(attempt(ref)));
  assert.throws(() => store.addAttempt(attempt(ref, { correct: false, score: 0 })), /different content/);
  assert.equal(store.evidence(ref).attempts[0]!.correct, true);
});

test("negative: a write missing a required field is rejected (KM-3)", () => {
  const { store, ref } = seed();
  assert.throws(() => store.addAttempt(attempt(ref, { primaryConceptId: "" })), /missing primaryConceptId/);
});

test("negative: a review row can't be edited", () => {
  const { store, ref } = seed();
  store.putItem(item(ref), [], [{ conceptId: "c1", weight: 1, primary: true }], []);
  const fsrs = { due: T, stability: 1, difficulty: 5, elapsed_days: 0, scheduled_days: 1, learning_steps: 0, reps: 1, lapses: 0, state: 1, last_review: T };
  store.putCard({ id: "k1", itemId: "i1", courseRef: ref, conceptId: "c1", fsrs, fsrsVersion: "5.4.2", paramsHash: "p", isConceptTrack: false });
  const review: LearningReview = { id: "v1", cardId: "k1", rating: 3, stateBefore: fsrs, stateAfter: fsrs, reviewMs: 900, localDay: "2026-09-20", undoesReviewId: null, createdAt: T };
  store.addReview(review);
  assert.throws(() => store.addReview({ ...review, rating: 1 }), /different content/);
  assert.equal(store.evidence(ref).reviews[0]!.rating, 3);
  assert.equal("updateReview" in store, false);
});

test("an attempt on a student-made item with no source resource is accepted", () => {
  const { store, ref } = seed();
  store.putItem(item(ref, "own1", 1, "student"), [], [{ conceptId: "c1", weight: 1, primary: true }], []);
  store.addAttempt(attempt(ref, { id: "a-own", itemId: "own1", sourceResourceId: null }));
  assert.equal(store.evidence(ref).attempts[0]!.sourceResourceId, null);
});

test("markStale flags artifacts and items; an item whose quote no longer validates is quarantined 'source changed' (NB-13)", () => {
  const { store, ref } = seed();
  store.putItem(item(ref, "i1"), [src("h1")], [{ conceptId: "c1", weight: 1, primary: true }], []);
  store.putItem({ ...item(ref, "i2"), familyId: "f2" }, [{ ...src("h1"), quote: "the recursion tree has log n levels" }], [{ conceptId: "c1", weight: 1, primary: true }], []);
  store.putArtifact({ id: "g1", courseRef: ref, kind: "study_guide", scope: {}, cacheKey: "ck1", body: {}, removedCount: 0, status: "ready", generator: null, createdAt: T, sources: [{ resourceId: "r1", contentHash: "h1" }] });
  const newText = "In the new version, merge sort splits the array in half and merges.";
  const report = store.markStale("r1", "h2", (q) => newText.includes(q));
  assert.deepEqual(report.artifacts, ["g1"]);
  assert.deepEqual(report.items, [{ id: "i1", version: 1 }]);
  assert.deepEqual(report.quarantined, [{ id: "i2", version: 1 }]);
  const i2 = store.items({ ids: ["i2"] })[0]!;
  assert.equal(i2.item.status, "quarantined");
  assert.equal(i2.item.statusReason, "source changed");
  assert.equal(store.artifact("ck1")!.status, "stale");
  // Unchanged hash: nothing is flagged.
  const { store: s2, ref: r2 } = seed();
  s2.putItem(item(r2), [src("h1")], [{ conceptId: "c1", weight: 1, primary: true }], []);
  assert.deepEqual(s2.markStale("r1", "h1", () => false).quarantined, []);
});

test("a rebuilt concept map never overwrites a student edit (KM-1)", () => {
  const { store, ref } = seed();
  store.editConcept("c1", { kind: "rename", label: "Solving recurrences" });
  store.editConcept("c2", { kind: "hide" });
  const rebuilt = store.concepts(ref).map((c) => ({ ...c, studentLabel: null, status: "active" as const, label: c.label + " (v2)" }));
  store.putConceptMap(ref, rebuilt, "m2");
  const byId = new Map(store.concepts(ref).map((c) => [c.id, c]));
  assert.equal(byId.get("c1")!.studentLabel, "Solving recurrences");
  assert.equal(byId.get("c2")!.status, "hidden");
  assert.equal(byId.get("c1")!.mapVersion, "m2");
});

test("negative: tags to another course's concept are rejected; coverage decisions survive a re-put", () => {
  const { store, ref } = seed();
  const other = store.course("acct", "OTHER").id;
  store.putConceptMap(other, [{ id: "x1", courseRef: other, parentId: null, label: "X", kind: "concept", position: 0, origin: "code", status: "active", mergedInto: null, studentLabel: null, mapVersion: "m1", sources: [] }], "m1");
  assert.throws(() => store.putItem(item(ref), [], [{ conceptId: "x1", weight: 1, primary: true }], []), /not a concept/);
  const row = { assessmentId: "exam2", conceptId: "c1", basis: "stated" as const, tier: "T2" as const, evidenceResourceId: null, start: null, end: null, quote: null, status: "proposed" as const, decidedByStudent: false };
  store.putCoverage([row]);
  store.decideCoverage({ assessmentId: "exam2", conceptId: "c1" }, "rejected");
  store.putCoverage([row]);
  assert.equal(store.coverage("exam2")[0]!.status, "rejected");
});

test("negative: after reset(), every collection is empty (KM-13 analogue)", () => {
  const { store, ref } = seed();
  store.putItem(item(ref), [src("h1")], [{ conceptId: "c1", weight: 1, primary: true }], []);
  store.addAttempt(attempt(ref));
  store.addAlias({ conceptId: "c1", alias: "recurrence relations", origin: "student" });
  store.addDispute({ id: "d1", courseRef: ref, targetKind: "item", targetId: "i1", reason: "wrong_key", note: null, status: "open", createdAt: T, resolvedAt: null });
  store.putSession({ id: "s-null", courseRef: null, kind: "quick", plan: {}, minutes: 5, difficulty: "normal", startedAt: T, endedAt: null });
  store.putArtifact({ id: "g1", courseRef: ref, kind: "faq", scope: {}, cacheKey: "ck", body: {}, removedCount: 0, status: "ready", generator: null, createdAt: T, sources: [] });
  store.putConceptState([{ conceptId: "c1", theta: 0, n: 0, s: 1.5, pHat: 0.4, r: null, band: "not_seen", reasons: [], counts: {}, configVersion: "km-0.1", computedAt: T }]);
  store.reset();
  assert.equal(store.items().length, 0);
  assert.equal(store.concepts(ref).length, 0);
  assert.equal(store.cards().length, 0);
  assert.deepEqual(store.evidence(ref), { attempts: [], reviews: [], selfRatings: [], disputes: [] });
  assert.equal(store.artifact("ck"), null);
  assert.equal(store.sessions(null).length, 0);
  assert.equal(store.conceptState(ref).length, 0);
  assert.equal(store.coverage("exam2").length, 0);
  assert.equal(store.aliases("c1").length, 0);
});
