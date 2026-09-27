/**
 * Our side of `pnpm semester`: each of the ten everyday actions driven through the code path the
 * desktop worker wires (core → the intent router → the learning router / pack handler / grounded
 * ask / core queries), on the synthetic semester, with the student's model played by the fake
 * CLI (tests/fixtures/fake-cli). Calls are counted from the fake CLI's log, and prompt size is
 * the characters that reached it (system-prompt file + JSON schema + stdin). Tokens = ceil(chars
 * / 4), a stated approximation, not a tokenizer. Output tokens are an estimate: the size of the
 * scripted reply, which has the shape the pack's schema forces.
 *
 * Two routes are measured for the command bar's model calls: the one-shot runner (each call a
 * fresh CLI) and the warm session pool the desktop worker actually wires for the bar
 * (packages/runner/src/pool.ts: one interactive session per course that keeps its conversation,
 * with the classify/ask union schema). Because the fake CLI plays the model, "correct" on a model
 * row checks only what code controls; model-path latency here is a Node spawn, not inference.
 */
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCore } from "@magic/core";
import { changeNotes, CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import type { IntentCommandResult, LearningRequest, LearningResult, QueryResult } from "@magic/contracts";
import { createClaudeBackend, createModelRunner, createSessionPool, type CliCommand, type SessionPool } from "../../packages/runner/src/index";
import { askPack, classifyPack } from "../../packages/packs/intent/src/index";
import { codeAssignmentKind } from "../../packages/core/src/queries";
import { pipelineJobRegistry } from "../../packages/core/src/jobs/default-registry";
import { createPackRuntime, DEFAULT_PACK_CONFIG } from "../../packages/packs/core/src/index";
import { createPackHandler, type PackRunResult } from "../../packages/core/src/pack-handler";
import { createLearningRouter } from "../../packages/learning/src/router";
import type { FlashcardData, PracticeRoundData } from "../../packages/learning/src/router-types";
import { createIntentRouter } from "../../packages/core/src/intent/index";
import { createStudyContextResolver } from "../../apps/desktop/src/learning-context";
import {
  ANNOUNCEMENT, EXAM_COVERS, EXAM_SENTENCE, EXPECT_DUE_THIS_WEEK, GRADING, HASHING, HW4_MOVED, NOW, SCORES, SINCE_YESTERDAY, TA_EMAIL, TZ,
  expectedFinalForB, percentNear, semesterWorkspace,
} from "./workspace";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fake: CliCommand = { file: process.execPath, prefixArgs: [join(root, "tests", "fixtures", "fake-cli", "fake-cli.mjs"), "claude"] };
export const WARM_RUNS = 20;

export type Path = "code" | "model" | "cache" | "Jev";
/** Where the student starts the action in the app. */
export type Entry = "bar" | "rail" | "bar+course" | "pack handler + bar";
/** One call: the byte-stable prefix (system-prompt file + schema) and the per-call input (stdin). */
export interface ModelCall { chars: number; tokens: number; prefixTokens: number; inputTokens: number }
export interface OurRow {
  id: number;
  action: string;
  utterance: string;
  /** Path of the first run, and of a repeat. */
  path: Path;
  repeatPath: Path;
  /** Model calls and prompt tokens on the first run (tokens = chars / 4). */
  calls: number;
  promptChars: number;
  tokens: number;
  /** Of `tokens`: the prefix (system prompt + schema) and the per-call input. */
  prefixTokens: number;
  inputTokens: number;
  /** Estimated reply tokens for the first run's calls (scripted reply size). */
  outputTokens: number;
  /** Model calls on the repeat (0 = cache hit or code); valid only for a byte-identical repeat. */
  repeatCalls: number;
  repeatTokens: number;
  firstMs: number;
  warmMedianMs: number;
  /** "code": both times are real code-path times. "fake-cli": the first time is a Node spawn, not a model. */
  latencyKind: "code" | "fake-cli";
  /** Where the measured run starts. */
  entry: Entry;
  /** What the plain command bar (no course open, the same words) does, when that differs. */
  plainBar: string | null;
  /** The warm session pool's first turn for this action (prefix + union schema + header + input), when it is a bar model call. */
  pooled: { prefixTokens: number; inputTokens: number } | null;
  /** Code rows: the answer is right. Model rows: only the code-side checks (model scripted). */
  correct: boolean;
  check: string;
  notes: string[];
}

/** One fresh synthetic workspace wired as apps/desktop/src/worker.ts wires it, with scripted fake-CLI answers. */
async function harness(responses: unknown[], options: { pooled?: boolean } = {}) {
  const w = semesterWorkspace();
  const { store } = w;
  const dir = await mkdtemp(join(tmpdir(), "semester-"));
  const workDir = join(dir, "work");
  await mkdir(workDir);
  const log = join(dir, "log.jsonl");
  const env = { FAKE_CLI_LOG: log, FAKE_CLI_STATE: join(dir, "state"), FAKE_CLI_RESPONSES: JSON.stringify(responses) };
  const runner = createPackRuntime(createClaudeBackend({ command: fake, workDir, env }), DEFAULT_PACK_CONFIG).runner;
  // The command bar's runner in the app: a warm session pool over classify and ask (worker.ts intentRunner).
  const pool: SessionPool | null = options.pooled
    ? createSessionPool({ command: fake, workDir, env, fallback: createClaudeBackend({ command: fake, workDir, env }), kinds: { [classifyPack.id]: classifyPack.schema, [askPack.id]: askPack.schema } })
    : null;
  const intentRunner = pool ? createModelRunner({ backend: pool }) : runner;
  // Session processes run in workDir; on Windows the folder can't be removed until they exit.
  const live = new Set<string>();
  let exited: () => void = () => {};
  pool?.onActivity((e) => {
    if (e.type === "session_start") live.add(e.session);
    if (e.type === "session_exit") { live.delete(e.session); if (!live.size) exited(); }
  });
  const closePool = async () => {
    if (!pool) return;
    const done = live.size ? new Promise<void>((resolve) => (exited = resolve)) : Promise.resolve();
    await pool.close();
    await done;
  };
  // The learning router's clock moves forward between flashcard runs so the same cards are due again.
  let learnNow = NOW.getTime();
  const handler = createPackHandler({ store, runner: () => runner, now: () => NOW });
  const intent = createIntentRouter({ store, runner: () => intentRunner, now: () => NOW, timeZone: TZ });
  let resolveContext: ReturnType<typeof createStudyContextResolver> = () => null;
  const learning = createLearningRouter({ store: store.learning, resolveContext: (id) => resolveContext(id), now: () => new Date(learnNow) });
  const core = createCore(store, { fixture: w.fixture, now: () => NOW, timeZone: TZ, seams: { learning, pack: handler.pack, intent } });
  resolveContext = createStudyContextResolver(store, core);
  await core.execute({ type: "consent", value: { action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION } });
  intent.ready();

  const sent = async () => {
    if (!existsSync(log)) return [];
    const lines = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { argv: string[]; stdin: string | null; event?: string });
    return lines.filter((l) => !l.event).map((l) => {
      const at = (flag: string) => l.argv[l.argv.indexOf(flag) + 1] ?? "";
      const prefixPath = at("--system-prompt-file");
      const system = prefixPath && existsSync(prefixPath) ? readFileSync(prefixPath, "utf8") : "";
      return { system, schema: at("--json-schema"), stdin: l.stdin ?? "" };
    });
  };
  const readCalls = async (): Promise<ModelCall[]> =>
    (await sent()).map((c) => {
      const chars = c.system.length + c.schema.length + c.stdin.length;
      const prefixTokens = Math.ceil((c.system.length + c.schema.length) / 4);
      const inputTokens = Math.ceil(c.stdin.length / 4);
      return { chars, tokens: prefixTokens + inputTokens, prefixTokens, inputTokens };
    });
  /** The warm pool's log: each spawn (prefix file + union schema) and each message sent to it. */
  const sessionLog = async () => {
    if (!existsSync(log)) return [];
    const lines = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { argv: string[]; stdin: string | null; event?: string });
    return lines.filter((l) => l.event).map((l) => {
      const at = (flag: string) => l.argv[l.argv.indexOf(flag) + 1] ?? "";
      const prefixPath = at("--system-prompt-file");
      const system = prefixPath && existsSync(prefixPath) ? readFileSync(prefixPath, "utf8") : "";
      return l.event === "spawn"
        ? { event: "spawn" as const, prefixTokens: Math.ceil((system.length + at("--json-schema").length) / 4), inputTokens: 0 }
        : { event: "message" as const, prefixTokens: 0, inputTokens: Math.ceil((l.stdin ?? "").length / 4) };
    });
  };
  /** Everything the fake CLI has received so far (system prompt and stdin). */
  const promptText = async () => (await sent()).map((c) => `${c.system}\n${c.stdin}`).join("\n");
  /** A command-bar command; `courseId` is the course the student has open (the bar's context). */
  const command = async (text: string, courseId?: string) =>
    (await core.execute({ type: "command", value: { text, ...(courseId ? { context: { courseId } } : {}) } })).command as IntentCommandResult;
  const learn = (request: LearningRequest): Promise<LearningResult> => learning.handle(request, new AbortController().signal);
  return {
    ...w, core, handler, command, learn, readCalls, sessionLog, promptText, lecturePid: pidOf(store, "Lecture 5 notes: Hashing"), syllabusPid: pidOf(store, "Syllabus"),
    advanceLearningClock: (days: number) => { learnNow += days * 86_400_000; },
    close: async () => { await closePool(); await core.close(); await rm(dir, { recursive: true, force: true }); },
  };
}
type Harness = Awaited<ReturnType<typeof harness>>;

