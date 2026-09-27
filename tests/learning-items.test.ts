import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate } from "../packages/learning/src/arith";
import { acceptMap, candidates, proposalFromCandidates } from "../packages/learning/src/concepts";
import { trigramJaccard } from "../packages/learning/src/flaws";
import { acceptFamily, runPipeline, type CandidateItem, type PipelineContext, type SupportVerdict } from "../packages/learning/src/items";
import { LABEL, supportByModel, tierLabel } from "../packages/learning/src/labels";
import { COURSE, exactValidate, smoke, smokeResources } from "./learning-fixtures";

const resources = smokeResources();
const map = acceptMap(proposalFromCandidates(candidates(resources)), { courseRef: COURSE, resources, validate: exactValidate, mapVersion: "m1" }).concepts;
const concept = map.find((c) => c.kind === "concept")!.id;
const NOW = new Date("2026-09-20T15:00:00.000Z");
const ctx = (over: Partial<PipelineContext> = {}): PipelineContext => ({
  courseRestricted: false, resources, validate: exactValidate, map, seenStems: [], now: NOW, ...over,
});

interface Seeded { id: string; flaw: string | null; expectedStage: number | null; item: Pick<CandidateItem, "kind" | "stem" | "options" | "key">; source: { resource: string; quote: string } }
const seeded = smoke<{ items: Seeded[] }>("seeded-items.json").items;

function candidate(s: Seeded | { id: string; item: Seeded["item"]; source: Seeded["source"] }, over: Partial<CandidateItem> = {}): CandidateItem {
  return {
    id: s.id, version: 1, familyId: `fam-${s.id}`, courseRef: COURSE, ...s.item, keyIdeas: [], explanation: null, tempting: {},
    bloom: "understand", tier: "T4", sourceTerm: null, origin: "generated", generator: null,
    sources: [{ resourceId: s.source.resource, quote: s.source.quote }], tags: [{ conceptId: concept, primary: true }], ...over,
  };
}

// What a judge (Jev per-option Nouls) would say for the seeded stage-7 items.
const JUDGE: Record<string, SupportVerdict> = {
  s01: { method: "jev", support: "supports", optionsPass: ["a"] },
  s02: { method: "jev", support: "supports", optionsPass: ["a", "b"] },
  s03: { method: "jev", support: "supports", optionsPass: [] },
  c01: { method: "jev", support: "supports", optionsPass: ["a"] },
};

test("negative: every seeded bad item is dropped at its expected stage with the reason logged; controls pass (ST-1)", () => {
  for (const s of seeded) {
    const r = runPipeline(candidate(s), ctx({ support: JUDGE[s.id] }));
    if (s.flaw === null) {
      assert.equal(r.accepted, true, `${s.id}: ${r.dropped?.reason}`);
    } else {
      assert.equal(r.accepted, false, `${s.id} (${s.flaw}) must be dropped`);
      assert.equal(r.dropped!.stage, s.expectedStage, `${s.id} (${s.flaw}): ${r.dropped!.reason}`);
      assert.ok(r.dropped!.reason.length > 0);
      assert.equal(r.log.at(-1)!.outcome, "fail");
    }
  }
});

