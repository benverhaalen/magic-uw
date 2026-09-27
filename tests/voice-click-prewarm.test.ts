// A mic click passes the page the student has open (ids only) through renderer → preload bridge → main, and
// the connected agent's planner session for that page starts while the microphone does. Measured here over
// the real session pool with fake Claude CLI processes that take FAKE_CLI_START_MS to start, standing in for
// the real CLI's ~1.1–1.3 s local start-up (HANDOFF "Benchmark"). All timings are synthetic; no real CLI,
// microphone, Electron or browser runs.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClaudeBackend, createModelRunner, createSessionPool, type ActivityEvent, type CliCommand, type SessionPool } from "../packages/runner/src/index";
import { plannerPack } from "../packages/packs/intent/src/planner";
import { memoryArtifactStore, memoryLedgerStore } from "../packages/packs/core/src/index";
import { plannerOrigin, plannerWarmRequest, runPlanner, type ObservedExecutor } from "../packages/core/src/intent/planner";
import { createAgentWarmup } from "../apps/desktop/src/voice/agent-warmup";
import { createConnectedVoiceDispatch } from "../apps/desktop/src/voice/connected-dispatch";
import { createVoiceBridge } from "../apps/desktop/src/voice/bridge";
import { isRequestContext } from "../apps/desktop/src/voice/policy";
import { VoiceMicrophone, type MicrophoneEnvironment } from "../apps/desktop/src/renderer/voice/microphone";
import type { VoiceBridge, VoiceRequestContext, VoiceState } from "../apps/desktop/src/voice/types";
import type { IntentCommandResult } from "@magic/contracts";
import { createCore } from "@magic/core";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import { NOW, TZ, workspace } from "./intent-fixtures";

const here = dirname(fileURLToPath(import.meta.url));
const fake: CliCommand = { file: process.execPath, prefixArgs: [join(here, "fixtures", "fake-cli", "fake-cli.mjs"), "claude"] };
const START_MS = 400;
const plan = (kind: string, say: string, goal: string | null = null) => ({ output: { kind: "intent-plan", data: { kind, say, goal, question: null, destinations: null } } });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const idle: ObservedExecutor = { observe: async () => ({ status: "unknown", at: NOW.toISOString(), note: "no browser in this test" }), act: async () => ({ status: "stopped" }) };

async function setup(responses: unknown[]) {
  const { store, batches } = workspace();
  await createCore(store, { fixture: batches[0]!, now: () => NOW, timeZone: TZ }).execute({ type: "consent", value: { action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION } });
  const dir = await mkdtemp(join(tmpdir(), "voice-click-"));
  const workDir = join(dir, "work");
  await mkdir(workDir);
  const log = join(dir, "log.jsonl");
  const env = { FAKE_CLI_LOG: log, FAKE_CLI_STATE: join(dir, "state"), FAKE_CLI_RESPONSES: JSON.stringify(responses), FAKE_CLI_START_MS: String(START_MS) };
  // The worker's voice pool, as `intentRunner` builds it for Claude.
  const pool = createSessionPool({ command: fake, workDir, env, fallback: createClaudeBackend({ command: fake, workDir, env }), kinds: { [plannerPack.id]: plannerPack.schema }, maxLive: 2, turns: "conversation" });
  const events: ActivityEvent[] = [];
  pool.onActivity((e) => events.push(e));
  const runner = createModelRunner({ backend: pool });
  const messages = async () => (existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.event === "message").length : 0);
  const spawnsOn = (lane: string) => events.filter((e) => e.type === "session_start" && e.lane === lane).length;
  return { store, pool, runner, events, messages, spawnsOn };
}

