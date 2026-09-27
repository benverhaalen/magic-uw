import { test } from "node:test";
import assert from "node:assert/strict";
import { confusablePairs, frequentDistractors } from "../packages/learning/src/insights/errors";
import { tagOptions } from "../packages/learning/src/insights/option-tags";
import type { Concept, Dispute, LearningAttempt, StoredItem } from "../packages/learning/src/store";

const REF = "r";
const src = (resourceId: string, start: number) => ({ resourceId, contentHash: "h", start, end: start + 20, quote: "x".repeat(20), quoteValid: true });
const concept = (id: string, label: string): Concept => ({ id, courseRef: REF, parentId: null, label, kind: "concept", position: 0, origin: "code", status: "active", mergedInto: null, studentLabel: null, mapVersion: "m", sources: [src(`lec-${id}`, 0)] });
const MAP = [concept("chain", "Chaining"), concept("probe", "Open addressing"), concept("lf", "Load factor")];

function mc(id: string, primary: string, options: string[]): StoredItem {
  return {
    item: { id, version: 1, courseRef: REF, familyId: id, kind: "mc", stem: `Q ${id}`, options: options.map((text, i) => ({ id: "abcd"[i]!, text })), key: "a", keyIdeas: [], explanation: null, tempting: { b: "It sounds like the table itself stores the key." }, bloom: "understand", bPrior: -0.5, tier: "T4", sourceTerm: null, origin: "generated", status: "active", statusReason: null, generator: null, createdAt: "" },
    sources: [{ ...src("lec3", 40), textHash: "t" }],
    tags: [{ conceptId: primary, weight: 1, primary: true }],
    checks: [],
  };
}
const q1 = mc("q1", "chain", ["A linked list per bucket", "Open addressing probes for a slot", "A bigger table", "The load factor"]);
const q2 = mc("q2", "chain", ["Keys share a bucket list", "Open addressing with linear probing", "Rehashing", "Sorting keys"]);
const q3 = mc("q3", "probe", ["Probe for an empty slot", "Chaining in a list", "Nothing", "Resize"]);

let n = 0;
const pick = (s: StoredItem, optionId: string, over: Partial<LearningAttempt> = {}): LearningAttempt => ({
  id: `a${++n}`, courseRef: REF, itemId: s.item.id, itemVersion: 1, sourceResourceId: "lec3", primaryConceptId: s.tags[0]!.conceptId,
  correct: optionId === "a", assistance: "none", seenBefore: false, confidence: null, createdAt: `2026-09-20T10:00:${String(n).padStart(2, "0")}Z`,
  format: "mc", mode: "learn", response: { optionId }, score: optionId === "a" ? 1 : 0, gradingMethod: "exact", responseMs: 1,
  conceptTags: s.tags, sessionId: `s${n}`, localDay: "2026-09-20", optionId, ...over,
});

test("distractors are tagged to concepts in code; unmatched or ambiguous options stay untagged", () => {
  const tags = tagOptions(q1.item, MAP);
  assert.deepEqual(tags.map((t) => [t.optionId, t.conceptId]), [["b", "probe"], ["d", "lf"]]);
  assert.equal(tagOptions({ ...q1.item, options: [{ id: "a", text: "k" }, { id: "b", text: "Chaining and open addressing" }, { id: "c", text: "None" }] }, MAP).length, 0, "two concepts in one option: untagged");
  assert.deepEqual(tagOptions({ ...q1.item, options: [{ id: "a", text: "k" }, { id: "b", text: "Separate lists" }] }, MAP, [{ term: "separate lists", conceptId: "chain" }]).map((t) => t.conceptId), ["chain"]);
});

test("frequent distractors: chosen ≥2 times, with the tempting line and the settling passage's anchor", () => {
  const attempts = [pick(q1, "b"), pick(q1, "b"), pick(q1, "c"), pick(q1, "a")];
  const d = frequentDistractors(attempts, [q1, q2, q3]);
  assert.equal(d.length, 1);
  assert.equal(d[0]!.optionId, "b");
  assert.equal(d[0]!.count, 2);
  assert.equal(d[0]!.tempting, "It sounds like the table itself stores the key.");
  assert.equal(d[0]!.anchors[0]!.resourceId, "lec3");
});

test("confusable pairs: A answered as B ≥2 times, both anchors, and an interleaved compare session", () => {
  const tags = [...tagOptions(q1.item, MAP), ...tagOptions(q2.item, MAP), ...tagOptions(q3.item, MAP)];
  const attempts = [pick(q1, "b"), pick(q2, "b"), pick(q3, "b")];
  const pairs = confusablePairs(attempts, [q1, q2, q3], tags, MAP);
  assert.equal(pairs.length, 1);
  assert.deepEqual([pairs[0]!.asked, pairs[0]!.answeredAs, pairs[0]!.count], ["chain", "probe", 2]);
  assert.equal(pairs[0]!.anchors.asked[0]!.resourceId, "lec-chain");
  assert.equal(pairs[0]!.anchors.answeredAs[0]!.resourceId, "lec-probe");
  assert.deepEqual(pairs[0]!.compare, ["q1", "q3", "q2"]);
});

test("negative: disputed or contested attempts are excluded; untagged options never form a pair", () => {
  const tags = tagOptions(q1.item, MAP);
  const a1 = pick(q1, "b");
  const a2 = pick(q1, "b");
  const contested: Dispute = { id: "d", courseRef: REF, targetKind: "grade", targetId: a2.id, reason: "grade_wrong", note: null, status: "open", createdAt: "", resolvedAt: null };
  assert.equal(confusablePairs([a1, a2], [q1], tags, MAP, [contested]).length, 0);
  assert.equal(frequentDistractors([a1, a2], [q1], [contested]).length, 0);
  const flagged: Dispute = { ...contested, targetKind: "item", targetId: "q1" };
  assert.equal(frequentDistractors([a1, a2], [q1], [flagged]).length, 0);
  // Option c ("A bigger table") is untagged: choosing it twice makes a frequent distractor, never a pair.
  const c = [pick(q1, "c"), pick(q1, "c")];
  assert.equal(confusablePairs(c, [q1], tags, MAP).length, 0);
  assert.equal(frequentDistractors(c, [q1]).length, 1);
});
