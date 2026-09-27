// The grounded ask is the reasoning producer behind spoken and typed questions. Its actual system prompt
// must carry the task mode code chose from the student's words, the exact source scope and every sent
// course's full policy; open graded work is never direct help; a withheld request makes no model call;
// and an answer produced under a changed source or rule is never shown or served from cache.
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
import type { IntentCommandResult } from "@magic/contracts";
import { createClaudeBackend, type CliCommand, type ModelRunner, type RunRequest } from "../packages/runner/src/index";
import { createPackRuntime, memoryArtifactStore, memoryLedgerStore } from "../packages/packs/core/src/index";
import { createIntentRouter, groundedAsk } from "../packages/core/src/intent/index";
import { askPack } from "../packages/packs/intent/src/index";
import { NOW, TZ, workspace } from "./intent-fixtures";

const here = dirname(fileURLToPath(import.meta.url));
const fake: CliCommand = { file: process.execPath, prefixArgs: [join(here, "fixtures", "fake-cli", "fake-cli.mjs"), "claude"] };
type Store = ReturnType<typeof workspace>["store"];
type Policy = ResourceInput["policy"];

const HOMEWORK = "Homework 3: write a recursive method sumDigits(n) that returns the sum of the digits of n. Submit your solution by Tuesday.";
let observed = 0;
/** Each capture is newer than every earlier one, so a re-capture always replaces the saved course. */
const nextObservedAt = () => new Date(Date.parse("2026-09-28T13:00:00.000Z") + ++observed * 60_000).toISOString();
/** Re-capture a course with new policy (and optional homework text); a newer observation replaces the old. */
function recapture(store: Store, batches: CaptureBatch[], courseId: string, policy: Policy, homework = false) {
  const batch = batches.find((b) => b.source.courseId === courseId)!;
  store.ingest({
    ...batch,
    observedAt: nextObservedAt(),
    resources: batch.resources.map((r) => ({ ...r, policy, ...(homework && r.title === "Homework 3" ? { text: HOMEWORK } : {}) })),
  });
}
const pidOf = (store: Store, title: string) => `p${store.passages(store.resources().find((r) => r.title === title && !r.deleted)!.id)[0]!.pid}`;

