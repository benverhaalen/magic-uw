// owner: analytics. Practice analytics over a synthetic course in the SQL learning store:
// the references adapter, the rollups, the router ops and the incremental cache.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../packages/storage/src/index";
import { createLearningRouter, type StudyContext } from "../packages/learning/src/router";
import { runPipeline, type CandidateItem } from "../packages/learning/src/items";
import type { Concept } from "../packages/learning/src/store";
import { createAnalytics, createCurrentReferences, examKind, urlKey } from "../packages/learning/src/analytics";
import type {
  AgendaHintsData,
  AssignmentAnalyticsData,
  CourseAnalyticsData,
  KnowledgeStateData,
  PracticeRoundData,
} from "../packages/learning/src/router-types";
import type { LearningRequest, LearningResult, ResourceInput } from "@magic/contracts";

const at = new Date("2026-09-26T15:00:00.000Z");
const inDays = (d: number) => new Date(at.getTime() + d * 86_400_000).toISOString();
const ORIGIN = "https://canvas.example.test";
const url = (path: string) => `${ORIGIN}/courses/SYN201/${path}`;
const HASHING = "Chaining stores colliding keys in a linked list at each bucket. Open addressing probes for the next free slot.";
const TREES = "A binary search tree keeps smaller keys on the left.";
const GRAPHS = "Breadth-first search visits vertices in order of distance.";

function concept(id: string, label: string, kind: Concept["kind"], parentId: string | null, position: number, ref: string): Concept {
  return { id, courseRef: ref, parentId, label, kind, position, origin: "code", status: "active", mergedInto: null, studentLabel: null, mapVersion: "m1", sources: [] };
}

function resource(externalId: string, kind: ResourceInput["kind"], title: string, path: string, text: string, extra: Partial<ResourceInput> = {}) {
  return {
    externalId, kind, courseId: "SYN201", courseName: "Synthetic algorithms", title, url: url(path), text, deadlines: [],
    policy: { mode: "coaching" as const, evidence: "Synthetic policy" }, ...extra,
  };
}

