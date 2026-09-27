// D49: the critical-action agenda. Code ranks by least slack (latest start = due − estimate −
// buffer), estimates are bounded and corrected by the student, the model's "why now" lines are
// checked by code, and the launch views read only the local database. Synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "@magic/storage";
import { defaultPrivacy, queryRequestSchema, correctionSchema, type CaptureBatch, type ResourceInput, type QueryRequest, type Store } from "@magic/contracts";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import { createModelRunner, type BackendCall } from "../packages/runner/src/index";
import { runQuery } from "../packages/core/src/queries";
import {
  AGENDA_CONFIG,
  checkLine,
  codeEstimate,
  correctAgendaEstimate,
  estimateCourse,
  formatMinutes,
  invalidateAgenda,
  narrateAgenda,
  narrationFact,
  rankAgenda,
  registerAgendaJobs,
  type AgendaFact,
} from "../packages/core/src/priority/index";
import { createJobRegistry } from "../packages/core/src/jobs/registry";
import { pipelineJobRegistry } from "../packages/core/src/jobs/default-registry";
import { createCore } from "@magic/core";
import { captureBatchSchema } from "@magic/contracts";
import courseFixture from "../fixtures/course.json";

const TZ = "America/Chicago";
// Thursday, October 1, 2026, 10:00 am in Chicago.
const NOW = "2026-10-01T15:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const H = 3_600_000;
const at = (hours: number) => new Date(NOW_MS + hours * H).toISOString();
const ACCOUNT = "acct-1";
const COURSE = "501";

// ---------- pure ranking ----------
const fact = (id: string, over: Partial<AgendaFact> = {}): AgendaFact => ({
  id,
  resourceId: id,
  kind: "assignment",
  title: id,
  accountScope: ACCOUNT,
  courseId: COURSE,
  courseName: "Synthetic Course",
  url: null,
  contentHash: `h-${id}`,
  dueAt: at(48),
  lockAt: null,
  unlockAt: null,
  points: 10,
  grade: null,
  done: false,
  canvasMissing: false,
  needsSubmission: true,
  features: { questionCount: null, rubricCriteria: 0, instructionChars: 0 },
  ...over,
});
const minutes = (m: Record<string, number>) => (f: AgendaFact) => ({ minutes: m[f.id] ?? 60, method: "code" as const, label: "estimate" as const, calibrated: false });

test("a later-due long task outranks an earlier-due short one when its slack is smaller", () => {
  const short = fact("short", { dueAt: at(48) }); // slack 48 − 0.5 − 2 = 45.5 h
  const long = fact("long", { dueAt: at(72) }); // slack 72 − 40 − 2 = 30 h
  const r = rankAgenda([short, long], { now: NOW_MS, estimate: minutes({ short: 30, long: 40 * 60 }) });
  assert.deepEqual(r.ranked.map((x) => x.fact.id), ["long", "short"]);
  assert.equal(r.ranked[0]!.slackMinutes, 30 * 60);
  assert.equal(r.ranked[0]!.latestStartMs, NOW_MS + 30 * H);
  assert.equal(r.ranked[1]!.slackMinutes, 45.5 * 60);
  // Earliest-deadline-first alone would put "short" first.
  const edf = [short, long].sort((a, b) => a.dueAt!.localeCompare(b.dueAt!));
  assert.equal(edf[0]!.id, "short");
});

