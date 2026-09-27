/**
 * Performance budgets (fast, deterministic, CI). Synthetic MT1 coursework only (evals/perf/synthetic.ts).
 *
 * - Statements per call are exact: a cap and a "does not grow with the data" check catch an N+1
 *   whatever the machine's speed.
 * - Times are divided by a same-run calibration (a fixed SQLite, zlib and JSON workload), so a
 *   budget compares ratios, which travel across machines better than milliseconds.
 * - Every recorded metric fails when it worsens by more than 25% against evals/perf/budgets.json.
 *
 * Run on its own (`pnpm test:budgets`; CI runs it as a separate step after the suite), so the
 * parallel suite's load doesn't skew its timings. Re-record after an intended change:
 * MAGIC_BUDGETS_RECORD=1 pnpm test:budgets
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { captureBatchSchema } from "@magic/contracts";
import { agenda, courseGraph, createPipelineReferences } from "../../packages/core/src/graph/index";
import { pipelineJobRegistry } from "../../packages/core/src/jobs/default-registry";
import { createLearningRouter } from "../../packages/learning/src/router";
import { createNotesService } from "../../packages/notes/src/index";
import { createStudyContextResolver } from "../../apps/desktop/src/learning-context";
import { syntheticCorpus, QUERIES, COURSES } from "../../evals/perf/synthetic";
import { recordSyntheticCanvas, replaySync } from "../../evals/perf/canvas-replay";
import { LIVE_SHAPE } from "../../evals/perf/baseline";
import fixture from "../../fixtures/course.json";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUDGETS = join(root, "evals", "perf", "budgets.json");
const RECORD = process.env.MAGIC_BUDGETS_RECORD === "1";
const TOLERANCE = 0.25;
const SIZE = 1000;
const SMALL = 200;
const NOW = "2026-09-30T15:00:00.000Z";
const TODAY = "2026-09-30";
const TZ = "America/Chicago";
const SUMMARY_MAX_BYTES = 64 * 1024;

// ------------------------------------------------------------------ statement counter
let statements = 0;
for (const method of ["all", "get", "run", "iterate"] as const) {
  const original = StatementSync.prototype[method] as (...args: unknown[]) => unknown;
  (StatementSync.prototype as unknown as Record<string, unknown>)[method] = function (this: StatementSync, ...args: unknown[]) {
    statements++;
    return original.apply(this, args);
  };
}
async function count(run: () => unknown): Promise<number> {
  const before = statements;
  await run();
  return statements - before;
}
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)]!;
};

/** A fixed workload of the backend's own kinds of work: SQLite reads, zlib and JSON (about 10 ms). */
const calibration = (() => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v BLOB)");
  const insert = db.prepare("INSERT INTO t (v) VALUES (?)");
  const text = "the quick brown fox jumps over the lazy dog ".repeat(40);
  for (let i = 0; i < 2000; i++) insert.run(deflateRawSync(Buffer.from(JSON.stringify({ i, text }))));
  const select = db.prepare("SELECT * FROM t");
  return () => {
    const t = performance.now();
    let n = 0;
    for (const row of select.all() as { v: Uint8Array }[]) n += (JSON.parse(inflateRawSync(row.v).toString()) as { i: number }).i;
    if (n < 0) throw new Error("unreachable");
    return performance.now() - t;
  };
})();
/** A fixed write workload for ingest: compressed JSON rows into a new table, in one transaction. */
const writeCalibration = () => {
  const db = new DatabaseSync(":memory:");
  const text = "the quick brown fox jumps over the lazy dog ".repeat(40);
  const t = performance.now();
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, h TEXT, v BLOB); CREATE INDEX t_h ON t (h); BEGIN");
  const insert = db.prepare("INSERT INTO t (h, v) VALUES (?, ?)");
  for (let i = 0; i < 3000; i++) insert.run(String(i * 7919), deflateRawSync(Buffer.from(JSON.stringify({ i, text }))));
  db.exec("COMMIT");
  const ms = performance.now() - t;
  db.close();
  return ms;
};
const timed = (run: () => unknown) => () => {
  const t = performance.now();
  run();
  return performance.now() - t;
};
/**
 * The operation's time over a reference's, measured back to back so both see the same machine
 * load (other test files run in parallel); the least of `n` pairs, so a stall is not a regression.
 * The reference does the same kind of work (a full resource read, a write workload), so a GC
 * pause or a busy core slows both alike.
 */
