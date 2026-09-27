import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG, params, unvalidatedConstants, validateConfig } from "../packages/learning/src/config";
import { STATE_LABEL } from "../packages/learning/src/types";

test("CONFIG is km-0.1, validates, and carries the spec §5.9 values", () => {
  assert.equal(CONFIG.version, "km-0.1");
  assert.doesNotThrow(() => validateConfig(CONFIG));
  const p = params();
  assert.equal(p.alpha, 1.0);
  assert.equal(p.beta, 0.06);
  assert.equal(p.s0, 1.5);
  assert.equal(p.bRef, 0.5);
  assert.deepEqual(p.bFormat, { tf: -1, mc: -0.5, cloze: 0, typed: 0.5, numeric: 0.5 });
  assert.equal(p.bBloom.remember, -0.25);
  assert.equal(p.solidEnterPLow, 0.75);
  assert.equal(p.solidExitPLow, 0.65);
  assert.equal(p.solidMinN, 8);
  assert.equal(p.r1AccBelow, 0.7);
  assert.equal(p.r5Margin, 0.1);
  assert.equal(p.r6Gap, 0.34);
  assert.deepEqual(p.difficultyBands.normal, [0.6, 0.8]);
  assert.equal(p.minutesPerItem.card, 0.5);
  assert.equal(p.minutesPerItem.typed, 2);
  assert.equal(typeof p.retrievalSupportThreshold, "number");
});

test("every constant carries validated: false", () => {
  const constants = Object.entries(CONFIG).filter(([, v]) => typeof v === "object");
  assert.ok(constants.length >= 40);
  for (const [key, entry] of constants) assert.equal((entry as { validated: boolean }).validated, false, key);
  assert.equal(unvalidatedConstants().length, constants.length);
});

test("negative: a config missing any constant fails validation", () => {
  for (const key of Object.keys(CONFIG)) {
    const copy: Record<string, unknown> = structuredClone(CONFIG);
    delete copy[key];
    assert.throws(() => validateConfig(copy), Error, `missing ${key} must fail`);
  }
});

test("negative: a band cut-off outside (0,1) fails validation", () => {
  for (const [key, bad] of [
    ["solidEnterPLow", 1],
    ["solidExitPLow", 0],
    ["r1PHatEnter", 1.2],
    ["solidMinR", -0.1],
  ] as const) {
    const copy = structuredClone(CONFIG) as unknown as Record<string, { value: unknown; validated: boolean }>;
    copy[key] = { value: bad, validated: false };
    assert.throws(() => validateConfig(copy), Error, key);
  }
  const bands = structuredClone(CONFIG) as unknown as { difficultyBands: { value: { push: number[] } } };
  bands.difficultyBands.value.push = [0.45, 1.3];
  assert.throws(() => validateConfig(bands));
});

test("Solid is shown to students as Mastered (spec H4)", () => {
  assert.equal(STATE_LABEL.solid, "Mastered");
});
