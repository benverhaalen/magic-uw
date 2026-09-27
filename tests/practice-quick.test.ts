import { test } from "node:test";
import assert from "node:assert/strict";
import type { ConceptModel } from "../packages/learning/src/knowledge/state";
import { quickSession, suggestSize, type QuickInput } from "../packages/learning/src/practice/quick";
import type { ConceptStateName } from "../packages/learning/src/types";

function model(conceptId: string, band: ConceptStateName, pHat = 0.4): ConceptModel {
  return {
    conceptId, theta: 0, n: band === "not_seen" ? 0 : 3, s: 0.75, pHat, pLow: 0.2, pHigh: 0.6, acc: null, r: null, band, r1Active: false,
    reasons: band === "iffy" ? [{ rule: "R1", text: "x", eventIds: [], clearsWhen: "y" }] : [],
    counts: { answers: 0, unassisted: 0, correct: 0, cardReviews: 0, selfRatings: 0 }, coveredBy: [], configVersion: "km-0.1",
  };
}
const item = (id: string, familyId: string, conceptId: string, kind: "mc" | "typed" | "tf") => ({
  id, familyId, kind, options: kind === "mc" ? 4 : kind === "tf" ? 2 : 0, bPrior: 0, tags: [{ conceptId, weight: 1, primary: true }],
});
const input = (over: Partial<QuickInput> = {}): QuickInput => ({
  sessionId: "q1", size: 5,
  models: [model("c1", "getting_there", 0.7), model("c2", "iffy", 0.3)],
  pool: [item("c1-mc", "fa", "c1", "mc"), item("c2-typed", "fb", "c2", "typed"), item("c2-mc", "fb", "c2", "mc"), item("miss1", "fc", "c1", "mc"), item("miss2", "fd", "c1", "mc")],
  mistakes: [
    { itemId: "miss1", lastMissId: "x", lastMissDay: "2026-09-20", confident: true, spacedSuccesses: 0, priority: 2, due: true },
    { itemId: "miss2", lastMissId: "y", lastMissDay: "2026-09-20", confident: true, spacedSuccesses: 0, priority: 2, due: true },
  ],
  dueCards: Array.from({ length: 20 }, (_, i) => ({ cardId: `k${i}`, conceptId: "c1", due: "", r: i / 20 })),
  ...over,
});

test("3-, 5- and 10-minute plans: ≤1 confident miss, due cards, one Learn family on the top-priority concept", () => {
  for (const size of [3, 5, 10] as const) {
    const plan = quickSession(input({ size }));
    const kinds = plan.blocks.map((b) => b.kind);
    assert.deepEqual(kinds, ["confident_misses", "due_cards", "learn"], `size ${size}`);
    assert.equal(plan.blocks[0]!.itemIds.length, 1);
    assert.deepEqual(plan.blocks[2]!.itemIds, ["c2-mc", "c2-typed"].slice(0, plan.blocks[2]!.itemIds.length), "the Iffy concept's family, MC first");
    assert.ok(plan.blocks[2]!.itemIds.length >= 1);
  }
});

test("negative: a plan never exceeds its size by more than one item; it uses existing pools only", () => {
  for (const size of [3, 5, 10] as const) {
    for (const cards of [0, 1, 5, 40]) {
      const plan = quickSession(input({ size, dueCards: Array.from({ length: cards }, (_, i) => ({ cardId: `k${i}`, conceptId: "c1", due: "", r: 0.5 })) }));
      assert.ok(plan.plannedMinutes < size + 2, `${size} min, ${cards} cards: ${plan.plannedMinutes}`);
      const ids = plan.blocks.flatMap((b) => b.itemIds);
      for (const id of ids) assert.ok(id.startsWith("k") || input().pool.some((p) => p.id === id), id);
    }
  }
  const empty = quickSession(input({ pool: [], mistakes: [], dueCards: [] }));
  assert.deepEqual(empty.blocks, []);
  assert.throws(() => quickSession(input({ size: 7 as 5 })));
});

test("suggests a size from today's study windows", () => {
  const windows = [{ start: "09:00", end: "09:04" }, { start: "13:00", end: "13:30" }];
  assert.equal(suggestSize(windows, "09:01"), 3);
  assert.equal(suggestSize(windows, "12:00"), 10);
  assert.equal(suggestSize(windows, "13:25"), 5);
  assert.equal(suggestSize(windows, "14:00"), null);
  assert.equal(suggestSize([], "10:00"), null);
});
