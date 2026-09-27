// The flashcards pack: term/definition cards and cloze sentences blanked by code.
import test from "node:test";
import assert from "node:assert/strict";
import { cardDrafts, cardsOutputSchema, CLOZE_BLANK } from "../packages/packs/cards/src/index";
import { batchCheck } from "../packages/packs/items/src/draft";

const card = (over: Record<string, unknown> = {}) => ({
  kind: "term" as const,
  front: "Queue",
  back: "A first-in, first-out collection",
  topics: ["Queues"],
  section: "Linear structures",
  sourceId: "p1",
  quote: "A queue is a first-in, first-out collection.",
  ...over,
});

test("a term card keeps the term as its front and the definition as its key", () => {
  const [d] = cardDrafts({ cards: [card()] });
  assert.equal(d!.kind, "card");
  assert.equal(d!.stem, "Queue");
  assert.equal(d!.key, "A first-in, first-out collection");
  assert.equal(d!.problem, null);
});

test("cloze: code blanks the first whole-word occurrence; an answer missing from the sentence is a fault", () => {
  const [ok, missing, partial] = cardDrafts({
    cards: [
      card({ kind: "cloze", front: "Chaining puts colliding keys in a linked list.", back: "linked list" }),
      card({ kind: "cloze", front: "Chaining puts colliding keys in a list.", back: "probing" }),
      card({ kind: "cloze", front: "Rehashing grows the table.", back: "hash" }),
    ],
  });
  assert.equal(ok!.kind, "cloze");
  assert.equal(ok!.stem, `Chaining puts colliding keys in a ${CLOZE_BLANK}.`);
  assert.equal(ok!.key, "linked list");
  assert.deepEqual(ok!.keyIdeas, [{ idea: "linked list", synonyms: [], required: true }]);
  assert.match(missing!.problem!, /doesn't occur/);
  assert.match(partial!.problem!, /doesn't occur/, "part of a word is not a blank");
});

test("the cards schema is closed, and the batch check grounds each card's quote", () => {
  assert.equal(cardsOutputSchema.safeParse({ cards: [{ ...card(), extra: true }] }).success, false);
  const check = batchCheck(cardDrafts);
  const passages = [{ sourceId: "p1", text: "A queue is a first-in, first-out collection." }];
  const input = { count: 5, sections: [], topics: [], focus: [] };
  assert.deepEqual(check({ cards: [card()] }, input, { passages }), []);
  assert.match(check({ cards: [card({ sourceId: "p9" })] }, input, { passages })[0]!, /not among the passages/);
});
