/**
 * Stall guards (evals/perf/stalls.ts). Counts gate; wall-clock values are printed only.
 * - Reads never move the store's change count, so a window reading views is never told to
 *   re-read; a write does move it.
 * - Idle (nothing written), the window reads no snapshot.
 * - The worker's timers while idle: the 1 s change check and the documented cadences (30 s or longer).
 * - View requests while syncing and draining: p99 printed against the 100 ms budget.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { captureBatchSchema } from "@magic/contracts";
import { syntheticCorpus, COURSES } from "../evals/perf/synthetic";
import { measureStalls } from "../evals/perf/stalls";
import fixture from "../fixtures/course.json";

test("reads leave the store's change count alone; a write moves it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "magic-stall-guard-"));
  const store = createStore(join(directory, "w.sqlite"));
  try {
    for (const batch of syntheticCorpus(50).batches) store.ingest(batch);
    const core = createCore(store, { fixture: captureBatchSchema.parse(fixture) });
    const before = store.dataVersion();
    await core.execute({ type: "snapshot" });
    core.query({ view: "summary" });
    core.query({ view: "resources", accountScope: "perf-synthetic", courseId: COURSES[0].id, limit: 50 });
    assert.equal(store.dataVersion(), before, "a snapshot or view read wrote to the store");
    await core.execute({ type: "ingestion-settings", value: { ...store.ingestionSettings(), intervalMinutes: 30 } });
    assert.ok(store.dataVersion() > before, "a write did not move the change count");
    await core.close();
    assert.equal(store.dataVersion(), -1);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("idle: no snapshot reads and no polling faster than the change check", { timeout: 240_000 }, async (t) => {
  const report = await measureStalls({ size: 100, idleMs: 4_000, drainMs: 3_000, renderer: "changed" });
  assert.equal(report.idlePolling.mode, "changed");
  assert.equal(report.idlePolling.polls, 0, "the window read a snapshot while nothing changed");
  // No snapshot read also means nothing was written. Idle statements are the change check (once a
  // second) and the documented 30 s cadences' reads, which may land in the window: printed only.
  t.diagnostic(`idle statements: ${report.idle.child.statements} and ${report.idlePolling.child.statements} in two ${report.idle.windowMs} ms windows`);
  const intervals = report.idle.child.timers.filter((timer) => timer.kind === "interval" && timer.active);
  for (const timer of intervals)
    assert.ok(timer.delay >= 1_000, `a ${timer.delay} ms interval runs while idle: ${timer.site}`);
  const fast = intervals.filter((timer) => timer.delay < 30_000);
  assert.deepEqual(
    fast.map((timer) => timer.delay),
    [1_000],
    `only the change check may run more often than every 30 s: ${fast.map((timer) => timer.site).join("; ")}`,
  );
  for (const [phase, views] of [["sync", report.sync.views], ["drain", report.drain.views]] as const)
    for (const [name, latency] of Object.entries(views))
      t.diagnostic(`${latency.p99 <= 100 ? "within budget" : "OVER BUDGET (report only)"}: ${phase} ${name} p99 ${latency.p99} ms (n ${latency.n})`);
});
