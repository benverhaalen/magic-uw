import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createLearningRouter,
  eligibleStudySource,
  type StudyContext,
} from "../packages/learning/src/router";
import { createMemoryLearningStore } from "../packages/learning/src/memory-store";
import {
  runPipeline,
  type CandidateItem,
} from "../packages/learning/src/items";
import type { Concept } from "../packages/learning/src/store";
import type {
  LearningRequest,
  LearningResult,
  StudySessionView,
  Resource,
} from "@magic/contracts";
const at = new Date("2026-09-26T12:00:00.000Z"),
  ref = "acct:SYN101";
function setup(kind: "typed" | "mc" = "typed") {
  const store = createMemoryLearningStore(() => at.toISOString());
  store.course("acct", "SYN101");
  const text =
    "Chaining stores colliding keys in a linked list at each bucket.";
  const concept: Concept = {
    id: "concept",
    courseRef: ref,
    parentId: null,
    label: "Hash collisions",
    kind: "concept",
    position: 0,
    origin: "code",
    status: "active",
    mergedInto: null,
    studentLabel: null,
    mapVersion: "m1",
    sources: [],
  };
  store.putConceptMap(ref, [concept], "m1");
  const context: StudyContext = {
    resourceId: "assignment",
    accountScope: "acct",
    courseId: "SYN101",
    inputHash: "target-v1",
    contextHash: "context-v1",
    availability: "current",
    reason: "Ready",
    resources: [
      {
        id: "lecture",
        contentHash: "source-v1",
        text,
        title: "Lecture",
        url: "https://example.edu/course",
        observedAt: at.toISOString(),
        eligible: true,
      },
    ],
  };
  const candidate: CandidateItem = {
    id: "item",
    version: 1,
    courseRef: ref,
    familyId: "family",
    kind,
    stem:
      kind === "mc"
        ? "Which structure stores colliding keys when using chaining?"
        : "Name the structure used to store colliding keys in chaining.",
    options:
      kind === "mc"
        ? [
            { id: "a", text: "Linked list" },
            { id: "b", text: "Sorted array" },
            { id: "c", text: "Search tree" },
          ]
        : null,
    key: kind === "mc" ? "a" : "linked list",
    keyIdeas: [{ idea: "linked list", synonyms: [], required: true }],
    explanation: {
      text: "Chaining stores colliding keys in a linked list.",
      citation: { resourceId: "lecture", quote: text },
    },
    tempting: {},
    bloom: "understand",
    tier: "T4",
    sourceTerm: null,
    origin: "generated",
    generator: null,
    sources: [{ resourceId: "lecture", quote: text }],
    tags: [{ conceptId: "concept", primary: true }],
  };
  const prepared = runPipeline(candidate, {
    courseRestricted: false,
    resources: [
      { id: "lecture", contentHash: "source-v1", text, kind: "material" },
    ],
    validate: (source, quote) => {
      const start = source.indexOf(quote);
      return start < 0
        ? { status: "missing" }
        : { status: "unique", start, end: start + quote.length };
    },
    map: [concept],
    seenStems: [],
    now: at,
  });
  assert.equal(prepared.accepted, true, prepared.dropped?.reason);
  store.putItem(
    prepared.item!,
    prepared.sources,
    prepared.tags,
    prepared.checks,
  );
  let available = true;
  const router = createLearningRouter({
    store,
    resolveContext: (id) => (available && id === "assignment" ? context : null),
    now: () => at,
  });
  const call = (
    request: LearningRequest,
    signal = new AbortController().signal,
  ) => router.handle(request, signal);
  const start = () =>
    call({
      op: "study.plan",
      resourceId: "assignment",
      inputHash: "target-v1",
      operationId: "start",
      minutes: 15,
      difficulty: "normal",
    });
  return {
    store,
    context,
    call,
    start,
    unavailable: () => {
      available = false;
    },
  };
}
function view(result: LearningResult): StudySessionView {
  assert.equal(result.status, "ok", result.message);
  return (result.data as { session: StudySessionView }).session;
}
function answer(
  s: StudySessionView,
  operationId = "answer",
  text = "linked list",
): LearningRequest {
  return {
    op: "study.answer",
    sessionId: s.id,
    revision: s.revision,
    operationId,
    itemId: s.currentItem!.id,
    itemVersion: s.currentItem!.version,
    response: { kind: "text", text },
    confidence: null,
    responseMs: 2000,
  };
}