function seed() {
  const dir = mkdtempSync(join(tmpdir(), "magic-analytics-"));
  const owner = createStore(join(dir, "workspace.sqlite"), { now: () => at });
  const store = owner.learning;
  owner.ingest({
    source: { id: "syn-source", kind: "canvas", accountScope: "acct", courseId: "SYN201", scope: "all", label: "Synthetic" },
    observedAt: at.toISOString(),
    complete: true,
    status: "ok",
    resources: [
      resource("p-hashing", "material", "Hashing notes", "pages/hashing", HASHING),
      resource("f-77", "material", "Trees notes", "files/77", TREES),
      resource("f-88", "material", "Graphs notes", "files/88", GRAPHS),
      resource("mi-9", "material", "Trees notes (module item)", "modules/items/9", "", { moduleItem: { type: "File", title: "Trees notes", contentId: "77" } }),
      resource("mod-7", "material", "Week 7", "modules/7", "", { module: { id: "7", position: 7 } }),
      resource("mi-30", "material", "Participation (module item)", "modules/items/30", "", { moduleItem: { type: "Assignment", title: "Participation", contentId: "3" } }),
      resource("a-1", "assignment", "Homework 1", "assignments/1", "Read the hashing notes first.", { links: [{ url: url("pages/hashing?module_item_id=3") }], dueAt: inDays(3) }),
      resource("a-2", "assignment", "Homework 2", "assignments/2", "Tree exercises.", { links: [{ url: url("modules/items/9") }], dueAt: inDays(8) }),
      resource("a-3", "assignment", "Participation", "assignments/3", "", { dueAt: inDays(9) }),
      resource("a-mid", "assignment", "Midterm 1", "assignments/10", "Covers hashing and trees.", {
        links: [{ url: url("pages/hashing") }, { url: `${url("files/77")}/download?wrap=1` }],
        deadlines: [{ value: inDays(5), kind: "due", quote: "Due in five days", authority: "structured", scopeConfirmed: true }],
      }),
      resource("a-rev", "assignment", "Midterm 1 review", "assignments/11", "Practice problems.", { links: [{ url: url("files/88") }], dueAt: inDays(4) }),
      resource("a-quiz", "assignment", "Reading check", "assignments/12", "", { submissionTypes: ["online_quiz"] }),
      resource("e-final", "event", "Final exam", "calendar_events/1", "", { calendar: { uid: "final-1", start: inDays(30), allDay: false } }),
    ],
  });
  const byExt = new Map(owner.resources().map((r) => [r.externalId, r]));
  const rid = (ext: string) => byExt.get(ext)!.id;
  const ref = store.course("acct", "SYN201").id;
  store.putConceptMap(ref, [
    concept("m1", "Module 1: Hashing", "unit", null, 0, ref),
    concept("m2", "Module 2: Trees and graphs", "unit", null, 1, ref),
    concept("t1", "Chaining", "concept", "m1", 0, ref),
    concept("t2", "Open addressing", "concept", "m1", 1, ref),
    concept("t3", "Binary search trees", "concept", "m2", 0, ref),
    concept("t4", "Graph search", "concept", "m2", 1, ref),
  ], "m1");
  const texts = new Map([[rid("p-hashing"), HASHING], [rid("f-77"), TREES], [rid("f-88"), GRAPHS]]);
  const base = (id: string, familyId: string, conceptId: string, resourceId: string, quote: string) => ({
    id, version: 1, courseRef: ref, familyId, keyIdeas: [], explanation: null, tempting: {},
    bloom: "understand" as const, tier: "T4" as const, sourceTerm: null, origin: "generated" as const, generator: null,
    sources: [{ resourceId, quote }], tags: [{ conceptId, primary: true }],
  });
  const mc = (id: string, familyId: string, conceptId: string, resourceId: string, quote: string, stem: string, options: string[]): CandidateItem => ({
    ...base(id, familyId, conceptId, resourceId, quote), kind: "mc", stem, options: options.map((text, i) => ({ id: "abc"[i]!, text })), key: "a",
  });
  const candidates: CandidateItem[] = [
    mc("i-t1-mc", "f1", "t1", rid("p-hashing"), "Chaining stores colliding keys in a linked list at each bucket.", "Which structure stores colliding keys when using chaining?", ["Linked list", "Sorted array", "Search tree"]),
    {
      ...base("i-t1-typed", "f1", "t1", rid("p-hashing"), "Chaining stores colliding keys in a linked list at each bucket."), kind: "typed",
      stem: "Name the structure used to store colliding keys in chaining.", options: null, key: "linked list",
      keyIdeas: [{ idea: "linked list", synonyms: [], required: true }],
    },
    mc("i-t2-mc", "f2", "t2", rid("p-hashing"), "Open addressing probes for the next free slot.", "What does open addressing probe for after a collision?", ["The next free slot", "The first full slot", "The hash seed slot"]),
    mc("i-t3-mc", "f3", "t3", rid("f-77"), TREES, "Where does a binary search tree keep smaller keys?", ["On the left", "On the right", "At the root"]),
    mc("i-t4-mc", "f4", "t4", rid("f-88"), GRAPHS, "In what order does breadth-first search visit vertices?", ["By distance", "By degree", "At random"]),
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
      now: at,
    });
    assert.equal(checked.accepted, true, `${c.id}: ${checked.dropped?.reason}`);
    store.putItem(checked.item!, checked.sources, checked.tags, checked.checks);
    seen.push(c.stem);
  }
  const context = (anchor: string, courseId = "SYN201"): StudyContext => ({
    resourceId: anchor, accountScope: "acct", courseId, inputHash: `input-${anchor}`, contextHash: `context-${anchor}`,
    label: "Synthetic algorithms", availability: "current", reason: "Ready",
    resources: [...texts].map(([id, text]) => {
      const r = owner.resource(id)!;
      return { id, contentHash: r.contentHash, text, title: r.title, url: r.url, observedAt: at.toISOString(), eligible: true };
    }),
  });
  const router = createLearningRouter({
    store,
    resolveContext: (id) => (id === "a1" ? context(id) : id === "other" ? context(id, "OTHER") : null),
    now: () => at,
    analyticsReferences: () => createCurrentReferences(owner),
  });
  const signal = new AbortController().signal;
  const call = (request: LearningRequest): Promise<LearningResult> => router.handle(request, signal);
  const analytics = (request: unknown) => router.analytics(request, signal);
  const done = () => {
    owner.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { owner, store, ref, rid, call, analytics, done };
}

const HIDDEN = ["theta", "pHat", "pLow", "\"acc\"", "%", "priority", "probability"];
const noNumbersLeak = (value: unknown) => {
  const json = JSON.stringify(value);
  for (const hidden of HIDDEN) assert.equal(json.includes(hidden), false, `leaks ${hidden}`);
};