test("stages run in order; the check line lists exactly the stages that ran and passed", () => {
  const c01 = seeded.find((s) => s.id === "c01")!;
  const noJudge = runPipeline(candidate(c01), ctx());
  assert.deepEqual(noJudge.log.map((l) => l.stage), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(noJudge.labels, [LABEL.quoteFound, LABEL.oneKeyStructure, LABEL.supportNotChecked, "From course materials"]);
  const judged = runPipeline(candidate(c01), ctx({ support: JUDGE.c01 }));
  assert.deepEqual(judged.labels, [LABEL.quoteFound, LABEL.oneKeyJev, LABEL.supportJev, "From course materials"]);
  const shadow = runPipeline(candidate(c01), ctx({ support: { ...JUDGE.c01!, shadow: true } }));
  assert.ok(shadow.labels.includes(LABEL.supportJevShadow));
  const model = runPipeline(candidate(c01), ctx({ support: { method: "model:sonnet-5", support: "supports", sameModel: true } }));
  assert.ok(model.labels.includes("Support judged by sonnet-5 in a separate check (same model that wrote it)"));
  assert.equal(judged.item!.bPrior, -0.5);
  assert.equal(judged.checks.find((c) => c.check === "support")!.method, "jev");
});

test("negative: an item from an open graded assignment is dropped at stage 1; a restricted course makes no items", () => {
  const hw = seeded.find((s) => s.id === "s10")!;
  assert.equal(runPipeline(candidate(hw), ctx()).dropped!.stage, 1);
  // After the closing time, the same source is allowed.
  assert.notEqual(runPipeline(candidate(hw), ctx({ now: new Date("2026-11-01T00:00:00Z") })).dropped?.stage, 1);
  assert.equal(runPipeline(candidate(seeded.find((s) => s.id === "c01")!), ctx({ courseRestricted: true })).dropped!.stage, 1);
});

test("stage 3 and stage 9: a one-character-off quote and an explanation without a valid citation are dropped", () => {
  const c01 = seeded.find((s) => s.id === "c01")!;
  const offByOne = candidate({ ...c01, source: { ...c01.source, quote: c01.source.quote.replace("bucket,", "bucket;") } });
  assert.equal(runPipeline(offByOne, ctx()).dropped!.stage, 3);
  const badExplanation = candidate(c01, { explanation: { text: "Collisions happen.", citation: { resourceId: "syn101-lecture-3", quote: "Collisions happen whenever buckets fill." } } });
  assert.equal(runPipeline(badExplanation, ctx()).dropped!.stage, 9);
  const goodExplanation = candidate(c01, { explanation: { text: "Chaining handles them.", citation: { resourceId: "syn101-lecture-3", quote: "Chaining stores colliding keys in a linked list at each bucket." } } });
  const r = runPipeline(goodExplanation, ctx());
  assert.equal(r.accepted, true);
  assert.equal(r.sources.length, 2);
});

test("near-duplicate: trigram Jaccard ≥ 0.8 against seen stems is rejected", () => {
  const c01 = seeded.find((s) => s.id === "c01")!;
  assert.ok(trigramJaccard("What is a collision in a hash table?", "what is a collision in a hash table") >= 0.8);
  assert.equal(runPipeline(candidate(c01), ctx({ seenStems: ["What is a collision in a hash table"] })).dropped!.stage, 5);
  assert.equal(runPipeline(candidate(c01), ctx({ seenStems: ["What is the load factor of a hash table?"] })).accepted, true);
});

test("stage 6: numeric keys are recomputed by the evaluator", () => {
  const base = { id: "n1", item: { kind: "numeric" as const, stem: "A table holds 12 keys in 4 buckets. What is its load factor?", options: null, key: 3 }, source: { resource: "syn101-lecture-3", quote: "The load factor alpha is the number of stored keys divided by the number of buckets." } };
  const ok = runPipeline(candidate(base, { formula: "12 ÷ 4" }), ctx());
  assert.equal(ok.accepted, true);
  assert.ok(ok.labels.includes(LABEL.executed));
  assert.equal(runPipeline(candidate({ ...base, item: { ...base.item, key: 4 } }, { formula: "12 ÷ 4" }), ctx()).dropped!.stage, 6);
});

test("the arithmetic evaluator handles + − × ÷, parentheses and units, and never calls eval or Function", () => {
  assert.deepEqual(evaluate("(2 + 3) × 4 − 6 ÷ 3"), { value: 18, unit: null });
  assert.deepEqual(evaluate("3 m + 2 m"), { value: 5, unit: "m" });
  assert.deepEqual(evaluate("10 m / 2 s"), { value: 5, unit: "m/s" });
  assert.deepEqual(evaluate("-(1.5e2) * 2"), { value: -300, unit: null });
  for (const bad of ["3 m + 2 s", "1 / 0", "process.exit(1)", "2 +", "(1 + 2"]) assert.throws(() => evaluate(bad), bad);
  const src = readFileSync(join(import.meta.dirname, "..", "packages", "learning", "src", "arith.ts"), "utf8").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(src, /\beval\s*\(|\bFunction\s*\(|new\s+Function/);
});

test("families: each variant passes on its own; a family with a failing variant keeps only its passing variants", () => {
  const c01 = seeded.find((s) => s.id === "c01")!;
  const keyIdeas = [{ idea: "two keys map to the same bucket", synonyms: [], required: true }];
  const mc = candidate({ ...c01, id: "v-mc" }, { familyId: "fam-collision", keyIdeas });
  const typed = candidate({ ...c01, id: "v-typed", item: { kind: "typed", stem: "Define a collision in a hash table.", options: null, key: "Two keys map to the same bucket" } }, { familyId: "fam-collision", keyIdeas });
  const badMc = candidate({ ...c01, id: "v-bad", item: { ...c01.item, stem: "Which option describes a hash collision best?", options: [...c01.item.options!.slice(0, 3), { id: "d", text: "None of the above" }] } }, { familyId: "fam-collision", keyIdeas });
  const fam = acceptFamily([mc, typed, badMc], ctx());
  assert.deepEqual(fam.accepted.map((r) => r.item!.id), ["v-mc", "v-typed"]);
  assert.equal(fam.dropped.length, 1);
  assert.equal(fam.accepted[1]!.item!.familyId, "fam-collision");
  const stranger = candidate({ ...c01, id: "v-other" }, { familyId: "fam-collision", keyIdeas: [] });
  assert.equal(acceptFamily([mc, stranger], ctx()).dropped[0]!.dropped!.reason, "a variant must share the family's ID, key ideas and sources");
});

test("negative: no check-label string contains 'verified', 'correct' or 'accurate'", () => {
  const all = [...Object.values(LABEL), supportByModel("any", true), supportByModel("any", false), ...(["T1", "T2", "T3", "T4"] as const).map((t) => tierLabel(t, "Fall 2025"))];
  for (const l of all) assert.doesNotMatch(l, /verified|correct|accurate/i, l);
});
