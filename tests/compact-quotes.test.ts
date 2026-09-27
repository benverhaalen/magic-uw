// Output-token saving for quiz and cards: a long quote may come back as its first and last words
// around an ellipsis; code restores the exact span from the cited passage, and every grounding
// check runs on the restored text as before.
import test from "node:test";
import assert from "node:assert/strict";
import { expandQuote, batchCheck, quizDrafts, sharedRules, type GenerationInput } from "../packages/packs/items/src/index";
import { cardDrafts } from "../packages/packs/cards/src/index";

const PASSAGE =
  "Lecture 5: Hashing. A collision happens when two keys map to the same bucket. Chaining resolves collisions by keeping a linked list in each bucket.\nRehashing costs linear time, but amortized over many inserts it keeps insertion constant on average.";
const LONG = "Rehashing costs linear time, but amortized over many inserts it keeps insertion constant on average.";

test("expandQuote restores the exact passage span; a full or unrestorable quote is unchanged", () => {
  assert.equal(expandQuote(PASSAGE, "Rehashing costs linear time, but … keeps insertion constant on average."), LONG);
  assert.equal(expandQuote(PASSAGE, "Rehashing costs linear time, but ... keeps insertion constant on average."), LONG, "three dots too");
  // Whitespace in the passage (a line break) doesn't stop it; the result is the passage's own text.
  assert.equal(expandQuote(PASSAGE, "Chaining resolves collisions by … average."), PASSAGE.slice(PASSAGE.indexOf("Chaining"), PASSAGE.length));
  assert.equal(expandQuote(PASSAGE, LONG), LONG, "a full quote");
  assert.equal(expandQuote(PASSAGE, "Rehashing costs linear time … keeps deletion constant."), "Rehashing costs linear time … keeps deletion constant.", "a tail not in the passage");
  assert.equal(expandQuote(PASSAGE, "keeps insertion constant … Rehashing costs"), "keeps insertion constant … Rehashing costs", "the tail must follow the head");
});

const input: GenerationInput = { count: 5, sections: [], topics: [], focus: [] };
const context = { passages: [{ sourceId: "p1", text: PASSAGE }] };
const quizItem = (quote: string) => ({
  kind: "mc" as const,
  stem: "What does rehashing cost?",
  options: [
    { text: "Linear time", correct: true },
    { text: "Constant time", correct: false },
    { text: "Logarithmic time", correct: false },
    { text: "Quadratic time", correct: false },
  ],
  statementIsTrue: null,
  numeric: null,
  explanation: "From the notes.",
  topics: ["Hash tables"],
  section: "Hashing",
  bloom: "remember" as const,
  sourceId: "p1",
  quote,
});

test("quiz and cards: an abbreviated quote passes the grounding check as its restored text; a wrong one still fails", () => {
  const short = "Rehashing costs linear time, but … keeps insertion constant on average.";
  const quiz = { items: [quizItem(short)] };
  assert.deepEqual(batchCheck(quizDrafts)(quiz, input, context), []);
  assert.equal(quizDrafts(quiz, context.passages)[0]!.quote, LONG);
  const wrong = { items: [quizItem("Rehashing costs linear time … keeps deletion constant.")] };
  assert.equal(batchCheck(quizDrafts)(wrong, input, context).length, 1, "an unrestorable quote fails verbatim");
  const cards = { cards: [{ kind: "cloze" as const, front: LONG, back: "linear", topics: ["Hash tables"], section: "Hashing", sourceId: "p1", quote: short }] };
  const [card] = cardDrafts(cards, context.passages);
  assert.equal(card!.quote, LONG);
  assert.equal(card!.problem, null, "the cloze sentence is the restored quote");
  assert.ok(sharedRules(input, "quiz").includes("first 5 words, then …"), "quiz and cards may abbreviate");
  assert.ok(!sharedRules(input).includes("first 5 words"), "a pack that doesn't restore quotes is never told to abbreviate");
});

test("output size: abbreviating long quotes on a semester-style quiz reply (chars / 4)", () => {
  const sentences = [
    "Rehashing costs linear time, but amortized over many inserts it keeps insertion constant on average.",
    "Primary clustering is the tendency of linear probing to form long runs of occupied slots.",
    "Deleting from an open-addressing table leaves a tombstone so later probes keep going.",
    "Overriding equals without overriding hashCode breaks lookups in a HashMap.",
    "The worst case for a hash table lookup is linear time, when every key lands in one bucket.",
  ];
  const abbreviate = (s: string) => {
    const w = s.split(" ");
    return w.length > 12 ? `${w.slice(0, 5).join(" ")} … ${w.slice(-5).join(" ")}` : s;
  };
  const full = JSON.stringify({ items: sentences.map((s) => quizItem(s)) });
  const short = JSON.stringify({ items: sentences.map((s) => quizItem(abbreviate(s))) });
  const tokens = (s: string) => Math.ceil(s.length / 4);
  assert.ok(tokens(short) < tokens(full));
  // Every abbreviated quote restores to its sentence from a passage holding all five.
  const passage = sentences.join(" ");
  for (const s of sentences) assert.equal(expandQuote(passage, abbreviate(s)), s);
});