function lifecycle(h: { store: ReturnType<typeof workspace>["store"]; pool: SessionPool }, o: { pool?: SessionPool | null; consented?: () => boolean } = {}) {
  return createAgentWarmup({
    chosen: async () => ({ id: "claude", key: "claude:instant" }),
    runtime: async () => ({ client: "claude:instant", pool: o.pool === undefined ? h.pool : o.pool }),
    consented: () => o.consented?.() ?? true,
    warmRequest: () => plannerWarmRequest(h.store, { route: "home" }, NOW),
    onStatus: () => {},
    settleMs: 50,
  });
}
/** What the worker does with a click's context (`voiceFocus`): the planner's first-call prefix for that page. */
const clickRequest = (store: ReturnType<typeof workspace>["store"], context: VoiceRequestContext) => plannerWarmRequest(store, plannerOrigin(store, context), NOW);

/** Speech-final → the planner's first observed action, through runPlanner on the voice pool. */
async function firstAction(h: Awaited<ReturnType<typeof setup>>, context: VoiceRequestContext, utterance: string) {
  let acted = 0;
  const t0 = performance.now();
  const executor: ObservedExecutor = {
    observe: async () => ({ status: "observed", at: NOW.toISOString(), browser: { url: "https://example.org/", title: "Example" } }),
    act: async () => { acted ||= performance.now() - t0; return { status: "done", action: "open https://example.org/next", observed: { status: "observed", at: NOW.toISOString() } }; },
  };
  const result = await runPlanner(
    { store: h.store, runner: async () => h.runner, artifacts: memoryArtifactStore(), ledger: memoryLedgerStore(), now: () => NOW, executor, current: () => true, maxSteps: 2 },
    { runId: `r-${Math.random()}`, utterance, origin: plannerOrigin(h.store, context) },
    new AbortController().signal,
  );
  return { firstActionMs: Math.round(acted), result };
}

test("the click's page reaches main: microphone → preload bridge channel, and main accepts only the page's ids", async () => {
  const invoked: unknown[][] = [];
  const bridge = createVoiceBridge({ invoke: async (...args: unknown[]) => (invoked.push(args), { phase: "idle", token: null }), on: () => {}, removeListener: () => {} } as never);
  await bridge.start({ view: "courses", courseId: "c400" });
  await bridge.start();
  assert.deepEqual(invoked, [["magic:voice-start", { view: "courses", courseId: "c400" }], ["magic:voice-start", null]]);
  assert.equal(isRequestContext({ view: "resource", courseId: "c400", resourceId: "r1" }), true);
  assert.equal(isRequestContext({ courseId: "c400", accountScope: "someone-else" }), false, "strict: no account or other fields from the renderer");
  assert.equal(isRequestContext(null), false);

  // The microphone controller hands the click's page to start, before (and without waiting for) capture.
  const starts: (VoiceRequestContext | undefined)[] = [];
  let media = 0;
  const fakeBridge = { start: async (page?: VoiceRequestContext): Promise<VoiceState> => (starts.push(page), { phase: "idle", token: null }), onEvent: () => () => {} } as unknown as VoiceBridge;
  const mic = new VoiceMicrophone(fakeBridge, () => {}, () => {}, { getUserMedia: async () => (media++, null) } as unknown as MicrophoneEnvironment);
  await mic.start({ view: "resource", courseId: "c400", resourceId: "r1" });
  assert.deepEqual(starts, [{ view: "resource", courseId: "c400", resourceId: "r1" }]);
  assert.equal(media, 0, "an idle (refused) start never opens the microphone");
});

