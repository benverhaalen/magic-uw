// owner: mastery (D57). Course mastery over a synthetic course in the SQL stores, through the real
// router: the delayed-recall tier, demotion on a wrong answer, the time-decay flag without demotion,
// the next step, claim → check → update, hide and unhide, the exam slice, the agenda roll-up, past
// exams as of their date, grades through the router, and the copy rules (no percentage or grade
// prediction in any mastery payload or in the view's source).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../packages/storage/src/index";
import { createLearningRouter, type StudyContext } from "../packages/learning/src/router";
import { runPipeline, type CandidateItem } from "../packages/learning/src/items";
import { newCard, review } from "../packages/learning/src/fsrs";
import { createCurrentReferences } from "../packages/learning/src/analytics";
import type { Concept, LearningAttempt } from "../packages/learning/src/store";
import type { ItemFormat } from "../packages/learning/src/config";
import type { AssessmentMasteryData, ClaimData, CourseMasteryData, ExamHistoryData, HideData, ItemsMasteryData } from "../packages/learning/src/mastery";
import type { CourseGradesData } from "../packages/learning/src/strategy/inputs";
import type { PracticeRoundData } from "../packages/learning/src/router-types";
import type { LearningRequest, LearningResult, ResourceInput } from "@magic/contracts";
import { RULES, lintPaths } from "../scripts/copy-lint";
import ts from "typescript";

const base = new Date("2026-09-26T15:00:00.000Z");
const inDays = (d: number, from = base) => new Date(from.getTime() + d * 86_400_000).toISOString();
const ORIGIN = "https://canvas.example.test";
const url = (path: string) => `${ORIGIN}/courses/SYN201/${path}`;
const HASHING = "Chaining stores colliding keys in a linked list at each bucket. Open addressing probes for the next free slot.";
const TREES = "A binary search tree keeps smaller keys on the left.";
const GRAPHS = "Breadth-first search visits vertices in order of distance. A heap keeps the smallest key at the root.";

function concept(id: string, label: string, kind: Concept["kind"], parentId: string | null, position: number, ref: string, sources: Concept["sources"] = []): Concept {
  return { id, courseRef: ref, parentId, label, kind, position, origin: "code", status: "active", mergedInto: null, studentLabel: null, mapVersion: "m1", sources };
}
function resource(externalId: string, kind: ResourceInput["kind"], title: string, path: string, text: string, extra: Partial<ResourceInput> = {}) {
  return {
    externalId, kind, courseId: "SYN201", courseName: "Synthetic algorithms", title, url: url(path), text, deadlines: [],
    policy: { mode: "coaching" as const, evidence: "Synthetic policy" }, ...extra,
  };
}

