import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PATHS, lintJson, lintPaths, lintSource } from "../scripts/copy-lint";

const ROOT = join(import.meta.dirname, "..");

const BANNED: [string, string][] = [
  ["urgency", "Only 2 spots left"],
  ["urgency", "Hurry, review now"],
  ["urgency", "Last chance to practice"],
  ["urgency", "Offer ends in 3 hours"],
  ["guilt", "Don't lose your progress"],
  ["guilt", "You're falling behind your classmates"],
  ["guilt", "We miss you!"],
  ["guilt", "We're disappointed"],
  ["guilt", "No practice today :("],
  ["game", "Keep your streak alive"],
  ["game", "7-day streak"],
  ["game", "+10 XP"],
  ["game", "You earned 50 experience points"],
  ["game", "3 hearts left"],
  ["ranking", "You moved up a league"],
  ["ranking", "Weekly leaderboard"],
  ["ranking", "You're in the top 10%"],
  ["readiness", "Predicted score: B+"],
  ["readiness", "Your chance of passing is high"],
  ["readiness", "Pass probability"],
  ["readiness", "You're ready for the exam"],
  ["readiness", "Ready for the midterm"],
  ["readiness", "85% mastered"],
  ["readiness", "Mastery: 72%"],
];

test("negative: each banned pattern is found in a string literal", () => {
  for (const [rule, text] of BANNED) {
    const found = lintSource("fixture.ts", `export const label = ${JSON.stringify(text)};\n`);
    assert.ok(found.some((f) => f.rule === rule), `${rule}: ${text}`);
  }
});

test("template strings and JSX text are scanned; comments and imports aren't", () => {
  assert.equal(lintSource("a.ts", "const n = 3;\nexport const s = `Keep your ${n}-day streak`;\n").length, 1);
  assert.equal(lintSource("a.tsx", "export const A = () => <p>Weekly leaderboard</p>;\n").length, 1);
  assert.equal(lintSource("a.ts", "// no XP, no streaks, no leagues\nimport x from './streak';\nexport const y = x;\n").length, 0);
});

test("calm, specific copy passes, including the mastery bar's own label", () => {
  for (const ok of [
    "Mastered 7 of 12 topics for Midterm 2",
    "Based on your answers in My Magic UW, not a grade prediction.",
    "Right on 2 of 4 answers without help.",
    "Fading: last reviewed 20 days ago.",
    "Due Friday at 11:59 pm",
    "You already answered this one.",
  ]) {
    assert.deepEqual(lintSource("ok.ts", `export const s = ${JSON.stringify(ok)};\n`), [], ok);
  }
});

test("quoted course text is exempt when it's marked as a quote", () => {
  const src = [
    '// copy-lint: quote',
    'export const q1 = "Hurry: only 3 seats left in the lab section";',
    'export const q2 = "Only 2 days left to register"; // copy-lint: quote',
    'export const bad = "Only 2 days left to register";',
  ].join("\n");
  const found = lintSource("q.ts", src);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.line, 4);
  assert.deepEqual(lintJson("q.json", JSON.stringify({ quote: "Hurry, the exam covers modules 1-3", label: "Section 1" })), []);
  assert.equal(lintJson("q.json", JSON.stringify({ label: "Hurry" })).length, 1);
});

test("negative: the CLI exits non-zero on a fixture with a banned pattern, and 0 on the product paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "copy-lint-"));
  try {
    writeFileSync(join(dir, "bad.ts"), 'export const s = "Keep your streak!";\n');
    const tsx = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
    const bad = spawnSync(process.execPath, [tsx, join(ROOT, "scripts", "copy-lint.ts"), dir], { encoding: "utf8" });
    assert.equal(bad.status, 1, bad.stderr);
    assert.match(bad.stderr, /\[game\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const clean = lintPaths(DEFAULT_PATHS.map((p) => join(ROOT, p)));
  assert.deepEqual(clean, []);
});
