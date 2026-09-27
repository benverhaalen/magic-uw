/**
 * View-open speed fixes, each checked against the path it replaced on synthetic data:
 * - S4: course practice scopes resolve every anchor in one pass (core.contexts, resolver.many);
 *   the contexts and the learning answers are identical, with the workspace read once per batch.
 * - S8: learning, notes and ui_event commands sent with `reply: "result"` answer without the
 *   workspace snapshot; the result itself is identical, and the default reply is unchanged.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { StatementSync } from "node:sqlite";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { captureBatchSchema, type ContextManifest, type LearningRequest } from "@magic/contracts";
import { createLearningRouter } from "../packages/learning/src/router";
import { createNotesService } from "../packages/notes/src/index";
import { createStudyContextResolver } from "../apps/desktop/src/learning-context";
import { syntheticCorpus, COURSES } from "../evals/perf/synthetic";
import { batches } from "./pipeline-fixture";
import fixture from "../fixtures/course.json";

let statements = 0;
for (const method of ["all", "get", "run", "iterate"] as const) {
  const original = StatementSync.prototype[method] as (...args: unknown[]) => unknown;
  (StatementSync.prototype as unknown as Record<string, unknown>)[method] = function (this: StatementSync, ...args: unknown[]) {
    statements++;
    return original.apply(this, args);
  };
}
const counted = <T>(run: () => T) => {
  const before = statements;
  const value = run();
  return { value, n: statements - before };
};
const NOW = "2026-09-30T15:00:00.000Z";

function workspace(size: number) {
  const store = createStore(":memory:", { now: () => new Date(NOW) });
  for (const b of syntheticCorpus(size).batches) store.ingest(b);
  for (const b of batches()) store.ingest(b);
  const core = createCore(store, { fixture: captureBatchSchema.parse(fixture), now: () => new Date(NOW) });
  const resolve = createStudyContextResolver(store, core);
  const courseId = COURSES[0].id;
  const anchors = store.resources().filter((r) => r.kind === "assignment" && r.courseId === courseId).map((r) => r.id);
  // Accepted "specifies" links, one and two hops, so manifests carry supporting evidence.
  const materials = store.resources().filter((r) => r.kind === "material" && r.courseId === courseId);
  anchors.slice(0, 8).forEach((to, i) => {
    const from = materials[i % materials.length]!;
    const second = materials[(i + 3) % materials.length]!;
    if (second.id === from.id) return;
    store.putLink({ id: `spec-${i}`, fromId: from.id, toId: to, type: "specifies", reason: "Synthetic pointer", status: "accepted", inputHash: from.contentHash });
    store.putLink({ id: `spec2-${i}`, fromId: second.id, toId: from.id, type: "specifies", reason: "Synthetic pointer", status: "accepted", inputHash: second.contentHash });
  });
  return { store, core, resolve, courseId, anchors };
}

test("S4: core.contexts gives each item's context manifest, reading the workspace once", async () => {
  const w = workspace(200);
  try {
    const all = w.store.resources();
    // Every kind, both recipients that read evidence, a deleted-or-missing id among them.
    const ids = [...all.filter((r) => r.kind === "assignment").slice(0, 12), ...all.filter((r) => r.kind !== "assignment").slice(0, 6)].map((r) => r.id);
    ids.push("missing-resource-id");
    for (const recipient of ["local", "claude", "jev"] as const) {
      const one = ids.map((id) => {
        try {
          return w.core.context(id, recipient);
        } catch {
          return null;
        }
      });
      const batch = w.core.contexts(ids, recipient);
      // A hosted manifest's citation projection gets a fresh id per call (two per-item calls differ too).
      const stable = (ms: (ContextManifest | null)[]) =>
        ms.map((m) => (m?.citationProjections ? { ...m, citationProjections: m.citationProjections.map((c) => ({ ...c, projectionId: "fresh" })) } : m));
      assert.deepEqual(stable(batch), stable(one), recipient);
      if (recipient === "local") assert.ok(one.some((m) => m && m.resourceIds.length > 1), "some manifest carries supporting evidence");
    }
    const perItem = counted(() => ids.slice(0, 10).map((id) => w.core.context(id, "local"))).n;
    const batched = counted(() => w.core.contexts(ids.slice(0, 10), "local")).n;
    assert.ok(batched < perItem / 3, `batch ${batched} statements vs ${perItem} per item`);
  } finally {
    await w.core.close();
  }
});

test("S4: resolver.many equals resolving each anchor, whatever the order and with invalid ids", async () => {
  const w = workspace(200);
  try {
    const material = w.store.resources().find((r) => r.kind !== "assignment")!.id;
    const ids = [...w.anchors.slice(0, 15).reverse(), material, "missing-resource-id", w.anchors[0]!];
    assert.deepEqual(w.resolve.many(ids), ids.map((id) => w.resolve(id)));
    // A core without the batch method falls back to one context per id, with the same answer.
    const fallback = createStudyContextResolver(w.store, { context: (id, recipient) => w.core.context(id, recipient) });
    assert.deepEqual(fallback.many(ids), ids.map((id) => w.resolve(id)));
  } finally {
    await w.core.close();
  }
});

test("S4: learning ops answer the same with the batch resolver; its reads don't grow with the anchors", async () => {
  const w = workspace(200);
  try {
    const router = (batch: boolean) =>
      createLearningRouter({
        store: w.store.learning,
        resolveContext: (id) => w.resolve(id),
        ...(batch ? { resolveContexts: (ids: readonly string[]) => w.resolve.many(ids) } : {}),
        now: () => new Date(NOW),
      });
    const signal = new AbortController().signal;
    const per = router(false),
      batch = router(true);
    const anchorIds = w.anchors.slice(0, 20);
    assert.ok(anchorIds.length >= 10, "enough synthetic anchors");
    for (const op of ["knowledge.state", "practice.path", "course.mastery"] as const) {
      const request = { op, courseId: w.courseId, anchorIds } as LearningRequest;
      assert.deepEqual(await batch.handle(request, signal), await per.handle(request, signal), op);
    }
    const reads = async (n: number) => {
      const request = { op: "knowledge.state", courseId: w.courseId, anchorIds: w.anchors.slice(0, n) } as LearningRequest;
      const before = statements;
      await batch.handle(request, signal);
      return statements - before;
    };
    const five = await reads(5),
      twenty = await reads(20);
    const perFive = statements;
    await per.handle({ op: "knowledge.state", courseId: w.courseId, anchorIds: w.anchors.slice(0, 20) } as LearningRequest, signal);
    const perTwenty = statements - perFive;
    // The per-anchor path grows by a full context read per anchor; the batch only by a few single-row reads.
    assert.ok(twenty - five <= 4 * 15, `batch: ${five} statements at 5 anchors, ${twenty} at 20`);
    assert.ok(twenty < perTwenty / 2, `batch ${twenty} vs per-anchor ${perTwenty} statements at 20 anchors`);
  } finally {
    await w.core.close();
  }
});

test("S8: reply \"result\" answers learning, notes and ui_event without a snapshot; the result is unchanged", async () => {
  const w = workspace(60);
  const router = createLearningRouter({
    store: w.store.learning,
    resolveContext: (id) => w.resolve(id),
    resolveContexts: (ids) => w.resolve.many(ids),
    now: () => new Date(NOW),
  });
  const notes = createNotesService({ store: w.store, now: () => new Date(NOW) });
  const core = createCore(w.store, { fixture: captureBatchSchema.parse(fixture), now: () => new Date(NOW), seams: { learning: router, notes } });
  try {
    const learning = { op: "knowledge.state", courseId: w.courseId, anchorIds: w.anchors.slice(0, 5) } as LearningRequest;
    const full = await core.execute({ type: "learning", request: learning });
    const slim = await core.execute({ type: "learning", request: learning, reply: "result" });
    assert.ok(full.snapshot, "the default reply keeps its snapshot");
    assert.equal("snapshot" in slim, false);
    assert.deepEqual(slim.learning, full.learning);

    const notesFull = await core.execute({ type: "notes", request: { op: "notes.templates" } });
    const notesSlim = await core.execute({ type: "notes", request: { op: "notes.templates" }, reply: "result" });
    assert.ok(notesFull.snapshot);
    assert.equal("snapshot" in notesSlim, false);
    assert.deepEqual(notesSlim.notes, notesFull.notes);

    const open = counted(() => core.execute({ type: "ui_event", value: { kind: "open", subject: w.anchors[0]! }, reply: "result" }));
    assert.equal("snapshot" in (await open.value), false);
    assert.equal(open.n, 0, "an open event reads nothing when no snapshot is asked for");

    // Commands that change what the shell shows keep the snapshot; the opt-in is refused elsewhere.
    await assert.rejects(core.execute({ type: "complete", id: w.anchors[0]!, completed: true, reply: "result" } as never));
  } finally {
    await core.close();
  }
});