test("ties within the window break on weight, then readiness, then availability", () => {
  const e = minutes({});
  // Same slack: a larger computed share first; listed vs computed isn't compared, points decide.
  const small = fact("small", { grade: { basis: "computed", percent: 2, source: "canvas_group" } });
  const big = fact("big", { dueAt: at(48.5), grade: { basis: "computed", percent: 9, source: "canvas_group" } });
  assert.deepEqual(rankAgenda([small, big], { now: NOW_MS, estimate: e }).ranked.map((x) => x.fact.id), ["big", "small"]);
  const listed = fact("listed", { points: 5, grade: { basis: "listed", percent: 60, source: "canvas_group" } });
  const computed = fact("computed", { points: 20, grade: { basis: "computed", percent: 3, source: "canvas_group" } });
  assert.deepEqual(rankAgenda([listed, computed], { now: NOW_MS, estimate: e }).ranked.map((x) => x.fact.id), ["computed", "listed"]);
  // Equal weight: the exam with more weak topics first.
  const examA = fact("examA", { kind: "exam", points: null });
  const examB = fact("examB", { kind: "exam", points: null, dueAt: at(48.2) });
  const ready = (f: AgendaFact) => (f.id === "examB" ? 0.8 : 0.1);
  assert.deepEqual(rankAgenda([examA, examB], { now: NOW_MS, estimate: e, readiness: ready }).ranked.map((x) => x.fact.id), ["examB", "examA"]);
  // Equal otherwise: an item not yet unlocked sinks.
  const locked = fact("locked", { unlockAt: at(24) });
  const open = fact("open", { dueAt: at(48.3) });
  const r = rankAgenda([locked, open], { now: NOW_MS, estimate: e });
  assert.deepEqual(r.ranked.map((x) => x.fact.id), ["open", "locked"]);
  assert.equal(r.ranked[1]!.flags.notYetOpen, true);
  // Outside the window slack alone decides, whatever the weight.
  const heavy = fact("heavy", { dueAt: at(60), points: 500 });
  assert.deepEqual(rankAgenda([heavy, small], { now: NOW_MS, estimate: e }).ranked.map((x) => x.fact.id), ["small", "heavy"]);
});

test("submitted and graded items drop out; missing and late items are flagged, never hidden", () => {
  const e = minutes({});
  const facts = [
    fact("submitted", { done: true }),
    fact("late", { dueAt: at(-20), canvasMissing: true }),
    fact("closed", { dueAt: at(-30), lockAt: at(-2) }),
    fact("ancient", { dueAt: at(-24 * 30) }),
    fact("paper", { dueAt: at(-5), needsSubmission: false }),
    fact("undated", { dueAt: null }),
    fact("upcoming", { dueAt: at(30) }),
  ];
  const r = rankAgenda(facts, { now: NOW_MS, estimate: e });
  assert.deepEqual(r.ranked.map((x) => x.fact.id), ["late", "upcoming"]);
  const late = r.ranked[0]!;
  assert.equal(late.band, "overdue");
  assert.deepEqual(late.flags, { missing: true, late: true, notYetOpen: false });
  // Can't be submitted any more, or overdue past the window: flagged in `missing`, not ranked.
  assert.deepEqual(r.missing.map((x) => x.fact.id).sort(), ["ancient", "closed"]);
  assert.ok(r.missing.every((x) => x.flags.missing));
  assert.equal(r.counts.missing, 3);
  assert.equal(r.counts.undated, 1);
  assert.equal(r.counts.overdue, 1);
});

test("estimates: code's rule is bounded to 5 min–40 h", () => {
  const huge = codeEstimate({ kind: "exam", points: 1000, questionCount: null, rubricCriteria: 400, instructionChars: 10_000_000, materialTokens: 10_000_000 });
  assert.equal(huge.minutes, AGENDA_CONFIG.estimate.maxMinutes);
  const tiny = codeEstimate({ kind: "quiz", points: 0, questionCount: 1, rubricCriteria: 0, instructionChars: 0, materialTokens: null }, {
    ...AGENDA_CONFIG,
    estimate: { ...AGENDA_CONFIG.estimate, quizSetupMinutes: 0, minutesPerQuestion: 1 },
  });
  assert.equal(tiny.minutes, AGENDA_CONFIG.estimate.minMinutes);
  const quiz = codeEstimate({ kind: "quiz", points: 10, questionCount: 12, rubricCriteria: 0, instructionChars: 0, materialTokens: null });
  assert.equal(quiz.minutes, 5 + 12 * 2 + 10);
  assert.equal(AGENDA_CONFIG.validated, false);
});

// ---------- the store, the pack path and the views ----------
const resource = (id: string, over: Partial<ResourceInput> = {}): ResourceInput => ({
  externalId: id,
  kind: "assignment",
  courseId: COURSE,
  courseName: "Synthetic Chemistry",
  title: `Problem set ${id}`,
  url: `https://canvas.example.test/courses/${COURSE}/assignments/${id}`,
  text: `Answer the questions on reaction rates for set ${id}. Show your work.`,
  deadlines: [],
  points: 15,
  submitted: null,
  policy: { mode: "coaching", evidence: "Synthetic: AI help allowed for planning." },
  submissionTypes: ["online_upload"],
  submission: { workflowState: "unsubmitted" },
  ...over,
});
const batch = (scope: string, resources: ResourceInput[], observedAt = "2026-09-30T12:00:00.000Z"): CaptureBatch => ({
  source: { id: `src-${scope}`, label: "Synthetic Canvas", kind: "canvas", accountScope: ACCOUNT, courseId: COURSE, scope },
  observedAt,
  complete: true,
  status: "ok",
  resources,
});