async function calibrated(run: () => unknown, n: number, reference: () => number = calibration): Promise<number> {
  await run(); // warm-up
  reference();
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const before = reference();
    const t = performance.now();
    await run();
    const ms = performance.now() - t;
    best = Math.min(best, ms / Math.max(before, reference()));
  }
  return best;
}

// ------------------------------------------------------------------ the workspace under test
interface Workspace {
  store: ReturnType<typeof createStore>;
  file: string;
  close(): Promise<void>;
  core: ReturnType<typeof createCore>;
  router: ReturnType<typeof createLearningRouter>;
  notes: ReturnType<typeof createNotesService>;
  course: { accountScope: string; courseId: string };
  assignmentId: string;
  anchorIds: string[];
}
async function workspace(size: number): Promise<Workspace> {
  const directory = mkdtempSync(join(tmpdir(), "magic-budgets-"));
  const file = join(directory, "workspace.sqlite");
  const store = createStore(file, { now: () => new Date(NOW) });
  for (const batch of syntheticCorpus(size).batches) store.ingest(batch);
  const core = createCore(store, {
    fixture: captureBatchSchema.parse(fixture),
    jobs: pipelineJobRegistry(),
    now: () => new Date(NOW),
    timeZone: TZ,
  });
  const resolve = createStudyContextResolver(store, core);
  const router = createLearningRouter({
    store: store.learning,
    resolveContext: (id) => resolve(id),
    analyticsReferences: () => createPipelineReferences(store),
    now: () => new Date(NOW),
  });
  const notes = createNotesService({ store, now: () => new Date(NOW) });
  const course = { accountScope: "perf-synthetic", courseId: COURSES[0].id };
  const assignments = store.resources().filter((r) => r.kind === "assignment" && r.courseId === course.courseId);
  return {
    store,
    file,
    core,
    router,
    notes,
    course,
    assignmentId: assignments[0]!.id,
    anchorIds: assignments.slice(0, 10).map((r) => r.id),
    async close() {
      await core.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** The hot operations: each one's statements per call is capped and must not grow with the data. */
function hotOperations(w: Workspace): Record<string, { run: () => unknown; scaleFree: boolean; todo?: string }> {
  const signal = new AbortController().signal;
  const query = (request: unknown) => w.core.query(request as never);
  return {
    "store.resources": { run: () => w.store.resources(), scaleFree: true },
    "query.summary": { run: () => query({ view: "summary" }), scaleFree: true },
    "query.resources (course page)": { run: () => query({ view: "resources", ...w.course, limit: 50 }), scaleFree: true },
    "query.resource": { run: () => query({ view: "resource", id: w.assignmentId }), scaleFree: true },
    "store.searchPassages": { run: () => w.store.searchPassages({ query: "how do I find the eigenvalue of a matrix", k: 8 }), scaleFree: true },
    "core.context (local)": { run: () => w.core.context(w.assignmentId, "local"), scaleFree: true },
    "core.snapshot": { run: () => w.core.snapshot(), scaleFree: true },
    "notes.tree": { run: () => w.notes.handle({ op: "notes.tree", ...w.course }, signal), scaleFree: true },
    "learning.knowledge.state (10 anchors)": {
      run: () => w.router.handle({ op: "knowledge.state", courseId: w.course.courseId, anchorIds: w.anchorIds }, signal),
      scaleFree: true,
    },
    "graph.courseGraph": {
      run: () => courseGraph(w.store, w.course),
      scaleFree: false,
      todo: "one materialFacts and one resourceRefs read per material; a batch read needs a new GraphStore method (contracts)",
    },
    "graph.agenda": {
      run: () => agenda(w.store, { date: TODAY, tz: TZ, days: 14, now: NOW }),
      scaleFree: false,
      todo: "three reads per agenda entry (the assignment, its stored references, its covering facts); batching needs GraphStore methods (contracts)",
    },
    "workspace.due": { run: () => w.core.execute({ type: "workspace", value: { verb: "due", days: 7 } }), scaleFree: true },
  };
}

// ------------------------------------------------------------------ measure once, assert per budget
interface Measured {
  calibrationMs: number;
  /** Ratios to the calibration: lower is better, except `ingestRate` (higher is better). */
  ratios: Record<string, number>;
  /** Exact or deterministic values: lower is better. */
  values: Record<string, number>;
  statements: Record<string, number>;
  small: Record<string, number>;
}
let measured: Promise<Measured> | undefined;
function measure(): Promise<Measured> {
  return (measured ??= (async () => {
    const calibrationMs = Math.min(...Array.from({ length: 5 }, () => calibration()));
    const small = await workspace(SMALL);
    const smallStatements: Record<string, number> = {};
    try {
      for (const [name, op] of Object.entries(hotOperations(small))) {
        await op.run();
        smallStatements[name] = await count(op.run);
      }
    } finally {
      await small.close();
    }
    const w = await workspace(SIZE);
    try {
      const stmts: Record<string, number> = {};
      for (const [name, op] of Object.entries(hotOperations(w))) {
        await op.run();
        stmts[name] = await count(op.run);
      }
      // Search: each query's calibrated cost, then the p50 and p95 across the 24 queries.
      const search: number[] = [];
      let zeroHits = 0;
      for (const q of QUERIES) {
        if (!w.store.searchPassages({ query: q, k: 8 }).hits.length) zeroHits++;
        search.push(await calibrated(() => w.store.searchPassages({ query: q, k: 8 }), 3));
      }
      // Agenda and summary: in units of one full resource read of the same workspace.
      const listRead = timed(() => w.store.resources());
      // Agenda: each of 8 days across the term, then the p95 across days.
      const agendas: number[] = [];
      for (let d = 0; d < 8; d++) {
        const date = new Date(Date.UTC(2026, 8, 28 + d * 7)).toISOString().slice(0, 10);
        agendas.push(await calibrated(() => agenda(w.store, { date, tz: TZ, days: 14, now: `${date}T15:00:00.000Z` }), 4, listRead));
      }
      const summary = await calibrated(() => w.core.query({ view: "summary" }), 5, listRead);
      // Ingest: in memory (disk scanners are not the store), against a fixed write workload.
      const corpus = syntheticCorpus(SIZE).batches;
      const ingest = await calibrated(() => {
        const memory = createStore(":memory:", { now: () => new Date(NOW) });
        for (const batch of corpus) memory.ingest(batch);
        memory.close();
      }, 3, writeCalibration);
      const summaryBytes = Buffer.byteLength(JSON.stringify(w.core.query({ view: "summary" })));
      // Canvas sync through the replay transport (evals/perf): requests and bytes are exact.
      const recording = await recordSyntheticCanvas(LIVE_SHAPE, { sleep: async () => {} });
      const replayStore = createStore(":memory:");
      const hour = (h: number) => () => new Date(Date.UTC(2026, 8, 26, 15 + h));
      const full = await replaySync(replayStore, recording, hour(0), { sleep: async () => {} });
      const again = await replaySync(replayStore, recording, hour(1), { sleep: async () => {} });
      replayStore.close();
      const snapshotBytes = Buffer.byteLength(JSON.stringify(w.core.snapshot()));
      return {
        calibrationMs,
        ratios: {
          ingestRate: SIZE / ingest,
          searchP95: pct(search, 95),
          searchP50: pct(search, 50),
          agendaP95: pct(agendas, 95),
          summary: summary,
        },
        values: {
          summaryBytes,
          snapshotBytes,
          searchZeroHitShare: zeroHits / QUERIES.length,
          dbBytesPer1000: (statSync(w.file).size / SIZE) * 1000,
          syncRequests: full.requests,
          syncBytes: full.bytes,
          syncReplayMisses: full.misses + again.misses,
          zeroChangeSyncRequests: again.requests,
          zeroChangeSyncBytes: again.bytes,
        },
        statements: stmts,
        small: smallStatements,
      };
    } finally {
      await w.close();
    }
  })());
}

interface Budgets {
  note: string;
  recordedAt: string;
  machine: { calibrationMs: number };
  size: number;
  tolerance: number;
  ratios: Record<string, number>;
  values: Record<string, number>;
  statements: Record<string, number>;
}
function budgets(): Budgets | undefined {
  return existsSync(BUDGETS) ? (JSON.parse(readFileSync(BUDGETS, "utf8")) as Budgets) : undefined;
}

test("record budgets (MAGIC_BUDGETS_RECORD=1 only)", { skip: !RECORD }, async () => {
  const m = await measure();
  const record: Budgets = {
    note: "Synthetic MT1 at 1,000 resources. ratios: an operation's time over a reference run back to back with it (least of several pairs). searchP50/P95: across 24 queries, over a fixed SQLite+zlib+JSON read workload. agendaP95 (across 8 days) and summary: in full resource reads of the same workspace. ingestRate: resources per unit of a fixed SQLite write workload (higher is better). Re-record: MAGIC_BUDGETS_RECORD=1 pnpm test:budgets",
    recordedAt: new Date().toISOString(),
    machine: { calibrationMs: Number(m.calibrationMs.toFixed(3)) },
    size: SIZE,
    tolerance: TOLERANCE,
    ratios: Object.fromEntries(Object.entries(m.ratios).map(([k, v]) => [k, Number(v.toFixed(4))])),
    values: Object.fromEntries(Object.entries(m.values).map(([k, v]) => [k, Number(v.toFixed(4))])),
    statements: m.statements,
  };
  writeFileSync(BUDGETS, `${JSON.stringify(record, null, 2)}\n`);
});

test("ingest rate at 1,000 resources stays above its floor", async () => {
  const m = await measure();
  const b = budgets();
  assert.ok(b, "evals/perf/budgets.json is missing; record it");
  assert.ok(
    m.ratios.ingestRate >= b.ratios.ingestRate! * (1 - TOLERANCE),
    `ingest ${m.ratios.ingestRate.toFixed(3)} vs floor ${(b.ratios.ingestRate! * (1 - TOLERANCE)).toFixed(3)} (calibrated resources/s)`,
  );
});

test("passage search, agenda and summary: calibrated times within 25% of the recorded budget", async () => {
  const m = await measure();
  const b = budgets()!;
  for (const key of ["searchP95", "searchP50", "agendaP95", "summary"])
    assert.ok(
      m.ratios[key]! <= b.ratios[key]! * (1 + TOLERANCE),
      `${key}: ${m.ratios[key]!.toFixed(3)} vs budget ${(b.ratios[key]! * (1 + TOLERANCE)).toFixed(3)} (x calibration ${m.calibrationMs.toFixed(1)} ms)`,
    );
});

test("scoped summary stays under 64 KB; payloads and search quality within 25%", async () => {
  const m = await measure();
  const b = budgets()!;
  assert.ok(m.values.summaryBytes! <= SUMMARY_MAX_BYTES, `summary ${m.values.summaryBytes} bytes`);
  for (const key of Object.keys(b.values))
    assert.ok(
      m.values[key]! <= b.values[key]! * (1 + TOLERANCE) + (b.values[key] === 0 ? 1e-9 : 0),
      `${key}: ${m.values[key]} vs budget ${b.values[key]! * (1 + TOLERANCE)}`,
    );
});

test("statements per call: capped for each hot operation", async () => {
  const m = await measure();
  const b = budgets()!;
  for (const [name, cap] of Object.entries(b.statements))
    assert.ok((m.statements[name] ?? Infinity) <= cap, `${name}: ${m.statements[name]} statements, cap ${cap}`);
});

test("statements per call do not grow with the data (200 vs 1,000 resources)", async () => {
  const m = await measure();
  const ops = hotOperations({} as Workspace);
  for (const [name, op] of Object.entries(ops))
    if (op.scaleFree) assert.equal(m.statements[name], m.small[name], `${name}: ${m.small[name]} at ${SMALL}, ${m.statements[name]} at ${SIZE}`);
});

for (const [name, op] of Object.entries(hotOperations({} as Workspace)))
  if (!op.scaleFree)
    test(`statements per call do not grow with the data: ${name}`, { todo: op.todo }, async () => {
      const m = await measure();
      assert.equal(m.statements[name], m.small[name], `${name}: ${m.small[name]} at ${SMALL}, ${m.statements[name]} at ${SIZE}`);
    });

test(
  "learning, notes and pack commands return their result without a full snapshot",
  { todo: "core.execute (packages/core/src/index.ts) returns snapshot() for every command until those are slimmed" },
  async () => {
    const w = await workspace(SMALL);
    try {
      const learning = await w.core.execute({ type: "learning", request: { op: "study.path", courseId: w.course.courseId } });
      const notes = await w.core.execute({ type: "notes", request: { op: "notes.templates" } });
      assert.equal("snapshot" in learning, false, "learning");
      assert.equal("snapshot" in notes, false, "notes");
    } finally {
      await w.close();
    }
  },
);
