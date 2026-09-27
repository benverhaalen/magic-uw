// The generator fixes the item-quality harness motivated (evals/items): unit-safe numeric
// formulas, cloze checks, language cards in both directions and the subject profile line.
import test from "node:test";
import assert from "node:assert/strict";
import { quizDrafts, quizPack, withUnit, type QuizItemOutput } from "../packages/packs/items/src/index";
import { cardDrafts, cardsPack, CLOZE_BLANK, reverseCards } from "../packages/packs/cards/src/index";
import { buildPrompt } from "../packages/packs/core/src/index";
import { runPipeline } from "../packages/learning/src/items";
import { findQuote } from "../packages/retrieval/src/quotes";

test("a unitless formula for an item with a unit is recomputed with that unit; a wrong value still fails", () => {
  assert.equal(withUnit("25 * 4", "bytes"), "(25 * 4) bytes");
  assert.equal(withUnit("25 * 4 bytes", "bytes"), "25 * 4 bytes");
  assert.equal(withUnit("10 + 1", "comparisons"), "(10 + 1) comparisons");
  assert.equal(withUnit("25 * 4", null), "25 * 4");
  assert.equal(withUnit("25 * 4", "m/s"), "25 * 4", "a compound unit is left alone");
  const item = (value: number): QuizItemOutput => ({
    kind: "numeric",
    stem: "How many bytes do 25 nodes of 4 bytes use?",
    options: [],
    statementIsTrue: null,
    numeric: { value, unit: "bytes", formula: "25 * 4" },
    explanation: "",
    topics: ["Memory"],
    section: "Lists",
    bloom: "apply",
    sourceId: "p1",
    quote: "Each list node holds 4 bytes, so 25 nodes use 100 bytes.",
  });
  const text = "Each list node holds 4 bytes, so 25 nodes use 100 bytes.";
  const run = (value: number) => {
    const d = quizDrafts({ items: [item(value)] })[0]!;
    return runPipeline(
      {
        id: "i", version: 1, familyId: "i", courseRef: "a:c", kind: "numeric", stem: d.stem, options: null, key: d.key, unit: d.unit!, formula: d.formula!,
        keyIdeas: [], explanation: null, tempting: {}, bloom: "apply", tier: "T4", sourceTerm: null, origin: "generated", generator: null,
        sources: [{ resourceId: "r", quote: d.quote }], tags: [],
      },
      { courseRestricted: false, resources: [{ id: "r", kind: "material", text, contentHash: "h" }], validate: findQuote, map: [], seenStems: [], now: new Date() },
    );
  };
  assert.notEqual(run(100).dropped?.name, "executed", "the right value passes the executed stage");
  assert.equal(run(101).dropped?.name, "executed");
});

const card = (over: Record<string, unknown>) => ({
  kind: "cloze" as const,
  front: "The load factor is the number of stored keys divided by the number of buckets.",
  back: "load factor",
  topics: ["Hashing"],
  section: "Hashing",
  sourceId: "p1",
  quote: "The load factor is the number of stored keys divided by the number of buckets.",
  ...over,
});

test("cloze: every occurrence is blanked; function-word, whole-sentence and unquoted blanks are faults; negations are emphasised", () => {
  const [twice, fn, whole, unquoted, negation, ok] = cardDrafts({
    cards: [
      card({ back: "number" }),
      card({ back: "the" }),
      card({ back: "load factor is the number of stored keys divided by the number of buckets" }),
      card({ front: "The load factor is the number of buckets divided by the number of stored keys." }),
      card({ front: "A secondary source is written by someone who did not witness the events.", back: "secondary source", quote: "A secondary source is written by someone who did not witness the events." }),
      card({}),
    ],
  });
  assert.equal(twice!.stem, `The load factor is the ${CLOZE_BLANK} of stored keys divided by the ${CLOZE_BLANK} of buckets.`);
  assert.equal(twice!.problem, null);
  assert.match(fn!.problem!, /function words/);
  assert.match(whole!.problem!, /most of the sentence/);
  assert.match(unquoted!.problem!, /isn't the quoted text/);
  assert.equal(negation!.stem, `A ${CLOZE_BLANK} is written by someone who did NOT witness the events.`);
  assert.equal(negation!.problem, null);
  assert.equal(ok!.problem, null);
});

test("term cards: a back that only repeats the front is a fault; language cards reverse by code", () => {
  const drafts = cardDrafts({
    cards: [
      card({ kind: "term", front: "perro", back: "dog", quote: "The word perro means dog." }),
      card({ kind: "term", front: "Stack", back: "stack" }),
      card({ kind: "term", front: "Queue", back: "A queue is a first-in, first-out collection" }),
      card({ kind: "term", front: "casa", back: "house", quote: "The word casa means house." }),
    ],
  });
  assert.match(drafts[1]!.problem!, /only repeats the front/);
  const reverse = reverseCards(drafts);
  assert.deepEqual(
    reverse.map((r) => [r.index, r.derivedFrom, r.stem, r.key]),
    [
      [4, 0, "dog", "perro"],
      [5, 3, "house", "casa"],
    ],
    "no reverse for a faulty card or a definition that contains the term",
  );
  assert.equal(reverse[0]!.quote, "The word perro means dog.");
});

test("prompts carry the subject profile when code knows the family, and nothing otherwise", () => {
  const frame = { courseId: "a:c", course: "C", skeleton: "Course: C", policy: "" };
  const passage = [{ sourceId: "p1", text: "A stack is a last-in, first-out collection." }];
  const base = { count: 4, sections: [], topics: [], focus: [] };
  const quiz = buildPrompt(quizPack, frame, { ...base, subject: "math" }, passage).input;
  assert.match(quiz, /Subject profile \(math\): Prefer numeric questions/);
  assert.ok(quiz.endsWith("the formula using numbers, + - * / and parentheses."));
  assert.match(buildPrompt(cardsPack, frame, { ...base, subject: "languages" }, passage).input, /Subject profile \(languages\): Vocabulary term cards/);
  assert.doesNotMatch(buildPrompt(cardsPack, frame, base, passage).input, /Subject profile/);
  assert.equal(quizPack.version, "v2");
  assert.equal(cardsPack.version, "v2");
});
