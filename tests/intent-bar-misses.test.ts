// Command-bar phrasings the semester cost model found answered wrongly, each on a synthetic
// workspace: "what changed since yesterday" (code, from change events), a course-scoped exam
// question naming its course, and the grade what-if with no course open (code, no sharing gate).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import { defaultPrivacy, type CaptureBatch, type IntentCommandResult, type ResourceInput } from "@magic/contracts";
import { createClaudeBackend, type CliCommand } from "../packages/runner/src/index";
import { createPackRuntime } from "../packages/packs/core/src/index";
import { createIntentRouter } from "../packages/core/src/intent/index";

const here = dirname(fileURLToPath(import.meta.url));
const fake: CliCommand = { file: process.execPath, prefixArgs: [join(here, "fixtures", "fake-cli", "fake-cli.mjs"), "claude"] };

// Monday 2026-09-28, 10:00 in Chicago; yesterday began 2026-09-27T05:00Z.
const NOW = new Date("2026-09-28T15:00:00.000Z");
const TZ = "America/Chicago";
const ACCT = "acct";
const BASE_AT = "2026-09-25T12:00:00.000Z";
const DELTA_AT = "2026-09-28T13:00:00.000Z";
const CS = "COMPSCI400: Programming III (001) FA26";
const ECON = "ECON101: Principles of Microeconomics (002) FA26";
export const EXAM = "The midterm exam is on Thursday, October 15, 2026, from 7:15 to 9:15 PM in Room 1240 Computer Sciences.";
export const COVERS = "The midterm covers lectures 1 through 6: recursion, binary search trees and hashing.";
export const GRADING = "Grading: homework 30%, midterm exam 30%, final exam 40%. Letter grades: A 93 and above, AB 88, B 83, BC 78, C 70, D 60.";
const ANNOUNCEMENT = "Homework 4 is now due Friday, October 9 at 11:59 PM instead of Wednesday, October 7.";

const res = (courseId: string, courseName: string, id: string, kind: ResourceInput["kind"], extra: Partial<ResourceInput> = {}): ResourceInput => ({
  externalId: id,
  kind,
  courseId,
  courseName,
  title: id,
  text: "",
  url: `https://canvas.example.test/courses/${courseId}/${encodeURIComponent(id)}`,
  deadlines: [],
  points: null,
  submitted: null,
  policy: { mode: "coaching", evidence: "Synthetic: AI help is allowed for practice." },
  ...extra,
});
const due = (iso: string) => [{ value: iso, kind: "due" as const, quote: "", authority: "structured" as const, scopeConfirmed: true }];
const batch = (id: string, courseId: string, scope: string, observedAt: string, resources: ResourceInput[]): CaptureBatch => ({
  source: { id, kind: "canvas", accountScope: ACCT, courseId, scope, label: courseId },
  observedAt,
  complete: true,
  status: "ok",
  resources,
});
// As the Canvas connector writes them: each assignment group is its own record with its weight,
// and each assignment names its group (canvas-models.ts assignmentGroupId).
const group = (id: string, title: string, weight: number, position: number) => res("c400", CS, id, "material", { title, assignmentGroup: { weight, position } });
const graded = (title: string, score: number) =>
  res("c400", CS, title, "assignment", { dueAt: "2026-09-16T04:59:00.000Z", deadlines: due("2026-09-16T04:59:00.000Z"), points: 50, submitted: true, assignmentGroupId: "g-hw", submission: { workflowState: "graded", score } });
const assignments = (hw4: string): ResourceInput[] => [
  res("c400", CS, "Programming III", "course"),
  group("g-hw", "Homework", 30, 1),
  group("g-mid", "Midterm", 30, 2),
  group("g-final", "Final", 40, 3),
  graded("Homework 1", 47),
  graded("Homework 2", 46),
  res("c400", CS, "Homework 4", "assignment", { dueAt: hw4, deadlines: due(hw4), points: 50, assignmentGroupId: "g-hw" }),
  res("c400", CS, "Midterm exam", "assignment", { dueAt: "2026-10-16T02:15:00.000Z", deadlines: due("2026-10-16T02:15:00.000Z"), points: 100, assignmentGroupId: "g-mid" }),
  res("c400", CS, "Final exam", "assignment", { dueAt: "2026-12-15T21:00:00.000Z", deadlines: due("2026-12-15T21:00:00.000Z"), points: 100, assignmentGroupId: "g-final" }),
];