function seeded(extra: ResourceInput[] = []) {
  const store = createStore(":memory:");
  store.setPrivacy({ ...defaultPrivacy, mode: "selective_cloud", hostedProvider: "claude", shareCourseText: true });
  store.setConsent!({ action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION }, "2026-09-30T12:00:00Z");
  store.ingest(batch("course", [resource("course", { kind: "course", title: "Synthetic Chemistry", submissionTypes: undefined, submission: undefined, points: null })]));
  store.ingest(
    batch("assignments", [
      resource("1", { dueAt: at(26) }), // Fri Oct 2, 12 pm
      resource("2", { dueAt: at(50), points: 40 }), // Sat Oct 3
      resource("3", { dueAt: at(12), submission: { workflowState: "submitted", submittedAt: at(-1) } }),
      ...extra,
    ]),
  );
  return store;
}
function fakeRunner(respond: (call: BackendCall) => unknown) {
  const calls: BackendCall[] = [];
  const runner = createModelRunner({
    backend: {
      client: "claude",
      async call(call) {
        calls.push(call);
        return { value: respond(call), usage: { in: 100, cached: 0, out: 20 }, model: "synthetic" };
      },
    },
  });
  return { runner, calls };
}
const ids = (input: string, prefix: string) => [...input.matchAll(new RegExp(`### (${prefix}\\d+):`, "g"))].map((m) => m[1]!);
const query = (store: Store, request: QueryRequest) => runQuery(store, queryRequestSchema.parse(request), { now: () => NOW, gatewayConfigured: false });
const ranked = (store: Store, extra: Partial<Extract<QueryRequest, { view: "agenda.ranked" }>> = {}) => {
  const r = query(store, { view: "agenda.ranked", timeZone: TZ, ...extra });
  assert.equal(r.view, "agenda.ranked");
  return r as Extract<ReturnType<typeof runQuery>, { view: "agenda.ranked" }>;
};
const deps = (runner: ReturnType<typeof fakeRunner>["runner"] | null) => ({ runner: () => runner, now: () => new Date(NOW), timeZone: () => TZ });
const course = { accountScope: ACCOUNT, courseId: COURSE };