function seed() {
  const dir = mkdtempSync(join(tmpdir(), "magic-mastery-"));
  let now = base;
  const owner = createStore(join(dir, "workspace.sqlite"), { now: () => now });
  const store = owner.learning;
  owner.ingest({
    source: { id: "syn-source", kind: "canvas", accountScope: "acct", courseId: "SYN201", scope: "assignments", label: "Synthetic" },
    observedAt: base.toISOString(),
    complete: true,
    status: "ok",
    resources: [
      resource("p-hashing", "material", "Hashing notes", "pages/hashing", HASHING),
      resource("f-77", "material", "Trees notes", "files/77", TREES),
      resource("f-88", "material", "Graphs notes", "files/88", GRAPHS),
      resource("g-hw", "material", "Homework", "assignments", "", { assignmentGroup: { weight: 40, position: 1 } }),
      resource("g-ex", "material", "Exams", "assignments", "", { assignmentGroup: { weight: 60, position: 2 } }),
      resource("a-1", "assignment", "Homework 1", "assignments/1", "Read the hashing notes first.", {
        links: [{ url: url("pages/hashing") }], dueAt: inDays(-6), points: 10, assignmentGroupId: "g-hw",
        submission: { workflowState: "graded", submittedAt: inDays(-7), score: 9 }, submitted: true,
      }),
      resource("a-2", "assignment", "Homework 2", "assignments/2", "Tree exercises.", { links: [{ url: url("files/77") }], dueAt: inDays(8), points: 10, assignmentGroupId: "g-hw" }),
      resource("a-exam0", "assignment", "Exam 0", "assignments/9", "Covers hashing.", {
        links: [{ url: url("pages/hashing") }], dueAt: inDays(-10), points: 50, assignmentGroupId: "g-ex",
        submission: { workflowState: "graded", submittedAt: inDays(-10), score: 42 }, submitted: true,
      }),
      resource("a-mid", "assignment", "Midterm 1", "assignments/10", "Covers hashing and trees.", {
        links: [{ url: url("pages/hashing") }, { url: url("files/77") }], dueAt: inDays(5), points: 100, assignmentGroupId: "g-ex",
      }),
      resource("e-final", "event", "Final exam", "calendar_events/1", "", { calendar: { uid: "final-1", start: inDays(30), allDay: false } }),
    ],
  });
  const byExt = new Map(owner.resources().map((r) => [r.externalId, r]));
  const rid = (ext: string) => byExt.get(ext)!.id;
  const ref = store.course("acct", "SYN201").id;
  const graphsQuote = "A heap keeps the smallest key at the root.";
  store.putConceptMap(ref, [
    concept("m1", "Module 1: Hashing", "unit", null, 0, ref),
    concept("m2", "Module 2: Trees and graphs", "unit", null, 1, ref),
    concept("t1", "Chaining", "concept", "m1", 0, ref),
    concept("t2", "Open addressing", "concept", "m1", 1, ref),
    concept("t3", "Binary search trees", "concept", "m2", 0, ref),
    concept("t4", "Graph search", "concept", "m2", 1, ref),
    concept("t5", "Heaps", "concept", "m2", 2, ref, [
      { resourceId: rid("f-88"), contentHash: owner.resource(rid("f-88"))!.contentHash, start: GRAPHS.indexOf(graphsQuote), end: GRAPHS.indexOf(graphsQuote) + graphsQuote.length, quote: graphsQuote, quoteValid: true },
    ]),
  ], "m1");
  const texts = new Map([[rid("p-hashing"), HASHING], [rid("f-77"), TREES], [rid("f-88"), GRAPHS]]);
  const chaining = "Chaining stores colliding keys in a linked list at each bucket.";
  const common = (id: string, familyId: string, conceptId: string, resourceId: string, quote: string) => ({
    id, version: 1, courseRef: ref, familyId, keyIdeas: [], explanation: null, tempting: {},
    bloom: "understand" as const, tier: "T4" as const, sourceTerm: null, origin: "generated" as const, generator: null,
    sources: [{ resourceId, quote }], tags: [{ conceptId, primary: true }],
  });
  const mc = (id: string, familyId: string, conceptId: string, resourceId: string, quote: string, stem: string, options: string[]): CandidateItem => ({
    ...common(id, familyId, conceptId, resourceId, quote), kind: "mc", stem, options: options.map((text, i) => ({ id: "abc"[i]!, text })), key: "a",
  });
  const typed = (id: string, familyId: string, conceptId: string, resourceId: string, quote: string, stem: string, key: string): CandidateItem => ({
    ...common(id, familyId, conceptId, resourceId, quote), kind: "typed", stem, options: null, key, keyIdeas: [{ idea: key, synonyms: [], required: true }],
  });
  const h = rid("p-hashing");
  const candidates: CandidateItem[] = [
    mc("i1m", "f1", "t1", h, chaining, "Which structure stores colliding keys when using chaining?", ["Linked list", "Sorted array", "Search tree"]),
    typed("i1t", "f1", "t1", h, chaining, "Name the structure chaining uses to hold colliding keys.", "linked list"),
    mc("i2m", "f2", "t1", h, chaining, "Where does chaining place a key that collides with another?", ["In the bucket's list", "In the next free slot", "In a new table"]),
    typed("i2t", "f2", "t1", h, chaining, "What does each bucket hold under chaining?", "linked list"),
    mc("i3m", "f3", "t1", h, chaining, "Chaining handles collisions by keeping what per bucket?", ["A list of keys", "One key only", "A counter"]),
    typed("i3t", "f3", "t1", h, chaining, "Chaining keeps colliding keys together in which list type?", "linked list"),
    mc("i4m", "f4", "t1", h, chaining, "With chaining, what grows when many keys collide in one bucket?", ["That bucket's list", "The hash seed", "The table size"]),
    typed("i4t", "f4", "t1", h, chaining, "Type the data structure used per bucket in chaining.", "linked list"),
    mc("i5m", "f5", "t2", h, "Open addressing probes for the next free slot.", "What does open addressing probe for after a collision?", ["The next free slot", "The first full slot", "The hash seed slot"]),
    mc("i6m", "f6", "t3", rid("f-77"), TREES, "Where does a binary search tree keep smaller keys?", ["On the left", "On the right", "At the root"]),
    mc("i7m", "f7", "t4", rid("f-88"), "Breadth-first search visits vertices in order of distance.", "In what order does breadth-first search visit vertices?", ["By distance", "By degree", "At random"]),
  ];
  const seen: string[] = [];
  for (const c of candidates) {
    const checked = runPipeline(c, {
      courseRestricted: false,
      resources: [...texts].map(([id, text]) => ({ id, contentHash: owner.resource(id)!.contentHash, text, kind: "material" })),
      validate: (source, quote) => {
        const start = source.indexOf(quote);
        return start < 0 ? { status: "missing" } : { status: "unique", start, end: start + quote.length };
      },
      map: store.concepts(ref),
      seenStems: seen,
      now: base,
    });
    assert.equal(checked.accepted, true, `${c.id}: ${checked.dropped?.reason}`);
    store.putItem(checked.item!, checked.sources, checked.tags, checked.checks);
    seen.push(c.stem);
  }
  const context = (anchor: string): StudyContext => ({
    resourceId: anchor, accountScope: "acct", courseId: "SYN201", inputHash: `input-${anchor}`, contextHash: `context-${anchor}`,
    label: "Synthetic algorithms", availability: "current", reason: "Ready",
    resources: [...texts].map(([id, text]) => {
      const r = owner.resource(id)!;
      return { id, contentHash: r.contentHash, text, title: r.title, url: r.url, observedAt: base.toISOString(), eligible: true };
    }),
  });
  // With `coursework` the router memoises the references port; without it, every request reads it afresh.
  const makeRouter = (memo = true) =>
    createLearningRouter({
      store,
      resolveContext: (id) => (id === "a1" ? context(id) : null),
      now: () => now,
      analyticsReferences: () => createCurrentReferences(owner),
      ...(memo ? { coursework: () => owner } : {}),
    });
  const router = makeRouter();
  const signal = new AbortController().signal;
  const call = (request: LearningRequest): Promise<LearningResult> => router.handle(request, signal);
  const ok = async <T>(request: LearningRequest): Promise<T> => {
    const res = await call(request);
    assert.equal(res.status, "ok", `${request.op}: ${res.message}`);
    return res.data as T;
  };
  const mastery = () => ok<CourseMasteryData>({ op: "course.mastery", courseId: "SYN201", anchorIds: ["a1"] });
  let seq = 0;
  const answer = (itemId: string, topic: string, format: ItemFormat, right: boolean, at: string) => {
    const a: LearningAttempt = {
      id: `att-${++seq}`, courseRef: ref, itemId, itemVersion: 1, sourceResourceId: h, primaryConceptId: topic, correct: right,
      assistance: "none", seenBefore: false, confidence: null, createdAt: at, format, mode: "test", response: null,
      score: right ? 1 : 0, gradingMethod: "code", responseMs: 4000, conceptTags: [{ conceptId: topic, weight: 1, primary: true }],
      sessionId: `sess-${seq}`, localDay: at.slice(0, 10),
    };
    store.addAttempt(a);
  };
  /** Sixteen right answers on Chaining, all on one day: the model's Solid band without delayed recall. */
  const solidOneDay = (day = "2026-09-24") => {
    const items: [string, ItemFormat][] = [["i1m", "mc"], ["i1t", "typed"], ["i2m", "mc"], ["i2t", "typed"], ["i3m", "mc"], ["i3t", "typed"], ["i4m", "mc"], ["i4t", "typed"]];
    for (let k = 0; k < 16; k++) answer(items[k % 8]![0], "t1", items[k % 8]![1], true, `${day}T${String(8 + Math.floor(k / 2)).padStart(2, "0")}:${k % 2 ? "30" : "00"}:00.000Z`);
  };
  const done = () => {
    owner.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { owner, store, ref, rid, call, ok, mastery, answer, solidOneDay, makeRouter, setNow: (d: Date) => (now = d), done };
}

const topicOf = (m: CourseMasteryData, id: string) => m.topics.find((t) => t.topicId === id)!;
const PREDICTION_RULES = RULES.filter((r) => r.id === "readiness" || r.id === "game" || r.id === "ranking" || r.id === "urgency" || r.id === "guilt");
function noPercentOrPrediction(label: string, value: unknown, allowPercent = false) {
  const json = JSON.stringify(value);
  if (!allowPercent) assert.equal(json.includes("%"), false, `${label}: a percentage appears`);
  for (const hidden of ["theta", "pHat", "pLow", "probability", "priority"]) assert.equal(json.includes(hidden), false, `${label}: leaks ${hidden}`);
  const strings: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(value);
  for (const s of strings) for (const r of PREDICTION_RULES) assert.equal(r.pattern.test(s), false, `${label}: "${s}" matches ${r.id}`);
}

test("two tiers: Solid without a later-day recall shows as Getting there; a right recall on a later day makes it Mastered", async () => {
  const s = seed();
  try {
    s.solidOneDay();
    const first = await s.mastery();
    const t1 = topicOf(first, "t1");
    assert.equal(s.store.conceptState(s.ref).find((r) => r.conceptId === "t1")!.band, "solid", "the model's band is Solid");
    assert.deepEqual([t1.state, t1.stateLabel, t1.confirmed, t1.awaitingLaterRecall], ["getting_there", "Getting there", false, true]);
    assert.match(t1.why, /recall it right on a later day/);
    assert.equal(first.counts.solid, 0);
    assert.equal(first.label, "Mastered 0 of 5 topics");
    assert.equal(t1.evidenceCount, 16);
    assert.equal(t1.lastEvidenceDay, "2026-09-24");
    // A right recognition answer on a later day doesn't confirm it; a typed one does.
    s.answer("i1m", "t1", "mc", true, "2026-09-25T09:00:00.000Z");
    assert.equal(topicOf(await s.mastery(), "t1").state, "getting_there");
    s.answer("i2t", "t1", "typed", true, "2026-09-25T10:00:00.000Z");
    const after = await s.mastery();
    assert.deepEqual([topicOf(after, "t1").state, topicOf(after, "t1").stateLabel, topicOf(after, "t1").confirmed], ["solid", "Mastered", true]);
    assert.equal(after.label, "Mastered 1 of 5 topics");
    assert.equal(after.counts.solid, 1);
    noPercentOrPrediction("course.mastery", after);
  } finally {
    s.done();
  }
});

test("a wrong answer on a Mastered topic demotes it visibly (the model's lapse rule), with the reason", async () => {
  const s = seed();
  try {
    s.solidOneDay();
    s.answer("i2t", "t1", "typed", true, "2026-09-25T10:00:00.000Z");
    assert.equal(topicOf(await s.mastery(), "t1").state, "solid");
    s.answer("i3t", "t1", "typed", false, "2026-09-26T09:00:00.000Z");
    const t1 = topicOf(await s.mastery(), "t1");
    assert.equal(t1.state, "iffy");
    assert.match(t1.reasons.map((r) => r.text).join(" "), /Missed a question on 26 Sep after getting it right/);
  } finally {
    s.done();
  }
});

test("time decay is a flag: forty days later the topic is still Mastered and is due for review; the next step is the due cards", async () => {
  const s = seed();
  try {
    s.solidOneDay();
    s.answer("i2t", "t1", "typed", true, "2026-09-25T10:00:00.000Z");
    // A reviewed card on Chaining (the typed item), last reviewed on 25 Sep.
    let card = newCard({ id: "card-i1t", itemId: "i1t", courseRef: s.ref, conceptId: "t1" }, new Date("2026-09-24T12:00:00.000Z"));
    for (const at of ["2026-09-24T12:00:00.000Z", "2026-09-25T12:00:00.000Z"]) {
      const r = review(card, 3, new Date(at), { id: `rv-${at}`, reviewMs: 2000, localDay: at.slice(0, 10) });
      s.store.putCard(r.card);
      s.store.addReview(r.review);
      card = r.card;
    }
    const soon = await s.mastery();
    assert.equal(topicOf(soon, "t1").dueForReview, false, "not due the next day");
    s.setNow(new Date("2026-11-05T15:00:00.000Z"));
    const later = await s.mastery();
    const t1 = topicOf(later, "t1");
    assert.deepEqual([t1.state, t1.confirmed, t1.dueForReview], ["solid", true, true], "shown as Mastered, flagged due, never silently demoted");
    assert.equal(later.sinceLastWeek.dueForReview, 1);
    assert.match(later.sinceLastWeek.text, /1 is due for review/);
    // No exam is upcoming and nothing is Iffy, so the due cards come first.
    assert.equal(later.nextStep?.kind, "review");
    assert.deepEqual(later.nextStep?.command, { type: "learning", request: { op: "practice.target", courseId: "SYN201", topicIds: ["t1"], mode: "flashcards", count: 1 } });
    assert.equal(later.nextStep?.label, "Review 1 due card");
    // The command runs exactly what the label says.
    const run = await s.ok<{ flashcards: { remaining: number } }>({ ...later.nextStep!.command.request, anchorIds: ["a1"], operationId: "review-1" } as LearningRequest);
    assert.equal(run.flashcards.remaining, 1);
  } finally {
    s.done();
  }
});

test("next step: weakness × exam proximity picks the topic; an Iffy one on the exam comes first; no items means generate", async () => {
  const s = seed();
  try {
    const fresh = await s.mastery();
    // Nothing practiced: the top topic is in Midterm 1's scope (5 days away) → a quiz on it and its module sibling.
    assert.equal(fresh.nextStep?.kind, "quiz");
    const cmd = fresh.nextStep!.command;
    assert.equal(cmd.type, "learning");
    if (cmd.type !== "learning") return;
    assert.equal(cmd.request.mode, "test");
    assert.ok(cmd.request.topicIds.every((t) => ["t1", "t2", "t3"].includes(t)), "topics in the midterm's scope");
    assert.match(fresh.nextStep!.detail, /Midterm 1 in 5 days/);
    // The label's count is exactly what the quiz serves (a quiz serves each question once).
    const started = await s.ok<PracticeRoundData>({ ...cmd.request, anchorIds: ["a1"], operationId: "quiz-1" } as LearningRequest);
    assert.equal(started.session.plan[0]!.itemIds.length >= cmd.request.count, true);
    assert.match(fresh.nextStep!.label, new RegExp(`^Quiz me: ${cmd.request.count} questions? on `));

    // Graph search goes Iffy, but it isn't on any exam: the priority (weakness × exam proximity ×
    // scope share) still puts the midterm's topics first. Five misses: repeats of one item count
    // half, so the model's Iffy rule (R1) needs this many.
    for (let k = 0; k < 5; k++) s.answer("i7m", "t4", "mc", false, `2026-09-2${1 + k}T10:00:00.000Z`);
    const offExam = await s.mastery();
    assert.equal(topicOf(offExam, "t4").state, "iffy");
    assert.notEqual(offExam.nextStep?.topicIds[0], "t4");
    // Open addressing goes Iffy and it's on the midterm: it comes first.
    for (let k = 0; k < 5; k++) s.answer("i5m", "t2", "mc", false, `2026-09-2${1 + k}T11:00:00.000Z`);
    const iffy = await s.mastery();
    assert.equal(topicOf(iffy, "t2").state, "iffy");
    assert.equal(iffy.nextStep?.kind, "quiz");
    assert.equal(iffy.nextStep?.topicIds[0], "t2");
    assert.match(iffy.nextStep!.detail, /^Open addressing is Iffy\. It's on Midterm 1 in 5 days\.$/);

    // With the others hidden, Heaps (no practice items) is all that's left: generate, which uses the student's AI.
    for (const t of ["t1", "t2", "t3", "t4"]) await s.ok<HideData>({ op: "mastery.hide", courseId: "SYN201", anchorIds: ["a1"], topicId: t, hidden: true });
    const left = await s.mastery();
    assert.deepEqual(left.topics.map((t) => [t.topicId, t.practiceItems, t.why]), [["t5", 0, "Not practiced yet. No practice items yet."]]);
    assert.equal(left.nextStep?.kind, "generate");
    assert.equal(left.nextStep?.usesAi, true);
    assert.deepEqual(left.nextStep?.command, { type: "pack", pack: "quiz", scope: { courseId: "SYN201", topicIds: ["t5"] } });
  } finally {
    s.done();
  }
});

test("claim → check → update: 'I know this' records the claim, returns a check from the topic's pool, and the answer updates the state normally", async () => {
  const s = seed();
  try {
    assert.equal(topicOf(await s.mastery(), "t2").state, "not_seen");
    const claim = await s.ok<ClaimData>({ op: "mastery.claim", courseId: "SYN201", anchorIds: ["a1"], topicId: "t2", operationId: "claim-1" });
    assert.equal(claim.recorded, "know_it");
    assert.ok(claim.check, "a check, not acceptance");
    const round = claim.check as PracticeRoundData;
    assert.deepEqual(round.practice.topicIds, ["t2"], "only the claimed topic");
    assert.equal(round.session.plan[0]!.itemIds.length, 1, "t2 has one question in its pool (at most 3)");
    // The claim itself never moves the state.
    assert.equal(topicOf(await s.mastery(), "t2").state, "not_seen");
    assert.equal(s.store.evidence(s.ref).selfRatings.filter((r) => r.id === "claim:claim-1").length, 1);
    // Repeating the same operation doesn't record a second claim or start a second session.
    const again = await s.ok<ClaimData>({ op: "mastery.claim", courseId: "SYN201", anchorIds: ["a1"], topicId: "t2", operationId: "claim-1" });
    assert.equal((again.check as PracticeRoundData).session.id, round.session.id);
    assert.equal(s.store.evidence(s.ref).selfRatings.length, 1);
    const item = round.session.currentItem!;
    const answered = await s.call({ op: "study.answer", sessionId: round.session.id, revision: 0, operationId: "ans-1", itemId: item.id, itemVersion: item.version, response: { kind: "choice", optionId: "a" }, confidence: null, responseMs: 3000 });
    assert.equal(answered.status, "ok", answered.message);
    const after = topicOf(await s.mastery(), "t2");
    assert.notEqual(after.state, "not_seen");
    assert.equal(after.evidenceCount, 1);
    const cached = s.store.conceptState(s.ref).find((r) => r.conceptId === "t2")!.band;
    assert.equal(after.state, cached, "the same state the practice engine computed");
    // A topic without practice items: nothing to check with, and the generate command.
    const empty = await s.ok<ClaimData>({ op: "mastery.claim", courseId: "SYN201", anchorIds: ["a1"], topicId: "t5", operationId: "claim-2" });
    assert.equal(empty.check, null);
    assert.deepEqual(empty.generate, { type: "pack", pack: "quiz", scope: { courseId: "SYN201", topicIds: ["t5"] } });
    assert.equal((await s.call({ op: "mastery.claim", courseId: "SYN201", anchorIds: ["a1"], topicId: "m1", operationId: "claim-3" })).status, "unavailable", "a module isn't a topic");
  } finally {
    s.done();
  }
});

test("hide and unhide: a student correction, reversible, and the evidence is kept", async () => {
  const s = seed();
  try {
    s.answer("i7m", "t4", "mc", true, "2026-09-25T10:00:00.000Z");
    const hid = await s.ok<HideData>({ op: "mastery.hide", courseId: "SYN201", anchorIds: ["a1"], topicId: "t4", hidden: true });
    assert.match(hid.message, /Graph search is hidden .* Your answers on it are kept/);
    const m = await s.mastery();
    assert.equal(m.topics.some((t) => t.topicId === "t4"), false);
    assert.deepEqual(m.hidden, [{ topicId: "t4", label: "Graph search" }]);
    assert.equal(m.total, 4);
    assert.equal(s.store.evidence(s.ref).attempts.length, 1, "evidence kept");
    assert.equal((await s.call({ op: "mastery.hide", courseId: "SYN201", anchorIds: ["a1"], topicId: "t4", hidden: true })).status, "unavailable");
    await s.ok<HideData>({ op: "mastery.hide", courseId: "SYN201", anchorIds: ["a1"], topicId: "t4", hidden: false });
    const back = await s.mastery();
    assert.equal(topicOf(back, "t4").evidenceCount, 1);
    assert.deepEqual(back.hidden, []);
    // A concept map rebuild keeps the student's hide.
    await s.ok<HideData>({ op: "mastery.hide", courseId: "SYN201", anchorIds: ["a1"], topicId: "t4", hidden: true });
    s.store.putConceptMap(s.ref, s.store.concepts(s.ref).map((c) => ({ ...c, status: "active" as const })), "m2");
    assert.deepEqual((await s.mastery()).hidden.map((h) => h.topicId), ["t4"]);
  } finally {
    s.done();
  }
});

test("the exam slice, the agenda roll-up and past exams as of their date", async () => {
  const s = seed();
  try {
    // Before Exam 0 (16 Sep): five misses on Open addressing. After it: Chaining to Mastered.
    for (let k = 0; k < 5; k++) s.answer("i5m", "t2", "mc", false, `2026-09-1${k}T10:00:00.000Z`);
    s.solidOneDay();
    s.answer("i2t", "t1", "typed", true, "2026-09-25T10:00:00.000Z");
    const m = await s.mastery();
    assert.deepEqual(m.assessments.map((a) => [a.title, a.daysAway, a.scope, a.topicIds]), [
      ["Midterm 1", 5, "linked", ["t1", "t2", "t3"]],
      ["Final exam", 30, "not_linked", []],
    ]);
    assert.equal(m.assessments[0]!.label, "Mastered 1 of 3 topics for Midterm 1");

    const slice = await s.ok<AssessmentMasteryData>({ op: "mastery.assessment", courseId: "SYN201", anchorIds: ["a1"], assessmentId: m.assessments[0]!.assessmentId });
    assert.deepEqual(slice.topics.map((t) => [t.topicId, t.stateLabel]), [["t1", "Mastered"], ["t2", "Iffy"], ["t3", "Not seen yet"]]);
    assert.deepEqual(slice.assessment.counts, { solid: 1, getting_there: 0, iffy: 1, not_seen: 1 });
    assert.equal(slice.assessment.nextStep?.topicIds[0], "t2", "the exam's own next step");
    assert.equal((await s.call({ op: "mastery.assessment", courseId: "SYN201", anchorIds: ["a1"], assessmentId: "nope" })).status, "unavailable");

    const day = await s.ok<ItemsMasteryData>({ op: "mastery.forItems", courseId: "SYN201", anchorIds: ["a1"], itemIds: [s.rid("a-2"), s.rid("a-1"), "unknown"] });
    assert.deepEqual(day.items.map((i) => [i.title, i.linkage, i.topicIds]), [
      ["Homework 2", "linked", ["t3"]],
      ["Homework 1", "linked", ["t1", "t2"]],
      [null, "unknown_item", []],
    ]);
    assert.deepEqual(day.counts, { solid: 1, getting_there: 0, iffy: 1, not_seen: 1 });
    assert.equal(day.label, "Mastered 1 of 3 topics behind these items");
    assert.ok(day.nextStep);

    const history = await s.ok<ExamHistoryData>({ op: "mastery.history", courseId: "SYN201", anchorIds: ["a1"] });
    assert.equal(history.exams.length, 1);
    const exam0 = history.exams[0]!;
    assert.equal(exam0.title, "Exam 0");
    assert.deepEqual(exam0.asOf.topics.map((t) => [t.topicId, t.state]), [["t1", "not_seen"], ["t2", "iffy"]], "as of 16 Sep, from the evidence stored up to then");
    assert.deepEqual(exam0.score, { earned: 42, possible: 50, text: "42 of 50 points, as Canvas shows it" });
    assert.deepEqual(exam0.since.up.map((t) => [t.topicId, t.from, t.to]), [["t1", "not_seen", "solid"]]);
    assert.deepEqual(exam0.since.down, []);
    for (const [label, v] of [["mastery.assessment", slice], ["mastery.forItems", day], ["mastery.history", history]] as const) noPercentOrPrediction(label, v);
  } finally {
    s.done();
  }
});

test("since last week counts self-referenced moves only; no topic map is said plainly", async () => {
  const s = seed();
  try {
    for (let k = 0; k < 5; k++) s.answer("i7m", "t4", "mc", false, `2026-09-1${k}T10:00:00.000Z`);
    s.solidOneDay();
    s.answer("i2t", "t1", "typed", true, "2026-09-25T10:00:00.000Z");
    const m = await s.mastery();
    assert.equal(topicOf(m, "t4").dueForReview, false, "never recalled, so nothing to forget: its state already says it needs work");
    assert.deepEqual([m.sinceLastWeek.since, m.sinceLastWeek.movedUp, m.sinceLastWeek.movedDown], ["2026-09-19", 1, 0]);
    assert.equal(m.sinceLastWeek.text, "Since 19 Sep: 1 topic moved up, 0 are due for review.");
    // A course with no topic map.
    s.store.putConceptMap(s.ref, s.store.concepts(s.ref).map((c) => ({ ...c, status: "hidden" as const, origin: "student" as const })), "m3");
    const none = await s.mastery();
    assert.equal(none.status, "no_topics");
    assert.match(none.message!, /no topic map yet/);
    assert.equal(none.nextStep?.kind, "generate");
  } finally {
    s.done();
  }
});

test("course.grades through the router: account-scoped scores, listed weights, the high-weight exam and its weak topics", async () => {
  const s = seed();
  try {
    s.answer("i5m", "t2", "mc", false, "2026-09-25T10:00:00.000Z");
    const g = await s.ok<CourseGradesData>({ op: "course.grades", courseId: "SYN201", anchorIds: ["a1"] });
    assert.deepEqual(g.grades.weights, { status: "known", source: "canvas", text: "Group weights as listed in Canvas." });
    // Homework 9/10 (40), exams 42/50 (60): (40·90 + 60·84) / 100.
    assert.deepEqual(g.grades.grade, { status: "known", percent: 86.4, basis: "From your captured Canvas scores. Group weights as listed in Canvas. Ungraded work isn't counted yet." });
    // Complete capture, no drops: each item's own share. Midterm 1 is 100 of Exams' 150 points (60%): 40.
    assert.deepEqual(g.grades.upcomingHighWeight.map((i) => [i.title, i.weight]), [
      ["Midterm 1", { share: 40, group: 60, source: "canvas" }],
      ["Homework 2", { share: 20, group: 40, source: "canvas" }],
    ]);
    assert.deepEqual(g.overlaps[0]!.weakTopics.map((t) => t.topicId), ["t1", "t2", "t3"]);
    assert.ok(g.observations.some((o) => o.kind === "overlap" && o.text.startsWith("3 weak topics (Chaining: Not seen yet; Open addressing: Getting there; Binary search trees: Not seen yet) overlap Midterm 1, due 1 Oct, about 40% of the grade (Exams is 60%, as listed in Canvas).")), JSON.stringify(g.observations));
    assert.match(g.observationHash, /^[a-f0-9]{64}$/);
    noPercentOrPrediction("course.grades", g, true);
  } finally {
    s.done();
  }
});

test("copy: the mastery view's source passes the copy lint; its only percentages are captured grade facts", () => {
  assert.deepEqual(lintPaths(["apps/desktop/src/renderer/backend/mastery"]), []);
  for (const file of ["MasteryView.tsx", "StateBar.tsx", "SessionRunner.tsx"]) {
    // Every piece of copy (string, template and JSX text) with a "%" must be the captured grade line.
    const source = readFileSync(join("apps/desktop/src/renderer/backend/mastery", file), "utf8");
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const copy: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node)) copy.push(node.getText(sf));
      else if (ts.isTemplateExpression(node)) copy.push(node.getText(sf));
      ts.forEachChild(node, visit);
    };
    visit(sf);
    for (const c of copy.filter((c) => c.includes("%"))) assert.match(c, /^`Current grade from your captured scores: \$\{grade\.percent\}%\.`$/, `${file}: a percentage outside the captured grade: ${c}`);
  }
});

