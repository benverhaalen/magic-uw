import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { captureBatchSchema } from "@magic/contracts";

// One course with a syllabus and many assignments: the course profile depends on all of them.
const captured = "2026-09-26T18:00:00Z";
const ASSIGNMENTS = 40;
const batch = captureBatchSchema.parse({
  source: { id: "synthetic-a-course", label: "Synthetic course", kind: "fixture", accountScope: "synthetic-a", courseId: "101", scope: "assignments" },
  observedAt: captured, complete: true, status: "ok",
  resources: [
    { externalId: "syllabus", kind: "material", courseId: "101", courseName: "Synthetic Writing", title: "Syllabus", url: "https://example.org/syllabus", text: "Topics\\nArgument\\nAI tools are prohibited.", deadlines: [], points: null, submitted: null, policy: { mode: "coaching", evidence: "Synthetic." } },
    ...Array.from({ length: ASSIGNMENTS }, (_, i) => ({
      externalId: `a${i}`, kind: "assignment", courseId: "101", courseName: "Synthetic Writing", title: `Essay ${i}`,
      url: `https://example.org/a${i}`, text: `Write essay ${i}.`, deadlines: [], points: 10, submitted: null,
      policy: { mode: "coaching", evidence: "Synthetic." },
    })),
  ],
});

// Loading every stored item decompresses every payload; it must not happen once per item.
function countingStore() {
  const store = createStore(":memory:");
  let fullReads = 0;
  const original = store.resources.bind(store);
  store.resources = ((search?: string) => {
    fullReads++;
    return original(search);
  }) as typeof store.resources;
  return { store, reads: () => fullReads, reset: () => void (fullReads = 0) };
}

test("course extraction loads the workspace a bounded number of times, not once per item", async () => {
  const counted = countingStore();
  let inputs = 0;
  const core = createCore(counted.store, {
    fixture: batch, now: () => new Date(captured),
    courseExtractor: { async extract(input) {
      inputs = input.resources.length;
      return { inputHash: input.inputHash, extractorVersion: "synthetic-v1", candidates: [] };
    } },
  });
  try {
    counted.store.ingest(batch);
    counted.reset();
    core.wake();
    await core.settled();
    assert.ok(inputs > ASSIGNMENTS / 2, `the extractor still receives the course's items (${inputs})`);
    assert.ok(counted.reads() < 10, `full workspace reads during extraction: ${counted.reads()}`);
  } finally {
    await core.close();
  }
});

test("building sharing context for one item loads the workspace a bounded number of times", async () => {
  const counted = countingStore();
  const core = createCore(counted.store, { fixture: batch, now: () => new Date(captured) });
  try {
    counted.store.ingest(batch);
    const id = counted.store.resources().find((r) => r.externalId === "a0")!.id;
    counted.reset();
    await core.execute({ type: "context", id, recipient: "local" });
    assert.ok(counted.reads() < 10, `full workspace reads for one context: ${counted.reads()}`);
  } finally {
    await core.close();
  }
});
