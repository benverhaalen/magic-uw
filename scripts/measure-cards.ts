/**
 * Flashcard latency, cost and path through the real worker and the real `claude` (synthetic data).
 *
 *   pnpm tsx scripts/measure-cards.ts [--packs study-prep-cards,cards] [--runs 2]
 *
 * The worker is loaded in this process with Electron's parentPort stood in (as
 * scripts/verify-ai-events.ts does). One synthetic course is imported; each pack runs `--runs` times
 * with unchanged sources (run 2 onward should be a cache hit). Per run it prints wall time, the
 * client processes spawned (warm-pool session or one-shot `claude -p`, and the model flag), the
 * pool asks, and the ledger rows the run wrote (tier, model, tokens, check failures, escalation).
 */
import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createRequire, syncBuiltinESMExports } from "node:module";
import type { ChildProcess, SpawnOptions } from "node:child_process";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name: string, fallback: string) => {
  const at = process.argv.indexOf(name);
  return at > 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback;
};
const PACKS = arg("--packs", "study-prep-cards,cards").split(",");
const RUNS = Number(arg("--runs", "2"));

const root = await mkdtemp(join(tmpdir(), "magic-measure-cards-"));
const userData = join(root, "user-data");
await mkdir(userData, { recursive: true });
process.env.MAGIC_DB_PATH = join(userData, "workspace.sqlite");
delete process.env.MAGIC_GATEWAY_URL;

// ---- Client processes: which path each call took ----
interface Spawned { at: number; path: "pool-session" | "one-shot"; model: string; asks: number }
const spawned: Spawned[] = [];
const cp = createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process");
const realSpawn = cp.spawn;
Object.assign(cp, {
  spawn(file: string, args: readonly string[] = [], options?: SpawnOptions): ChildProcess {
    const child = realSpawn(file, args as string[], options ?? {});
    const all = [file, ...args].join(" ");
    const isClaude = /claude/i.test(all) && !args.includes("--version") && !args.includes("--help") && !args.includes("auth");
    if (isClaude && (args.includes("-p") || args.includes("--print"))) {
      const m = args.indexOf("--model");
      const entry: Spawned = { at: performance.now(), path: args.includes("stream-json") && args[args.indexOf("--input-format") + 1] === "stream-json" ? "pool-session" : "one-shot", model: m >= 0 ? String(args[m + 1]) : "(default)", asks: 0 };
      spawned.push(entry);
      const write = child.stdin?.write.bind(child.stdin);
      if (child.stdin && write && entry.path === "pool-session")
        child.stdin.write = ((chunk: unknown, ...rest: unknown[]) => {
          if (String(chunk).includes('"type":"user"')) entry.asks++;
          return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
        }) as typeof child.stdin.write;
    }
    return child;
  },
});
syncBuiltinESMExports();

// ---- The worker ----
type Message = { kind: string; id?: string; [key: string]: unknown };
const toWorker = new EventEmitter();
const fromWorker = new EventEmitter();
Object.assign(process, { parentPort: {
  on: (event: string, listener: (e: { data: Message }) => void) => void toWorker.on(event, listener),
  postMessage: (message: Message) => void setImmediate(() => fromWorker.emit("message", message)),
} });
Object.assign(globalThis, { __dirname: join(REPO, "apps", "desktop", "dist") });
const send = (data: Message) => toWorker.emit("message", { data });
const HOST_READS = new Set(["source-fetch", "ai-key", "madgrades-read", "planning-public-read", "planning-refresh", "source-secret", "graph-state", "notes-google"]);
fromWorker.on("message", (m: Message) => {
  if (m.id && HOST_READS.has(m.kind)) send({ kind: "source-response", id: m.id, error: "unavailable" });
});
const ready = new Promise<void>((done) => fromWorker.on("message", (m: Message) => m.kind === "ready" && done()));
await import(pathToFileURL(join(REPO, "apps", "desktop", "src", "worker.ts")).href);
await ready;
send({ kind: "privacy-key", secret: randomBytes(32).toString("base64") });

function command(value: unknown, timeoutMs = 400_000): Promise<{ result?: any; error?: string; ms: number }> {
  const id = randomUUID();
  const started = performance.now();
  return new Promise((done) => {
    const timer = setTimeout(() => done({ error: "timeout", ms: performance.now() - started }), timeoutMs);
    const listen = (m: Message) => {
      if (m.kind !== "response" || m.id !== id) return;
      clearTimeout(timer);
      fromWorker.off("message", listen);
      done({ result: m.result, ...(typeof m.error === "string" ? { error: m.error } : {}), ms: performance.now() - started });
    };
    fromWorker.on("message", listen);
    send({ kind: "command", id, command: value });
  });
}
async function must(value: unknown) {
  const r = await command(value);
  if (r.error) throw new Error(`${JSON.stringify(value).slice(0, 60)}: ${r.error}`);
  return r.result;
}

const { CONSENT_DISCLOSURE_VERSION } = await import("../packages/domain/src/index");
const { chooseClient } = await import("../apps/desktop/src/clients/profiles");
for (const recipient of ["uw", "jev", "claude"]) await must({ type: "consent", value: { action: "grant", recipient, disclosureVersion: CONSENT_DISCLOSURE_VERSION } });
await chooseClient("claude", userData);
const snap = (await must({ type: "snapshot" })).snapshot;
await must({ type: "privacy", value: { ...snap.privacy, mode: "selective_cloud", hostedProvider: "claude", shareCourseText: true } });

