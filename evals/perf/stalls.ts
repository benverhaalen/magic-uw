/**
 * Stall audit harness: `pnpm tsx evals/perf/stalls.ts [--size 1000] [--idle 12000] [--json out.json]`.
 *
 * Drives the real utility-process worker (apps/desktop/src/worker.ts) in a Node child process,
 * with this process playing main: it answers the worker's `source-fetch` from a synthetic Canvas
 * university (packages/connectors/src/canvas-fixture.ts, 150 ms per request) and sends the same
 * messages main sends for each student action. No Electron window, no network, no real data:
 * the workspace is evals/perf/synthetic.ts coursework.
 *
 * The child is started with `--import` of this same file (MAGIC_STALLS_ROLE=worker), which
 * installs the instruments before the worker loads:
 * - `process.parentPort`, shimmed over Node's IPC channel (advanced serialization, like
 *   Electron's structured clone);
 * - event-loop delay (monitorEventLoopDelay) and a 10 ms drift detector that records every block
 *   over 50 ms with the operations and SQL that ran inside it;
 * - node:sqlite statements (count, time, every one over 20 ms with its SQL) and `exec` calls;
 * - timers (every setInterval and setTimeout: callsite, cadence, fires);
 * - synchronous fs calls (`*Sync`) with their callsite, and JSON parse/stringify over 1 MB.
 *
 * Per request it records round-trip time, statements and response bytes; main's cost to forward
 * a response to the renderer is measured here as a v8 serialize of the result (a structured-clone
 * proxy). `measureStalls()` returns the whole report; tests/perf/stalls.test.ts gates its counts.
 */
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { serialize } from "node:v8";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const here = fileURLToPath(import.meta.url);
const root = resolve(dirname(here), "..", "..");
const ROLE = process.env.MAGIC_STALLS_ROLE;

// ============================================================================ shared shapes
export interface LoopStats { p50: number; p99: number; max: number; blocks: Block[] }
export interface Block { ms: number; at: number; ops: string[]; sql: { sql: string; ms: number }[] }
export interface TimerRecord { kind: "interval" | "timeout"; delay: number; site: string; created: number; fires: number; active: boolean }
export interface ChildReport {
  loop: LoopStats;
  statements: number;
  sqlMs: number;
  slowSql: { sql: string; ms: number; op: string }[];
  execs: { sql: string; ms: number }[];
  timers: TimerRecord[];
  syncFs: Record<string, number>;
  bigJson: { op: string; bytes: number; ms: number }[];
  requests: { label: string; ms: number; statements: number; sqlMs: number }[];
  cpuMs: number;
}

