// The connected-agent planner seam: the student's connected Claude/Codex plans one goal at a time through the
// installed pack runtime (fake CLI here), a typed executor acts and reports the observed outcome, and the
// planner follows up. Every call carries the course AI policy text and goes through consent receipts; Stop,
// a newer request or a changed rule ends the run before the next model call or action.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createCore } from "@magic/core";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import type { CaptureBatch, ResourceInput } from "@magic/contracts";
import { createClaudeBackend, type CliCommand, type ModelRunner, type RunRequest } from "../packages/runner/src/index";
import { createPackRuntime, memoryArtifactStore, memoryLedgerStore } from "../packages/packs/core/src/index";
import { runPlanner, type ExecutorOutcome, type ObservedExecutor, type ObservedState, type PlannerOrigin } from "../packages/core/src/intent/planner";
import { plannerPack } from "../packages/packs/intent/src/planner";
import { NOW, TZ, workspace } from "./intent-fixtures";

const here = dirname(fileURLToPath(import.meta.url));
const fake: CliCommand = { file: process.execPath, prefixArgs: [join(here, "fixtures", "fake-cli", "fake-cli.mjs"), "claude"] };
type Store = ReturnType<typeof workspace>["store"];
type Policy = ResourceInput["policy"];
let observedAt = 0;
function recapture(store: Store, batches: CaptureBatch[], courseId: string, policy: Policy) {
  const batch = batches.find((b) => b.source.courseId === courseId)!;
  store.ingest({ ...batch, observedAt: new Date(Date.parse("2026-09-28T13:00:00.000Z") + ++observedAt * 60_000).toISOString(), resources: batch.resources.map((r) => ({ ...r, policy })) });
}
const plan = (kind: string, say: string, goal: string | null = null, question: string | null = null, destinations: { url: string; label: string }[] | null = null) => ({ output: { kind, say, goal, question, destinations } });
const screen = (route: string, title: string): ObservedState => ({ status: "observed", at: NOW.toISOString(), app: { route, title }, elements: [{ id: "n1", role: "button", name: "Calendar" }] });

