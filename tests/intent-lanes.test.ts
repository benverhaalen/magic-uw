// The command bar over the other lanes' features on main (Outlook mail and calendar proposals,
// study guides, practice analytics, the material pipeline), the notes lane's plain actions, the
// pool's warm start, and the read-only preview query.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createCore } from "@magic/core";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import type { IntentCommandResult, LearningRequest } from "@magic/contracts";
import { createClaudeBackend, createModelRunner, createSessionPool, type CliCommand } from "../packages/runner/src/index";
import { askPack, classifyPack } from "../packages/packs/intent/src/index";
import { createIntentRouter, fromNotes, type NotesSeam } from "../packages/core/src/intent/index";
import { notesActions } from "../packages/notes/src/actions";
import { NOW, TZ, workspace } from "./intent-fixtures";

const here = dirname(fileURLToPath(import.meta.url));
const fake: CliCommand = { file: process.execPath, prefixArgs: [join(here, "fixtures", "fake-cli", "fake-cli.mjs"), "claude"] };
const slots = (over: Record<string, unknown> = {}) => ({ course: null, assignment: null, topics: null, date: null, time: null, query: null, kind: null, count: null, scope: null, ...over });

async function setup(responses: unknown[] = [{}], opts: { pool?: boolean } = {}) {
  const { store, batches } = workspace();
  const dir = await mkdtemp(join(tmpdir(), "intent-lanes-"));
  const workDir = join(dir, "work");
  await mkdir(workDir);
  const log = join(dir, "log.jsonl");
  const env = { FAKE_CLI_LOG: log, FAKE_CLI_STATE: join(dir, "state"), FAKE_CLI_RESPONSES: JSON.stringify(responses) };
  const fallback = createClaudeBackend({ command: fake, workDir, env });
  const pool = opts.pool ? createSessionPool({ command: fake, workDir, env, fallback, kinds: { [classifyPack.id]: classifyPack.schema, [askPack.id]: askPack.schema } }) : null;
  const runner = createModelRunner({ backend: pool ?? fallback });
  const learning: LearningRequest[] = [];
  const notesCalls: { request: unknown; session?: [string, string, string | undefined] }[] = [];
  const notesSeam: NotesSeam = {
    handle: async (request) => {
      notesCalls.push({ request });
      const r = request as { op: string; sessionId?: string };
      return r.op === "notes.open" ? { op: r.op, status: "ok", note: { id: `note-${r.sessionId}` } } : { op: r.op, status: "ok" };
    },
    sessionOn: (courseId, date, type) => (notesCalls.push({ request: null, session: [courseId, date, type] }), { id: `s-${courseId}-${date}` }),
  };
  const router = createIntentRouter({
    store,
    runner: () => runner,
    now: () => NOW,
    timeZone: TZ,
    actions: fromNotes({ notesActions }, notesSeam),
    ...(pool ? { warm: (r) => pool.warm(r) } : {}),
  });
  const core = createCore(store, {
    fixture: batches[0]!,
    now: () => NOW,
    timeZone: TZ,
    seams: {
      learning: { handle: async (request) => (learning.push(request), { op: request.op, status: "ok" as const }) },
      intent: router,
    },
  });
  await core.execute({ type: "consent", value: { action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION } });
  const events = async () => (existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { event?: string; argv: string[] }) : []);
  const run = async (text: string, context?: Record<string, string>) =>
    (await core.execute({ type: "command", value: { text, ...(context ? { context } : {}) } })).command as IntentCommandResult;
  return { store, core, router, run, events, learning, notesCalls, pool };
}
const ran = (r: IntentCommandResult) => {
  assert.equal(r.status, "ran", JSON.stringify(r));
  return r as Extract<IntentCommandResult, { status: "ran" }>;
};

test("Outlook: mail search reads stored fields; a calendar event is only a proposal for the student to confirm", async () => {
  const h = await setup();
  const mail = ran(await h.run("search my email for exam room"));
  assert.equal(mail.action, "mail.search");
  assert.equal(mail.path, "code");
  assert.deepEqual(mail.result, { items: [] });
  const event = ran(await h.run("schedule a study session tomorrow at 3pm"));
  assert.equal(event.action, "calendar.proposeEvent");
  // 15:00 in Chicago on Tuesday 2026-09-29 (CDT, UTC−5); an hour by default.
  assert.deepEqual(event.result, {
    handoff: "calendarProposeEvent",
    proposal: { subject: "Study session", start: "2026-09-29T20:00:00.000Z", end: "2026-09-29T21:00:00.000Z", timeZone: TZ },
    confirm: "Main issues the proposal ID; nothing is written until the student clicks to confirm.",
  });
  const range = ran(await h.run("block off friday 2-4pm for the ece lab report"));
  const proposal = (range.result as { proposal: { subject: string; start: string; end: string } }).proposal;
  assert.deepEqual([proposal.start, proposal.end], ["2026-10-02T19:00:00.000Z", "2026-10-02T21:00:00.000Z"]);
  assert.equal(proposal.subject, "Ece lab report");
  const noTime = await h.run("schedule a study session tomorrow");
  assert.deepEqual({ status: noTime.status, path: noTime.path }, { status: "clarify", path: "code" });
  assert.equal((await h.events()).length, 0, "no model call, and the router never writes an event");
});