// ---- One synthetic course, identical at every commit ----
const COURSE = "bench-240";
const POLICY = { mode: "coaching", evidence: "AI may explain concepts and quiz you; it must not write graded work." };
const lecture = [
  "Lecture 3: Graph search.",
  "A graph G = (V, E) is a set of vertices V and a set of edges E between pairs of vertices.",
  "Breadth-first search (BFS) explores a graph level by level from a source vertex using a queue.",
  "BFS finds the shortest path, measured in edges, from the source to every reachable vertex in an unweighted graph.",
  "Depth-first search (DFS) follows one path as deep as possible before backtracking, using a stack or recursion.",
  "DFS records a discovery time and a finish time for every vertex.",
  "Both BFS and DFS run in O(V + E) time when the graph is stored as adjacency lists.",
  "A directed acyclic graph (DAG) is a directed graph with no directed cycles.",
  "A topological sort orders the vertices of a DAG so that every edge goes from an earlier vertex to a later one.",
  "Listing vertices in decreasing order of DFS finish time gives a topological sort of a DAG.",
  "A back edge found during DFS of a directed graph means the graph has a cycle.",
  "Dijkstra's algorithm finds shortest paths in a graph with non-negative edge weights using a priority queue.",
  "With a binary heap, Dijkstra's algorithm runs in O((V + E) log V) time.",
  "Dijkstra's algorithm can give wrong answers when some edge weights are negative.",
].join("\n");
await must({ type: "import", batch: {
  source: { id: "bench-240-lectures", label: "Bench course · synthetic", kind: "fixture", accountScope: "synthetic", courseId: COURSE, scope: "materials" },
  observedAt: "2026-09-26T18:00:00Z", complete: true, status: "ok",
  resources: [
    { externalId: "lecture-3", kind: "material", courseId: COURSE, courseName: "COMP SCI 240 · Bench", title: "Lecture 3: Graph search", url: "https://example.org/bench/lecture-3", text: lecture, deadlines: [], points: null, submitted: false, policy: POLICY },
    { externalId: "midterm-1", kind: "assignment", courseId: COURSE, courseName: "COMP SCI 240 · Bench", title: "Midterm 1", url: "https://example.org/bench/midterm-1", text: "Midterm 1 covers graph search: BFS, DFS, topological sort and Dijkstra's algorithm.", deadlines: [{ value: "2026-10-09T15:00:00Z", kind: "due", quote: "due_at: 2026-10-09T15:00:00Z", authority: "structured", scopeConfirmed: true }], points: 100, submitted: false, policy: POLICY },
  ],
} });
const snapshotAfter = (await must({ type: "snapshot" })).snapshot;
const resources = (snapshotAfter.resources ?? []) as { id: string; title: string }[];
const midterm = resources.find((r) => r.title === "Midterm 1");
if (!midterm) {
  console.error(`Midterm 1 not in the snapshot (${resources.length} resources; import: ${JSON.stringify(snapshotAfter.sources?.map((s: { id: string; status: string }) => [s.id, s.status]))})`);
  process.exit(1);
}

// ---- Runs ----
const db = new DatabaseSync(process.env.MAGIC_DB_PATH!, { readOnly: true });
const ledgerSince = (iso: string) => db.prepare("SELECT pack, tier, model, tokens_in, tokens_cached, tokens_out, latency_ms, check_failures, escalated FROM ledger WHERE created_at >= ? ORDER BY created_at").all(iso) as Record<string, unknown>[];
const lines: string[] = [];
for (const pack of PACKS) {
  for (let run = 1; run <= RUNS; run++) {
    const since = new Date().toISOString();
    const from = spawned.length;
    const asksBefore = spawned.reduce((n, s) => n + s.asks, 0);
    const scope = pack.startsWith("study-prep") ? { courseId: COURSE, assessmentId: midterm.id } : { courseId: COURSE };
    const r = await command({ type: "pack", pack, scope });
    await new Promise((d) => setTimeout(d, 300));
    const p = r.result?.pack ?? {};
    const ledger = ledgerSince(since);
    const procs = spawned.slice(from).map((s) => `${s.path}(${s.model})`);
    const asks = spawned.reduce((n, s) => n + s.asks, 0) - asksBefore;
    const line = `${pack} run ${run}: ${Math.round(r.ms)} ms | status=${p.status ?? r.error} cached=${p.cached} tokens=${JSON.stringify(p.tokens ?? null)} counts=${JSON.stringify(p.counts ?? null)}\n` +
      `   spawned=[${procs.join(", ")}] pool asks (all sessions)=${asks}\n` +
      `   ledger=${JSON.stringify(ledger.map((l) => ({ pack: l.pack, tier: l.tier, model: l.model, in: l.tokens_in, cached: l.tokens_cached, out: l.tokens_out, ms: Math.round(Number(l.latency_ms)), checkFail: l.check_failures, esc: l.escalated })))}\n` +
      `   message=${String(p.message ?? "").slice(0, 160)}`;
    console.log(line);
    lines.push(line);
  }
}
db.close();
send({ kind: "shutdown" });
await new Promise((d) => setTimeout(d, 1_500));
await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
process.exit(0);
