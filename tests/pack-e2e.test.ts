// Generation end to end on a synthetic course: the pack command → the student's (fake) client →
// N06's gates → the N24 LearningStore → N25's study.plan serving the pool at 0 tokens.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import { defaultPrivacy, type CaptureBatch, type LearningRequest, type LearningResult, type ResourceInput, type StudySessionView } from "@magic/contracts";
import { createClaudeBackend, type CliCommand, type ModelRunner } from "../packages/runner/src/index";
import { createPackRuntime } from "../packages/packs/core/src/index";
import { createPackHandler, type PackRunResult } from "../packages/core/src/pack-handler";
import { createLearningRouter } from "../packages/learning/src/router";
import { createStudyContextResolver } from "../apps/desktop/src/learning-context";

const here = dirname(fileURLToPath(import.meta.url));
const fake: CliCommand = { file: process.execPath, prefixArgs: [join(here, "fixtures", "fake-cli", "fake-cli.mjs"), "claude"] };
const TEXT = [
  "A stack is a last-in, first-out collection of elements.",
  "A queue is a first-in, first-out collection of elements.",
  "Each list node holds 4 bytes, so 25 nodes use 100 bytes in total.",
  "Hash tables resolve collisions by chaining entries in a linked list.",
].join(" ");
const input = (id: string, kind: ResourceInput["kind"], extra: Partial<ResourceInput> = {}): ResourceInput => ({
  externalId: id,
  kind,
  courseId: "SYN101",
  courseName: "Synthetic Data Structures",
  title: `Synthetic ${id}`,
  text: TEXT,
  url: `https://canvas.example.test/${id}`,
  deadlines: [],
  points: null,
  submitted: null,
  policy: { mode: "coaching", evidence: "Synthetic: AI help is allowed for practice." },
  ...extra,
});
const batch = (id: string, resources: ResourceInput[]): CaptureBatch => ({
  source: { id, kind: "canvas", accountScope: "acct", courseId: "SYN101", scope: id, label: "Synthetic" },
  observedAt: "2090-01-01T00:00:00.000Z",
  complete: true,
  status: "ok",
  resources,
});