test("a click on a course page warms that page's planner session; the first spoken call uses it (no second spawn, 0 tokens before)", { timeout: 60_000 }, async (t) => {
  const h = await setup([plan("reply", "Homework 3 is due Tuesday.")]);
  t.after(() => h.pool.close());
  const warmup = lifecycle(h);
  const context = { view: "courses", courseId: "c400" };
  const request = clickRequest(h.store, context);
  assert.equal(request.courseId, "voice::c400", "a course lane, apart from Home's voice:all");
  const clicked = performance.now();
  assert.equal(await warmup.focus(request), "warm");
  const warmReadyMs = Math.round(performance.now() - clicked);
  assert.equal(h.spawnsOn("interactive:voice::c400"), 1);
  assert.equal(h.spawnsOn("interactive:voice:all"), 1, "the launch (Home) session also started, once");
  assert.equal(await h.messages(), 0, "warming sends nothing");
  const again = await warmup.focus(request);
  assert.equal(again, "reused", "a second click on the same page adds no process");
  await wait(START_MS + 50); // the student speaks for longer than the CLI's start-up
  await runPlanner(
    { store: h.store, runner: async () => h.runner, artifacts: memoryArtifactStore(), ledger: memoryLedgerStore(), now: () => NOW, executor: idle, current: () => true },
    { runId: "r1", utterance: "When is homework 3 due?", origin: plannerOrigin(h.store, context) },
    new AbortController().signal,
  );
  assert.equal(h.spawnsOn("interactive:voice::c400"), 1, "the first spoken call was served by the warmed process");
  t.diagnostic(`click → focus resolved (process spawned, not yet settled): ${warmReadyMs} ms`);
});

test("speech-final → first observed action: cold vs warmed at the click (synthetic, fake CLI start-up " + START_MS + " ms)", { timeout: 90_000 }, async (t) => {
  const context = { view: "courses", courseId: "c400" };
  const rows: { path: string; firstActionMs: number }[] = [];
  for (let round = 0; round < 3; round++) {
    const cold = await setup([plan("act", "Opening.", "open the course site"), plan("done", "Done.")]);
    rows.push({ path: "cold", ...(await firstAction(cold, context, "open the course site")) });
    await cold.pool.close();
    const warm = await setup([plan("act", "Opening.", "open the course site"), plan("done", "Done.")]);
    const warmup = lifecycle(warm);
    void warmup.focus(clickRequest(warm.store, context)); // the click: fire-and-forget, as main posts it
    await wait(START_MS + 100); // speaking
    rows.push({ path: "warm", ...(await firstAction(warm, context, "open the course site")) });
    assert.equal(warm.spawnsOn("interactive:voice::c400"), 1);
    await warm.pool.close();
  }
  const median = (p: string) => rows.filter((r) => r.path === p).map((r) => r.firstActionMs).sort((a, b) => a - b)[1]!;
  t.diagnostic(`synthetic speech-final→first action (ms): ${JSON.stringify(rows.map((r) => [r.path, r.firstActionMs]))}; median cold ${median("cold")}, warm ${median("warm")}`);
  assert.ok(median("cold") - median("warm") >= START_MS * 0.6, "the warmed path skips the CLI start-up");
});

test("an open item: the warm prefix matches only a request whose task mode is unclear; a concept question starts its own session", { timeout: 60_000 }, async (t) => {
  const h = await setup([plan("reply", "OK.")]);
  t.after(() => h.pool.close());
  const item = h.store.resources().find((r) => r.title === "Homework 3")!;
  const context = { view: "resource", courseId: "c400", resourceId: item.id };
  const warmup = lifecycle(h);
  assert.equal(await warmup.focus(clickRequest(h.store, context)), "warm");
  const lane = clickRequest(h.store, context).courseId!;
  const say = (utterance: string) => runPlanner(
    { store: h.store, runner: async () => h.runner, artifacts: memoryArtifactStore(), ledger: memoryLedgerStore(), now: () => NOW, executor: idle, current: () => true },
    { runId: `r-${utterance}`, utterance, origin: plannerOrigin(h.store, context) },
    new AbortController().signal,
  );
  await say("open the rubric page");
  assert.equal(h.spawnsOn(`interactive:${lane}`), 1, "navigation-shaped (unclear task mode): the warmed prefix");
  await say("explain what a base case is");
  assert.equal(h.spawnsOn(`interactive:${lane}`), 2, "concept mode changes the policy text in the prefix: a new session");
  t.diagnostic("item pages: warm hit only for unclear-mode requests (the policy's task mode is in the planner prefix)");
});

