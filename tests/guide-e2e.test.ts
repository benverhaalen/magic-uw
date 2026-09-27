// Study guides, steps 3–4 end to end on a synthetic course: the pack command → the student's
// (fake) client → the code checks → the artifact cache; `guide-view` personalises it at 0 tokens,
// and new attempts change the view without a model call or a new cache key.
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
import { defaultPrivacy, type CaptureBatch, type ResourceInput } from "@magic/contracts";
import { createClaudeBackend, type CliCommand } from "../packages/runner/src/index";
import { createPackRuntime } from "../packages/packs/core/src/index";
import { createPackHandler } from "../packages/core/src/pack-handler";
import type { GuideRunResult, GuideViewResult, GuideView, ConceptMapView } from "../packages/packs/guide/src/index";
import type { LearningAttempt } from "../packages/learning/src/store";

const here = dirname(fileURLToPath(import.meta.url));
const fake: CliCommand = { file: process.execPath, prefixArgs: [join(here, "fixtures", "fake-cli", "fake-cli.mjs"), "claude"] };
const TEXT = [
  "A stack is a last-in, first-out collection of elements.",
  "A queue is a first-in, first-out collection of elements.",
  "Each list node holds 4 bytes, so 25 nodes use 100 bytes in total.",
  "The midterm is on October 14, 2026.",
].join(" ");
const input = (id: string, over: Partial<ResourceInput> = {}): ResourceInput => ({
  externalId: id,
  kind: "material",
  courseId: "SYN101",
  courseName: "Synthetic Data Structures",
  title: `Synthetic ${id}`,
  text: TEXT,
  url: `https://canvas.example.test/${id}`,
  deadlines: [],
  points: null,
  submitted: null,
  policy: { mode: "coaching", evidence: "Synthetic: AI help is allowed for practice." },
  module: { id: "m1" },
  ...over,
});
const batch = (resources: ResourceInput[], observedAt = "2090-01-01T00:00:00.000Z"): CaptureBatch => ({
  source: { id: "materials", kind: "canvas", accountScope: "acct", courseId: "SYN101", scope: "materials", label: "Synthetic" },
  observedAt,
  complete: true,
  status: "ok",
  resources,
});

const Q = {
  stack: "A stack is a last-in, first-out collection of elements.",
  queue: "A queue is a first-in, first-out collection of elements.",
  bytes: "Each list node holds 4 bytes, so 25 nodes use 100 bytes in total.",
  midterm: "The midterm is on October 14, 2026.",
};
const b = (pid: string, topic: string, quote: string, over: Record<string, unknown> = {}) => ({
  kind: "point", topic, heading: null, text: `${topic}: what the reading says.`, expression: null, result: null, date: null, cells: null, sourceId: pid, quote, ...over,
});
const guideOut = (pid: string) => ({
  output: {
    title: "Module m1 study guide",
    sections: [
      { title: "Stacks", topics: ["Stacks"], columns: null, blocks: [b(pid, "Stacks", Q.stack), b(pid, "Stacks", Q.stack, { kind: "definition", heading: "Stack" })] },
      { title: "Queues", topics: ["Queues"], columns: null, blocks: [b(pid, "Queues", Q.queue)] },
      {
        title: "Memory use",
        topics: ["Memory use"],
        columns: null,
        blocks: [
          b(pid, "Memory use", Q.bytes, { kind: "example", expression: "25 * 4 bytes", result: "100 bytes" }),
          b(pid, "Memory use", Q.bytes, { kind: "example", expression: "25 * 4 bytes", result: "120 bytes" }),
          b(pid, "Memory use", "Lists were invented in 1955 by synthetic authors."),
        ],
      },
    ],
  },
});
const mapOut = (pid: string) => ({
  output: {
    title: "Module m1 map",
    nodes: [
      { id: "n1", label: "Stacks", sourceId: pid, quote: Q.stack },
      { id: "n2", label: "Queues", sourceId: pid, quote: Q.queue },
    ],
    edges: [
      { from: "n1", to: "n2", kind: "confused_with", sourceId: pid, quote: Q.queue },
      { from: "n2", to: "n1", kind: "prerequisite", sourceId: null, quote: null },
    ],
  },
});
const timelineOut = (pid: string) => ({
  output: {
    title: "Midterm timeline",
    sections: [{ title: "Dates", topics: ["Midterm"], columns: null, blocks: [b(pid, "Midterm", Q.midterm, { kind: "event", date: "2026-10-14" }), b(pid, "Midterm", Q.midterm, { kind: "event", date: "2026-10-15" })] }],
  },
});
const quizOut = (pid: string) => ({
  output: {
    items: [
      {
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
        quote: Q.stack,
      },
      {
        kind: "tf",
        stem: "A queue is first-in, first-out.",
        options: [],
        statementIsTrue: true,
        numeric: null,
        explanation: "The reading says so.",
        topics: ["Queues"],
        section: "Linear structures",
        bloom: "remember",
        sourceId: pid,
        quote: Q.queue,
      },
    ],
  },
});

