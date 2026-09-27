// The item-quality harness (evals/items, measurement plan MT4): its statistics, the offline smoke
// suite through the real pack path with the fake CLI, and the blind rubric step.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cohenKappa, rate, shuffle, prng, wilson } from "../evals/items/stats";
import { createHash } from "node:crypto";
import { createStore } from "@magic/storage";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import { defaultPrivacy } from "@magic/contracts";
import { applyConsent } from "../packages/core/src/egress";
import { offlineBackend, runOffline } from "../evals/items/run";
import { inspectCourse, runHarness } from "../evals/items/harness";
import { verify } from "../evals/freeze";
import { CASES_DIR, syntheticCourses } from "../evals/items/corpus";
import { checkRaters, exportBlind, ourItems, parseDelimited, RefusedError, scoreBlind, theirItems } from "../evals/items/blind";

test("Wilson intervals: exact at the edges, known value in the middle, never outside [0, 1]", () => {
  assert.equal(wilson(0, 0), null);
  const [lo0, hi0] = wilson(0, 10)!;
  assert.equal(lo0, 0);
  assert.ok(Math.abs(hi0 - 0.2775) < 1e-3, String(hi0));
  const [lo1, hi1] = wilson(10, 10)!;
  assert.ok(Math.abs(lo1 - 0.7225) < 1e-3, String(lo1));
  assert.equal(hi1, 1);
  const [lo, hi] = wilson(8, 10)!;
  assert.ok(Math.abs(lo - 0.4902) < 1e-3 && Math.abs(hi - 0.9433) < 1e-3, `${lo} ${hi}`);
  assert.deepEqual(rate(0, 0), { k: 0, n: 0, rate: null, ci: null });
  assert.throws(() => wilson(3, 2));
});

test("Cohen's kappa: perfect, chance-level and a hand-computed quadratic-weighted case", () => {
  assert.equal(cohenKappa([1, 2, 3, 4], [1, 2, 3, 4], [1, 2, 3, 4], "quadratic"), 1);
  assert.equal(cohenKappa([1, 1, 2, 2], [1, 2, 1, 2], [1, 2]), 0);
  // Observed weighted disagreement (1/9)/3, expected 21/81: kappa = 1 - (1/27)/(21/81) = 6/7.
  assert.ok(Math.abs(cohenKappa([1, 2, 3], [1, 2, 4], [1, 2, 3, 4], "quadratic")! - 6 / 7) < 1e-9);
  assert.equal(cohenKappa([], [], [1, 2]), null);
  assert.throws(() => cohenKappa([1], [1, 2], [1, 2]));
});

test("the seeded shuffle is reproducible and a permutation", () => {
  const a = shuffle([1, 2, 3, 4, 5, 6], prng(7));
  assert.deepEqual(a, shuffle([1, 2, 3, 4, 5, 6], prng(7)));
  assert.deepEqual([...a].sort(), [1, 2, 3, 4, 5, 6]);
});

test("the item-eval case files are frozen", () => {
  assert.deepEqual(verify(CASES_DIR), []);
});

let smoke: Awaited<ReturnType<typeof runOffline>> | null = null;
const getSmoke = async () => (smoke ??= await runOffline("smoke"));

test("offline smoke: the real pack path meets every pre-registered code threshold", async () => {
  const run = await getSmoke();
  const missed = run.report.rows.filter((r) => r.verdict === "missed");
  // The one planted defect the app doesn't survive today is reported, not hidden (see the todo below).
  const catchRow = run.report.rows.find((r) => r.id === "plantedCatch")!;
  assert.ok(catchRow.rate.n >= 8, `planted n = ${catchRow.rate.n}`);
  assert.deepEqual(
    missed.map((r) => r.id),
    [],
    JSON.stringify(missed.map((r) => ({ id: r.id, rate: r.rate }))),
  );
  for (const row of run.report.rows) if (row.rate.n) assert.ok(row.rate.ci, `${row.id} has a Wilson interval`);
  // Every planted item defect code can catch was caught.
  for (const p of run.report.planted.filter((x) => !x.requiresJudge && x.id !== "call-unparseable-response")) assert.equal(p.caught, p.n, p.id);
});

