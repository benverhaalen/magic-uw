// owner: study-backend. The course practice ops over a synthetic checked pool in the SQL learning store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../packages/storage/src/index";
import {
  createLearningRouter,
  type StudyContext,
} from "../packages/learning/src/router";
import { runPipeline, type CandidateItem } from "../packages/learning/src/items";
import type { Concept } from "../packages/learning/src/store";
import {
  EMPTY_POOL_MESSAGE,
  type FlashcardData,
  type KnowledgeStateData,
  type PracticePathData,
  type PracticeResultsData,
  type PracticeRoundData,
} from "../packages/learning/src/router-types";
import type { LearningRequest, LearningResult } from "@magic/contracts";

const at = new Date("2026-09-26T15:00:00.000Z");
const TEXT =
  "Chaining stores colliding keys in a linked list at each bucket. " +
  "Open addressing probes for the next free slot. " +
  "A binary search tree keeps smaller keys on the left.";
const sentence = (n: number) => TEXT.split(". ").map((s, i, a) => (i < a.length - 1 ? `${s}.` : s))[n]!;

function concept(id: string, label: string, kind: Concept["kind"], parentId: string | null, position: number, ref: string): Concept {
  return { id, courseRef: ref, parentId, label, kind, position, origin: "code", status: "active", mergedInto: null, studentLabel: null, mapVersion: "m1", sources: [] };
}

function open(path: string) {
  const owner = createStore(path);
  return { owner, store: owner.learning };
}

function seed(path: string, { items = true } = {}) {
  const { owner, store } = open(path);
  owner.ingest({
    source: { id: "syn-source", kind: "canvas", accountScope: "acct", courseId: "SYN101", scope: "materials", label: "Synthetic" },
    observedAt: at.toISOString(),
    complete: true,
    status: "ok",
    resources: [
      {
        externalId: "lecture", kind: "material", courseId: "SYN101", courseName: "Synthetic data structures",
        title: "Hashing and trees", url: "https://canvas.example.test/lecture", text: TEXT, deadlines: [],
        policy: { mode: "coaching", evidence: "Synthetic policy" },
      },
    ],
  });
  const resource = owner.resources()[0]!;
  const ref = store.course("acct", "SYN101").id;
  store.putConceptMap(ref, [
    concept("m1", "Module 1: Hashing", "unit", null, 0, ref),
    concept("m2", "Module 2: Trees", "unit", null, 1, ref),
    concept("t1", "Chaining", "concept", "m1", 0, ref),
    concept("t2", "Open addressing", "concept", "m1", 1, ref),
    concept("t3", "Binary search trees", "concept", "m2", 0, ref),
  ], "m1");
  if (items) {
    const base = (id: string, familyId: string, conceptId: string, quote: string) => ({
      id, version: 1, courseRef: ref, familyId, keyIdeas: [], explanation: null, tempting: {},
      bloom: "understand" as const, tier: "T4" as const, sourceTerm: null, origin: "generated" as const, generator: null,
      sources: [{ resourceId: resource.id, quote }], tags: [{ conceptId, primary: true }],
    });
    const mc = (id: string, familyId: string, conceptId: string, quote: string, stem: string, options: string[]): CandidateItem => ({
      ...base(id, familyId, conceptId, quote), kind: "mc", stem,
      options: options.map((text, i) => ({ id: "abc"[i]!, text })), key: "a",
    });
    const candidates: CandidateItem[] = [
      mc("i-t1-mc", "f1", "t1", sentence(0), "Which structure stores colliding keys when using chaining?", ["Linked list", "Sorted array", "Search tree"]),
      {
        ...base("i-t1-typed", "f1", "t1", sentence(0)), kind: "typed",
        stem: "Name the structure used to store colliding keys in chaining.", options: null, key: "linked list",
        keyIdeas: [{ idea: "linked list", synonyms: [], required: true }],
      },
      mc("i-t2-mc", "f2", "t2", sentence(1), "What does open addressing probe for after a collision?", ["The next free slot", "The first full slot", "The hash seed slot"]),
      mc("i-t3-mc", "f3", "t3", sentence(2), "Where does a binary search tree keep smaller keys?", ["On the left", "On the right", "At the root"]),
      {
        ...base("i-t3-card", "f4", "t3", sentence(2)), kind: "card",
        stem: "Binary search tree: where do smaller keys go?", options: null, key: "To the left",
      },
    ];
    const seen: string[] = [];
    for (const c of candidates) {
      const checked = runPipeline(c, {
        courseRestricted: false,
        resources: [{ id: resource.id, contentHash: resource.contentHash, text: TEXT, kind: "material" }],
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
  }
  const context = (anchor: string, courseId = "SYN101"): StudyContext => ({
    resourceId: anchor, accountScope: "acct", courseId, inputHash: `input-${anchor}`, contextHash: `context-${anchor}`,
    label: "Synthetic data structures", availability: "current", reason: "Ready",
    resources: [{ id: resource.id, contentHash: resource.contentHash, text: TEXT, title: "Hashing and trees", url: "https://canvas.example.test/lecture", observedAt: at.toISOString(), eligible: true }],
  });
  return { owner, store, ref, context };
}

function routerFor(store: ReturnType<typeof open>["store"], context: (anchor: string, courseId?: string) => StudyContext) {
  const router = createLearningRouter({
    store,
    resolveContext: (id) => (id === "a1" || id === "a2" ? context(id) : id === "other-course" ? context(id, "OTHER") : null),
    now: () => at,
  });
  return (request: LearningRequest): Promise<LearningResult> => router.handle(request, new AbortController().signal);
}

const anchors = ["a1", "a2"];
function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "magic-practice-ops-"));
  return { dir, path: join(dir, "workspace.sqlite") };
}

