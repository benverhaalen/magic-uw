// The connected agent's launch lifecycle over the real session pool (fake Claude CLI processes): the launch
// warm starts one planner session with the exact prefix the first spoken call uses; that call is served by
// the same process (no second spawn); each run's session ends with it and a fresh one is started; repeated
// activations never add processes; provider/consent changes tear down; Codex is never reported warm.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClaudeBackend, createModelRunner, createSessionPool, type ActivityEvent, type CliCommand, type SessionPool } from "../packages/runner/src/index";
import { askPack, classifyPack } from "../packages/packs/intent/src/index";
import { plannerPack } from "../packages/packs/intent/src/planner";
import { memoryArtifactStore, memoryLedgerStore } from "../packages/packs/core/src/index";
import { plannerWarmRequest, runPlanner, type ObservedExecutor } from "../packages/core/src/intent/planner";
import { createAgentWarmup, type AgentReadiness } from "../apps/desktop/src/voice/agent-warmup";
import { createCore } from "@magic/core";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import { NOW, TZ, workspace } from "./intent-fixtures";

const here = dirname(fileURLToPath(import.meta.url));
const fake: CliCommand = { file: process.execPath, prefixArgs: [join(here, "fixtures", "fake-cli", "fake-cli.mjs"), "claude"] };
const reply = (kind: string, say: string) => ({ output: { kind: "intent-plan", data: { kind, say, goal: null, question: null, destinations: null } } });
const executor: ObservedExecutor = { observe: async () => ({ status: "unknown", at: NOW.toISOString(), note: "no browser in this test" }), act: async () => ({ status: "stopped" }) };
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

async function setup(responses: unknown[] = [reply("reply", "Hi.")]) {
  const { store, batches } = workspace();
  await createCore(store, { fixture: batches[0]!, now: () => NOW, timeZone: TZ }).execute({ type: "consent", value: { action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION } });
  const dir = await mkdtemp(join(tmpdir(), "voice-agent-"));
  const workDir = join(dir, "work");
  await mkdir(workDir);
  const log = join(dir, "log.jsonl");
  const env = { FAKE_CLI_LOG: log, FAKE_CLI_STATE: join(dir, "state"), FAKE_CLI_RESPONSES: JSON.stringify(responses) };
  // The worker's pool: classify, ask and (now) the planner.
  const pool = createSessionPool({ command: fake, workDir, env, fallback: createClaudeBackend({ command: fake, workDir, env }), kinds: { [plannerPack.id]: plannerPack.schema }, maxLive: 2, turns: "conversation" }); // the worker's voice pool
  const events: ActivityEvent[] = [];
  pool.onActivity((e) => events.push(e));
  const runner = createModelRunner({ backend: pool });
  const entries = async () => (existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { event?: string; argv: string[]; stdin: string | null }) : []);
  // Processes as the pool started them (a session killed within ~100 ms exits before the fake CLI logs).
  const spawns = async () => events.filter((e) => e.type === "session_start");
  return { store, pool, runner, events, entries, spawns };
}

function lifecycle(h: { store: ReturnType<typeof workspace>["store"]; pool: SessionPool }, o: { chosen?: () => { id: string; key: string } | null; pool?: () => SessionPool | null; consented?: () => boolean; fail?: () => boolean; settleMs?: number } = {}) {
  const statuses: AgentReadiness[] = [];
  let runtimeCalls = 0;
  const warmup = createAgentWarmup({
    chosen: async () => (o.chosen ? o.chosen() : { id: "claude", key: "claude:instant" }),
    runtime: async () => (runtimeCalls++, o.fail?.() ? null : { client: "claude:instant", pool: o.pool ? o.pool() : h.pool }),
    consented: () => o.consented?.() ?? true,
    warmRequest: () => plannerWarmRequest(h.store, { route: "home" }, NOW),
    onStatus: (s) => statuses.push(s),
    settleMs: o.settleMs ?? 200,
  });
  return { warmup, statuses, runtimeCalls: () => runtimeCalls };
}

