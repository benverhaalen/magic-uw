import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { gatewayClient } from "@magic/ai";
import { captureBatchSchema, defaultPrivacy } from "@magic/contracts";
import fixture from "../fixtures/course.json";
import { canvasConnector } from "../packages/connectors/src/canvas";
import { createSyntheticCanvasUniversity } from "../packages/connectors/src/canvas-fixture";

const judgment = {
  kind: "essay",
  probabilities: { essay: 0.9, problem_set: 0.02, quiz: 0.02, exam: 0.02, discussion: 0.01, project: 0.01, reading: 0.01, other: 0.01 },
  model: "synthetic-model",
  questionVersion: "assignment.kind.v1",
};

// Observed live on September 26: a device hourly limit of 5 turned one sync into
// 636 refused requests, and each refused job burned an attempt until it was
// permanently failed. A budget refusal must pause the queue instead.
test("a gateway budget refusal pauses the judgment queue without consuming attempts", async () => {
  const university = createSyntheticCanvasUniversity({ rateLimit: false });
  const store = createStore(":memory:");
  for await (const b of canvasConnector({
    origin: "https://canvas.synthetic.test", fetch: university.fetch as typeof globalThis.fetch,
    now: () => new Date("2026-09-26T15:00:00Z"), sleep: async () => {}, random: () => 0,
  }).pull())
    store.ingest(b);

  let judged = 0;
  let refused = 0;
  const fetcher = (async (url: URL) => {
    if (String(url).endsWith("/v1/devices")) return new Response(JSON.stringify({ token: "t".repeat(32) }), { status: 200 });
    if (judged < 2) {
      judged++;
      return new Response(JSON.stringify(judgment), { status: 200 });
    }
    refused++;
    return new Response(JSON.stringify({ error: "device_hourly_limit" }), { status: 429, headers: { "retry-after": "120" } });
  }) as typeof globalThis.fetch;
  let token: string | null = null;
  const gateway = gatewayClient("http://127.0.0.1:9/", { read: async () => token, write: async (t) => void (token = t) }, fetcher);
  const core = createCore(store, { fixture: captureBatchSchema.parse(fixture), gateway });
  await core.execute({ type: "privacy", value: { ...defaultPrivacy, mode: "selective_cloud", jevEnabled: true, shareCourseText: true } });
  await core.settled();
  const queued = store.jobs().filter((j) => j.kind === "enrich.resource");
  assert.ok(queued.length > 20, `many assignments queued (${queued.length})`);

  // Two judged, then exactly one refusal stops the run; the rest are never sent.
  assert.equal(judged, 2);
  assert.equal(refused, 1);
  // Further wakes during the wait send nothing.
  core.wake();
  await core.settled();
  assert.equal(refused, 1);

  const jobs = store.jobs().filter((j) => j.kind === "enrich.resource");
  assert.equal(jobs.filter((j) => j.status === "failed").length, 0, "no assignment is permanently failed by a budget wait");
  const deferred = jobs.find((j) => j.error?.startsWith("Judgment budget reached"));
  assert.ok(deferred, "the refused job is back in the queue");
  assert.equal(deferred.status, "pending");
  assert.equal(deferred.attempts, 0, "the refusal did not consume an attempt");
  assert.ok(Date.parse(deferred.runAfter) >= Date.now() + 100_000, "waits for the gateway's Retry-After");
  await core.close();
});