// ============================================================================ child (the worker)
function installChild() {
  const { DatabaseSync, StatementSync } = require("node:sqlite") as typeof import("node:sqlite");
  const fs = require("node:fs") as typeof import("node:fs");
  const { syncBuiltinESMExports } = require("node:module") as typeof import("node:module");
  const realSetInterval = globalThis.setInterval,
    realSetTimeout = globalThis.setTimeout,
    realClearInterval = globalThis.clearInterval,
    realClearTimeout = globalThis.clearTimeout;
  const t0 = performance.now();
  const now = () => performance.now() - t0;
  // ----- operation labels: what the worker was doing (message handlers in flight)
  const inFlight = new Map<string, { label: string; start: number; statements: number; sqlMs: number }>();
  let statements = 0,
    sqlMs = 0;
  let window = freshWindow();
  function freshWindow() {
    return {
      statements0: statements,
      sqlMs0: sqlMs,
      slowSql: [] as ChildReport["slowSql"],
      execs: [] as ChildReport["execs"],
      syncFs: {} as Record<string, number>,
      bigJson: [] as ChildReport["bigJson"],
      requests: [] as ChildReport["requests"],
      blocks: [] as Block[],
      cpu: process.cpuUsage(),
      recentOps: [] as { at: number; label: string }[],
      recentSql: [] as { at: number; sql: string; ms: number }[],
    };
  }
  const opLabel = () => [...new Set([...inFlight.values()].map((v) => v.label))].join(",") || "background";
  // ----- SQL
  for (const method of ["all", "get", "run", "iterate"] as const) {
    const original = StatementSync.prototype[method] as (...args: unknown[]) => unknown;
    (StatementSync.prototype as unknown as Record<string, unknown>)[method] = function (this: import("node:sqlite").StatementSync, ...args: unknown[]) {
      const start = performance.now();
      try {
        return original.apply(this, args);
      } finally {
        const ms = performance.now() - start;
        statements++;
        sqlMs += ms;
        if (ms > 5) {
          const sql = this.sourceSQL.replace(/\s+/g, " ").slice(0, 120);
          window.recentSql.push({ at: now(), sql, ms });
          if (window.recentSql.length > 400) window.recentSql.splice(0, 200);
          if (ms > 20) window.slowSql.push({ sql, ms: round(ms), op: opLabel() });
        }
      }
    };
  }
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (this: InstanceType<typeof DatabaseSync>, sql: string) {
    const start = performance.now();
    try {
      return exec.call(this, sql);
    } finally {
      const ms = performance.now() - start;
      if (ms > 5) window.execs.push({ sql: sql.replace(/\s+/g, " ").slice(0, 120), ms: round(ms) });
    }
  };
  // ----- synchronous fs
  const site = (skip = 3) => {
    const lines = (new Error().stack ?? "").split("\n").slice(skip);
    const frame = lines.find((l) => /[\\/](apps|packages)[\\/]/.test(l) && !l.includes("stalls.ts")) ?? lines[0] ?? "";
    return frame.trim().replace(/^at /, "").replace(/\(?[A-Za-z]:[\\/].*?[\\/](apps|packages)[\\/]/, "$1/").replace(/\)$/, "");
  };
  for (const name of Object.keys(fs) as (keyof typeof fs)[]) {
    if (!String(name).endsWith("Sync") || typeof fs[name] !== "function") continue;
    const original = fs[name] as unknown as (...args: unknown[]) => unknown;
    (fs as unknown as Record<string, unknown>)[name] = function (this: unknown, ...args: unknown[]) {
      const key = `${String(name)} @ ${site()}`;
      window.syncFs[key] = (window.syncFs[key] ?? 0) + 1;
      return original.apply(this, args);
    };
  }
  syncBuiltinESMExports();
  // ----- JSON over 1 MB
  const parse = JSON.parse,
    stringify = JSON.stringify;
  JSON.parse = function (text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) {
    const start = performance.now();
    const value = parse(text, reviver);
    if (typeof text === "string" && text.length > 1_000_000) window.bigJson.push({ op: `parse (${opLabel()})`, bytes: text.length, ms: round(performance.now() - start) });
    return value;
  } as typeof JSON.parse;
  JSON.stringify = function (...args: Parameters<typeof JSON.stringify>) {
    const start = performance.now();
    const text = stringify(...args);
    if (typeof text === "string" && text.length > 1_000_000) window.bigJson.push({ op: `stringify (${opLabel()})`, bytes: text.length, ms: round(performance.now() - start) });
    return text;
  } as typeof JSON.stringify;
  // ----- timers (the instruments' own use the real functions)
  const timers = new Map<object, TimerRecord>();
  const trackTimer = (kind: TimerRecord["kind"], real: typeof setTimeout | typeof setInterval) =>
    function (this: unknown, callback: (...a: unknown[]) => void, delay?: number, ...rest: unknown[]) {
      const record: TimerRecord = { kind, delay: Number(delay) || 0, site: site(), created: round(now()), fires: 0, active: true };
      const handle = (real as (...a: unknown[]) => object)(function (this: unknown, ...a: unknown[]) {
        record.fires++;
        if (kind === "timeout") record.active = false;
        return callback.apply(this, a);
      }, delay, ...rest);
      timers.set(handle, record);
      return handle;
    };
  globalThis.setInterval = trackTimer("interval", realSetInterval) as unknown as typeof setInterval;
  globalThis.setTimeout = trackTimer("timeout", realSetTimeout) as unknown as typeof setTimeout;
  globalThis.clearInterval = ((h?: object) => {
    const r = h && timers.get(h);
    if (r) r.active = false;
    return realClearInterval(h as never);
  }) as typeof clearInterval;
  globalThis.clearTimeout = ((h?: object) => {
    const r = h && timers.get(h);
    if (r) r.active = false;
    return realClearTimeout(h as never);
  }) as typeof clearTimeout;
  // ----- event loop
  // MAGIC_STALLS_LIGHT=1: no loop instruments, so idle CPU is the worker's own.
  const light = process.env.MAGIC_STALLS_LIGHT === "1";
  let histogram = monitorEventLoopDelay({ resolution: 10 });
  if (!light) histogram.enable();
  let last = performance.now();
  const drift = realSetInterval(() => {
    const t = performance.now(),
      gap = t - last - 10;
    last = t;
    if (gap > 50) {
      const from = now() - gap - 10;
      window.blocks.push({
        ms: round(gap),
        at: round(from),
        ops: [...new Set([...window.recentOps.filter((o) => o.at >= from - 5).map((o) => o.label), opLabel()])],
        sql: window.recentSql.filter((s) => s.at >= from).sort((a, b) => b.ms - a.ms).slice(0, 3).map((s) => ({ sql: s.sql, ms: round(s.ms) })),
      });
    }
  }, 10);
  drift.unref();
  if (light) realClearInterval(drift);
  // ----- parentPort over Node IPC
  type Listener = (event: { data: unknown }) => void;
  const listeners: Listener[] = [];
  const port = {
    on(event: string, listener: Listener) {
      if (event === "message") listeners.push(listener);
      return port;
    },
    postMessage(message: { kind?: string; id?: string }) {
      const request = message?.id && ["response", "local-response"].includes(String(message.kind)) ? inFlight.get(message.id) : undefined;
      if (request) {
        inFlight.delete(message.id!);
        window.requests.push({ label: request.label, ms: round(performance.now() - request.start), statements: statements - request.statements, sqlMs: round(sqlMs - request.sqlMs) });
      }
      process.send?.(message);
    },
  };
  Object.defineProperty(process, "parentPort", { value: port });
  (globalThis as { __dirname?: string }).__dirname = join(root, "apps", "desktop", "src");
  process.on("message", (data: { kind?: string; id?: string; [k: string]: unknown }) => {
    if (data?.kind === "__stalls-reset") {
      histogram.disable();
      histogram = monitorEventLoopDelay({ resolution: 10 });
      if (!light) histogram.enable();
      for (const record of timers.values()) record.fires = 0;
      window = freshWindow();
      process.send?.({ kind: "__stalls-reset-done" });
      return;
    }
    if (data?.kind === "__stalls-report") {
      const cpu = process.cpuUsage(window.cpu);
      const report: ChildReport = {
        loop: { p50: round(histogram.percentile(50) / 1e6), p99: round(histogram.percentile(99) / 1e6), max: round(histogram.max / 1e6), blocks: window.blocks },
        statements: statements - window.statements0,
        sqlMs: round(sqlMs - window.sqlMs0),
        slowSql: window.slowSql,
        execs: window.execs,
        timers: [...timers.values()].filter((t) => t.active || t.fires > 0).map((t) => ({ ...t })),
        syncFs: window.syncFs,
        bigJson: window.bigJson,
        requests: window.requests,
        cpuMs: round((cpu.user + cpu.system) / 1000),
      };
      process.send?.({ kind: "__stalls-report", report });
      return;
    }
    if (data?.id && ["command", "query", "graph", "refresh", "local", "planning-sync"].includes(String(data.kind))) {
      const command = data.command as { type?: string; request?: { op?: string }; value?: { mode?: string } } | undefined;
      const query = data.query as { view?: string; type?: string } | undefined;
      const label =
        data.kind === "command"
          ? `command:${command?.type}${command?.request?.op ? `/${command.request.op}` : ""}`
          : data.kind === "query"
            ? `query:${query?.view}`
            : data.kind === "graph"
              ? `graph:${query?.type}`
              : String(data.kind);
      inFlight.set(data.id, { label, start: performance.now(), statements, sqlMs });
      window.recentOps.push({ at: now(), label });
      if (window.recentOps.length > 400) window.recentOps.splice(0, 200);
    } else if (data?.kind) {
      window.recentOps.push({ at: now(), label: `msg:${data.kind}` });
    }
    for (const listener of listeners) listener({ data });
  });
}
const round = (n: number) => Math.round(n * 10) / 10;

