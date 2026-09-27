import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStore, SCHEMA_VERSION } from "../packages/storage/src/index";
import { LEARNING_SCHEMA } from "../packages/storage/src/learning";
import type {
  Concept,
  LearningItem,
  LearningAttempt,
  LearningSession,
} from "../packages/learning/src/store";
const T = "2026-09-20T15:00:00.000Z";
function seed(path = ":memory:") {
  const owner = createStore(path);
  owner.ingest({
    source: {
      id: "syn-source",
      kind: "canvas",
      accountScope: "acct",
      courseId: "SYN101",
      scope: "materials",
      label: "Synthetic",
    },
    observedAt: T,
    complete: true,
    status: "ok",
    resources: [
      {
        externalId: "r",
        kind: "material",
        courseId: "SYN101",
        courseName: "Synthetic",
        title: "A synthetic source",
        url: "https://canvas.example.test/material",
        text: "The synthetic unit measures a quantity.",
        deadlines: [],
        policy: { mode: "coaching", evidence: "Synthetic policy" },
      },
    ],
  });
  const resource = owner.resources()[0]!;
  const s = owner.learning,
    ref = s.course("acct", "SYN101").id;
  const c: Concept = {
    id: "c1",
    courseRef: ref,
    parentId: null,
    label: "Quantity",
    kind: "concept",
    position: 0,
    origin: "code",
    status: "active",
    mergedInto: null,
    studentLabel: null,
    mapVersion: "v1",
    sources: [],
  };
  s.putConceptMap(ref, [c, { ...c, id: "c2" }], "v1");
  const i: LearningItem = {
    id: "i1",
    version: 1,
    courseRef: ref,
    familyId: "f1",
    kind: "numeric",
    stem: "Synthetic quantity?",
    options: null,
    key: 2,
    unit: "m",
    keyIdeas: [],
    explanation: "Synthetic explanation",
    tempting: {},
    bloom: "understand",
    bPrior: 0,
    tier: "T1",
    sourceTerm: null,
    origin: "instructor",
    status: "active",
    statusReason: null,
    generator: null,
    createdAt: T,
  };
  const src = {
    resourceId: resource.id,
    contentHash: resource.contentHash,
    textHash: "synthetic-text-hash",
    start: 0,
    end: 3,
    quote: "The",
    quoteValid: true,
  };
  s.putItem(i, [src], [{ conceptId: "c1", weight: 1, primary: true }], []);
  const a: LearningAttempt = {
    id: "a1",
    courseRef: ref,
    itemId: i.id,
    itemVersion: 1,
    sourceResourceId: resource.id,
    primaryConceptId: "c1",
    correct: true,
    assistance: "none",
    seenBefore: false,
    confidence: null,
    createdAt: T,
    format: "numeric",
    mode: "learn",
    response: { value: 2 },
    score: 1,
    gradingMethod: "code",
    responseMs: 100,
    conceptTags: [{ conceptId: "c1", weight: 1, primary: true }],
    sessionId: "s1",
    localDay: "2026-09-20",
    optionId: "option",
  };
  const session: LearningSession = {
    id: "s1",
    courseRef: ref,
    kind: "learn",
    plan: { revision: 0, draft: "saved" },
    minutes: 5,
    difficulty: "normal",
    startedAt: T,
    endedAt: null,
  };
  return { owner, s, ref, c, i, a, src, session };
}
const fsrs = {
  due: T,
  stability: 1,
  difficulty: 1,
  elapsed_days: 0,
  scheduled_days: 1,
  learning_steps: 0,
  reps: 1,
  lapses: 0,
  state: 1,
  last_review: T,
};
test("N24 full record persistence, reopen, immutable evidence and isolated courses", () => {
  const dir = mkdtempSync(join(tmpdir(), "magic-learning-sql-")),
    path = join(dir, "db.sqlite");
  let { owner, s, ref, c, i, a, session } = seed(path);
  try {
    s.addAlias({ conceptId: c.id, alias: " Quantity ", origin: "student" });
    s.addAlias({ conceptId: c.id, alias: "quantity", origin: "code" });
    s.editConcept(c.id, { kind: "rename", label: "My quantity" });
    s.editConcept("c2", { kind: "merge", intoId: "c1" });
    s.putConceptMap(ref, [c, { ...c, id: "c2" }], "v2");
    assert.equal(s.concepts(ref)[0]!.studentLabel, "My quantity");
    assert.equal(s.concepts(ref)[1]!.mergedInto, "c1");
    s.putCard({
      id: "card",
      itemId: i.id,
      courseRef: ref,
      conceptId: c.id,
      fsrs,
      fsrsVersion: "5.4.2",
      paramsHash: "p",
      isConceptTrack: false,
    });
    s.putCard({
      id: "track",
      itemId: "concept-track",
      courseRef: ref,
      conceptId: c.id,
      fsrs,
      fsrsVersion: "5.4.2",
      paramsHash: "p",
      isConceptTrack: true,
    });
    s.addReview({
      id: "review",
      cardId: "card",
      rating: 3,
      stateBefore: fsrs,
      stateAfter: fsrs,
      reviewMs: 100,
      localDay: "2026-09-20",
      undoesReviewId: null,
      createdAt: T,
    });
    s.addAttempt(a);
    s.addAttempt({ ...a, response: { value: 2 } });
    assert.throws(() => s.addAttempt({ ...a, score: 0 }), /different content/);
    s.addSelfRating({
      id: "rating",
      conceptId: c.id,
      rating: "shaky",
      delayed: false,
      localDay: "2026-09-20",
      createdAt: T,
    });
    s.addDispute({
      id: "dispute",
      courseRef: ref,
      targetKind: "item",
      targetId: i.id,
      reason: "unclear",
      note: null,
      status: "open",
      createdAt: T,
      resolvedAt: null,
    });
    s.setDisputeStatus("dispute", "resolved", T);
    s.putConceptState([
      {
        conceptId: c.id,
        theta: 0,
        n: 1,
        s: 1,
        pHat: 1,
        r: null,
        band: "not_seen",
        reasons: [],
        counts: {},
        configVersion: "1",
        computedAt: T,
      },
    ]);
    s.putSession(session);
    s.putArtifact({
      id: "artifact",
      courseRef: ref,
      kind: "answer",
      scope: {},
      cacheKey: "cache",
      body: { text: "Synthetic" },
      removedCount: 0,
      status: "ready",
      generator: null,
      pack: "explain",
      packVersion: "v1",
      createdAt: T,
      sources: [],
    });
    const before = {
      items: s.items(),
      cards: s.cards(),
      evidence: s.evidence(ref),
      concepts: s.concepts(ref),
      aliases: s.aliases(c.id),
      state: s.conceptState(ref),
      session: s.session("s1"),
      artifact: s.artifact("cache"),
    };
    owner.close();
    owner = createStore(path);
    s = owner.learning;
    assert.deepEqual(
      {
        items: s.items(),
        cards: s.cards(),
        evidence: s.evidence(ref),
        concepts: s.concepts(ref),
        aliases: s.aliases(c.id),
        state: s.conceptState(ref),
        session: s.session("s1"),
        artifact: s.artifact("cache"),
      },
      before,
    );
    assert.equal(s.cards({ itemId: i.id })[0]!.itemVersion, 1);
    assert.equal(s.items()[0]!.item.unit, "m");
    assert.equal(s.evidence(ref).attempts[0]!.optionId, "option");
    assert.equal(s.evidence("other").attempts.length, 0);
    assert.equal(owner.attempts().length, 0);
    const other = s.course("other", "SYN101").id;
    assert.throws(
      () => s.putConceptMap(other, [{ ...c, courseRef: other }], "x"),
      /another course/,
    );
    assert.throws(
      () =>
        s.putItem(
          { ...i, id: "foreign", courseRef: other },
          [],
          [{ conceptId: c.id, weight: 1, primary: true }],
          [],
        ),
      /another course/,
    );
    assert.throws(
      () => s.putSession({ ...session, courseRef: other }),
      /another course/,
    );
  } finally {
    owner.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("N24 CAS and batch writes roll back on error, preserving session and evidence", () => {
  const { owner, s, ref, c, a, session } = seed();
  try {
    assert.equal(s.commitSession(session, null), true);
    assert.equal(
      s.commitSession({ ...session, plan: { revision: 1 } }, null, a),
      false,
    );
    assert.equal(s.evidence(ref).attempts.length, 0);
    assert.throws(() =>
      s.commitSession({ ...session, plan: { revision: 1 } }, 0, {
        ...a,
        primaryConceptId: "missing",
      }),
    );
    assert.deepEqual(s.session("s1"), session);
    assert.equal(s.evidence(ref).attempts.length, 0);
    assert.equal(
      s.commitSession({ ...session, plan: { revision: 1 } }, 0, a),
      true,
    );
    assert.throws(() =>
      s.transaction(() => {
        s.putSession({ ...session, plan: { revision: 2 } });
        throw Error("abort");
      }),
    );
    assert.deepEqual(s.session("s1")!.plan, { revision: 1 });
    assert.throws(() =>
      s.putConceptMap(
        ref,
        [
          { ...c, id: "new" },
          { ...c, id: "bad", parentId: "missing" },
        ],
        "v3",
      ),
    );
    assert.equal(
      s.concepts(ref).some((x) => x.id === "new"),
      false,
    );
    assert.throws(() =>
      s.putConceptState([
        {
          conceptId: c.id,
          theta: 0,
          n: 1,
          s: 0,
          pHat: 0,
          r: null,
          band: "x",
          reasons: [],
          counts: {},
          configVersion: "1",
          computedAt: T,
        },
        {
          conceptId: "missing",
          theta: 0,
          n: 1,
          s: 0,
          pHat: 0,
          r: null,
          band: "x",
          reasons: [],
          counts: {},
          configVersion: "1",
          computedAt: T,
        },
      ]),
    );
    assert.equal(s.conceptState(ref).length, 0);
  } finally {
    owner.close();
  }
});
test("N24 stale validation is atomic, immutable source versions survive, purge clears null-course sessions", () => {
  const { owner, s, ref, i, src, session } = seed();
  try {
    s.putItem({ ...i, id: "i2" }, [{ ...src, quote: "different" }], [], []);
    s.putArtifact({
      id: "a",
      courseRef: ref,
      kind: "faq",
      scope: {},
      cacheKey: "cache",
      body: {},
      removedCount: 0,
      status: "ready",
      generator: null,
      createdAt: T,
      sources: [src],
    });
    assert.throws(() =>
      s.markStale(src.resourceId, "new", () => {
        throw Error("validation failed");
      }),
    );
    assert.equal(s.artifact("cache")!.status, "ready");
    const report = s.markStale(src.resourceId, "new", (q) => q === src.quote);
    assert.deepEqual(report.items, [{ id: "i1", version: 1 }]);
    assert.deepEqual(report.quarantined, [{ id: "i2", version: 1 }]);
    assert.equal(s.items()[0]!.sources[0]!.contentHash, src.contentHash);
    assert.equal(s.items()[1]!.sources[0]!.quoteValid, false);
    s.putSession({ ...session, id: "cross", courseRef: null });
    owner.purge();
    assert.deepEqual(s.sessions(null), []);
    assert.deepEqual(s.items(), []);
    assert.deepEqual(s.concepts(ref), []);
  } finally {
    owner.close();
  }
});
test("N24 v7 upgrade preserves item-backed cards/reviews and leaves source and evidence data intact", () => {
  const dir = mkdtempSync(join(tmpdir(), "magic-learning-v7-")),
    path = join(dir, "db.sqlite");
  const initial = seed(path);
  initial.owner.close();
  let db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA foreign_keys=OFF");
    const names = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'learning_%'",
      )
      .all();
    for (const row of names) db.exec(`DROP TABLE "${String(row.name)}"`);
    db.exec(LEARNING_SCHEMA);
    db.prepare("INSERT INTO learning_courses VALUES (?,?,?,?,?,?)").run(
      "acct:SYN101",
      "acct",
      "SYN101",
      "Synthetic",
      null,
      T,
    );
    db.prepare(
      "INSERT INTO learning_concepts VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      "c1",
      "acct:SYN101",
      null,
      "Quantity",
      "concept",
      0,
      "code",
      "active",
      null,
      null,
      "v1",
    );
  } catch (error) {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  // Explicit columns mirror the genuine v7 schema, not the new adapter.
  try {
    db.prepare(
      "INSERT INTO learning_items (id,version,course_id,family_id,kind,stem,options_json,key_json,key_ideas_json,explanation,tempting_json,bloom,b_prior,tier,source_term,origin,status,status_reason,generator_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      "i1",
      3,
      "acct:SYN101",
      "f",
      "typed",
      "Synthetic stem",
      null,
      '"key"',
      "[]",
      null,
      "{}",
      "understand",
      0,
      "T1",
      null,
      "instructor",
      "active",
      null,
      null,
      T,
    );
    db.prepare("INSERT INTO learning_item_concepts VALUES (?,?,?,?,?)").run(
      "i1",
      3,
      "c1",
      1,
      1,
    );
    db.prepare(
      "INSERT INTO learning_cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run("card", "i1", 3, T, 1, 2, 0, 1, 0, 1, 0, 1, T, "5.4.2", "p", 0);
    db.prepare("INSERT INTO learning_reviews VALUES (?,?,?,?,?,?,?,?,?)").run(
      "r",
      "card",
      3,
      JSON.stringify(fsrs),
      JSON.stringify(fsrs),
      100,
      "2026-09-20",
      null,
      T,
    );
    db.exec("PRAGMA user_version=7");
    const cards = db.prepare("SELECT * FROM learning_cards").all(),
      reviews = db.prepare("SELECT * FROM learning_reviews").all();
    db.close();
    const owner = createStore(path);
    assert.equal(owner.learning.cards()[0]!.itemVersion, 3);
    assert.equal(owner.learning.cards()[0]!.conceptId, "c1");
    assert.equal(owner.learning.cards()[0]!.courseRef, "acct:SYN101");
    assert.equal(owner.learning.evidence("acct:SYN101").reviews.length, 1);
    assert.equal(owner.resources().length, 1);
    owner.close();
    db = new DatabaseSync(path);
    assert.equal(
      db.prepare("PRAGMA user_version").get()!.user_version,
      SCHEMA_VERSION,
    );
    const migrated = db.prepare("SELECT * FROM learning_cards").get()!;
    for (const [k, v] of Object.entries(cards[0]!))
      assert.equal(migrated[k], v, k);
    assert.deepEqual(
      db.prepare("SELECT * FROM learning_reviews").all(),
      reviews,
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    db.close();
  } finally {
    try {
      db.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});
test("N24 coverage retains student decisions; same-course sources and concept-track cards are enforced", () => {
  const { owner, s, ref, c, src } = seed();
  try {
    owner.putAssessment(
      {
        id: "exam",
        sourceId: "syn-source",
        resourceId: null,
        kind: "exam",
        title: "Synthetic exam",
        date: null,
        weight: null,
        format: null,
        origin: "code",
      },
      T,
    );
    const row = {
      assessmentId: "exam",
      conceptId: c.id,
      basis: "stated" as const,
      tier: "T1" as const,
      evidenceResourceId: src.resourceId,
      start: 0,
      end: 3,
      quote: "The",
      status: "proposed" as const,
      decidedByStudent: false,
    };
    s.putCoverage([row]);
    s.decideCoverage({ assessmentId: "exam", conceptId: c.id }, "rejected");
    s.putCoverage([row]);
    assert.equal(s.coverage("exam")[0]!.decidedByStudent, true);
    assert.equal(s.coverage("exam")[0]!.status, "rejected");
    const other = s.course("other", "OTHER").id;
    s.putConceptMap(other, [{ ...c, id: "other", courseRef: other }], "v1");
    assert.throws(
      () => s.putCoverage([{ ...row, conceptId: "other" }]),
      /another course/,
    );
    assert.throws(
      () =>
        s.putCard({
          id: "bad",
          itemId: "none",
          courseRef: ref,
          conceptId: "other",
          fsrs,
          fsrsVersion: "5",
          paramsHash: "p",
          isConceptTrack: true,
        }),
      /another course/,
    );
  } finally {
    owner.close();
  }
});
test("N24 nested caught failure rolls back its writes without aborting the surrounding operation", () => {
  const { owner, s, ref, c } = seed();
  try {
    s.transaction(() => {
      try {
        s.putConceptMap(
          ref,
          [
            {
              ...c,
              id: "fresh",
              sources: [
                {
                  resourceId: owner.resources()[0]!.id,
                  contentHash: "x",
                  start: 0,
                  end: 1,
                  quote: "x",
                  quoteValid: true,
                },
                {
                  resourceId: owner.resources()[0]!.id,
                  contentHash: "y",
                  start: 0,
                  end: 2,
                  quote: "xx",
                  quoteValid: true,
                },
              ],
            },
          ],
          "v2",
        );
      } catch {}
      assert.equal(
        s.concepts(ref).some((x) => x.id === "fresh"),
        false,
      );
      s.addAlias({ conceptId: c.id, alias: "survives", origin: "student" });
    });
    assert.equal(s.aliases(c.id).length, 1);
  } finally {
    owner.close();
  }
});