function pidOf(store: ReturnType<typeof semesterWorkspace>["store"], title: string) {
  const r = store.resources().find((x) => x.title === title);
  const p = r && store.passages(r.id)[0];
  return p ? `p${p.pid}` : "p0";
}
/** Passage IDs are deterministic for the same synthetic ingest, so a probe names them for the script. */
function probeIds() {
  const { store } = semesterWorkspace();
  const ids = { lecture: pidOf(store, "Lecture 5 notes: Hashing"), syllabus: pidOf(store, "Syllabus"), announcement: pidOf(store, "Homework 4 deadline moved") };
  store.close();
  return ids;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : 0;
};
const round = (x: number) => Math.round(x * 10) / 10;

interface Outcome { path: Path; correct?: boolean; check?: string; notes?: string[] }
/**
 * First run, then WARM_RUNS repeats. Calls and characters are the fake CLI's log deltas.
 * `prepare` (not timed) runs before every run; `repeatPath` is the second run's path.
 */
let warmRuns = WARM_RUNS;
async function measure(h: Harness, run: (i: number) => Promise<Outcome>, prepare?: (i: number) => void | Promise<void>) {
  const times: number[] = [];
  let first: Outcome | null = null;
  let second: Outcome | null = null;
  let firstCalls: ModelCall[] = [];
  let repeatCalls: ModelCall[] = [];
  for (let i = 0; i <= warmRuns; i++) {
    await prepare?.(i);
    const before = (await h.readCalls()).length;
    const t = performance.now();
    const o = await run(i);
    const ms = performance.now() - t;
    const made = (await h.readCalls()).slice(before);
    if (i === 0) { first = o; firstCalls = made; }
    else times.push(ms);
    if (i === 1) { second = o; repeatCalls = made; }
    if (i === 0) times.length = 0, (first as Outcome & { ms?: number }).ms = ms;
  }
  return { first: first!, second: second!, firstCalls, repeatCalls, firstMs: (first as Outcome & { ms?: number }).ms ?? 0, warm: median(times) };
}

