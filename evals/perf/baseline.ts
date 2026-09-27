/**
 * The §1 baseline of docs/plans/2026-09-26-backend-optimization/plan.md, measured headless
 * against the backend as it is at the recorded SHA. Product code is only called, never changed;
 * a metric whose seam does not exist is recorded as not-measured with the missing seam.
 */
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { captureBatchSchema, defaultPrivacy, type Store } from "@magic/contracts";
import type { JudgmentGateway } from "@magic/ai";
import fixture from "../../fixtures/course.json";
import { distribution, notMeasured, scalar, type Metric } from "./stats";
import { syntheticCorpus, QUERIES } from "./synthetic";
import { recordSyntheticCanvas, replaySync, type Recording } from "./canvas-replay";

export const SIZES = [10, 100, 1000, 5000] as const;
const INGEST_REPEATS = 3;
const QUERY_RUNS = 5;
const SNAPSHOT_RUNS = 5;
const SYNC_RUNS = 5;
const OPEN_RUNS = 5;

const ms = (start: number) => performance.now() - start;
const hour = (h: number) => () => new Date(Date.UTC(2026, 8, 26, 15 + h, 0, 0));

function tempStore(label: string) {
  const directory = mkdtempSync(join(tmpdir(), `magic-perf-${label}-`));
  const file = join(directory, "perf.sqlite");
  return { directory, file, store: createStore(file) };
}
function fileSize(path: string) {
  return existsSync(path) ? statSync(path).size : 0;
}
const log = (line: string) => process.stderr.write(`[perf] ${line}\n`);

// ------------------------------------------------- 1a. First full Canvas sync, live-shaped (T17)
/**
 * The shape of the live account the first sync was measured on (2026-09-26 trial log: 54
 * module-item lists across 6 courses, 5 of 6 Pages lists hidden), scaled to the fixture's
 * 5 courses: 9 modules per course and 4 of 5 Pages lists hidden.
 */
