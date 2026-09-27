/**
 * One job drain (WP1). Core has no inline drain: every kind, including Jev's `enrich.resource`,
 * runs as a registered handler in the pipeline loop, which is sliced, idle-only and never leases
 * while a sync is reading.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { captureBatchSchema, defaultPrivacy } from "@magic/contracts";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import { createJobRegistry, type JobHandler } from "../packages/core/src/jobs/registry";
import { createPipelineLoop } from "../packages/core/src/jobs/pipeline";
import fixture from "../fixtures/course.json";

const batch = captureBatchSchema.parse(fixture);
const privacy = { ...defaultPrivacy, mode: "selective_cloud" as const, jevEnabled: true, shareCourseText: true };
const judgment = { kind: "essay" as const, probabilities: { essay: 1 }, model: "synthetic", questionVersion: "assignment.kind.v1" as const };
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await delay(5);
  }
};
function jevAllowed(store: ReturnType<typeof createStore>) {
  store.setPrivacy(privacy);
  store.setConsent!({ action: "grant", recipient: "jev", disclosureVersion: CONSENT_DISCLOSURE_VERSION }, new Date().toISOString());
}
const localKind = (run: JobHandler["run"]): JobHandler => ({
  kind: "local.inspect",
  subject: "resource",
  ready: true,
  owner: "test",
  onSave: (r) => r.kind === "assignment",
  run,
});

test("a save during a sync leases nothing, Jev included, until syncEnded", async () => {
  const store = createStore(":memory:");
  jevAllowed(store);
  let calls = 0;
  const ran: string[] = [];
  const jobs = createJobRegistry([localKind(async (job) => (ran.push(job.resourceId), { status: "done" }))]);
  const core = createCore(store, {
    fixture: batch,
    jobs,
    gateway: { async evaluate() { calls++; return judgment; } },
    drain: { idleMs: 0 },
  });
  try {
    core.pipeline.syncStarted();
    store.ingest(batch);
    assert.ok(core.saved(batch.source.id) > 0, "the save enqueues the local kind");
    core.wake(); // the worker's 30 s tick and startup wake land here too
    await delay(60);
    assert.deepEqual(
      store.jobs().filter((j) => j.status !== "pending" || j.attempts > 0).map((j) => `${j.kind}:${j.status}`),
      [],
      "nothing is leased while a sync reads",
    );
    assert.equal(calls, 0);
    assert.equal(ran.length, 0);
    core.pipeline.syncEnded();
    await until(() => store.jobs().filter((j) => j.kind === "local.inspect").every((j) => j.status === "done") && calls > 0);
    assert.ok(ran.length > 0);
  } finally {
    await core.close();
  }
});

test("enrich.resource is a registered handler: it honours maySend and writes its receipt", async () => {
  const store = createStore(":memory:");
  store.ingest(batch);
  let calls = 0;
  const core = createCore(store, { fixture: batch, gateway: { async evaluate() { calls++; return judgment; } } });
  try {
    assert.ok(core.jobs.get("enrich.resource"), "the Jev kind is in the drain's registry");
    core.wake();
    await core.settled();
    assert.equal(calls, 0, "default privacy: Jev is never leased");
    assert.ok(store.jobs().filter((j) => j.kind === "enrich.resource").every((j) => j.status === "pending" && j.attempts === 0));
    assert.equal(store.receipts().length, 0);
    jevAllowed(store);
    core.wake();
    await core.settled();
    assert.ok(calls > 0);
    assert.equal(store.receipts().filter((r) => r.recipient === "jev" && r.status === "sent").length, calls);
    assert.equal(store.judgments().length, calls);
  } finally {
    await core.close();
  }
});

test("a purge during an in-flight Jev call keeps nothing and writes no failure", async () => {
  const store = createStore(":memory:");
  store.ingest(batch);
  jevAllowed(store);
  let entered!: () => void, answer!: (value: typeof judgment) => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const core = createCore(store, {
    fixture: batch,
    drain: { idleMs: 0 },
    gateway: { evaluate: () => { entered(); return new Promise((resolve) => { answer = resolve; }); } },
  });
  try {
    core.wake();
    await started;
    await core.execute({ type: "purge", confirmation: "DELETE LOCAL DATA" });
    answer(judgment);
    await core.settled();
    assert.equal(store.judgments().length, 0);
    assert.equal(store.receipts().filter((r) => r.status === "failed").length, 0);
  } finally {
    answer?.(judgment); // a gateway that ignores its signal would otherwise hold close()
    await core.close();
  }
});

test("the drain records a handler's thrown cause on the job", async () => {
  const store = createStore(":memory:");
  const jobs = createJobRegistry([localKind(async () => { throw new Error("Parser rejected page 3"); })]);
  const core = createCore(store, { fixture: batch, jobs });
  try {
    store.ingest(batch);
    core.saved(batch.source.id);
    await core.settled();
    const failed = store.jobs().filter((j) => j.kind === "local.inspect");
    assert.ok(failed.length > 0 && failed.every((j) => j.error === "Parser rejected page 3"));
  } finally {
    await core.close();
  }
});

test("a handler's retry-after defers its kind and the loop wakes itself when it ends", async () => {
  const store = createStore(":memory:");
  store.ingest(batch);
  const r = store.resources().find((x) => x.kind === "assignment")!;
  let runs = 0;
  const registry = createJobRegistry([localKind(async () => {
    runs++;
    return runs === 1
      ? { status: "defer", until: new Date(Date.now() + 80).toISOString(), error: "Budget reached; waiting." }
      : { status: "done" };
  })]);
  store.enqueue("local.inspect", r.id, r.contentHash, new Date().toISOString());
  const loop = createPipelineLoop({ store, registry, idleMs: 0 });
  try {
    loop.wake();
    await until(() => runs === 1);
    await delay(20);
    const waiting = store.jobs().find((j) => j.kind === "local.inspect")!;
    assert.equal(waiting.status, "pending");
    assert.equal(waiting.attempts, 0, "a deferral does not spend an attempt");
    assert.ok(store.jobCooldown("local.inspect"));
    await until(() => store.jobs().find((j) => j.kind === "local.inspect")!.status === "done");
    assert.equal(runs, 2);
  } finally {
    await loop.stop();
    store.close();
  }
});