async function setup(responses: (pid: string) => unknown[], opts: { consent?: boolean; client?: boolean } = {}) {
  const store = createStore(":memory:");
  const assignments = batch("assignments", [input("target", "assignment", { text: "Synthetic homework prompt.", points: 10 })]);
  store.ingest(assignments);
  store.ingest(batch("materials", [input("reading", "material")]));
  const target = store.resources().find((r) => r.externalId === "target")!;
  const reading = store.resources().find((r) => r.externalId === "reading")!;
  store.putLink({ id: "link", fromId: reading.id, toId: target.id, type: "specifies", reason: "Synthetic pointer", status: "accepted", inputHash: reading.contentHash });
  store.setPrivacy({ ...defaultPrivacy, mode: "selective_cloud", hostedProvider: "claude", shareCourseText: true });
  const pid = `p${store.passages(reading.id)[0]!.pid}`;
  const dir = await mkdtemp(join(tmpdir(), "pack-e2e-"));
  const workDir = join(dir, "work");
  await mkdir(workDir);
  const log = join(dir, "log.jsonl");
  const env = { FAKE_CLI_LOG: log, FAKE_CLI_STATE: join(dir, "state"), FAKE_CLI_RESPONSES: JSON.stringify(responses(pid)) };
  const runner: ModelRunner = createPackRuntime(createClaudeBackend({ command: fake, workDir, env }), { dailyBackgroundTokens: 1_000_000 }).runner;
  const handler = createPackHandler({ store, runner: () => (opts.client === false ? null : runner) });
  const core = createCore(store, { fixture: assignments, seams: { pack: handler.pack } });
  if (opts.consent !== false)
    await core.execute({ type: "consent", value: { action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION } });
  const calls = async () => (existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n").length : 0);
  return { store, core, target, reading, handler, calls, pid };
}
const pack = async (core: ReturnType<typeof createCore>, name = "quiz") =>
  (await core.execute({ type: "pack", pack: name, scope: { courseId: "SYN101" } })).pack as PackRunResult;

const item = (pid: string, over: Record<string, unknown>) => ({
  kind: "mc",
  stem: "Which collection is last-in, first-out?",
  options: [
    { text: "A stack", correct: true },
    { text: "A queue", correct: false },
    { text: "A heap", correct: false },
    { text: "A graph", correct: false },
  ],
  statementIsTrue: null,
  numeric: null,
  explanation: "The reading defines a stack as last-in, first-out.",
  topics: ["Stacks"],
  section: "Linear structures",
  bloom: "remember",
  sourceId: pid,
  quote: "A stack is a last-in, first-out collection of elements.",
  ...over,
});
const quiz = (pid: string) => ({
  output: {
    items: [
      item(pid, {}),
      item(pid, {
        kind: "tf",
        stem: "A queue is first-in, first-out.",
        options: [],
        statementIsTrue: true,
        topics: ["Queues"],
        quote: "A queue is a first-in, first-out collection of elements.",
      }),
      item(pid, {
        kind: "numeric",
        stem: "How many bytes do 25 list nodes use?",
        options: [],
        numeric: { value: 100, unit: "bytes", formula: "25 * 4 bytes" },
        topics: ["Memory use"],
        quote: "Each list node holds 4 bytes, so 25 nodes use 100 bytes in total.",
      }),
      // Fabricated quote: dropped at N06 stage 3 with its reason.
      item(pid, { stem: "Which structure was invented in 1946?", topics: ["History"], quote: "Stacks were invented in 1946 by Alan Turing." }),
      // Two options marked correct: the item fails (exactly one key).
      item(pid, {
        stem: "Which collections store elements in order?",
        options: [
          { text: "A stack", correct: true },
          { text: "A queue", correct: true },
          { text: "A heap", correct: false },
          { text: "A graph", correct: false },
        ],
      }),
    ],
  },
});

test("quiz end to end: generated, gated, stored; a fabricated quote and two keys are dropped with reasons; study.plan serves the pool with no model", async () => {
  const g = await setup((pid) => [quiz(pid)]);
  try {
    const r = await pack(g.core);
    assert.equal(r.status, "done", r.message);
    assert.equal(r.cached, false);
    assert.equal(r.counts.generated, 5);
    assert.equal(r.counts.accepted, 3);
    assert.deepEqual(r.counts.droppedBy, { quote: 1, schema: 1 });
    assert.match(r.drops.find((d) => d.stage === "quote")!.reason, /quote not found/);
    assert.match(r.drops.find((d) => d.stage === "schema")!.reason, /2 options are marked correct/);
    assert.ok(r.tokens.in > 0);
    assert.equal(r.artifactIds.length, 1);
    assert.ok(g.store.receipts().some((x) => x.recipient === "claude" && x.status === "sent" && x.categories.includes("course_text")));

    const ref = "acct:SYN101";
    const stored = g.store.learning.items({ courseRef: ref });
    assert.equal(stored.length, 3);
    for (const s of stored) {
      assert.equal(s.item.origin, "generated");
      assert.ok(s.tags.length >= 1 && s.tags.some((t) => t.primary));
      assert.equal(g.reading.text.slice(s.sources[0]!.start, s.sources[0]!.end), s.sources[0]!.quote);
      for (const c of ["policy", "schema", "quote", "flaws", "near_duplicate", "tags"])
        assert.equal(s.checks.find((x) => x.check === c)?.outcome, "pass", c);
    }
    assert.equal(stored.find((s) => s.item.kind === "numeric")!.checks.find((c) => c.check === "executed")?.outcome, "pass");
    // Topics and their section are on the course map.
    const map = g.store.learning.concepts(ref);
    const stacks = map.find((c) => c.label === "Stacks")!;
    assert.equal(map.find((c) => c.id === stacks.parentId)?.label, "Linear structures");

    // Study time: the teammate's router, with no runner reachable, over the pool the pack filled.
    const before = await g.calls();
    const router = createLearningRouter({ store: g.store.learning, resolveContext: createStudyContextResolver(g.store, g.core) });
    const call = (request: LearningRequest) => router.handle(request, new AbortController().signal);
    const view = (x: LearningResult) => {
      assert.equal(x.status, "ok", x.message);
      return (x.data as { session: StudySessionView }).session;
    };
    const s = view(await call({ op: "study.plan", resourceId: g.target.id, inputHash: g.target.contentHash, operationId: "start", minutes: 15, difficulty: "normal" }));
    const current = s.currentItem!;
    assert.ok(stored.some((x) => x.item.id === current.id));
    const key = stored.find((x) => x.item.id === current.id)!.item;
    const response =
      current.kind === "numeric" ? { kind: "number" as const, value: Number(key.key), unit: key.unit } : current.options ? { kind: "choice" as const, optionId: String(key.key) } : { kind: "text" as const, text: String(key.key) };
    const answered = view(
      await call({ op: "study.answer", sessionId: s.id, revision: s.revision, operationId: "a1", itemId: current.id, itemVersion: current.version, response, confidence: null, responseMs: 1500 }),
    );
    assert.equal(answered.events.at(-1)?.outcome, "correct");
    assert.equal(g.store.learning.evidence(ref).attempts.length, 1);
    assert.equal(await g.calls(), before, "no model was called at study time");
  } finally {
    g.store.close();
  }
});

test("a repeat with unchanged content is a cache hit: 0 tokens, no model call, a 0-token ledger row, no duplicate items", async () => {
  const g = await setup((pid) => [quiz(pid)]);
  try {
    const first = await pack(g.core);
    assert.equal(first.status, "done", first.message);
    const calls = await g.calls();
    const again = await pack(g.core);
    assert.equal(again.status, "done");
    assert.equal(again.cached, true);
    assert.deepEqual(again.tokens, { in: 0, cached: 0, out: 0 });
    assert.deepEqual(again.itemIds, first.itemIds);
    assert.equal(await g.calls(), calls);
    const rows = g.store.ledger();
    assert.ok(rows.some((r) => r.tier === "cache" && r.tokensIn + r.tokensOut + r.tokensCached === 0 && r.course?.courseId === "SYN101"));
    assert.ok(rows.some((r) => r.tier === "pass" && r.tokensIn > 0));
    assert.equal(g.store.learning.items({ courseRef: "acct:SYN101" }).length, 3);
  } finally {
    g.store.close();
  }
});

test("no consent: blocked with a receipt, and no model call", async () => {
  const g = await setup(() => [{ output: {} }], { consent: false });
  try {
    const r = await pack(g.core);
    assert.equal(r.status, "blocked");
    assert.match(r.message, /not agreed/);
    assert.equal(r.receiptIds.length, 1);
    assert.ok(g.store.receipts().some((x) => x.id === r.receiptIds[0] && x.status === "blocked" && x.recipient === "claude"));
    assert.equal(await g.calls(), 0);
    assert.equal(g.store.learning.items().length, 0);
  } finally {
    g.store.close();
  }
});

test("no client connected: a friendly answer, never a throw", async () => {
  const g = await setup(() => [{ output: {} }], { client: false });
  try {
    const r = await pack(g.core, "cards");
    assert.equal(r.status, "no_client");
    assert.match(r.message, /Connect your AI first/);
    assert.equal(await g.calls(), 0);
  } finally {
    g.store.close();
  }
});

// Operator decision 2026-09-27: item packs retry once on the pass tier and never escalate to the strong model.
test("a batch failing the checks is retried once on the pass tier, never escalated, then put to the student", async () => {
  const g = await setup((pid) => [{ output: { items: [item(pid, { quote: "Queues were invented by Grace Hopper in 1952." })] } }]);
  try {
    const r = await pack(g.core);
    assert.equal(r.status, "needs_student");
    assert.deepEqual(r.options, ["retry", "narrow_scope", "skip"]);
    assert.ok(r.checkErrors?.some((e) => /quote not found/.test(e)));
    assert.equal(await g.calls(), 2);
    assert.equal(g.store.learning.items().length, 0);
  } finally {
    g.store.close();
  }
});

test("flashcards: term cards get an FSRS card, cloze is blanked by code; both stored as checked versions", async () => {
  const cards = (pid: string) => ({
    output: {
      cards: [
        { kind: "term", front: "Queue", back: "A first-in, first-out collection of elements", topics: ["Queues"], section: "Linear structures", sourceId: pid, quote: "A queue is a first-in, first-out collection of elements." },
        { kind: "cloze", front: "Hash tables resolve collisions by chaining entries in a linked list.", back: "chaining", topics: ["Hashing"], section: "Hash tables", sourceId: pid, quote: "Hash tables resolve collisions by chaining entries in a linked list." },
      ],
    },
  });
  const g = await setup((pid) => [cards(pid)]);
  try {
    const r = await pack(g.core, "cards");
    assert.equal(r.status, "done", r.message);
    assert.equal(r.counts.accepted, 2, JSON.stringify(r.drops));
    const items = g.store.learning.items({ courseRef: "acct:SYN101" });
    const term = items.find((x) => x.item.kind === "card")!;
    const cloze = items.find((x) => x.item.kind === "cloze")!;
    assert.equal(term.item.stem, "Queue");
    assert.equal(cloze.item.stem, "Hash tables resolve collisions by _____ entries in a linked list.");
    assert.equal(cloze.item.key, "chaining");
    assert.equal(g.store.learning.cards({ itemId: term.item.id }).length, 1);
  } finally {
    g.store.close();
  }
});
