// T45: the items (quiz) pack reads model output into drafts; code finds structural faults.
import test from "node:test";
import assert from "node:assert/strict";
import { batchCheck, quizDrafts, quizOutputSchema, quizPack, type QuizItemOutput } from "../packages/packs/items/src/index";
import { buildPrompt } from "../packages/packs/core/src/index";

const passage = { sourceId: "p1", text: "A stack is a last-in, first-out collection of elements." };
const mc = (over: Partial<QuizItemOutput> = {}): QuizItemOutput => ({
  kind: "mc",
  stem: "Which collection is last-in, first-out?",
  options: [
    { text: "A stack", correct: true },
    { text: "A queue", correct: false },
    { text: "A heap", correct: false },
    { text: "A graph", correct: false },
  ],
  statementIsTrue: null,
  numeric: null,
  explanation: "",
  topics: ["Stacks"],
  section: "Linear structures",
  bloom: "remember",
  sourceId: "p1",
  quote: "a last-in, first-out collection",
  ...over,
});
const input = { count: 4, sections: [], topics: [], focus: [] };

test("an MC item needs 4 options and exactly one key; two correct options fail the item", () => {
  const [ok, two, three] = quizDrafts({
    items: [
      mc(),
      mc({ options: mc().options.map((o, i) => ({ ...o, correct: i < 2 })) }),
      mc({ options: mc().options.slice(0, 3) }),
    ],
  });
  assert.equal(ok!.problem, null);
  assert.equal(ok!.key, "a");
  assert.deepEqual(ok!.options?.map((o) => o.id), ["a", "b", "c", "d"]);
  assert.match(two!.problem!, /2 options are marked correct; exactly one key is needed/);
  assert.equal(two!.key, "");
  assert.match(three!.problem!, /needs 4 options, not 3/);
});

test("true/false and numeric items: code builds the options and the key", () => {
  const [tf, num, bad] = quizDrafts({
    items: [
      mc({ kind: "tf", stem: "A stack is last-in, first-out.", options: [], statementIsTrue: true }),
      mc({ kind: "numeric", options: [], numeric: { value: 100, unit: "bytes", formula: "25 * 4 bytes" } }),
      mc({ kind: "numeric", options: [], numeric: null }),
    ],
  });
  assert.deepEqual(tf!.options, [{ id: "true", text: "True" }, { id: "false", text: "False" }]);
  assert.equal(tf!.key, "true");
  assert.equal(num!.key, 100);
  assert.equal(num!.unit, "bytes");
  assert.equal(num!.formula, "25 * 4 bytes");
  assert.match(bad!.problem!, /needs its value/);
});

test("the batch check retries only when fewer than half the items survive; bad items are dropped singly", () => {
  const check = batchCheck(quizDrafts);
  const invented = mc({ quote: "Stacks were invented in 1946." });
  assert.deepEqual(check({ items: [mc(), invented] }, input, { passages: [passage] }), []);
  const errors = check({ items: [mc(), invented, invented] }, input, { passages: [passage] });
  assert.equal(errors.length, 2);
  assert.match(errors[0]!, /^item 2: quote not found verbatim in p1/);
  assert.deepEqual(check({ items: [] }, input, { passages: [passage] }), ["no items were returned"]);
});

test("the pack's schema is strict, and the question comes last after the passages", () => {
  assert.equal(quizOutputSchema.safeParse({ items: [{ ...mc(), extra: 1 }] }).success, false);
  const p = buildPrompt(quizPack, { courseId: "a:c", course: "C", skeleton: "Course: C", policy: "" }, input, [passage]);
  assert.ok(p.input.startsWith('<passage id="p1">'));
  assert.ok(p.input.endsWith("the formula using numbers, + - * / and parentheses."));
});
