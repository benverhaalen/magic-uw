import { test } from "node:test";
import assert from "node:assert/strict";
import type { ConceptModel } from "../packages/learning/src/knowledge/state";
import type { MistakeEntry } from "../packages/learning/src/mistakes";
import { conceptPriority } from "../packages/learning/src/priority";
import { buildSession, DIAGNOSTIC_REASON, type PoolItem, type SessionInput } from "../packages/learning/src/session";
import type { Concept } from "../packages/learning/src/store";
import type { ConceptStateName } from "../packages/learning/src/types";

const concept = (id: string, position: number, parentId: string | null = null, kind: Concept["kind"] = "concept"): Concept => ({
  id, courseRef: "r", parentId, label: id, kind, position, origin: "code", status: "active", mergedInto: null, studentLabel: null, mapVersion: "m", sources: [],
});
function model(conceptId: string, band: ConceptStateName, over: Partial<ConceptModel> = {}): ConceptModel {
  return {
    conceptId, theta: 0, n: band === "not_seen" ? 0 : 3, s: 0.75, pHat: 0.38, pLow: 0.2, pHigh: 0.6, acc: null, r: null, band, r1Active: false,
    reasons: band === "iffy" ? [{ rule: "R1", text: "x", eventIds: [], clearsWhen: "y" }] : [],
    counts: { answers: 0, unassisted: 0, correct: 0, cardReviews: 0, selfRatings: 0 }, coveredBy: [], configVersion: "km-0.1", ...over,
  };
}
const item = (id: string, conceptId: string, kind: PoolItem["kind"], bPrior: number): PoolItem => ({
  id, kind, options: kind === "mc" ? 4 : kind === "tf" ? 2 : 0, bPrior, tags: [{ conceptId, weight: 1, primary: true }],
});
const mistake = (itemId: string, confident: boolean, due = true): MistakeEntry => ({ itemId, lastMissId: `m-${itemId}`, lastMissDay: "2026-09-20", confident, spacedSuccesses: 0, priority: 1, due });

const concepts = [concept("c1", 1), concept("c2", 2), concept("c3", 3)];
const base = (over: Partial<SessionInput> = {}): SessionInput => ({
  sessionId: "s1", minutes: 20, difficulty: "normal", concepts, pool: [], mistakes: [], dueCards: [],
  models: [model("c1", "iffy"), model("c2", "getting_there"), model("c3", "not_seen")], ...over,
});

test("priority follows spec §5.7", () => {
  const m = model("c1", "iffy", { pHat: 0.5, coveredBy: [{ assessmentId: "e", title: "Exam", daysAway: 7 }] });
  assert.ok(Math.abs(conceptPriority(m) - (1 + 2 * Math.exp(-1)) * (0.5 + 0.25)) < 1e-12);
  assert.equal(conceptPriority(model("c3", "not_seen")), 0.6);
  const many = model("c1", "iffy", { pHat: 0.5, reasons: Array.from({ length: 5 }, () => ({ rule: "R1" as const, text: "", eventIds: [], clearsWhen: "" })) });
  assert.equal(conceptPriority(many), 0.5 + 0.75, "rules are capped at 0.75");
});

test("blocks run R4 items (≤3) → due mistakes → due cards → Learn, each with a reason", () => {
  const pool = [
    ...["r1", "r2", "r3", "r4"].map((id) => item(id, "c1", "mc", -0.5)),
    item("m1", "c2", "typed", 0.5), item("m2", "c2", "typed", 0.5),
    item("l1", "c1", "typed", 0.5), item("l2", "c2", "mc", -0.5), item("l3", "c3", "tf", -1),
  ];
  const plan = buildSession(base({
    minutes: 60, pool,
    mistakes: [mistake("r1", true), mistake("r2", true), mistake("r3", true), mistake("r4", true), mistake("m1", false), mistake("m2", false, false)],
    dueCards: [{ cardId: "k1", conceptId: "c2", due: "", r: 0.7 }, { cardId: "k2", conceptId: "c1", due: "", r: 0.9 }],
  }));
  assert.deepEqual(plan.blocks.map((b) => b.kind), ["confident_misses", "mistakes", "due_cards", "learn"]);
  assert.deepEqual(plan.blocks[0]!.itemIds, ["r1", "r2", "r3"]);
  assert.deepEqual(plan.blocks[1]!.itemIds, ["r4", "m1"], "due mistakes only; the fourth confident miss is served here");
  assert.equal(plan.blocks[3]!.itemIds[0], "l1", "Iffy concept first");
  for (const b of plan.blocks) assert.ok(b.reason.length > 10);
});

