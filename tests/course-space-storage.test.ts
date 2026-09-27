import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStore, SCHEMA_VERSION } from "@magic/storage";
import { COURSE_CORE_SCHEMA } from "../packages/storage/src/course-core";
import { runQuery } from "../packages/core/src/queries";
import {
  persistCourseSpaces,
  hydrateCourseSpaces,
} from "../apps/desktop/src/course-space-storage";
import type { CourseSpace } from "../packages/connectors/src/canvas-inventory";
const at = "2026-09-26T12:00:00.000Z";
function seed(store: ReturnType<typeof createStore>, account: string) {
  store.ingest({
    source: {
      id: account,
      label: "Course",
      kind: "canvas",
      accountScope: account,
      courseId: "1",
      scope: "pages",
    },
    observedAt: at,
    complete: true,
    status: "ok",
    resources: [
      {
        externalId: "p",
        kind: "material",
        courseId: "1",
        courseName: "Course",
        title: "Page",
        url: "https://canvas.wisc.edu/courses/1/pages/p",
        text: "Saved text",
        deadlines: [],
      },
    ],
  });
}
function space(): CourseSpace {
  return {
    id: "connector-id",
    courseId: "1",
    kind: "canvas_page",
    host: "canvas.wisc.edu",
    url: "https://canvas.wisc.edu/courses/1/pages/p?secret=discard",
    foundIn: "body",
    foundAt: "p",
    route: "canvas_session",
    treatment: "store",
    label: "Page",
    readState: "read",
    jev: false,
    access: { state: "unknown", checkedAt: null, action: "none" },
  };
}
test("durable access is account scoped; discovery, cached text, and denial stay distinct", () => {
  const dir = mkdtempSync(join(tmpdir(), "magic-spaces-"));
  const path = join(dir, "store.db");
  let store = createStore(path);
  try {
    seed(store, "a");
    seed(store, "b");
    persistCourseSpaces(store, "a", "1", [space()]);
    persistCourseSpaces(store, "b", "1", [space()]);
    let a = store.courseSpaces({ accountScope: "a", courseId: "1" })[0]!;
    assert.equal(a.accessState, "unknown");
    assert.equal(a.checkedAt, null);
    assert.ok(a.lastReadAt);
    assert.ok(!a.url.includes("secret"));
    assert.notEqual(
      a.id,
      store.courseSpaces({ accountScope: "b", courseId: "1" })[0]!.id,
    );
    persistCourseSpaces(store, "a", "1", [
      {
        ...space(),
        access: {
          state: "blocked",
          checkedAt: at,
          reason: "Denied",
          action: "none",
        },
      },
    ]);
    persistCourseSpaces(store, "a", "1", []);
    persistCourseSpaces(store, "a", "1", [space()]);
    store.close();
    store = createStore(path);
    a = store.courseSpaces({ accountScope: "a", courseId: "1" })[0]!;
    assert.equal(a.accessState, "blocked");
    assert.ok(a.lastReadAt);
    const b = store.courseSpaces({ accountScope: "b", courseId: "1" })[0]!;
    assert.equal(b.accessState, "unknown");
    assert.equal(b.checkedAt, null);
    assert.equal(
      hydrateCourseSpaces(store, "b", "1", [space()])[0]!.access.state,
      "unknown",
    );
    assert.equal(
      hydrateCourseSpaces(store, "a", "1", [space()])[0]!.access.state,
      "blocked",
    );
    const query = runQuery(
      store,
      { view: "courseSpaces", accountScope: "a", courseId: "1" },
      { now: () => at, gatewayConfigured: false },
    );
    assert.equal(query.view, "courseSpaces");
    if (query.view === "courseSpaces") assert.deepEqual(query.items, [a]);
    const { accountScope, courseId, ...input } = a;
    assert.throws(
      () => store.putCourseSpace({ ...input, sourceId: "b" }),
      /own course|between accounts/,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("v8 → v9 migrates the historical NOT NULL schema and preserves observed access", () => {
  const dir = mkdtempSync(join(tmpdir(), "magic-spaces-v8-"));
  const path = join(dir, "store.db");
  let store = createStore(path);
  try {
    for (const account of ["ambiguous", "read", "blocked"]) {
      seed(store, account);
      persistCourseSpaces(store, account, "1", [space()]);
    }
    store.close();
    const db = new DatabaseSync(path);
    try {
      // Rebuild the actual historical table and indexes, not just its version pragma.
      const historical = COURSE_CORE_SCHEMA.slice(
        COURSE_CORE_SCHEMA.indexOf("  CREATE TABLE course_spaces ("),
        COURSE_CORE_SCHEMA.indexOf("  CREATE TABLE course_briefs ("),
      );
      assert.ok(historical.includes("checked_at TEXT NOT NULL"));
      db.exec(`CREATE TEMP TABLE saved_spaces AS SELECT * FROM course_spaces;
        DROP TABLE course_spaces; ${historical}
        UPDATE saved_spaces SET access_state='readable', checked_at='${at}';
        UPDATE saved_spaces SET last_read_at=NULL WHERE account_scope='ambiguous';
        UPDATE saved_spaces SET access_state='blocked', access_reason='Denied' WHERE account_scope='blocked';
        INSERT INTO course_spaces SELECT * FROM saved_spaces;
        DROP TABLE saved_spaces; PRAGMA user_version=8;`);
      assert.throws(
        () => db.exec("UPDATE course_spaces SET checked_at=NULL"),
        /NOT NULL/,
      );
    } finally {
      db.close();
    }
    store = createStore(path);
    const ambiguous = store.courseSpaces({
      accountScope: "ambiguous",
      courseId: "1",
    })[0]!;
    assert.equal(ambiguous.accessState, "unknown");
    assert.equal(ambiguous.checkedAt, null);
    assert.equal(ambiguous.title, "Page");
    assert.equal(store.resources().length, 3);
    const read = store.courseSpaces({
      accountScope: "read",
      courseId: "1",
    })[0]!;
    assert.equal(read.accessState, "readable");
    assert.equal(read.checkedAt, at);
    assert.ok(read.lastReadAt);
    const blocked = store.courseSpaces({
      accountScope: "blocked",
      courseId: "1",
    })[0]!;
    assert.equal(blocked.accessState, "blocked");
    assert.equal(blocked.checkedAt, at);
    assert.equal(blocked.accessReason, "Denied");
    assert.ok(blocked.lastReadAt);
    store.close();
    store = createStore(path);
    assert.deepEqual(
      store.courseSpaces({ accountScope: "ambiguous", courseId: "1" }),
      [ambiguous],
    );
    assert.deepEqual(
      store.courseSpaces({ accountScope: "read", courseId: "1" }),
      [read],
    );
    assert.deepEqual(
      store.courseSpaces({ accountScope: "blocked", courseId: "1" }),
      [blocked],
    );
    const check = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(
        check.prepare("PRAGMA user_version").get()!.user_version,
        SCHEMA_VERSION,
      );
      assert.deepEqual(check.prepare("PRAGMA foreign_key_check").all(), []);
      assert.equal(
        check
          .prepare(
            "SELECT \"notnull\" AS required FROM pragma_table_info('course_spaces') WHERE name='checked_at'",
          )
          .get()!.required,
        0,
      );
    } finally {
      check.close();
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file download and preview aliases find saved evidence without confusing another course", () => {
  const store = createStore(":memory:");
  try {
    seed(store, "a");
    store.ingest({
      source: {
        id: "file-a",
        label: "File",
        kind: "canvas",
        accountScope: "a",
        courseId: "1",
        scope: "file:9",
      },
      observedAt: at,
      complete: true,
      status: "ok",
      resources: [
        {
          externalId: "9",
          kind: "material",
          courseId: "1",
          courseName: "Course",
          title: "Reading",
          url: "https://canvas.wisc.edu/courses/1/files/9",
          text: "Captured reading",
          deadlines: [],
        },
      ],
    });
    const urls = [
      "/files/9",
      "/files/9/download",
      "/courses/1/files/9/preview",
      "/courses/2/files/9",
    ];
    for (const path of urls)
      persistCourseSpaces(store, "a", "1", [
        {
          ...space(),
          kind: "canvas_file",
          url: `https://canvas.wisc.edu${path}`,
        },
      ]);
    const saved = store.courseSpaces();
    for (const path of urls.slice(0, 3))
      assert.ok(saved.find((s) => s.url.endsWith(path))?.lastReadAt, path);
    assert.equal(saved.find((s) => s.url.endsWith(urls[3]!))?.lastReadAt, null);
  } finally {
    store.close();
  }
});
