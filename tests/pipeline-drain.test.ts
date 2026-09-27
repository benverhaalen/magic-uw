import test from "node:test";
import assert from "node:assert/strict";
import { pipelineJobRegistry } from "../packages/core/src/jobs/default-registry";
import { createPipelineLoop } from "../packages/core/src/jobs/pipeline";
import { enqueueOnSave } from "../packages/core/src/jobs/registry";
import { ANALYZER_VERSION } from "../packages/core/src/graph/index";
import { course, idOf, seededStore, VECTORS_TEXT } from "./pipeline-fixture";

const until = async (check: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test("the drain runs the pipeline jobs: passages, links and facts, and one course pass", async () => {
  const store = seededStore();
  const registry = pipelineJobRegistry();
  assert.deepEqual(registry.readyKinds().sort(), ["compile.course", "link.resource", "passages.resource"]);
  assert.ok(registry.kinds().includes("card.resource"), "the cards stub is known, never leased");
  const loop = createPipelineLoop({ store, registry });
  const enqueued = await loop.backfill();
  assert.ok(enqueued > 0);
  // Every resource with text is queued for passages, whatever its kind (pages, assignments, syllabus).
  const withText = store.resources().filter((r) => r.text.length > 0);
  const passageJobs = store.jobs().filter((j) => j.kind === "passages.resource");
  assert.deepEqual(new Set(passageJobs.map((j) => j.resourceId)), new Set(withText.map((r) => r.id)));
  const courseJobs = store.jobs().filter((j) => j.kind === "compile.course");
  assert.equal(courseJobs.length, 1, "one course pass per course, not one per source");
  const report = await loop.runToIdle();
  assert.equal(report.failed, 0);
  const pipelineJobs = store.jobs().filter((j) => ["passages.resource", "link.resource", "compile.course"].includes(j.kind));
  assert.ok(pipelineJobs.length > 0 && pipelineJobs.every((j) => j.status === "done"));
  // A second backfill of unchanged content adds nothing.
  const before = store.jobs().length;
  await loop.backfill();
  assert.equal(store.jobs().length, before);

  const page = idOf(store, "page:vectors", "p1");
  const facts = store.materialFacts(page);
  assert.ok(facts.some((f) => f.kind === "role" && f.value === "lecture"));
  assert.ok(facts.every((f) => f.analyzerVersion === ANALYZER_VERSION));
  assert.ok(store.resourceRefs(idOf(store, "assignments", "1001")).length > 0);
  assert.ok(store.graphCounts(course).some((c) => c.resourceId === page && c.passages > 0 && c.facts > 0));
  store.close();
});

test("passages carry exact offsets into the resource's text", async () => {
  const store = seededStore();
  const loop = createPipelineLoop({ store, registry: pipelineJobRegistry() });
  await loop.backfill();
  await loop.runToIdle();
  const page = idOf(store, "page:vectors", "p1");
  const passages = store.passages(page);
  assert.ok(passages.length > 0);
  for (const p of passages) {
    assert.ok(p.start >= 0 && p.end <= VECTORS_TEXT.length && p.end > p.start);
    assert.equal(store.passage(p.pid)!.text, VECTORS_TEXT.slice(p.start, p.end));
  }
  store.close();
});

test("the loop yields to a sync and resumes when it ends; suspend holds it", async () => {
  const store = seededStore();
  const registry = pipelineJobRegistry();
  const loop = createPipelineLoop({ store, registry, idleMs: 0, presentSlice: 5, presentGapMs: 0 });
  for (const s of store.sources()) enqueueOnSave(store, registry, s.id, new Date().toISOString());
  const pending = () => store.jobs().filter((j) => j.status === "pending" && registry.readyKinds().includes(j.kind)).length;
  const total = pending();
  assert.ok(total > 5);
  loop.syncStarted();
  loop.wake();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(pending(), total, "nothing runs while a sync reads");
  loop.syncEnded();
  await until(() => pending() === 0);
  loop.suspend();
  await loop.stop();
  store.close();
});
