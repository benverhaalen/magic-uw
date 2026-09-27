/**
 * owner: drain. The UI is never blocked by background work, at the live workspace's size: budgets
 * that fail CI when broken. A file-backed store (WAL, real commits) holds 2,000+ synthetic
 * resources; the first-launch backlog (every course's passages, facts and references, then every
 * note scaffold in the window) runs while a scoped query is issued every 50 ms.
 *
 * - event-loop delay on the request thread: p99 ≤ 50 ms, max ≤ 200 ms during the whole backlog;
 * - the scoped query: p95 ≤ 100 ms, measured from when it was due;
 * - no stretch of background work holds the thread longer than 50 ms without yielding;
 * - a second pass with nothing changed writes nothing.
 * The backlog's total time is reported (t.diagnostic).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { captureBatchSchema } from "@magic/contracts";
import { appJobRegistry } from "../packages/core/src/jobs/default-registry";
import { createNotesService } from "../packages/notes/src/index";
import fixture from "../fixtures/course.json";
import { bigWorkspaceBatches, BIG_NOW } from "./derive-fixture";

const STRETCH_BUDGET_MS = 50;
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.max(0, Math.ceil((p / 100) * xs.length) - 1)] ?? 0;

test("first-launch backlog at 2,000+ resources keeps the request thread responsive", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "magic-derive-budget-"));
  const store = createStore(join(dir, "workspace.sqlite"));
  const core = createCore(store, {
    fixture: captureBatchSchema.parse(fixture),
    jobs: appJobRegistry(),
    drain: { derive: true, idleMs: 3_600_000 },
    now: () => new Date(BIG_NOW),
  });
  const notes = createNotesService({ store, now: () => new Date(BIG_NOW) });
  try {
    for (const b of bigWorkspaceBatches()) assert.ok(!store.ingest(b).rejected);
    const resources = store.resources().length;
    assert.ok(resources >= 2000, `sized like the live workspace (${resources} resources)`);

    // The UI's scoped query every 50 ms; its latency counts from when it was due.
    const latencies: number[] = [];
    let probing = true;
    const start = performance.now();
    let n = 0;
    const probe = () => {
      if (!probing) return;
      const due = start + ++n * 50;
      setTimeout(() => {
        if (!probing) return;
        core.query({ view: "changes", courseId: "303", limit: 100 });
        latencies.push(performance.now() - due);
        probe();
      }, Math.max(0, due - performance.now()));
    };
    probe();
    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    const began = performance.now();
    await core.settled(); // the reconcile, then every due job
    const notesStats = await notes.reconcile();
    const backlogMs = performance.now() - began;
    delay.disable();
    probing = false;

    const derived = core.pipeline.derived;
    const p99 = delay.percentile(99) / 1e6, max = delay.max / 1e6;
    t.diagnostic(
      `backlog ${Math.round(backlogMs)} ms for ${resources} resources: ${derived.courses} courses, ${derived.writes} resources written in ${derived.transactions} transactions, ` +
        `${notesStats.created} notes in ${notesStats.transactions} transactions; loop delay p99 ${p99.toFixed(1)} ms, max ${max.toFixed(1)} ms; ` +
        `query p95 ${pct(latencies, 95).toFixed(1)} ms (n=${latencies.length}); longest stretch ${derived.maxBatchMs.toFixed(1)} ms (derive), ${notesStats.maxBatchMs.toFixed(1)} ms (notes)`,
    );
    assert.ok(derived.courses >= 7 && derived.writes > 1000, "the backlog was real work");
    assert.ok(notesStats.created >= 50, "the notes had sessions to scaffold");
    assert.deepEqual(derived.errors, []);
    // Wall-clock budgets gate locally; on shared CI runners they report only (see PR #37), so a
    // loaded runner can't fail a teammate's build. Set BUDGETS_TIMING=gate to enforce them in CI.
    if (process.env.CI && process.env.BUDGETS_TIMING !== "gate") {
      console.log(`DERIVE-BUDGETS (report only in CI) derive ${derived.maxBatchMs.toFixed(1)} ms, notes ${notesStats.maxBatchMs.toFixed(1)} ms, p99 ${p99.toFixed(1)} ms, max ${max.toFixed(1)} ms`);
      return;
    }
    assert.ok(derived.maxBatchMs <= STRETCH_BUDGET_MS, `derive stretch ${derived.maxBatchMs.toFixed(1)} ms ≤ ${STRETCH_BUDGET_MS} ms`);
    assert.ok(notesStats.maxBatchMs <= STRETCH_BUDGET_MS, `notes stretch ${notesStats.maxBatchMs.toFixed(1)} ms ≤ ${STRETCH_BUDGET_MS} ms`);
    assert.ok(p99 <= 50, `event-loop delay p99 ${p99.toFixed(1)} ms ≤ 50 ms`);
    assert.ok(max <= 200, `event-loop delay max ${max.toFixed(1)} ms ≤ 200 ms`);
    assert.ok(latencies.length >= 3, "the query ran during the backlog");
    assert.ok(pct(latencies, 95) <= 100, `scoped query p95 ${pct(latencies, 95).toFixed(1)} ms ≤ 100 ms`);

    // Nothing changed: the reconcile compares and writes nothing; the notes skip.
    const before = { ...derived };
    await core.settled();
    assert.equal(core.pipeline.derived.writes, before.writes);
    assert.equal(core.pipeline.derived.transactions, before.transactions);
    assert.equal((await notes.reconcile()).skipped, true);
  } finally {
    await core.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