test("offline smoke: prompts carry the subject profile; a repeat costs 0 tokens; languages get both directions", async () => {
  const run = await getSmoke();
  const course = run.result.units.filter((u) => u.scopeKind === "course");
  assert.ok(course.length >= 4);
  for (const u of course) {
    assert.match(u.prompt ?? "", new RegExp(`Subject profile \\(${u.family}\\)`));
    assert.deepEqual({ cached: u.repeat.cached, tokens: u.repeat.tokens, calls: u.repeat.backendCalls }, { cached: true, tokens: 0, calls: 0 });
  }
  const spanish = run.report.subjectFit.find((f) => f.family === "languages")!;
  assert.equal(spanish.pass, true, JSON.stringify(spanish.checks));
  const reverse = run.result.items.flatMap((i) => i.derived);
  assert.ok(reverse.length >= 2);
  for (const r of reverse) assert.equal(r.item.id.endsWith("r"), true);
  // Every stored quote is the exact slice of its resource text.
  assert.equal(run.report.rows.find((r) => r.id === "verbatimQuote")!.rate.rate, 1);
});

test("an unparseable model answer is retried like a failed check, not thrown", { todo: "the SQL ledger rejects the runner's row for an unreadable answer (model \"\"), so the pack command throws; see the harness's probe-unparseable unit" }, async () => {
  const run = await getSmoke();
  const probe = run.result.units.find((u) => u.scopeKind === "probe")!;
  assert.equal(probe.threw, null, probe.threw ?? "");
  assert.equal(probe.result.status, "done");
});

test("a workspace database is read through a temp copy: the original file is byte-identical after a run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "item-db-"));
  const db = join(dir, "workspace.sqlite");
  const [course] = syntheticCourses(["computing"]);
  const store = createStore(db);
  store.ingest(course!.batch);
  store.setPrivacy({ ...defaultPrivacy, mode: "selective_cloud", hostedProvider: "claude", shareCourseText: true });
  applyConsent(store, { action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION }, "2026-09-27T00:00:00.000Z");
  store.close();
  const hash = () => createHash("sha256").update(readFileSync(db)).digest("hex");
  const before = hash();
  const found = inspectCourse(db, course!.id)!;
  assert.deepEqual({ accountScope: found.accountScope, family: found.family }, { accountScope: "synthetic", family: "computing" });
  const result = await runHarness({
    courses: [{ ...course!, tier: "private", dbPath: db }],
    packs: ["quiz"],
    counts: { quiz: 6, cards: 6 },
    scopes: "course",
    backend: { kind: "offline", fake: offlineBackend, plantsPerCall: 0, defects: [] },
  });
  assert.equal(result.units[0]!.result.status, "done", result.units[0]!.result.message);
  assert.ok(result.items.some((i) => i.stored));
  assert.equal(hash(), before);
  assert.deepEqual(readdirSync(dir), ["workspace.sqlite"]);
});