function row(id: number, action: string, utterance: string, m: Awaited<ReturnType<typeof measure>>, generation?: { calls: ModelCall[]; repeat: ModelCall[] }): OurRow {
  const calls = [...(generation?.calls ?? []), ...m.firstCalls];
  const repeat = [...(generation?.repeat ?? []), ...m.repeatCalls];
  const chars = calls.reduce((s, c) => s + c.chars, 0);
  const sum = (xs: ModelCall[], k: keyof ModelCall) => xs.reduce((s, c) => s + c[k], 0);
  return {
    id, action, utterance,
    path: generation?.calls.length ? "model" : m.first.path,
    // A repeat that made no call after a first run that did was answered from the cache.
    repeatPath: repeat.length ? "model" : calls.length ? "cache" : m.second.path,
    calls: calls.length, promptChars: chars, tokens: sum(calls, "tokens"),
    prefixTokens: sum(calls, "prefixTokens"), inputTokens: sum(calls, "inputTokens"), outputTokens: 0,
    repeatCalls: repeat.length, repeatTokens: sum(repeat, "tokens"),
    firstMs: round(m.firstMs), warmMedianMs: round(m.warm), latencyKind: calls.length ? "fake-cli" : "code",
    entry: "bar", plainBar: null, pooled: null,
    correct: m.first.correct ?? false, check: m.first.check ?? "", notes: m.first.notes ?? [],
  };
}

const pathOf = (r: IntentCommandResult): Path => (r.path === "ai" ? "model" : r.path === "cache" ? "cache" : "code");
const answerPath = (r: IntentCommandResult): Path => {
  if (r.status !== "answer") return pathOf(r);
  const p = (r as { answerPath?: string }).answerPath;
  return r.tokens.in > 0 || p === "ai" ? "model" : r.path === "cache" ? "cache" : "code";
};

// ── Scripted fake-CLI answers (the model's output is fixed; what we measure is what we send) ───
const ask = (sentences: { text: string; sourceId: string; quote: string }[]) => ({
  output: { found: true, sentences: sentences.map((s) => ({ text: s.text, citations: [{ sourceId: s.sourceId, quote: s.quote }] })) },
});
const quizItem = (pid: string, n: number) => {
  const q = [
    { stem: "What happens when two keys map to the same bucket?", right: "A collision", wrong: ["A resize step", "A rehash pass", "A probe cycle"], quote: HASHING[3]! },
    { stem: "How does chaining resolve collisions?", right: "A linked list in each bucket", wrong: ["A sorted array in each bucket", "A second hash function", "Probing for an empty slot"], quote: HASHING[4]! },
    { stem: "What is the load factor?", right: "Stored keys divided by buckets", wrong: ["Buckets divided by stored keys", "Length of the longest chain", "Probes per successful lookup"], quote: HASHING[9]! },
    { stem: "When does Java's HashMap resize?", right: "When the load factor exceeds 0.75", wrong: ["When any chain has 8 entries", "After every 16 insertions", "Whenever two keys collide"], quote: HASHING[11]! },
    { stem: "What must equal objects return?", right: "The same hashCode", wrong: ["Different hashCodes", "The same toString", "Their memory address"], quote: HASHING[17]! },
  ][n]!;
  return {
    kind: "mc", stem: q.stem, options: [{ text: q.right, correct: true }, ...q.wrong.map((text) => ({ text, correct: false }))],
    statementIsTrue: null, numeric: null, explanation: "From the Lecture 5 notes.", topics: ["Hash tables"], section: "Recursion, trees and hashing", bloom: "remember", sourceId: pid, quote: q.quote,
  };
};
const card = (pid: string, sentence: string) => ({
  kind: "cloze", front: sentence, back: sentence.split(" ").filter((w) => w.length > 5)[0]!.replace(/[.,]$/, ""), topics: ["Hash tables"], section: "Recursion, trees and hashing", sourceId: pid, quote: sentence,
});
const intentOut = (action: string, args: Record<string, unknown>) => ({
  output: { action, args: { course: null, assignment: null, topics: null, date: null, time: null, query: null, kind: null, count: null, scope: null, ...args }, confidence: "high", alternatives: null, question: null },
});

