import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStore, migrationBackupPath, SCHEMA_VERSION } from "@magic/storage";
import type { ResourceInput } from "@magic/contracts";
import { COURSE_CORE_SCHEMA } from "../packages/storage/src/course-core";
import { LEARNING_TABLES } from "../packages/storage/src/learning";

// Synthetic data only.
const t = (s: number) => new Date(Date.UTC(2099, 0, 1, 0, 0, s)).toISOString();
const item = (externalId: string, text: string): ResourceInput => ({
  externalId,
  kind: "material",
  courseId: "course-1",
  courseName: "Example Biology",
  title: `Reading ${externalId}`,
  url: `https://canvas.example.test/files/${externalId}`,
  text,
  deadlines: [],
  points: null,
  submitted: null,
  policy: { mode: "unknown", evidence: "" },
});
const source = {
  id: "canvas-course-1",
  label: "Example Canvas",
  kind: "canvas" as const,
  accountScope: "student-1",
  courseId: "course-1",
  scope: "files",
};

function temporary() {
  const directory = mkdtempSync(join(tmpdir(), "magic-v7-"));
  return { file: join(directory, "workspace.sqlite"), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
function counts(db: DatabaseSync): Record<string, number> {
  return Object.fromEntries(
    (db.prepare("SELECT name FROM pragma_table_list WHERE schema='main' AND type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
      .filter((r) => !/_(data|idx|content|docsize|config)$/.test(r.name))
      .map((r) => [r.name, Number(db.prepare(`SELECT count(*) AS n FROM "${r.name}"`).get()!.n)]),
  );
}

/** One row in every learning table, through plain SQL (the learning lane owns the accessors). */
function seedLearning(db: DatabaseSync, resourceId: string) {
  db.exec(`
    INSERT INTO learning_courses VALUES ('student-1:course-1','student-1','course-1','Biology',NULL,'${t(0)}');
    INSERT INTO learning_concepts (id,course_id,parent_id,label,kind,origin,map_version) VALUES
      ('unit','student-1:course-1',NULL,'Transport','unit','code','m1'),
      ('osmosis','student-1:course-1','unit','Osmosis','concept','model','m1');
    INSERT INTO learning_concept_aliases VALUES ('osmosis','water movement','student');
    INSERT INTO learning_concept_sources VALUES ('osmosis','${resourceId}',0,7,'h','Osmosis',1);
    INSERT INTO learning_items (id,version,course_id,kind,stem,key_json,tier,origin,created_at) VALUES
      ('q1',1,'student-1:course-1','mc','What is osmosis?','{"answer":"a"}','T1','generated','${t(1)}');
    INSERT INTO learning_item_sources VALUES ('q1',1,'${resourceId}',0,7,'h','th','Osmosis',1);
    INSERT INTO learning_item_concepts VALUES ('q1',1,'osmosis',1.0,1);
    INSERT INTO learning_item_checks VALUES ('q1',1,'verbatim_quote','code','pass',NULL,'${t(1)}');
    INSERT INTO learning_cards (id,item_id,item_version,course_id,concept_id,due,stability,difficulty,elapsed_days,scheduled_days,reps,lapses,state,fsrs_version,params_hash)
      VALUES ('c1','q1',1,'student-1:course-1','osmosis','${t(2)}',1,5,0,0,0,0,0,'5.4.2','p');
    INSERT INTO learning_reviews VALUES ('rv1','c1',3,'{}','{}',1200,'2099-01-01',NULL,'${t(2)}');
    INSERT INTO learning_attempts (id,course_id,item_id,item_version,source_resource_id,correct,assistance,seen_before,created_at,format,mode,local_day)
      VALUES ('at1','student-1:course-1','q1',1,'${resourceId}',1,'none',0,'${t(3)}','mc','learn','2099-01-01');
    INSERT INTO learning_self_ratings VALUES ('sr1','osmosis','shaky',0,'2099-01-01','${t(3)}');
    INSERT INTO learning_disputes VALUES ('d1','student-1:course-1','citation','q1','wrong page',NULL,'open','${t(3)}',NULL);
    INSERT INTO learning_artifacts (id,course_id,kind,pack,pack_version,scope_json,cache_key,body_json,status,created_at)
      VALUES ('ar1','student-1:course-1','study_guide','guide','1','{}','k1','{}','ready','${t(3)}');
    INSERT INTO learning_artifact_sources VALUES ('ar1','${resourceId}','h');
    INSERT INTO learning_coverage VALUES ('mid','osmosis','stated','core','${resourceId}',0,7,'Osmosis','proposed',0);
    INSERT INTO learning_sessions VALUES ('se1','student-1:course-1','review','{}',10,NULL,'${t(3)}',NULL),
                                         ('se2',NULL,'review','{}',5,NULL,'${t(3)}',NULL);
    INSERT INTO learning_concept_state VALUES ('osmosis',0.1,2,NULL,0.5,NULL,'iffy',NULL,NULL,'v1','${t(3)}');
    INSERT INTO learning_prefs VALUES ('daily_goal','20');
    INSERT INTO learning_stars VALUES ('student-1:course-1','item','q1','${t(3)}');
    INSERT INTO learning_option_tags VALUES ('q1',1,'b','unit');
    INSERT INTO learning_views VALUES ('v1','${resourceId}',1,0,7,45,'2099-01-01');
  `);
}

test("v7 creates exactly the amended learning tables (D17), never the replaced or dropped ones", () => {
  const { file, cleanup } = temporary();
  try {
    createStore(file).close();
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, SCHEMA_VERSION);
      const learning = (db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'learning_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
      assert.deepEqual(learning, [...LEARNING_TABLES].sort());
      for (const absent of ["learning_passages", "learning_passage_search", "learning_jobs", "learning_notifications", "learning_digests", "course_topics", "pack_results"])
        assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name = ?").get(absent), undefined, absent);
      const coverage = db.prepare("SELECT \"table\" AS parent, \"from\" AS col FROM pragma_foreign_key_list('learning_coverage')").all() as { parent: string; col: string }[];
      assert.ok(coverage.some((fk) => fk.parent === "assessments" && fk.col === "assessment_id"), "coverage keys to assessments.id");
      const artifacts = (db.prepare("SELECT name FROM pragma_table_info('learning_artifacts')").all() as { name: string }[]).map((r) => r.name);
      assert.ok(artifacts.includes("pack") && artifacts.includes("pack_version"), "learning_artifacts carries pack and version");
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});

test("v6 → v7 keeps every row; cascades follow the anchor; attempts outlive a deleted source item", () => {
  const { file, cleanup } = temporary();
  try {
    let store = createStore(file);
    store.ingest({ source, observedAt: t(0), complete: true, status: "ok", resources: [item("r1", "Osmosis moves water."), item("r2", "Diffusion.")] });
    store.putAssessment({ id: "mid", sourceId: source.id, resourceId: null, kind: "midterm", title: "Midterm", date: null, weight: null, format: null, origin: "syllabus" }, t(1));
    store.close();
    // Back to the v6 shape.
    const down = new DatabaseSync(file);
    down.exec("PRAGMA foreign_keys = OFF;" + [...LEARNING_TABLES].reverse().map((name) => `DROP TABLE ${name};`).join("") + "PRAGMA user_version = 6;");
    const before = counts(down);
    down.close();
    store = createStore(file);
    const [r1] = store.resources();
    store.close();
    const db = new DatabaseSync(file);
    try {
      const after = counts(db);
      for (const [table, n] of Object.entries(before)) assert.equal(after[table], n, `${table} keeps every row`);
      for (const name of LEARNING_TABLES) assert.equal(after[name], 0, `${name} starts empty`);
      assert.equal(db.prepare("SELECT user_version FROM pragma_user_version").get()!.user_version, SCHEMA_VERSION);
      assert.equal(migrationBackupPath(file).endsWith(`.pre-v${SCHEMA_VERSION}.bak`), true);
      seedLearning(db, r1!.id);
      for (const name of LEARNING_TABLES) assert.ok(Number(db.prepare(`SELECT count(*) AS n FROM ${name}`).get()!.n) > 0, `${name} seeded`);
      // An attempt outlives the item it came from; its reference clears.
      db.exec("PRAGMA foreign_keys = ON;");
      db.prepare("DELETE FROM resources WHERE id = ?").run(r1!.id);
      assert.equal(db.prepare("SELECT source_resource_id FROM learning_attempts WHERE id='at1'").get()!.source_resource_id, null);
      assert.equal(db.prepare("SELECT count(*) AS n FROM learning_views").get()!.n, 0, "reading views cascade with the resource");
      // Deleting the anchor removes the course's learning rows; a cross-course session stays.
      db.exec("DELETE FROM learning_courses");
      for (const name of LEARNING_TABLES.filter((n) => !["learning_courses", "learning_prefs", "learning_sessions"].includes(n)))
        assert.equal(db.prepare(`SELECT count(*) AS n FROM ${name}`).get()!.n, 0, `${name} cascades from the anchor`);
      assert.equal(db.prepare("SELECT count(*) AS n FROM learning_sessions").get()!.n, 1);
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});

test("purge leaves zero rows in every learning table", () => {
  const { file, cleanup } = temporary();
  try {
    const store = createStore(file);
    try {
      store.ingest({ source, observedAt: t(0), complete: true, status: "ok", resources: [item("r1", "Osmosis moves water.")] });
      store.putAssessment({ id: "mid", sourceId: source.id, resourceId: null, kind: "midterm", title: "Midterm", date: null, weight: null, format: null, origin: "syllabus" }, t(1));
      const writer = new DatabaseSync(file);
      seedLearning(writer, store.resources()[0]!.id);
      writer.close();
      store.purge();
    } finally {
      store.close();
    }
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      for (const [table, n] of Object.entries(counts(db))) assert.equal(n, 0, `${table} is empty after purge`);
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});


test("v8 → v9 preserves every learning row, including v8-only fields and concept cards", () => {
  const { file, cleanup } = temporary();
  try {
    let store = createStore(file);
    store.ingest({ source, observedAt: t(0), complete: true, status: "ok", resources: [item("r1", "Osmosis moves water.")] });
    store.putAssessment({ id: "mid", sourceId: source.id, resourceId: null, kind: "midterm", title: "Midterm", date: null, weight: null, format: null, origin: "syllabus" }, t(1));
    const resourceId = store.resources()[0]!.id;
    store.close();
    const old = new DatabaseSync(file);
    let before: Record<string, unknown[]>;
    try {
      const historical = COURSE_CORE_SCHEMA.slice(COURSE_CORE_SCHEMA.indexOf("  CREATE TABLE course_spaces ("), COURSE_CORE_SCHEMA.indexOf("  CREATE TABLE course_briefs ("));
      assert.ok(historical.includes("checked_at TEXT NOT NULL"));
      old.exec(`DROP TABLE course_spaces; ${historical} PRAGMA user_version=8;`);
      seedLearning(old, resourceId);
      old.exec(`UPDATE learning_items SET unit='Transport';
        UPDATE learning_attempts SET option_id='b';
        UPDATE learning_coverage SET decided_by_student=1;
        INSERT INTO learning_cards (id,course_id,concept_id,due,stability,difficulty,elapsed_days,scheduled_days,reps,lapses,state,fsrs_version,params_hash,is_concept_track)
          VALUES ('concept-card','student-1:course-1','osmosis','${t(2)}',2,4,0,0,1,0,1,'5.4.2','p',1);`);
      before = Object.fromEntries(LEARNING_TABLES.map(name => [name, old.prepare(`SELECT * FROM ${name}`).all()]));
      for (const name of LEARNING_TABLES) assert.ok(before[name]!.length > 0, `${name} is seeded`);
    } finally { old.close(); }
    // Opening invokes only migration 9; accidentally rerunning 8 fails on its added columns.
    store = createStore(file); store.close();
    store = createStore(file); store.close();
    const migrated = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(migrated.prepare("PRAGMA user_version").get()!.user_version, 9);
      for (const name of LEARNING_TABLES)
        assert.deepEqual(migrated.prepare(`SELECT * FROM ${name}`).all(), before[name], `${name} survives migration and reopening unchanged`);
      assert.deepEqual(migrated.prepare("PRAGMA foreign_key_check").all(), []);
      const backup = new DatabaseSync(migrationBackupPath(file), { readOnly: true });
      try {
        assert.equal(backup.prepare("PRAGMA user_version").get()!.user_version, 8);
        for (const name of LEARNING_TABLES)
          assert.deepEqual(backup.prepare(`SELECT * FROM ${name}`).all(), before[name], `${name} is backed up before migration`);
      } finally { backup.close(); }
    } finally { migrated.close(); }
  } finally { cleanup(); }
});