test("guides, analytics and the pipeline's references and overview run from the code path", async () => {
  const h = await setup();
  const guide = ran(await h.run("show the study guide for cs 400"));
  assert.equal(guide.action, "guide.view");
  assert.equal((guide.result as { view: string; modelCalls: number }).view, "guide");
  assert.equal((guide.result as { modelCalls: number }).modelCalls, 0);
  const faq = ran(await h.run("open the philosophy faq"));
  assert.equal((faq.result as { kind: string }).kind, "faq");
  ran(await h.run("how am I doing in cs 400"));
  ran(await h.run("what should I study next for econ"));
  ran(await h.run("how ready am I for homework 3"));
  assert.deepEqual(
    h.learning.map((l) => l.op),
    ["analytics.course", "analytics.agendaHints", "analytics.assignment"],
  );
  const course = h.learning[0] as Extract<LearningRequest, { op: "analytics.course" }>;
  assert.equal(course.courseId, "c400");
  assert.equal(course.anchorIds.length, 2, "the course's assignments anchor the scope");
  const readiness = h.learning[2] as Extract<LearningRequest, { op: "analytics.assignment" }>;
  assert.equal(readiness.courseId, "c400");
  assert.equal(h.store.resource(readiness.assignmentId)?.title, "Homework 3");
  const refs = ran(await h.run("what do I need for homework 3 in cs 400"));
  assert.equal(refs.action, "assignment.references");
  assert.ok(Array.isArray((refs.result as { references: unknown[] }).references));
  const overview = ran(await h.run("show the modules in cs 400"));
  assert.equal(overview.action, "course.overview");
  assert.equal((overview.result as { course: { courseId: string } }).course.courseId, "c400");
  assert.equal((await h.events()).length, 0);
});

test("notes: the notes lane's notesActions (#16) run from their patterns and from the model's slots", async () => {
  const h = await setup([{ output: { action: "notes.open", args: slots({ course: "COMPSCI 400", date: "tuesday" }), confidence: "high", alternatives: null, question: null } }]);
  const open = ran(await h.run("notes for today's CS 400 lecture"));
  assert.equal(open.action, "notes.open");
  assert.equal(open.path, "code");
  assert.deepEqual(h.notesCalls.slice(0, 2), [
    { request: null, session: ["c400", "2026-09-28", "lecture"] },
    { request: { op: "notes.open", sessionId: "s-c400-2026-09-28" } },
  ]);
  h.notesCalls.length = 0;
  const append = ran(await h.run("add to my CS 400 notes: Hash tables resize at load factor 0.75"));
  assert.equal(append.action, "notes.append");
  // The text keeps the student's casing; the notes service resolves "today" to its session.
  assert.deepEqual(h.notesCalls.at(-1), { request: { op: "notes.append", noteId: "note-s-c400-today", text: "Hash tables resize at load factor 0.75" } });
  h.notesCalls.length = 0;
  const ai = ran(await h.run("pull up what I wrote in class for the tuesday session of programming three"));
  assert.equal(ai.path, "ai");
  assert.deepEqual(h.notesCalls[0], { request: null, session: ["c400", "2026-09-29", "lecture"] });
});

test("warm start: prewarm spawns the pooled session with the catalogue prefix, so commands spawn nothing", { timeout: 60_000 }, async () => {
  const h = await setup([{ output: { kind: "intent-classify", data: { action: "agenda.due", args: slots({ date: "tomorrow" }), confidence: "high", alternatives: null, question: null } } }], { pool: true });
  try {
    const ready = (await h.core.execute({ type: "command", value: { text: "", mode: "prewarm" } })).command!;
    assert.deepEqual({ status: ready.status, ai: ready.status === "ready" && ready.ai }, { status: "ready", ai: true });
    const spawns = async () => (await h.events()).filter((e) => e.event === "spawn").length;
    const messages = async () => (await h.events()).filter((e) => e.event === "message").length;
    // The fake CLI logs its spawn once the process is up; wait for it (a real CLI loads the same way).
    for (let i = 0; i < 100 && (await spawns()) === 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(await spawns(), 1, "prewarm started the CLI");
    assert.equal(await messages(), 0, "and sent nothing (0 tokens)");
    assert.equal((await h.router.prewarm()).status, "ready");
    assert.equal(await spawns(), 1, "a second prewarm reuses the live session");
    for (const text of ["zq sort out thing one for me", "zq sort out thing two for me"]) assert.equal((await h.run(text)).path, "ai");
    assert.equal(await spawns(), 1, "both commands ran in the warm session: 0 spawns");
    assert.equal(await messages(), 2);
  } finally {
    await h.pool!.close();
  }
});

test("preview on the query channel: code resolver only, 0 tokens, no snapshot", async () => {
  const h = await setup();
  const result = h.core.query({ view: "intent.preview", text: "quiz me on recursion in cs 400" });
  assert.equal(result.view, "intent.preview");
  if (result.view !== "intent.preview") return;
  assert.equal(result.preview.status, "preview");
  assert.ok(result.preview.status === "preview" && result.preview.action === "practice.quiz");
  assert.deepEqual(result.preview.tokens, { in: 0, cached: 0, out: 0 });
  assert.ok(!("snapshot" in result));
  const miss = h.core.query({ view: "intent.preview", text: "I'm totally lost on" });
  assert.ok(miss.view === "intent.preview" && miss.preview.status === "preview" && miss.preview.action === null);
  assert.equal((await h.events()).length, 0);
  assert.equal(h.learning.length, 0);
});
