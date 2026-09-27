/**
 * Local benchmarks (owner: benchmarks). A synthetic university synced through the app's own
 * ingestion, core and pipeline loop, wired as worker.ts wires them: ingestion's onRunStart/onRunEnd
 * pause the drain and drive the recorder. Checks counts and shape only, never timings.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { captureBatchSchema } from "@magic/contracts";
import fixture from "../fixtures/course.json";
import { createIngestion } from "../apps/desktop/src/ingestion";
import { createBenchmarkBank, createBenchmarkRecorder, classifyRequest, type BenchmarkRecorder } from "../apps/desktop/src/benchmarks";
import { createSyntheticCanvasUniversity } from "../packages/connectors/src/canvas-fixture";
import { pipelineJobRegistry } from "../packages/core/src/jobs/default-registry";
import type { PublicClient } from "../packages/connectors/src/network";
import { readCourseSources } from "../apps/desktop/src/renderer/CourseSpaceDetails";

const origin = "https://canvas.wisc.edu";
const offline: PublicClient = {
  isCanvas: (url) => new URL(url).origin === origin,
  get: async () => { throw new Error("offline"); },
  text: async () => { throw new Error("offline"); },
  feed: async () => { throw new Error("offline"); },
  signedDownload: async () => { throw new Error("offline"); },
};

function rig() {
  const directory = mkdtempSync(join(tmpdir(), "magic-bench-"));
  const dbPath = join(directory, "workspace.sqlite");
  const store = createStore(dbPath);
  const core = createCore(store, { fixture: captureBatchSchema.parse(fixture), jobs: pipelineJobRegistry(), drain: { idleMs: 0, presentGapMs: 0 } });
  const bank = createBenchmarkBank(join(directory, "benchmarks.sqlite"));
  const university = createSyntheticCanvasUniversity({ origin, rateLimit: false });
  let recorder: BenchmarkRecorder | undefined;
  const starts: number[] = [];
  const measured = (url: string, init?: RequestInit) => {
    const started = performance.now();
    return university.fetch(url, init).then(async (response) => {
      const body = await response.clone().text();
      recorder?.request("canvas", url, { status: response.status, bytes: body.length, ms: performance.now() - started });
      return response;
    });
  };
  const ingestion = createIngestion(store, {
    directory,
    client: offline,
    canvasFetch: measured,
    secrets: async () => ({}),
    onSaved: (sourceId) => {
      recorder?.saved(sourceId);
      core.saved(sourceId);
    },
    onRunStart: () => {
      starts.push(Date.now());
      core.pipeline.syncStarted();
      recorder?.started();
    },
    onRunEnd: (run) => {
      core.pipeline.syncEnded();
      recorder?.ended(run);
    },
  });
  recorder = createBenchmarkRecorder({
    store,
    dbPath,
    bank,
    registry: core.jobs,
    pipelineTotals: () => core.pipeline.totals,
    present: () => false,
    drainPollMs: 20,
    drainWaitMs: 20_000,
  });
  return {
    store, core, bank, ingestion, recorder, starts,
    async close() {
      recorder!.close();
      await ingestion.stop();
      await core.close();
      bank.close();
    },
  };
}

test("Run benchmark banks one content-free record of a real synthetic sync and its drain", async () => {
  const r = rig();
  try {
    const record = await r.recorder.runBenchmark(() => r.ingestion.tick("manual"));
    assert.ok(record, "a record is returned");
    assert.equal(record.trigger, "benchmark");
    // Course websites are offline here, so the run is honestly partial, not signed out.
    assert.equal(record.status, "partial");
    assert.ok(record.sync!.diagnostics.read_failed! > 0);
    assert.equal(record.outcome!.sources.needs_sign_in ?? 0, 0);
    assert.ok(record.sync && record.sync.requests.total > 0);
    assert.ok(record.sync.requests.byService.canvas!.requests > 0);
    assert.ok(record.sync.phases.some((p) => p.phase === "canvas-lists"));
    // Only the five academic courses were read; non-course sites and the restricted course are
    // listed by Canvas as a course row only and are not in the per-course table.
    assert.deepEqual(record.sync.courses.map((c) => c.courseId), ["101", "102", "103", "104", "105"]);
    const { read, listedOnly } = readCourseSources(r.store.sources());
    assert.deepEqual(read.map((s) => s.courseId).sort(), ["101", "102", "103", "104", "105"]);
    assert.ok(read.every((s) => s.scope === "course"), "each read course is represented by its course row");
    assert.equal(listedOnly, 6);
    assert.ok(record.outcome && record.outcome.resources > 0 && record.outcome.courses > 0);
    assert.ok(record.outcome.passages > 0, "the pipeline wrote passages");
    assert.ok(record.pipeline && record.pipeline.drained && record.pipeline.done > 0);
    assert.equal(record.pipeline.syncsDuringWait, 0);
    assert.ok(record.query && record.query.queries > 0);
    assert.equal(record.machine.schemaVersion > 0, true);
    // Content-free: no URL, host, course name or coursework title anywhere in the banked JSON.
    const json = JSON.stringify(r.bank.get(record.id));
    for (const leak of ["://", "https:", "canvas.wisc.edu", "courses.synthetic.test", "COMP SCI", "Synthetic course", "Synthetic assignment", "syllabus_body"])
      assert.ok(!json.includes(leak), `banked record contains ${leak}`);
    const list = r.bank.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.id, record.id);
    assert.equal(list[0]!.requests, record.sync.requests.total);
  } finally {
    await r.close();
  }
});

test("a skipped background tick is not a run: no pause of the drain, nothing banked", async () => {
  const r = rig();
  try {
    await r.recorder.runBenchmark(() => r.ingestion.tick("manual"));
    const starts = r.starts.length;
    for (let i = 0; i < 5; i++) await r.ingestion.tick("background"); // not due: the coordinator skips
    assert.equal(r.starts.length, starts, "onRunStart only fires when a read really begins");
    assert.equal(r.bank.list().length, 1);
  } finally {
    await r.close();
  }
});

test("a finished job is not rewritten to 'Interrupted.' by skipped ticks", async () => {
  const r = rig();
  try {
    r.store.ingest(captureBatchSchema.parse(fixture));
    r.core.saved(captureBatchSchema.parse(fixture).source.id);
    for (let i = 0; i < 10; i++) {
      await r.ingestion.tick("background"); // no sources due: previously paused and aborted the slice
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await r.core.pipeline.runToIdle();
    const interrupted = r.store.jobs().filter((j) => j.error === "Interrupted.");
    assert.deepEqual(interrupted.map((j) => j.kind), []);
  } finally {
    await r.close();
  }
});

test("purge drops a run still being measured and clears the bank", async () => {
  const r = rig();
  try {
    const first = await r.recorder.runBenchmark(() => r.ingestion.tick("manual"));
    assert.ok(first);
    r.recorder.purge();
    assert.equal(r.bank.list().length, 0);
    r.recorder.planning({ startedAt: new Date().toISOString(), wallMs: 1200, ok: false, failed: ["uw_myuw:refresh_failed"], requests: 3, bytes: 900 });
    const [planning] = r.bank.list();
    assert.equal(planning!.trigger, "planning");
    assert.equal(planning!.status, "partial");
  } finally {
    await r.close();
  }
});

test("requests are classified by path shape only", () => {
  assert.deepEqual(classifyRequest("canvas", "https://canvas.wisc.edu/courses/12/files/9/download?verifier=x"), { service: "download", phase: "documents", courseId: "12" });
  assert.deepEqual(classifyRequest("canvas", "https://canvas.wisc.edu/api/v1/courses/12/pages/week-1"), { service: "canvas", phase: "canvas-pages", courseId: "12" });
  assert.deepEqual(classifyRequest("canvas", "https://canvas.wisc.edu/api/v1/courses/12/assignments?per_page=100"), { service: "canvas", phase: "canvas-lists", courseId: "12" });
  assert.deepEqual(classifyRequest("feed", "https://canvas.wisc.edu/feeds/calendars/course_SECRET.ics"), { service: "feed", phase: "calendar", courseId: null });
  assert.deepEqual(classifyRequest("public", "https://prof.example.edu/~name/cs400/"), { service: "public", phase: "websites", courseId: null });
});