test("canonical prepared round starts, persists draft, resumes, scores, advances and completes without exposing keys", async () => {
  const x = setup(),
    s = view(await x.start());
  assert.equal(s.currentItem?.kind, "typed");
  assert.equal("key" in s.currentItem!, false);
  assert.equal(s.currentItem?.citations[0]?.contentHash, "source-v1");
  const drafted = view(
    await x.call({
      op: "study.draft",
      sessionId: s.id,
      revision: 0,
      operationId: "draft",
      draft: "linked",
    }),
  );
  assert.equal(drafted.draft, "linked");
  assert.equal(
    view(await x.call({ op: "study.resume", sessionId: s.id })).draft,
    "linked",
  );
  const answered = view(await x.call(answer(drafted)));
  assert.equal(answered.events[0]?.outcome, "correct");
  assert.equal(answered.answered, true);
  assert.equal(x.store.evidence(ref).attempts.length, 1);
  const ended = view(
    await x.call({
      op: "study.advance",
      sessionId: s.id,
      revision: answered.revision,
      operationId: "next",
      action: "next",
    }),
  );
  assert.equal(ended.status, "complete");
  assert.equal(ended.currentItem, undefined);
});

test("operation retries are idempotent; conflicting revisions and reused operation bodies do not create attempts", async () => {
  const x = setup(),
    s = view(await x.start());
  assert.equal(view(await x.start()).id, s.id);
  const request = answer(s, "__proto__");
  const first = view(await x.call(request)),
    again = view(await x.call(request));
  assert.equal(again.revision, first.revision);
  assert.equal(x.store.evidence(ref).attempts.length, 1);
  assert.equal((await x.call(answer(s, "another"))).status, "unavailable");
  assert.equal((await x.call(answer(s, "__proto__", "other"))).status, "failed");
  assert.equal(x.store.evidence(ref).attempts.length, 1);
});

test("undecided typed answers remain unscored history and may deliberately repeat", async () => {
  const x = setup(),
    s = view(await x.start()),
    a = view(await x.call(answer(s, "a", "a chain of nodes")));
  assert.equal(a.events[0]?.outcome, "undecided");
  assert.equal(a.events[0]?.score, null);
  assert.equal(x.store.evidence(ref).attempts.length, 0);
  const again = view(
    await x.call({
      op: "study.advance",
      sessionId: s.id,
      revision: a.revision,
      operationId: "next",
      action: "next",
    }),
  );
  assert.equal(again.currentItem?.id, s.currentItem?.id);
  const corrected = view(await x.call(answer(again, "corrected")));
  assert.equal(corrected.events.length, 2);
  assert.equal(x.store.evidence(ref).attempts[0]?.seenBefore, true);
});

test("a wrong recognition answer repeats and is stored honestly; explanation marks assisted evidence", async () => {
  const x = setup("mc"),
    s = view(await x.start());
  const hint = view(
    await x.call({
      op: "study.hint",
      sessionId: s.id,
      revision: s.revision,
      operationId: "hint",
      itemId: "item",
      level: "hint",
    }),
  );
  assert.equal(hint.events[0]?.kind, "explain");
  const a = view(
    await x.call({
      op: "study.answer",
      sessionId: s.id,
      revision: hint.revision,
      operationId: "wrong",
      itemId: "item",
      itemVersion: 1,
      response: { kind: "choice", optionId: "b" },
      confidence: 1,
      responseMs: 10,
    }),
  );
  assert.equal(a.events[1]?.outcome, "incorrect");
  assert.equal(x.store.evidence(ref).attempts[0]?.assistance, "explained");
  const again = view(
    await x.call({
      op: "study.advance",
      sessionId: s.id,
      revision: a.revision,
      operationId: "again",
      action: "next",
    }),
  );
  assert.equal(again.currentItem?.id, "item");
});

test("changed source hash, changed exact quote or source eligibility blocks practice; draft can be recovered", async () => {
  for (const change of [
    (c: StudyContext) => {
      c.resources[0]!.contentHash = "v2";
    },
    (c: StudyContext) => {
      c.resources[0]!.text = "Changed";
    },
    (c: StudyContext) => {
      c.resources[0]!.eligible = false;
    },
    (c: StudyContext) => {
      c.contextHash = "policy-v2";
    },
  ]) {
    const x = setup(),
      s = view(await x.start());
    change(x.context);
    const stale = view(await x.call({ op: "study.session", sessionId: s.id }));
    assert.equal(stale.availability, "stale");
    assert.equal(stale.currentItem, undefined);
    assert.equal((await x.call(answer(s))).status, "unavailable");
    assert.equal(
      view(
        await x.call({
          op: "study.draft",
          sessionId: s.id,
          revision: s.revision,
          operationId: "save",
          draft: "saved",
        }),
      ).draft,
      "saved",
    );
    assert.equal(x.store.evidence(ref).attempts.length, 0);
  }
});

