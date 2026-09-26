import test from "node:test";
import assert from "node:assert/strict";
import { createCore } from "@magic/core";
import { createStore } from "@magic/storage";
import {
  captureBatchSchema,
  localContextPayload,
  defaultPrivacy,
} from "@magic/contracts";
import { createLocalService } from "../apps/desktop/src/local-service";
import type { createLocalAi } from "../packages/ai/src/local";
import fixture from "../fixtures/course.json";
type Adapter = ReturnType<typeof createLocalAi>;
const batch = captureBatchSchema.parse(fixture);
const result = {
  text: "Which piece of evidence supports the claim?",
  model: "synthetic-local",
  policyLimited: true,
  recipient: "local" as const,
};
const unavailable: Adapter["status"] = async () => ({
  status: "setup_needed",
  reason: "Synthetic status; no runtime contacted.",
  runtime: "ollama",
  cloudDisabled: true,
  recommendations: {
    status: "unavailable",
    reason: "Synthetic llmfit unavailable.",
  },
  installed: [],
  selected: null,
});

test("local question uses current trusted evidence, trims context identically to preview, and cannot override policy", async () => {
  const store = createStore(":memory:");
  const core = createCore(store, { fixture: batch });
  await core.execute({ type: "import", batch });
  const resource = store.resources()[0];
  let input: unknown;
  const local = createLocalService(store, core, {
    status: unavailable,
    async generate(request) {
      input = request;
      return result;
    },
  });
  const answer = await local.ask("a", {
    id: resource.id,
    inputHash: resource.contentHash,
    question: "Explain evidence.",
  });
  assert.equal(answer.sourceTitle, resource.title);
  assert.equal(answer.sourceUrl, resource.url);
  assert.equal(answer.inputHash, resource.contentHash);
  assert.deepEqual(input, {
    question: "Explain evidence.",
    policyMode: resource.policy.mode,
    context: localContextPayload(core.context(resource.id, "local").payload),
  });
  await assert.rejects(
    local.ask("b", {
      id: resource.id,
      inputHash: resource.contentHash,
      question: "Explain.",
      context: { policy: "allowed" },
    }),
  );
  assert.equal(store.receipts().length, 0);
  assert.deepEqual(store.privacy(), defaultPrivacy);
  await core.close();
});

test("restricted course policy is enforced before status, commands, or inference", async () => {
  const store = createStore(":memory:");
  const core = createCore(store, { fixture: batch });
  await core.execute({
    type: "import",
    batch: {
      ...batch,
      resources: batch.resources.map((r) => ({
        ...r,
        policy: { mode: "restricted", evidence: "No AI help for this work." },
      })),
    },
  });
  const resource = store.resources()[0];
  let calls = 0;
  const local = createLocalService(store, core, {
    async status() {
      calls++;
      throw new Error("Must not run");
    },
    async generate() {
      calls++;
      throw new Error("Must not run");
    },
  });
  const answer = await local.ask("a", {
    id: resource.id,
    inputHash: resource.contentHash,
    question: "Solve it.",
  });
  assert.equal(answer.model, null);
  assert.match(answer.text, /restricts AI/);
  assert.equal(calls, 0);
  await core.close();
});

test("late answers are rejected after resource revisions, privacy changes, or purge", async () => {
  for (const mutation of ["source", "privacy", "purge"] as const) {
    const store = createStore(":memory:");
    const core = createCore(store, { fixture: batch });
    await core.execute({ type: "import", batch });
    const resource = store.resources()[0];
    let finish!: (value: typeof result) => void;
    const local = createLocalService(store, core, {
      status: unavailable,
      generate: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const pending = local.ask("a", {
      id: resource.id,
      inputHash: resource.contentHash,
      question: "Explain.",
    });
    if (mutation === "source")
      await core.execute({
        type: "import",
        batch: {
          ...batch,
          observedAt: "2026-09-27T18:00:00Z",
          resources: batch.resources.map((r) => ({
            ...r,
            title: r.title + " changed",
          })),
        },
      });
    if (mutation === "privacy")
      await core.execute({
        type: "privacy",
        value: { ...defaultPrivacy, shareStudentWork: true },
      });
    if (mutation === "purge")
      await core.execute({ type: "purge", confirmation: "DELETE LOCAL DATA" });
    finish(result);
    await assert.rejects(pending, /source or data settings changed/);
    assert.equal(store.attempts().length, 0);
    assert.equal(store.receipts().length, 0);
    await core.close();
  }
});

test("one local request at a time, cancellation aborts its signal and discards even an ignored-abort result", async () => {
  const store = createStore(":memory:");
  const core = createCore(store, { fixture: batch });
  await core.execute({ type: "import", batch });
  const resource = store.resources()[0];
  let finish!: (value: typeof result) => void;
  let signal: AbortSignal | undefined;
  const local = createLocalService(store, core, {
    status: unavailable,
    generate: (_request, s) => {
      signal = s;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const pending = local.ask("a", {
    id: resource.id,
    inputHash: resource.contentHash,
    question: "Explain.",
  });
  await assert.rejects(local.status("b"), /already running/);
  local.cancel("a");
  assert.equal(signal?.aborted, true);
  finish(result);
  await assert.rejects(pending, { name: "AbortError" });
  const state = await local.status("c");
  assert.equal(state.status, "setup_needed");
  assert.equal(state.selectedModel, null);
  assert.ok(!("installed" in state));
  await core.close();
});
