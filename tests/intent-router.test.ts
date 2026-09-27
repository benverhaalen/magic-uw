// The command bar's intent router on a synthetic workspace: the code path (0 tokens), course and
// date resolution, the AI fallback through the fake CLI, the cache, the grounded ask, no client,
// and no tools for the model.
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
import { createClaudeBackend, type CliCommand, type ModelRunner, type RunRequest } from "../packages/runner/src/index";
import { createPackRuntime } from "../packages/packs/core/src/index";
import { conceptId } from "../packages/learning/src/concepts";
import { createIntentRouter, NO_CLIENT_REASON, NOT_IN_MATERIALS, resolveDate, type AnyAction } from "../packages/core/src/intent/index";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const fake: CliCommand = { file: process.execPath, prefixArgs: [join(here, "fixtures", "fake-cli", "fake-cli.mjs"), "claude"] };
import { LATE, NOW, TZ, workspace } from "./intent-fixtures";

async function setup(responses: unknown[] = [{}], opts: { client?: boolean; actions?: AnyAction[] } = {}) {
  const { store, batches, ref } = workspace();
  const dir = await mkdtemp(join(tmpdir(), "intent-"));
  const workDir = join(dir, "work");
  await mkdir(workDir);
  const log = join(dir, "log.jsonl");
  const env = { FAKE_CLI_LOG: log, FAKE_CLI_STATE: join(dir, "state"), FAKE_CLI_RESPONSES: JSON.stringify(responses) };
  const inner = createPackRuntime(createClaudeBackend({ command: fake, workDir, env }), { dailyBackgroundTokens: 1_000_000 }).runner;
  const requests: RunRequest<unknown>[] = [];
  const runner: ModelRunner = { client: inner.client, run: (r) => (requests.push(r as RunRequest<unknown>), inner.run(r)) };
  const learning: LearningRequest[] = [];
  const packs: { pack: string; scope: unknown }[] = [];
  const router = createIntentRouter({ store, runner: () => (opts.client === false ? null : runner), now: () => NOW, timeZone: TZ, actions: opts.actions });
  const core = createCore(store, {
    fixture: batches[0]!,
    now: () => NOW,
    timeZone: TZ,
    seams: {
      learning: { handle: async (request) => (learning.push(request), { op: request.op, status: "ok" as const, data: { started: true } }) },
      pack: async (pack, scope) => (packs.push({ pack, scope }), { status: "done", pack }),
      intent: router,
    },
  });
  await core.execute({ type: "consent", value: { action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION } });
  const calls = async () => (existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { argv: string[]; stdin: string }) : []);
  const run = async (text: string, context?: { courseId?: string }) =>
    (await core.execute({ type: "command", value: { text, ...(context ? { context } : {}) } })).command as IntentCommandResult;
  return { store, core, router, run, calls, learning, packs, requests, ref };
}

const slots = (over: Record<string, unknown> = {}) => ({ course: null, assignment: null, topics: null, date: null, query: null, kind: null, count: null, scope: null, ...over });
const intent = (action: string, args: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  output: { action, args: slots(args), confidence: "high", alternatives: null, question: null, ...over },
});

