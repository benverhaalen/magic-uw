import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createStore, SCHEMA_VERSION } from "@magic/storage";
import {
  captureBatchSchema,
  resourceInputSchema,
  defaultIngestionSettings,
  defaultPrivacy,
  mcpGrantSchema,
  type CaptureBatch,
  type ResourceInput,
} from "@magic/contracts";

const time = (n: number) => new Date(Date.UTC(2099, 0, 1, 0, n)).toISOString();
const item = (id = "1", extra: Partial<ResourceInput> = {}): ResourceInput => ({
  externalId: id,
  kind: "assignment",
  courseId: "course",
  courseName: "Biology 101",
  title: `Lab ${id}`,
  url: `https://canvas.example.test/courses/1/assignments/${id}`,
  text: "Read the protocol and explain the result.",
  deadlines: [],
  points: 10,
  submitted: false,
  policy: { mode: "unknown", evidence: "" },
  ...extra,
});
const capture = (
  n: number,
  resources: unknown[],
  extra: Partial<CaptureBatch> = {},
) => ({
  source: {
    id: "course:assignments",
    label: "Assignments",
    kind: "canvas",
    accountScope: "account",
    courseId: "course",
    scope: "assignments",
  },
  observedAt: time(n),
  status: "ok",
  complete: true,
  readId: `read-${n}`,
  resources,
  ...extra,
});