test("references adapter: description links resolve through URLs and module items; exams are dated by code", () => {
  const { owner, rid, done } = seed();
  try {
    const port = createCurrentReferences(owner);
    assert.equal(urlKey(`${ORIGIN}/courses/X/files/5/download?wrap=1`), "canvas.example.test/courses/x/files/5");
    assert.deepEqual(port.references(rid("a-1")).map((m) => [m.resourceId, m.reason]), [
      [rid("a-1"), "The assignment's own page."],
      [rid("p-hashing"), "Linked in the description."],
    ]);
    assert.deepEqual(port.references(rid("a-2")).map((m) => m.resourceId), [rid("a-2"), rid("f-77")], "a module item resolves to its file");
    assert.deepEqual(port.references(rid("a-3")), [], "no text and no links: nothing linked");
    const exams = port.examDates("SYN201");
    assert.deepEqual(exams.map((e) => [e.title, e.kind, e.dateSource, e.at === null]), [
      ["Midterm 1", "midterm", "assignment", false],
      ["Final exam", "final", "calendar", false],
      ["Reading check", "quiz", "assignment", true],
    ]);
    assert.equal(examKind("Midterm 1 review"), null, "reviews and practice exams are not exams");
    assert.deepEqual(
      port.assessmentsFor(rid("p-hashing")).map((a) => [a.title, a.kind]).sort(),
      [["Homework 1", "assignment"], ["Midterm 1", "midterm"]],
    );
    assert.equal(port.assignment("nope"), null);
  } finally {
    done();
  }
});

test("analytics.assignment: topics behind the references, coverage, study next; honest when unlinked", async () => {
  const { rid, analytics, owner, done } = seed();
  try {
    const hw1 = await analytics({ op: "analytics.assignment", courseId: "SYN201", anchorIds: ["a1"], assignmentId: rid("a-1") });
    assert.equal(hw1.status, "ok", hw1.message);
    const data = hw1.data as AssignmentAnalyticsData;
    assert.equal(data.linkage, "linked");
    assert.deepEqual(data.topics.map((t) => [t.conceptId, t.stateLabel, t.practiceItems]), [["t1", "Not seen yet", 2], ["t2", "Not seen yet", 1]]);
    assert.deepEqual(data.topics[0]!.nextExam && [data.topics[0]!.nextExam.title, data.topics[0]!.nextExam.daysAway], ["Midterm 1", 5]);
    assert.deepEqual(data.coverage, { withEvidence: 0, of: 2, text: "0 of 2 topics practiced" });
    assert.deepEqual(data.distribution, { solid: 0, getting_there: 0, iffy: 0, not_seen: 2 });
    assert.equal(data.calibration.status, "not_enough");
    assert.ok(data.studyNext.length <= 3);
    assert.match(data.studyNext[0]!.reason, /Not practiced yet\. In scope for Midterm 1 in 5 days\./);
    noNumbersLeak(data);

    const hw3 = (await analytics({ op: "analytics.assignment", courseId: "SYN201", anchorIds: ["a1"], assignmentId: rid("a-3") })).data as AssignmentAnalyticsData;
    assert.equal(hw3.linkage, "no_materials");
    assert.equal(hw3.topics.length, 0);
    // A reference change reaches the next read: a new link from the assignment to the trees notes.
    const a3 = owner.resource(rid("a-3"))!;
    owner.putLink({ id: "l1", fromId: a3.id, toId: rid("f-77"), type: "supports", reason: "Named in class", status: "proposed", inputHash: a3.contentHash });
    const relinked = (await analytics({ op: "analytics.assignment", courseId: "SYN201", anchorIds: ["a1"], assignmentId: rid("a-3") })).data as AssignmentAnalyticsData;
    assert.equal(relinked.linkage, "linked");
    assert.deepEqual(relinked.topics.map((t) => t.conceptId), ["t3"]);
    assert.equal(relinked.materials[0]!.reason, "Link (supports): Named in class");

    assert.equal((await analytics({ op: "analytics.assignment", courseId: "SYN201", anchorIds: ["a1"], assignmentId: "unknown" })).status, "unavailable");
    assert.equal((await analytics({ op: "analytics.assignment", courseId: "SYN201", anchorIds: ["other"], assignmentId: rid("a-1") })).status, "unavailable");
    assert.equal((await analytics({ op: "analytics.assignment", courseId: "SYN201", assignmentId: rid("a-1") })).status, "failed", "anchors are required");
  } finally {
    done();
  }
});

