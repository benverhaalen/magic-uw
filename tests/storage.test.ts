import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStore } from "@magic/storage";
import {
  defaultPrivacy,
  type CaptureBatch,
  type ResourceInput,
  type Store,
  type Judgment,
  type Attempt,
} from "@magic/contracts";

const t = (seconds: number) =>
  new Date(Date.UTC(2099, 0, 1, 0, 0, seconds)).toISOString();
const item = (
  externalId = "a1",
  extra: Partial<ResourceInput> = {},
): ResourceInput => ({
  externalId,
  kind: "assignment",
  courseId: "course-1",
  courseName: "Example Biology",
  title: "Cells and membranes",
  url: `https://canvas.example.test/assignments/${externalId}`,
  text: "Compare transport across cell membranes.",
  deadlines: [],
  points: 10,
  submitted: false,
  policy: {
    mode: "coaching",
    evidence: "Hints and explanations are permitted.",
  },
  ...extra,
});
const batch = (
  seconds: number,
  resources = [item()],
  extra: Partial<CaptureBatch> = {},
): CaptureBatch => ({
  source: {
    id: "canvas-course-1",
    label: "Example Canvas",
    kind: "canvas",
    accountScope: "student-1",
    courseId: "course-1",
    scope: "assignments",
  },
  observedAt: t(seconds),
  complete: true,
  status: "ok",
  resources,
  ...extra,
});
const judgment = (store: Store, key = "question-v1"): Judgment => {
  const r = store.resources()[0];
  return {
    key,
    resourceId: r.id,
    inputHash: r.contentHash,
    model: "test-model",
    questionVersion: "v1",
    result: { kind: "practice" },
    createdAt: t(2),
  };
};