test("analytics.course and analytics.assignment answer exactly the same with the memoised references port, before and after a link changes", async () => {
  const s = seed();
  try {
    s.answer("i5m", "t2", "mc", false, "2026-09-25T10:00:00.000Z");
    const signal = new AbortController().signal;
    const memo = s.makeRouter(true);
    const fresh = () => s.makeRouter(false);
    const requests = [
      { op: "analytics.course", courseId: "SYN201", anchorIds: ["a1"] },
      { op: "analytics.assignment", courseId: "SYN201", anchorIds: ["a1"], assignmentId: s.rid("a-2") },
      { op: "analytics.agendaHints", courseId: "SYN201", anchorIds: ["a1"] },
    ];
    const compare = async (label: string) => {
      for (const r of requests) {
        const expected = await fresh().analytics(r, signal);
        assert.equal(expected.status, "ok", `${label} ${r.op}: ${expected.message}`);
        assert.deepEqual(await memo.analytics(r, signal), expected, `${label}: ${r.op} (first read)`);
        assert.deepEqual(await memo.analytics(r, signal), expected, `${label}: ${r.op} (from the memo)`);
      }
    };
    await compare("before");
    // A new link changes Homework 2's references; the memo must drop what it kept.
    const a2 = s.owner.resource(s.rid("a-2"))!;
    s.owner.putLink({ id: "l-new", fromId: a2.id, toId: s.rid("f-88"), type: "supports", reason: "Named in class", status: "proposed", inputHash: a2.contentHash });
    await compare("after a link");
    const after = (await memo.analytics(requests[1], signal)).data as { topics: { conceptId: string }[] };
    assert.ok(after.topics.some((t) => t.conceptId === "t4"), "the new link's topics appear");
  } finally {
    s.done();
  }
});