test("launch warm: one planner session with the first call's exact prefix; the first spoken call uses that process", { timeout: 60_000 }, async (t) => {
  const h = await setup([reply("reply", "Calendar is open.")]);
  t.after(() => h.pool.close());
  const { warmup, statuses } = lifecycle(h);
  const ready = await warmup.start();
  assert.equal(ready.state, "ready", JSON.stringify(ready));
  assert.equal(ready.state === "ready" && ready.lane, "interactive:voice:all");
  assert.equal(typeof (ready.state === "ready" && ready.pid), "number", "a real OS process id");
  assert.deepEqual(statuses.map((s) => s.state), ["starting", "starting", "ready"], "starting (spawned, with its pid) until the process outlives start-up");
  await settle();
  assert.equal((await h.spawns()).length, 1);
  assert.equal((await h.entries()).filter((e) => e.event === "message").length, 0, "the warm sends nothing (0 tokens)");

  const result = await runPlanner(
    { store: h.store, runner: async () => h.runner, artifacts: memoryArtifactStore(), ledger: memoryLedgerStore(), now: () => NOW, executor, current: () => true },
    { runId: "r1", utterance: "Hello", origin: { route: "home" } },
    new AbortController().signal,
  );
  assert.equal(result.status, "reply");
  const log = await h.entries();
  assert.equal((await h.spawns()).length, 1, "no second process for the first spoken call");
  assert.equal(log.filter((e) => e.event === "message").length, 1);
  const asks = h.events.filter((e) => e.type === "ask_start");
  const started = h.events.filter((e) => e.type === "session_start");
  assert.equal(started.length, 1);
  assert.equal(asks[0]!.type === "ask_start" && asks[0]!.session, started[0]!.type === "session_start" && started[0]!.session, "served by the launch session");
  assert.ok(!h.events.some((e) => e.type === "rotate" || e.type === "fallback"), "no prefix rotation, no one-shot fallback");
});

test("repeated voice activations and a concurrent start never add a process", { timeout: 60_000 }, async (t) => {
  const h = await setup();
  t.after(() => h.pool.close());
  const { warmup } = lifecycle(h);
  await Promise.all([warmup.start(), warmup.start(), warmup.start()]);
  await warmup.start();
  await warmup.start();
  await settle();
  assert.equal((await h.spawns()).length, 1);
  assert.equal(h.pool.lanes().filter((l) => l.session).length, 1);
});

test("after a run, its session ends and a fresh launch session starts: the next request carries no earlier page text", { timeout: 60_000 }, async (t) => {
  const h = await setup([reply("reply", "One."), reply("reply", "Two.")]);
  t.after(() => h.pool.close());
  const { warmup } = lifecycle(h);
  const first = await warmup.start();
  const deps = { store: h.store, runner: async () => h.runner, artifacts: memoryArtifactStore(), ledger: memoryLedgerStore(), now: () => NOW, executor, current: () => true };
  await runPlanner(deps, { runId: "r1", utterance: "PRIVATE-PAGE-TEXT-ONE", origin: { route: "home" } }, new AbortController().signal);
  await warmup.afterRun(plannerWarmRequest(h.store, { route: "home" }, NOW));
  const second = warmup.status();
  assert.equal(second.state, "ready");
  assert.notEqual(second.state === "ready" && second.session, first.state === "ready" && first.session, "a new session");
  assert.notEqual(second.state === "ready" && second.pid, first.state === "ready" && first.pid, "a new process");
  await runPlanner(deps, { runId: "r2", utterance: "Second request", origin: { route: "home" } }, new AbortController().signal);
  await settle();
  const log = await h.entries();
  const messages = log.filter((e) => e.event === "message");
  assert.equal(messages.length, 2);
  // The second request was served by the second process, which never received the first request.
  assert.equal((await h.spawns()).length, 2);
  const asks = h.events.filter((e) => e.type === "ask_start").map((e) => e.type === "ask_start" && e.session);
  assert.deepEqual(asks, [first.state === "ready" && first.session, second.state === "ready" && second.session]);
  assert.ok(!messages[1]!.stdin!.includes("PRIVATE-PAGE-TEXT-ONE"));
  assert.equal(h.pool.lanes().find((l) => l.lane === "interactive:voice:all")?.session !== null, true);
});