export function semester() {
  const store = createStore(":memory:");
  const base = [
    batch("canvas-c400", "c400", "course", BASE_AT, assignments("2026-10-08T04:59:00.000Z")),
    batch("canvas-c400-files", "c400", "files", BASE_AT, [
      res("c400", CS, "Syllabus", "material", { text: `Course policies. Exams are closed book. ${EXAM} ${COVERS} ${GRADING}` }),
      res("c400", CS, "Recursion notes", "material", { text: "Recursion solves a problem by solving smaller instances of the same problem. Every recursive method needs a base case." }),
    ]),
    batch("canvas-c400-announcements", "c400", "announcements", BASE_AT, []),
    batch("canvas-c101", "c101", "course", BASE_AT, [
      res("c101", ECON, "Principles of Microeconomics", "course"),
      res("c101", ECON, "Supply and demand", "material", { text: "Demand curves slope downward because consumers buy more at lower prices." }),
    ]),
  ];
  for (const b of base) store.ingest(b);
  // This morning: Homework 4 moved, and the announcement saying so.
  store.ingest(batch("canvas-c400", "c400", "course", DELTA_AT, assignments("2026-10-10T04:59:00.000Z")));
  store.ingest(batch("canvas-c400-announcements", "c400", "announcements", DELTA_AT, [res("c400", CS, "Homework 4 deadline moved", "message", { text: ANNOUNCEMENT, createdAt: DELTA_AT, updatedAt: DELTA_AT })]));
  store.setPrivacy({ ...defaultPrivacy, mode: "selective_cloud", hostedProvider: "claude", shareCourseText: true });
  return { store, fixture: base[0]! };
}

export async function bar(responses: unknown[] = [{}]) {
  const { store, fixture } = semester();
  const dir = await mkdtemp(join(tmpdir(), "bar-misses-"));
  const workDir = join(dir, "work");
  await mkdir(workDir);
  const log = join(dir, "log.jsonl");
  const env = { FAKE_CLI_LOG: log, FAKE_CLI_STATE: join(dir, "state"), FAKE_CLI_RESPONSES: JSON.stringify(responses) };
  const runner = createPackRuntime(createClaudeBackend({ command: fake, workDir, env }), { dailyBackgroundTokens: 1_000_000 }).runner;
  const packs: { pack: string; scope: unknown; options: unknown }[] = [];
  const router = createIntentRouter({ store, runner: () => runner, now: () => NOW, timeZone: TZ });
  const core = createCore(store, {
    fixture,
    now: () => NOW,
    timeZone: TZ,
    seams: {
      intent: router,
      learning: { handle: async (request) => ({ op: request.op, status: "ok" as const, data: { request } }) },
      pack: async (pack: string, scope: unknown, _signal: AbortSignal, options?: unknown) => (packs.push({ pack, scope, options }), { status: "done", pack }),
    },
  });
  await core.execute({ type: "consent", value: { action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION } });
  const calls = async () => (existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { argv: string[]; stdin: string }) : []);
  const run = async (text: string, courseId?: string) =>
    (await core.execute({ type: "command", value: { text, ...(courseId ? { context: { courseId } } : {}) } })).command as IntentCommandResult;
  const pid = (title: string) => {
    const r = store.resources().find((x) => x.title === title)!;
    return `p${store.passages(r.id)[0]!.pid}`;
  };
  return { store, run, calls, packs, pid, close: async () => (await core.close(), await rm(dir, { recursive: true, force: true })) };
}

type Changed = { items: { title: string; changes: string[]; notes: string[]; course: string }[]; since: string };