function temporaryStore() {
  const directory = mkdtempSync(join(tmpdir(), "magic-ingestion-store-"));
  const path = join(directory, "evidence.sqlite");
  const store = createStore(path);
  return {
    store,
    path,
    cleanup() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("resource contracts preserve typed evidence and reject capability URLs and arbitrary payloads", () => {
  const value = item("1", {
    rawHtml: "<p>Local assignment instructions</p>",
    createdAt: time(0),
    updatedAt: time(1),
    unlockAt: null,
    dueAt: time(3),
    workflowState: "future_canvas_state",
    submissionTypes: ["online_upload"],
    assignmentGroupId: "group-1",
    rubric: [
      {
        id: "criterion",
        description: "Reasoning",
        points: 10,
        ratings: [{ description: "Clear", points: 10 }],
      },
    ],
    submission: {
      workflowState: "future_submission_state",
      submittedAt: null,
      score: null,
      grade: null,
      comments: [{ text: "Explain the control.", createdAt: time(0) }],
    },
    course: {
      termName: "Fall 2026 to 2027",
      selection: {
        score: 5.5,
        included: true,
        reasons: ["student enrollment"],
      },
    },
    parts: [{ page: 2, text: "Protocol", start: 0, end: 8 }],
    document: {
      pages: [{ page: 2, text: "Protocol", anchor: "page-2" }],
      extractionStatus: "partial",
    },
    calendar: {
      uid: "event",
      start: "2099-01-01",
      end: "2099-01-02",
      allDay: true,
    },
  });
  assert.deepEqual(resourceInputSchema.parse(value), value);
  assert.equal(
    resourceInputSchema.safeParse({ ...value, raw: { cookie: "private" } })
      .success,
    false,
  );
  assert.equal(
    resourceInputSchema.safeParse({
      ...value,
      file: { downloadUrl: "https://example.test/private" },
    }).success,
    false,
  );
  for (const url of [
    "https://example.test/file?token=secret",
    "https://example.test/file?verifier=secret",
    "https://user:password@example.test/file",
    "https://example.test/file#access_token=secret",
    "not a URL",
  ])
    assert.equal(
      resourceInputSchema.safeParse({ ...value, url }).success,
      false,
    );
  assert.equal(
    captureBatchSchema.safeParse(
      capture(0, [value], {
        source: { ...capture(0, []).source, kind: "calendar" },
        status: "not_published",
      }),
    ).success,
    true,
  );
  assert.equal(
    mcpGrantSchema.safeParse({
      id: "client",
      label: "Tool",
      recipient: "local",
      enabled: true,
      courses: [],
      categories: ["everything"],
    }).success,
    false,
  );
});

test("per-record validation keeps valid neighbors, emits only paths/codes and prevents removals", () => {
  const { store, cleanup } = temporaryStore();
  try {
    store.ingest(capture(0, [item("1"), item("2")]));
    const rejectedPrivateValue = "PRIVATE_REJECTED_VALUE_NEVER_RECORDED";
    const report = store.ingest(
      capture(1, [
        item("1", { title: "Updated valid title" }),
        { ...item("bad"), points: rejectedPrivateValue },
      ]),
    );
    assert.equal(report.rejected, 1);
    assert.equal(report.changed, 1);
    assert.equal(report.deleted, 0);
    assert.equal(store.resources().length, 2);
    assert.equal(store.sources()[0].status, "partial");
    assert.equal(store.sources()[0].lastSuccessAt, time(0));
    assert.deepEqual(report.diagnostics, [
      {
        code: "invalid_type",
        path: ["resources", "1", "points"],
        severity: "error",
      },
    ]);
    assert.equal(
      JSON.stringify([
        store.sources(),
        store.changes(),
        store.resources(),
      ]).includes(rejectedPrivateValue),
      false,
    );
    assert.throws(
      () =>
        store.ingest({
          ...capture(2, []),
          source: { token: rejectedPrivateValue },
        }),
      /^Error: Invalid capture envelope\.$/,
    );
  } finally {
    cleanup();
  }
});

test("field observations distinguish never seen, omitted and explicit null without erasing earlier evidence", () => {
  const { store, path, cleanup } = temporaryStore();
  try {
    const first = {
      ...item(),
      submission: { workflowState: "unsubmitted", score: null },
    };
    delete (first as Partial<ResourceInput>).points;
    store.ingest(capture(0, [first]));
    const id = store.resources()[0].id;
    assert.equal(store.resource(id)!.points, null);
    assert.equal(store.resource(id)!.fieldLastSeen!.points, undefined);
    assert.equal(
      store.resource(id)!.fieldLastSeen!["submission.score"],
      time(0),
    );
    store.ingest(
      capture(1, [
        {
          ...first,
          rawHtml: "<p>Earlier evidence</p>",
          dueAt: time(5),
          submission: {
            workflowState: "submitted",
            submittedAt: time(1),
            score: 9,
          },
        },
      ]),
    );
    store.ingest(capture(2, [first]));
    assert.equal(store.resource(id)!.dueAt, time(5));
    assert.equal(store.resource(id)!.rawHtml, "<p>Earlier evidence</p>");
    assert.equal(store.resource(id)!.submission!.submittedAt, time(1));
    assert.equal(store.resource(id)!.fieldLastSeen!.dueAt, time(1));
    assert.equal(store.resource(id)!.submission!.score, null);
    assert.equal(
      store.resource(id)!.fieldLastSeen!["submission.score"],
      time(2),
    );
    store.ingest(capture(3, [{ ...first, dueAt: null }]));
    assert.equal(store.resource(id)!.dueAt, null);
    assert.equal(store.resource(id)!.fieldLastSeen!.dueAt, time(3));
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.ok(
        Number(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM field_observations WHERE resource_id=? AND field='submission.score'",
            )
            .get(id)!.count,
        ) === 1, // D4 (schema v6): the latest observation per field is kept, not every sync
      );
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});

test("typed changes retain exact before/after values, scope and read identity through removal and restoration", () => {
  const { store, cleanup } = temporaryStore();
  try {
    const original = item("1", {
      dueAt: time(10),
      lockAt: null,
      submission: { workflowState: "unsubmitted", score: null },
    });
    store.ingest(capture(0, [original]));
    const id = store.resources()[0].id;
    const changed = {
      ...original,
      dueAt: time(20),
      text: "Use the revised protocol.",
      submission: {
        workflowState: "submitted",
        submittedAt: time(1),
        score: null,
      },
    };
    store.ingest(capture(1, [changed]));
    let events = store.changes({ resourceId: id });
    assert.deepEqual(
      new Set(events.map((e) => e.type)),
      new Set([
        "new",
        "updated",
        "date_changed",
        "requirements_changed",
        "submitted",
      ]),
    );
    const dates = events.find((e) => e.type === "date_changed")!;
    assert.deepEqual(dates.oldValues, { dueAt: time(10) });
    assert.deepEqual(dates.newValues, { dueAt: time(20) });
    assert.equal(dates.readId, "read-1");
    assert.equal(dates.scope, "assignments");
    assert.equal(dates.accountScope, "account");
    const graded = {
      ...changed,
      submission: {
        ...changed.submission,
        workflowState: "graded",
        score: 9,
        grade: "A",
      },
    };
    store.ingest(capture(2, [graded]));
    assert.equal(
      store.changes({ since: time(2) }).filter((e) => e.type === "graded")
        .length,
      1,
    );
    store.ingest(capture(3, []));
    assert.equal(store.resource(id)!.deleted, true);
    store.ingest(capture(4, [graded]));
    events = store.changes({ resourceId: id });
    assert.equal(events.filter((e) => e.type === "restored").length, 1);
    assert.equal(events.filter((e) => e.type === "removed").length, 1);
    assert.equal(store.resource(id)!.id, id);
    const eventCount = events.length;
    store.ingest(capture(5, [graded]));
    assert.equal(store.changes({ resourceId: id }).length, eventCount);
    assert.equal(store.changes({ accountScope: "other-account" }).length, 0);
  } finally {
    cleanup();
  }
});

test("failed, blocked and drifting scopes preserve last successful content and historical baselines", () => {
  const { store, cleanup } = temporaryStore();
  try {
    const resources = Array.from({ length: 10 }, (_, n) =>
      item(String(n), { dueAt: time(20) }),
    );
    store.ingest(capture(0, resources));
    const original = store
      .resources()
      .map((r) => ({ id: r.id, hash: r.contentHash }));
    store.ingest(
      capture(1, [item("0", { text: "login-shaped replacement" })], {
        status: "needs_sign_in",
        complete: false,
      }),
    );
    assert.deepEqual(
      store.resources().map((r) => ({ id: r.id, hash: r.contentHash })),
      original,
    );
    const report = store.ingest(capture(2, []));
    assert.equal(report.deleted, 0);
    assert.equal(store.sources()[0].status, "needs_attention");
    assert.equal(store.sources()[0].lastSuccessAt, time(0));
    assert.equal(store.scopeBaselines()[0].successfulReads, 1);
    store.ingest(
      capture(
        3,
        resources.map((r) => ({ ...r, text: "" })),
      ),
    );
    assert.equal(store.sources()[0].diagnostics![0].code, "key_text_loss");
    assert.deepEqual(
      store.resources().map((r) => ({ id: r.id, hash: r.contentHash })),
      original,
    );
    store.ingest(
      capture(
        4,
        resources.map((r) => ({ ...r, dueAt: null })),
      ),
    );
    assert.equal(store.sources()[0].diagnostics![0].code, "date_coverage_loss");
    store.ingest(capture(5, resources));
    assert.equal(store.sources()[0].status, "ok");
    assert.equal(store.sources()[0].lastSuccessAt, time(5));
    assert.equal(store.scopeBaselines()[0].successfulReads, 2);
    assert.equal(store.changes().filter((e) => e.type === "removed").length, 0);
  } finally {
    cleanup();
  }
});

test("restricted course catalogs remain visible without refreshing or replacing successful content", () => {
  for (const status of ["inaccessible", "not_published"] as const) {
    const { store, cleanup } = temporaryStore();
    try {
      const source = {
        ...capture(0, []).source,
        kind: "canvas" as const,
        id: "course:catalog",
        scope: "course",
      };
      const catalog = item("catalog", {
        kind: "course",
        title: "Biology 101",
        text: "Restricted content must not be treated as evidence.",
        rawHtml: "<p>Restricted content</p>",
        course: {
          workflowState:
            status === "not_published" ? "unpublished" : "available",
          accessRestricted: true,
          accessState: "not_open",
          selection: {
            score: 4,
            included: false,
            reasons: ["Course is not open yet"],
          },
        },
      });
      const first = store.ingest(
        capture(0, [catalog, item("non-course")], { source, status }),
      );
      assert.equal(first.created, 1);
      const resource = store.resources()[0];
      assert.equal(resource.kind, "course");
      assert.equal(
        resource.course!.selection!.reasons[0],
        "Course is not open yet",
      );
      assert.equal(resource.text, "");
      assert.equal(resource.rawHtml, undefined);
      assert.equal(resource.fieldLastSeen!.text, undefined);
      assert.equal(store.sources()[0].status, status);
      assert.equal(store.sources()[0].complete, false);
      assert.equal(store.sources()[0].lastSuccessAt, null);
      assert.equal(store.scopeBaselines().length, 0);

      const good = {
        ...catalog,
        text: "Successful course evidence.",
        rawHtml: "<p>Successful course evidence.</p>",
        dueAt: time(20),
        course: {
          ...catalog.course!,
          accessRestricted: false,
          accessState: "open" as const,
        },
      };
      store.ingest(capture(1, [good], { source }));
      const restricted = {
        ...catalog,
        title: "Biology 101 — next term",
        text: "",
        rawHtml: "",
        dueAt: null,
      };
      const update = store.ingest(
        capture(2, [restricted, item("non-course")], { source, status }),
      );
      assert.equal(update.changed, 1);
      assert.equal(store.resources().length, 1);
      const retained = store.resource(resource.id)!;
      assert.equal(retained.title, restricted.title);
      assert.equal(retained.course!.accessRestricted, true);
      assert.equal(retained.text, good.text);
      assert.equal(retained.rawHtml, good.rawHtml);
      assert.equal(retained.dueAt, good.dueAt);
      assert.equal(retained.fieldLastSeen!.text, time(1));
      assert.equal(retained.fieldLastSeen!["course.accessRestricted"], time(2));
      assert.equal(store.sources()[0].status, status);
      assert.equal(store.sources()[0].complete, false);
      assert.equal(store.sources()[0].lastSuccessAt, time(1));
      assert.equal(store.scopeBaselines()[0].successfulReads, 1);
      assert.equal(
        store
          .changes({ since: time(2) })
          .some((change) => change.type === "requirements_changed"),
        false,
      );
      assert.equal(store.ingest(capture(3, [], { source, status })).deleted, 0);
      assert.equal(store.resource(resource.id)!.deleted, false);
    } finally {
      cleanup();
    }
  }
});

test("v2 migration preserves history and missing provenance; settings, grants and all new history purge", () => {
  const directory = mkdtempSync(join(tmpdir(), "magic-v2-migration-"));
  const path = join(directory, "evidence.sqlite");
  let store = createStore(path);
  try {
    store.ingest(capture(0, [item()]));
    const id = store.resources()[0].id;
    store.setCompleted(id, true);
    store.close();
    const legacy = new DatabaseSync(path);
    // A real v2 database has no learning tables. Remove the current additions
    // before downgrading the fixture's version, rather than leaving a hybrid schema.
    legacy.exec("PRAGMA foreign_keys=OFF");
    for (const row of legacy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'learning_%'").all()) {
      const name = String(row.name);
      if (!/^learning_[a-z_]+$/.test(name)) throw new Error("Unexpected learning table");
      legacy.exec(`DROP TABLE "${name}"`);
    }
    legacy.exec("PRAGMA foreign_keys=ON");
    legacy.exec(
      // Schema v6 objects first, so the file matches what a v2 database held.
      "DROP TABLE passage_vocab; DROP TABLE passage_fts; DROP TABLE passages; DROP TABLE counters; DROP TABLE assessment_scope; DROP TABLE assessments; DROP TABLE course_sessions; DROP TABLE map_links; DROP TABLE course_spaces; DROP TABLE extraction_recipes; DROP TABLE course_briefs; DROP TABLE material_facts; DROP TABLE life_items; DROP TABLE compile_runs; DROP TABLE ledger; DROP TABLE ui_events; DROP INDEX judgments_resource; DROP INDEX links_from; DROP INDEX links_to; DROP INDEX sources_course; ALTER TABLE resources DROP COLUMN text_hash; ALTER TABLE resource_versions DROP COLUMN text_hash; CREATE VIRTUAL TABLE resource_search USING fts5(resource_id UNINDEXED, title, course_name, body); " +
        "DROP TABLE course_intelligence; DROP TABLE planning_versions; DROP TABLE planning_records; DROP TABLE planning_captures; DROP TABLE planning_sources; DROP TABLE field_observations; DROP TABLE resource_changes; DROP TABLE scope_baselines; DROP TABLE course_overrides; DROP TABLE sync_runs; DROP TABLE mcp_grants; ALTER TABLE sources DROP COLUMN details; PRAGMA user_version=2;",
    );
    legacy.close();
    store = createStore(path);
    assert.equal(store.resources()[0].id, id);
    assert.equal(store.resource(id)!.completed, true);
    assert.deepEqual(store.resource(id)!.fieldLastSeen, {});
    assert.deepEqual(store.ingestionSettings(), defaultIngestionSettings);
    store.setIngestionSettings({
      ...defaultIngestionSettings,
      intervalMinutes: 17,
      collectComments: false,
    });
    store.setCourseOverride({
      accountScope: "account",
      courseId: "course",
      included: false,
    });
    store.setCourseOverride({
      accountScope: "other-account",
      courseId: "course",
      included: true,
    });
    store.setMcpGrant({
      id: "client",
      label: "Local tool",
      recipient: "local",
      enabled: true,
      courses: [{ accountScope: "account", courseId: "course" }],
      categories: ["course_text"],
      tokenHash: "a".repeat(64),
    });
    store.addSyncRun({
      id: "run",
      startedAt: time(0),
      finishedAt: time(1),
      status: "ok",
      action: "manual",
      stats: { requests: 8, rateLimitRemaining: 300 },
    });
    store.ingest(capture(1, [item()]));
    store.close();
    store = createStore(path);
    assert.equal(store.ingestionSettings().intervalMinutes, 17);
    assert.equal(store.ingestionSettings().collectComments, false);
    assert.equal(store.courseOverrides().length, 2);
    assert.equal(store.mcpGrants()[0].courses[0].accountScope, "account");
    assert.equal(store.syncRuns()[0].stats!.requests, 8);
    store.setCourseOverride({
      accountScope: "account",
      courseId: "course",
      included: null,
    });
    assert.deepEqual(store.courseOverrides(), [
      { accountScope: "other-account", courseId: "course", included: true },
    ]);
    store.purge();
    for (const list of [
      store.resources(),
      store.changes(),
      store.scopeBaselines(),
      store.courseOverrides(),
      store.syncRuns(),
      store.mcpGrants(),
    ])
      assert.deepEqual(list, []);
    assert.deepEqual(store.ingestionSettings(), defaultIngestionSettings);
    assert.deepEqual(store.privacy(), defaultPrivacy);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, SCHEMA_VERSION);
      for (const table of [
        "course_intelligence",
        "field_observations",
        "resource_changes",
        "scope_baselines",
        "sync_runs",
        "mcp_grants",
        "course_overrides",
      ])
        assert.equal(
          db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count,
          0,
        );
    } finally {
      db.close();
    }
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a single outside page losing its extraction preserves its last good evidence", () => {
  const { store, cleanup } = temporaryStore();
  try {
    const source = {
      ...capture(0, []).source,
      id: "course:website",
      kind: "web" as const,
      scope: "website",
    };
    const good = item("page", {
      text: "Read the complete assignment instructions and required analysis. ".repeat(
        20,
      ),
    });
    store.ingest(capture(0, [good], { source }));
    const old = store.resources()[0];
    store.ingest(capture(1, [{ ...good, text: "Loading…" }], { source }));
    assert.equal(store.resource(old.id)!.text, old.text);
    assert.equal(store.resource(old.id)!.observedAt, time(0));
    assert.equal(store.sources()[0].status, "needs_attention");
    assert.equal(store.sources()[0].lastSuccessAt, time(0));
    assert.equal(store.sources()[0].diagnostics![0].code, "key_text_loss");
  } finally {
    cleanup();
  }
});