test("provider change, consent withdrawal or no provider: the warm session is torn down; no spawn without permission", { timeout: 60_000 }, async (t) => {
  const h = await setup();
  t.after(() => h.pool.close());
  let chosen: { id: string; key: string } | null = { id: "claude", key: "claude:instant" };
  let consent = true;
  const { warmup, statuses } = lifecycle(h, { chosen: () => chosen, consented: () => consent });
  await warmup.start();
  const pid = h.pool.lanes()[0]!.pid!;
  consent = false;
  const refused = await warmup.refresh();
  assert.equal(refused.state, "needs_permission");
  assert.equal(h.pool.lanes().find((l) => l.lane === "interactive:voice:all")?.session ?? null, null, "the session ended");
  await settle(300);
  assert.throws(() => process.kill(pid, 0), "the launch process exited");
  consent = true;
  chosen = null;
  assert.equal((await warmup.refresh()).state, "none");
  await settle();
  assert.equal((await h.spawns()).length, 1, "no spawn while unpermitted or unconfigured");
  chosen = { id: "claude", key: "claude:instant" };
  assert.equal((await warmup.refresh()).state, "ready");
  assert.equal((await h.spawns()).length, 2);
  assert.ok(statuses.some((s) => s.state === "needs_permission") && statuses.some((s) => s.state === "none"));
});

test("Codex (no persistent transport) is reported per request, never warm; a failed start is truthful and retries on the next activation", async () => {
  const { store } = workspace();
  const codex = createAgentWarmup({
    chosen: async () => ({ id: "codex", key: "codex:instant" }),
    runtime: async () => ({ client: "codex:instant", pool: null }),
    consented: () => true,
    warmRequest: () => plannerWarmRequest(store, { route: "home" }, NOW),
    onStatus: () => {},
  });
  const s = await codex.start();
  assert.equal(s.state, "per_request");
  assert.equal(s.state === "per_request" && s.transport, "one_shot");
  assert.match(s.state === "per_request" ? s.reason : "", /Each request starts it fresh/);

  let fail = true;
  const h = await setup();
  const { warmup, runtimeCalls } = lifecycle(h, { fail: () => fail });
  const failed = await warmup.start();
  assert.equal(failed.state, "failed");
  assert.match(failed.state === "failed" ? failed.reason : "", /couldn't start Claude Code/);
  fail = false;
  assert.equal((await warmup.start()).state, "ready", "the next activation retries");
  assert.equal(runtimeCalls(), 2);
  await warmup.close();
  assert.equal(h.pool.lanes().find((l) => l.lane === "interactive:voice:all")?.session ?? null, null, "app exit ends the session");
  await h.pool.close();
});

test("a session that exits during start-up is reported failed, not ready", { timeout: 60_000 }, async (t) => {
  const h = await setup();
  t.after(() => h.pool.close());
  const { warmup } = lifecycle(h, { settleMs: 400 });
  const pending = warmup.start();
  await settle(100);
  const pid = h.pool.lanes()[0]!.pid!;
  process.kill(pid, "SIGKILL");
  const s = await pending;
  assert.equal(s.state, "failed", JSON.stringify(s));
  assert.match(s.state === "failed" ? s.reason : "", /stopped while starting/);
});

test("the planner pack is poolable and its launch prefix is the first call's prefix for Home", () => {
  const { store } = workspace();
  const a = plannerWarmRequest(store, { route: "home" }, NOW);
  const b = plannerWarmRequest(store, { route: "calendar" }, NOW);
  assert.equal(a.systemPrompt, b.systemPrompt, "any page without an open item shares the launch session");
  assert.equal(a.courseId, "voice:all");
  assert.equal(a.pack.id, "intent-plan");
});