/** Estimated reply tokens: the scripted reply's size (the shape the pack's schema forces). */
const outTokens = (spec: { output: unknown }) => Math.ceil(JSON.stringify(spec.output).length / 4);
/** The same scripted reply as the warm pool returns it: the union schema's { kind, data }. */
const pooledReply = (kind: string, spec: { output: unknown }) => ({ output: { kind, data: spec.output } });

/** One extra run of a phrasing, for the record: its outcome and model calls. */
async function variant(h: Harness, text: string, courseId?: string) {
  const before = (await h.readCalls()).length;
  const r = await h.command(text, courseId);
  const calls = (await h.readCalls()).length - before;
  const what = r.status === "answer" ? (r.notFound ? `"${r.text}"` : `answer with ${r.citations.length} checked citation(s)`) : r.status === "ran" ? `ran ${r.action}` : r.status === "unavailable" ? `unavailable ("${r.reason}")` : r.status;
  return `Variant "${text}"${courseId ? ` (course open)` : ""} → ${what}, ${calls} model call(s).`;
}

// ── The ten actions ────────────────────────────────────────────────────────────────────────────
/** `warmRuns` below 20 is for the deterministic test, which never asserts on timing. */
export async function runOurs(options: { warmRuns?: number } = {}): Promise<OurRow[]> {
  warmRuns = Math.max(1, options.warmRuns ?? WARM_RUNS);
  const ids = probeIds();
  const rows: OurRow[] = [];

  // 1. What's due this week: agenda.due, code path.
  {
    const h = await harness([]);
    const u = "what's due this week";
    const m = await measure(h, async () => {
      const r = await h.command(u);
      const result = r.status === "ran" ? (r.result as { entries?: { title: string; kind: string }[]; items?: { title: string }[] }) : {};
      const titles = [...new Set((result.entries?.filter((e) => e.kind === "assignment" || e.kind === "exam") ?? result.items ?? []).map((e) => e.title))].sort();
      const ok = r.status === "ran" && r.action === "agenda.due" && JSON.stringify(titles) === JSON.stringify(EXPECT_DUE_THIS_WEEK);
      return { path: pathOf(r), correct: ok, check: `due titles ${JSON.stringify(titles)} = ${JSON.stringify(EXPECT_DUE_THIS_WEEK)}` };
    });
    rows.push(row(1, "What's due this week", u, m));
    await h.close();
  }

  // 2. What changed since yesterday: the rail's path, core.query({view:"changes"}) + changeNotes. 0 calls.
  {
    const h = await harness([intentOut("agenda.due", {})]);
    const u = "what changed since yesterday";
    const m = await measure(h, async () => {
      const q = h.core.query({ view: "changes", limit: 100 }) as Extract<QueryResult, { view: "changes" }>;
      const recent = q.changes.filter((c) => c.observedAt >= SINCE_YESTERDAY);
      const notes = changeNotes(recent.map((c) => ({ resourceId: c.resourceId, type: c.type, observedAt: c.observedAt, oldValues: c.oldValues, newValues: c.newValues })), NOW.toISOString(), TZ);
      const titles = new Map(recent.map((c) => [c.resourceId, h.store.resource(c.resourceId)?.title ?? ""]));
      const hw4 = recent.find((c) => titles.get(c.resourceId) === "Homework 4" && c.type === "date_changed");
      const ann = recent.find((c) => titles.get(c.resourceId) === "Homework 4 deadline moved" && c.type === "new");
      const hw4Note = hw4 ? notes.get(hw4.resourceId) ?? [] : [];
      const ok = !!hw4 && (hw4.newValues as { dueAt?: string }).dueAt === HW4_MOVED && !!ann && hw4Note.length > 0 && recent.length === q.changes.filter((c) => c.observedAt >= SINCE_YESTERDAY).length;
      return { path: "code", correct: ok, check: `Homework 4 moved to ${HW4_MOVED} (note: ${JSON.stringify(hw4Note)}) and the new announcement, from ${recent.length} change rows` };
    });
    const r = row(2, "What changed since yesterday", u, m);
    r.entry = "rail";
    // What the command bar does with the same words, for the record (one run; the model is scripted).
    const bar = await h.command(u);
    r.plainBar = `${bar.status}${bar.status === "ran" ? ` ${bar.action}` : bar.status === "answer" ? ` "${bar.text}"` : ""}, ${(await h.readCalls()).length} model calls`;
    r.notes.push(`Command bar: "${u}" → ${r.plainBar}. No changes action is registered, so the bar can't answer this; the Today rail's changes path above does.`);
    rows.push(r);
    await h.close();
  }

  // 3. Explain a topic from lecture: the grounded ask, one checked call; the repeat is a cache hit.
  {
    const reply = ask([
      { text: "A hash table keeps key-value pairs in an array of buckets, and a hash function picks each key's bucket.", sourceId: ids.lecture, quote: HASHING[1]! },
      { text: "When two keys land in the same bucket, that is a collision; chaining keeps a linked list per bucket.", sourceId: ids.lecture, quote: HASHING[4]! },
    ]);
    const h = await harness([reply]);
    const u = "explain hash tables from lecture";
    const m = await measure(h, async () => {
      const r = await h.command(u, "c400");
      const ok = r.status === "answer" && r.citations.length === 2 && r.citations.every((c) => c.start !== null && h.store.resource(c.resourceId)?.title === "Lecture 5 notes: Hashing");
      return { path: answerPath(r), correct: ok, check: `${r.status === "answer" ? r.citations.length : 0} citations, each found verbatim in the Lecture 5 notes by code` };
    });
    const r = row(3, "Explain <topic> from lecture", u, m);
    await barModelRow(r, h, reply, askPack.id, "c400");
    rows.push(r);
    await h.close();
  }

  // 4. Quiz me (5 questions): first-time generation (one call), then the quiz at 0 calls.
  {
    const reply = { output: { items: [0, 1, 2, 3, 4].map((n) => quizItem(ids.lecture, n)) } };
    const h = await harness([reply]);
    const scope = { courseId: "c400", topicIds: [h.hashTables] };
    const before = (await h.readCalls()).length;
    const t0 = performance.now();
    const gen = (await h.handler.run("quiz", scope, undefined, { count: 5 })) as PackRunResult;
    const genMs = performance.now() - t0;
    const genCalls = (await h.readCalls()).slice(before);
    const again = (await h.handler.run("quiz", scope, undefined, { count: 5 })) as PackRunResult;
    const genRepeat = (await h.readCalls()).slice(before + genCalls.length);
    const u = "quiz me on hash tables in cs 400";
    const items = h.store.learning.items({ courseRef: h.ref });
    const m = await measure(h, async () => {
      const r = await h.command(u);
      const started = r.status === "ran" ? (r.result as LearningResult) : null;
      if (!started || started.status !== "ok") return { path: pathOf(r), correct: false, check: `quiz did not start: ${JSON.stringify(started ?? r).slice(0, 200)}` };
      let { session } = started.data as PracticeRoundData;
      let right = 0;
      let asked = 0;
      for (let n = 0; n < 10 && session.currentItem; n++) {
        const cur = session.currentItem;
        const key = items.find((x) => x.item.id === cur.id)!.item;
        asked++;
        const answered = await h.learn({ op: "study.answer", sessionId: session.id, revision: session.revision, operationId: `a-${session.id}-${n}`, itemId: cur.id, itemVersion: cur.version, response: { kind: "choice", optionId: String(key.key) }, confidence: null, responseMs: 2000 });
        session = (answered.data as PracticeRoundData).session;
        if (session.events.at(-1)?.outcome === "correct") right++;
        const next = await h.learn({ op: "study.advance", sessionId: session.id, revision: session.revision, operationId: `n-${session.id}-${n}`, action: "next" });
        if (next.status !== "ok") break;
        session = (next.data as PracticeRoundData).session;
      }
      const submitted = await h.learn({ op: "study.submit", sessionId: session.id });
      const ok = gen.status === "done" && gen.counts.accepted === 5 && asked === 5 && right === 5 && submitted.status === "ok";
      return { path: pathOf(r), correct: ok, check: `generated ${gen.counts.accepted}/5 checked items${gen.drops.length ? ` (dropped: ${gen.drops.map((d) => `${d.stage}: ${d.reason}`).join("; ")})` : ""}; quiz served ${asked}, graded ${right} correct by code; submit ${submitted.status}` };
    });
    const r = row(4, "Quiz me on <topic> (5 questions)", u, m, { calls: genCalls, repeat: genRepeat });
    r.firstMs = round(genMs + m.firstMs); // the first time includes generating the pool
    r.latencyKind = "fake-cli";
    r.entry = "pack handler + bar";
    r.outputTokens = genCalls.length * outTokens(reply);
    r.notes.push(`First time: ${genCalls.length} generation call (${genCalls.reduce((s, c) => s + c.tokens, 0)} tokens); second time: ${again.cached ? "cache hit" : "regenerated"}, ${genRepeat.length} calls. The quiz itself: ${m.firstCalls.length} calls.`);
    r.plainBar = (await variant(h, "make 5 questions on hash tables in cs 400")).replace(/^Variant /, "");
    r.notes.push(`Command bar generation: ${r.plainBar}`);
    r.notes.push("pack.generate passes no count to the pack, so a generation started from the command bar asks for the pack default (8 questions), not the 5 requested; this row generates through the pack handler with count 5.");
    rows.push(r);
    await h.close();
  }

  // 5. A 20-card flashcard review: first-time generation (one call), then review at 0 calls.
  {
    const reply = { output: { cards: HASHING.slice(0, 20).map((s) => card(ids.lecture, s)) } };
    const h = await harness([reply]);
    const scope = { courseId: "c400", topicIds: [h.hashTables] };
    const before = (await h.readCalls()).length;
    const t0 = performance.now();
    const gen = (await h.handler.run("cards", scope, undefined, { count: 20 })) as PackRunResult;
    const genMs = performance.now() - t0;
    const genCalls = (await h.readCalls()).slice(before);
    const again = (await h.handler.run("cards", scope, undefined, { count: 20 })) as PackRunResult;
    const genRepeat = (await h.readCalls()).slice(before + genCalls.length);
    const u = "cs 400 flashcards due";
    const m = await measure(
      h,
      async () => {
        const r = await h.command(u);
        const started = r.status === "ran" ? (r.result as LearningResult) : null;
        if (!started || started.status !== "ok") return { path: pathOf(r), correct: false, check: `review did not start: ${JSON.stringify(started ?? r).slice(0, 200)}` };
        let fc = (started.data as FlashcardData).flashcards;
        let reviewed = 0;
        for (let n = 0; n < 40 && fc.current; n++) {
          const rated = await h.learn({ op: "study.review", sessionId: fc.id, revision: fc.revision, operationId: `r-${fc.id}-${n}`, cardId: fc.current.cardId, rating: 3, reviewMs: 1500 });
          if (rated.status !== "ok") break;
          fc = (rated.data as FlashcardData).flashcards;
          reviewed++;
        }
        const ok = gen.status === "done" && gen.counts.accepted === 20 && reviewed >= 20;
        return { path: pathOf(r), correct: ok, check: `generated ${gen.counts.accepted}/20 checked cards; reviewed ${reviewed} with FSRS in code` };
      },
      // Between sessions the student's clock moves past every card's next due date.
      (i) => { if (i > 0) h.advanceLearningClock(400); },
    );
    const r = row(5, "20-card flashcard review", u, m, { calls: genCalls, repeat: genRepeat });
    r.firstMs = round(genMs + m.firstMs); // the first time includes generating the pool
    r.latencyKind = "fake-cli";
    r.entry = "pack handler + bar";
    r.outputTokens = genCalls.length * outTokens(reply);
    r.notes.push(`First time: ${genCalls.length} generation call; second time: ${again.cached ? "cache hit" : "regenerated"}. Review sessions: ${m.firstCalls.length} calls.`);
    r.plainBar = (await variant(h, "make 20 flashcards on hash tables in cs 400")).replace(/^Variant /, "");
    r.notes.push(`Command bar generation: ${r.plainBar}`);
    r.notes.push("pack.generate passes no count to the pack, so \"make 20 flashcards …\" from the command bar asks for the pack default (10 cards), not 20; this row generates through the pack handler with count 20.");
    rows.push(r);
    await h.close();
  }

  // 6. Find the slides: materials.search, code path.
  {
    const h = await harness([]);
    const u = "find the slides on hashing";
    const m = await measure(h, async () => {
      const r = await h.command(u);
      const hits = r.status === "ran" ? ((r.result as { hits: { title: string }[] }).hits ?? []) : [];
      const rank = hits.findIndex((x) => x.title === "Lecture 5 slides: Hashing");
      return { path: pathOf(r), correct: r.status === "ran" && rank >= 0 && rank < 3, check: `slides at rank ${rank + 1} of ${hits.length} (${hits.map((x) => x.title).join("; ")})` };
    });
    rows.push(row(6, "Find the slides/file for <topic>", u, m));
    await h.close();
  }

  // 7. When and where is the exam, and what's on it: the grounded ask over the syllabus.
  {
    const reply = ask([
      { text: "The midterm is Thursday, October 15, 7:15 to 9:15 PM, in Room 1240 Computer Sciences.", sourceId: ids.syllabus, quote: EXAM_SENTENCE },
      { text: "It covers lectures 1 through 6: recursion, binary search trees and hashing.", sourceId: ids.syllabus, quote: EXAM_COVERS },
    ]);
    const h = await harness([reply]);
    const u = "when and where is the midterm, and what's on it";
    const m = await measure(h, async () => {
      const r = await h.command(u, "c400");
      const quotes = r.status === "answer" ? r.citations.map((c) => c.quote) : [];
      const ok = r.status === "answer" && quotes.includes(EXAM_SENTENCE) && quotes.includes(EXAM_COVERS);
      return { path: answerPath(r), correct: ok, check: "the date/room and coverage sentences reached the model and both quotes check against the syllabus" };
    });
    const r = row(7, "When/where is the exam, what's on it", u, m);
    await barModelRow(r, h, reply, askPack.id, "c400");
    r.notes.push(await variant(h, "when and where is the midterm in cs 400, and what's on it"));
    rows.push(r);
    await h.close();
  }

  // 8. What do I need on the final for a B: no calculator exists; the bar sends it to the grounded ask.
  {
    const reply = ask([{ text: "The final exam is 40% of the grade, and a B starts at 83.", sourceId: ids.syllabus, quote: GRADING }]);
    const h = await harness([reply]);
    const u = "what do I need on the final for a B if I get 80 on the midterm";
    const need = expectedFinalForB();
    let prompt = "";
    const m = await measure(h, async () => {
      const r = await h.command(u, "c400");
      prompt = prompt || (await h.promptText());
      const scoresSent = SCORES.homework.every((s) => prompt.includes(`${s.score}`)) && /46\s*\/\s*50|46 of 50/.test(prompt);
      // The same ±1-point tolerance as the baseline's check (workspace.ts percentNear).
      const ok = r.status === "answer" && scoresSent && percentNear(r.text, need);
      return {
        path: answerPath(r), correct: ok,
        check: `expected ${need}% on the final (homework ${SCORES.homework.map((s) => `${s.score}/${s.points}`).join(", ")}, midterm assumed 80, weights 30/30/40, B = 83); the prompt ${scoresSent ? "carries" : "does not carry"} the student's scores`,
        notes: ["Not built: no code computes a needed final score. Canvas scores and group weights are stored (submission.score, assignmentGroup.weight), but the ask sends only syllabus passages, so the model cannot know the scores. Per AGENTS.md this arithmetic belongs in code."],
      };
    });
    const r8 = row(8, "What do I need on the final for a B", u, m);
    await barModelRow(r8, h, reply, askPack.id, "c400");
    rows.push(r8);
    await h.close();
  }

  // 9. Summarize the new announcement: the grounded ask.
  {
    const reply = ask([{ text: "Homework 4 now is due Friday, October 9 at 11:59 PM.", sourceId: ids.announcement, quote: ANNOUNCEMENT.split(". ")[0]! + "." }]);
    const h = await harness([reply]);
    const u = "summarize the new announcement";
    let prompt = "";
    const m = await measure(h, async () => {
      const r = await h.command(u, "c400");
      prompt = prompt || (await h.promptText());
      const sent = prompt.includes(ANNOUNCEMENT.slice(0, 60));
      const ok = r.status === "answer" && sent && r.citations.some((c) => h.store.resource(c.resourceId)?.title === "Homework 4 deadline moved");
      return { path: answerPath(r), correct: ok, check: `announcement text ${sent ? "reached" : "did not reach"} the model; ${r.status === "answer" ? r.citations.length : 0} checked citation(s)${r.status === "answer" && r.notFound ? "; answered Not in your materials" : ""}` };
    });
    const r = row(9, "Summarize the new announcement", u, m);
    await barModelRow(r, h, reply, askPack.id, "c400");
    r.notes.push(await variant(h, "summarize the homework 4 announcement"));
    rows.push(r);
    await h.close();
  }

  // 10. Open the email from my TA about the regrade: mail.search (stored fields only) → its link.
  {
    const reply = intentOut("mail.search", { query: "regrade" });
    const h = await harness([reply]);
    const u = "open the email from my TA about the regrade";
    const m = await measure(h, async () => {
      const r = await h.command(u);
      const items = r.status === "ran" && r.action === "mail.search" ? ((r.result as { items: { subject: string; webLink: string }[] }).items ?? []) : [];
      const top = items[0];
      const ok = !!top && top.subject === TA_EMAIL.subject && top.webLink.includes("ta-regrade");
      return { path: pathOf(r), correct: ok, check: `${r.status === "ran" ? r.action : r.status}: top result "${top?.subject ?? "none"}"${top ? ` → ${top.webLink}` : ""}` };
    });
    const r = row(10, "Open the email from my TA about <x>", u, m);
    await barModelRow(r, h, reply, classifyPack.id);
    rows.push(r);
    await h.close();
  }
  return rows;
}