test("\"what changed since yesterday\" answers in code from the change events: the moved deadline and the new announcement", async () => {
  const h = await bar();
  try {
    for (const text of ["what changed since yesterday", "What's changed since yesterday?", "anything new in cs 400 since yesterday"]) {
      const r = await h.run(text);
      assert.equal(r.status, "ran", `${text}: ${JSON.stringify(r)}`);
      assert.equal(r.status === "ran" && r.action, "changes.since", text);
      assert.equal(r.path, "code", text);
      assert.deepEqual(r.tokens, { in: 0, cached: 0, out: 0 });
      const out = (r as Extract<IntentCommandResult, { status: "ran" }>).result as Changed;
      assert.equal(out.since, "2026-09-27T05:00:00.000Z", "yesterday's local midnight");
      const titles = out.items.map((i) => i.title).sort();
      assert.deepEqual(titles, ["Homework 4", "Homework 4 deadline moved"], `${text}: ${JSON.stringify(titles)}`);
      const hw4 = out.items.find((i) => i.title === "Homework 4")!;
      assert.ok(hw4.changes.includes("date changed"));
      assert.ok(hw4.notes.some((n) => /Oct 7/.test(n)), JSON.stringify(hw4.notes));
      assert.deepEqual(out.items.find((i) => i.title === "Homework 4 deadline moved")!.changes, ["new"]);
    }
    // Back to the first import (Friday): the imported items are not news; the morning's changes are.
    for (const text of ["what changed since sep 25", "what changed since friday"]) {
      const r = await h.run(text);
      assert.equal(r.status === "ran" && r.action, "changes.since", text);
      const out = (r as Extract<IntentCommandResult, { status: "ran" }>).result as Changed;
      assert.equal(out.since, "2026-09-25T05:00:00.000Z", text);
      assert.deepEqual(out.items.map((i) => i.title).sort(), ["Homework 4", "Homework 4 deadline moved"], text);
    }
    assert.equal((await h.calls()).length, 0, "no model call");
  } finally {
    await h.close();
  }
});

const answer = (sentences: { sourceId: string; quote: string }[]) => ({
  output: { found: true, sentences: sentences.map((s) => ({ text: "From the course materials.", citations: [s] })) },
});