test("account change, policy restriction, missing context and cancellation cannot grade", async () => {
  for (const mode of ["account", "blocked", "absent", "cancelled"]) {
    const x = setup(),
      s = view(await x.start());
    const signal = new AbortController();
    if (mode === "account") x.context.accountScope = "other";
    if (mode === "blocked") x.context.availability = "blocked";
    if (mode === "absent") x.unavailable();
    if (mode === "cancelled") signal.abort();
    assert.equal(
      (await x.call(answer(s), signal.signal)).status,
      "unavailable",
    );
    assert.equal(x.store.evidence(ref).attempts.length, 0);
  }
});

test("unchecked and stale items never become a fabricated pool; no-op router stays honest", async () => {
  const x = setup();
  x.store.setItemStatus("item", 1, "quarantined", "failed check");
  assert.equal((await x.start()).status, "unavailable");
  assert.equal(x.store.sessions(ref).length, 0);
  assert.equal(
    (
      await createLearningRouter().handle(
        { op: "study.plan", minutes: 15, difficulty: "normal" },
        new AbortController().signal,
      )
    ).status,
    "not_built",
  );
  assert.equal(
    (
      await x.call({
        op: "notebook.ask",
        courseId: "SYN101",
        question: "Explain",
      })
    ).status,
    "not_built",
  );
});

test("IP-2 eligibility ignores submitted state and treats missing/invalid lock dates as open", () => {
  const base = {
    kind: "assignment",
    deadlines: [],
    submission: { submitted: true },
  } as unknown as Resource;
  assert.equal(eligibleStudySource(base, at.getTime()), false);
  const claim = {
    kind: "lock",
    value: "2026-09-25T00:00:00Z",
    scopeConfirmed: true,
  } as Resource["deadlines"][number];
  assert.equal(
    eligibleStudySource({ ...base, deadlines: [claim] }, at.getTime()),
    true,
  );
  assert.equal(
    eligibleStudySource(
      { ...base, deadlines: [{ ...claim, value: "not a date" }] },
      at.getTime(),
    ),
    false,
  );
  assert.equal(
    eligibleStudySource(
      { ...base, deadlines: [{ ...claim, scopeConfirmed: false }] },
      at.getTime(),
    ),
    false,
  );
  assert.equal(
    eligibleStudySource({ ...base, kind: "material" }, at.getTime()),
    true,
  );
});

test("a newer quarantined item version cannot fall back to the old active question", async () => {
  const x = setup(),
    s = view(await x.start()),
    old = x.store.items()[0]!;
  x.store.putItem(
    {
      ...old.item,
      version: 2,
      status: "quarantined",
      statusReason: "new validation failed",
    },
    old.sources,
    old.tags,
    old.checks,
  );
  assert.equal(
    view(await x.call({ op: "study.session", sessionId: s.id })).availability,
    "stale",
  );
  assert.equal((await x.call(answer(s))).status, "unavailable");
  assert.equal(
    (
      await x.call({
        op: "study.plan",
        resourceId: "assignment",
        operationId: "fresh",
        minutes: 15,
        difficulty: "normal",
      })
    ).status,
    "unavailable",
  );
});

test("source-version disclosure survives stale captures; failed CAS does not save an answer", async () => {
  const x = setup(),
    s = view(await x.start());
  const originalCommit = x.store.commitSession;
  x.store.commitSession = () => false;
  assert.equal((await x.call(answer(s))).status, "unavailable");
  assert.equal(x.store.evidence(ref).attempts.length, 0);
  assert.equal(
    view(await x.call({ op: "study.session", sessionId: s.id })).revision,
    0,
  );
  x.store.commitSession = originalCommit;
  x.context.resources[0]!.contentHash = "new";
  const stale = view(await x.call({ op: "study.session", sessionId: s.id }));
  assert.equal(stale.sources[0]?.contentHash, "source-v1");
  assert.equal(stale.availability, "stale");
});
