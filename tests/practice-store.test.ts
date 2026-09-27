import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryLearningStore } from "../packages/learning/src/memory-store";
import { createMemoryPracticeStore } from "../packages/learning/src/practice/memory-store";

const T = "2026-09-20T15:00:00.000Z";

function seed() {
  const learning = createMemoryLearningStore(() => T);
  const ref = learning.course("acct", "SYN101").id;
  const concept = (id: string) => ({ id, courseRef: ref, parentId: null, label: id, kind: "concept" as const, position: 0, origin: "code" as const, status: "active" as const, mergedInto: null, studentLabel: null, mapVersion: "m", sources: [] });
  learning.putConceptMap(ref, [concept("c1"), concept("c2")], "m");
  learning.putItem(
    { id: "i1", version: 1, courseRef: ref, familyId: "f", kind: "mc", stem: "Which bucket?", options: [{ id: "a", text: "Chaining" }, { id: "b", text: "Probing" }, { id: "c", text: "Resizing" }], key: "a", keyIdeas: [], explanation: null, tempting: {}, bloom: "understand", bPrior: -0.5, tier: "T4", sourceTerm: null, origin: "generated", status: "active", statusReason: null, generator: null, createdAt: T },
    [], [{ conceptId: "c1", weight: 1, primary: true }], [],
  );
  return { learning, practice: createMemoryPracticeStore(learning), ref };
}

test("stars, option tags and views round-trip with their keys", () => {
  const { practice, ref } = seed();
  practice.star({ courseRef: ref, targetKind: "item", targetId: "i1", createdAt: T });
  practice.star({ courseRef: ref, targetKind: "item", targetId: "i1", createdAt: T });
  practice.star({ courseRef: ref, targetKind: "concept", targetId: "c2", createdAt: T });
  assert.equal(practice.stars(ref).length, 2);
  assert.equal(practice.stars(ref, "concept").length, 1);
  practice.unstar(ref, "item", "i1");
  assert.equal(practice.isStarred(ref, "item", "i1"), false);
  practice.putOptionTag({ itemId: "i1", itemVersion: 1, optionId: "b", conceptId: "c2" });
  practice.putOptionTag({ itemId: "i1", itemVersion: 1, optionId: "b", conceptId: "c1" });
  assert.deepEqual(practice.optionTags("i1").map((t) => t.conceptId), ["c1"], "≤1 concept per option");
  practice.addView({ id: "v1", resourceId: "r1", version: 1, start: 0, end: 40, activeSeconds: 35, localDay: "2026-09-20", createdAt: T });
  assert.equal(practice.views({ resourceId: "r1" }).length, 1);
});

test("negative: a star on an unknown target is rejected; an option tag to another course's concept is rejected", () => {
  const { learning, practice, ref } = seed();
  assert.throws(() => practice.star({ courseRef: ref, targetKind: "item", targetId: "nope", createdAt: T }), /unknown item/);
  assert.throws(() => practice.star({ courseRef: ref, targetKind: "card", targetId: "k-missing", createdAt: T }), /unknown card/);
  const other = learning.course("acct", "OTHER").id;
  learning.putConceptMap(other, [{ id: "x1", courseRef: other, parentId: null, label: "X", kind: "concept", position: 0, origin: "code", status: "active", mergedInto: null, studentLabel: null, mapVersion: "m", sources: [] }], "m");
  assert.throws(() => practice.star({ courseRef: ref, targetKind: "concept", targetId: "x1", createdAt: T }), /unknown concept/);
  assert.throws(() => practice.putOptionTag({ itemId: "i1", itemVersion: 1, optionId: "b", conceptId: "x1" }), /not in the item's course/);
  assert.throws(() => practice.putOptionTag({ itemId: "i1", itemVersion: 1, optionId: "z", conceptId: "c1" }), /unknown option/);
});

test("negative: a view on a deleted resource is dropped with it; reset() empties every collection", () => {
  const { practice, ref } = seed();
  practice.addView({ id: "v1", resourceId: "r1", version: 1, start: 0, end: 40, activeSeconds: 35, localDay: "d", createdAt: T });
  practice.addView({ id: "v2", resourceId: "r2", version: 1, start: 0, end: 40, activeSeconds: 12, localDay: "d", createdAt: T });
  practice.deleteResource("r1");
  assert.deepEqual(practice.views().map((v) => v.id), ["v2"]);
  practice.star({ courseRef: ref, targetKind: "item", targetId: "i1", createdAt: T });
  practice.putOptionTag({ itemId: "i1", itemVersion: 1, optionId: "b", conceptId: "c2" });
  practice.reset();
  assert.equal(practice.stars(ref).length, 0);
  assert.equal(practice.optionTags("i1").length, 0);
  assert.equal(practice.views().length, 0);
});