test("Stop releases the page's session; the launch session stays. A newer page replaces an older one", { timeout: 60_000 }, async (t) => {
  const h = await setup([plan("reply", "OK.")]);
  t.after(() => h.pool.close());
  const warmup = lifecycle(h);
  await warmup.focus(clickRequest(h.store, { view: "courses", courseId: "c400" }));
  const live = () => h.pool.lanes().filter((l) => l.session).map((l) => l.lane).sort();
  assert.deepEqual(live(), ["interactive:voice::c400", "interactive:voice:all"]);
  await warmup.focus(clickRequest(h.store, { view: "courses", courseId: "c101" }));
  assert.deepEqual(live(), ["interactive:voice::c101", "interactive:voice:all"], "one page session at a time");
  await warmup.release();
  assert.deepEqual(live(), ["interactive:voice:all"]);
  // Home is the launch lane: a click there reuses it and release never ends it.
  assert.equal(await warmup.focus(clickRequest(h.store, { view: "today" })), "reused");
  await warmup.release();
  assert.deepEqual(live(), ["interactive:voice:all"]);
});

test("a provider/account/consent change or app exit during the click's warm leaves no page session", { timeout: 60_000 }, async (t) => {
  const h = await setup([plan("reply", "OK.")]);
  t.after(() => h.pool.close());
  const warmup = lifecycle(h);
  await warmup.start();
  const pending = warmup.focus(clickRequest(h.store, { view: "courses", courseId: "c400" }));
  await warmup.refresh(); // what main's refreshVoiceAgent posts on a provider, account or consent change
  assert.equal(await pending, "skipped");
  await wait(50);
  assert.equal(h.pool.lanes().some((l) => l.lane === "interactive:voice::c400" && l.session), false);
  await warmup.focus(clickRequest(h.store, { view: "courses", courseId: "c101" }));
  await warmup.close();
  assert.equal(h.pool.lanes().some((l) => l.session), false, "exit ends every voice session");
});

test("after a run on the page's session, it ends (no carry-over) and a fresh one starts while the mic stays on", { timeout: 60_000 }, async (t) => {
  const h = await setup([plan("reply", "OK.")]);
  t.after(() => h.pool.close());
  const warmup = lifecycle(h);
  const request = clickRequest(h.store, { view: "courses", courseId: "c400" });
  await warmup.focus(request);
  await warmup.afterRun(request);
  assert.equal(h.spawnsOn("interactive:voice::c400"), 2, "a new process for the next utterance");
  await warmup.release();
  await warmup.afterRun(request);
  assert.equal(h.spawnsOn("interactive:voice::c400"), 2, "after Stop nothing is re-warmed");
});

test("Codex (no pool) stays per request and nothing is spawned; without consent nothing is warmed", async () => {
  const h = await setup([plan("reply", "OK.")]);
  try {
    assert.equal(await lifecycle(h, { pool: null }).focus(clickRequest(h.store, { view: "courses", courseId: "c400" })), "per_request");
    assert.equal(await lifecycle(h, { consented: () => false }).focus(clickRequest(h.store, { view: "courses", courseId: "c400" })), "skipped");
    assert.equal(h.events.filter((e) => e.type === "session_start").length, 0);
  } finally {
    await h.pool.close();
  }
});