test("the launch views work with no network and before any sync, from local data only", () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("network used");
  }) as typeof fetch;
  try {
    // A fresh workspace (launch before any sync): empty, not an error.
    const empty = createStore(":memory:");
    const first = query(empty, { view: "workspace.bootstrap", timeZone: TZ });
    assert.equal(first.view, "workspace.bootstrap");
    if (first.view === "workspace.bootstrap") {
      assert.equal(first.agenda.items.length, 0);
      assert.equal(first.courses.length, 0);
      assert.equal(first.modelCalls, 0);
    }
    empty.close();

    const store = seeded();
    const boot = query(store, { view: "workspace.bootstrap", timeZone: TZ, top: 5 });
    assert.equal(boot.view, "workspace.bootstrap");
    if (boot.view !== "workspace.bootstrap") return;
    assert.deepEqual(boot.agenda.items.map((i) => i.title), ["Problem set 1", "Problem set 2"], "the submitted set drops out");
    assert.equal(boot.courses.find((c) => c.courseId === COURSE)?.open, 2);
    assert.ok(Buffer.byteLength(JSON.stringify(boot)) < 64 * 1024);
    const item = boot.agenda.items[0]!;
    assert.equal(item.estimate.label, "estimate");
    assert.equal(item.estimate.method, "code");
    assert.equal(item.why.source, "code");
    assert.equal(item.why.text, `Due Fri 12 pm · about ${formatMinutes(item.estimate.minutes)} · 15 pts`);
    assert.equal(boot.agenda.narration.status, "code");
    // Marked done here (not a re-read of any source): gone from the next view, cached facts or not.
    store.setCompleted(item.resourceId!, true);
    assert.deepEqual(ranked(store).items.map((i) => i.title), ["Problem set 2"]);
    store.close();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the model refines each estimate once per text hash, bounded; a repeat costs 0 tokens", async () => {
  const store = seeded();
  const { runner, calls } = fakeRunner((call) =>
    call.pack.id === "agenda-estimate"
      ? { items: ids(call.input, "e").map((id, i) => ({ id, minutes: i === 0 ? 99_999 : 1, basis: "synthetic" })) }
      : { lines: [] },
  );
  const first = await estimateCourse(store, course, deps(runner));
  assert.equal(first.modelCalls, 1);
  assert.equal(calls.length, 1);
  assert.ok(!calls[0]!.input.includes(ACCOUNT), "no account identifier in the payload");
  assert.ok(store.receipts().some((r) => r.purpose.includes("Estimate") && r.status === "sent"), "a receipt per send");
  const items = ranked(store).items;
  const byTitle = Object.fromEntries(items.map((i) => [i.title, i.estimate]));
  assert.deepEqual(new Set(items.map((i) => i.estimate.method)), new Set(["model"]));
  assert.equal(byTitle["Problem set 1"]!.minutes, AGENDA_CONFIG.estimate.maxMinutes, "40 h at most");
  assert.equal(byTitle["Problem set 2"]!.minutes, AGENDA_CONFIG.estimate.minMinutes, "5 min at least");

  // A repeat: nothing pending, no call, no tokens.
  const tokensBefore = store.ledger(100).reduce((n, e) => n + e.tokensIn + e.tokensOut, 0);
  const again = await estimateCourse(store, course, deps(runner));
  assert.equal(again.modelCalls, 0);
  assert.equal(calls.length, 1);
  assert.equal(store.ledger(100).reduce((n, e) => n + e.tokensIn + e.tokensOut, 0), tokensBefore);
  // The views never call a model.
  assert.equal(ranked(store).modelCalls, 0);
  assert.equal(calls.length, 1);

  // Only an edited assignment is asked about again.
  store.ingest(
    batch(
      "assignments",
      [resource("1", { dueAt: at(26), text: "New instructions: a longer lab report." }), resource("2", { dueAt: at(50), points: 40 }), resource("3", { dueAt: at(12), submission: { workflowState: "submitted", submittedAt: at(-1) } })],
      "2026-10-01T12:00:00.000Z",
    ),
  );
  invalidateAgenda(store);
  await estimateCourse(store, course, deps(runner));
  assert.equal(calls.length, 2);
  assert.deepEqual(ids(calls[1]!.input, "e"), ["e1"], "one item re-estimated");
  store.close();
});

test("a student correction wins and teaches the course's calibration", () => {
  const store = seeded([resource("4", { dueAt: at(100) })]);
  const before = ranked(store).items;
  const one = before.find((i) => i.title === "Problem set 1")!;
  const four = before.find((i) => i.title === "Problem set 4")!;
  assert.equal(four.estimate.calibrated, false);
  const message = correctAgendaEstimate(store, { resourceId: one.resourceId!, minutes: one.estimate.minutes * 2 }, NOW, TZ);
  assert.match(message, /Saved/);
  assert.ok(correctionSchema.safeParse({ subject: "estimate", resourceId: one.resourceId, minutes: 90 }).success);
  const after = ranked(store).items;
  const corrected = after.find((i) => i.title === "Problem set 1")!;
  assert.equal(corrected.estimate.method, "student");
  assert.equal(corrected.estimate.minutes, one.estimate.minutes * 2);
  // The course's other items scale by the ratio (2×), labelled calibrated.
  const four2 = after.find((i) => i.title === "Problem set 4")!;
  assert.equal(four2.estimate.calibrated, true);
  assert.equal(four2.estimate.minutes, Math.min(AGENDA_CONFIG.estimate.maxMinutes, four.estimate.minutes * 2));
  // A correction outside 5 min–40 h is refused at the boundary.
  assert.equal(correctionSchema.safeParse({ subject: "estimate", resourceId: one.resourceId, minutes: 3 }).success, false);
  store.close();
});