async function setup(responses: unknown[], options: { consent?: boolean; prepare?: (store: Store, batches: CaptureBatch[]) => void } = {}) {
  const { store, batches } = workspace();
  options.prepare?.(store, batches);
  const dir = await mkdtemp(join(tmpdir(), "voice-planner-"));
  const workDir = join(dir, "work");
  await mkdir(workDir);
  const log = join(dir, "log.jsonl");
  const hooks: { queued?: () => void; modelReturned?: () => void } = {};
  const backend = createClaudeBackend({ command: fake, workDir, env: { FAKE_CLI_LOG: log, FAKE_CLI_STATE: join(dir, "state"), FAKE_CLI_RESPONSES: JSON.stringify(responses) } });
  // `modelReturned` runs after the provider answered and before the runner's post-call hook.
  const observed = { ...backend, call: async (c: Parameters<typeof backend.call>[0]) => { const r = await backend.call(c); hooks.modelReturned?.(); return r; } };
  const inner = createPackRuntime(observed, { dailyBackgroundTokens: 1_000_000 }).runner;
  const requests: RunRequest<unknown>[] = [];
    const runner: ModelRunner = { client: inner.client, run: (r) => (requests.push(r as RunRequest<unknown>), hooks.queued?.(), inner.run(r)) };
  const core = createCore(store, { fixture: batches[0]!, now: () => NOW, timeZone: TZ });
  if (options.consent !== false)
    await core.execute({ type: "consent", value: { action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION } });
  const calls = async () => (existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n").length : 0);
  const artifacts = memoryArtifactStore();
  const deps = { store, runner: async () => runner, artifacts, ledger: memoryLedgerStore(), now: () => NOW };
  return { store, batches, deps, requests, calls, hooks, artifacts };
}
/** A scripted executor: records every goal and returns the next outcome. */
function executor(outcomes: ((signal: AbortSignal) => ExecutorOutcome)[], first = screen("home", "Home")) {
  const goals: string[] = [];
  let last = first;
  const x: ObservedExecutor & { goals: string[] } = {
    goals,
    observe: async () => last,
    act: async (step, signal) => {
      goals.push(step.goal);
      const o = outcomes.shift()!(signal);
      if (o.status === "done") last = o.observed;
      return o;
    },
  };
  return x;
}
const home: PlannerOrigin = { route: "home" };

test("act → observed outcome → planner follow-up → done, each call through consent with the policy section", async () => {
  const h = await setup([plan("act", "Opening your calendar.", "open the Calendar page in Magic"), plan("done", "Your calendar is open.")]);
  const x = executor([() => ({ status: "done", action: "page.open calendar", observed: screen("calendar", "Calendar") })]);
  const events: string[] = [];
  const r = await runPlanner({ ...h.deps, executor: x, current: () => true, onEvent: (e) => events.push(e.type) }, { runId: "r1", utterance: "Open my calendar", origin: home }, new AbortController().signal);
  assert.equal(r.status, "done", JSON.stringify(r));
  assert.deepEqual(x.goals, ["open the Calendar page in Magic"]);
  assert.deepEqual(events, ["planned", "outcome", "planned"]);
  assert.equal(await h.calls(), 2);
  // runPack checks consent before the run and again at dispatch, as for the grounded ask: two receipts per call.
  assert.equal(r.receiptIds.length, 4);
  const [first, second] = h.requests;
  assert.equal(first!.pack.id, plannerPack.id);
  assert.match(first!.systemPrompt, /## Course AI policy\nNo course item is open for this request\. Give no course help yourself/);
  assert.match(first!.input, /Earlier steps: none\nObserved now:\nApp: "home" "Home"/);
  // The follow-up sees the executor's observed result, not the planner's own claim.
  assert.match(second!.input, /1\. goal "open the Calendar page in Magic" → done: page\.open calendar; now App: "calendar" "Calendar"/);
  assert.equal(h.artifacts.list({ packId: plannerPack.id }).length, 2);
});

test("an open course item: the planner carries that item's quoted rule; a course question goes back to the grounded ask", async () => {
  const h = await setup([plan("course_question", "I'll answer from your notes.", null, "What is a base case?")], {
    prepare: (store, batches) => recapture(store, batches, "c400", { mode: "allowed", evidence: "Synthetic: you may use AI to study course readings." }),
  });
  const notes = h.store.resources().find((r) => r.title === "Recursion notes" && !r.deleted)!;
  const x = executor([]);
  const origin: PlannerOrigin = { route: "course", accountScope: "acct", courseId: "c400", courseLabel: "COMPSCI 400", resourceId: notes.id, itemTitle: "Recursion notes" };
  const r = await runPlanner({ ...h.deps, executor: x, current: () => true }, { runId: "r2", utterance: "What is a base case?", origin }, new AbortController().signal);
  assert.equal(r.status, "course_question", JSON.stringify(r));
  assert.equal(r.status === "course_question" && r.question, "What is a base case?");
  assert.deepEqual(x.goals, [], "no action");
  assert.match(h.requests[0]!.systemPrompt, /## Course AI policy\nContract magic\.learning-generation\/v2\. Task mode: concept\./);
  assert.match(h.requests[0]!.systemPrompt, /Quoted rule: "Synthetic: you may use AI to study course readings\."/);
  assert.equal(r.policy, h.requests[0]!.systemPrompt.split("## Course AI policy\n")[1]);
});

test("Stop while an action runs: no further model call or action", async () => {
  const h = await setup([plan("act", "Opening Canvas.", "open Homework 3 in Canvas"), plan("act", "Next.", "scroll down")]);
  const stop = new AbortController();
  const x = executor([() => (stop.abort(), { status: "stopped" })]);
  const r = await runPlanner({ ...h.deps, executor: x, current: () => true }, { runId: "r3", utterance: "Open homework 3", origin: home }, stop.signal);
  assert.equal(r.status, "stopped");
  assert.equal(await h.calls(), 1);
  assert.deepEqual(x.goals, ["open Homework 3 in Canvas"]);
});

test("a newer request while the plan call is queued: zero model calls, nothing stored, no action", async () => {
  const h = await setup([plan("act", "Opening.", "open Calendar")]);
  let current = true;
  h.hooks.queued = () => { current = false; };
  const x = executor([]);
  const r = await runPlanner({ ...h.deps, executor: x, current: () => current }, { runId: "r4", utterance: "Open my calendar", origin: home }, new AbortController().signal);
  assert.equal(r.status, "stopped", JSON.stringify(r));
  assert.equal(await h.calls(), 0);
  assert.equal(h.artifacts.list({ packId: plannerPack.id }).length, 0);
  assert.deepEqual(x.goals, []);
});

test("a newer request after the model answered: the step is neither stored nor acted on", async () => {
  const h = await setup([plan("act", "Opening.", "open Calendar")]);
  let current = true;
  h.hooks.modelReturned = () => { current = false; };
  const x = executor([]);
  const r = await runPlanner({ ...h.deps, executor: x, current: () => current }, { runId: "r4b", utterance: "Open my calendar", origin: home }, new AbortController().signal);
  assert.equal(r.status, "stopped", JSON.stringify(r));
  assert.equal(await h.calls(), 1);
  assert.equal(h.artifacts.list({ packId: plannerPack.id }).length, 0);
  assert.deepEqual(x.goals, []);
});

test("the open item's rule changes after an action: the next plan call never goes out", async () => {
  const h = await setup([plan("act", "Opening the notes.", "open Recursion notes"), plan("done", "Done.")], {
    prepare: (store, batches) => recapture(store, batches, "c400", { mode: "allowed", evidence: "Synthetic: you may use AI to study course readings." }),
  });
  const notes = h.store.resources().find((r) => r.title === "Recursion notes" && !r.deleted)!;
  // The rule is recaptured (a new resource row keeps the same id) while the action runs.
  const x = executor([() => (recapture(h.store, h.batches, "c400", { mode: "restricted", evidence: "Synthetic: no AI tools in this course." }), { status: "done", action: "page.open", observed: screen("course", "COMPSCI 400") })]);
  const origin: PlannerOrigin = { route: "course", accountScope: "acct", courseId: "c400", courseLabel: "COMPSCI 400", resourceId: notes.id };
  const r = await runPlanner({ ...h.deps, executor: x, current: () => true }, { runId: "r5", utterance: "Open my recursion notes", origin }, new AbortController().signal);
  assert.equal(r.status, "unavailable", JSON.stringify(r));
  assert.match(r.status === "unavailable" ? r.reason : "", /course rules changed/);
  assert.equal(await h.calls(), 1);
});

test("no observed executor: the planner is told the screen is unknown and an act step is reported, not faked", async () => {
  const h = await setup([plan("act", "Opening.", "open Calendar")]);
  const r = await runPlanner({ ...h.deps, executor: null, current: () => true }, { runId: "r6", utterance: "Open my calendar", origin: home }, new AbortController().signal);
  assert.equal(r.status, "unavailable");
  assert.match(r.status === "unavailable" ? r.reason : "", /observed executor isn't connected/);
  assert.match(h.requests[0]!.input, /Observed now:\nUnknown: the app could not read the screen \("no observed executor is connected"\)/);
});

test("needs confirmation hands the step to the student; without consent nothing is sent", async () => {
  const h = await setup([plan("act", "Submitting?", "press the Submit button")]);
  const x = executor([() => ({ status: "needs_confirmation", action: "click Submit", prompt: "Magic won't submit for you. Press Submit yourself if you're ready." })]);
  const r = await runPlanner({ ...h.deps, executor: x, current: () => true }, { runId: "r7", utterance: "submit it", origin: home }, new AbortController().signal);
  assert.equal(r.status, "needs_confirmation");
  assert.equal(await h.calls(), 1);

  const none = await setup([plan("done", "x")], { consent: false });
  const blocked = await runPlanner({ ...none.deps, executor: executor([]), current: () => true }, { runId: "r8", utterance: "Open my calendar", origin: home }, new AbortController().signal);
  assert.equal(blocked.status, "unavailable");
  assert.equal(await none.calls(), 0);
});