test("practice rolls up: the answered topic is recomputed on commit, reads reuse the cache, and match a full recompute", async () => {
  const { store, ref, owner, call, analytics, done } = seed();
  try {
    const first = createAnalytics({ store, ref, courseId: "SYN201", references: createCurrentReferences(owner), now: at });
    first.course();
    assert.deepEqual(first.freshness().recomputed.sort(), ["m1", "m2", "t1", "t2", "t3", "t4"], "the first read computes every topic");

    const started = await call({ op: "practice.target", courseId: "SYN201", anchorIds: ["a1"], mode: "learn", topicIds: ["t1"], count: 5, operationId: "learn-1" });
    assert.equal(started.status, "ok", started.message);
    const round = started.data as PracticeRoundData;
    const item = round.session.currentItem!;
    const wrong = await call({ op: "study.answer", sessionId: round.session.id, revision: 0, operationId: "ans-1", itemId: item.id, itemVersion: item.version, response: { kind: "choice", optionId: "b" }, confidence: 1, responseMs: 3000 });
    assert.equal(wrong.status, "ok", wrong.message);
    const cached = store.conceptState(ref).find((r) => r.conceptId === "t1")!;
    assert.equal(cached.band, "iffy", "the commit refreshed the answered topic's cached state");

    const second = createAnalytics({ store, ref, courseId: "SYN201", references: createCurrentReferences(owner), now: at });
    const course = second.course();
    assert.deepEqual(second.freshness().recomputed, [], "nothing is recomputed on the next read");

    // The cached states equal the router's full recompute.
    const full = (await call({ op: "knowledge.state", courseId: "SYN201", anchorIds: ["a1"] })).data as KnowledgeStateData;
    const byModule = course.modules.map((m) => [m.label, m.distribution]);
    assert.deepEqual(byModule, [
      ["Module 1: Hashing", { solid: 0, getting_there: 0, iffy: 1, not_seen: 1 }],
      ["Module 2: Trees and graphs", { solid: 0, getting_there: 0, iffy: 0, not_seen: 2 }],
    ]);
    const cachedBands = new Map(store.conceptState(ref).map((r) => [r.conceptId, r.band]));
    assert.deepEqual(
      full.topics.map((t) => [t.conceptId, t.state]),
      full.topics.map((t) => [t.conceptId, cachedBands.get(t.conceptId)]),
    );
    assert.deepEqual(full.topics.map((t) => t.state), ["iffy", "not_seen", "not_seen", "not_seen"]);

    // Exams: the midterm's scope reaches t1-t3 along the chain; the final has no linked scope; the quiz has no date.
    assert.deepEqual(course.exams.map((e) => [e.title, e.daysAway, e.scope, e.topicIds]), [
      ["Midterm 1", 5, "linked", ["t1", "t2", "t3"]],
      ["Final exam", 30, "not_linked", []],
    ]);
    assert.deepEqual(course.exams[0]!.distribution, { solid: 0, getting_there: 0, iffy: 1, not_seen: 2 });
    assert.deepEqual(course.undatedExams.map((e) => e.title), ["Reading check"]);
    assert.deepEqual(course.coverage, { withEvidence: 1, of: 4, text: "1 of 4 topics practiced" });
    assert.deepEqual(course.evidence, { answers: 1, correct: 0, cardReviews: 0, selfRatings: 0, sessions: 1 });

    // Priority: the Iffy topic first; a topic outside every exam's scope ranks below those in scope.
    assert.equal(course.studyNext[0]!.conceptId, "t1");
    assert.match(course.studyNext[0]!.reason, /wrong/);
    assert.deepEqual(course.studyNext.map((r) => r.conceptId).sort(), ["t1", "t2", "t3"]);
    assert.equal(course.studyNext.length, 3);

    // Trend: the answered topic's first evidence.
    assert.deepEqual(course.trend.transitions.map((t) => [t.conceptId, t.from, t.to, t.direction]), [["t1", "not_seen", "iffy", "new"]]);
    assert.equal(course.trend.sessions, 1);
    noNumbersLeak(course);

    // The op returns the same shape.
    const op = await analytics({ op: "analytics.course", courseId: "SYN201", anchorIds: ["a1"], sessions: 3 });
    assert.equal(op.status, "ok", op.message);
    assert.deepEqual((op.data as CourseAnalyticsData).studyNext, course.studyNext);
  } finally {
    done();
  }
});

