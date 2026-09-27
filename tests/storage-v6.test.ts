import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import {
  createStore,
  migrationBackupPath,
  MigrationError,
  restoreMigrationBackup,
  SCHEMA_VERSION,
} from "@magic/storage";
import { textHash } from "@magic/retrieval";
import type { CaptureBatch, PlanningCapture, ResourceInput } from "@magic/contracts";
import { LIFE_COURSE_ID } from "../packages/contracts/src/course-core";
import { LEARNING_TABLES } from "../packages/storage/src/learning";
import { createDrain } from "../packages/core/src/drain";
// The dead `passages.build` handler is gone (one drain, WP1); these storage tests queue the live
// text-keyed passages kind directly and rebuild through the store.
const PASSAGES_JOB_KIND = "passages.resource";
const enqueuePassages = (
  store: { enqueueSubject(job: { kind: string; subjectKind: "resource"; subjectId: string; inputHash: string }, now: string): boolean },
  resourceId: string,
  inputHash: string,
  now: string,
) => store.enqueueSubject({ kind: PASSAGES_JOB_KIND, subjectKind: "resource", subjectId: resourceId, inputHash }, now);

// Synthetic data only.
const t = (seconds: number) => new Date(Date.UTC(2099, 0, 1, 0, 0, seconds)).toISOString();
const TOKEN = "Zebrafishquokka";
const item = (externalId = "a1", extra: Partial<ResourceInput> = {}): ResourceInput => ({
  externalId,
  kind: "assignment",
  courseId: "course-1",
  courseName: "Example Biology",
  title: "Cells and membranes",
  url: `https://canvas.example.test/assignments/${externalId}`,
  text: "Compare transport across cell membranes. Osmosis moves water toward higher solute concentration.",
  deadlines: [],
  points: 10,
  submitted: false,
  policy: { mode: "coaching", evidence: "Hints are permitted." },
  ...extra,
});
const SYLLABUS =
  "BIO 101 Syllabus\n\nThe midterm exam is on October 14 and covers chapters 1-4.\n\n" +
  "Grading: the midterm is worth 25% of the final grade. Late work loses 10% per day.\n\n" +
  `Office hours are Tuesdays 2-3pm with Dr. ${TOKEN}.`;
