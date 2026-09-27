import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createClaudeBackend, type CliCommand } from "../packages/runner/src/index.ts";
import {
  buildPrompt,
  createPackRuntime,
  definePack,
  memoryArtifactStore,
  memoryLedgerStore,
  quotesGrounded,
  type CourseFrame,
  type Passage,
} from "../packages/packs/core/src/index.ts";
import { readPackArtifact, runPack, type PackJobDeps } from "../packages/core/src/jobs/pack.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fake: CliCommand = { file: process.execPath, prefixArgs: [join(here, "fixtures", "fake-cli", "fake-cli.mjs"), "claude"] };

const cardsSchema = z
  .object({
    cards: z.array(z.object({ front: z.string().min(1), back: z.string().min(1), sourceId: z.string(), quote: z.string() }).strict()).min(1),
  })
  .strict();
type Cards = z.infer<typeof cardsSchema>;
const pack = definePack<{ topic: string }, Cards>({
  id: "concept-cards",
  version: "v1",
  tier: "pass",
  system: "You write study cards from the passages. Quote the passage you used.",
  template: (i) => `Make cards on: ${i.topic}`,
  schema: cardsSchema,
  checks: [quotesGrounded((o: Cards) => o.cards.map((c) => ({ sourceId: c.sourceId, quote: c.quote })))],
  jevGates: [{ id: "card-accuracy", items: (o: Cards) => o.cards.map((c, i) => ({ id: String(i), text: `${c.front} / ${c.back}` })) }],
  cacheKey: (i) => ({ topic: i.topic }),
  categories: ["course_text"],
  intent: "cards",
});
const frame: CourseFrame = {
  courseId: "c-101",
  course: "Example 101",
  profile: "computing",
  skeleton: "Week 1: stacks. Week 2: queues.",
  policy: "AI help is allowed for practice.",
};
const passages: Passage[] = [{ sourceId: "r1", text: "A stack is a  last-in, first-out collection." }];
const good = { output: { cards: [{ front: "Stack?", back: "LIFO", sourceId: "r1", quote: "a last-in, first-out collection" }] } };
const invented = { output: { cards: [{ front: "Stack?", back: "LIFO", sourceId: "r1", quote: "stacks were invented in 1946" }] } };

async function setup(responses: unknown[], config = { dailyBackgroundTokens: 1_000_000 }, over: Partial<PackJobDeps> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "packs-"));
  const workDir = join(dir, "work");
  await mkdir(workDir);
  const logPath = join(dir, "log.jsonl");
  const env = { FAKE_CLI_LOG: logPath, FAKE_CLI_STATE: join(dir, "state"), FAKE_CLI_RESPONSES: JSON.stringify(responses) };
  const { runner, budget } = createPackRuntime(createClaudeBackend({ command: fake, workDir, env }), config);
  const deps: PackJobDeps = {
    runner,
    artifacts: memoryArtifactStore(),
    ledger: memoryLedgerStore(),
    authorize: () => ({ allowed: true, reason: "" }),
    ...over,
  };
  const calls = async () =>
    existsSync(logPath) ? (await readFile(logPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { argv: string[]; stdin: string }) : [];
  return { deps, budget, calls };
}

test("a pack schema must be strict-compatible: closed objects, every field required", () => {
  assert.throws(
    () =>
      definePack({ id: "loose", version: "v1", tier: "pass", system: "", template: () => "", schema: z.object({ a: z.string().optional() }), cacheKey: () => 1, categories: [] }),
    /must be \.strict\(\)|must be required/,
  );
});

test("the prompt prefix is byte-stable for a course (O8: system, skeleton and policy, question last)", async () => {
  const a = buildPrompt(pack, frame, { topic: "stacks" }, passages);
  const b = buildPrompt(pack, { ...frame, skeleton: frame.skeleton.replace(/\n/g, "\r\n") }, { topic: "queues" }, []);
  assert.equal(a.systemPrompt, b.systemPrompt);
  assert.ok(a.systemPrompt.indexOf("You write study cards") < a.systemPrompt.indexOf("Week 1") && a.systemPrompt.indexOf("Week 1") < a.systemPrompt.indexOf("AI help"));
  assert.ok(a.input.endsWith("Make cards on: stacks"));
  const other = buildPrompt(pack, { ...frame, courseId: "c-202", skeleton: "Week 1: graphs." }, { topic: "stacks" }, passages);
  assert.notEqual(other.systemPrompt, a.systemPrompt);

  const h = await setup([good]);
  await runPack(h.deps, pack, frame, { topic: "stacks" }, passages, { lane: "interactive" });
  await runPack(h.deps, pack, frame, { topic: "queues" }, passages, { lane: "interactive" });
  const [first, second] = await h.calls();
  const prefixOf = (argv: string[]) => argv[argv.indexOf("--system-prompt-file") + 1];
  assert.equal(prefixOf(first.argv), prefixOf(second.argv));
  assert.equal(await readFile(prefixOf(first.argv), "utf8"), a.systemPrompt);
  assert.match(first.stdin, /^\[ctx course="Example 101" profile=computing intent=cards pack=concept-cards\.v1 sources=r1\]/);
});