test("code path: common commands run at 0 tokens with no model call", async () => {
  const h = await setup();
  const cases: [string, string][] = [
    ["What's due tomorrow?", "agenda.due"],
    ["quiz me on recursion in CS 400", "practice.quiz"],
    ["COMP SCI 400 flashcards due", "practice.flashcards"],
    ["start a learn round for my econ class", "practice.learn"],
    ["make 5 flashcards on hash tables for cs400", "pack.generate"],
    ["open homework 3 in cs 400", "assignment.open"],
    ["go to philosophy", "course.open"],
    ["search for utilitarianism", "materials.search"],
  ];
  for (const [text, action] of cases) {
    const r = await h.run(text);
    assert.equal(r.status, "ran", `${text}: ${JSON.stringify(r)}`);
    assert.equal(r.status === "ran" && r.action, action, text);
    assert.equal(r.path, "code", text);
    assert.deepEqual(r.tokens, { in: 0, cached: 0, out: 0 });
    assert.ok(r.latencyMs < 250, `${text} took ${r.latencyMs} ms`);
  }
  assert.equal((await h.calls()).length, 0, "no model call on the code path");
  // The practice ops carry code-resolved IDs.
  const quiz = h.learning.find((l) => l.op === "practice.target" && l.mode === "test")!;
  assert.equal(quiz.op === "practice.target" && quiz.courseId, "c400");
  assert.deepEqual(quiz.op === "practice.target" && quiz.topicIds, [conceptId(h.ref, "concept", "Recursion")]);
  const learn = h.learning.find((l) => l.op === "practice.target" && l.mode === "learn")!;
  assert.equal(learn.op === "practice.target" && learn.courseId, "c101");
  assert.deepEqual(h.packs[0], { pack: "cards", scope: { courseId: "c400", topicIds: [conceptId(h.ref, "concept", "Hash tables")] } });
  const agenda = await h.run("what's due tomorrow");
  assert.ok(agenda.status === "ran");
  const items = (agenda.result as { items: { title: string }[] }).items.map((i) => i.title);
  // Both fall on Tuesday in Chicago; Homework 3 is due 23:59 local, after Problem Set 2 at 17:00.
  assert.deepEqual(items, ["Problem Set 2", "Homework 3"]);
  const open = await h.run("open homework 3 in cs 400");
  assert.ok(open.status === "ran" && (open.result as { url: string }).url.endsWith("/c400/Homework%203"));
  // Every command left a route row in the ledger with its path and latency.
  const rows = h.store.ledger(100).filter((r) => r.pack === "intent-route");
  assert.ok(rows.length >= cases.length + 2);
  assert.ok(rows.every((r) => r.tier === "code" && r.tokensIn === 0));
});

test("course and date resolution", async () => {
  const h = await setup();
  const code = (t: string) => {
    const r = h.router.resolve.course(t);
    return r.status === "ok" ? r.value.code : r.status;
  };
  assert.equal(code("CS 400"), "COMPSCI 400");
  assert.equal(code("COMP SCI 400"), "COMPSCI 400");
  assert.equal(code("compsci400"), "COMPSCI 400");
  assert.equal(code("my econ class"), "ECON 101");
  assert.equal(code("introduction to philosophy"), "PHILOS 101");
  // Two MATH courses: the current term wins; the old one is still reachable by its number.
  assert.equal(code("my math class"), "MATH 234");
  assert.equal(code("calc"), "MATH 234");
  assert.equal(code("math 221"), "MATH 221");
  assert.equal(code("CS 999"), "none");
  assert.equal(code("underwater basket weaving"), "none");
  const d = (p: string, now = NOW) => resolveDate(p, now, TZ);
  assert.deepEqual(d("today"), { from: "2026-09-28", to: "2026-09-28", label: "today" });
  assert.equal(d("tomorrow")?.from, "2026-09-29");
  assert.equal(d("tuesday")?.from, "2026-09-29");
  assert.equal(d("next tuesday")?.from, "2026-10-06");
  assert.deepEqual(d("this week"), { from: "2026-09-28", to: "2026-10-04", label: "this week" });
  assert.deepEqual(d("next week"), { from: "2026-10-05", to: "2026-10-11", label: "next week" });
  assert.equal(d("oct 3")?.from, "2026-10-03");
  assert.equal(d("the next 3 days")?.to, "2026-09-30");
  assert.equal(d("someday"), null);
  // 22:30 in Chicago is still Monday there, though it is Tuesday in UTC.
  assert.equal(d("today", new Date("2026-09-29T03:30:00.000Z"))?.from, "2026-09-28");
  // Through the router: an ambiguous action reference is asked by code, at 0 tokens.
  const which = await h.run("quiz me on derivatives");
  assert.equal(which.status, "clarify");
  assert.equal(which.path, "code");
  assert.ok(which.status === "clarify" && which.candidates.length >= 4);
  // A topic that only one course's map has picks that course.
  const byTopic = await h.run("quiz me on binary search trees");
  assert.ok(byTopic.status === "ran" && (byTopic.args.course as { courseId: string }).courseId === "c400");
  // The open course is the default.
  const inContext = await h.run("flashcards due", { courseId: "c102" });
  assert.ok(inContext.status === "ran" && (inContext.args.course as { courseId: string }).courseId === "c102");
});

