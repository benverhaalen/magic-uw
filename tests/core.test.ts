import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { captureBatchSchema, defaultPrivacy } from "@magic/contracts";
import fixture from "../fixtures/course.json";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
// T06: Jev needs its own consent record before any send; these tests exercise sends.
const jevConsent = {
  type: "consent" as const,
  value: {
    action: "grant" as const,
    recipient: "jev" as const,
    disclosureVersion: CONSENT_DISCLOSURE_VERSION,
  },
};
const batch = captureBatchSchema.parse(fixture);
const enabled = {
  ...defaultPrivacy,
  mode: "selective_cloud" as const,
  jevEnabled: true,
  shareCourseText: true,
};
const result = {
  kind: "essay" as const,
  probabilities: {
    essay: 0.97,
    problem_set: 0.005,
    quiz: 0.005,
    exam: 0.005,
    discussion: 0.005,
    project: 0.005,
    reading: 0.005,
    other: 0,
  },
  model: "synthetic-model",
  questionVersion: "assignment.kind.v1" as const,
};
test("local default ingests immediately, blocks egress, and compiles exactly the allowed fields", async () => {
  let calls = 0;
  const payloads = new Map<string, unknown>();
  const store = createStore(":memory:");
  const core = createCore(store, {
    fixture: batch,
    gateway: {
      async evaluate(p) {
        calls++;
        payloads.set(p.title, p);
        return result;
      },
    },
  });
  await core.execute({ type: "fixture" });
  await core.settled();
  const r = core.snapshot().resources.find((r) => r.kind === "assignment")!;
  assert.equal(calls, 0);
  const blocked = await core.execute({ type: "enrich", id: r.id });
  assert.equal(blocked.manifest?.allowed, false);
  assert.equal(store.receipts()[0].status, "blocked");
  const expected = core.context(r.id, "jev").payload;
  assert.deepEqual(Object.keys(expected).sort(), [
    "course",
    "policy",
    "text",
    "title",
  ]);
  assert.ok(!JSON.stringify(expected).includes(r.url));
  await core.execute(jevConsent);
  await core.execute({ type: "privacy", value: enabled });
  await core.settled();
  // One judgment per queued sample assignment.
  assert.equal(
    calls,
    batch.resources.filter((x) => x.kind === "assignment").length,
  );
  assert.deepEqual(payloads.get(r.title), expected);
  assert.equal(
    core.snapshot().resources.find((x) => x.id === r.id)?.kindLabel,
    "essay",
  );
  await core.close();
});
test("revoking cloud access discards a late successful response", async () => {
  let resolve!: (value: typeof result) => void, entered!: () => void;
  const inFlight = new Promise<void>((r) => (entered = r));
  const store = createStore(":memory:");
  store.setPrivacy(enabled);
  store.setConsent!(jevConsent.value, "2026-09-26T12:00:00Z");
  const core = createCore(store, {
    fixture: batch,
    // One drain: the Jev call starts in the drain's idle slice, so wait until it is in flight.
    drain: { idleMs: 0 },
    gateway: {
      evaluate() {
        entered();
        return new Promise((r) => {
          resolve = r;
        });
      },
    },
  });
  await core.execute({ type: "fixture" });
  await inFlight;
  await core.execute({ type: "privacy", value: defaultPrivacy });
  resolve(result);
  await core.settled();
  assert.equal(store.judgments().length, 0);
  await core.close();
});
test("deleting local data prevents an in-flight result or receipt from recreating it", async () => {
  let resolve!: (value: typeof result) => void, entered!: () => void;
  const inFlight = new Promise<void>((r) => (entered = r));
  const store = createStore(":memory:");
  store.setPrivacy(enabled);
  store.setConsent!(jevConsent.value, "2026-09-26T12:00:00Z");
  const core = createCore(store, {
    fixture: batch,
    // One drain: the Jev call starts in the drain's idle slice, so wait until it is in flight.
    drain: { idleMs: 0 },
    gateway: {
      evaluate() {
        entered();
        return new Promise((r) => {
          resolve = r;
        });
      },
    },
  });
  await core.execute({ type: "fixture" });
  await inFlight;
  await core.execute({ type: "purge", confirmation: "DELETE LOCAL DATA" });
  resolve(result);
  await core.settled();
  assert.equal(store.resources().length, 0);
  assert.equal(store.judgments().length, 0);
  assert.equal(store.receipts().length, 0);
  await core.close();
});
test("a source change while evaluation is running prevents old classification replacing new facts", async () => {
  let resolve!: (value: typeof result) => void, entered!: () => void;
  const inFlight = new Promise<void>((r) => (entered = r));
  let calls = 0;
  const store = createStore(":memory:");
  store.setPrivacy(enabled);
  store.setConsent!(jevConsent.value, "2026-09-26T12:00:00Z");
  const core = createCore(store, {
    fixture: batch,
    drain: { idleMs: 0 },
    gateway: {
      evaluate() {
        calls++;
        entered();
        return calls === 1
          ? new Promise((r) => {
              resolve = r;
            })
          : Promise.reject(new Error("offline"));
      },
    },
  });
  await core.execute({ type: "import", batch });
  await inFlight;
  const newer = {
    ...batch,
    observedAt: "2026-09-27T12:00:00Z",
    resources: batch.resources.map((r) => ({
      ...r,
      title: r.title + " revised",
    })),
  };
  await core.execute({ type: "import", batch: newer });
  resolve(result);
  await core.settled();
  assert.equal(store.judgments().length, 0);
  assert.ok(store.resources().every((r) => r.title.endsWith(" revised")));
  await core.close();
});