// ---- The final transcript's route (createConnectedVoiceDispatch as main composes it) ----
const zero = { in: 0, cached: 0, out: 0 };
const ran = (action: string): IntentCommandResult => ({ status: "ran", action, args: {}, result: {}, path: "code", latencyMs: 0, tokens: zero });
function dispatch(o: { trialRuns?: boolean; code?: boolean; capability?: boolean; answer?: IntentCommandResult }) {
  const calls: string[] = [];
  const d = createConnectedVoiceDispatch({
    trial: async () => (calls.push("trial"), o.trialRuns ? ran("page.open") : { status: "unavailable", reason: "Trial only.", path: "none", latencyMs: 0, tokens: zero }),
    capability: async () => (calls.push("capability"), o.capability === false ? { ok: false, reason: "Spoken browser actions need Jev." } : { ok: true, jev: true, computerUse: { bound: false, code: "x", blocker: "y" } }),
    plan: async () => (calls.push("plan"), { status: "done", say: "Done.", runId: "r", policy: "", steps: [], receiptIds: [] } as never),
    ask: async () => { throw new Error("no ask"); },
    interactive: {
      code: async () => (calls.push("code"), !!o.code),
      run: async () => (calls.push("interactive"), o.answer ?? ran("course.open")),
    },
  });
  return { d, calls };
}
const op = () => ({ operationId: "o", signal: new AbortController().signal, current: () => true });

test("final transcript: a code-placed request runs on the interactive dispatch at once; the planner is not asked", async () => {
  const { d, calls } = dispatch({ code: true });
  const t0 = performance.now();
  const r = await d("open programming three", { courseId: "c400" }, op());
  assert.equal(r.status === "ran" && r.action, "course.open");
  assert.deepEqual(calls, ["trial", "code", "interactive"]);
  assert.ok(performance.now() - t0 < 50);
});

test("final transcript: a code miss goes to the planner (Jev fast path and computer-use fallback), with no classify call in front", async () => {
  const { d, calls } = dispatch({ code: false });
  const r = await d("open wikipedia and find apollo 11", {}, op());
  assert.equal(r.status, "ran");
  assert.deepEqual(calls, ["trial", "code", "capability", "plan"]);
});

test("final transcript without the action capability uses the interactive dispatch, not the regex trial, and keeps the reason", async () => {
  const { d, calls } = dispatch({ code: false, capability: false, answer: { status: "unavailable", reason: "I couldn't place that.", path: "ai", latencyMs: 0, tokens: zero } });
  const r = await d("what's due this week in econ", {}, op());
  assert.deepEqual(calls, ["trial", "code", "capability", "interactive"]);
  assert.equal(r.status === "unavailable" && r.reason, "Spoken browser actions need Jev. I couldn't place that.");
  const trial = dispatch({ trialRuns: true, code: true });
  await trial.d("open calendar", {}, op());
  assert.deepEqual(trial.calls, ["trial"], "the local trial's navigation still answers first");
});

test("final transcript: Stop or a lost fence during the code check runs nothing", async () => {
  const stop = new AbortController();
  const calls: string[] = [];
  const d = createConnectedVoiceDispatch({
    trial: async () => ({ status: "unavailable", reason: "x", path: "none", latencyMs: 0, tokens: zero }),
    capability: async () => (calls.push("capability"), { ok: true, jev: true, computerUse: { bound: false, code: "x", blocker: "y" } }),
    plan: async () => (calls.push("plan"), { status: "stopped" }),
    ask: async () => { throw new Error("no"); },
    interactive: { code: async () => (stop.abort(), true), run: async () => (calls.push("interactive"), ran("course.open")) },
  });
  await assert.rejects(d("open programming three", {}, { operationId: "o", signal: stop.signal, current: () => true }));
  assert.equal(calls.join(), "");
  let live = true;
  const fenced = createConnectedVoiceDispatch({
    trial: async () => ({ status: "unavailable", reason: "x", path: "none", latencyMs: 0, tokens: zero }),
    capability: async () => (calls.push("capability"), { ok: true, jev: true, computerUse: { bound: false, code: "x", blocker: "y" } }),
    plan: async () => (calls.push("plan"), { status: "stopped" }),
    ask: async () => { throw new Error("no"); },
    interactive: { code: async () => ((live = false), true), run: async () => (calls.push("interactive"), ran("course.open")) },
  });
  await assert.rejects(fenced("open programming three", {}, { operationId: "o", signal: new AbortController().signal, current: () => live }));
  assert.equal(calls.join(), "");
});