test("why-now lines: code drops a line whose date or number doesn't match; a repeat costs 0 tokens", async () => {
  const store = seeded();
  const { runner, calls } = fakeRunner((call) => {
    if (call.pack.id !== "agenda-why") return { items: [] };
    const [a, b] = ids(call.input, "n");
    return {
      lines: [
        { id: a, text: "Start here: it builds directly on this week's reaction-rate reading." },
        { id: b, text: "Due Sunday at 9 pm and worth 50 points, so give it a full evening." },
      ],
    };
  });
  const result = await narrateAgenda(store, deps(runner));
  assert.equal(result.modelCalls, 1);
  const view = ranked(store);
  assert.equal(view.narration.status, "partial");
  assert.equal(view.narration.dropped, 1);
  const [first, second] = view.items;
  assert.equal(first!.why.source, "model");
  assert.match(first!.why.text, /reaction-rate reading/);
  assert.equal(second!.why.source, "code", "the wrong line fell back to code's line");
  assert.match(second!.why.text, /^Due Sat /);
  // The same agenda: no second call.
  const again = await narrateAgenda(store, deps(runner));
  assert.equal(again.modelCalls, 0);
  assert.equal(calls.filter((c) => c.pack.id === "agenda-why").length, 1);
  store.close();
});

test("the line check: numbers, weekdays, months and relative days must match the facts", () => {
  const item = rankAgenda([fact("x", { dueAt: "2026-10-02T04:59:00.000Z", points: 15 })], { now: NOW_MS, estimate: minutes({ x: 120 }) }).ranked[0]!;
  const f = narrationFact(item, "n1", NOW_MS, TZ, { course: "Synthetic Chemistry", title: "Lab 3", covers: [] });
  const ok = (line: string) => checkLine(line, f, item, NOW_MS, TZ).ok;
  // Due Thu Oct 1, 11:59 pm Chicago (today); about 2 h.
  assert.equal(ok("Due tonight at 11:59 pm and about 2 h of work: start after dinner."), true);
  assert.equal(ok("Worth 15 points, due Thursday; Lab 3 needs the whole 2 hours."), true);
  assert.equal(ok("Due tomorrow at 11:59 pm."), false, "tomorrow is wrong");
  assert.equal(ok("Due Friday, so there's time."), false, "wrong weekday");
  assert.equal(ok("Due Oct 2 at 11:59 pm."), false, "wrong day of month");
  assert.equal(ok("Worth 25 points."), false, "wrong number");
  assert.equal(ok("About three hours of work."), false, "wrong number word");
  const titled = narrationFact(item, "n1", NOW_MS, TZ, { course: "Synthetic Chemistry", title: "Lab 3", covers: [] });
  assert.equal(checkLine("Lab 3 is about 3 hours of work.", titled, item, NOW_MS, TZ).ok, false, "a title's number doesn't license an estimate");
  assert.equal(checkLine("Lab 3 is about 2 hours of work.", titled, item, NOW_MS, TZ).ok, true);
  assert.equal(ok("It's overdue already."), false, "not overdue");
  assert.equal(ok("x".repeat(200)), false, "too long");
});

test("the one drain runs agenda.estimate on a course save, as the worker wires it", async () => {
  const store = seeded();
  const { runner, calls } = fakeRunner((call) =>
    call.pack.id === "agenda-estimate"
      ? { items: ids(call.input, "e").map((id) => ({ id, minutes: 95, basis: "synthetic" })) }
      : { lines: ids(call.input, "n").map((id) => ({ id, text: "Start with this one: it opens the week's reading." })) },
  );
  const jobs = pipelineJobRegistry();
  registerAgendaJobs(jobs, deps(runner));
  const core = createCore(store, { fixture: captureBatchSchema.parse(courseFixture), jobs, drain: { idleMs: 0 } });
  try {
    assert.ok(core.saved("src-assignments") > 0, "a course save enqueues the course job");
    await core.settled();
    const done = store.jobs().filter((j) => j.kind === "agenda.estimate");
    assert.equal(done.length, 1);
    assert.equal(done[0]!.status, "done");
    const view = ranked(store);
    assert.deepEqual(view.items.map((i) => [i.estimate.method, i.estimate.minutes]), [["model", 95], ["model", 95]]);
    assert.equal(view.narration.status, "model");
    assert.deepEqual(calls.map((c) => c.pack.id), ["agenda-estimate", "agenda-why"]);
    assert.ok(calls.every((c) => c.lane === "background"), "the drain's model calls use the background lane");
  } finally {
    await core.close();
  }
});

test("the agenda job registers on the drain's registry as a ready course job", () => {
  const registry = createJobRegistry();
  registerAgendaJobs(registry, { runner: () => null });
  assert.deepEqual(registry.readyKinds(), ["agenda.estimate"]);
  assert.equal(registry.get("agenda.estimate")!.subject, "course");
});