test("a cache hit spends no tokens and writes a zero-token ledger row", async () => {
  const h = await setup([good]);
  const first = await runPack(h.deps, pack, frame, { topic: "stacks" }, passages, { lane: "background" });
  const second = await runPack(h.deps, pack, frame, { topic: "stacks" }, passages, { lane: "background" });
  assert.equal(first.status, "done");
  assert.ok(second.status === "done" && second.cached);
  assert.equal((await h.calls()).length, 1);
  assert.equal(h.budget.state().spent, 120);
  const rows = h.deps.ledger.list({ courseId: "c-101" });
  assert.deepEqual(rows.map((r) => r.outcome), ["ok", "cache_hit"]);
  assert.deepEqual(rows[1].usage, { in: 0, cached: 0, out: 0 });
});

test("an invented quote is retried with the check error; a ledger row per call", async () => {
  const h = await setup([invented, good]);
  const r = await runPack(h.deps, pack, frame, { topic: "stacks" }, passages, { lane: "interactive" });
  assert.ok(r.status === "done" && r.artifact.verified);
  assert.equal(r.artifact.usage.in, 200);
  const calls = await h.calls();
  assert.match(calls[1].stdin, /quote not found verbatim in r1/);
  const rows = h.deps.ledger.list();
  assert.deepEqual(rows.map((x) => x.outcome), ["check_failed", "ok"]);
  assert.ok(rows.every((x) => x.courseId === "c-101" && x.cacheKey === r.artifact.cacheKey));
});

test("negative: retry → escalate → a student question; an invented quote is never stored", async () => {
  const h = await setup([invented]);
  const r = await runPack(h.deps, pack, frame, { topic: "stacks" }, passages, { lane: "interactive" });
  assert.equal(r.status, "needs_student");
  assert.ok(r.status === "needs_student" && r.options.includes("narrow_scope") && r.checkErrors[0].includes("verbatim"));
  assert.equal(h.deps.artifacts.list().length, 0);
  const calls = await h.calls();
  assert.deepEqual(calls.map((c) => c.argv[c.argv.indexOf("--model") + 1]), ["sonnet", "sonnet", "opus"]);
  assert.equal(h.deps.ledger.list().length, 3);
  assert.equal(readPackArtifact(h.deps.artifacts, pack, frame, { topic: "stacks" }, passages), null);
});

test("a usage limit pauses background work without retry; on-demand work tells the student", async () => {
  const h = await setup([{ error: "Claude usage limit reached" }]);
  const bg = await runPack(h.deps, pack, frame, { topic: "stacks" }, passages, { lane: "background" });
  assert.deepEqual([bg.status, bg.status === "paused" && bg.kind], ["paused", "usage_limit"]);
  const again = await runPack(h.deps, pack, frame, { topic: "queues" }, passages, { lane: "background" });
  assert.deepEqual([again.status, again.status === "paused" && again.kind], ["paused", "background_paused"]);
  assert.equal((await h.calls()).length, 1);
  const onDemand = await runPack(h.deps, pack, frame, { topic: "queues" }, passages, { lane: "interactive" });
  assert.ok(onDemand.status === "failed" && onDemand.kind === "usage_limit" && /usage limit/.test(onDemand.message));
  assert.equal((await h.calls()).length, 2);
});

test("the daily background budget from the configuration defers work before any call", async () => {
  const h = await setup([good], { dailyBackgroundTokens: 10 });
  const r = await runPack(h.deps, pack, frame, { topic: "stacks" }, passages, { lane: "background" });
  assert.ok(r.status === "paused" && r.kind === "budget_exhausted");
  assert.equal((await h.calls()).length, 0);
});

test("a refused egress decision blocks the call", async () => {
  const seen: [string, string[]][] = [];
  const h = await setup([good], undefined, {
    authorize: (recipient, categories) => (seen.push([recipient, categories]), { allowed: false, reason: "You have not agreed to share data with this service yet." }),
  });
  const r = await runPack(h.deps, pack, frame, { topic: "stacks" }, passages, { lane: "interactive" });
  assert.deepEqual(r, { status: "blocked", reason: "You have not agreed to share data with this service yet." });
  assert.deepEqual(seen, [["claude", ["course_text"]]]);
  assert.equal((await h.calls()).length, 0);
});

test("Jev gates flag an artifact unverified; without Jev they are skipped", async () => {
  const h = await setup([good], undefined, { jev: async (_g, items) => items.map((i) => ({ id: i.id, pass: false })) });
  const r = await runPack(h.deps, pack, frame, { topic: "stacks" }, passages, { lane: "interactive" });
  assert.ok(r.status === "done");
  assert.equal(r.artifact.verified, false);
  assert.deepEqual(r.artifact.gates, [{ id: "card-accuracy", status: "failed", failed: ["0"] }]);
  const g = await setup([good]);
  const s = await runPack(g.deps, pack, frame, { topic: "stacks" }, passages, { lane: "interactive" });
  assert.ok(s.status === "done" && s.artifact.verified && s.artifact.gates[0].status === "skipped");
});

test("study time reads stored artifacts and never calls a model (spec §2)", async () => {
  const h = await setup([good]);
  assert.equal(readPackArtifact(h.deps.artifacts, pack, frame, { topic: "stacks" }, passages), null);
  await runPack(h.deps, pack, frame, { topic: "stacks" }, passages, { lane: "background" });
  const before = (await h.calls()).length;
  const read = readPackArtifact(h.deps.artifacts, pack, frame, { topic: "stacks" }, passages);
  assert.equal(read?.output.cards[0].back, "LIFO");
  assert.equal((await h.calls()).length, before);
  assert.equal(readPackArtifact.length, 5);
});