export const LIVE_SHAPE = { modulesPerCourse: 9, hiddenPages: [102, 103, 104, 105] };
/** The latency model: each replayed response is held this long, so concurrency shows. */
export const LATENCY_MS = 150;
const FIRST_SYNC_RUNS = 3;
export async function canvasFirstSync() {
  const recording = await recordSyntheticCanvas(LIVE_SHAPE);
  const once = async (latencyMs: number, hostConcurrency?: number) => {
    const { directory, store } = tempStore("first-sync");
    try {
      return await replaySync(
        store,
        recording,
        hour(0),
        hostConcurrency ? { hostConcurrency, metadataConcurrency: hostConcurrency } : {},
        { latencyMs },
      );
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
  await once(0); // warm-up: module JIT and schema compilation
  const paced: Awaited<ReturnType<typeof once>>[] = [];
  for (let run = 0; run < FIRST_SYNC_RUNS; run++) paced.push(await once(LATENCY_MS));
  const instant = await once(0);
  // The per-host limit is configurable (default 6); what a wider limit would buy on this model.
  const sweep: Record<string, number> = {};
  for (const limit of [8, 10]) {
    const runs: number[] = [];
    for (let run = 0; run < FIRST_SYNC_RUNS; run++) runs.push((await once(LATENCY_MS, limit)).wallMs);
    sweep[limit] = Number(runs.sort((a, b) => a - b)[Math.floor(runs.length / 2)]!.toFixed(1));
  }
  const last = paced[paced.length - 1]!;
  return {
    transport: "replay",
    shape: LIVE_SHAPE,
    recording: { source: recording.source, responses: recording.entries.length },
    requests: scalar("requests", last.requests, FIRST_SYNC_RUNS),
    bytes: scalar("bytes", last.bytes, FIRST_SYNC_RUNS),
    misses: scalar("requests", last.misses, FIRST_SYNC_RUNS, { notes: "should be 0" }),
    maxInFlight: scalar("requests", last.maxInFlight, FIRST_SYNC_RUNS),
    wallMs: distribution("ms", paced.map((r) => r.wallMs), {
      notes: `product pacing on (jitter fixed at its mean), latency model ${LATENCY_MS} ms per request, one warm-up discarded`,
    }),
    wallMsNoLatency: scalar("ms", Number(instant.wallMs.toFixed(1)), 1, {
      notes: "the same sync with no latency model: pacing sleeps + CPU only; cannot show concurrency",
    }),
    wallMsAtHostLimit: Object.fromEntries(
      Object.entries(sweep).map(([limit, ms]) => [
        limit,
        scalar("ms", ms, FIRST_SYNC_RUNS, {
          notes: `median wall at per-host limit ${limit}, latency model ${LATENCY_MS} ms`,
        }),
      ]),
    ),
  };
}

// ---------------------------------------------------------------- 1. Canvas sync (replay)
async function canvasSync(recording: Recording) {
  const full: number[] = [],
    fullConnector: number[] = [],
    zero: number[] = [];
  let fullRequests = 0,
    fullBytes = 0,
    zeroRequests = 0,
    zeroBytes = 0,
    misses = 0,
    zeroChangeEvents = 0,
    zeroChangedResources = 0,
    resources = 0,
    perCourse: Record<string, { requests: number; bytes: number; spanMs: number }> = {},
    zeroPerCourse: Record<string, { requests: number; bytes: number }> = {};
  // One warm-up so module JIT and zod schema compilation are not billed to run 1.
  {
    const warm = tempStore("sync-warm");
    await replaySync(warm.store, recording, hour(0));
    warm.store.close();
    rmSync(warm.directory, { recursive: true, force: true });
  }
  for (let run = 0; run < SYNC_RUNS; run++) {
    const { directory, store } = tempStore("sync");
    try {
      const first = await replaySync(store, recording, hour(0));
      full.push(first.wallMs);
      fullConnector.push(first.connectorMs);
      fullRequests = first.requests;
      fullBytes = first.bytes;
      misses += first.misses;
      const before = new Map(store.resources().map((r) => [r.id, r.contentHash]));
      resources = before.size;
      const changesBefore = store.changes({ limit: 2000 }).length;
      const again = await replaySync(store, recording, hour(1));
      zero.push(again.wallMs);
      zeroRequests = again.requests;
      zeroBytes = again.bytes;
      misses += again.misses;
      zeroChangeEvents = store.changes({ limit: 2000 }).length - changesBefore;
      zeroChangedResources = store
        .resources()
        .filter((r) => before.get(r.id) !== r.contentHash).length;
      if (run === SYNC_RUNS - 1) {
        perCourse = Object.fromEntries(
          [...first.byCourse].map(([course, t]) => [
            course,
            { requests: t.requests, bytes: t.bytes, spanMs: Number((t.lastMs - t.firstMs).toFixed(3)) },
          ]),
        );
        zeroPerCourse = Object.fromEntries(
          [...again.byCourse].map(([course, t]) => [course, { requests: t.requests, bytes: t.bytes }]),
        );
      }
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
  // The same full sync with the connector's per-request pacing sleep replaced by a no-op:
  // what remains is connector parsing + store ingest (the part P2/P3 change).
  const noPacing: number[] = [];
  for (let run = 0; run < SYNC_RUNS; run++) {
    const { directory, store } = tempStore("sync-nopace");
    try {
      noPacing.push((await replaySync(store, recording, hour(0), { sleep: async () => {} })).wallMs);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
  const courses = Object.keys(perCourse).filter((c) => c !== "account").length;
  return {
    transport: "replay",
    recording: {
      source: recording.source,
      responses: recording.entries.length,
      bytes: recording.entries.reduce((a, e) => a + Buffer.byteLength(e.body), 0),
    },
    courses,
    resourcesStored: resources,
    replayMisses: scalar("requests", misses, SYNC_RUNS * 2, {
      notes: "requests not present in the recording (served as 404); should be 0",
    }),
    fullSync: {
      requests: scalar("requests", fullRequests, SYNC_RUNS),
      bytes: scalar("bytes", fullBytes, SYNC_RUNS),
      requestsPerCourse: scalar("requests/course", fullRequests / courses, SYNC_RUNS, {
        notes: "total including account-level reads, divided by synced courses",
      }),
      bytesPerCourse: scalar("bytes/course", fullBytes / courses, SYNC_RUNS),
      wallMs: distribution("ms", full, {
        notes: "connector + store ingest, replay transport, product pacing (25-100 ms/request, jitter fixed at mean), one warm-up discarded",
      }),
      wallMsNoPacing: distribution("ms", noPacing, {
        notes: "same sync with the pacing sleep stubbed out: connector CPU + store ingest only",
      }),
      wallMsPerCourse: distribution(
        "ms/course",
        full.map((v) => v / courses),
      ),
      connectorMs: distribution("ms", fullConnector, { notes: "wall minus store.ingest time" }),
      perCourse,
    },
    zeroChangeResync: {
      requests: scalar("requests", zeroRequests, SYNC_RUNS),
      bytes: scalar("bytes", zeroBytes, SYNC_RUNS),
      requestRatio: scalar("ratio", zeroRequests / fullRequests, SYNC_RUNS, {
        notes: "zero-change requests / full-sync requests; plan M2 adopts at <= 0.10",
      }),
      wallMs: distribution("ms", zero),
      changeEvents: scalar("events", zeroChangeEvents, SYNC_RUNS),
      changedResources: scalar("resources", zeroChangedResources, SYNC_RUNS),
      perCourse: zeroPerCourse,
    },
    liveRun: notMeasured("live run pending (operator present; plan §1)"),
  };
}

// ---------------------------------------------------------------- 2-4. Ingest, size, query, snapshot
interface SizeResult {
  ingest: Metric;
  dbSize: Metric;
  dbBytesPer1000: Metric;
  query: Metric;
  queryZeroHitShare: Metric;
  snapshot: { bytes: Metric; executeMs: Metric; cloneMs: Metric; jsonMs: Metric };
}

async function atSize(size: number): Promise<SizeResult> {
  const corpus = syntheticCorpus(size);
  const rates: number[] = [],
    sizes: number[] = [],
    walSizes: number[] = [];
  let queryResult: Pick<SizeResult, "query" | "queryZeroHitShare"> | undefined;
  let snapshot: SizeResult["snapshot"] | undefined;
  for (let repeat = 0; repeat < INGEST_REPEATS; repeat++) {
    const { directory, file, store } = tempStore(`ingest-${size}`);
    let closed = false;
    try {
      const start = performance.now();
      for (const batch of corpus.batches) store.ingest(batch);
      const elapsed = ms(start);
      rates.push(size / (elapsed / 1000));
      if (repeat === 0) {
        queryResult = queries(store);
        snapshot = await snapshots(store);
        closed = true; // core.close() closes the store
      } else {
        store.close();
        closed = true;
      }
      sizes.push(fileSize(file));
      walSizes.push(fileSize(`${file}-wal`));
    } finally {
      if (!closed) store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
  const bytes = sizes[sizes.length - 1]! + walSizes[walSizes.length - 1]!;
  return {
    ingest: distribution("resources/s", rates, {
      notes: `${corpus.batches.length} batches, ${corpus.textChars} body chars; each repeat on a fresh temp file`,
    }),
    dbSize: scalar("bytes", bytes, INGEST_REPEATS, {
      mainBytes: sizes[sizes.length - 1],
      walBytes: walSizes[walSizes.length - 1],
      notes: "file size after store.close() (WAL checkpointed on close)",
    }),
    dbBytesPer1000: scalar("bytes/1000 resources", (bytes / size) * 1000, INGEST_REPEATS),
    ...queryResult!,
    snapshot: snapshot!,
  };
}

function queries(store: Store): Pick<SizeResult, "query" | "queryZeroHitShare"> {
  for (const q of QUERIES) store.resources(q); // one warm-up pass
  const samples: number[] = [];
  let zeroHits = 0,
    hits = 0;
  for (let run = 0; run < QUERY_RUNS; run++)
    for (const q of QUERIES) {
      const start = performance.now();
      const found = store.resources(q);
      samples.push(ms(start));
      if (run === 0) {
        if (!found.length) zeroHits++;
        hits += found.length;
      }
    }
  return {
    query: distribution("ms", samples, {
      queries: QUERIES.length,
      runsPerQuery: QUERY_RUNS,
      meanHits: Number((hits / QUERIES.length).toFixed(2)),
      notes: "store.resources(search); 12 single terms + 12 question phrases, one warm-up pass",
    }),
    queryZeroHitShare: scalar("share", zeroHits / QUERIES.length, QUERIES.length, {
      notes: "share of the fixed queries returning no resource (prefix-AND matcher)",
    }),
  };
}

async function snapshots(store: Store): Promise<SizeResult["snapshot"]> {
  const core = createCore(store, {
    fixture: captureBatchSchema.parse(fixture),
    now: hour(0),
  });
  try {
    await core.execute({ type: "snapshot" }); // warm-up
    const exec: number[] = [],
      clone: number[] = [],
      json: number[] = [];
    let bytes = 0;
    for (let run = 0; run < SNAPSHOT_RUNS; run++) {
      let start = performance.now();
      const result = await core.execute({ type: "snapshot" });
      exec.push(ms(start));
      start = performance.now();
      structuredClone(result);
      clone.push(ms(start));
      start = performance.now();
      const text = JSON.stringify(result);
      json.push(ms(start));
      bytes = Buffer.byteLength(text);
    }
    return {
      bytes: scalar("bytes", bytes, SNAPSHOT_RUNS, {
        notes: "UTF-8 JSON of the CommandResult for {type:'snapshot'} (every command returns a full snapshot)",
      }),
      executeMs: distribution("ms", exec, { notes: "core.execute in-process (no IPC)" }),
      cloneMs: distribution("ms", clone, {
        notes: "structuredClone of the result: an in-process proxy for one IPC hop's serialization",
      }),
      jsonMs: distribution("ms", json),
    };
  } finally {
    await core.close();
  }
}

// ---------------------------------------------------------------- 5. DB open/migrate (in-process part of cold start)
function dbOpen(largest: number) {
  const fresh: number[] = [];
  for (let run = 0; run < OPEN_RUNS; run++) {
    const directory = mkdtempSync(join(tmpdir(), "magic-perf-open-"));
    try {
      const start = performance.now();
      const store = createStore(join(directory, "perf.sqlite"));
      fresh.push(ms(start));
      store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  const { directory, file, store } = tempStore("reopen");
  const reopen: number[] = [];
  try {
    for (const batch of syntheticCorpus(largest).batches) store.ingest(batch);
    store.close();
    for (let run = 0; run < OPEN_RUNS; run++) {
      const start = performance.now();
      const again = createStore(file);
      reopen.push(ms(start));
      again.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  return {
    freshCreateAndMigrateMs: distribution("ms", fresh, {
      notes: "createStore on a new file: open + schema migrations to the current version",
    }),
    [`reopen${largest}Ms`]: distribution("ms", reopen, {
      notes: `createStore on an existing ${largest}-resource DB (no migration needed)`,
    }),
  };
}

// ---------------------------------------------------------------- 7. Jev calls per sync
async function jevCalls(recording: Recording) {
  const { directory, store } = tempStore("jev");
  let calls = 0;
  const gateway: JudgmentGateway = {
    async evaluate() {
      calls++;
      return {
        kind: "other",
        probabilities: { other: 1 },
        model: "perf-counting-stub",
        questionVersion: "assignment.kind.v1",
      };
    },
  };
  // Real clock here: store.ingest stamps jobs with the wall clock, and the drain leases by core's now.
  const core = createCore(store, { fixture: captureBatchSchema.parse(fixture), gateway });
  try {
    await replaySync(store, recording, hour(0));
    const jobsQueued = store.jobs().filter((j) => j.status === "pending").length;
    core.wake();
    await core.settled();
    const defaultCalls = calls;
    // Upper bound: every sharing permission on, so the queued enrich jobs actually drain.
    store.setPrivacy({
      ...defaultPrivacy,
      mode: "selective_cloud",
      jevEnabled: true,
      shareCourseText: true,
      shareStudentWork: true,
      shareGrades: true,
      shareComments: true,
      shareCommunications: true,
    });
    calls = 0;
    core.wake();
    await core.settled();
    const enabledCalls = calls;
    calls = 0;
    await replaySync(store, recording, hour(1));
    core.wake();
    await core.settled();
    const zeroChangeCalls = calls;
    return {
      defaultPrivacy: scalar("calls/sync", defaultCalls, 1, {
        notes: "as shipped: local_only privacy, so the drain never reaches the gateway",
      }),
      jobsQueuedPerSync: scalar("jobs", jobsQueued, 1, {
        notes: "enrich.resource jobs a full sync queues; the Jev work a sync creates",
      }),
      allSharingEnabled: scalar("calls/sync", enabledCalls, 1, {
        notes: "counting stub gateway (no network) with every sharing permission on",
      }),
      zeroChangeResyncEnabled: scalar("calls/sync", zeroChangeCalls, 1),
      per100Checked: notMeasured("needs a batch judgment path; today each call carries one item (plan O9)"),
    };
  } finally {
    await core.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function runBaseline() {
  log("recording synthetic Canvas responses");
  const recording = await recordSyntheticCanvas();
  log(`recorded ${recording.entries.length} responses; replaying sync`);
  const sync = await canvasSync(recording);
  log("first full sync, live-shaped, latency model");
  const firstSync = await canvasFirstSync();
  const bySize: Record<string, SizeResult> = {};
  for (const size of SIZES) {
    log(`size ${size}: ingest, size, query, snapshot`);
    bySize[String(size)] = await atSize(size);
  }
  log("db open/migrate");
  const open = dbOpen(SIZES[SIZES.length - 1]);
  log("jev counter");
  const jev = await jevCalls(recording);
  const pick = <K extends keyof SizeResult>(key: K) =>
    Object.fromEntries(Object.entries(bySize).map(([size, r]) => [size, r[key]]));
  const electronSeam =
    "needs timing hooks in apps/desktop/src/main.ts (the MAGIC_SMOKE branch of scripts/desktop-smoke.ts reports only pass/fail; it emits no launch, first-paint, worker-ready, migrated or per-command timestamps)";
  const metrics = {
    canvasSync: sync,
    canvasFirstSync: firstSync,
    ingestThroughput: pick("ingest"),
    dbSize: pick("dbSize"),
    dbBytesPer1000: pick("dbBytesPer1000"),
    queryLatency: pick("query"),
    queryZeroHitShare: pick("queryZeroHitShare"),
    commandRoundTrip: {
      inProcess: pick("snapshot"),
      electronRendererWorkerRenderer: notMeasured(electronSeam),
    },
    coldStart: {
      launchToFirstPaint: notMeasured(electronSeam),
      launchToWorkerReady: notMeasured(electronSeam),
      launchToDbMigrated: notMeasured(electronSeam),
      inProcessDbOpen: open,
    },
    aiCostLedger: notMeasured("no ledger (T13)"),
    jevCallsPerCourseSync: jev,
  };
  return { metrics, recording };
}