const batch = (seconds: number, resources = [item()], extra: Partial<CaptureBatch> = {}): CaptureBatch => ({
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
const planning = (): PlanningCapture => ({
  schemaVersion: 1,
  id: "capture-1",
  accountScope: "local-account-a",
  source: "normalized_import",
  scope: { kind: "degree_plan", key: "primary" },
  sourceUrl: "https://enroll.wisc.edu/",
  observedAt: "2026-09-26T12:00:00Z",
  status: "complete",
  completeness: "complete",
  records: [
    {
      id: "attempt",
      kind: "course_history",
      provenance: {
        sourceUrl: "https://enroll.wisc.edu/",
        observedAt: "2026-09-26T12:00:00Z",
        scope: { kind: "degree_plan", key: "primary" },
      },
      courseKey: "uw:266:300",
      termCode: "1264",
      state: "completed",
      credits: 3,
      grade: "AB",
      gpaEligible: true,
    },
  ],
  diagnostics: [],
});

function temporary() {
  const directory = mkdtempSync(join(tmpdir(), "magic-v6-"));
  return { directory, file: join(directory, "workspace.sqlite"), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

/** A populated store: resources (one later deleted), versions, planning, jobs, judgments, links, attempts, receipts. */
function populate(file: string) {
  const store = createStore(file);
  store.ingest(
    batch(0, [
      item(),
      item("m1", { kind: "material", title: "Transport reading", text: `Diffusion and ${TOKEN} channels.` }),
      item("old", { title: "Removed later", text: "This item disappears from the capture." }),
      item("syl", { kind: "material", title: "Syllabus", text: SYLLABUS }),
    ]),
  );
  store.ingest(
    batch(1, [
      item("a1", { text: "Updated: compare active and passive transport across membranes." }),
      item("m1", { kind: "material", title: "Transport reading", text: `Diffusion and ${TOKEN} channels.` }),
      item("syl", { kind: "material", title: "Syllabus", text: SYLLABUS }),
    ]),
  );
  store.ingestPlanning(planning());
  const [a, m] = store.resources();
  store.setCompleted(a!.id, true);
  store.putJudgment({
    key: "k1", resourceId: a!.id, inputHash: a!.contentHash, model: "m", questionVersion: "q", result: { ok: 1 }, createdAt: t(2),
  });
  store.putLink({
    id: "l1", fromId: a!.id, toId: m!.id, type: "supports", reason: "Related.", status: "proposed", inputHash: a!.contentHash,
  });
  store.addAttempt({
    id: "at1", resourceId: a!.id, itemId: "i1", skill: "s", correct: true, assistance: "none", seenBefore: false, confidence: 0.5, createdAt: t(3),
  });
  store.addReceipt({
    id: "r1", recipient: "jev", purpose: "p", categories: ["course_text"], resourceIds: [a!.id], characters: 10, status: "sent", createdAt: t(3),
  });
  store.addSyncRun({ id: "run", startedAt: t(0), finishedAt: t(1), status: "ok", action: "manual" });
  store.setCourseOverride({ accountScope: "student-1", courseId: "course-1", included: true });
  return store;
}

/** Turns a v6 file into the exact v5 shape (the shipped v1–v5 DDL), with field history rows. */
const TO_V5 = `
  ${LEARNING_TABLES.slice().reverse().map((t) => `DROP TABLE ${t};`).join(" ")}
  DROP TABLE resource_refs; DROP TABLE external_refs;
  DROP TABLE note_sync_settings; DROP TABLE note_remotes; DROP TABLE note_suggestions; DROP TABLE note_template_choices;
  DROP TABLE note_links; DROP TABLE note_versions; DROP TABLE notes;
  DROP TABLE passage_vocab; DROP TABLE passage_fts; DROP TABLE passages; DROP TABLE counters;
  DROP TABLE assessment_scope; DROP TABLE assessments; DROP TABLE course_sessions; DROP TABLE map_links;
  DROP TABLE course_spaces; DROP TABLE extraction_recipes; DROP TABLE course_briefs; DROP TABLE material_facts;
  DROP TABLE life_items; DROP TABLE compile_runs; DROP TABLE ledger; DROP TABLE ui_events;
  DROP INDEX judgments_resource; DROP INDEX links_from; DROP INDEX links_to; DROP INDEX sources_course;
  DROP INDEX resource_changes_seq; DROP INDEX resource_changes_resource; DROP INDEX resource_changes_source;
  ALTER TABLE resources DROP COLUMN text_hash; ALTER TABLE resource_versions DROP COLUMN text_hash;
  ALTER TABLE resource_changes DROP COLUMN seq;
  CREATE TABLE jobs_v5 (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL,
    resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    input_hash TEXT NOT NULL, status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, run_after TEXT NOT NULL,
    lease_until TEXT, lease_token TEXT, error TEXT,
    UNIQUE (kind, resource_id, input_hash)
  );
  INSERT INTO jobs_v5 SELECT id,kind,resource_id,input_hash,status,attempts,run_after,lease_until,lease_token,error FROM jobs ORDER BY rowid;
  DROP TABLE jobs; ALTER TABLE jobs_v5 RENAME TO jobs; CREATE INDEX jobs_available ON jobs (status, run_after);
  CREATE TABLE fo_v5 (
    resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE, field TEXT NOT NULL,
    observed_at TEXT NOT NULL, read_id TEXT NOT NULL, version INTEGER NOT NULL,
    PRIMARY KEY(resource_id, field, observed_at)
  );
  INSERT INTO fo_v5 SELECT * FROM field_observations;
  INSERT INTO fo_v5 SELECT resource_id, field, '2000-01-01T00:00:00.000Z', 'older-read', version FROM field_observations;
  DROP TABLE field_observations; ALTER TABLE fo_v5 RENAME TO field_observations;
  UPDATE resource_versions SET payload = payload_json(payload);
  CREATE VIRTUAL TABLE resource_search USING fts5(resource_id UNINDEXED, title, course_name, body);
  INSERT INTO resource_search SELECT r.id, json_extract(v.payload,'$.title'), json_extract(v.payload,'$.courseName'),
    json_extract(v.payload,'$.text') FROM resources r JOIN resource_versions v ON v.resource_id=r.id AND v.version=r.version
    WHERE r.deleted=0;
  PRAGMA user_version = 5;
`;
const V5_TABLES = [
  "attempts", "completions", "course_intelligence", "course_overrides", "field_observations", "jobs", "judgments",
  "links", "mcp_grants", "observations", "planning_captures", "planning_records", "planning_sources",
  "planning_versions", "preferences", "receipts", "resource_changes", "resource_search", "resource_versions",
  "resources", "scope_baselines", "source_observations", "sources", "sync_runs",
];

function seedV5(file: string) {
  populate(file).close();
  const db = new DatabaseSync(file);
  // v5 stored payloads as JSON text.
  db.function("payload_json", (value: unknown) =>
    value instanceof Uint8Array ? inflateRawSync(value).toString("utf8") : String(value),
  );
  db.exec("PRAGMA foreign_keys = OFF;" + TO_V5);
  db.close();
}
function tables(db: DatabaseSync): string[] {
  return (
    db.prepare("SELECT name FROM pragma_table_list WHERE schema='main' AND type IN ('table','virtual') AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]
  ).map((r) => r.name);
}
function counts(file: string): Record<string, number> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Object.fromEntries(
      (db.prepare("SELECT name FROM pragma_table_list WHERE schema='main' AND type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
        .filter((r) => !/_(data|idx|content|docsize|config)$/.test(r.name))
        .map((r) => [r.name, Number(db.prepare(`SELECT count(*) AS n FROM "${r.name}"`).get()!.n)]),
    );
  } finally {
    db.close();
  }
}
function dump(file: string, table: string): unknown[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
  } finally {
    db.close();
  }
}

test("v5 → current (v6 course core, v7 learning) keeps every row, planning and course_intelligence byte-for-byte; backfills hashes, seq and passages", () => {
  const { file, cleanup } = temporary();
  try {
    seedV5(file);
    const v5db = new DatabaseSync(file, { readOnly: true });
    assert.deepEqual(tables(v5db), V5_TABLES, "the fixture has exactly the shipped v5 tables");
    v5db.close();
    const before = counts(file);
    const planningBefore = ["planning_sources", "planning_captures", "planning_records", "planning_versions", "course_intelligence"].map((t) => dump(file, t));
    const fieldPairs = new DatabaseSync(file, { readOnly: true });
    const distinctFields = Number(fieldPairs.prepare("SELECT count(*) AS n FROM (SELECT DISTINCT resource_id, field FROM field_observations)").get()!.n);
    fieldPairs.close();
    assert.ok(before.planning_records! > 0 && before.course_intelligence! > 0 && before.jobs! > 0 && before.links! > 0);
    assert.ok(before.field_observations! > distinctFields, "the fixture carries field history");

    const started = performance.now();
    const store = createStore(file);
    const migrationMs = performance.now() - started;
    try {
      const after = counts(file);
      for (const [table, n] of Object.entries(before)) {
        if (table === "resource_search") assert.equal(after[table], undefined, "resource_search is dropped");
        else if (table === "field_observations") assert.equal(after[table], distinctFields, "latest per field");
        else assert.equal(after[table], n, `${table} keeps every row`);
      }
      assert.deepEqual(
        ["planning_sources", "planning_captures", "planning_records", "planning_versions", "course_intelligence"].map((t) => dump(file, t)),
        planningBefore,
      );
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, SCHEMA_VERSION);
        assert.equal(
          db.prepare("SELECT count(*) AS n FROM field_observations WHERE observed_at = '2000-01-01T00:00:00.000Z'").get()!.n,
          0,
          "the latest observation wins",
        );
        for (const v of db.prepare("SELECT payload, text_hash FROM resource_versions").all() as { payload: string; text_hash: string }[]) {
          const p = JSON.parse(v.payload) as ResourceInput;
          assert.equal(v.text_hash, textHash(p.title, p.text));
        }
        const seqs = (db.prepare("SELECT seq FROM resource_changes ORDER BY observed_at, rowid").all() as { seq: number }[]).map((r) => r.seq);
        assert.deepEqual(seqs, seqs.map((_, i) => i + 1));
        assert.equal(db.prepare("SELECT value FROM counters WHERE name='change_seq'").get()!.value, seqs.length);
        assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
      } finally {
        db.close();
      }
      // Passages were built for live resources in the migration; the deleted one has none.
      const live = store.resources();
      assert.equal(live.length, 3);
      for (const r of live) assert.ok(store.passages(r.id).length >= 1);
      const found = store.searchPassages({ query: "when is the midterm exam" });
      assert.equal(found.notFound, false);
      assert.equal(found.hits[0]!.title, "Syllabus");
      // Jobs keep their order and become resource-subject jobs.
      assert.ok(store.jobs().every((j) => (j as { subjectKind?: string }).subjectKind === "resource"));
      // The change feed continues from the backfilled counter.
      const n = store.changesAfter(0, 2000).length;
      store.ingest(batch(5, [item("new-one")], { complete: false }));
      const next = store.changesAfter(n);
      assert.equal(next.length, 1);
      assert.equal(next[0]!.seq, n + 1);
      // privacy (lead decision, September 27): the v5 backup is a plaintext copy; once the migrated
      // database passes integrity_check and every carried-over table's row count, it is deleted.
      assert.equal(store.backupCheck()?.status, "deleted");
      assert.equal(store.migrationBackup(), null);
      assert.equal(existsSync(migrationBackupPath(file)), false);
      assert.ok(migrationMs < 2000, `migration took ${migrationMs} ms`);
    } finally {
      store.close();
    }
  } finally {
    cleanup();
  }
});

test("a failed migration leaves the original database intact and keeps the backup; the next open resumes", () => {
  const { file, cleanup } = temporary();
  try {
    seedV5(file);
    // A conflicting object makes the v6 step fail midway (after the column and job changes ran).
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE ledger (x TEXT); INSERT INTO ledger VALUES ('conflict');");
    db.close();
    const before = counts(file);
    const schemaBefore = dump(file, "sqlite_schema");
    assert.throws(
      () => createStore(file),
      (error: unknown) =>
        error instanceof MigrationError && error.from === 5 && error.backup === migrationBackupPath(file) && /unchanged/.test(error.message),
    );
    assert.deepEqual(counts(file), before, "every row is where it was");
    assert.deepEqual(dump(file, "sqlite_schema"), schemaBefore, "no schema change survived");
    const check = new DatabaseSync(file, { readOnly: true });
    assert.equal(check.prepare("PRAGMA user_version").get()!.user_version, 5);
    assert.equal(check.prepare("PRAGMA quick_check").get()!.quick_check, "ok");
    check.close();
    assert.ok(existsSync(migrationBackupPath(file)));
    const fix = new DatabaseSync(file);
    fix.exec("DROP TABLE ledger;");
    fix.close();
    const store = createStore(file);
    assert.equal(store.resources().length, 3);
    store.close();
  } finally {
    cleanup();
  }
});

test("a database newer than this schema is refused and left alone", () => {
  const { file, cleanup } = temporary();
  try {
    createStore(file).close();
    const db = new DatabaseSync(file);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    assert.throws(() => createStore(file), /newer My Magic UW version/);
    const again = new DatabaseSync(file, { readOnly: true });
    assert.equal(again.prepare("PRAGMA user_version").get()!.user_version, SCHEMA_VERSION + 1);
    again.close();
  } finally {
    cleanup();
  }
});

test("the backup restores through SQLite's backup API while a reader is open", async () => {
  const { file, cleanup } = temporary();
  try {
    seedV5(file);
    // A verified migration deletes its backup (privacy, September 27); a backup is kept only when the
    // check fails. Stand in for that kept backup with the v5 file itself.
    copyFileSync(file, `${file}.v5`);
    createStore(file).close(); // migrates
    copyFileSync(`${file}.v5`, migrationBackupPath(file));
    const reader = new DatabaseSync(file, { readOnly: true });
    reader.exec("BEGIN");
    reader.prepare("SELECT count(*) FROM resources").get();
    await restoreMigrationBackup(file);
    reader.exec("COMMIT");
    reader.close();
    const db = new DatabaseSync(file, { readOnly: true });
    assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 5);
    assert.equal(db.prepare("PRAGMA quick_check").get()!.quick_check, "ok");
    db.close();
  } finally {
    cleanup();
  }
});

test("purge enumerates every table: zero rows everywhere, FTS empty, backup deleted, planted token gone", () => {
  const { file, cleanup } = temporary();
  try {
    seedV5(file);
    const store = createStore(file);
    try {
      const syllabus = store.resources().find((r) => r.title === "Syllabus")!;
      store.putAssessment({ id: "mid", sourceId: "canvas-course-1", resourceId: null, kind: "midterm", title: "Midterm", date: "2099-10-14", weight: 25, format: null, origin: "syllabus" }, t(9));
      assert.deepEqual(
        store.putAssessmentScope({ id: "s1", assessmentId: "mid", stated: "Chapters 1-4", evidence: { resourceId: syllabus.id, version: syllabus.version, quote: "covers chapters 1-4." }, windowStart: null, windowEnd: null, status: "settled", rung: "code" }, t(9)),
        { ok: true },
      );
      store.putCourseSession({ id: "w1", sourceId: "canvas-course-1", date: "2099-09-01", ordinal: 1, title: "Week 1", topicIds: [], origin: "syllabus" });
      store.putMapLink({ id: "ml", sourceId: "canvas-course-1", fromKind: "assessment", fromId: "mid", toResourceId: syllabus.id, kind: "covers", tier: "core", reason: "Stated scope.", rung: "code", status: "settled" }, t(9));
      store.putExtractionRecipe({ id: "rec", host: "example.test", layoutHash: "h", version: 1, recipe: { selector: "main" }, validatedAt: null });
      store.putCourseSpace({ id: "sp", sourceId: "canvas-course-1", kind: "external_tool", host: "tool.example.test", url: "https://tool.example.test/x", title: TOKEN, foundInResourceId: syllabus.id, route: "lti", readState: "skipped", readSourceId: null, lastReadAt: null, recipeId: "rec", accessState: "link-only", accessReason: null, checkedAt: t(9), storeOrLink: "link" });
      assert.deepEqual(store.putMaterialFacts({ resourceId: syllabus.id, textHash: textHash(syllabus.title, syllabus.text), analyzerVersion: "a1", facts: [{ kind: "term", start: 0, end: 7, value: "BIO 101" }] }), { ok: true });
      const ref = store.putExternalRef({ sourceId: "canvas-course-1", url: "https://tool.example.test/reading", title: TOKEN, hostClass: "unknown", treatment: "link", foundInResourceId: syllabus.id }, t(9));
      assert.deepEqual(store.putResourceRefs(syllabus.id, syllabus.contentHash, [{ toResourceId: null, externalRefId: ref, target: "https://tool.example.test/reading", kind: "external", strength: "direct", reason: "linked in the body" }]), { ok: true });
      store.addLedgerEntry({ id: "le", pack: "p", packVersion: "1", tier: "fast", model: "m", tokensIn: 1, tokensCached: 0, tokensOut: 1, latencyMs: 1, checkFailures: 0, escalated: false, course: null, createdAt: t(9) });
      store.addCompileRun({ id: "cr", course: { accountScope: "student-1", courseId: "course-1" }, packVersion: "1", model: "m", tier: "fast", inputHash: "h", tokens: 1, latencyMs: 1, checkFailures: 0, escalated: false, createdAt: t(9) });
      store.addUiEvent({ kind: "open", subject: TOKEN, createdAt: t(9) });
      store.enqueueSubject({ kind: "course.compile", subjectKind: "course", subjectId: "student-1:course-1", sourceId: "canvas-course-1", inputHash: "h" }, t(9));
      // v11 notes: one of each row, the planted token in the note's text.
      const block = { id: "notes", kind: "section" as const, heading: "Notes", items: [{ id: "i", text: TOKEN, origin: "student" as const }] };
      store.notes.insert({ id: "n1", accountScope: "student-1", courseId: "course-1", sessionId: "course-1/2099-09-01:lecture", session: null, sessionDate: "2099-09-01", sessionType: "lecture", moduleId: null, moduleName: null, title: "Lecture", template: "outline", templateReason: "t", state: "edited", scaffoldHash: null, scheduled: true, editedAt: t(9) }, [block], "student");
      store.notes.setLinks("n1", [{ resourceId: syllabus.id, role: "reading", reason: "t" }]);
      store.notes.setTemplateChoice("student-1", "course-1", "lecture", "outline");
      store.notes.addSuggestions("n1", [{ id: "sg", blockId: "notes", text: "t", resourceId: syllabus.id, quote: "q" }]);
      store.notes.putRemote({ noteId: "n1", provider: "google", remoteId: "r", webUrl: null, etag: null, modifiedTime: null, syncedVersion: 1, syncedAt: t(9), status: "synced", error: null });
      store.notes.setSyncSetting({ provider: "google", enabled: true, enabledAt: t(9), lastCheckAt: null, message: null });
      assert.equal(store.migrationBackup(), null, "the verified v5 backup was deleted after migration (privacy)");
      for (const [table, n] of Object.entries(counts(file)))
        // platform-fix: observations and source_observations were never read and are no longer written.
        if (!["preferences", "life_items", "course_briefs", "mcp_grants", "observations", "source_observations"].includes(table) && !table.startsWith("learning_")) assert.ok(n > 0, `${table} is populated before purge`);

      const onDisk = () =>
        [file, `${file}-wal`, migrationBackupPath(file)]
          .filter((path) => existsSync(path))
          .some((path) => readFileSync(path).toString("latin1").toLowerCase().includes(TOKEN.toLowerCase()));
      assert.equal(onDisk(), true, "the planted token is on disk before purge");
      store.purge();
      assert.equal(onDisk(), false, "no database, WAL or backup file holds the token after purge");
      const after = counts(file);
      for (const [table, n] of Object.entries(after)) assert.equal(n, 0, `${table} is empty`);
      const db = new DatabaseSync(file, { readOnly: true });
      assert.equal(db.prepare("SELECT count(*) AS n FROM passage_fts").get()!.n, 0);
      assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_sequence").get()!.n, 0);
      db.close();
      assert.equal(store.migrationBackup(), null);
      assert.equal(existsSync(migrationBackupPath(file)), false);
      assert.equal(store.searchPassages({ query: TOKEN }).hits.length, 0);
    } finally {
      store.close();
    }
    for (const path of [file, `${file}-wal`])
      if (existsSync(path)) {
        const bytes = readFileSync(path).toString("latin1").toLowerCase();
        assert.equal(bytes.includes(TOKEN.toLowerCase()), false, `${path} holds no planted token`);
      }
  } finally {
    cleanup();
  }
});

test("the _life sentinel carries life sources without a course: no course record, no access chip", () => {
  const store = createStore(":memory:");
  try {
    const report = store.ingest({
      source: { id: "feeds", label: "Campus feeds", kind: "web", accountScope: "student-1", courseId: LIFE_COURSE_ID, scope: "news" },
      observedAt: t(0),
      complete: true,
      status: "ok",
      resources: [item("n1", { courseId: LIFE_COURSE_ID, courseName: "Life", kind: "message", title: "Library hours", text: "Open late." })],
    });
    assert.equal(report.created, 1);
    assert.equal(store.courseIntelligence().filter((c) => c.courseId === LIFE_COURSE_ID).length, 0);
    store.putLifeItem({ id: "li", sourceId: "feeds", area: "news", courseId: null, sender: "UW News", title: "Library hours", date: t(0), labels: ["campus"], link: "https://news.example.test/a", duplicateOf: null, gist: "Open late this week." });
    assert.equal(store.lifeItems("news").length, 1);
    assert.throws(() =>
      store.putCourseSpace({ id: "x", sourceId: "feeds", kind: "page", host: "h", url: "https://h.example.test", title: null, foundInResourceId: null, route: "public", readState: "found", readSourceId: null, lastReadAt: null, recipeId: null, accessState: "readable", accessReason: null, checkedAt: t(0), storeOrLink: "store" }),
    );
    assert.deepEqual(store.courseAccessSummary(), []);
  } finally {
    store.close();
  }
});

test("lease(kinds) serves only the named kinds, with a staleness rule per subject; text jobs survive a grade change", () => {
  const store = createStore(":memory:");
  try {
    store.ingest(batch(0));
    const r = store.resources()[0]!;
    const th = textHash(r.title, r.text);
    assert.equal(enqueuePassages(store, r.id, th, t(0)), true);
    assert.equal(enqueuePassages(store, r.id, th, t(0)), false, "no duplicate");
    assert.equal(enqueuePassages(store, r.id, "stale-hash", t(0)), false, "stale at enqueue");
    assert.equal(store.enqueueSubject({ kind: "course.compile", subjectKind: "course", subjectId: "student-1:course-1", sourceId: "canvas-course-1", inputHash: "c1" }, t(0)), true);
    assert.equal(store.enqueueSubject({ kind: "course.compile", subjectKind: "course", subjectId: "student-1:other", sourceId: "canvas-course-1", inputHash: "c1" }, t(0)), false, "subject must be the source's course");
    assert.throws(() => store.enqueueSubject({ kind: "course.compile", subjectKind: "course", subjectId: "student-1:course-1", inputHash: "c1" }, t(0)), /cascades/);
    assert.equal(store.lease(t(1), 1000, ["unregistered.kind"]), undefined);
    const course = store.lease(t(1), 1000, ["course.compile"])!;
    assert.equal(course.kind, "course.compile");
    assert.equal(course.subjectKind, "course");
    assert.equal(course.resourceId, "");
    assert.equal(store.finish(course, undefined, t(1)), true);
    // A submission flip changes the content hash, not the text hash.
    store.ingest(batch(2, [{ ...item(), submitted: true }]));
    assert.notEqual(store.resource(r.id)!.contentHash, r.contentHash);
    const passagesJob = store.lease(t(3), 1000, [PASSAGES_JOB_KIND])!;
    assert.equal(passagesJob.kind, PASSAGES_JOB_KIND);
    assert.equal(store.finish(passagesJob, undefined, t(3)), true);
    // The content-keyed job from the first ingest went stale; nothing else is due.
    const enrich = store.jobs().filter((j) => j.kind === "enrich.resource");
    assert.ok(enrich.some((j) => j.inputHash === r.contentHash && j.status === "failed"));
    // A text change stales a text-keyed job.
    assert.equal(store.enqueueSubject({ kind: "card.build", subjectKind: "resource", subjectId: r.id, inputHash: th }, t(4)), true);
    store.ingest(batch(5, [item("a1", { text: "Entirely new instructions." })]));
    assert.equal(store.lease(t(6), 1000, ["card.build"]), undefined);
    assert.equal(store.jobs().find((j) => j.kind === "card.build")!.status, "failed");
    // Assessment subjects are stale once the assessment is gone.
    assert.equal(store.enqueueSubject({ kind: "scope.settle", subjectKind: "assessment", subjectId: "missing", sourceId: "canvas-course-1", inputHash: "x" }, t(6)), false);
  } finally {
    store.close();
  }
});

test("the drain serves only its registered kinds, never spins, and a failing handler backs off", async () => {
  const store = createStore(":memory:");
  try {
    store.ingest(batch(0, [item(), item("m1", { title: "Reading", text: "Membranes and channels." })]));
    let clock = 10;
    const now = () => t(clock);
    for (const r of store.resources()) enqueuePassages(store, r.id, textHash(r.title, r.text), now());
    store.enqueueSubject({ kind: "flaky", subjectKind: "source", subjectId: "canvas-course-1", sourceId: "canvas-course-1", inputHash: "f" }, now());
    let rebuilt = 0;
    let flakyCalls = 0;
    const drain = createDrain({
      store,
      now,
      handlers: {
        [PASSAGES_JOB_KIND]: (job) => {
          rebuilt++;
          store.rebuildPassages(job.subjectId);
        },
        flaky: () => {
          flakyCalls++;
          throw new Error("temporary");
        },
      },
    });
    assert.deepEqual([...drain.kinds].sort(), ["flaky", PASSAGES_JOB_KIND].sort());
    const [first, shared] = await Promise.all([drain.run(), drain.run()]);
    assert.equal(first, shared, "concurrent runs share one run");
    assert.deepEqual(first, { done: 2, failed: 1, skipped: 0 });
    assert.equal(rebuilt, 2);
    assert.equal(flakyCalls, 1, "a failed job waits for its backoff");
    // enrich.resource jobs are not ours: untouched, still pending.
    assert.ok(store.jobs().filter((j) => j.kind === "enrich.resource").every((j) => j.status === "pending"));
    assert.deepEqual(await drain.run(), { done: 0, failed: 0, skipped: 0 }, "nothing due: the run ends");
    clock += 120;
    assert.deepEqual(await drain.run(), { done: 0, failed: 1, skipped: 0 });
    clock += 120;
    await drain.run();
    assert.equal(flakyCalls, 3);
    assert.equal(store.jobs().find((j) => j.kind === "flaky")!.status, "failed", "the retry limit ends it");
    clock += 120;
    assert.deepEqual(await drain.run(), { done: 0, failed: 0, skipped: 0 });
  } finally {
    store.close();
  }
});

test("course records: scopes and briefs are quote-checked by code; a correction wins; access summary counts (D41)", () => {
  const store = createStore(":memory:");
  try {
    store.ingest(batch(0, [item("syl", { kind: "material", title: "Syllabus", text: SYLLABUS })]));
    const syl = store.resources()[0]!;
    // An assessment named only in the syllabus exists without a resource.
    store.putAssessment({ id: "mid", sourceId: "canvas-course-1", resourceId: null, kind: "midterm", title: "Midterm", date: "2099-10-14", weight: 25, format: "in person", origin: "syllabus" }, t(1));
    assert.equal(store.assessments({ accountScope: "student-1", courseId: "course-1" })[0]!.resourceId, null);
    const scope = { id: "s1", assessmentId: "mid", stated: "Chapters 1-4", windowStart: null, windowEnd: null, status: "settled", rung: "pass" } as const;
    const bad = store.putAssessmentScope({ ...scope, evidence: { resourceId: syl.id, version: syl.version, quote: "covers the first four chapters" } }, t(1));
    assert.equal(bad.ok, false, "a paraphrase is refused");
    assert.equal(store.putAssessmentScope({ ...scope, evidence: { resourceId: syl.id, version: syl.version, quote: "covers chapters 1-4.", start: 0, end: 3 } }, t(1)).ok, true);
    const saved = store.assessmentScopes("mid")[0]!;
    assert.equal(SYLLABUS.slice(saved.evidence!.start, saved.evidence!.end), "covers chapters 1-4.", "offsets repaired");
    assert.equal(store.putAssessmentScope({ ...scope, stated: "Chapters 1-5", status: "corrected", rung: "student", evidence: null }, t(2)).ok, true);
    assert.equal(store.putAssessmentScope({ ...scope, stated: "Chapters 1-4", evidence: null }, t(3)).ok, false, "a correction is never rewritten by the system");
    assert.equal(store.assessmentScopes("mid")[0]!.stated, "Chapters 1-5");

    const quoted = (quote: string) => ({ quote, start: 0, end: 0 });
    const brief = {
      schedule: [{ date: "2099-10-14", title: "Midterm", ...quoted("The midterm exam is on October 14") }],
      assessments: [{ title: "Midterm", kind: "midterm" as const, date: "2099-10-14", weight: 25, scope: "chapters 1-4", ...quoted("the midterm is worth 25% of the final grade") }],
      grading: [{ label: "Late work", value: "10% per day", ...quoted("Late work loses 10% per day.") }],
      policies: [],
      texts: [],
      staff: [{ name: "Instructor", role: "instructor", officeHours: "Tue 2-3pm", ...quoted("Office hours are Tuesdays 2-3pm") }],
    };
    const input = { sourceId: "canvas-course-1", syllabusResourceId: syl.id, textHash: textHash(syl.title, syl.text), passVersion: "course-pass.v1", brief, prefixText: "Course brief v1", compileRunId: null };
    assert.equal(store.putCourseBrief({ ...input, textHash: "old" }, t(1)).ok, false, "a stale text hash is refused");
    const wrong = store.putCourseBrief({ ...input, brief: { ...brief, grading: [{ label: "Late", value: "5%", ...quoted("Late work loses 5% per day.") }] } }, t(1));
    assert.equal(wrong.ok, false);
    assert.equal(store.putCourseBrief(input, t(1)).ok, true);
    const stored = store.courseBrief({ accountScope: "student-1", courseId: "course-1" })!;
    assert.equal(SYLLABUS.slice(stored.brief.grading[0]!.start, stored.brief.grading[0]!.end), "Late work loses 10% per day.");
    assert.match(stored.prefixHash, /^[0-9a-f]{64}$/);
    // A changed syllabus retires the brief until it's re-derived.
    store.ingest(batch(2, [item("syl", { kind: "material", title: "Syllabus", text: SYLLABUS + "\n\nUpdated." })]));
    assert.equal(store.courseBrief({ accountScope: "student-1", courseId: "course-1" }), undefined);

    assert.equal(store.putMaterialFacts({ resourceId: syl.id, textHash: "stale", analyzerVersion: "a", facts: [] }).ok, false);

    const space = (id: string, accessState: "readable" | "needs-uw-signin" | "needs-own-login" | "link-only" | "blocked") =>
      store.putCourseSpace({ id, sourceId: "canvas-course-1", kind: "external_url", host: `${id}.example.test`, url: `https://${id}.example.test/`, title: null, foundInResourceId: syl.id, route: "public", readState: "found", readSourceId: null, lastReadAt: null, recipeId: null, accessState, accessReason: accessState === "blocked" ? "HTTP 500" : null, checkedAt: t(3), storeOrLink: accessState === "link-only" ? "link" : "store" });
    space("a", "readable");
    space("b", "needs-uw-signin");
    space("c", "needs-uw-signin");
    space("d", "needs-own-login");
    space("e", "link-only");
    space("f", "blocked");
    assert.deepEqual(store.courseAccessSummary(), [
      { accountScope: "student-1", courseId: "course-1", total: 6, readable: 1, needsUwSignin: 2, needsOwnLogin: 1, linkOnly: 1, blocked: 1, needsAttention: 3, lastCheckedAt: t(3) },
    ]);
    store.putExtractionRecipe({ id: "r", host: "a.example.test", layoutHash: "L", version: 1, recipe: { main: "article" }, validatedAt: t(3) });
    store.recordRecipeUse("r", true);
    store.recordRecipeUse("r", false);
    assert.deepEqual([store.extractionRecipe("a.example.test", "L")!.hits, store.extractionRecipe("a.example.test", "L")!.misses], [1, 1]);

    store.putMapLink({ id: "m", sourceId: "canvas-course-1", fromKind: "assessment", fromId: "mid", toResourceId: syl.id, kind: "covers", tier: "core", reason: "Syllabus scope.", rung: "student", status: "settled" }, t(4));
    assert.equal(store.putMapLink({ id: "m", sourceId: "canvas-course-1", fromKind: "assessment", fromId: "mid", toResourceId: syl.id, kind: "covers", tier: "practice", reason: "Jev.", rung: "jev", status: "proposed" }, t(5)).ok, false);
    assert.equal(store.mapLinks()[0]!.tier, "core");
    store.addUiEvent({ kind: "move_tier", subject: "m", createdAt: t(5) });
    assert.equal(store.uiEvents(1)[0]!.kind, "move_tier");
  } finally {
    store.close();
  }
});

test("T14: a judgment keyed to the text hash survives a submission flip; one keyed to the content hash doesn't", () => {
  const store = createStore(":memory:");
  try {
    store.ingest(batch(0));
    const r = store.resources()[0]!;
    const th = textHash(r.title, r.text);
    const base = { resourceId: r.id, model: "m", questionVersion: "item.card.v1", result: { role: "reading" }, createdAt: t(1) };
    assert.equal(store.putJudgment({ ...base, key: "text", inputHash: th }), true);
    assert.equal(store.putJudgment({ ...base, key: "content", inputHash: r.contentHash }), true);
    store.ingest(batch(2, [{ ...item(), submitted: true, points: 12 }]));
    assert.ok(store.judgment("text"), "text judgment still served");
    assert.equal(store.judgment("content"), undefined);
    store.ingest(batch(3, [item("a1", { text: "New text." })]));
    assert.equal(store.judgment("text"), undefined, "a text change retires it");
  } finally {
    store.close();
  }
});

test("T14: new versions are stored compressed; a version written as JSON text still reads", () => {
  const { file, cleanup } = temporary();
  try {
    const store = createStore(file);
    store.ingest(batch(0, [item("a1", { text: "Osmosis ".repeat(500) })]));
    const id = store.resources()[0]!.id;
    store.close();
    const db = new DatabaseSync(file);
    const row = db.prepare("SELECT payload FROM resource_versions WHERE resource_id = ?").get(id)!;
    assert.ok(row.payload instanceof Uint8Array);
    assert.ok((row.payload as Uint8Array).length < 400, "compressed");
    db.prepare("UPDATE resource_versions SET payload = ? WHERE resource_id = ?").run(JSON.stringify(item("a1", { text: "Legacy text." })), id);
    db.close();
    const again = createStore(file);
    assert.equal(again.resource(id)!.text, "Legacy text.");
    again.close();
  } finally {
    cleanup();
  }
});