test("blind export: one normalised, shuffled set with no system names; pairs in both orders; the key sealed", async () => {
  const run = await getSmoke();
  const dir = mkdtempSync(join(tmpdir(), "item-blind-"));
  const itemsJsonl = run.result.items
    .filter((i) => i.stored && !i.planted)
    .map((i) => JSON.stringify({ item: { id: i.stored!.item.id, kind: i.stored!.item.kind, stem: i.stored!.item.stem, options: i.stored!.item.options, key: i.stored!.item.key, unit: i.stored!.item.unit ?? null } }))
    .join("\n");
  const ours = ourItems(itemsJsonl, "magic");
  const quizlet = "Stack\tA last-in, first-out collection\nQueue\tA first-in, first-out collection\n\"Hash, table\"\t\"Maps keys to \"\"buckets\"\"\"\n";
  const theirs = theirItems(quizlet, "quizlet", "quizlet-export");
  assert.equal(theirs.length, 3);
  assert.equal(theirs[2]!.item.answer, 'Maps keys to "buckets"');
  const r = exportBlind({ ours, theirs, generatorFamilies: { magic: "anthropic", "quizlet-export": "unknown" }, seed: 42, out: dir, now: "2026-09-27T00:00:00.000Z" });
  assert.equal(r.tasks, ours.length + 3);
  assert.equal(r.pairs, 3);
  const tasks = readFileSync(join(dir, "tasks.jsonl"), "utf8");
  const pairs = readFileSync(join(dir, "pairs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { pairId: string; order: string });
  assert.doesNotMatch(tasks + JSON.stringify(pairs), /magic|quizlet|anthropic|sourceId|quote/i);
  for (const id of new Set(pairs.map((p) => p.pairId))) assert.deepEqual(pairs.filter((p) => p.pairId === id).map((p) => p.order).sort(), ["AB", "BA"]);
  assert.deepEqual(readdirSync(join(dir, "sealed")), ["key.json"]);
  // Same seed, same export.
  const again = mkdtempSync(join(tmpdir(), "item-blind-"));
  exportBlind({ ours, theirs, generatorFamilies: { magic: "anthropic", "quizlet-export": "unknown" }, seed: 42, out: again, now: "2026-09-27T00:00:00.000Z" });
  assert.equal(readFileSync(join(again, "tasks.jsonl"), "utf8"), tasks);
});

test("blind score: a same-family LLM rater is refused; order-swap consistency, Wilson rates and kappa are reported", async () => {
  const run = await getSmoke();
  const dir = mkdtempSync(join(tmpdir(), "item-blind-"));
  const ours = ourItems(
    run.result.items.filter((i) => i.stored && !i.planted).slice(0, 6).map((i) => JSON.stringify({ item: { id: i.stored!.item.id, kind: i.stored!.item.kind, stem: i.stored!.item.stem, options: i.stored!.item.options, key: i.stored!.item.key, unit: null } })).join("\n"),
    "magic",
  );
  const theirs = theirItems("front,back\nStack,LIFO collection\nQueue,FIFO collection\n", "csv", "other");
  exportBlind({ ours, theirs, generatorFamilies: { magic: "anthropic", other: "google" }, seed: 1, out: dir });
  const tasks = readFileSync(join(dir, "tasks.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { taskId: string });
  const pairs = readFileSync(join(dir, "pairs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { pairId: string; order: "AB" | "BA" });
  const write = (name: string, rater: object, score: (i: number) => number, prefer: (order: string) => string) => {
    const lines = [
      ...tasks.map((t, i) => JSON.stringify({ taskId: t.taskId, rater, scores: { accuracy: score(i), clarity: score(i + 1), examRelevance: 3, difficultyFit: 3, distractorQuality: "na" } })),
      ...pairs.map((p) => JSON.stringify({ pairId: p.pairId, order: p.order, rater, preferred: prefer(p.order) })),
    ];
    const f = join(dir, name);
    writeFileSync(f, lines.join("\n"));
    return f;
  };
  const sameFamily = write("claude.jsonl", { id: "j1", kind: "llm", family: "anthropic", model: "x" }, () => 4, () => "A");
  assert.throws(() => scoreBlind(dir, [sameFamily]), RefusedError);
  assert.throws(() => checkRaters([{ id: "j", kind: "llm" }], ["anthropic"]), RefusedError);
  // A position-biased rater (always "A") is swap-inconsistent on every pair.
  const human = write("human.jsonl", { id: "h1", kind: "human" }, (i) => 1 + (i % 4), () => "A");
  const second = write("human2.jsonl", { id: "h2", kind: "human" }, (i) => 1 + (i % 4), (o) => (o === "AB" ? "A" : "B"));
  const s = scoreBlind(dir, [human, second]);
  assert.equal(s.pairwise!.swapConsistent.k, 0);
  assert.equal(s.pairwise!.pairs, 2);
  assert.ok(s.perSystem.magic!.accuracy!.acceptable.ci);
  assert.equal(s.agreement.find((a) => a.dimension === "accuracy")!.kappa, 1);
  assert.equal(s.agreement.find((a) => a.dimension === "accuracy")!.weights, "quadratic");
  // The second rater is consistent across orders.
  const consistent = scoreBlind(dir, [second]);
  assert.equal(consistent.pairwise!.swapConsistent.k, 2);
});

test("delimited parsing: quotes, doubled quotes, embedded delimiters and newlines", () => {
  assert.deepEqual(parseDelimited('a,"b,c","d ""e""\nf"\r\ng,h', ","), [["a", "b,c", 'd "e"\nf'], ["g", "h"]]);
  const q = theirItems("question,a,b,c,d,answer\nWhat is LIFO?,Stack,Queue,Heap,Graph,a\n", "csv", "x");
  assert.deepEqual(q[0]!.item, { kind: "question", prompt: "What is LIFO?", options: ["Stack", "Queue", "Heap", "Graph"], answer: "Stack" });
});