test("difficulty is a preference: the item nearest the band is picked", () => {
  const pool = [item("typed", "c1", "typed", 0.5), item("tf", "c1", "tf", -1), item("mc", "c1", "mc", -0.5)];
  const first = (difficulty: SessionInput["difficulty"]) => buildSession(base({ pool, difficulty, minutes: 0.5, models: [model("c1", "iffy")] })).blocks[0]!.itemIds[0];
  assert.equal(first("warmup"), "tf");
  assert.equal(first("normal"), "mc");
  assert.equal(first("push"), "mc");
});

test("negative: a pool with no item inside the band still fills the block with the nearest items", () => {
  const pool = [item("t1", "c1", "typed", 0.5), item("t2", "c1", "typed", 0.5), item("t3", "c1", "typed", 0.5)];
  const plan = buildSession(base({ pool, difficulty: "warmup", minutes: 6, models: [model("c1", "iffy")] }));
  assert.equal(plan.blocks[0]!.itemIds.length, 3);
});

test("negative: with no evidence the plan is a labelled diagnostic of ≤8 items", () => {
  const units = Array.from({ length: 10 }, (_, i) => concept(`u${i}`, i, null, "unit"));
  const kids = units.map((u, i) => concept(`k${i}`, 0, u.id));
  const pool = kids.flatMap((k) => [item(`${k.id}-a`, k.id, "mc", -0.5), item(`${k.id}-b`, k.id, "typed", 0.5)]);
  const plan = buildSession(base({ concepts: [...units, ...kids], pool, minutes: 120, models: kids.map((k) => model(k.id, "not_seen")) }));
  assert.equal(plan.blocks.length, 1);
  assert.equal(plan.blocks[0]!.kind, "diagnostic");
  assert.equal(plan.blocks[0]!.reason, DIAGNOSTIC_REASON);
  assert.equal(plan.blocks[0]!.itemIds.length, 8);
  assert.equal(new Set(plan.blocks[0]!.itemIds.map((id) => id.split("-")[0])).size, 8, "one per unit");
});

test("negative: planned length never exceeds the requested minutes by more than one item", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const kinds: PoolItem["kind"][] = ["mc", "tf", "typed", "cloze", "numeric"];
  for (let run = 0; run < 200; run++) {
    const pool = Array.from({ length: 5 + Math.floor(rnd() * 40) }, (_, i) => item(`i${i}`, `c${1 + (i % 3)}`, kinds[Math.floor(rnd() * kinds.length)]!, rnd() - 0.5));
    const minutes = 5 + Math.floor(rnd() * 60);
    const plan = buildSession(base({
      pool, minutes,
      mistakes: pool.slice(0, 4).map((p, i) => mistake(p.id, i % 2 === 0)),
      dueCards: Array.from({ length: Math.floor(rnd() * 30) }, (_, i) => ({ cardId: `k${i}`, conceptId: "c1", due: "", r: rnd() })),
    }));
    assert.ok(plan.plannedMinutes < minutes + 2, `planned ${plan.plannedMinutes} for ${minutes}`);
    const ids = plan.blocks.flatMap((b) => b.itemIds);
    assert.equal(new Set(ids).size, ids.length, "no item twice");
  }
});
