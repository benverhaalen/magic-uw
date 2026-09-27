import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyJudgeVerdicts,
  gradeChoice,
  gradeNumeric,
  gradeTyped,
  pendingJudgeRequests,
  resolveByStudent,
} from "../packages/learning/src/grade";

const bst = { id: "i1", key: "Binary Search Tree", keyIdeas: [] };
const collision = {
  id: "i2",
  key: "Two keys map to the same bucket",
  keyIdeas: [
    { idea: "two keys", synonyms: ["two different keys", "distinct keys"], required: true },
    { idea: "same bucket", synonyms: ["same slot", "one bucket"], required: true },
  ],
};

test('"Binary Search Tree" vs "binary search tree." grades correct by code', () => {
  const g = gradeTyped(bst, "binary search tree.");
  assert.equal(g.outcome, "correct");
  assert.equal(g.score, 1);
  assert.equal(g.keyIdeas[0]!.method, "normalised");
  assert.equal(gradeTyped(bst, "Binary Search Tree").keyIdeas[0]!.method, "exact");
  assert.equal(gradeTyped(bst, "  a binary   search trees ").outcome, "correct", "articles, spacing and plurals");
});

test("key ideas are found by phrase or listed synonym; score = found / required; each idea names its method", () => {
  const g = gradeTyped(collision, "It happens when two different keys land in the same slot of the table.");
  assert.equal(g.outcome, "correct");
  assert.deepEqual(g.keyIdeas.map((i) => [i.found, i.method]), [[true, "synonym"], [true, "synonym"]]);
  const partial = resolveByStudent(gradeTyped(collision, "Two keys, somewhere."), { "same bucket": false });
  assert.equal(partial.outcome, "partial");
  assert.equal(partial.score, 0.5);
});

test("negative: when code can't decide, the idea is undecided and the attempt isn't scored; no judge is called", () => {
  const g = gradeTyped(collision, "Distinct inputs hashing to a single location.");
  assert.equal(g.outcome, "undecided");
  assert.equal(g.score, null);
  assert.ok(g.keyIdeas.some((i) => i.found === null && i.method === "undecided"));
  assert.ok(g.checks.includes("Some key ideas not checked yet"));
  // A negated phrase isn't counted as found.
  assert.equal(gradeTyped(collision, "It's not the same bucket, and not two keys").score, null);
});

test("a blank or non-answer is graded incorrect by code", () => {
  for (const a of ["", "idk", "I don't know"]) assert.equal(gradeTyped(collision, a).outcome, "incorrect", JSON.stringify(a));
});

test("hook A: the student settles undecided ideas; code-decided ideas don't change", () => {
  const g = gradeTyped(collision, "Distinct keys hashing to a single location.");
  assert.equal(g.keyIdeas[0]!.found, true);
  const settled = resolveByStudent(g, { "same bucket": true, "two keys": false });
  assert.equal(settled.outcome, "correct");
  assert.equal(settled.keyIdeas[0]!.method, "synonym");
  assert.equal(settled.keyIdeas[1]!.method, "student");
  assert.ok(settled.checks.includes("Marked by you"));
});

test("hook B: pending re-check requests, then verdicts; an abstention leaves the idea undecided", () => {
  const answer = "Distinct inputs hashing to a single location.";
  const g = gradeTyped(collision, answer);
  assert.deepEqual(pendingJudgeRequests(g, answer).map((r) => r.idea), ["two keys", "same bucket"]);
  const half = applyJudgeVerdicts(g, { "two keys": true, "same bucket": "abstain" });
  assert.equal(half.outcome, "undecided");
  const done = applyJudgeVerdicts(half, { "same bucket": true });
  assert.equal(done.outcome, "correct");
  assert.equal(done.keyIdeas[1]!.method, "judge");
});

test("choice and numeric answers are graded exactly in code", () => {
  assert.equal(gradeChoice({ id: "m", key: "b" }, "b").outcome, "correct");
  assert.equal(gradeChoice({ id: "m", key: "b" }, "a").outcome, "incorrect");
  assert.equal(gradeNumeric({ id: "n", key: 3 }, 3.001).outcome, "correct");
  assert.equal(gradeNumeric({ id: "n", key: 3 }, 3.1).outcome, "incorrect");
  assert.equal(gradeNumeric({ id: "n", key: 5, unit: "m/s" }, 5, "m").outcome, "incorrect");
  assert.equal(gradeNumeric({ id: "n", key: 5, unit: "m/s" }, 5).outcome, "correct");
});
