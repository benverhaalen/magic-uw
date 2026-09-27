import { judgmentFailure, judgmentFailureError } from "../apps/desktop/src/judgment-errors";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { gatewayClient, JudgmentBudgetError } from "@magic/ai";
import { captureBatchSchema, defaultPrivacy } from "@magic/contracts";
import { createJobRegistry } from "../packages/core/src/jobs/registry";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import fixture from "../fixtures/course.json";
const batch = captureBatchSchema.parse(fixture);
const privacy = { ...defaultPrivacy, mode: "selective_cloud" as const, jevEnabled: true, shareCourseText: true };
const judgment = { kind: "essay" as const, probabilities: { essay: 1 }, model: "synthetic", questionVersion: "assignment.kind.v1" as const };

test("429 defers Jev only, persists across restart and new jobs, then resumes at Retry-After", async () => {
  const dir = mkdtempSync(join(tmpdir(), "magic-budget-"));
  let at = new Date("2030-09-26T22:00:00Z"), calls = 0, local = 0;
  const jobs = createJobRegistry([{ kind: "local.inspect", subject: "resource", ready: true, owner: "test",
    async run() { local++; return { status: "done" }; } }]);
  const gateway = { async evaluate() { calls++; if (calls === 1) throw judgmentFailureError(structuredClone(judgmentFailure(new JudgmentBudgetError(120_000)))); return judgment; } };
  let store = createStore(join(dir, "test.db"), { now: () => at });
  store.ingest(batch); store.setPrivacy(privacy);
  store.setConsent!({ action: "grant", recipient: "jev", disclosureVersion: CONSENT_DISCLOSURE_VERSION }, at.toISOString());
  const r = store.resources().find((r) => r.kind === "assignment")!;
  store.enqueue("local.inspect", r.id, r.contentHash, at.toISOString());
  let core = createCore(store, { fixture: batch, jobs, gateway, now: () => at });
  try {
    core.wake(); await core.settled();
    assert.equal(calls, 1); assert.equal(local, 1);
    const refused = store.jobs().find((j) => j.error?.startsWith("Judgment budget"))!;
    assert.equal(refused.attempts, 0); assert.equal(refused.status, "pending");
    assert.equal(store.jobCooldown("enrich.resource"), "2030-09-26T22:02:00.000Z");
    await core.close();
    store = createStore(join(dir, "test.db"), { now: () => at });
    core = createCore(store, { fixture: batch, jobs, gateway, now: () => at });
    // Newly queued Jev work must also respect the persisted kind cooldown.
    const other = store.resources().find((x) => x.kind !== "assignment")!;
    store.enqueue("enrich.resource", other.id, other.contentHash, at.toISOString());
    assert.equal(store.lease(at.toISOString(), 60000, ["enrich.resource"]), undefined);
    core.wake(); await core.settled(); assert.equal(calls, 1);
    at = new Date("2030-09-26T22:01:59Z");
    core.wake(); await core.settled(); assert.equal(calls, 1);
    at = new Date("2030-09-26T22:02:00Z");
    core.wake(); await core.settled(); assert.ok(calls > 1);
    assert.equal(store.jobs().find((j) => j.id === refused.id)?.status, "done");
  } finally { await core.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("local registered work runs without Jev availability and refusal retains handler consent stop", async () => {
  const store = createStore(":memory:"); store.ingest(batch);
  const r = store.resources()[0]!; let ran = 0;
  const jobs = createJobRegistry([{ kind: "local.inspect", subject: "resource", ready: true, owner: "test",
    async run() { ran++; return { status: "stop", error: "Consent required" }; } }]);
  store.enqueue("local.inspect", r.id, r.contentHash, batch.observedAt);
  const core = createCore(store, { fixture: batch, jobs });
  try { core.wake(); await core.settled(); assert.equal(ran, 1); assert.equal(store.jobs().find((j) => j.kind === "local.inspect")?.error, "Consent required"); }
  finally { await core.close(); }
});

test("expired or replaced leases cannot defer a kind or refund attempts", () => {
  const store = createStore(":memory:", { now: () => new Date("2030-09-26T22:00:00Z") }); store.ingest(batch);
  const at = "2030-09-26T22:00:00.000Z";
  try {
    const job = store.lease(at, 1000, ["enrich.resource"])!; assert.ok(job);
    assert.equal(store.defer(job, "2030-09-26T22:02:00Z", "wait", "2030-09-26T22:00:02Z"), false);
    const replacement = store.lease("2030-09-26T22:00:02Z", 1000, ["enrich.resource"])!;
    assert.equal(store.defer(job, "2030-09-26T22:02:00Z", "wait", "2030-09-26T22:00:02Z"), false);
    assert.equal(store.jobCooldown("enrich.resource"), undefined);
    assert.equal(replacement.attempts, 2);
  } finally { store.close(); }
});

test("gateway turns enrollment and judgment 429s into bounded Retry-After waits", async () => {
  for (const saved of [null, "test-token"]) {
    for (const [header, expected] of [["120", 120000], ["bad", 900000], ["9999999999", 86400000]] as const) {
      const gateway = gatewayClient("https://gateway.test", { read: async () => saved, write: async () => {} },
        (async () => new Response("", { status: 429, headers: { "retry-after": header } })) as typeof fetch);
      await assert.rejects(gateway.evaluate({ course: "", title: "", text: "", policy: "" }, new AbortController().signal),
        (error: unknown) => error instanceof JudgmentBudgetError && error.retryAfterMs === expected);
    }
  }
});

test("a canceled Jev request cannot install a late cooldown", async () => {
  const store = createStore(":memory:"); store.ingest(batch); store.setPrivacy(privacy);
  store.setConsent!({ action: "grant", recipient: "jev", disclosureVersion: CONSENT_DISCLOSURE_VERSION }, new Date().toISOString());
  let entered!: () => void, reject!: (error: Error) => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const core = createCore(store, { fixture: batch, gateway: { evaluate: () => {
    entered(); return new Promise((_resolve, no) => { reject = no; });
  } } });
  try {
    core.wake(); await started;
    await core.execute({ type: "privacy", value: defaultPrivacy });
    reject(new JudgmentBudgetError(120000));
    await core.settled();
    assert.equal(store.jobCooldown("enrich.resource"), undefined);
    assert.equal(store.judgments().length, 0);
  } finally { await core.close(); }
});


test("desktop judgment error IPC preserves bounded cooldowns and drops upstream details", () => {
  assert.deepEqual(judgmentFailure(new Error("private upstream body")), { error: true });
  const packet = structuredClone(judgmentFailure(new JudgmentBudgetError(120000)));
  assert.deepEqual(packet, { error: true, code: "judgment_budget", retryAfterMs: 120000 });
  assert.ok(judgmentFailureError(packet) instanceof JudgmentBudgetError);
  for (const retryAfterMs of [NaN, Infinity, -1, 0, 999, 86400001, "120000"])
    assert.equal(judgmentFailureError({ code: "judgment_budget", retryAfterMs }) instanceof JudgmentBudgetError, false);
  assert.equal(judgmentFailureError({ code: "other", retryAfterMs: 120000 }) instanceof JudgmentBudgetError, false);
});

test("gateway accepts HTTP-date Retry-After", async () => {
  const deadline = Date.now() + 180000;
  const gateway = gatewayClient("https://gateway.test", { read: async () => "test-token", write: async () => {} },
    (async () => new Response("", { status: 429, headers: { "retry-after": new Date(deadline).toUTCString() } })) as typeof fetch);
  await assert.rejects(gateway.evaluate({ course: "", title: "", text: "", policy: "" }, new AbortController().signal),
    (error: unknown) => error instanceof JudgmentBudgetError && error.retryAfterMs > 175000 && error.retryAfterMs <= 180000);
});