test("course practice: an empty pool is honestly unavailable and starts nothing; ops without anchors keep their answer", async () => {
  const { dir, path } = tmp();
  const { owner, store, ref, context } = seed(path, { items: false });
  try {
    const call = routerFor(store, context);
    const home = await call({ op: "practice.path", courseId: "SYN101", anchorIds: anchors });
    assert.equal(home.status, "unavailable");
    assert.equal(home.message, EMPTY_POOL_MESSAGE);
    const data = home.data as PracticePathData;
    assert.equal(data.ready, false);
    assert.deepEqual(data.modules.map((m) => m.label), ["Module 1: Hashing", "Module 2: Trees"]);
    for (const mode of ["flashcards", "learn", "test"] as const) {
      const started = await call({ op: "practice.target", courseId: "SYN101", anchorIds: anchors, mode, count: 10, operationId: `empty-${mode}` });
      assert.equal(started.status, "unavailable");
      assert.equal(started.message, EMPTY_POOL_MESSAGE);
    }
    assert.equal(store.sessions(ref).length, 0);
    assert.equal((await call({ op: "practice.path", courseId: "SYN101" })).status, "not_built");
    assert.equal((await call({ op: "knowledge.state", courseId: "SYN101" })).status, "not_built");
    assert.equal((await call({ op: "study.review", cardId: "c", rating: 3, reviewMs: 1 })).status, "unavailable");
  } finally {
    owner.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("course practice: the scope is authorized per anchor and never crosses courses", async () => {
  const { dir, path } = tmp();
  const { owner, store, context } = seed(path);
  try {
    const call = routerFor(store, context);
    assert.equal((await call({ op: "practice.path", courseId: "SYN101", anchorIds: ["a1", "other-course"] })).status, "unavailable");
    assert.equal((await call({ op: "practice.path", courseId: "SYN101", anchorIds: ["unknown"] })).status, "unavailable");
    assert.equal((await call({ op: "practice.path", courseId: "OTHER", anchorIds: ["a1"] })).message, "Course context does not match.");
    const bad = await call({ op: "practice.target", courseId: "SYN101", anchorIds: anchors, mode: "learn", count: 5, topicIds: ["nope"], operationId: "x" });
    assert.equal(bad.message, "Those topics aren't in this course's map.");
    const write = await call({ op: "practice.target", courseId: "SYN101", anchorIds: anchors, mode: "write", count: 5, operationId: "w" });
    assert.equal(write.status, "not_built");
  } finally {
    owner.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("course practice: path, topic states, module list and due count, with no percentages", async () => {
  const { dir, path } = tmp();
  const { owner, store, context } = seed(path);
  try {
    const call = routerFor(store, context);
    const home = await call({ op: "practice.path", courseId: "SYN101", anchorIds: anchors });
    assert.equal(home.status, "ok");
    const data = home.data as PracticePathData;
    assert.equal(data.ready, true);
    assert.equal(data.questions, 4);
    // Card-capable: the card and the typed recall item.
    assert.deepEqual(data.cards, { total: 2, dueToday: 2 });
    assert.deepEqual(data.modules.map((m) => [m.moduleId, m.topicIds, m.questions]), [["m1", ["t1", "t2"], 3], ["m2", ["t3"], 1]]);
    assert.deepEqual(data.topics.map((t) => [t.conceptId, t.stateLabel, t.moduleLabel]), [
      ["t1", "Not seen yet", "Module 1: Hashing"],
      ["t2", "Not seen yet", "Module 1: Hashing"],
      ["t3", "Not seen yet", "Module 2: Trees"],
    ]);
    assert.deepEqual(data.mastered, { count: 0, of: 3 });
    const serialized = JSON.stringify(home);
    for (const hidden of ["theta", "pHat", "pLow", "\"acc\"", "%"]) assert.equal(serialized.includes(hidden), false, hidden);
    const chosen = await call({ op: "knowledge.state", courseId: "SYN101", anchorIds: anchors, moduleIds: ["m2"] });
    assert.deepEqual((chosen.data as KnowledgeStateData).topics.map((t) => t.conceptId), ["t3"]);
  } finally {
    owner.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("flashcards: due cards, FSRS rating, idempotent retry, stale revision, undo, and a reopen from disk", async () => {
  const { dir, path } = tmp();
  const seeded = seed(path);
  let owner = seeded.owner;
  try {
    let call = routerFor(seeded.store, seeded.context);
    const started = await call({ op: "practice.target", courseId: "SYN101", anchorIds: anchors, mode: "flashcards", count: 10, operationId: "cards-1" });
    assert.equal(started.status, "ok", started.message);
    let fc = (started.data as FlashcardData).flashcards;
    assert.equal(fc.remaining, 2);
    assert.equal(fc.dueToday, 2);
    assert.ok(fc.current && fc.current.isNew && fc.current.topics.length === 1);
    assert.ok(fc.current.citations[0]!.quote.length > 0);
    const first = fc.current;
    const rate = { op: "study.review", sessionId: fc.id, revision: 0, operationId: "rate-1", cardId: first.cardId, rating: 3, reviewMs: 2400 } as const;
    const rated = await call(rate);
    assert.equal(rated.status, "ok", rated.message);
    fc = (rated.data as FlashcardData).flashcards;
    assert.equal(fc.remaining, 1);
    assert.equal(fc.revision, 1);
    // FSRS: Good on a new card enters a short learning step, so it is still due later today.
    const scheduled = seeded.store.cards({ courseRef: seeded.ref }).find((k) => k.id === first.cardId)!;
    assert.ok(scheduled.fsrs.due > at.toISOString() && scheduled.fsrs.reps === 1);
    assert.equal(fc.dueToday, 2);
    const retry = await call(rate);
    assert.equal(retry.status, "ok");
    assert.equal(seeded.store.evidence(seeded.ref).reviews.length, 1, "a retried rating writes one review");
    assert.equal((await call({ ...rate, operationId: "rate-2" })).status, "unavailable", "a stale revision cannot rate");
    assert.equal((await call({ ...rate, rating: 1 })).status, "failed", "a reused operation ID with another request");
    const reviewId = fc.reviewed[0]!.reviewId;
    const undone = await call({ op: "study.undoReview", reviewId, sessionId: fc.id, revision: 1, operationId: "undo-1" });
    assert.equal(undone.status, "ok", undone.message);
    fc = (undone.data as FlashcardData).flashcards;
    assert.equal(fc.current?.cardId, first.cardId, "the undone card comes back first");
    assert.equal(fc.reviewed[0]!.undone, true);
    assert.equal(seeded.store.evidence(seeded.ref).reviews.length, 2, "undo appends; nothing is deleted");
    const card = seeded.store.cards({ courseRef: seeded.ref }).find((k) => k.id === first.cardId)!;
    assert.equal(card.fsrs.reps, 0);
    assert.equal(card.itemVersion, 1);

    owner.close();
    const reopened = open(path);
    owner = reopened.owner;
    call = routerFor(reopened.store, seeded.context);
    const resumed = await call({ op: "study.session", sessionId: fc.id });
    assert.equal(resumed.status, "ok", resumed.message);
    const after = (resumed.data as FlashcardData).flashcards;
    assert.equal(after.revision, 2);
    assert.equal(after.remaining, 2);
    assert.equal(after.reviewed.length, 1);
    const again = await call({ op: "study.review", sessionId: fc.id, revision: 2, operationId: "rate-3", cardId: after.current!.cardId, rating: 1, reviewMs: 900 });
    assert.equal(again.status, "ok", again.message);
    assert.equal(reopened.store.evidence(seeded.ref).reviews.length, 3);
    const home = await call({ op: "practice.path", courseId: "SYN101", anchorIds: anchors });
    assert.deepEqual((home.data as PracticePathData).openSessions.map((s) => s.mode), ["flashcards"]);
  } finally {
    owner.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quiz me on: a Learn round stays within the chosen topics, and a retried answer stores one attempt", async () => {
  const { dir, path } = tmp();
  const { owner, store, ref, context } = seed(path);
  try {
    const call = routerFor(store, context);
    const started = await call({ op: "practice.target", courseId: "SYN101", anchorIds: anchors, mode: "learn", topicIds: ["t1"], count: 5, operationId: "learn-1" });
    assert.equal(started.status, "ok", started.message);
    let round = started.data as PracticeRoundData;
    assert.equal(round.practice.mode, "learn");
    assert.deepEqual(round.practice.topicIds, ["t1"]);
    assert.equal(round.session.goal, "Learn round: Chaining");
    const retryStart = await call({ op: "practice.target", courseId: "SYN101", anchorIds: anchors, mode: "learn", topicIds: ["t1"], count: 5, operationId: "learn-1" });
    assert.equal((retryStart.data as PracticeRoundData).session.id, round.session.id, "a retried start returns the same session");
    const item = round.session.currentItem!;
    assert.equal(item.id, "i-t1-mc");
    assert.deepEqual(round.practice.topicsByItem[`${item.id}@${item.version}`], [{ conceptId: "t1", label: "Chaining", primary: true }]);
    const answer = { op: "study.answer", sessionId: round.session.id, revision: 0, operationId: "ans-1", itemId: item.id, itemVersion: item.version, response: { kind: "choice", optionId: "a" }, confidence: 1, responseMs: 3000 } as const;
    const answered = await call(answer);
    assert.equal(answered.status, "ok", answered.message);
    await call(answer);
    assert.equal(store.evidence(ref).attempts.length, 1, "retry does not duplicate the attempt");
    round = answered.data as PracticeRoundData;
    assert.ok(round.practice, "saved-session ops keep the practice meta on course sessions");
    assert.equal(round.session.events.at(-1)?.outcome, "correct");
    assert.ok(round.session.currentItem!.citations[0]!.quote.startsWith("Chaining"), "feedback can quote the source passage");
    const next = await call({ op: "study.advance", sessionId: round.session.id, revision: 1, operationId: "adv-1", action: "next" });
    round = next.data as PracticeRoundData;
    assert.equal(round.session.currentItem?.id, "i-t1-typed", "recall follows recognition in Learn");
    const typed = await call({ op: "study.answer", sessionId: round.session.id, revision: 2, operationId: "ans-2", itemId: "i-t1-typed", itemVersion: 1, response: { kind: "text", text: "a linked list" }, confidence: 0.67, responseMs: 5000 });
    assert.equal((typed.data as PracticeRoundData).session.events.at(-1)?.outcome, "correct");
    const done = await call({ op: "study.advance", sessionId: round.session.id, revision: 3, operationId: "adv-2", action: "next" });
    assert.equal((done.data as PracticeRoundData).session.status, "complete");
    const results = await call({ op: "study.submit", sessionId: round.session.id });
    assert.equal(results.status, "ok", results.message);
    const r = (results.data as PracticeResultsData).results;
    assert.equal(r.complete, true);
    assert.deepEqual([r.answered, r.correct], [2, 2]);
    assert.deepEqual(r.topics.map((t) => [t.conceptId, t.before]), [["t1", "not_seen"]]);
    for (const a of store.evidence(ref).attempts) assert.equal(a.primaryConceptId, "t1");
    const listed = await call({ op: "study.sessions", resourceId: "a1" });
    assert.equal((listed.data as { sessions: unknown[] }).sessions.length, 0, "course sessions stay out of the assignment panel's list");
  } finally {
    owner.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a quiz sectioned by module: sections in module order, each question once, results with study-next", async () => {
  const { dir, path } = tmp();
  const { owner, store, ref, context } = seed(path);
  try {
    const call = routerFor(store, context);
    const started = await call({ op: "practice.target", courseId: "SYN101", anchorIds: anchors, mode: "test", moduleIds: ["m1", "m2"], count: 3, operationId: "quiz-1" });
    assert.equal(started.status, "ok", started.message);
    let round = started.data as PracticeRoundData;
    assert.deepEqual(round.practice.sections.map((s) => [s.moduleId, s.label]), [["m1", "Module 1: Hashing"], ["m2", "Module 2: Trees"]]);
    assert.equal(round.session.goal, "Quiz: Module 1: Hashing, Module 2: Trees");
    const served: string[] = [];
    let revision = 0;
    for (let n = 0; n < 6 && round.session.currentItem; n++) {
      const item = round.session.currentItem;
      served.push(item.id);
      assert.ok(round.practice.topicsByItem[`${item.id}@${item.version}`]?.length, "every question has topic chips");
      const wrong = item.id === "i-t1-mc";
      const a = await call({ op: "study.answer", sessionId: round.session.id, revision, operationId: `q-${n}`, itemId: item.id, itemVersion: item.version, response: { kind: "choice", optionId: wrong ? "b" : "a" }, confidence: wrong ? 1 : 0.67, responseMs: 1000 });
      assert.equal(a.status, "ok", a.message);
      const adv = await call({ op: "study.advance", sessionId: round.session.id, revision: revision + 1, operationId: `qa-${n}`, action: "next" });
      revision += 2;
      round = adv.data as PracticeRoundData;
    }
    assert.deepEqual(served, ["i-t1-mc", "i-t2-mc", "i-t3-mc"], "module order, each question once, no return after a miss");
    assert.ok(store.evidence(ref).attempts.every((a) => a.mode === "test"));
    const r = ((await call({ op: "study.submit", sessionId: round.session.id })).data as PracticeResultsData).results;
    assert.equal(r.mode, "test");
    assert.deepEqual([r.answered, r.correct], [3, 2]);
    assert.equal(r.studyNext[0]?.conceptId, "t1", "the missed topic is studied next");
    assert.ok(r.topics.every((t) => ["up", "down", "same", "new"].includes(t.direction)));
    assert.equal(JSON.stringify(r).includes("%"), false);
  } finally {
    owner.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("course practice reaches no runner, pack or provider", async () => {
  const source = readFileSync(join(import.meta.dirname, "../packages/learning/src/router.ts"), "utf8");
  for (const forbidden of ["@magic/runner", "@magic/packs", "@magic/ai", "runner/src", "packs/src", "ai/src", "fetch("])
    assert.equal(source.includes(forbidden), false, forbidden);
  const { dir, path } = tmp();
  const { owner, store, context } = seed(path);
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    throw new Error("no network in practice");
  }) as typeof fetch;
  try {
    const call = routerFor(store, context);
    await call({ op: "practice.path", courseId: "SYN101", anchorIds: anchors });
    const fc = ((await call({ op: "practice.target", courseId: "SYN101", anchorIds: anchors, mode: "flashcards", count: 5, operationId: "n1" })).data as FlashcardData).flashcards;
    await call({ op: "study.review", sessionId: fc.id, revision: 0, operationId: "n2", cardId: fc.current!.cardId, rating: 4, reviewMs: 10 });
    const q = (await call({ op: "practice.target", courseId: "SYN101", anchorIds: anchors, mode: "test", count: 5, operationId: "n3" })).data as PracticeRoundData;
    await call({ op: "study.submit", sessionId: q.session.id });
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = realFetch;
    owner.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