/**
 * Fills a command-bar model row: the output estimate, the entry point, what the plain bar (no
 * course open) does with the same words, and the warm pool's first turn for the same action.
 */
async function barModelRow(r: OurRow, h: Harness, reply: { output: unknown }, packId: string, courseId?: string) {
  r.outputTokens = r.calls * outTokens(reply);
  r.entry = courseId ? "bar+course" : "bar";
  if (courseId) r.plainBar = (await variant(h, r.utterance)).replace(/^Variant "[^"]*" /, "");
  const turns = await warmTurns([pooledReply(packId, reply)], [{ text: r.utterance, courseId }]);
  const first = turns.turns[0];
  r.pooled = first ? { prefixTokens: first.prefixTokens, inputTokens: first.inputTokens } : null;
}

export interface WarmTurn { text: string; spawned: boolean; prefixTokens: number; inputTokens: number; historyTokens: number; outputTokens: number; billedInputTokens: number }
/**
 * Runs command-bar asks through the warm session pool the worker wires (fake CLI in stream-json
 * mode) and reads what each turn sent. The CLI keeps the conversation, so a turn's billed input
 * is its session's prefix (system prompt + protocol + union schema) + every earlier message and
 * reply in that session + its own message. The fake CLI doesn't bill, so the history is added up
 * from the log and the scripted replies; the pool's 40k-token rotation and 10-minute idle close
 * (pool.ts) reset it.
 */
