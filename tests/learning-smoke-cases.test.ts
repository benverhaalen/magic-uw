import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureBatchSchema } from "../packages/contracts/src/index";
import { verify } from "../evals/freeze";

const DIR = join(import.meta.dirname, "..", "evals", "cases", "smoke");
const load = <T>(f: string): T => JSON.parse(readFileSync(join(DIR, f), "utf8")) as T;

interface Course { source: { label: string }; resources: { externalId: string; text: string; courseName: string }[] }
const course = load<Course>("course.json");
const text = new Map(course.resources.map((r) => [r.externalId, r.text]));
const occurrences = (hay: string, needle: string) => hay.split(needle).length - 1;

test("the course is a clearly synthetic, captureBatchSchema-valid batch", () => {
  assert.doesNotThrow(() => captureBatchSchema.parse(course));
  assert.match(course.source.label, /Synthetic/i);
  for (const r of course.resources) assert.match(r.courseName, /Synthetic/);
  for (const r of course.resources) assert.match(r.text + r.courseName, /synthetic/i);
});

test("≥10 answerable questions whose gold quotes occur exactly once; ≥4 unanswerable", () => {
  const q = load<{ answerable: { gold: { resource: string; quote: string }[] }[]; unanswerable: unknown[] }>("questions.json");
  assert.ok(q.answerable.length >= 10);
  assert.ok(q.unanswerable.length >= 4);
  for (const a of q.answerable) for (const g of a.gold) assert.equal(occurrences(text.get(g.resource)!, g.quote), 1, g.quote);
});

test("≥8 seeded bad items covering wrong key, two correct, no correct and cue flaws; quotes valid except the planted miss", () => {
  const s = load<{ items: { flaw: string | null; source: { resource: string; quote: string } }[] }>("seeded-items.json");
  const flaws = s.items.filter((i) => i.flaw).map((i) => i.flaw);
  assert.ok(flaws.length >= 8);
  for (const f of ["wrong_key", "two_correct", "no_correct", "longest_option_key", "all_of_the_above"]) assert.ok(flaws.includes(f), f);
  for (const i of s.items) {
    const n = occurrences(text.get(i.source.resource)!, i.source.quote);
    assert.equal(n, i.flaw === "quote_missing" ? 0 : 1, `${i.flaw}: ${i.source.quote}`);
  }
});

test("event streams cover every row of the spec §5.5 table", () => {
  const e = load<{ rows: { label: string }[] }>("events.json");
  assert.equal(e.rows.length, 11);
});

test("the frozen manifest verifies; negative: editing a case file without re-freezing fails", () => {
  assert.deepEqual(verify(DIR), []);
  const tmp = mkdtempSync(join(tmpdir(), "smoke-"));
  try {
    cpSync(DIR, tmp, { recursive: true });
    const f = join(tmp, "questions.json");
    writeFileSync(f, readFileSync(f, "utf8").replace("upper bound", "lower bound"));
    assert.match(verify(tmp).join("\n"), /questions\.json changed/);
    writeFileSync(join(tmp, "extra.json"), "{}");
    assert.match(verify(tmp).join("\n"), /extra\.json is not in the frozen manifest/);
    rmSync(join(tmp, "events.json"));
    assert.match(verify(tmp).join("\n"), /events\.json is in the manifest but missing/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
