// What the command bar's warm session pool sends, measured on the fake CLI (tokens = chars / 4):
// the pooled ask's prefix (system-prompt file + union schema) is byte-identical across asks and at
// least the model's prompt-cache minimum, with a course brief and without one.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createCore } from "@magic/core";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import type { IntentCommandResult } from "@magic/contracts";
import { CLAUDE_TIER_MODELS, createClaudeBackend, createModelRunner, createSessionPool, promptCacheMinimum, type CliCommand } from "../packages/runner/src/index";
import { askPack, classifyPack } from "../packages/packs/intent/src/index";
import { createIntentRouter } from "../packages/core/src/intent/index";
import { refersBack } from "../packages/core/src/intent/ask";
import { NOW, TZ, workspace } from "./intent-fixtures";

const here = dirname(fileURLToPath(import.meta.url));
const fake: CliCommand = { file: process.execPath, prefixArgs: [join(here, "fixtures", "fake-cli", "fake-cli.mjs"), "claude"] };
type Line = { argv: string[]; stdin: string | null; event?: string };

export async function pooledBar(responses: unknown[]) {
  const { store, batches } = workspace();
  const dir = await mkdtemp(join(tmpdir(), "pool-cost-"));
  const workDir = join(dir, "work");
  await mkdir(workDir);
  const log = join(dir, "log.jsonl");
  const env = { FAKE_CLI_LOG: log, FAKE_CLI_STATE: join(dir, "state"), FAKE_CLI_RESPONSES: JSON.stringify(responses) };
  // As apps/desktop/src/worker.ts wires the bar: one pool over classify and ask.
  const pool = createSessionPool({ command: fake, workDir, env, fallback: createClaudeBackend({ command: fake, workDir, env }), kinds: { [classifyPack.id]: classifyPack.schema, [askPack.id]: askPack.schema } });
  const live = new Set<string>();
  let exited: () => void = () => {};
  pool.onActivity((e) => {
    if (e.type === "session_start") live.add(e.session);
    if (e.type === "session_exit") {
      live.delete(e.session);
      if (!live.size) exited();
    }
  });
  const runner = createModelRunner({ backend: pool });
  const router = createIntentRouter({ store, runner: () => runner, now: () => NOW, timeZone: TZ });
  const core = createCore(store, { fixture: batches[0]!, now: () => NOW, timeZone: TZ, seams: { intent: router } });
  await core.execute({ type: "consent", value: { action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION } });
  const lines = async (): Promise<Line[]> => (existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Line) : []);
  const at = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1] ?? "";
  /** Each spawn's prefix (system-prompt file + schema) and each message's input, in log order. */
  const sent = async () =>
    (await lines())
      .filter((l) => l.event)
      .map((l) =>
        l.event === "spawn"
          ? { event: "spawn" as const, prefix: readFileSync(at(l.argv, "--system-prompt-file"), "utf8") + at(l.argv, "--json-schema") }
          : { event: "message" as const, input: l.stdin ?? "" },
      );
  const run = async (text: string, courseId?: string) =>
    (await core.execute({ type: "command", value: { text, ...(courseId ? { context: { courseId } } : {}) } })).command as IntentCommandResult;
  const close = async () => {
    const done = live.size ? new Promise<void>((resolve) => (exited = resolve)) : Promise.resolve();
    await pool.close();
    await done;
    await core.close();
    await rm(dir, { recursive: true, force: true });
  };
  const pid = (title: string) => {
    const r = store.resources().find((x) => x.title === title)!;
    return `p${store.passages(r.id)[0]!.pid}`;
  };
  return { store, run, sent, close, pid };
}
export const tokens = (s: string) => Math.ceil(s.length / 4);
export const pooledAsk = (sourceId: string, quote: string) => ({
  output: { kind: askPack.id, data: { found: true, sentences: [{ text: "From the course materials.", citations: [{ sourceId, quote }] }] } },
});

