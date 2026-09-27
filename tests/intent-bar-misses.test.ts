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
const graded = (title: string, score: number) =>
  res("c400", CS, title, "assignment", { dueAt: "2026-09-16T04:59:00.000Z", deadlines: due("2026-09-16T04:59:00.000Z"), points: 50, submitted: true, assignmentGroup: { weight: 30 }, submission: { workflowState: "graded", score } });
const assignments = (hw4: string): ResourceInput[] => [
  res("c400", CS, "Programming III", "course"),
  graded("Homework 1", 47),
  graded("Homework 2", 46),
  res("c400", CS, "Homework 4", "assignment", { dueAt: hw4, deadlines: due(hw4), points: 50, assignmentGroup: { weight: 30 } }),
  res("c400", CS, "Midterm exam", "assignment", { dueAt: "2026-10-16T02:15:00.000Z", deadlines: due("2026-10-16T02:15:00.000Z"), points: 100, assignmentGroup: { weight: 30 } }),
  res("c400", CS, "Final exam", "assignment", { dueAt: "2026-12-15T21:00:00.000Z", deadlines: due("2026-12-15T21:00:00.000Z"), points: 100, assignmentGroup: { weight: 40 } }),
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