export async function warmTurns(replies: { output: unknown }[], steps: { text: string; courseId?: string }[]): Promise<{ turns: WarmTurn[]; spawns: number }> {
  const h = await harness(replies, { pooled: true });
  const turns: WarmTurn[] = [];
  let seen = 0;
  let prefix = 0;
  let history = 0;
  let replyIndex = 0;
  let spawns = 0;
  try {
    for (const step of steps) {
      await h.command(step.text, step.courseId);
      const log = await h.sessionLog();
      let spawned = false;
      for (const e of log.slice(seen)) {
        if (e.event === "spawn") {
          spawned = true;
          spawns++;
          prefix = e.prefixTokens;
          history = 0;
          continue;
        }
        const out = outTokens(replies[Math.min(replyIndex++, replies.length - 1)]!);
        turns.push({ text: step.text, spawned, prefixTokens: prefix, inputTokens: e.inputTokens, historyTokens: history, outputTokens: out, billedInputTokens: prefix + history + e.inputTokens });
        history += e.inputTokens + out;
        spawned = false;
      }
      seen = log.length;
    }
  } finally {
    await h.close();
  }
  return { turns, spawns };
}

/** A burst of five different asks about one course inside the pool's idle window: history carried. */
export async function warmBurst() {
  const { lecture, syllabus } = probeIds();
  const steps: { text: string; quotes: { sourceId: string; quote: string }[] }[] = [
    { text: "explain hash tables from lecture", quotes: [{ sourceId: lecture, quote: HASHING[1]! }, { sourceId: lecture, quote: HASHING[4]! }] },
    { text: "when and where is the midterm, and what's on it", quotes: [{ sourceId: syllabus, quote: EXAM_SENTENCE }, { sourceId: syllabus, quote: EXAM_COVERS }] },
    { text: "explain the load factor from lecture", quotes: [{ sourceId: lecture, quote: HASHING[9]! }] },
    { text: "explain chaining from lecture", quotes: [{ sourceId: lecture, quote: HASHING[4]! }] },
    { text: "explain open addressing from lecture", quotes: [{ sourceId: lecture, quote: HASHING[5]! }] },
  ];
  const replies = steps.map((s) => pooledReply(askPack.id, ask(s.quotes.map((q) => ({ text: "From the course materials.", ...q })))));
  return warmTurns(replies, steps.map((s) => ({ text: s.text, courseId: "c400" })));
}