async function setup() {
  const store = createStore(":memory:");
  const materials = batch([input("reading"), input("other", { module: { id: "m2" }, text: "Graphs have vertices and edges connecting them." })]);
  store.ingest(materials);
  const reading = store.resources().find((r) => r.externalId === "reading")!;
  store.setPrivacy({ ...defaultPrivacy, mode: "selective_cloud", hostedProvider: "claude", shareCourseText: true });
  const pid = `p${store.passages(reading.id)[0]!.pid}`;
  const dir = await mkdtemp(join(tmpdir(), "guide-e2e-"));
  const workDir = join(dir, "work");
  await mkdir(workDir);
  const log = join(dir, "log.jsonl");
  const env = { FAKE_CLI_LOG: log, FAKE_CLI_STATE: join(dir, "state"), FAKE_CLI_RESPONSES: JSON.stringify([guideOut(pid), mapOut(pid), timelineOut(pid), quizOut(pid)]) };
  const runner = createPackRuntime(createClaudeBackend({ command: fake, workDir, env }), { dailyBackgroundTokens: 1_000_000 }).runner;
  const handler = createPackHandler({ store, runner: () => runner });
  const core = createCore(store, { fixture: materials, seams: { pack: handler.pack } });
  await core.execute({ type: "consent", value: { action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION } });
  const calls = async () => (existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n").filter((l) => JSON.parse(l).argv).length : 0);
  const prompts = async () => (existsSync(log) ? await readFile(log, "utf8") : "");
  const pack = async <T>(name: string, scope: Record<string, unknown> = { moduleId: "m1" }) =>
    (await core.execute({ type: "pack", pack: name, scope: { courseId: "SYN101", ...scope } })).pack as T;
  return { store, core, reading, calls, prompts, pack };
}

test("a module guide: one checked call; a wrong worked example and an invented quote are dropped; the repeat is a 0-token cache hit", async () => {
  const g = await setup();
  try {
    const r = await g.pack<GuideRunResult>("guide");
    assert.equal(r.status, "done", r.message);
    assert.equal(r.cached, false);
    assert.deepEqual(r.counts, { generated: 6, accepted: 4, dropped: 2, droppedBy: { arithmetic: 1, quote: 1 } });
    assert.deepEqual(r.stats!.arithmetic, { checked: 2, mismatches: 1 });
    assert.ok(r.tokens.in > 0);
    assert.ok(g.store.receipts().some((x) => x.recipient === "claude" && x.status === "sent" && x.purpose.includes("study guide")));
    const example = r.doc!.kind !== "conceptmap" ? r.doc!.sections[2]!.blocks.find((x) => x.kind === "example")! : null;
    assert.equal(example?.computed, "100 bytes");
    assert.equal(g.reading.text.slice(example!.source.start!, example!.source.end!), Q.bytes, "the quote is placed in the resource");
    assert.ok(!(await g.prompts()).includes("Graphs have vertices"), "only the module's material was sent");
    const calls = await g.calls();

    const again = await g.pack<GuideRunResult>("guide");
    assert.equal(again.cached, true);
    assert.deepEqual(again.tokens, { in: 0, cached: 0, out: 0 });
    assert.deepEqual(again.artifactIds, r.artifactIds);
    assert.deepEqual(again.counts, r.counts);
    assert.equal(await g.calls(), calls);
    assert.ok(g.store.ledger().some((x) => x.tier === "cache" && x.tokensIn + x.tokensOut + x.tokensCached === 0));
  } finally {
    g.store.close();
  }
});

test("guide-view personalises at 0 model calls; new attempts change the view, not the cached artifact or its key", async () => {
  const g = await setup();
  try {
    assert.equal((await g.pack<GuideViewResult>("guide-view")).status, "missing");
    const made = await g.pack<GuideRunResult>("guide");
    assert.equal(made.status, "done", made.message);
    const first = await g.pack<GuideViewResult>("guide-view");
    assert.equal(first.status, "ready");
    if (first.status !== "ready") return;
    assert.equal(first.op, "guide.view");
    assert.equal(first.modelCalls, 0);
    const v1 = first.view as GuideView;
    assert.deepEqual(v1.sections.map((s) => s.mark), ["untested", "untested", "untested"]);
    assert.deepEqual(v1.confusions, []);

    // Practice happens: a quiz is generated, then the student picks "A queue" for the stack question twice.
    const quiz = await g.pack<{ status: string; itemIds: string[] }>("quiz", { moduleId: "m1" });
    assert.equal(quiz.status, "done");
    const calls = await g.calls();
    const ref = "acct:SYN101";
    const stackItem = g.store.learning.items({ courseRef: ref }).find((s) => s.item.kind === "mc")!;
    const primary = stackItem.tags.find((t) => t.primary)!.conceptId;
    for (let i = 1; i <= 3; i++) {
      const attempt: LearningAttempt = {
        id: `att${i}`, courseRef: ref, itemId: stackItem.item.id, itemVersion: 1, sourceResourceId: g.reading.id, primaryConceptId: primary,
        correct: false, assistance: "none", seenBefore: i > 1, confidence: null, createdAt: `2090-01-0${i}T10:00:00.000Z`, format: "mc", mode: "learn",
        response: { optionId: "b" }, score: 0, gradingMethod: "exact", responseMs: 900, conceptTags: stackItem.tags, sessionId: `s${i}`, localDay: `2090-01-0${i}`, optionId: "b",
      };
      g.store.learning.addAttempt(attempt);
    }

    const second = await g.pack<GuideViewResult>("guide-view");
    assert.equal(second.status, "ready");
    if (second.status !== "ready") return;
    assert.equal(second.artifactId, first.artifactId, "the same cached artifact: personalisation isn't in the key");
    const v2 = second.view as GuideView;
    assert.notDeepEqual(v2, v1, "the view changed");
    assert.equal(v2.sections.find((s) => s.topics[0] === "Stacks")!.mark !== "untested", true, "Stacks now has evidence");
    assert.ok(v2.confusions.some((c) => c.kind === "frequent_distractor" && c.text.includes('"A queue"') && c.quotes.length > 0));
    assert.ok(v2.confusions.some((c) => c.kind === "confusable_pair" && c.text === "You answered Stacks questions as Queues 3 times."));
    assert.equal(await g.calls(), calls, "no model call for either view");
  } finally {
    g.store.close();
  }
});

test("concept map and an assessment timeline: edges need a quote; dates need a course or quoted date; unknown scopes are refused", async () => {
  const g = await setup();
  try {
    await g.pack<GuideRunResult>("guide");
    const map = await g.pack<GuideRunResult>("conceptmap");
    assert.equal(map.status, "done", map.message);
    assert.deepEqual(map.counts.droppedBy, { edge: 1 });
    const mv = (await g.pack<GuideViewResult>("conceptmap-view")) as Extract<GuideViewResult, { status: "ready" }>;
    assert.equal((mv.view as ConceptMapView).nodes.length, 2);

    g.store.putAssessment({ id: "mid", sourceId: "materials", resourceId: null, kind: "midterm", title: "Midterm", date: "2026-10-14", weight: 20, format: null, origin: "syllabus" }, "2090-01-01T00:00:00.000Z");
    const t = await g.pack<GuideRunResult>("timeline", { assessmentId: "mid" });
    assert.equal(t.status, "done", t.message);
    assert.deepEqual(t.counts.droppedBy, { date: 1 });
    assert.ok((await g.prompts()).includes("Midterm: Midterm (2026-10-14)"));
    assert.equal((await g.pack<GuideRunResult>("timeline", { assessmentId: "nope" })).status, "empty");

    // The key covers the inputs' content: changed material is a miss (never a stale view); the pack version is in the key too.
    assert.equal((await g.pack<GuideViewResult>("guide-view")).status, "ready");
    g.store.ingest(batch([input("reading", { text: `${TEXT} A deque allows insertion at both ends.` }), input("other", { module: { id: "m2" }, text: "Graphs have vertices and edges connecting them." })], "2090-02-01T00:00:00.000Z"));
    assert.equal((await g.pack<GuideViewResult>("guide-view")).status, "missing");
  } finally {
    g.store.close();
  }
});
