import test from "node:test";
import assert from "node:assert/strict";
import { sourceInvestigationOps, type InvestigationCall } from "../apps/desktop/src/source-investigation-ops";

/** A fake worker link: `ready` resolves when the test says; sends and cancels are recorded. */
function harness(timeoutMs?: number) {
  let open!: () => void, fail!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { open = resolve; fail = reject; });
  const sent: { id: string; assignmentId: string; call: InvestigationCall }[] = [];
  const cancelled: string[] = [];
  let n = 0;
  const ops = sourceInvestigationOps({
    ready, timeoutMs, newId: () => `w${++n}`,
    send: (id, assignmentId, call) => { sent.push({ id, assignmentId, call }); },
    cancel: id => { cancelled.push(id); },
  });
  return { ops, sent, cancelled, open: () => open(), fail: (e: Error) => fail(e) };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const outcome = (p: Promise<unknown>) => p.then(value => ({ value }), (error: Error) => ({ error: error.message }));

test("Stop while the workspace is starting settles at once and nothing reaches the worker or provider", async () => {
  const h = harness();
  const run = outcome(h.ops.run("op-1", "a7"));
  assert.equal(h.ops.has("op-1"), true, "stoppable before ready");
  h.ops.stop("op-1");
  assert.deepEqual(await run, { error: "Investigation stopped." });
  assert.equal(h.ops.has("op-1"), false);
  h.open();
  await flush();
  assert.equal(h.sent.length, 0, "no worker request, so no provider call");
  assert.deepEqual(h.cancelled, [], "nothing to cancel in the worker");
});

test("Stop after the request is sent cancels the worker call; its late success or failure changes nothing", async () => {
  const h = harness();
  const run = outcome(h.ops.run("op-1", "a7"));
  h.open();
  await flush();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0]!.assignmentId, "a7");
  h.ops.stop("op-1");
  h.ops.stop("op-1");
  assert.deepEqual(h.cancelled, ["w1"], "cancelled once");
  h.sent[0]!.call.resolve({ summary: "late" });
  h.sent[0]!.call.reject(new Error("late failure"));
  assert.deepEqual(await run, { error: "Investigation stopped." });
  assert.equal(h.ops.has("op-1"), false);
});

test("restart after Stop: the same ID may run again and the stopped run can't remove or answer for it", async () => {
  const h = harness();
  const first = outcome(h.ops.run("op-1", "a7"));
  h.ops.stop("op-1");
  const again = outcome(h.ops.run("op-1", "a7"));
  const fresh = outcome(h.ops.run("op-2", "a7"));
  assert.deepEqual(await first, { error: "Investigation stopped." });
  h.open();
  await flush();
  assert.deepEqual(h.sent.map(s => s.id), ["w1", "w2"], "one worker request each for the two live runs, none for the stopped one");
  assert.equal(h.ops.has("op-1"), true, "the stopped run's settle left the newer registration in place");
  h.sent[0]!.call.resolve({ summary: "restarted" });
  h.sent[1]!.call.resolve({ summary: "fresh" });
  assert.deepEqual(await again, { value: { summary: "restarted" } });
  assert.deepEqual(await fresh, { value: { summary: "fresh" } });
  assert.equal(h.ops.has("op-1"), false);
  assert.equal(h.ops.has("op-2"), false);
});

test("operations are isolated: a Stop or failure of one leaves another running, and a live ID can't be reused", async () => {
  const h = harness();
  const a = outcome(h.ops.run("op-a", "a7"));
  const b = outcome(h.ops.run("op-b", "a8"));
  assert.deepEqual(await outcome(h.ops.run("op-a", "a9")), { error: "Invalid investigation request." });
  h.open();
  await flush();
  h.ops.stop("op-a");
  h.ops.stop("unknown");
  assert.deepEqual(h.cancelled, ["w1"]);
  assert.equal(h.ops.has("op-b"), true);
  h.sent[1]!.call.reject(new Error("Saved course evidence changed."));
  assert.deepEqual(await a, { error: "Investigation stopped." });
  assert.deepEqual(await b, { error: "Saved course evidence changed." });
  assert.equal(h.sent.find(s => s.id === "w2")?.assignmentId, "a8");
});

test("a workspace that fails to start, and a worker that never answers, both settle and unregister", async () => {
  const failed = harness();
  const run = outcome(failed.ops.run("op-1", "a7"));
  failed.fail(new Error("Local workspace did not start."));
  assert.deepEqual(await run, { error: "Local workspace did not start." });
  assert.equal(failed.ops.has("op-1"), false);
  assert.equal(failed.sent.length, 0);

  const slow = harness(5);
  const late = outcome(slow.ops.run("op-1", "a7"));
  slow.open();
  assert.deepEqual(await late, { error: "Investigation stopped." });
  assert.deepEqual(slow.cancelled, ["w1"]);
  assert.equal(slow.ops.has("op-1"), false);
});
