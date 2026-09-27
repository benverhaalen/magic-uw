import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  createClaudeBackend,
  createModelRunner,
  createSessionPool,
  RunnerError,
  type ActivityEvent,
  type CliCommand,
  type LedgerEntry,
} from "../packages/runner/src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fakeScript = join(here, "fixtures", "fake-cli", "fake-cli.mjs");
const fake: CliCommand = { file: process.execPath, prefixArgs: [fakeScript, "claude"] };
const card = z.object({ front: z.string().min(1), back: z.string().min(1) }).strict();
const answer = z.object({ text: z.string() }).strict();
const cards = { id: "cards", version: "v1" };
const chat = { id: "chat", version: "v2" };
const SYSTEM = "Role and synthetic course brief for Example 101.";

type Log = { argv: string[]; stdin: string | null; event?: string };
async function harness(responses: unknown[], extra: { rotateAtTokens?: number; maxLive?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pool-"));
  const workDir = join(dir, "work");
  await mkdir(workDir);
  const logPath = join(dir, "log.jsonl");
  const env = {
    FAKE_CLI_LOG: logPath,
    FAKE_CLI_STATE: join(dir, "state"),
    FAKE_CLI_RESPONSES: JSON.stringify(responses),
  };
  const fallback = createClaudeBackend({ command: fake, workDir, env });
  const pool = createSessionPool({ command: fake, workDir, env, fallback, kinds: { cards: card, chat: answer }, ...extra });
  const events: ActivityEvent[] = [];
  pool.onActivity((e) => events.push(e));
  const ledger: LedgerEntry[] = [];
  const runner = createModelRunner({ backend: pool, ledger: (e) => ledger.push(e) });
  const log = async (): Promise<Log[]> =>
    existsSync(logPath) ? (await readFile(logPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l)) : [];
  return { pool, runner, events, ledger, log, workDir };
}
const ok = (kind: string, data: unknown, usage?: unknown) => ({ output: { kind, data }, ...(usage ? { usage } : {}) });
const forbidden = ["--dangerously-skip-permissions", "--bare"];

test("a warm interactive lane answers follow-ups in one process, with the header and the union schema", async () => {
  const h = await harness([ok("chat", { text: "one" }), ok("chat", { text: "two" })]);
  try {
    const ask = { pack: chat, systemPrompt: SYSTEM, schema: answer, tier: "pass" as const, lane: "interactive" as const, courseId: "c1" };
    const a = await h.runner.run({ ...ask, input: "SYNTH-Q1", context: { course: "Example 101", intent: "chat", sources: ["r1"] } });
    const b = await h.runner.run({ ...ask, input: "SYNTH-Q2" });
    assert.equal(a.output.text, "one");
    assert.equal(b.output.text, "two");
    const log = await h.log();
    const spawns = log.filter((l) => l.event === "spawn");
    const messages = log.filter((l) => l.event === "message");
    assert.equal(spawns.length, 1);
    assert.equal(messages.length, 2);
    const argv = spawns[0].argv;
    const schema = JSON.parse(argv[argv.indexOf("--json-schema") + 1]);
    assert.deepEqual(schema.properties.kind.enum, ["cards", "chat"]);
    assert.deepEqual(schema.required, ["kind", "data"]);
    for (const flag of ["--input-format", "stream-json", "--verbose", "--strict-mcp-config", "--no-session-persistence"])
      assert.ok(argv.includes(flag));
    assert.equal(argv[argv.indexOf("--tools") + 1], "");
    assert.ok(!argv.some((x) => forbidden.includes(x) || x.includes("SYNTH-Q")));
    const prefix = await readFile(argv[argv.indexOf("--system-prompt-file") + 1], "utf8");
    assert.ok(prefix.startsWith(SYSTEM) && prefix.includes("[protocol]"));
    assert.equal(messages[0].stdin, '[ctx course="Example 101" intent=chat pack=chat.v2 sources=r1]\nSYNTH-Q1');
    assert.equal(messages[1].stdin, "[ctx pack=chat.v2]\nSYNTH-Q2");
    assert.deepEqual(
      h.events.map((e) => e.type),
      ["session_start", "ask_start", "ask_end", "ask_start", "ask_end"],
    );
    const end = h.events.find((e) => e.type === "ask_end");
    assert.ok(end && end.type === "ask_end" && end.usage.in === 100 && end.ms >= 0);
    assert.equal(h.pool.lanes()[0].lane, "interactive:c1");
  } finally {
    await h.pool.close();
  }
});

test("each course has its own interactive lane; a new batch rotates the background lane", async () => {
  const h = await harness([ok("chat", { text: "x" }), ok("chat", { text: "y" }), ok("cards", { front: "Q", back: "A" })]);
  try {
    const base = { systemPrompt: SYSTEM, tier: "pass" as const };
    await h.runner.run({ ...base, pack: chat, schema: answer, input: "a", lane: "interactive", courseId: "c1" });
    await h.runner.run({ ...base, pack: chat, schema: answer, input: "b", lane: "interactive", courseId: "c2" });
    await h.runner.run({ ...base, pack: cards, schema: card, input: "c", lane: "background" });
    h.pool.beginBatch();
    await h.runner.run({ ...base, pack: cards, schema: card, input: "d", lane: "background" });
    const log = await h.log();
    assert.equal(log.filter((l) => l.event === "spawn").length, 4);
    assert.ok(h.events.some((e) => e.type === "rotate" && e.reason === "batch"));
    assert.deepEqual(h.pool.lanes().map((l) => l.lane).sort(), ["background", "interactive:c1", "interactive:c2"]);
  } finally {
    await h.pool.close();
  }
});

test("past the history limit the next ask goes to a pre-warmed spare with the byte-identical prefix", async () => {
  const big = { input_tokens: 10, cache_read_input_tokens: 150, output_tokens: 20 };
  const h = await harness([ok("chat", { text: "1" }, big), ok("chat", { text: "2" })], { rotateAtTokens: 150 });
  try {
    const ask = { pack: chat, systemPrompt: SYSTEM, schema: answer, tier: "pass" as const, lane: "interactive" as const, courseId: "c1" };
    await h.runner.run({ ...ask, input: "first" });
    await h.runner.run({ ...ask, input: "second" });
    const log = await h.log();
    const spawns = log.filter((l) => l.event === "spawn");
    assert.equal(spawns.length, 2);
    assert.deepEqual(spawns[0].argv, spawns[1].argv);
    assert.ok(h.events.some((e) => e.type === "rotate" && e.reason === "history"));
    // The spare starts before the second ask; the second session is also near the limit, so
    // another spare is pre-warmed after it.
    const starts = h.events.filter((e) => e.type === "session_start" || e.type === "ask_start").map((e) => e.type);
    assert.deepEqual(starts.slice(0, 4), ["session_start", "ask_start", "session_start", "ask_start"]);
  } finally {
    await h.pool.close();
  }
});

test("a crashed session respawns; two consecutive failures fall back to one-shot calls", async () => {
  const h = await harness([{ crash: true }, ok("chat", { text: "after respawn" })]);
  try {
    const ask = { pack: chat, systemPrompt: SYSTEM, schema: answer, tier: "pass" as const, lane: "interactive" as const, courseId: "c1" };
    const r = await h.runner.run({ ...ask, input: "q" });
    assert.equal(r.output.text, "after respawn");
    assert.equal(h.pool.lanes()[0].failures, 0);
  } finally {
    await h.pool.close();
  }
  // The one-shot fallback gets the pack's own schema, so it answers without the union wrapper.
  const g = await harness([{ crash: true }, { crash: true }, { output: { text: "one-shot" } }]);
  try {
    const ask = { pack: chat, systemPrompt: SYSTEM, schema: answer, tier: "pass" as const, lane: "interactive" as const, courseId: "c1" };
    const r = await g.runner.run({ ...ask, input: "q" });
    assert.equal(r.output.text, "one-shot");
    const log = await g.log();
    const oneShot = log.filter((l) => !l.event);
    assert.equal(oneShot.length, 1);
    // client-detection: the one-shot streams (the tripwire reads it as it arrives).
    assert.deepEqual(oneShot[0].argv.slice(0, 4), ["-p", "--output-format", "stream-json", "--verbose"]);
    assert.ok(g.events.some((e) => e.type === "fallback" && e.reason === "failures"));
    assert.equal(g.pool.lanes()[0].oneShot, true);
  } finally {
    await g.pool.close();
  }
});

test("a wrong kind is a failed check the runner retries; unpooled packs go one-shot", async () => {
  const h = await harness([ok("cards", { front: "Q", back: "A" }), ok("chat", { text: "right" }), { output: { v: 1 } }]);
  try {
    const r = await h.runner.run({ pack: chat, systemPrompt: SYSTEM, schema: answer, tier: "pass", input: "q", lane: "interactive", courseId: "c1" });
    assert.equal(r.output.text, "right");
    assert.deepEqual(h.ledger.map((e) => e.outcome), ["check_failed", "ok"]);
    const other = z.object({ v: z.number() });
    const u = await h.runner.run({ pack: { id: "digest", version: "v1" }, systemPrompt: SYSTEM, schema: other, tier: "pass", input: "q" });
    assert.equal(u.output.v, 1);
    assert.ok(h.events.some((e) => e.type === "fallback" && e.reason === "not_pooled"));
  } finally {
    await h.pool.close();
  }
});

test("escalation runs on the strong model in its own session, closed after the ask", async () => {
  const h = await harness([ok("cards", { front: "", back: "A" }), ok("cards", { front: "", back: "A" }), ok("cards", { front: "Q", back: "A" })]);
  try {
    const r = await h.runner.run({ pack: cards, systemPrompt: SYSTEM, schema: card, tier: "pass", input: "q", lane: "background" });
    assert.equal(r.escalated, true);
    const spawns = (await h.log()).filter((l) => l.event === "spawn");
    assert.deepEqual(spawns.map((s) => s.argv[s.argv.indexOf("--model") + 1]), ["sonnet", "opus"]);
    const esc = h.pool.lanes().find((l) => l.lane === "escalation");
    assert.equal(esc?.session, null);
  } finally {
    await h.pool.close();
  }
});

test("a usage limit inside a warm session surfaces as usage_limit and keeps the session", async () => {
  const h = await harness([{ error: "You've hit your usage limit" }, ok("chat", { text: "later" })]);
  try {
    const ask = { pack: chat, systemPrompt: SYSTEM, schema: answer, tier: "pass" as const, lane: "interactive" as const, courseId: "c1", input: "q" };
    await assert.rejects(h.runner.run(ask), (e: unknown) => e instanceof RunnerError && e.kind === "usage_limit");
    await h.runner.run(ask);
    assert.equal((await h.log()).filter((l) => l.event === "spawn").length, 1);
  } finally {
    await h.pool.close();
  }
});