test("an exam question naming its course searches that course's passages and exam facts before \"Not in your materials\"", { timeout: 60_000 }, async () => {
  const probe = await bar();
  const syllabus = probe.pid("Syllabus");
  await probe.close();
  const h = await bar([answer([{ sourceId: syllabus, quote: EXAM }, { sourceId: syllabus, quote: COVERS }])]);
  try {
    const r = await h.run("when and where is the midterm in cs 400, and what's on it");
    assert.equal(r.status, "answer", JSON.stringify(r));
    assert.ok(r.status === "answer" && !r.notFound && r.citations.length === 2, JSON.stringify(r));
    const sent = (await h.calls()).map((c) => c.stdin).join("\n");
    assert.equal((await h.calls()).length, 1, "one checked call");
    assert.ok(sent.includes(EXAM) && sent.includes(COVERS), "the syllabus passage with the date, room and coverage reached the model");
    // The Canvas record, rendered by code in the student's time zone.
    assert.ok(sent.includes("Midterm exam (Canvas assignment): due Thursday, October 15, 2026 at 9:15 PM CDT; 100 points; its assignment group is 30% of the grade."), sent);
    assert.ok(!/Homework 1 \(Canvas/.test(sent), "only the asked-about assessment");
    // Nothing on the topic: still "Not in your materials", with no call.
    const miss = await h.run("who won the world series in cs 400");
    assert.ok(miss.status === "answer" && miss.notFound, JSON.stringify(miss));
    assert.equal((await h.calls()).length, 1, "the coverage gate still sends nothing");
  } finally {
    await h.close();
  }
});

test("the grade what-if runs in code with no course open: the grade bank's scores and weights, the syllabus scale, no sharing gate", { timeout: 60_000 }, async () => {
  const h = await bar();
  try {
    for (const [text, courseId] of [
      ["what do I need on the final for a B if I get 80 on the midterm", undefined],
      ["What do I need on the final for a B if I get 80 on the midterm?", "c400"],
      ["what score do i need on the final exam in cs 400 to get a b if i got 80 on the midterm", undefined],
    ] as const) {
      const r = await h.run(text, courseId);
      assert.equal(r.status, "answer", `${text}: ${JSON.stringify(r)}`);
      assert.equal(r.path, "code", text);
      assert.deepEqual(r.tokens, { in: 0, cached: 0, out: 0 });
      // Homework 93% × 30 + midterm 80% × 30 + final x × 40 = 83 → x = 77.75, rounded up.
      assert.ok(r.status === "answer" && r.text.startsWith("You need at least 77.8% on Final exam for B (83%) in COMPSCI 400."), r.status === "answer" ? r.text : "");
      assert.ok(r.status === "answer" && r.citations.length === 1 && r.citations[0]!.title === "Syllabus" && /B 83/.test(r.citations[0]!.quote), JSON.stringify(r));
    }
    // A percentage goal needs no scale; a missing score is named, not assumed.
    const pct = await h.run("what do I need on the final to get 90 if I get 95 on the midterm");
    assert.ok(pct.status === "answer" && pct.text.startsWith("You need at least 84% on Final exam for 90%"), JSON.stringify(pct));
    const missing = await h.run("what do I need on the final for a B");
    assert.ok(missing.status === "answer" && /Midterm \(30% of the grade\) has no score yet/.test(missing.text), JSON.stringify(missing));
    const gpa = await h.run("what gpa do i need to graduate with honors");
    assert.equal(gpa.status === "ran" && gpa.action, "grades.gpa", JSON.stringify(gpa));
    assert.equal((await h.calls()).length, 0, "no model call, so no sharing gate");
  } finally {
    await h.close();
  }
});

test("a stated count reaches the quiz and the pack, parsed and clamped (1-30) by code", async () => {
  const h = await bar();
  try {
    type Ran = Extract<IntentCommandResult, { status: "ran" }>;
    const learned = (r: IntentCommandResult) => ((r as Ran).result as { data: { request: { count: number } } }).data.request.count;
    const quiz: [string, number][] = [
      ["quiz me on recursion in cs 400 with 5 questions", 5],
      ["quiz me on recursion in cs 400, 7 questions", 7],
      ["give me a 12 question quiz on recursion in cs 400", 12],
      ["quiz me on recursion in cs 400", 10],
    ];
    for (const [text, count] of quiz) {
      const r = await h.run(text);
      assert.equal(r.status === "ran" && r.action, "practice.quiz", `${text}: ${JSON.stringify(r)}`);
      assert.equal(learned(r), count, text);
    }
    const cards = await h.run("12 flashcards due in cs 400");
    assert.equal(cards.status === "ran" && cards.action, "practice.flashcards", JSON.stringify(cards));
    assert.equal(learned(cards), 12);
    const generated: [string, number | undefined][] = [
      ["make 12 cards on recursion in cs 400", 12],
      ["make twelve flashcards on recursion in cs 400", 12],
      ["make 50 flashcards on recursion in cs 400", 30],
      ["make 0 questions on recursion in cs 400", 1],
      ["generate a quiz on recursion in cs 400 with 5 questions", 5],
      ["make flashcards on recursion in cs 400", undefined],
    ];
    for (const [text, count] of generated) {
      const before = h.packs.length;
      const r = await h.run(text);
      assert.equal(r.status === "ran" && r.action, "pack.generate", `${text}: ${JSON.stringify(r)}`);
      assert.equal(h.packs.length, before + 1);
      assert.deepEqual(h.packs.at(-1)!.options, count === undefined ? undefined : { count }, text);
    }
    // An action that takes no count keeps its words.
    const open = await h.run("open homework 4 in cs 400");
    assert.equal(open.status === "ran" && open.action, "assignment.open", JSON.stringify(open));
    assert.equal((await h.calls()).length, 0, "all by code");
  } finally {
    await h.close();
  }
});