/**
 * One-time costs of a first sync, from the code that runs: the material pipeline's registered jobs
 * (passages, links and facts, the course pass) are code; mail gists and cards are stubs never
 * enqueued; Jev's assignment-kind judgment (`enrich.resource`, packages/core/src/jobs/enrich.ts)
 * runs once per assignment whose Canvas submission types don't settle the kind, on the owner-paid
 * gateway, not the student's model. The concept map grows from the topic labels generation packs
 * already return (pack-handler.ts tagsFor), with no call of its own.
 */
export function oneTimeCosts() {
  const { store } = semesterWorkspace();
  const assignments = store.resources().filter((r) => !r.deleted && r.kind === "assignment");
  const jev = assignments.filter((r) => !codeAssignmentKind(r)).length;
  store.close();
  const registry = pipelineJobRegistry();
  return {
    studentModelCalls: 0,
    pipelineJobs: registry.readyKinds(),
    stubJobs: registry.kinds().filter((k) => !registry.readyKinds().includes(k)),
    jevCalls: jev,
    assignments: assignments.length,
    basis: "Registered pipeline jobs are code (packages/core/src/jobs/default-registry.ts); Jev judges each assignment whose submission types don't decide its kind, once per title+text (enrich.ts), on our gateway. The synthetic assignments carry no submission types, so every one counts: an upper bound.",
  };
}