test("the pooled ask's prefix is byte-identical across asks and past the prompt-cache minimum, with a brief and without", { timeout: 60_000 }, async () => {
  const probe = await pooledBar([]);
  const recursion = probe.pid("Recursion notes");
  const demand = probe.pid("Supply and demand");
  await probe.close();
  const q = "Every recursive method needs a base case.";
  const d = "Demand curves slope downward because consumers buy more at lower prices.";
  const h = await pooledBar([pooledAsk(recursion, q), pooledAsk(recursion, q), pooledAsk(demand, d), pooledAsk(demand, d)]);
  try {
    // COMPSCI 400 has a syllabus (a course brief); ECON 101 has none (the pack catalogue alone).
    for (const text of ["what does every recursive method need", "why does recursion need a base case"]) assert.equal((await h.run(text, "c400")).status, "answer", text);
    for (const text of ["why do demand curves slope downward", "what do consumers buy at lower prices"]) assert.equal((await h.run(text, "c101")).status, "answer", text);
    const spawns = (await h.sent()).flatMap((e) => (e.event === "spawn" ? [e.prefix] : []));
    const byCourse = new Map<string, Set<string>>();
    for (const p of spawns) {
      const course = p.includes("COMPSCI400") ? "c400" : "other";
      byCourse.set(course, (byCourse.get(course) ?? new Set()).add(p));
    }
    const minimum = promptCacheMinimum(CLAUDE_TIER_MODELS[askPack.tier]);
    assert.equal(minimum, 1024, "Sonnet 5 (the pass tier's `sonnet`) caches from 1,024 tokens");
    assert.equal(byCourse.get("c400")?.size, 1, "one byte-identical prefix for every COMPSCI 400 ask");
    assert.equal(byCourse.get("other")?.size, 1, "one byte-identical prefix for a course with no brief");
    for (const [course, set] of byCourse) {
      const prefix = [...set][0]!;
      assert.ok(tokens(prefix) >= minimum, `${course}: pooled prefix ${tokens(prefix)} tokens < ${minimum}`);
    }
    assert.ok([...byCourse.get("c400")!][0]!.includes("# COMPSCI400"), "the course brief is in the prefix");
  } finally {
    await h.close();
  }
});

/** Per turn: what the CLI bills as input. A session re-sends its whole conversation, so a turn costs its session's prefix, every earlier message and reply in it, and its own message. */
async function turns(h: Awaited<ReturnType<typeof pooledBar>>, replyTokens: number) {
  let prefix = 0;
  let history = 0;
  const out: { spawned: boolean; history: number; message: number; billed: number; input: string }[] = [];
  let spawned = false;
  for (const e of await h.sent()) {
    if (e.event === "spawn") {
      prefix = tokens(e.prefix);
      history = 0;
      spawned = true;
      continue;
    }
    const message = tokens(e.input);
    out.push({ spawned, history, message, billed: prefix + history + message, input: e.input });
    history += message + replyTokens;
    spawned = false;
  }
  return out;
}

test("a burst of asks: every turn sends its question and passages only, so input doesn't grow past turn 2", { timeout: 60_000 }, async () => {
  const probe = await pooledBar([]);
  const recursion = probe.pid("Recursion notes");
  await probe.close();
  const q = "Every recursive method needs a base case.";
  const reply = pooledAsk(recursion, q);
  const h = await pooledBar([reply]);
  try {
    const burst = [
      "what does every recursive method need in recursion",
      "how does recursion solve a problem with smaller instances",
      "what are smaller instances of the same problem",
      "why does every recursive method need a base case",
      "explain the base case in recursion",
    ];
    for (const text of burst) assert.equal((await h.run(text, "c400")).status, "answer", text);
    const t = await turns(h, tokens(JSON.stringify(reply.output)));
    assert.equal(t.length, burst.length);
    for (const [i, x] of t.entries()) assert.equal(x.history, 0, `turn ${i + 1} carries ${x.history} tokens of earlier turns`);
    const second = t[1]!.billed;
    for (const [i, x] of t.slice(2).entries()) assert.ok(x.billed <= second, `turn ${i + 3}: ${x.billed} > turn 2's ${second}`);
  } finally {
    await h.close();
  }
});

test("a question that refers back carries only the last exchange", { timeout: 60_000 }, async () => {
  const probe = await pooledBar([]);
  const recursion = probe.pid("Recursion notes");
  await probe.close();
  const h = await pooledBar([pooledAsk(recursion, "Every recursive method needs a base case.")]);
  try {
    await h.run("what does every recursive method need", "c400");
    await h.run("how does recursion solve a problem", "c400");
    await h.run("why does it need one", "c400");
    const messages = (await h.sent()).flatMap((e) => (e.event === "message" ? [e.input] : []));
    assert.equal(messages.length, 3);
    assert.ok(!messages[0]!.includes("Earlier exchange") && !messages[1]!.includes("Earlier exchange"), "a question naming its subject carries no earlier turn");
    assert.ok(messages[2]!.includes("Earlier exchange"), "a back-reference carries the last exchange");
    assert.ok(messages[2]!.includes("how does recursion solve a problem"), "the last exchange");
    assert.ok(!messages[2]!.includes("what does every recursive method need"), "never an older one");
  } finally {
    await h.close();
  }
});

test("refersBack: a back-reference before the question's own subject", () => {
  for (const q of ["why does it resize?", "explain that more simply", "what's on it", "tell me more about those", "and what does that mean"]) assert.equal(refersBack(q), true, q);
  for (const q of ["when and where is the midterm, and what's on it", "explain the load factor from lecture", "what is a hash table", "how is the final weighted and is it cumulative"]) assert.equal(refersBack(q), false, q);
});