// ============================================================================ parent (main)
export interface Latencies { n: number; p50: number; p99: number; max: number; over100: number }
export interface ActionCost {
  action: string;
  messages: number;
  wallMs: number;
  workerMs: number;
  statements: number;
  responseBytes: number;
  forwardMs: number;
  fullSnapshot: boolean;
  syncOrProbe: boolean;
}
export interface StallReport {
  size: number;
  startup: { readyMs: number };
  actions: ActionCost[];
  idle: { windowMs: number; quiesceMs: number; child: ChildReport; mainLoop: { p99: number; max: number } };
  idlePolling: { windowMs: number; mode: "changed" | "poll"; polls: number; child: ChildReport; perPoll: { workerMs: number; statements: number; bytes: number; forwardMs: number } };
  sync: { wallMs: number; result: string; views: Record<string, Latencies>; snapshotPoll: Latencies; snapshotReads: number; child: ChildReport; mainLoop: { p99: number; max: number } };
  drain: { windowMs: number; views: Record<string, Latencies>; snapshotReads: number; child: ChildReport };
  canvasRequests: number;
}
export interface StallOptions { size?: number; idleMs?: number; latencyMs?: number; drainMs?: number; renderer?: "changed" | "poll"; log?: (line: string) => void }

const lat = (xs: number[]): Latencies => {
  if (!xs.length) return { n: 0, p50: 0, p99: 0, max: 0, over100: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)]!;
  return { n: s.length, p50: round(at(50)), p99: round(at(99)), max: round(s[s.length - 1]!), over100: s.filter((x) => x > 100).length };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function measureStalls(options: StallOptions = {}): Promise<StallReport> {
  const size = options.size ?? 1000,
    idleMs = options.idleMs ?? 12_000,
    latencyMs = options.latencyMs ?? 150,
    drainMs = options.drainMs ?? 8_000,
    log = options.log ?? (() => {});
  const { createStore } = await import("@magic/storage");
  const { syntheticCorpus, COURSES } = await import("./synthetic");
  const { createSyntheticCanvasUniversity } = await import("../../packages/connectors/src/canvas-fixture");
  const { LIVE_SHAPE } = await import("./baseline");
  const directory = mkdtempSync(join(tmpdir(), "magic-stalls-"));
  const dbPath = join(directory, "workspace.sqlite");
  // The sample account: synthetic coursework already on the device (a returning student).
  {
    const store = createStore(dbPath);
    for (const batch of syntheticCorpus(size).batches) store.ingest(batch);
    store.close?.();
  }
  const seeded = createStore(dbPath);
  const course = { accountScope: "perf-synthetic", courseId: COURSES[0].id };
  const item = seeded.resources().find((r) => r.kind === "assignment" && r.courseId === course.courseId)!;
  seeded.close?.();
  const university = createSyntheticCanvasUniversity({ origin: "https://canvas.wisc.edu", rateLimit: false, ...LIVE_SHAPE });
  let canvasRequests = 0;
  const mainLoop = () => {
    const h = monitorEventLoopDelay({ resolution: 10 });
    h.enable();
    return () => (h.disable(), { p99: round(h.percentile(99) / 1e6), max: round(h.max / 1e6) });
  };
  const started = performance.now();
  const child: ChildProcess = fork(join(root, "apps", "desktop", "src", "worker.ts"), [], {
    cwd: root,
    execArgv: ["--import", "tsx", "--import", pathToFileURL(here).href],
    serialization: "advanced",
    env: { ...process.env, MAGIC_STALLS_ROLE: "worker", MAGIC_DB_PATH: dbPath, MAGIC_GATEWAY_URL: "", MAGIC_GOOGLE_CLIENT_ID: "" },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr?.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
  const waiters = new Map<string, (m: any) => void>();
  let onReady!: () => void;
  const ready = new Promise<void>((r) => (onReady = r));
  let lastBytes = 0,
    lastForwardMs = 0,
    onChanged: (() => void) | undefined;
  // The worker announces changes (`changed`) since the stall audit; before it, App.tsx polled.
  const rendererMode: "changed" | "poll" =
    options.renderer ??
    (readFileSync(join(root, "apps", "desktop", "src", "worker.ts"), "utf8").includes('kind: "changed"') ? "changed" : "poll");
  child.on("message", async (m: any) => {
    if (m?.kind === "ready") return onReady();
    if (m?.kind === "changed") return onChanged?.();
    if (m?.kind === "__stalls-report" || m?.kind === "__stalls-reset-done") return waiters.get(m.kind)?.(m);
    if ((m?.kind === "response" || m?.kind === "local-response") && waiters.has(m.id)) {
      // Main forwards the result to the renderer: a structured clone of the whole result.
      const t = performance.now();
      lastBytes = m.result ? serialize(m.result).length : 0;
      lastForwardMs = performance.now() - t;
      return waiters.get(m.id)!(m);
    }
    if (m?.kind === "source-fetch") {
      const { service, url } = m.payload ?? {};
      if (service !== "canvas") return child.send({ kind: "source-response", id: m.id, error: true });
      canvasRequests++;
      await sleep(latencyMs);
      try {
        const response = await university.fetch(String(url), { method: "GET" });
        const headers: Record<string, string> = {};
        response.headers.forEach((v, k) => (headers[k] = v));
        child.send({ kind: "source-response", id: m.id, result: { status: response.status, url, headers, body: await response.text() } });
      } catch {
        child.send({ kind: "source-response", id: m.id, error: true });
      }
      return;
    }
    // Every other host read (planning, Graph state, secrets, madgrades, notes-google): unavailable.
    if (m?.id && typeof m.kind === "string" && !["response", "local-response", "closed"].includes(m.kind))
      child.send({ kind: "source-response", id: m.id, error: true });
  });
  const exited = new Promise<number | null>((r) => child.on("exit", r));
  const control = <T>(kind: string, reply: string): Promise<T> =>
    new Promise((r) => {
      waiters.set(reply, (m) => (waiters.delete(reply), r(m)));
      child.send({ kind });
    });
  const reset = () => control("__stalls-reset", "__stalls-reset-done");
  const report = async () => ((await control<{ report: ChildReport }>("__stalls-report", "__stalls-report")).report);
  const request = (message: Record<string, unknown>, timeoutMs = 30_000): Promise<{ ms: number; bytes: number; forwardMs: number; reply: any }> => {
    const id = randomUUID();
    const t = performance.now();
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => (waiters.delete(id), reject(new Error(`Local workspace request timed out (${JSON.stringify(message).slice(0, 80)}).`))), timeoutMs);
      waiters.set(id, (m) => {
        clearTimeout(timer);
        waiters.delete(id);
        resolveRequest({ ms: performance.now() - t, bytes: lastBytes, forwardMs: lastForwardMs, reply: m });
      });
      child.send({ ...message, id });
    });
  };
  try {
    await Promise.race([ready, exited.then((code) => Promise.reject(new Error(`worker exited (${code}): ${stderr}`)))]);
    child.on("error", () => {});
    const readyMs = round(performance.now() - started);
    log(`worker ready in ${readyMs} ms`);
    child.send({ kind: "presence", present: true });
    // The renderer's snapshot reads, as App.tsx does them: on the worker's `changed` (at most every
    // 2 s, one at a time) when the worker announces changes, else the 2 s poll.
    const snapshotRead = { kind: "command", command: { type: "snapshot" } };
    const startRenderer = () => {
      let reading = false,
        pending = false,
        stopped = false,
        lastRead = performance.now(),
        trailing: ReturnType<typeof setTimeout> | undefined,
        count = 0,
        bytes = 0,
        forwardMs = 0;
      const times: number[] = [];
      const pull = () => {
        pending = true;
        if (stopped || reading || trailing) return;
        const wait = lastRead + 2000 - performance.now();
        if (wait > 0) {
          trailing = setTimeout(() => {
            trailing = undefined;
            if (pending) pull();
          }, wait);
          return;
        }
        pending = false;
        reading = true;
        lastRead = performance.now();
        void request(snapshotRead, 60_000)
          .then((r) => {
            times.push(r.ms);
            count++;
            bytes = r.bytes;
            forwardMs += r.forwardMs;
          })
          .catch(() => times.push(60_000))
          .finally(() => {
            reading = false;
            if (pending) pull();
          });
      };
      const poll = rendererMode === "poll" ? setInterval(pull, 2000) : undefined;
      onChanged = pull;
      return {
        stop() {
          stopped = true;
          clearInterval(poll);
          clearTimeout(trailing);
          onChanged = undefined;
          return { count, times, bytes, forwardMs };
        },
      };
    };
    // ------------------------------------------------------------------ per action
    const snapshotCmd = { kind: "command", command: { type: "snapshot" } };
    const ACTIONS: { action: string; messages: Record<string, unknown>[]; syncOrProbe?: boolean }[] = [
      // App.tsx mounts: one snapshot (then the 2 s poll, measured below).
      { action: "open app (first snapshot)", messages: [snapshotCmd] },
      { action: "open Home (derived from the snapshot; agenda graph)", messages: [{ kind: "graph", query: { type: "agenda", date: "2026-09-30", tz: "America/Chicago" } }] },
      { action: "open a course (course page query + graph)", messages: [{ kind: "query", query: { view: "resources", ...course, limit: 50 } }, { kind: "graph", query: { type: "course", ...course } }] },
      { action: "open an item (ui_event open + resource query)", messages: [{ kind: "command", command: { type: "ui_event", value: { kind: "open", subject: item.id } } }, { kind: "query", query: { view: "resource", id: item.id } }] },
      { action: "search (snapshot with search)", messages: [{ kind: "command", command: { type: "snapshot", search: "eigenvalue matrix" } }] },
      { action: "command bar (prewarm + preview query)", messages: [{ kind: "command", command: { type: "command", value: { text: "", mode: "prewarm" } } }, { kind: "query", query: { view: "intent.preview", text: "quiz me on graphs" } }] },
      { action: "command bar (run: due this week)", messages: [{ kind: "command", command: { type: "command", value: { text: "what's due this week", mode: "run" } } }] },
      { action: "generate cards (pack, no client connected)", messages: [{ kind: "command", command: { type: "pack", pack: "cards", scope: { courseId: course.courseId } } }] },
      { action: "study: knowledge state (learning)", messages: [{ kind: "command", command: { type: "learning", request: { op: "knowledge.state", courseId: course.courseId, anchorIds: [item.id] } } }] },
      { action: "focus / blur (window focus)", messages: [{ kind: "focus" }], syncOrProbe: true },
    ];
    const actions: ActionCost[] = [];
    for (const a of ACTIONS) {
      for (const m of a.messages) if (m.kind !== "focus") await request(m).catch(() => {}); // warm
      await reset();
      const t = performance.now();
      let bytes = 0,
        forwardMs = 0,
        full = false;
      for (const m of a.messages) {
        if (m.kind === "focus") {
          child.send(m);
          continue;
        }
        const r = await request(m).catch((e: Error) => ({ ms: 0, bytes: 0, forwardMs: 0, reply: { error: e.message } }));
        bytes += r.bytes;
        forwardMs += r.forwardMs;
        if (r.reply?.result?.snapshot?.resources) full = true;
      }
      const wallMs = performance.now() - t;
      await sleep(a.syncOrProbe ? 1500 : 50);
      const c = await report();
      actions.push({
        action: a.action,
        messages: a.messages.length,
        wallMs: round(wallMs),
        workerMs: round(c.requests.reduce((n, r) => n + r.ms, 0)),
        statements: c.statements,
        responseBytes: bytes,
        forwardMs: round(forwardMs),
        fullSnapshot: full,
        syncOrProbe: canvasRequests > 0 || c.requests.some((r) => r.label === "refresh"),
      });
      log(`${a.action}: ${round(wallMs)} ms, ${c.statements} statements, ${bytes} B${full ? " (full snapshot)" : ""}`);
    }
    // ------------------------------------------------------------------ idle, no renderer
    // Idle means nothing is being written: wait until the worker has announced no change for 3 s
    // (the seeded workspace's background derivation settles) and the worker's one-time backfill
    // (20 s after start, worker.ts) has run, at most 90 s.
    let lastChange = performance.now();
    const quietWatch = setInterval(() => {}, 1000);
    onChanged = () => (lastChange = performance.now());
    const quiesceStart = performance.now();
    const readyAt = started + readyMs;
    while ((performance.now() - lastChange < 3000 || performance.now() - readyAt < 25_000) && performance.now() - quiesceStart < 90_000) await sleep(250);
    onChanged = undefined;
    clearInterval(quietWatch);
    const quiesceMs = round(performance.now() - quiesceStart);
    log(`quiet after ${quiesceMs} ms`);
    const requestsBeforeIdle = canvasRequests;
    await reset();
    let stopMain = mainLoop();
    await sleep(idleMs);
    const idle = { windowMs: idleMs, quiesceMs, child: await report(), mainLoop: stopMain() };
    log(`idle ${idleMs} ms: worker cpu ${idle.child.cpuMs} ms, ${idle.child.statements} statements, canvas ${canvasRequests - requestsBeforeIdle}`);
    // ------------------------------------------------------------------ idle with the renderer (App.tsx)
    const idleRenderer = startRenderer();
    await reset();
    await sleep(idleMs);
    const pollChild = await report();
    const idleRead = idleRenderer.stop();
    const idlePolling = {
      windowMs: idleMs,
      mode: rendererMode,
      polls: idleRead.count,
      child: pollChild,
      perPoll: {
        workerMs: round(pollChild.requests.reduce((n, r) => n + r.ms, 0) / Math.max(1, idleRead.count)),
        statements: Math.round(pollChild.statements / Math.max(1, idleRead.count)),
        bytes: idleRead.bytes,
        forwardMs: round(idleRead.forwardMs / Math.max(1, idleRead.count)),
      },
    };
    log(`renderer (${rendererMode}) idle ${idleMs} ms: ${idleRead.count} snapshot reads, ${pollChild.statements} statements, ${idlePolling.perPoll.bytes} B each`);
    // ------------------------------------------------------------------ first sync with concurrent views
    const VIEWS: Record<string, Record<string, unknown>> = {
      "query:summary": { kind: "query", query: { view: "summary" } },
      "query:resources": { kind: "query", query: { view: "resources", ...course, limit: 50 } },
      "query:resource": { kind: "query", query: { view: "resource", id: item.id } },
      "graph:agenda": { kind: "graph", query: { type: "agenda", date: "2026-09-30", tz: "America/Chicago" } },
    };
    const underLoad = async (until: () => boolean) => {
      const views: Record<string, number[]> = Object.fromEntries(Object.keys(VIEWS).map((k) => [k, []]));
      const renderer = startRenderer();
      let i = 0;
      while (!until()) {
        const name = Object.keys(VIEWS)[i++ % Object.keys(VIEWS).length]!;
        const r = await request(VIEWS[name]!, 60_000).catch(() => ({ ms: 60_000 }));
        views[name]!.push(r.ms);
        await sleep(100);
      }
      const read = renderer.stop();
      return { views: Object.fromEntries(Object.entries(views).map(([k, v]) => [k, lat(v)])), snapshotPoll: lat(read.times), snapshotReads: read.count };
    };
    await reset();
    stopMain = mainLoop();
    const syncStart = performance.now();
    let syncDone = false,
      syncResult = "";
    const sync = request({ kind: "refresh", discover: true }, 600_000)
      .then(() => request({ kind: "refresh", confirm: true }, 600_000))
      .then((r) => (syncResult = r.reply.error ? `error: ${r.reply.error}` : String(r.reply.result?.message ?? "ok")))
      .catch((e: Error) => (syncResult = `error: ${e.message}`))
      .finally(() => (syncDone = true));
    const load = await underLoad(() => syncDone);
    await sync;
    const syncReport = { wallMs: round(performance.now() - syncStart), result: syncResult, ...load, child: await report(), mainLoop: stopMain() };
    log(`sync ${syncReport.wallMs} ms (${canvasRequests} canvas requests): ${JSON.stringify(load.views)}`);
    // ------------------------------------------------------------------ the job drain after the sync
    await reset();
    const drainUntil = performance.now() + drainMs;
    const drainLoad = await underLoad(() => performance.now() >= drainUntil);
    const drain = { windowMs: drainMs, views: drainLoad.views, snapshotReads: drainLoad.snapshotReads, child: await report() };
    log(`drain: ${JSON.stringify(drainLoad.views)}`);
    return { size, startup: { readyMs }, actions, idle, idlePolling, sync: syncReport, drain, canvasRequests };
  } finally {
    if (child.connected) child.send({ kind: "shutdown" });
    await Promise.race([exited, sleep(5000)]);
    child.kill();
    await sleep(200);
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

// ============================================================================ report
export function renderStalls(r: StallReport): string {
  const lines: string[] = [];
  lines.push(`# Stall audit (synthetic ${r.size} resources)`, "", `Worker ready: ${r.startup.readyMs} ms`, "");
  lines.push("| action | wall ms | worker ms | statements | response bytes | main forward ms | full snapshot |", "|---|---|---|---|---|---|---|");
  for (const a of r.actions) lines.push(`| ${a.action} | ${a.wallMs} | ${a.workerMs} | ${a.statements} | ${a.responseBytes} | ${a.forwardMs} | ${a.fullSnapshot ? "yes" : "no"} |`);
  const loop = (c: ChildReport) => `loop p50 ${c.loop.p50} / p99 ${c.loop.p99} / max ${c.loop.max} ms, ${c.loop.blocks.length} blocks > 50 ms, cpu ${c.cpuMs} ms, ${c.statements} statements`;
  lines.push("", `Idle ${r.idle.windowMs} ms, no renderer: ${loop(r.idle.child)}`);
  lines.push(`Idle with the renderer (${r.idlePolling.mode}): ${r.idlePolling.polls} snapshot reads in ${r.idlePolling.windowMs} ms; ${loop(r.idlePolling.child)}; per read ${JSON.stringify(r.idlePolling.perPoll)}`);
  lines.push("", "Timers alive or fired while idle:");
  for (const t of r.idle.child.timers) lines.push(`- ${t.kind} ${t.delay} ms, fired ${t.fires}, ${t.active ? "active" : "done"}: ${t.site}`);
  const views = (v: Record<string, Latencies>) => Object.entries(v).map(([k, l]) => `${k} p50 ${l.p50} p99 ${l.p99} max ${l.max} (n ${l.n}, >100 ms ${l.over100})`).join("; ");
  lines.push("", `First sync: ${r.sync.wallMs} ms, ${r.canvasRequests} Canvas requests, ${r.sync.result}`, `- views: ${views(r.sync.views)}`, `- snapshot reads: ${r.sync.snapshotReads}, p50 ${r.sync.snapshotPoll.p50} p99 ${r.sync.snapshotPoll.p99} max ${r.sync.snapshotPoll.max}`, `- worker ${loop(r.sync.child)}`, `- main loop p99 ${r.sync.mainLoop.p99} max ${r.sync.mainLoop.max}`);
  lines.push("", `Drain ${r.drain.windowMs} ms after the sync: ${views(r.drain.views)}; ${r.drain.snapshotReads} snapshot reads; worker ${loop(r.drain.child)}`);
  const blocks = [...r.sync.child.loop.blocks, ...r.drain.child.loop.blocks, ...r.idlePolling.child.loop.blocks].sort((a, b) => b.ms - a.ms).slice(0, 15);
  lines.push("", "Worst blocks (> 50 ms):");
  for (const b of blocks) lines.push(`- ${b.ms} ms during [${b.ops.join(", ")}] sql: ${b.sql.map((s) => `${s.ms} ms ${s.sql}`).join(" | ") || "none > 5 ms"}`);
  const slow = [...r.sync.child.slowSql, ...r.drain.child.slowSql, ...r.idlePolling.child.slowSql].sort((a, b) => b.ms - a.ms).slice(0, 12);
  lines.push("", "Slowest statements (> 20 ms):");
  for (const s of slow) lines.push(`- ${s.ms} ms [${s.op}] ${s.sql}`);
  const fs = { ...r.sync.child.syncFs };
  for (const [k, v] of Object.entries(r.drain.child.syncFs)) fs[k] = (fs[k] ?? 0) + v;
  lines.push("", "Synchronous fs calls during the sync and drain:");
  for (const [k, v] of Object.entries(fs).sort((a, b) => b[1] - a[1]).slice(0, 15)) lines.push(`- ${v}x ${k}`);
  lines.push("", "JSON over 1 MB:");
  for (const j of [...r.idlePolling.child.bigJson, ...r.sync.child.bigJson].slice(0, 10)) lines.push(`- ${j.op} ${j.bytes} B ${j.ms} ms`);
  return lines.join("\n") + "\n";
}

// ============================================================================ entry
if (ROLE === "worker") installChild();
else if (process.argv[1] && resolve(process.argv[1]) === here) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const renderer = arg("renderer");
  measureStalls({ size: Number(arg("size") ?? 1000), idleMs: Number(arg("idle") ?? 12_000), ...(renderer === "poll" || renderer === "changed" ? { renderer } : {}), log: (l) => console.error(`[stalls] ${l}`) })
    .then((r) => {
      process.stdout.write(renderStalls(r));
      const out = arg("json");
      if (out) writeFileSync(out, JSON.stringify(r, null, 2));
    })
    .catch((e) => {
      console.error(e instanceof Error ? (e.stack ?? e.message) : e);
      process.exitCode = 1;
    });
}