test("AI fallback: a valid intent runs; an unknown action or an invented course becomes a clarification", async () => {
  const h = await setup([
    intent("practice.quiz", { course: "COMPSCI 400", topics: ["recursion"] }),
    intent("email.professor", { course: "COMPSCI 400" }),
    intent("practice.quiz", { course: "CS 999", topics: ["recursion"] }),
    intent("agenda.due", {}, { confidence: "low", question: "Do you want your deadlines or a practice quiz?", alternatives: [{ action: "practice.quiz", args: slots() }] }),
  ]);
  const ok = await h.run("I'm totally lost on recursion, run me through some practice");
  assert.equal(ok.status, "ran", JSON.stringify(ok));
  assert.equal(ok.path, "ai");
  assert.ok(ok.tokens.in > 0);
  assert.ok(ok.status === "ran" && ok.action === "practice.quiz");
  assert.equal(h.learning.length, 1);
  const unknown = await h.run("tell my professor I'll be late to lecture");
  assert.equal(unknown.status, "clarify");
  assert.equal(h.learning.length, 1, "nothing ran");
  const invented = await h.run("drill recursion stuff for that course I keep forgetting");
  assert.equal(invented.status, "clarify", JSON.stringify(invented));
  assert.ok(invented.status === "clarify" && /CS 999/.test(invented.question));
  assert.ok(invented.status === "clarify" && invented.candidates.some((c) => c.args.course === "COMPSCI 400"));
  assert.equal(h.learning.length, 1, "an invented course is refused, never run");
  const low = await h.run("the thing for monday-ish");
  assert.equal(low.status, "clarify");
  assert.ok(low.status === "clarify" && low.question.startsWith("Do you want") && low.candidates.length === 2);
  // The model saw only the utterance, the catalogue and course codes and names: no passages.
  const sent = await h.calls();
  assert.equal(sent.length, 4);
  for (const c of sent) assert.ok(!c.stdin.includes("<passage") && !c.stdin.includes(LATE));
  assert.ok(h.requests.every((r) => r.pack.id === "intent-classify" && r.tier === "pass"));
});

test("a classification cache hit costs 0 tokens and no call", async () => {
  const h = await setup([intent("practice.quiz", { course: "COMPSCI 400", topics: ["recursion"] })]);
  const first = await h.run("I'm totally lost on recursion, run me through some practice");
  assert.equal(first.path, "ai");
  const second = await h.run("  i'm TOTALLY lost on recursion, run me through some practice ");
  assert.equal(second.status, "ran");
  assert.equal(second.path, "cache");
  assert.deepEqual(second.tokens, { in: 0, cached: 0, out: 0 });
  assert.equal((await h.calls()).length, 1);
});

test("a resolver that throws still yields the AI result", async () => {
  const boom = {
    name: "boom.action",
    description: "Throws in the resolver.",
    slots: {},
    argsSchema: z.custom<never>(() => false),
    examples: [],
    get patterns(): RegExp[] {
      throw new Error("resolver bug");
    },
    run: async () => null,
  } as unknown as AnyAction;
  const h = await setup([intent("agenda.due", { date: "tomorrow" })], { actions: [boom] });
  const r = await h.run("zzq whatever is happening soon-ish");
  assert.equal(r.status, "ran", JSON.stringify(r));
  assert.equal(r.path, "ai");
  assert.ok(r.status === "ran" && r.action === "agenda.due");
});

