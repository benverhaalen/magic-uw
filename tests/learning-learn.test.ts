import { test } from "node:test";
import assert from "node:assert/strict";
import { createLearnRound, flagItem, nextQuestion, recordAnswer, roundDone, type LearnFamily, type LearnState } from "../packages/learning/src/learn";
import { mistakesQueue } from "../packages/learning/src/mistakes";
import type { LearningAttempt } from "../packages/learning/src/store";

function family(n: number): LearnFamily {
  const opts = [{ id: "a", text: `right ${n}` }, { id: "b", text: `wrong ${n}` }, { id: "c", text: `other ${n}` }];
  return {
    familyId: `f${n}`,
    recognition: { id: `f${n}-mc`, version: 1, kind: "mc", stem: `MC ${n}`, options: opts, key: "a", keyIdeas: [], bPrior: -0.5 },
    recall: { id: `f${n}-typed`, version: 1, kind: "typed", stem: `Typed ${n}`, options: null, key: `answer ${n}`, keyIdeas: [], bPrior: 0.5 },
  };
}
const pool = Array.from({ length: 12 }, (_, i) => family(i + 1));

function serveAll(state: LearnState, answer: (q: NonNullable<ReturnType<typeof nextQuestion>>, n: number) => "right" | "wrong") {
  const served: NonNullable<ReturnType<typeof nextQuestion>>[] = [];
  const attempts = [];
  for (let n = 0; n < 200; n++) {
    const q = nextQuestion(state);
    if (!q) break;
    served.push(q);
    const r = recordAnswer(state, q, answer(q, n));
    attempts.push(r.attempt);
    state = r.state;
  }
  return { served, attempts, state };
}

test("rounds hold 7 families; MC → typed after one right answer; each attempt records the variant, its format and prior", () => {
  const state = createLearnRound(pool);
  assert.equal(state.families.length, 7);
  assert.equal(createLearnRound(pool, { size: 10 }).families.length, 10);
  const { served, attempts, state: end } = serveAll(state, () => "right");
  assert.equal(served.length, 14);
  assert.ok(roundDone(end));
  const f1 = attempts.filter((a) => a.familyId === "f1");
  assert.deepEqual(f1.map((a) => [a.itemId, a.format, a.bPrior]), [["f1-mc", "mc", -0.5], ["f1-typed", "typed", 0.5]]);
});

test("negative: the typed stage never exposes options", () => {
  const { served } = serveAll(createLearnRound(pool), () => "right");
  for (const q of served) {
    if (q.format === "typed") assert.equal("options" in q, false, q.itemId);
    else assert.equal(q.options!.length, 3);
  }
});

test("a miss drops one stage and the family returns after at least 2 other families", () => {
  let missedOnce = false;
  const { served } = serveAll(createLearnRound(pool), (q) => {
    if (q.itemId === "f1-typed" && !missedOnce) {
      missedOnce = true;
      return "wrong";
    }
    return "right";
  });
  const i = served.findIndex((q) => q.itemId === "f1-typed");
  const back = served.findIndex((q, k) => k > i && q.familyId === "f1");
  assert.equal(served[back]!.itemId, "f1-mc", "dropped to the MC stage");
  assert.ok(back - i - 1 >= 2, `returned after ${back - i - 1} other families`);
});

test("never blocked: 50 wrong answers in a row, and the next question is still served", () => {
  let state = createLearnRound(pool.slice(0, 1));
  for (let n = 0; n < 50; n++) {
    const q = nextQuestion(state)!;
    assert.ok(q, `question ${n}`);
    state = recordAnswer(state, q, "wrong").state;
  }
  assert.ok(nextQuestion(state));
});

test("multiple choice only: the typed stage is skipped", () => {
  const { served } = serveAll(createLearnRound(pool, { mcOnly: true, size: 5 }), () => "right");
  assert.equal(served.length, 5);
  assert.ok(served.every((q) => q.format === "mc"));
});

test("negative: a flagged item's family leaves the round at once and doesn't return", () => {
  let state = createLearnRound(pool);
  const q = nextQuestion(state)!;
  state = flagItem(state, q.itemId);
  const { served } = serveAll(state, () => "right");
  assert.ok(!served.some((x) => x.familyId === q.familyId));
});

const T = (day: string, i: number) => `${day}T15:00:${String(i).padStart(2, "0")}.000Z`;
let k = 0;
function att(itemId: string, day: string, score: number, over: Partial<LearningAttempt> = {}): LearningAttempt {
  k++;
  return {
    id: `a${k}`, courseRef: "r", itemId, itemVersion: 1, sourceResourceId: null, primaryConceptId: "c1", correct: score >= 1,
    assistance: "none", seenBefore: false, confidence: null, createdAt: T(day, k % 60), format: "mc", mode: "learn", response: null,
    score, gradingMethod: "exact", responseMs: 1, conceptTags: [], sessionId: day, localDay: day, ...over,
  };
}

test("the mistakes queue puts confident misses first; a spaced unassisted success lowers priority; nothing retires", () => {
  const attempts = [
    att("plain", "2026-09-20", 0),
    att("confident", "2026-09-20", 0, { confidence: 1 }),
    att("spaced", "2026-09-20", 0),
    att("spaced", "2026-09-22", 1),
    att("spaced", "2026-09-24", 1),
    att("fixed-today", "2026-09-20", 0),
    att("fixed-today", "2026-09-25", 1, { assistance: "hint" }),
  ];
  const q = mistakesQueue(attempts, { today: "2026-09-25" });
  assert.equal(q[0]!.itemId, "confident");
  const spaced = q.find((e) => e.itemId === "spaced")!;
  const plain = q.find((e) => e.itemId === "plain")!;
  assert.ok(spaced.priority < plain.priority);
  assert.ok(spaced.priority > 0, "nothing retires");
  assert.equal(spaced.spacedSuccesses, 2);
  assert.equal(q.find((e) => e.itemId === "fixed-today")!.due, false);
  assert.equal(q.find((e) => e.itemId === "fixed-today")!.spacedSuccesses, 0, "a hinted success isn't unassisted");
});

test("negative: a flagged or quarantined item leaves the queue at once and never returns while flagged", () => {
  const attempts = [att("x", "2026-09-20", 0), att("y", "2026-09-20", 0), att("x", "2026-09-21", 0)];
  const dispute = { id: "d", courseRef: "r", targetKind: "item" as const, targetId: "x", reason: "wrong_key", note: null, status: "open" as const, createdAt: T("2026-09-21", 1), resolvedAt: null };
  assert.deepEqual(mistakesQueue(attempts, { today: "2026-09-22", disputes: [dispute] }).map((e) => e.itemId), ["y"]);
  assert.deepEqual(mistakesQueue(attempts, { today: "2026-09-22", quarantined: new Set(["y"]) }).map((e) => e.itemId), ["x"]);
  assert.equal(mistakesQueue(attempts, { today: "2026-09-22", disputes: [{ ...dispute, status: "undone" }] }).length, 2);
});