test("store restarts with evidence, completion, privacy, judgments, links, attempts and receipts intact", () => {
  const directory = mkdtempSync(join(tmpdir(), "magic-storage-"));
  const file = join(directory, "nested", "private.sqlite");
  let store = createStore(file);
  try {
    store.ingest(
      batch(0, [
        item(),
        item("m1", { kind: "material", title: "Transport reading" }),
      ]),
    );
    const [a, b] = store.resources();
    store.setCompleted(a.id, true);
    const privacy = {
      mode: "selective_cloud",
      jevEnabled: true,
      hostedProvider: "none",
      shareCourseText: true,
      shareStudentWork: false,
    } as const;
    store.setPrivacy(privacy);
    const result = judgment(store);
    assert.equal(store.putJudgment(result), true);
    store.putLink({
      id: "l1",
      fromId: a.id,
      toId: b.id,
      type: "supports",
      reason: "The resource explicitly names cell transport.",
      status: "proposed",
      inputHash: a.contentHash,
    });
    store.decideLink("l1", "accepted");
    const attempt: Attempt = {
      id: "attempt-1",
      resourceId: a.id,
      itemId: "question-1",
      skill: "transport",
      correct: true,
      assistance: "none",
      seenBefore: false,
      confidence: 0.8,
      createdAt: t(3),
    };
    store.addAttempt(attempt);
    store.addAttempt(attempt);
    store.addReceipt({
      id: "receipt-1",
      recipient: "jev",
      purpose: "classify",
      categories: ["course_text"],
      resourceIds: [a.id],
      characters: 40,
      status: "sent",
      createdAt: t(4),
    });
    store.close();
    store = createStore(file);
    // Windows' chmod cannot produce POSIX owner-only mode bits; the store still
    // calls chmodSync(path, 0o600) for the POSIX platforms where it matters.
    if (process.platform !== "win32")
      assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(store.resource(a.id)?.completed, true);
    assert.deepEqual(store.privacy(), { ...defaultPrivacy, ...privacy });
    assert.deepEqual(store.judgment(result.key), result);
    assert.equal(store.links()[0].status, "accepted");
    assert.deepEqual(store.attempts(), [attempt]);
    assert.equal(store.receipts()[0].characters, 40);
    assert.equal(store.jobs().length, 2);
    assert.equal(store.sources()[0].resourceCount, 2);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("observations refresh without duplicate content versions or jobs; changed content retains student state", () => {
  const directory = mkdtempSync(join(tmpdir(), "magic-observations-"));
  const file = join(directory, "private.sqlite");
  const store = createStore(file);
  try {
    assert.equal(store.ingest(batch(0)).created, 1);
    const first = store.resources()[0];
    store.setCompleted(first.id, true);
    assert.deepEqual(store.ingest(batch(1)), {
      created: 0,
      changed: 0,
      unchanged: 1,
      deleted: 0,
      ignored: false,
    });
    assert.equal(store.resource(first.id)?.version, 1);
    assert.equal(store.resource(first.id)?.observedAt, t(1));
    assert.equal(store.resource(first.id)?.capturedAt, first.capturedAt);
    assert.equal(store.jobs().length, 1);
    assert.equal(
      store.ingest(
        batch(2, [item("a1", { text: "The updated reading covers osmosis." })]),
      ).changed,
      1,
    );
    assert.equal(store.resource(first.id)?.version, 2);
    assert.equal(store.resource(first.id)?.completed, true);
    assert.equal(store.jobs().length, 2);
    const inspect = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(
        inspect.prepare("SELECT COUNT(*) AS count FROM resource_versions").get()
          ?.count,
        2,
      );
      assert.equal(
        inspect.prepare("SELECT COUNT(*) AS count FROM observations").get()
          ?.count,
        3,
      );
      assert.equal(
        inspect.prepare("PRAGMA user_version").get()?.user_version,
        5,
      );
    } finally {
      inspect.close();
    }
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("partial, failed, and sign-in captures preserve data and last complete success; only scoped enumeration deletes", () => {
  const store = createStore(":memory:");
  try {
    store.ingest(batch(0, [item("a1"), item("a2")]));
    const original = store.resources();
    const otherSource = {
      ...batch(0).source,
      id: "readings",
      scope: "readings",
    };
    store.ingest(batch(0, [item("m1")], { source: otherSource }));
    store.ingest(batch(1, [], { status: "partial", complete: true }));
    assert.equal(store.resources().length, 3);
    assert.equal(
      store.sources().find((s) => s.id === "canvas-course-1")?.complete,
      false,
    );
    assert.equal(
      store.sources().find((s) => s.id === "canvas-course-1")?.lastSuccessAt,
      t(0),
    );
    store.ingest(batch(2, [], { status: "needs_sign_in", complete: true }));
    store.ingest(batch(3, [], { status: "error", complete: false }));
    assert.equal(store.resources().length, 3);
    assert.equal(
      store.sources().find((s) => s.id === "canvas-course-1")?.lastAttemptAt,
      t(3),
    );
    assert.equal(store.ingest(batch(4, [item("a1")])).deleted, 1);
    assert.equal(store.resources().length, 2);
    assert.equal(
      store.resource(original.find((r) => r.externalId === "a2")!.id)?.deleted,
      true,
    );
    assert.equal(
      store.sources().find((s) => s.id === "readings")?.resourceCount,
      1,
    );
  } finally {
    store.close();
  }
});

test("source identity, course scope and observation ordering prevent cross-course or stale corruption", () => {
  const store = createStore(":memory:");
  try {
    store.ingest(batch(10));
    const r = store.resources()[0];
    assert.equal(store.ingest(batch(9, [])).ignored, true);
    assert.equal(
      store.ingest(
        batch(10, [item("a1", { title: "Concurrent conflicting capture" })]),
      ).ignored,
      true,
    );
    assert.equal(store.resource(r.id)?.title, r.title);
    assert.equal(store.sources()[0].lastAttemptAt, t(10));
    assert.throws(
      () => store.ingest(batch(11, [item("a1", { courseId: "other-course" })])),
      /course/,
    );
    assert.throws(
      () =>
        store.ingest(
          batch(11, [], {
            source: { ...batch(0).source, accountScope: "other-student" },
          }),
        ),
      /reassigned/,
    );
    assert.throws(() => store.ingest(batch(11, [item(), item()])), /duplicate/);
    assert.equal(store.resources().length, 1);
    assert.equal(store.jobs().length, 1);
  } finally {
    store.close();
  }
});

test("a resource that reappears retains completion and resumes work canceled by its deletion", () => {
  const store = createStore(":memory:");
  try {
    store.ingest(batch(0));
    const r = store.resources()[0];
    store.setCompleted(r.id, true);
    const oldWorker = store.lease(t(0), 10000)!;
    store.ingest(batch(1, []));
    assert.equal(store.jobs()[0].status, "failed");
    assert.equal(store.ingest(batch(2)).changed, 1);
    assert.equal(store.resource(r.id)?.deleted, false);
    assert.equal(store.resource(r.id)?.completed, true);
    assert.equal(store.resource(r.id)?.version, 1);
    assert.equal(store.jobs()[0].status, "pending");
    const newWorker = store.lease(t(3), 10000)!;
    assert.notEqual(newWorker.leaseToken, oldWorker.leaseToken);
    assert.equal(store.finish(oldWorker, undefined, t(3)), false);
    assert.equal(store.finish(newWorker, undefined, t(3)), true);
  } finally {
    store.close();
  }
});

test("FTS search accepts punctuation and operator-like input safely and drops deleted material", () => {
  const store = createStore(":memory:");
  try {
    store.ingest(
      batch(0, [
        item(),
        item("second", {
          title: "Linear algebra",
          text: "Matrix decomposition.",
        }),
      ]),
    );
    assert.equal(store.resources("membrane")[0].externalId, "a1");
    assert.equal(store.resources("CELLS and membranes").length, 1);
    assert.doesNotThrow(() => store.resources('" OR * NEAR(x) - :'));
    assert.doesNotThrow(() => store.resources("'; DROP TABLE resources; --"));
    assert.deepEqual(store.resources("***"), []);
    assert.equal(store.resources().length, 2);
    store.ingest(
      batch(1, [
        item("second", {
          title: "Linear algebra",
          text: "Matrix decomposition.",
        }),
      ]),
    );
    assert.deepEqual(store.resources("membrane"), []);
  } finally {
    store.close();
  }
});

test("lease tokens fence expired workers, crashed jobs retry, and retries eventually fail", () => {
  const store = createStore(":memory:");
  try {
    store.ingest(batch(0));
    const first = store.lease(t(0), 1000)!;
    assert.equal(first.attempts, 1);
    assert.equal(store.lease(t(0), 1000), undefined);
    assert.equal(store.finish(first, undefined, t(1)), false);
    const second = store.lease(t(1), 1000)!;
    assert.equal(second.id, first.id);
    assert.notEqual(second.leaseToken, first.leaseToken);
    assert.equal(second.attempts, 2);
    assert.equal(store.finish(first, undefined, t(1)), false);
    assert.equal(store.finish(second, "Temporary failure", t(1)), true);
    assert.equal(store.lease(t(2), 1000), undefined);
    const third = store.lease(t(3), 1000)!;
    assert.equal(third.attempts, 3);
    assert.equal(store.finish(third, "Still unavailable", t(3)), true);
    assert.equal(store.jobs()[0].status, "failed");
    assert.equal(store.lease(t(100), 1000), undefined);
    assert.throws(() => store.lease(t(0), -1), /duration/);
  } finally {
    store.close();
  }
});

test("in-flight jobs and judgments cannot apply to changed or deleted evidence", () => {
  const store = createStore(":memory:");
  try {
    store.ingest(batch(0));
    const original = judgment(store);
    assert.equal(store.putJudgment(original), true);
    const job = store.lease(t(0), 10000)!;
    store.ingest(
      batch(1, [item("a1", { text: "Updated instructor requirements." })]),
    );
    assert.equal(store.finish(job, undefined, t(2)), false);
    assert.equal(store.putJudgment({ ...original, createdAt: t(2) }), false);
    assert.equal(store.judgment(original.key), undefined);
    assert.deepEqual(store.judgments(), []);
    const fresh = judgment(store, "new-question-key");
    assert.equal(store.putJudgment(fresh), true);
    store.ingest(batch(3, []));
    assert.equal(store.putJudgment({ ...fresh, createdAt: t(4) }), false);
    assert.deepEqual(store.judgments(), []);
  } finally {
    store.close();
  }
});

test("student link rejection survives repeated proposals and cross-course links are refused", () => {
  const store = createStore(":memory:");
  try {
    store.ingest(batch(0, [item(), item("m1")]));
    const [a, b] = store.resources();
    const proposal = {
      id: "l1",
      fromId: a.id,
      toId: b.id,
      type: "supports",
      reason: "Related reading.",
      status: "proposed",
      inputHash: a.contentHash,
    } as const;
    store.putLink(proposal);
    store.decideLink(proposal.id, "rejected");
    store.putLink(proposal);
    assert.equal(store.links()[0].status, "rejected");
    store.ingest(
      batch(0, [item("a1", { courseId: "course-2" })], {
        source: { ...batch(0).source, id: "course-2", courseId: "course-2" },
      }),
    );
    const other = store.resources().find((r) => r.courseId === "course-2")!;
    assert.throws(
      () => store.putLink({ ...proposal, id: "l2", toId: other.id }),
      /one account and course/,
    );
    assert.throws(() => store.putLink({ ...proposal, toId: a.id }), /itself/);
    store.ingest(
      batch(1, [item(), item("m1", { title: "An unrelated new reading" })]),
    );
    assert.deepEqual(store.links(), []);
    assert.throws(() => store.decideLink(proposal.id, "accepted"), /stale/);
  } finally {
    store.close();
  }
});

test("purge deletes private history and defaults privacy; old asynchronous writes cannot restore it", () => {
  const directory = mkdtempSync(join(tmpdir(), "magic-purge-"));
  const file = join(directory, "private.sqlite");
  const store = createStore(file);
  try {
    store.ingest(batch(0));
    const r = store.resources()[0];
    const result = judgment(store);
    store.putJudgment(result);
    store.setCompleted(r.id, true);
    store.setPrivacy({
      mode: "selective_cloud",
      jevEnabled: true,
      hostedProvider: "claude",
      shareCourseText: true,
      shareStudentWork: true,
    });
    store.addAttempt({
      id: "a",
      resourceId: r.id,
      itemId: "i",
      skill: "s",
      correct: false,
      assistance: "hint",
      seenBefore: false,
      confidence: null,
      createdAt: t(1),
    });
    const receipt = {
      id: "r",
      recipient: "jev",
      purpose: "classify",
      categories: ["course_text"],
      resourceIds: [r.id],
      characters: 50,
      status: "sent",
      createdAt: t(1),
    } as const;
    store.addReceipt({
      ...receipt,
      categories: [...receipt.categories],
      resourceIds: [...receipt.resourceIds],
    });
    const job = store.lease(t(0), 10000)!;
    store.purge();
    for (const list of [
      store.resources(),
      store.sources(),
      store.jobs(),
      store.judgments(),
      store.attempts(),
      store.receipts(),
      store.links(),
    ])
      assert.deepEqual(list, []);
    assert.deepEqual(store.privacy(), defaultPrivacy);
    assert.equal(store.putJudgment(result), false);
    assert.equal(store.finish(job, undefined, t(1)), false);
    store.addReceipt({
      ...receipt,
      categories: [...receipt.categories],
      resourceIds: [...receipt.resourceIds],
    });
    assert.deepEqual(store.receipts(), []);
    const inspect = new DatabaseSync(file, { readOnly: true });
    try {
      for (const table of [
        "resource_versions",
        "observations",
        "source_observations",
        "completions",
        "resource_search",
      ]) {
        assert.equal(
          inspect.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()
            ?.count,
          0,
        );
      }
    } finally {
      inspect.close();
    }
    store.ingest(batch(2));
    assert.notEqual(store.resources()[0].id, r.id);
    assert.equal(store.putJudgment(result), false);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