test("analytics.agendaHints: at most three 'study X before <exam>' hints, sized from the item counts", async () => {
  const { analytics, call, done } = seed();
  try {
    const started = await call({ op: "practice.target", courseId: "SYN201", anchorIds: ["a1"], mode: "learn", topicIds: ["t1"], count: 5, operationId: "learn-1" });
    const round = started.data as PracticeRoundData;
    const item = round.session.currentItem!;
    await call({ op: "study.answer", sessionId: round.session.id, revision: 0, operationId: "ans-1", itemId: item.id, itemVersion: item.version, response: { kind: "choice", optionId: "b" }, confidence: 1, responseMs: 3000 });
    const res = await analytics({ op: "analytics.agendaHints", courseId: "SYN201", anchorIds: ["a1"] });
    assert.equal(res.status, "ok", res.message);
    const { hints } = res.data as AgendaHintsData;
    assert.ok(hints.length <= 3);
    assert.deepEqual(hints.map((h) => h.conceptId).sort(), ["t1", "t2", "t3"], "only topics in an upcoming exam's scope");
    const t1 = hints[0]!;
    assert.equal(t1.conceptId, "t1");
    // An MC (0.75 min) and a typed item (2 min): 2.75 rounds up to 5.
    assert.deepEqual([t1.items, t1.minutes], [2, 5]);
    assert.equal(t1.text, "Study Chaining before Midterm 1 (in 5 days): about 5 min, 2 practice items.");
    noNumbersLeak(hints);
  } finally {
    done();
  }
});

test("analytics ops: not built without a references port; existing ops keep their answers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "magic-analytics-bare-"));
  const owner = createStore(join(dir, "workspace.sqlite"));
  try {
    const router = createLearningRouter({ store: owner.learning, resolveContext: () => null });
    const signal = new AbortController().signal;
    const res = await router.analytics({ op: "analytics.course", courseId: "SYN201", anchorIds: ["a1"] }, signal);
    assert.equal(res.status, "not_built");
    assert.equal((await router.analytics({ op: "nope" }, signal)).status, "failed");
    assert.equal((await router.handle({ op: "practice.path", courseId: "SYN201" }, signal)).status, "not_built");
  } finally {
    owner.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a flashcard review refreshes its topic's cached state on commit", async () => {
  const { store, ref, call, done } = seed();
  try {
    const started = await call({ op: "practice.target", courseId: "SYN201", anchorIds: ["a1"], mode: "flashcards", topicIds: ["t1"], count: 5, operationId: "cards-1" });
    assert.equal(started.status, "ok", started.message);
    const fc = (started.data as { flashcards: { id: string; current?: { cardId: string } } }).flashcards;
    const rated = await call({ op: "study.review", sessionId: fc.id, revision: 0, operationId: "rate-1", cardId: fc.current!.cardId, rating: 3, reviewMs: 1200 });
    assert.equal(rated.status, "ok", rated.message);
    const row = store.conceptState(ref).find((r) => r.conceptId === "t1")!;
    assert.equal((row.counts as { cardReviews: number }).cardReviews, 1);
    assert.equal(row.band, "getting_there");
  } finally {
    done();
  }
});

test("references adapter: with module IDs on module items, an assignment reaches its module's materials; without them, nothing is guessed", () => {
  const { owner, rid, done } = seed();
  try {
    // Today's capture has no moduleItem.moduleId: the module step is skipped.
    assert.deepEqual(createCurrentReferences(owner).references(rid("a-3")), []);
    // Once the connector records it (feat/course-page), the same data links through the module.
    const withModules = {
      resources: () =>
        owner.resources().map((r) => {
          if (r.externalId !== "mi-9" && r.externalId !== "mi-30") return r;
          const moduleItem = { ...r.moduleItem!, moduleId: "7" };
          return { ...r, moduleItem };
        }),
    };
    const port = createCurrentReferences(withModules);
    assert.deepEqual(port.references(rid("a-3")).map((m) => [m.resourceId, m.reason]), [[rid("f-77"), "In the same module: Week 7."]]);
    assert.deepEqual(port.assessmentsFor(rid("f-77")).map((a) => a.title).sort(), ["Homework 2", "Midterm 1", "Participation"]);
  } finally {
    done();
  }
});

test("the analytics ops also run through handle() with the contracts' learning request schema", async () => {
  const { call, done } = seed();
  try {
    const res = await call({ op: "analytics.course", courseId: "SYN201", anchorIds: ["a1"] });
    assert.equal(res.status, "ok", res.message);
    assert.equal(res.op, "analytics.course");
    assert.ok((res.data as CourseAnalyticsData).modules.length > 0);
    const hints = await call({ op: "analytics.agendaHints", courseId: "SYN201", anchorIds: ["a1"] });
    assert.equal(hints.status, "ok", hints.message);
    const bad = await call({ op: "analytics.assignment", courseId: "SYN201", anchorIds: [], assignmentId: "x" } as unknown as LearningRequest);
    assert.equal(bad.status, "failed", "anchors are required by the schema");
  } finally {
    done();
  }
});