async function setup(prepare: (store: Store, batches: CaptureBatch[]) => void, responses: (store: Store) => unknown[]) {
  const { store, batches } = workspace();
  prepare(store, batches);
  const dir = await mkdtemp(join(tmpdir(), "voice-producer-"));
  const workDir = join(dir, "work");
  await mkdir(workDir);
  const log = join(dir, "log.jsonl");
  const env = { FAKE_CLI_LOG: log, FAKE_CLI_STATE: join(dir, "state"), FAKE_CLI_RESPONSES: JSON.stringify(responses(store)) };
  const hooks: { queued?: () => void; modelReturned?: () => void } = {};
  const backend = createClaudeBackend({ command: fake, workDir, env });
  // `modelReturned` runs after the provider answered and before the runner's post-call hook.
  const observed = { ...backend, call: async (c: Parameters<typeof backend.call>[0]) => { const r = await backend.call(c); hooks.modelReturned?.(); return r; } };
  const inner = createPackRuntime(observed, { dailyBackgroundTokens: 1_000_000 }).runner;
  const requests: RunRequest<unknown>[] = [];
  const runner: ModelRunner = {
    client: inner.client,
    run: (r) => {
      requests.push(r as RunRequest<unknown>);
      // `queued`: the request has its decision and prompt but no provider call has gone out yet.
      hooks.queued?.();
      return inner.run(r);
    },
  };
  const artifacts = memoryArtifactStore();
  const stored = () => artifacts.list({ packId: askPack.id }).length;
  const router = createIntentRouter({ store, runner: () => runner, now: () => NOW, timeZone: TZ, artifacts });
  const core = createCore(store, { fixture: batches[0]!, now: () => NOW, timeZone: TZ, seams: { intent: router } });
  await core.execute({ type: "consent", value: { action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION } });
  const calls = async () => (existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n").length : 0);
  const run = async (text: string) => (await core.execute({ type: "command", value: { text } })).command as IntentCommandResult;
  // The course AI policy is in the system prompt, or (with the course prefix or pack catalogue as the
  // byte-stable system prompt) in the request body: both are what the provider receives.
  const asks = () => requests.map((q) => ({ ...q, systemPrompt: `${q.systemPrompt}\n\n${String(q.input)}` })).filter((q) => /Task mode:/.test(q.systemPrompt));
  return { store, batches, run, requests, asks, calls, hooks, stored, runner, artifacts };
}
const answer = (pid: string, quote: string) => ({ output: { found: true, sentences: [{ text: "From your course.", citations: [{ sourceId: pid, quote }] }] } });
const reason = (r: IntentCommandResult) => (r.status === "unavailable" ? r.reason : "");

test("explain the cited concept: reading material under an explicit allowance gets direct cited help", async () => {
  const h = await setup(
    (store, batches) => recapture(store, batches, "c400", { mode: "allowed", evidence: "Synthetic: you may use AI to study course readings." }),
    (store) => [answer(pidOf(store, "Recursion notes"), "Every recursive method needs a base case.")],
  );
  const r = await h.run("Explain what a base case is in recursion.");
  assert.equal(r.status, "answer", JSON.stringify(r));
  const [ask] = h.asks();
  assert.ok(ask, "the grounded ask was the producer");
  assert.match(ask!.systemPrompt, /## Course AI policy\nContract magic\.learning-generation\/v2\. Task mode: concept\. Help boundary: direct-cited\./);
  assert.match(ask!.systemPrompt, /Sources sent \(exact scope\):\n- \[acct\/c400\] "Recursion notes" \S+ content \S+\n/);
  assert.doesNotMatch(ask!.systemPrompt, /open graded work/);
  assert.match(ask!.systemPrompt, /COMPSCI400[^\n]*\[acct\/c400\]: allowed; boundary direct-cited\./);
  assert.match(ask!.systemPrompt, /Quoted rule: "Synthetic: you may use AI to study course readings\."/);
});

test("solve this open assignment: never direct help; allowed policy coaches, unknown policy withholds with no model call", async () => {
  const allowed = await setup(
    (store, batches) => recapture(store, batches, "c400", { mode: "allowed", evidence: "Synthetic: you may use AI to study course readings." }, true),
    (store) => [answer(pidOf(store, "Homework 3"), "write a recursive method sumDigits(n)")],
  );
  await allowed.run("Can you solve Homework 3 for me?");
  const [ask] = allowed.asks();
  assert.ok(ask, `graded ask captured: ${allowed.requests.map((q) => q.pack.id).join(",")}`);
  assert.match(ask!.systemPrompt, /Task mode: graded-work\. Help boundary: coaching\.\nTask mode basis: the student's words asks for a graded deliverable to be solved or written \(graded-work\)\./);
  assert.match(ask!.systemPrompt, /"Homework 3" \S+ content \S+; open graded work/);
  assert.match(ask!.systemPrompt, /Never produce a submission-ready answer/);
  assert.doesNotMatch(ask!.systemPrompt, /direct-cited/);

  // The same words with the course's rule unknown: no model call at all.
  const unknown = await setup((store, batches) => recapture(store, batches, "c400", { mode: "unknown", evidence: "" }, true), () => []);
  const r = await unknown.run("Can you solve Homework 3 for me?");
  assert.equal(r.status, "unavailable", JSON.stringify(r));
  assert.match(reason(r), /COMPSCI400[^.]*no clear AI rule for graded work/);
  assert.equal(unknown.asks().length, 0);
  assert.equal(await unknown.calls(), 0, "no model call");
});

test("model-routed request: the classifier's rewritten query can't drop the student's graded request", async () => {
  // Only reading material is retrieved, so graded mode can come only from the student's raw words.
  const slots = { course: "cs 400", assignment: null, topics: null, date: null, time: null, query: "recursion base case", kind: null, count: null, scope: null };
  const h = await setup(
    (store, batches) => recapture(store, batches, "c400", { mode: "allowed", evidence: "Synthetic: you may use AI to study course readings." }),
    (store) => [{ output: { action: "ask", args: slots, confidence: "high", alternatives: null, question: null } }, answer(pidOf(store, "Recursion notes"), "Every recursive method needs a base case.")],
  );
  await h.run("Just do my Homework 3 for me using recursion in cs 400");
  assert.ok(h.requests.some((q) => !/Task mode:/.test(q.systemPrompt)), "the model classifier routed it");
  const [ask] = h.asks();
  assert.ok(ask, `ask captured: ${h.requests.map((q) => q.pack.id).join(",")}`);
  assert.match(ask!.systemPrompt, /"Recursion notes"/);
  assert.doesNotMatch(ask!.systemPrompt, /open graded work/);
  assert.match(ask!.systemPrompt, /Task mode: graded-work\. Help boundary: coaching\./);
});

test("a concept question whose sources include the open assignment is still graded work", async () => {
  const h = await setup(
    (store, batches) => recapture(store, batches, "c400", { mode: "allowed", evidence: "Synthetic: you may use AI to study course readings." }, true),
    (store) => [answer(pidOf(store, "Homework 3"), "write a recursive method sumDigits(n)")],
  );
  await h.run("What does Homework 3 sumDigits ask for?");
  const [ask] = h.asks();
  assert.ok(ask);
  assert.match(ask!.systemPrompt, /Task mode: graded-work\. Help boundary: coaching\.\nTask mode basis: the student's words asks to explain a concept \(concept\); an open graded item is in scope\./);
});

test("logistics are read back as facts even when the course's rule is recorded", async () => {
  const probe = workspace().store;
  const h = await setup(() => {}, () => [answer(pidOf(probe, "Syllabus"), "Late work loses 10% per day, up to three days.")]);
  const r = await h.run("What is the late policy in CS 400?");
  assert.equal(r.status, "answer", JSON.stringify(r));
  const [ask] = h.asks();
  assert.match(ask!.systemPrompt, /Task mode: administrative\. Help boundary: facts-only\./);
  assert.match(ask!.systemPrompt, /COMPSCI400[^\n]*\[acct\/c400\]: coaching/);
  assert.match(ask!.systemPrompt, /Quoted rule: "Synthetic: AI help is allowed for practice\."/);
});

test("a restricted course among the retrieved sources withholds the answer before any model call", async () => {
  const h = await setup((store, batches) => recapture(store, batches, "c101", { mode: "restricted", evidence: "Synthetic: no AI tools on any ECON coursework." }), () => []);
  const r = await h.run("What is recursion and why do demand curves slope downward?");
  assert.equal(h.asks().length, 0, "no learning request was sent");
  assert.equal(r.status, "unavailable", JSON.stringify(r));
  assert.match(reason(r), /ECON101[^.]*restricts AI help/);
  assert.equal(await h.calls(), 0, "no model call at all");
});

test("a cached answer is reused only under the identical decision", async () => {
  const allow: Policy = { mode: "allowed", evidence: "Synthetic: you may use AI to study course readings." };
  const h = await setup((store, batches) => recapture(store, batches, "c400", allow), (store) => [answer(pidOf(store, "Recursion notes"), "Every recursive method needs a base case.")]);
  const q = "Explain what a base case is in recursion.";
  assert.equal((await h.run(q)).status, "answer");
  assert.equal((await h.run(q)).status, "answer");
  assert.equal(await h.calls(), 1, "same decision: served from cache");
  assert.equal(h.stored(), 1, "the answer was cached once");
  recapture(h.store, h.batches, "c400", { mode: "allowed", evidence: "Synthetic: you may use AI to study course readings, but not on exams." });
  assert.equal((await h.run(q)).status, "answer");
  assert.equal(await h.calls(), 2, "changed rule text: the old cached answer was not reused");
  assert.match(h.asks().at(-1)!.systemPrompt, /but not on exams/);
});

test("a rule or source change while the request is queued sends nothing to the provider and stores nothing", async () => {
  const allow: Policy = { mode: "allowed", evidence: "Synthetic: you may use AI to study course readings." };
  const h = await setup((store, batches) => recapture(store, batches, "c400", allow), (store) => [answer(pidOf(store, "Recursion notes"), "Every recursive method needs a base case.")]);
  h.hooks.queued = () => recapture(h.store, h.batches, "c400", { mode: "restricted", evidence: "Synthetic: AI tools are now banned in this course." });
  const r = await h.run("Explain what a base case is in recursion.");
  assert.equal(r.status, "unavailable", JSON.stringify(r));
  assert.match(reason(r), /changed while Magic was answering/);
  assert.equal(h.asks().length, 1, "the ask reached the runner");
  assert.equal(await h.calls(), 0, "zero provider calls");
  assert.equal(h.stored(), 0, "no artifact");

  // A source edit (same rule) is caught the same way: the decision states every content hash.
  const g = await setup((store, batches) => recapture(store, batches, "c400", allow), (store) => [answer(pidOf(store, "Recursion notes"), "Every recursive method needs a base case.")]);
  g.hooks.queued = () => {
    const batch = g.batches.find((b) => b.source.courseId === "c400")!;
    g.store.ingest({ ...batch, observedAt: nextObservedAt(), resources: batch.resources.map((x) => ({ ...x, policy: allow, ...(x.title === "Recursion notes" ? { text: `${x.text} Updated after the question was asked.` } : {}) })) });
  };
  const s = await g.run("Explain what a base case is in recursion.");
  assert.equal(s.status, "unavailable", JSON.stringify(s));
  assert.equal(await g.calls(), 0);
  assert.equal(g.stored(), 0);
});

test("a rule change during the model call stores no artifact and shows no answer", async () => {
  const allow: Policy = { mode: "allowed", evidence: "Synthetic: you may use AI to study course readings." };
  const h = await setup((store, batches) => recapture(store, batches, "c400", allow), (store) => [answer(pidOf(store, "Recursion notes"), "Every recursive method needs a base case.")]);
  h.hooks.modelReturned = () => recapture(h.store, h.batches, "c400", { mode: "restricted", evidence: "Synthetic: AI tools are now banned in this course." });
  const r = await h.run("Explain what a base case is in recursion.");
  assert.equal(r.status, "unavailable", JSON.stringify(r));
  assert.match(reason(r), /changed while Magic was answering/);
  assert.equal(await h.calls(), 1, "the provider answered once");
  assert.equal(h.stored(), 0, "its answer was not cached");
  h.hooks.modelReturned = undefined;
  // Back under an allowing rule the answer is produced fresh, not read from a cache written under the old one.
  recapture(h.store, h.batches, "c400", allow);
  assert.equal((await h.run("Explain what a base case is in recursion.")).status, "answer");
  assert.equal(await h.calls(), 2);
  assert.equal(h.stored(), 1);
});

test("one of two sent sources disappearing while the runner is acquired: zero model calls, nothing stored", async () => {
  const allow: Policy = { mode: "allowed", evidence: "Synthetic: you may use AI to study course readings." };
  const h = await setup(
    (store, batches) => { recapture(store, batches, "c400", allow); recapture(store, batches, "c101", allow); },
    (store) => [answer(pidOf(store, "Recursion notes"), "Every recursive method needs a base case.")],
  );
  const courses = [
    { ref: "acct:c400", accountScope: "acct", courseId: "c400", code: "COMPSCI 400", name: "Programming III" },
    { ref: "acct:c101", accountScope: "acct", courseId: "c101", code: "ECON 101", name: "Principles of Microeconomics" },
  ];
  const question = "What is recursion and why do demand curves slope downward?";
  const deps = (runner: () => Promise<typeof h.runner | null>) => ({ store: h.store, runner, artifacts: h.artifacts, ledger: memoryLedgerStore(), now: () => NOW, utterance: question });
  // Control: with both sources present, both are sent and the decision covers both courses.
  const both = await groundedAsk(deps(async () => h.runner), question, courses, new AbortController().signal);
  assert.equal(both.notFound, false, JSON.stringify(both));
  assert.equal(both.unavailable, undefined, JSON.stringify(both));
  const sent = h.asks().at(-1)!.systemPrompt;
  assert.match(sent, /"Recursion notes"/);
  assert.match(sent, /"Supply and demand"/, "the question retrieves one source from each course");
  const callsBefore = await h.calls(), storedBefore = h.stored();

  // Same question under a fresh cache key (new text), with ECON's source hard-removed while the runner is acquired:
  // `store.resource()` no longer returns its rows, but its passage was already read into the prompt.
  const asksBefore = h.asks().length;
  const r = await groundedAsk(deps(async () => (h.store.removeSource("canvas-c101"), h.runner)), "What is recursion, and why do demand curves slope downward?", courses, new AbortController().signal);
  assert.equal(h.store.resources().some((x) => x.title === "Supply and demand"), false, "the source is gone");
  assert.equal(r.unavailable, "Magic couldn't confirm the course and account for every source, so it didn't answer.", JSON.stringify(r));
  assert.equal(h.asks().length, asksBefore, "no request reached the runner");
  assert.equal(await h.calls(), callsBefore, "zero model calls");
  assert.equal(h.stored(), storedBefore, "zero stored artifacts");
});

test("one of two sent sources removed after the decision, while the call is queued: zero model calls, nothing stored", async () => {
  const allow: Policy = { mode: "allowed", evidence: "Synthetic: you may use AI to study course readings." };
  const h = await setup(
    (store, batches) => { recapture(store, batches, "c400", allow); recapture(store, batches, "c101", allow); },
    (store) => [answer(pidOf(store, "Recursion notes"), "Every recursive method needs a base case.")],
  );
  h.hooks.queued = () => h.store.removeSource("canvas-c101");
  const r = await h.run("What is recursion and why do demand curves slope downward?");
  assert.equal(r.status, "unavailable", JSON.stringify(r));
  assert.match(reason(r), /changed while Magic was answering/);
  assert.equal(h.asks().length, 1, "the decision covered both courses and reached the runner");
  assert.match(h.asks()[0]!.systemPrompt, /"Supply and demand"/);
  assert.equal(await h.calls(), 0, "zero model calls");
  assert.equal(h.stored(), 0, "zero stored artifacts");
});