test("grounded ask: citations are checked, a fabricated quote is dropped, no match makes no call", async () => {
  // Passage IDs are deterministic for the same synthetic ingest, so a probe store names them.
  const probe = workspace().store;
  const syllabus = probe.resources().find((r) => r.title === "Syllabus")!;
  const pid = `p${probe.passages(syllabus.id)[0]!.pid}`;
  const g = await setup([
    {
      output: {
        found: true,
        sentences: [
          { text: "Late work loses 10% per day for up to three days.", citations: [{ sourceId: pid, quote: "Late work loses 10% per day, up to three days." }] },
          { text: "Extensions are granted automatically.", citations: [{ sourceId: pid, quote: "Extensions are always granted automatically." }] },
        ],
      },
    },
  ]);
  const r = await g.run("What is the late policy in CS 400?");
  assert.equal(r.status, "answer", JSON.stringify(r));
  assert.equal(r.path, "code");
  assert.ok(r.tokens.in > 0);
  if (r.status !== "answer") return;
  assert.equal(r.dropped, 1);
  assert.equal(r.citations.length, 1);
  assert.ok(r.text.startsWith("Late work loses 10% per day") && r.text.endsWith("[1]"));
  assert.ok(!r.text.includes("Extensions"));
  const c = r.citations[0]!;
  const text = g.store.resource(c.resourceId)!.text;
  assert.equal(text.slice(c.start!, c.end!), "Late work loses 10% per day, up to three days.");
  const before = (await g.calls()).length;
  const none = await g.run("What is the airspeed velocity of an unladen swallow?");
  assert.equal(none.status, "answer");
  assert.ok(none.status === "answer" && none.notFound && none.text === NOT_IN_MATERIALS);
  assert.deepEqual(none.tokens, { in: 0, cached: 0, out: 0 });
  assert.equal((await g.calls()).length, before, "the coverage gate made no model call");
  // The ask sent passages from the chosen course only, never planning data.
  const sent = (await g.calls())[0]!;
  assert.ok(sent.stdin.includes(LATE) && !sent.stdin.includes("Utilitarianism"));
});

test("no client: the code path works, and a miss says only exact commands work", async () => {
  const h = await setup([], { client: false });
  const due = await h.run("what's due tomorrow");
  assert.equal(due.status, "ran");
  const miss = await h.run("I'm totally lost on recursion, run me through some practice");
  assert.deepEqual({ status: miss.status, reason: miss.status === "unavailable" && miss.reason }, { status: "unavailable", reason: NO_CLIENT_REASON });
  const ask = await h.run("What is the late policy in CS 400?");
  assert.equal(ask.status, "unavailable");
  assert.equal((await h.calls()).length, 0);
});

test("the model gets no tools: argv turns tools off and the request carries none", async () => {
  const h = await setup([intent("agenda.due", { date: "tomorrow" })]);
  await h.run("zzq whatever is happening soon-ish");
  const [call] = await h.calls();
  assert.ok(call);
  const argv = call.argv;
  assert.equal(argv[argv.indexOf("--tools") + 1], "");
  assert.ok(argv.includes("--strict-mcp-config"));
  assert.ok(!argv.some((a) => a.includes("dangerously") || a === "--allowedTools" || a === "--mcp-config"));
  assert.ok(!argv.some((a) => a.includes("zzq")), "the request travels on stdin, never argv");
  for (const r of h.requests) assert.ok(!("tools" in r) && !("allowedTools" in r));
});

test("preview runs only the code resolver; prewarm reports readiness; both cost 0 tokens", async () => {
  const h = await setup([intent("agenda.due", {})]);
  const hint = (await h.core.execute({ type: "command", value: { text: "quiz me on recursion in cs 400", mode: "preview" } })).command!;
  assert.equal(hint.status, "preview");
  assert.ok(hint.status === "preview" && hint.action === "practice.quiz" && /COMPSCI 400/.test(hint.hint ?? ""));
  const partial = (await h.core.execute({ type: "command", value: { text: "I'm totally lost on", mode: "preview" } })).command!;
  assert.ok(partial.status === "preview" && partial.action === null);
  const ready = (await h.core.execute({ type: "command", value: { text: "", mode: "prewarm" } })).command!;
  assert.deepEqual({ status: ready.status, ai: ready.status === "ready" && ready.ai }, { status: "ready", ai: true });
  assert.equal((await h.calls()).length, 0, "preview and prewarm never call the model");
  assert.equal(h.learning.length, 0, "preview never runs an action");
});
