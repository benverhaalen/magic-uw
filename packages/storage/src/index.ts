import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { backup, DatabaseSync, type StatementSync } from "node:sqlite";
import { planningMigration, planningRepository, type PlanningRepository } from "./planning";
import { PLANNING_V12 } from "./planning-v12"; // owner: planning-perf
import { textHash } from "../../retrieval/src/index";
import { COURSE_CORE_SCHEMA, COURSE_SPACE_OBSERVATION_MIGRATION, courseCoreRepository } from "./course-core";
import { createPassageIndex, scopeToken } from "./passages";
import { graphRepository, migrateGraph } from "./graph";
import { LEARNING_SCHEMA } from "./learning";
import { LEARNING_V8 } from "./learning-v8";
import { createSqlLearningStore, type SqlLearningStore } from "../../learning/src/sql-store";
import { NOTES_V11 } from "./notes-v11"; // owner: notes
import { createSqlNotesStore, type SqlNotesStore } from "../../notes/src/sql-store"; // owner: notes
import { decodePayload, encodePayload } from "./payload";
import {
  LIFE_COURSE_ID,
  subjectJobSchema,
  type ChangeWithSeq,
  type CourseCoreStore,
  type CourseJob,
  type CourseRef,
  type GraphStore,
  type SubjectKind,
} from "../../contracts/src/course-core";
import {
  compileCourseIntelligence,
  courseInputHash,
  courseIntelligenceId,
} from "../../domain/src/course-intelligence";
import type {
  CourseIntelligence,
  CourseExtractionBatch,
} from "@magic/contracts";
import {
  captureEnvelopeSchema,
  courseExtractionBatchSchema,
  resourceInputSchema,
  ingestionSettingsSchema,
  defaultIngestionSettings,
  courseOverrideSchema,
  mcpGrantSchema,
  dayPlanEntrySchema,
  emptyNotificationState,
  notificationStateSchema,
  gitlabLinkSchema,
  type GitlabLink,
  syncRunSchema,
  type CaptureDiagnostic,
  type ChangeType,
  type ResourceChange,
  type ScopeBaseline,
  defaultPrivacy,
  instant,
  privacySchema,
  consentChangeSchema,
  consentRecordSchema,
  type ConsentChange,
  type ConsentRecord,
  identityRosterSchema,
  autoIdentityStateSchema,
  autoIdentityUpdateSchema,
  type AutoIdentityUpdate,
  type IdentityRoster,
  type Attempt,
  type DayPlanEntry,
  type EgressReceipt,
  type IngestReport,
  type Job,
  type Judgment,
  type Link,
  type PrivacyPreferences,
  type Resource,
  type ResourceInput,
  type SourceHealth,
  type Store,
} from "@magic/contracts";

export const SCHEMA_VERSION = 13;
const MAX_ATTEMPTS = 3;
/**
 * A resource row's latest observation per field, as one JSON object column. It walks the
 * (resource_id, field) primary key, so its key order is the per-resource query's order.
 */
const FIELD_SEEN = `(SELECT json_group_object(f.field, f.observed_at) FROM field_observations f
  WHERE f.resource_id = r.id) AS field_seen`;
/** The latest pre-migration backup, beside the database (one kept; purge deletes it). */
export function migrationBackupPath(path: string): string {
  return `${resolve(path)}.pre-v${SCHEMA_VERSION}.bak`;
}
const BACKUP_PATTERN = /\.pre-v\d+\.bak$/;
// owner: platform-fix. The read-only reader (the MCP course bank) never writes the database: its
// receipts go to this append-only log beside it, which the writer imports on its next open.
/** The reader's receipt log, one JSON receipt per line, in the app's data folder beside the database. */
export function readerReceiptLogPath(path: string): string {
  return `${resolve(path)}.reader-receipts.jsonl`;
}
/** The reader refuses a database it cannot read as this version; only the app migrates. */
export class ReaderSchemaError extends Error {}
/** Receipts keep 90 days of detail; older ones roll up into per-day counts (preferences 'receiptCounts'). */
export const RECEIPT_DETAIL_DAYS = 90;
// end owner: platform-fix
/** A failed migration. The single transaction rolled back, so the original file is intact. */
export class MigrationError extends Error {
  constructor(
    message: string,
    readonly from: number,
    readonly backup: string | null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}
/**
 * Restore the pre-migration backup into the live path through SQLite's backup API (never a file
 * copy: overwriting a file under an open connection corrupts it). Safe with a reader open.
 */
export async function restoreMigrationBackup(path: string): Promise<void> {
  const file = migrationBackupPath(path);
  if (!existsSync(file)) throw new Error("No pre-migration backup to restore.");
  const source = new DatabaseSync(file, { readOnly: true });
  try {
    await backup(source, resolve(path));
  } finally {
    source.close();
  }
}
type Row = Record<string, string | number | bigint | Uint8Array | null>;

function timestamp(value: string): string {
  return new Date(instant.parse(value)).toISOString();
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function contentHash(value: ResourceInput): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
/** Omitted fields retain prior observations; explicit null and empty arrays are observations. */
function mergeObserved(previous: unknown, incoming: unknown): unknown {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming))
    return incoming;
  const prior =
    previous && typeof previous === "object" && !Array.isArray(previous)
      ? (previous as Record<string, unknown>)
      : {};
  const result: Record<string, unknown> = { ...prior };
  for (const [key, value] of Object.entries(incoming))
    if (value !== undefined) result[key] = mergeObserved(prior[key], value);
  return result;
}
function observedFields(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return prefix ? [prefix] : [];
  return Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .flatMap(([key, item]) =>
      observedFields(item, prefix ? `${prefix}.${key}` : key),
    );
}
function fieldValue(value: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (v, key) =>
        v && typeof v === "object"
          ? (v as Record<string, unknown>)[key]
          : undefined,
      value,
    );
}

function assertText(value: string, name: string, max = 512): void {
  if (typeof value !== "string" || !value.length || value.length > max)
    throw new Error(`Invalid ${name}.`);
}

/** The text hash of a stored payload (registered for the v6 backfill). */
function payloadTextHash(payload: unknown): string {
  const item = decodePayload(payload) as { title?: string; text?: string };
  return textHash(String(item.title ?? ""), String(item.text ?? ""));
}

// owner: platform-fix
export interface ReceiptCount {
  day: string;
  recipient: string;
  purpose: string;
  status: string;
  receipts: number;
  characters: number;
}
export type LocalStore = Store &
  CourseCoreStore &
  GraphStore &
  PlanningRepository & {
    learning: SqlLearningStore;
    notes: SqlNotesStore;
    /** Imports the reader's receipt log into receipts (the writer only); returns how many were read. */
    importReaderReceipts(): number;
    /** Per-day receipt counts for receipts older than the detail window. */
    receiptCounts(): ReceiptCount[];
  };
// end owner: platform-fix

/** One local writer. Network requests and model inference must happen outside its transactions. */
export function createStore(
  path: string,
  options: { now?: () => Date; readOnly?: boolean } = {},
): LocalStore {
  const clock = options.now ?? (() => new Date());
  const file = path !== ":memory:";
  // owner: platform-fix. readOnly: the reader process. It opens the file read-only, never creates,
  // chmods, migrates, backs up (VACUUM INTO) or rebuilds anything; a write fails in SQLite itself.
  const readOnly = options.readOnly === true;
  if (readOnly && (!file || !existsSync(path)))
    throw new ReaderSchemaError("There is no local database to read yet. Open My Magic UW once first.");
  if (file && !readOnly) mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path, readOnly ? { readOnly: true } : {});
  if (file && !readOnly) chmodSync(path, 0o600);
  db.exec(
    readOnly
      ? "PRAGMA busy_timeout = 5000; PRAGMA query_only = ON;"
      : "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;",
  );
  // end owner: platform-fix
  db.function("magic_text_hash", { deterministic: true }, payloadTextHash);
  const readVersion = () =>
    Number(db.prepare("PRAGMA user_version").get()!.user_version);
  const schemaVersion = readVersion();
  if (schemaVersion > SCHEMA_VERSION) {
    db.close();
    throw new Error(
      "This database was created by a newer My Magic UW version.",
    );
  }
  // owner: platform-fix
  if (readOnly && schemaVersion < SCHEMA_VERSION) {
    db.close();
    throw new ReaderSchemaError(
      "The local database needs updating before the course bank can read it. Open My Magic UW once, then try again.",
    );
  }
  // end owner: platform-fix
  // O2: one prepared statement per SQL text for the life of the connection.
  const statements = new Map<string, StatementSync>();
  function prepare(sql: string): StatementSync {
    let statement = statements.get(sql);
    if (!statement) statements.set(sql, (statement = db.prepare(sql)));
    return statement;
  }

  function transaction<T>(operation: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      // SQLite may already have rolled back (FULL, IOERR, BUSY); never mask the original error.
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }

  // Every pending step runs in ONE transaction that re-reads user_version inside it (C1).
  // Step bodies are the historical migrations, unchanged; planning's v4 and v5 are untouched.
  const steps: [number, () => void][] = [];
  steps.push([
    1,
    () => {
      db.exec(`
      CREATE TABLE sources (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, kind TEXT NOT NULL,
        account_scope TEXT NOT NULL, course_id TEXT NOT NULL, scope TEXT NOT NULL,
        status TEXT NOT NULL, last_attempt_at TEXT NOT NULL, last_success_at TEXT,
        complete INTEGER NOT NULL CHECK (complete IN (0, 1))
      );
      CREATE TABLE resources (
        id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        external_id TEXT NOT NULL, content_hash TEXT NOT NULL, version INTEGER NOT NULL,
        observed_at TEXT NOT NULL, captured_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
        UNIQUE (source_id, external_id)
      );
      CREATE TABLE resource_versions (
        resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
        version INTEGER NOT NULL, content_hash TEXT NOT NULL, payload TEXT NOT NULL,
        captured_at TEXT NOT NULL, PRIMARY KEY (resource_id, version)
      );
      CREATE TABLE observations (
        resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
        observed_at TEXT NOT NULL, version INTEGER NOT NULL, deleted INTEGER NOT NULL,
        PRIMARY KEY (resource_id, observed_at)
      );
      CREATE TABLE source_observations (
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        observed_at TEXT NOT NULL, status TEXT NOT NULL, complete INTEGER NOT NULL,
        resource_count INTEGER NOT NULL, PRIMARY KEY (source_id, observed_at)
      );
      CREATE TABLE completions (
        resource_id TEXT PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
        completed INTEGER NOT NULL CHECK (completed IN (0, 1))
      );
      CREATE VIRTUAL TABLE resource_search USING fts5(resource_id UNINDEXED, title, course_name, body);
      CREATE TABLE preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE links (
        id TEXT PRIMARY KEY,
        from_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
        to_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
        type TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL, input_hash TEXT NOT NULL
      );
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL,
        resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
        input_hash TEXT NOT NULL, status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, run_after TEXT NOT NULL,
        lease_until TEXT, lease_token TEXT, error TEXT,
        UNIQUE (kind, resource_id, input_hash)
      );
      CREATE INDEX jobs_available ON jobs (status, run_after);
      CREATE TABLE judgments (
        key TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
        input_hash TEXT NOT NULL, model TEXT NOT NULL, question_version TEXT NOT NULL,
        result TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE attempts (
        id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL, skill TEXT NOT NULL, correct INTEGER NOT NULL,
        assistance TEXT NOT NULL, seen_before INTEGER NOT NULL, confidence REAL, created_at TEXT NOT NULL
      );
      CREATE INDEX attempts_resource ON attempts (resource_id, created_at);
      CREATE TABLE receipts (
        id TEXT PRIMARY KEY, recipient TEXT NOT NULL, purpose TEXT NOT NULL,
        categories TEXT NOT NULL, resource_ids TEXT NOT NULL,
        characters INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
      );
      PRAGMA user_version = 1;
    `);
    },
  ]);
  steps.push([
    2,
    () => {
      // Old links lack target evidence versions: hide them until their evidence is checked again.
      db.exec(
        "ALTER TABLE links ADD COLUMN target_hash TEXT NOT NULL DEFAULT ''; PRAGMA user_version = 2;",
      );
    },
  ]);
  steps.push([
    3,
    () => {
      db.exec(`
      ALTER TABLE sources ADD COLUMN details TEXT NOT NULL DEFAULT '{}';
      CREATE TABLE field_observations (
        resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE, field TEXT NOT NULL,
        observed_at TEXT NOT NULL, read_id TEXT NOT NULL, version INTEGER NOT NULL,
        PRIMARY KEY(resource_id, field, observed_at)
      );
      CREATE TABLE resource_changes (
        id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE, read_id TEXT NOT NULL,
        observed_at TEXT NOT NULL, type TEXT NOT NULL, old_values TEXT NOT NULL, new_values TEXT NOT NULL
      );
      CREATE INDEX resource_changes_time ON resource_changes(observed_at);
      CREATE TABLE scope_baselines (
        source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE, successful_reads INTEGER NOT NULL,
        record_count REAL NOT NULL, empty_text_ratio REAL NOT NULL, date_coverage_ratio REAL NOT NULL, observed_at TEXT NOT NULL
      );
      CREATE TABLE course_overrides (account_scope TEXT NOT NULL, course_id TEXT NOT NULL, included INTEGER NOT NULL, PRIMARY KEY(account_scope, course_id));
      CREATE TABLE sync_runs (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE mcp_grants (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      PRAGMA user_version = 3;
    `);
    },
  ]);
  steps.push([4, () => db.exec(planningMigration + "PRAGMA user_version = 4;")]);
  steps.push([
    5,
    () =>
      db.exec(`CREATE TABLE course_intelligence (
    id TEXT NOT NULL, version INTEGER NOT NULL, input_hash TEXT NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY(id,version)); PRAGMA user_version = 5;`),
  ]);
  // v6: the course core. Existing text is split into passages here, inside the same transaction.
  steps.push([
    6,
    () => {
      db.exec(COURSE_CORE_SCHEMA + "PRAGMA user_version = 6;");
      backfillPassages();
      db.exec("DROP TABLE resource_search;");
    },
  ]);
  // v7: learning and practice tables (T10L, D17).
  steps.push([7, () => db.exec(LEARNING_SCHEMA + "PRAGMA user_version = 7;")]);
  steps.push([8, () => db.exec(LEARNING_V8 + "PRAGMA user_version = 8;")]);
  steps.push([9, () => db.exec(COURSE_SPACE_OBSERVATION_MIGRATION + "PRAGMA user_version = 9;")]);
  // v10: the course graph (the material pipeline): external refs, resource refs, quoted facts.
  steps.push([
    10,
    () => {
      migrateGraph(db);
      db.exec("PRAGMA user_version = 10;");
    },
  ]);
  // v11 "notes": session notes (packages/notes); additive tables only (IF NOT EXISTS). Runs after v10 (the course graph).
  steps.push([11, () => db.exec(NOTES_V11 + "PRAGMA user_version = 11;")]);
  // owner: planning-perf. v12: planning index and capture pruning; idempotent (IF NOT EXISTS).
  steps.push([12, () => db.exec(PLANNING_V12 + "PRAGMA user_version = 12;")]);
  // owner: platform-fix. v13 (additive, idempotent; reserved for this branch, applied after main's
  // v12): the receipts index for the retention sweep. The per-day counts that outlive 90 days of
  // detail live in preferences ('receiptCounts'), like consents and the day plan: no new table.
  steps.push([
    13,
    () => db.exec("CREATE INDEX IF NOT EXISTS receipts_created ON receipts(created_at); PRAGMA user_version = 13;"),
  ]);
  // end owner: platform-fix
  const migrationBackup = file ? migrationBackupPath(path) : null;
  const passageIndex = createPassageIndex(db, prepare);
  const courseScope = (accountScope: string, courseId: string) =>
    scopeToken(accountScope, courseId);
  function backfillPassages() {
    for (const row of db
      .prepare(
        `SELECT r.id, r.version, r.text_hash, s.account_scope, s.course_id, v.payload FROM resources r
         JOIN sources s ON s.id = r.source_id
         JOIN resource_versions v ON v.resource_id = r.id AND v.version = r.version WHERE r.deleted = 0`,
      )
      .iterate())
      passageIndex.index(
        String(row.id),
        Number(row.version),
        String(row.text_hash),
        decodePayload(row.payload),
        courseScope(String(row.account_scope), String(row.course_id)),
      );
  }
  /** Every backup file this database has (any target version). */
  function backupFiles(): string[] {
    if (!file) return [];
    const directory = dirname(resolve(path));
    const base = `${basename(resolve(path))}.pre-v`;
    return readdirSync(directory)
      .filter((name) => name.startsWith(base) && BACKUP_PATTERN.test(name))
      .map((name) => join(directory, name));
  }
  function takeBackup(target: string) {
    // VACUUM INTO needs a missing or empty target: create it empty and private first. One kept.
    for (const old of backupFiles()) rmSync(old, { force: true });
    writeFileSync(target, "", { mode: 0o600 });
    chmodSync(target, 0o600);
    db.prepare("VACUUM INTO ?").run(target);
  }
  function migrate() {
    if (schemaVersion >= SCHEMA_VERSION) return;
    if (schemaVersion > 0 && migrationBackup) takeBackup(migrationBackup);
    let from = schemaVersion;
    db.exec("BEGIN IMMEDIATE");
    try {
      from = readVersion(); // another process may have migrated since the first read
      if (from > SCHEMA_VERSION)
        throw new Error("This database was created by a newer My Magic UW version.");
      for (const [version, step] of steps) if (version > from) step();
      if (db.prepare("PRAGMA foreign_key_check").all().length)
        throw new Error("The migration left foreign-key violations.");
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      db.close();
      throw new MigrationError(
        `Updating the local database from v${from} failed; the original database is unchanged.`,
        from,
        migrationBackup && existsSync(migrationBackup) ? migrationBackup : null,
        { cause: error },
      );
    }
  }
  if (!readOnly) migrate();
  const planning = planningRepository(db, prepare); // owner: planning-perf: cached statements
  // owner: T06. Consent storage helpers.
  function readConsents(): ConsentRecord[] {
    const row = db
      .prepare("SELECT value FROM preferences WHERE key = 'consents'")
      .get();
    if (!row) return [];
    let raw: unknown;
    try {
      raw = JSON.parse(String(row.value));
    } catch {
      return [];
    }
    // A malformed or unknown entry reads as absent: it can only withhold consent, never grant it.
    return Array.isArray(raw)
      ? raw.flatMap((entry) => {
          const parsed = consentRecordSchema.safeParse(entry);
          return parsed.success ? [parsed.data] : [];
        })
      : [];
  }
  /** The same registered key as `consentRecordsKey` in @magic/domain (maySend reads it). */
  function withConsentRecords(value: PrivacyPreferences): PrivacyPreferences {
    return Object.defineProperty(value, Symbol.for("magic.consentRecords"), {
      value: Object.freeze(readConsents()),
      enumerable: false,
    });
  }
  // end owner: T06

  function resourceRow(id: string): Row | undefined {
    return prepare(
        `SELECT r.*, v.payload, COALESCE(c.completed, 0) AS completed, ${FIELD_SEEN}
      FROM resources r JOIN resource_versions v ON v.resource_id = r.id AND v.version = r.version
      LEFT JOIN completions c ON c.resource_id = r.id WHERE r.id = ?`,
      )
      .get(id) as Row | undefined;
  }

  function readResource(row: Row): Resource {
    return {
      ...decodePayload(row.payload),
      id: String(row.id),
      sourceId: String(row.source_id),
      contentHash: String(row.content_hash),
      version: Number(row.version),
      observedAt: String(row.observed_at),
      capturedAt: String(row.captured_at),
      deleted: Boolean(row.deleted),
      completed: Boolean(row.completed),
      // A list query selects FIELD_SEEN, so a list is one statement, not one more per resource.
      fieldLastSeen:
        typeof row.field_seen === "string"
          ? (JSON.parse(row.field_seen) as Record<string, string>)
          : Object.fromEntries(
              (
                prepare(
                  "SELECT field, observed_at FROM field_observations WHERE resource_id = ?",
                ).all(String(row.id)) as Row[]
              ).map((v) => [String(v.field), String(v.observed_at)]),
            ),
    };
  }

  /** A live resource; with `hash`, only while it equals the content hash or the text hash (O5). */
  function liveResource(id: string, hash?: string): Row | undefined {
    const row = prepare("SELECT * FROM resources WHERE id = ? AND deleted = 0").get(
      id,
    ) as Row | undefined;
    return row &&
      (hash === undefined || row.content_hash === hash || row.text_hash === hash)
      ? row
      : undefined;
  }

  function enqueue(
    kind: string,
    resourceId: string,
    inputHash: string,
    now: string,
  ): void {
    assertText(kind, "job kind");
    const time = timestamp(now);
    if (!liveResource(resourceId, inputHash)) return;
    prepare(
      `INSERT OR IGNORE INTO jobs
      (id, kind, subject_kind, subject_id, resource_id, input_hash, status, attempts, run_after)
      VALUES (?, ?, 'resource', ?, ?, ?, 'pending', 0, ?)`,
    ).run(randomUUID(), kind, resourceId, resourceId, inputHash, time);
  }

  /** Per-subject staleness: a job is served only while its subject still holds its input. */
  const fresh: Record<SubjectKind, (row: Row) => boolean> = {
    resource: (row) =>
      row.resource_id !== null &&
      !!liveResource(String(row.resource_id), String(row.input_hash)),
    course: (row) =>
      row.source_id !== null &&
      !!prepare(
        "SELECT 1 FROM sources WHERE id = ? AND account_scope || ':' || course_id = ?",
      ).get(row.source_id, row.subject_id),
    assessment: (row) =>
      !!prepare("SELECT 1 FROM assessments WHERE id = ?").get(row.subject_id),
    source: (row) =>
      !!prepare("SELECT 1 FROM sources WHERE id = ?").get(row.subject_id),
    // A pack job's inputs are checked by its handler before anything is written.
    pack: () => true,
  };
  const isFresh = (row: Row) =>
    (fresh[row.subject_kind as SubjectKind] ?? (() => false))(row);

  function readJob(row: Row): CourseJob {
    return {
      id: String(row.id),
      kind: String(row.kind),
      resourceId: row.resource_id === null ? "" : String(row.resource_id),
      inputHash: String(row.input_hash),
      status: row.status as Job["status"],
      attempts: Number(row.attempts),
      runAfter: String(row.run_after),
      leaseUntil: row.lease_until === null ? null : String(row.lease_until),
      leaseToken: row.lease_token === null ? null : String(row.lease_token),
      error: row.error === null ? null : String(row.error),
      subjectKind: String(row.subject_kind) as SubjectKind,
      subjectId: String(row.subject_id),
      sourceId: row.source_id === null ? null : String(row.source_id),
    } satisfies CourseJob;
  }

  function readJudgment(row: Row): Judgment {
    return {
      key: String(row.key),
      resourceId: String(row.resource_id),
      inputHash: String(row.input_hash),
      model: String(row.model),
      questionVersion: String(row.question_version),
      result: JSON.parse(String(row.result)),
      createdAt: String(row.created_at),
    };
  }

  function readLink(row: Row): Link {
    return {
      id: String(row.id),
      fromId: String(row.from_id),
      toId: String(row.to_id),
      type: row.type as Link["type"],
      reason: String(row.reason),
      status: row.status as Link["status"],
      inputHash: String(row.input_hash),
    };
  }

  function latestIntelligence(id: string): CourseIntelligence | undefined {
    const row = prepare(
        "SELECT payload FROM course_intelligence WHERE id=? ORDER BY version DESC LIMIT 1",
      )
      .get(id);
    return row ? JSON.parse(String(row.payload)) : undefined;
  }
  function rebuildIntelligence(
    account: string,
    course: string,
    at: string,
    extraction?: CourseExtractionBatch,
  ) {
    // The input hash needs only identity and version columns: decide the early exits before
    // decoding every payload in the course (the same checks as below, on the same rows).
    const previous = latestIntelligence(courseIntelligenceId(account, course));
    const identities = (
      prepare(
        `SELECT r.id, r.source_id, r.content_hash, r.version FROM resources r JOIN sources s ON s.id=r.source_id
        WHERE s.account_scope=? AND s.course_id=? AND r.deleted=0 ORDER BY r.id`,
      ).all(account, course) as Row[]
    ).map((r) => ({
      id: String(r.id),
      sourceId: String(r.source_id),
      contentHash: String(r.content_hash),
      version: Number(r.version),
    })) as Resource[];
    const identityHash = courseInputHash(identities);
    if (extraction && extraction.inputHash !== identityHash) return false;
    if (!extraction && previous?.inputHash === identityHash) return false;
    const rows = prepare(
        `SELECT r.*,v.payload,COALESCE(c.completed,0) AS completed FROM resources r
      JOIN sources s ON s.id=r.source_id JOIN resource_versions v ON v.resource_id=r.id AND v.version=r.version
      LEFT JOIN completions c ON c.resource_id=r.id
      WHERE s.account_scope=? AND s.course_id=? AND r.deleted=0 ORDER BY r.id`,
      )
      .all(account, course) as Row[];
    const resources = rows.map(readResource);
    if (extraction && extraction.inputHash !== courseInputHash(resources))
      return false;
    if (!extraction && previous?.inputHash === courseInputHash(resources))
      return false;
    if (!resources.length && extraction) return false;
    const sourceRoles = prepare(
        "SELECT id,kind,scope FROM sources WHERE account_scope=? AND course_id=?",
      )
      .all(account, course) as unknown as Pick<
      SourceHealth,
      "id" | "kind" | "scope"
    >[];
    const profile = compileCourseIntelligence(
      account,
      course,
      resources,
      at,
      previous,
      extraction,
      sourceRoles,
    );
    if (
      extraction &&
      previous?.extraction?.resultHash === profile.extraction?.resultHash
    )
      return false;
    prepare("INSERT INTO course_intelligence VALUES (?,?,?,?)").run(
      profile.id,
      profile.version,
      profile.inputHash,
      JSON.stringify(profile),
    );
    return true;
  }
  // Existing databases are materialized locally at open; no model or network request.
  if (!readOnly) for (const row of prepare("SELECT DISTINCT account_scope,course_id FROM sources WHERE course_id <> ?")
    .all(LIFE_COURSE_ID))
    rebuildIntelligence(
      String(row.account_scope),
      String(row.course_id),
      new Date().toISOString(),
    );
  /** Every FTS5 table (not its shadow tables, not fts5vocab views). */
  function ftsTables(): string[] {
    return (
      prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%USING fts5(%'",
      ).all() as Row[]
    ).map((r) => String(r.name));
  }
  /** Every ordinary table, each after all the tables that reference it (children first). */
  function purgeOrder(): string[] {
    const tables = (
      prepare(
        "SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%'",
      ).all() as Row[]
    ).map((r) => String(r.name));
    const children = new Map<string, string[]>(tables.map((t) => [t, []]));
    for (const table of tables)
      for (const fk of prepare('SELECT DISTINCT "table" AS parent FROM pragma_foreign_key_list(?)').all(
        table,
      ) as Row[])
        if (fk.parent !== table) children.get(String(fk.parent))?.push(table);
    const order: string[] = [];
    const seen = new Set<string>();
    const visit = (table: string) => {
      if (seen.has(table)) return;
      seen.add(table);
      for (const child of children.get(table) ?? []) visit(child);
      order.push(table);
    };
    for (const table of tables) visit(table);
    return order;
  }
  /** A live resource's text at a version (default: its current one). */
  function versionText(resourceId: string, version?: number) {
    const row = prepare(
      `SELECT r.id, r.source_id, r.version AS current, v.version, v.text_hash, v.payload FROM resources r
       JOIN resource_versions v ON v.resource_id = r.id AND v.version = COALESCE(?, r.version)
       WHERE r.id = ? AND r.deleted = 0`,
    ).get(version ?? null, resourceId) as Row | undefined;
    return row
      ? {
          resourceId: String(row.id),
          sourceId: String(row.source_id),
          version: Number(row.version),
          currentVersion: Number(row.current),
          textHash: String(row.text_hash),
          item: decodePayload(row.payload),
        }
      : undefined;
  }
  const courseCore = courseCoreRepository(prepare, {
    transaction,
    timestamp,
    versionText,
  });
  const learning = createSqlLearningStore(prepare, transaction, () => clock().toISOString());
  const graph = graphRepository(prepare, { transaction, timestamp });
  const notes = createSqlNotesStore(prepare, transaction, () => clock().toISOString()); // owner: notes
  let closed = false;
  // Keep two weeks of day-plan history, measured from the newest saved day.
  const DAY_PLAN_KEEP_DAYS = 14;
  function readDayPlan(): DayPlanEntry[] {
    const row = db
      .prepare("SELECT value FROM preferences WHERE key = 'dayPlan'")
      .get();
    if (!row) return [];
    let saved: unknown;
    try {
      saved = JSON.parse(String(row.value));
    } catch {
      return [];
    }
    // Each entry validates on its own so one bad record cannot hide the rest.
    return (Array.isArray(saved) ? saved : [])
      .map((e) => dayPlanEntrySchema.safeParse(e))
      .filter((r) => r.success)
      .map((r) => r.data);
  }
  const DAY_PLAN_MAX_ENTRIES = 500;
  // Measured from today, never from the newest saved day, so one far-off date cannot erase the rest.
  function dayPlanWindow() {
    const day = (offset: number) =>
      new Date(clock().getTime() + offset * 86400000).toISOString().slice(0, 10);
    return { from: day(-DAY_PLAN_KEEP_DAYS), to: day(DAY_PLAN_KEEP_DAYS) };
  }
  function writeDayPlan(entries: DayPlanEntry[]) {
    const { from, to } = dayPlanWindow();
    const kept = entries
      .filter((e) => e.date >= from && e.date <= to)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, DAY_PLAN_MAX_ENTRIES);
    db.prepare(
      "INSERT INTO preferences VALUES ('dayPlan', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(JSON.stringify(kept));
  }
  // Manual GitLab links live beside the day plan in preferences, so Delete local data clears them.
  const GITLAB_LINKS_MAX = 200;
  function readGitlabLinks(): GitlabLink[] {
    const row = db.prepare("SELECT value FROM preferences WHERE key = 'gitlabLinks'").get();
    if (!row) return [];
    let saved: unknown;
    try {
      saved = JSON.parse(String(row.value));
    } catch {
      return [];
    }
    return (Array.isArray(saved) ? saved : [])
      .map((e) => gitlabLinkSchema.safeParse(e))
      .filter((r) => r.success)
      .map((r) => r.data);
  }
  function writeGitlabLinks(links: GitlabLink[]) {
    db.prepare(
      "INSERT INTO preferences VALUES ('gitlabLinks', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(JSON.stringify(links.slice(-GITLAB_LINKS_MAX)));
  }
  const sameLink = (a: GitlabLink, account: string, course: string, path: string) =>
    a.accountScope === account && a.courseId === course && a.projectPath.toLowerCase() === path.toLowerCase();
  // owner: platform-fix. Receipts: the one validated insert, the 90-day roll-up, the reader's log.
  function addReceiptRow(value: EgressReceipt) {
    assertText(value.id, "receipt ID");
    assertText(value.recipient, "receipt recipient");
    assertText(value.purpose, "receipt purpose", 2000);
    if (
      // owner: T06: preview_required records a held request; nothing was sent.
      !["blocked", "sent", "failed", "preview_required"].includes(value.status) ||
      !Number.isSafeInteger(value.characters) ||
      value.characters < 0 ||
      !Array.isArray(value.categories) ||
      !value.categories.every((item) => typeof item === "string") ||
      !Array.isArray(value.resourceIds) ||
      !value.resourceIds.every((item) => typeof item === "string")
    )
      throw new Error("Invalid egress receipt.");
    // This also rejects receipts from operations that were in flight when the user purged the store.
    if (value.resourceIds.some((id) => !liveResource(id))) return;
    prepare(
      `INSERT INTO receipts VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING`,
    ).run(
      value.id,
      value.recipient,
      value.purpose,
      JSON.stringify(value.categories),
      JSON.stringify(value.resourceIds),
      value.characters,
      value.status,
      timestamp(value.createdAt),
    );
  }
  const atomically = <T>(work: () => T): T => (db.isTransaction ? work() : transaction(work));
  let rolledUpAt = 0;
  function readReceiptCounts(): ReceiptCount[] {
    const row = prepare("SELECT value FROM preferences WHERE key = 'receiptCounts'").get();
    try {
      const value: unknown = row ? JSON.parse(String(row.value)) : [];
      return Array.isArray(value) ? (value as ReceiptCount[]) : [];
    } catch {
      return [];
    }
  }
  /** Receipts past the detail window become per-day counts (indexed on created_at, so cheap). */
  function rollUpReceipts() {
    if (readOnly) return;
    rolledUpAt = clock().getTime();
    const cutoff = new Date(rolledUpAt - RECEIPT_DETAIL_DAYS * 86_400_000).toISOString();
    atomically(() => {
      const expired = prepare(
        `SELECT substr(created_at, 1, 10) AS day, recipient, purpose, status, COUNT(*) AS receipts,
           SUM(characters) AS characters FROM receipts WHERE created_at < ? GROUP BY 1, 2, 3, 4`,
      ).all(cutoff) as Row[];
      if (!expired.length) return;
      const counts = new Map(readReceiptCounts().map((c) => [`${c.day}|${c.recipient}|${c.purpose}|${c.status}`, c]));
      for (const r of expired) {
        const key = `${r.day}|${r.recipient}|${r.purpose}|${r.status}`;
        const prior = counts.get(key);
        counts.set(key, {
          day: String(r.day),
          recipient: String(r.recipient),
          purpose: String(r.purpose),
          status: String(r.status),
          receipts: (prior?.receipts ?? 0) + Number(r.receipts),
          characters: (prior?.characters ?? 0) + Number(r.characters),
        });
      }
      const sorted = [...counts.values()].sort(
        (a, b) =>
          a.day.localeCompare(b.day) ||
          a.recipient.localeCompare(b.recipient) ||
          a.purpose.localeCompare(b.purpose) ||
          a.status.localeCompare(b.status),
      );
      prepare(
        "INSERT INTO preferences VALUES ('receiptCounts', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(JSON.stringify(sorted));
      prepare("DELETE FROM receipts WHERE created_at < ?").run(cutoff);
    });
  }
  /** The reader appends; the writer renames the log aside, imports it in one transaction, deletes it. */
  function importReaderReceipts(): number {
    if (readOnly || !file) return 0;
    const log = readerReceiptLogPath(path);
    const pending = `${log}.importing`;
    try {
      if (!existsSync(pending) && existsSync(log)) renameSync(log, pending);
    } catch {
      return 0; // the reader holds it this instant: the next open or tick imports it
    }
    if (!existsSync(pending)) return 0;
    const lines = readFileSync(pending, "utf8").split("\n");
    let imported = 0;
    atomically(() => {
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          addReceiptRow(JSON.parse(line) as EgressReceipt);
          imported++;
        } catch {
          // A torn or malformed line is skipped; it can only lose a record, never widen one.
        }
      }
    });
    rmSync(pending, { force: true });
    return imported;
  }
  // end owner: platform-fix
  const api: LocalStore = {
    learning,
    notes, // owner: notes
    courseIntelligence() {
      return prepare(
          "SELECT payload FROM course_intelligence p WHERE version=(SELECT MAX(version) FROM course_intelligence WHERE id=p.id) ORDER BY id",
        )
        .all()
        .map((row) => JSON.parse(String(row.payload)) as CourseIntelligence);
    },
    courseIntelligenceHistory(id) {
      return prepare(
          "SELECT payload FROM course_intelligence WHERE id=? ORDER BY version",
        )
        .all(id)
        .map((row) => JSON.parse(String(row.payload)) as CourseIntelligence);
    },
    applyCourseExtraction(account, course, extraction, at) {
      const parsed = courseExtractionBatchSchema.safeParse(extraction);
      if (!parsed.success) return false;
      return transaction(() =>
        rebuildIntelligence(account, course, timestamp(at), parsed.data),
      );
    },
    ...planning,
    close() {
      if (!closed) {
        db.close();
        closed = true;
      }
    },

    ingest(input: unknown): IngestReport {
      const envelope = captureEnvelopeSchema.safeParse(input);
      if (!envelope.success) throw new Error("Invalid capture envelope.");
      const batch = envelope.data;
      const observedAt = timestamp(batch.observedAt);
      const capturedAt = new Date().toISOString();
      const source = batch.source;
      const readId =
        batch.readId ??
        createHash("sha256").update(`${source.id}:${observedAt}`).digest("hex");
      const diagnostics: CaptureDiagnostic[] = [...(batch.diagnostics ?? [])];
      const records: { value: ResourceInput; raw: Record<string, unknown> }[] =
        [];
      const identities = new Set<string>();
      let rejected = 0;
      for (const [index, raw] of batch.resources.entries()) {
        const parsed = resourceInputSchema.safeParse(raw);
        if (!parsed.success) {
          rejected++;
          for (const issue of parsed.error.issues)
            diagnostics.push({
              code: issue.code,
              path: [
                "resources",
                String(index),
                ...issue.path.map(String),
              ].slice(0, 20),
              severity: "error",
            });
          continue;
        }
        if (parsed.data.courseId !== source.courseId)
          throw new Error("Resource course does not match its capture scope.");
        if (identities.has(parsed.data.externalId))
          throw new Error(
            "A capture contains duplicate external resource IDs.",
          );
        identities.add(parsed.data.externalId);
        records.push({
          value: parsed.data,
          raw: raw as Record<string, unknown>,
        });
      }
      return transaction(() => {
        const prior = prepare("SELECT * FROM sources WHERE id = ?")
          .get(source.id) as Row | undefined;
        if (
          prior &&
          (prior.account_scope !== source.accountScope ||
            prior.course_id !== source.courseId ||
            prior.scope !== source.scope ||
            prior.kind !== source.kind)
        )
          throw new Error(
            "A source ID cannot be reassigned to another account, course, kind, or scope.",
          );
        const report: IngestReport = {
          created: 0,
          changed: 0,
          unchanged: 0,
          deleted: 0,
          ignored: false,
        };
        if (prior && observedAt <= String(prior.last_attempt_at))
          return { ...report, ignored: true };
        let status =
          (rejected || diagnostics.some((d) => d.severity === "error")) &&
          batch.status === "ok"
            ? "partial"
            : batch.status;
        let complete =
          status === "ok" &&
          batch.complete &&
          !diagnostics.some((d) => d.severity === "error");
        const baseline = prepare("SELECT * FROM scope_baselines WHERE source_id = ?")
          .get(source.id) as Row | undefined;
        const count = records.length;
        const emptyRatio = count
          ? records.filter(({ value }) => !value.text.trim()).length / count
          : 0;
        const dateRatio = count
          ? records.filter(({ value }) => value.deadlines.length || value.dueAt)
              .length / count
          : 0;
        const drift: string[] = [];
        // owner: T30: a Graph source's set is built from Microsoft's own delta, whose removals are
        // authoritative (a student archiving mail), so a drop there is real, not a failed read.
        const deltaAuthoritative = source.scope.startsWith("graph_");
        if (complete && baseline && !deltaAuthoritative && Number(baseline.record_count) >= 5) {
          if (count < Number(baseline.record_count) * 0.3)
            drift.push("record_count_drop");
          if (
            count >= 3 &&
            emptyRatio > Number(baseline.empty_text_ratio) + 0.6
          )
            drift.push("key_text_loss");
          if (
            count >= 3 &&
            Number(baseline.date_coverage_ratio) >= 0.6 &&
            dateRatio < Number(baseline.date_coverage_ratio) * 0.3
          )
            drift.push("date_coverage_loss");
        }
        // A course site may contain a single page. Count baselines alone cannot detect its collapse.
        if (
          source.kind === "web" &&
          (status === "ok" || status === "partial")
        ) {
          for (const { value } of records) {
            const old = prepare(
                `SELECT v.payload FROM resources r JOIN resource_versions v ON v.resource_id=r.id AND v.version=r.version
              WHERE r.source_id=? AND r.external_id=? AND r.deleted=0`,
              )
              .get(source.id, value.externalId);
            const oldText = old
              ? decodePayload(old.payload).text.trim()
              : "";
            if (
              oldText.length >= 100 &&
              value.text.trim().length < oldText.length * 0.15
            ) {
              drift.push("key_text_loss");
              break;
            }
          }
        }
        if (drift.length) {
          status = "needs_attention";
          complete = false;
          diagnostics.push(
            ...drift.map((code): CaptureDiagnostic => ({
              code,
              path: ["resources"],
              severity: "error",
            })),
          );
        }
        if (rejected) report.rejected = rejected;
        if (diagnostics.length) report.diagnostics = diagnostics.slice(0, 2000);
        if (batch.readId) report.readId = readId;
        const details = {
          readId,
          diagnostics: diagnostics.slice(0, 2000),
          ...(batch.stats ? { stats: batch.stats } : {}),
          ...(batch.progress ? { progress: batch.progress } : {}),
        };
        prepare(
          `INSERT INTO sources
          (id,label,kind,account_scope,course_id,scope,status,last_attempt_at,last_success_at,complete,details)
          VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,status=excluded.status,
          last_attempt_at=excluded.last_attempt_at,last_success_at=COALESCE(excluded.last_success_at,sources.last_success_at),complete=excluded.complete,details=excluded.details`,
        ).run(
          source.id,
          source.label,
          source.kind,
          source.accountScope,
          source.courseId,
          source.scope,
          status,
          observedAt,
          complete ? observedAt : null,
          Number(complete),
          JSON.stringify(details),
        );
        // owner: platform-fix. source_observations and observations are no longer written: nothing
        // reads them (sources, resources and field_observations carry the latest state).
        let seq = Number(
          prepare("SELECT value FROM counters WHERE name = 'change_seq'").get()
            ?.value ?? 0,
        );
        const addChange = (
          resourceId: string,
          type: ChangeType,
          oldValues: Record<string, unknown>,
          newValues: Record<string, unknown>,
        ) => {
          prepare(
            "INSERT INTO resource_changes (id,resource_id,source_id,read_id,observed_at,type,old_values,new_values,seq) VALUES (?,?,?,?,?,?,?,?,?)",
          ).run(
            randomUUID(),
            resourceId,
            source.id,
            readId,
            observedAt,
            type,
            JSON.stringify(oldValues),
            JSON.stringify(newValues),
            ++seq,
          );
        };
        // Restricted course rows are catalog observations, not successful reads of their content.
        // Only their identity and typed course metadata may advance while content stays last known.
        const restrictedCatalog =
          source.kind === "canvas" &&
          source.scope === "course" &&
          (status === "inaccessible" || status === "not_published");
        const usable = status === "ok" || status === "partial";
        const accepted = usable
          ? records
          : restrictedCatalog
            ? records.filter(
                ({ value }) => value.kind === "course" && value.course,
              )
            : [];
        for (const entry of accepted) {
          const existing = prepare(
              "SELECT * FROM resources WHERE source_id = ? AND external_id = ?",
            )
            .get(source.id, entry.value.externalId) as Row | undefined;
          const previous = existing
            ? decodePayload(resourceRow(String(existing.id))!.payload)
            : undefined;
          if (restrictedCatalog && previous && previous.kind !== "course")
            continue;
          const observation = restrictedCatalog
            ? Object.fromEntries(
                [
                  "externalId",
                  "kind",
                  "courseId",
                  "courseName",
                  "title",
                  "url",
                  "course",
                ]
                  .filter((key) => entry.raw[key] !== undefined)
                  .map((key) => [key, entry.raw[key]]),
              )
            : entry.raw;
          const item = previous
            ? resourceInputSchema.parse(mergeObserved(previous, observation))
            : restrictedCatalog
              ? resourceInputSchema.parse({
                  ...observation,
                  text: "",
                  deadlines: [],
                })
              : entry.value;
          const hash = contentHash(item);
          const itemTextHash = textHash(item.title, item.text);
          const id = existing ? String(existing.id) : randomUUID();
          const modified = !existing || existing.content_hash !== hash;
          const revived = Boolean(existing?.deleted);
          const version = existing
            ? Number(existing.version) + Number(modified)
            : 1;
          if (!existing) {
            prepare(
              "INSERT INTO resources (id,source_id,external_id,content_hash,version,observed_at,captured_at,text_hash) VALUES (?,?,?,?,?,?,?,?)",
            ).run(
              id,
              source.id,
              item.externalId,
              hash,
              version,
              observedAt,
              capturedAt,
              itemTextHash,
            );
            report.created++;
          } else {
            prepare(
              "UPDATE resources SET content_hash=?,version=?,observed_at=?,captured_at=?,deleted=0,text_hash=? WHERE id=?",
            ).run(
              hash,
              version,
              observedAt,
              modified ? capturedAt : existing.captured_at,
              itemTextHash,
              id,
            );
            if (modified || revived) report.changed++;
            else report.unchanged++;
          }
          if (modified)
            prepare(
              "INSERT INTO resource_versions (resource_id,version,content_hash,payload,captured_at,text_hash) VALUES (?,?,?,?,?,?)",
            ).run(id, version, hash, encodePayload(item), capturedAt, itemTextHash);
          // Latest observation per field only (D4); history was never read.
          for (const field of observedFields(observation))
            prepare(
              `INSERT INTO field_observations VALUES (?,?,?,?,?) ON CONFLICT(resource_id, field) DO UPDATE SET
              observed_at=excluded.observed_at, read_id=excluded.read_id, version=excluded.version
              WHERE excluded.observed_at >= field_observations.observed_at`,
            ).run(
              id,
              field,
              observedAt,
              readId,
              version,
            );
          if (!previous)
            addChange(
              id,
              "new",
              {},
              { externalId: item.externalId, title: item.title },
            );
          if (revived)
            addChange(id, "restored", { deleted: true }, { deleted: false });
          if (previous && modified) {
            addChange(
              id,
              "updated",
              {
                contentHash: existing!.content_hash,
                updatedAt: previous.updatedAt,
              },
              { contentHash: hash, updatedAt: item.updatedAt },
            );
            const emitFields = (type: ChangeType, fields: string[]) => {
              const changed = fields.filter(
                (field) =>
                  canonical(fieldValue(previous, field)) !==
                  canonical(fieldValue(item, field)),
              );
              if (changed.length)
                addChange(
                  id,
                  type,
                  Object.fromEntries(
                    changed
                      .filter((f) => fieldValue(previous, f) !== undefined)
                      .map((f) => [f, fieldValue(previous, f)]),
                  ),
                  Object.fromEntries(
                    changed
                      .filter((f) => fieldValue(item, f) !== undefined)
                      .map((f) => [f, fieldValue(item, f)]),
                  ),
                );
            };
            emitFields("date_changed", [
              "dueAt",
              "lockAt",
              "unlockAt",
              "deadlines",
            ]);
            emitFields("requirements_changed", [
              "text",
              "rawHtml",
              "rubric",
              "submissionTypes",
            ]);
            const state = item.submission?.workflowState;
            if (
              (["submitted", "pending_review"].includes(state ?? "") &&
                state !== previous.submission?.workflowState) ||
              (item.submission?.submittedAt &&
                item.submission.submittedAt !==
                  previous.submission?.submittedAt) ||
              (item.submitted === true && previous.submitted !== true)
            )
              addChange(
                id,
                "submitted",
                {
                  submitted: previous.submitted,
                  submission: previous.submission ?? null,
                },
                {
                  submitted: item.submitted,
                  submission: item.submission ?? null,
                },
              );
            if (
              (state === "graded" &&
                state !== previous.submission?.workflowState) ||
              (item.submission?.score !== undefined &&
                item.submission.score !== null &&
                item.submission.score !== previous.submission?.score)
            )
              addChange(
                id,
                "graded",
                { submission: previous.submission ?? null },
                { submission: item.submission ?? null },
              );
          }
          if (modified || revived) {
            // The version's passages replace the old ones in the same transaction (T11b):
            // an old version is never searchable, and the new one is at once.
            passageIndex.index(
              id,
              version,
              itemTextHash,
              item,
              courseScope(source.accountScope, source.courseId),
            );
            // Jobs keyed to the text hash survive a submission or grade change (O5).
            prepare(
              `UPDATE jobs SET status='failed',error='Resource changed.',lease_until=NULL,lease_token=NULL WHERE resource_id=? AND input_hash NOT IN (?,?) AND status IN ('pending','running')`,
            ).run(id, hash, itemTextHash);
            prepare(
              `UPDATE jobs SET status='pending',attempts=0,run_after=?,error=NULL WHERE resource_id=? AND input_hash IN (?,?) AND status='failed' AND error IN ('Resource changed.','Resource deleted.','Resource changed or deleted.')`,
            ).run(capturedAt, id, hash, itemTextHash);
            enqueue("enrich.resource", id, hash, capturedAt);
          }
        }
        if (complete) {
          const present = prepare(
              "SELECT id,external_id,version FROM resources WHERE source_id=? AND deleted=0",
            )
            .all(source.id) as Row[];
          for (const row of present)
            if (!identities.has(String(row.external_id))) {
              const id = String(row.id);
              prepare(
                "UPDATE resources SET deleted=1,observed_at=? WHERE id=?",
              ).run(observedAt, id);
              passageIndex.remove(id);
              prepare(
                `UPDATE jobs SET status='failed',error='Resource deleted.',lease_until=NULL,lease_token=NULL WHERE resource_id=? AND status IN ('pending','running')`,
              ).run(id);
              addChange(id, "removed", { deleted: false }, { deleted: true });
              report.deleted++;
            }
          // Slowly adapt healthy baselines. An anomalous capture never teaches the detector its own failure.
          prepare(
            `INSERT INTO scope_baselines VALUES (?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET
            successful_reads=scope_baselines.successful_reads+1,record_count=scope_baselines.record_count*0.7+excluded.record_count*0.3,
            empty_text_ratio=scope_baselines.empty_text_ratio*0.7+excluded.empty_text_ratio*0.3,
            date_coverage_ratio=scope_baselines.date_coverage_ratio*0.7+excluded.date_coverage_ratio*0.3,observed_at=excluded.observed_at`,
          ).run(source.id, 1, count, emptyRatio, dateRatio, observedAt);
        }
        prepare("INSERT INTO counters VALUES ('change_seq', ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value").run(seq);
        if (source.courseId !== LIFE_COURSE_ID)
          rebuildIntelligence(source.accountScope, source.courseId, capturedAt);
        return report;
      });
    },

    resources(search?: string): Resource[] {
      const base = `SELECT r.*, v.payload, COALESCE(c.completed, 0) AS completed, ${FIELD_SEEN}
        FROM resources r JOIN resource_versions v ON v.resource_id = r.id AND v.version = r.version
        LEFT JOIN completions c ON c.resource_id = r.id`;
      if (!search?.trim())
        return (
          prepare(
            `${base} WHERE r.deleted = 0 ORDER BY r.source_id, r.external_id`,
          ).all() as Row[]
        ).map(readResource);
      // Passage search (T11b): all input is literal terms, never FTS operators or SQL. The best
      // passage ranks its resource; a page of at most 20 resources, in rank order.
      const ids = passageIndex.resourceIds(search);
      if (!ids?.length) return [];
      const rows = new Map(
        (
          prepare(
            `${base} WHERE r.deleted = 0 AND r.id IN (SELECT value FROM json_each(?))`,
          ).all(JSON.stringify(ids)) as Row[]
        ).map((row) => [String(row.id), row]),
      );
      return ids.flatMap((id) => {
        const row = rows.get(id);
        return row ? [readResource(row)] : [];
      });
    },
    resource(id) {
      const row = resourceRow(id);
      return row ? readResource(row) : undefined;
    },
    sources() {
      return (
        prepare(
            `SELECT s.*, (SELECT COUNT(*) FROM resources r WHERE r.source_id = s.id AND r.deleted = 0) AS resource_count
        FROM sources s ORDER BY s.id`,
          )
          .all() as Row[]
      ).map((row): SourceHealth => ({
        id: String(row.id),
        label: String(row.label),
        kind: row.kind as SourceHealth["kind"],
        accountScope: String(row.account_scope),
        courseId: String(row.course_id),
        scope: String(row.scope),
        status: row.status as SourceHealth["status"],
        lastAttemptAt: String(row.last_attempt_at),
        lastSuccessAt:
          row.last_success_at === null ? null : String(row.last_success_at),
        complete: Boolean(row.complete),
        resourceCount: Number(row.resource_count),
        ...JSON.parse(String(row.details)),
      }));
    },
    ingestionSettings() {
      const row = prepare("SELECT value FROM preferences WHERE key='ingestion'")
        .get();
      return row
        ? ingestionSettingsSchema.parse(JSON.parse(String(row.value)))
        : ingestionSettingsSchema.parse(defaultIngestionSettings);
    },
    setIngestionSettings(value) {
      const parsed = ingestionSettingsSchema.parse(value);
      prepare(
        "INSERT INTO preferences VALUES ('ingestion',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run(JSON.stringify(parsed));
    },
    courseOverrides() {
      return (
        prepare(
            "SELECT * FROM course_overrides ORDER BY account_scope,course_id",
          )
          .all() as Row[]
      ).map((r) => ({
        accountScope: String(r.account_scope),
        courseId: String(r.course_id),
        included: Boolean(r.included),
      }));
    },
    setCourseOverride(value) {
      const parsed = courseOverrideSchema.parse(value);
      if (parsed.included === null)
        prepare(
          "DELETE FROM course_overrides WHERE account_scope=? AND course_id=?",
        ).run(parsed.accountScope, parsed.courseId);
      else
        prepare(
          "INSERT INTO course_overrides VALUES (?,?,?) ON CONFLICT(account_scope,course_id) DO UPDATE SET included=excluded.included",
        ).run(parsed.accountScope, parsed.courseId, Number(parsed.included));
    },
    changes(filter = {}) {
      const conditions: string[] = [];
      const params: (string | number)[] = [];
      for (const [key, column] of [
        ["resourceId", "c.resource_id"],
        ["sourceId", "c.source_id"],
        ["courseId", "s.course_id"],
        ["accountScope", "s.account_scope"],
      ] as const)
        if (filter[key] !== undefined) {
          assertText(filter[key]!, key);
          conditions.push(`${column}=?`);
          params.push(filter[key]!);
        }
      if (filter.since !== undefined) {
        conditions.push("c.observed_at>=?");
        params.push(timestamp(filter.since));
      }
      const limit = filter.limit ?? 200;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000)
        throw new Error("Invalid change limit.");
      const rows = prepare(
          `SELECT c.*,s.account_scope,s.course_id,s.scope FROM resource_changes c JOIN sources s ON s.id=c.source_id ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY c.observed_at DESC,c.rowid DESC LIMIT ?`,
        )
        .all(...params, limit) as Row[];
      return rows.map((r): ResourceChange => ({
        id: String(r.id),
        resourceId: String(r.resource_id),
        sourceId: String(r.source_id),
        accountScope: String(r.account_scope),
        courseId: String(r.course_id),
        scope: String(r.scope),
        readId: String(r.read_id),
        observedAt: String(r.observed_at),
        type: r.type as ChangeType,
        oldValues: JSON.parse(String(r.old_values)),
        newValues: JSON.parse(String(r.new_values)),
      }));
    },
    scopeBaselines() {
      return (
        prepare("SELECT * FROM scope_baselines ORDER BY source_id")
          .all() as Row[]
      ).map((r): ScopeBaseline => ({
        sourceId: String(r.source_id),
        successfulReads: Number(r.successful_reads),
        recordCount: Number(r.record_count),
        emptyTextRatio: Number(r.empty_text_ratio),
        dateCoverageRatio: Number(r.date_coverage_ratio),
        observedAt: String(r.observed_at),
      }));
    },
    syncRuns() {
      return (
        prepare(
            "SELECT payload FROM sync_runs ORDER BY started_at DESC,id DESC LIMIT 100",
          )
          .all() as Row[]
      ).map((r) => syncRunSchema.parse(JSON.parse(String(r.payload))));
    },
    addSyncRun(value) {
      const parsed = syncRunSchema.parse(value);
      if (Date.parse(parsed.finishedAt) < Date.parse(parsed.startedAt))
        throw new Error("Sync finish precedes its start.");
      transaction(() => {
        prepare(
          "INSERT INTO sync_runs VALUES (?,?,?) ON CONFLICT(id) DO NOTHING",
        ).run(parsed.id, timestamp(parsed.startedAt), JSON.stringify(parsed));
        prepare(
          "DELETE FROM sync_runs WHERE id NOT IN (SELECT id FROM sync_runs ORDER BY started_at DESC,id DESC LIMIT 100)",
        ).run();
      });
    },
    mcpGrants() {
      return (
        prepare("SELECT payload FROM mcp_grants ORDER BY id").all() as Row[]
      ).map((r) => mcpGrantSchema.parse(JSON.parse(String(r.payload))));
    },
    setMcpGrant(value) {
      const parsed = mcpGrantSchema.parse(value);
      prepare(
        "INSERT INTO mcp_grants VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
      ).run(parsed.id, JSON.stringify(parsed));
    },
    privacy() {
      const row = prepare("SELECT value FROM preferences WHERE key = 'privacy'")
        .get();
      // owner: T06. Consent rides along read-only (non-enumerable; see readConsents).
      return withConsentRecords(
        row
          ? {
              ...defaultPrivacy,
              ...privacySchema.parse(JSON.parse(String(row.value))),
            }
          : { ...defaultPrivacy },
      );
      // end owner: T06
    },
    setPrivacy(value: PrivacyPreferences) {
      const parsed = privacySchema.parse(value);
      prepare(
        "INSERT INTO preferences VALUES ('privacy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(JSON.stringify(parsed));
    },
    // owner: T06. Consent records live in preferences under 'consents' (no schema change).
    // Only the `consent` command calls setConsent; the privacy command cannot reach it.
    consents() {
      return readConsents();
    },
    setConsent(change: ConsentChange, at: string) {
      const parsed = consentChangeSchema.parse(change);
      const kept = readConsents().filter((r) => r.recipient !== parsed.recipient);
      const next =
        parsed.action === "grant"
          ? [
              ...kept,
              consentRecordSchema.parse({
                recipient: parsed.recipient,
                disclosureVersion: parsed.disclosureVersion,
                grantedAt: timestamp(at),
              }),
            ]
          : kept;
      db.prepare(
        "INSERT INTO preferences VALUES ('consents', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(JSON.stringify(next));
    },
    // end owner: T06
    dayPlan() {
      return readDayPlan();
    },
    setDayPlanEntry(value) {
      const entry = dayPlanEntrySchema.parse(value);
      const { from, to } = dayPlanWindow();
      if (entry.date < from || entry.date > to)
        throw new Error("A plan entry must be dated within 14 days of today.");
      const rest = readDayPlan().filter(
        (e) => !(e.key === entry.key && e.date === entry.date),
      );
      writeDayPlan([...rest, entry]);
    },
    gitlabLinks() {
      return readGitlabLinks();
    },
    setGitlabLink(value) {
      const link = gitlabLinkSchema.parse(value);
      writeGitlabLinks([
        ...readGitlabLinks().filter((l) => !sameLink(l, link.accountScope, link.courseId, link.projectPath)),
        link,
      ]);
    },
    removeGitlabLink(accountScope, courseId, projectPath) {
      writeGitlabLinks(readGitlabLinks().filter((l) => !sameLink(l, accountScope, courseId, projectPath)));
    },
    removeDayPlanEntry(key, date) {
      writeDayPlan(
        readDayPlan().filter((e) => !(e.key === key && e.date === date)),
      );
    },
    notificationState() {
      const row = db
        .prepare("SELECT value FROM preferences WHERE key = 'notifications'")
        .get();
      if (!row) return { ...emptyNotificationState };
      try {
        const parsed = notificationStateSchema.safeParse(
          JSON.parse(String(row.value)),
        );
        return parsed.success ? parsed.data : { ...emptyNotificationState };
      } catch {
        return { ...emptyNotificationState };
      }
    },
    setNotificationState(value) {
      // Newest ids are appended last; keep the most recent within the schema's bound.
      const keep = (ids: string[]) => [...new Set(ids)].slice(-1000);
      const next = notificationStateSchema.parse({
        readIds: keep(value.readIds),
        dismissedIds: keep(value.dismissedIds),
      });
      db.prepare(
        "INSERT INTO preferences VALUES ('notifications', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(JSON.stringify(next));
    },
    baselineReadIds() {
      // The read that first captured each source: its "new" records are the starting point, not news.
      return (
        prepare(
          "SELECT read_id FROM resource_changes WHERE rowid IN (SELECT MIN(rowid) FROM resource_changes GROUP BY source_id)",
        ).all() as Row[]
      ).map((r) => String(r.read_id));
    },
    removeSource(sourceId) {
      return transaction(() => {
        const source = db
          .prepare("SELECT account_scope,course_id FROM sources WHERE id=?")
          .get(sourceId) as Row | undefined;
        if (!source) return 0;
        const ids = (
          db.prepare("SELECT id FROM resources WHERE source_id=?").all(sourceId) as Row[]
        ).map((r) => String(r.id));
        // The passage index (its contentless FTS rows), course profiles, and day plan are not
        // cleared by a resources foreign key alone; everything else cascades.
        for (const id of ids) passageIndex.remove(id);
        db.prepare("DELETE FROM sources WHERE id=?").run(sourceId);
        const account = String(source.account_scope),
          course = String(source.course_id);
        const remaining = db
          .prepare("SELECT 1 FROM sources WHERE account_scope=? AND course_id=? LIMIT 1")
          .get(account, course);
        if (remaining) rebuildIntelligence(account, course, clock().toISOString());
        else
          db.prepare("DELETE FROM course_intelligence WHERE id=?").run(
            courseIntelligenceId(account, course),
          );
        const removed = new Set(ids);
        const plan = readDayPlan();
        if (plan.some((e) => removed.has(e.block.resourceId)))
          writeDayPlan(plan.filter((e) => !removed.has(e.block.resourceId)));
        return ids.length;
      });
    },
    identityRoster() {
      // Stored in the existing preferences table: no schema change. Cleared by purge().
      const row = db
        .prepare("SELECT value FROM preferences WHERE key = 'identity_roster'")
        .get();
      return row
        ? identityRosterSchema.parse(JSON.parse(String(row.value)))
        : identityRosterSchema.parse({});
    },
    setIdentityRoster(value: IdentityRoster) {
      const parsed = identityRosterSchema.parse(value);
      db.prepare(
        "INSERT INTO preferences VALUES ('identity_roster', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(JSON.stringify(parsed));
    },
    autoIdentities() {
      // Kept apart from the manual roster so a sync can never overwrite manual entries.
      const row = db
        .prepare("SELECT value FROM preferences WHERE key = 'identity_roster_auto'")
        .get();
      return row
        ? autoIdentityStateSchema.parse(JSON.parse(String(row.value)))
        : { accounts: {} };
    },
    recordAutoIdentity(value: AutoIdentityUpdate) {
      const update = autoIdentityUpdateSchema.parse(value);
      const row = db
        .prepare("SELECT value FROM preferences WHERE key = 'identity_roster_auto'")
        .get();
      const state = row
        ? autoIdentityStateSchema.parse(JSON.parse(String(row.value)))
        : { accounts: {} as ReturnType<typeof autoIdentityStateSchema.parse>["accounts"] };
      const account = (state.accounts[update.accountScope] ??= { authorsByCourse: {} });
      // The current profile replaces the account's previous automatic self identity.
      if (update.self) account.self = update.self;
      if (update.courseId && update.authors?.length) {
        // Authors accumulate: a partial read never forgets a known student.
        const known = account.authorsByCourse[update.courseId] ?? [];
        account.authorsByCourse[update.courseId] = [...new Set([...known, ...update.authors])].slice(0, 2000);
      }
      db.prepare(
        "INSERT INTO preferences VALUES ('identity_roster_auto', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(JSON.stringify(autoIdentityStateSchema.parse(state)));
    },
    setCompleted(id, completed) {
      if (!liveResource(id))
        throw new Error(
          "Cannot change completion for a missing or deleted resource.",
        );
      prepare(
        `INSERT INTO completions VALUES (?, ?) ON CONFLICT(resource_id) DO UPDATE SET completed = excluded.completed`,
      ).run(id, Number(completed));
    },
    links() {
      return (
        prepare(
            `SELECT l.* FROM links l JOIN resources f ON f.id = l.from_id
        JOIN resources t ON t.id = l.to_id WHERE f.deleted = 0 AND t.deleted = 0
          AND f.content_hash = l.input_hash AND t.content_hash = l.target_hash ORDER BY l.id`,
          )
          .all() as Row[]
      ).map(readLink);
    },
    putLink(link) {
      assertText(link.id, "link ID");
      if (
        !["specifies", "supports", "same_as"].includes(link.type) ||
        !["proposed", "accepted", "rejected"].includes(link.status)
      )
        throw new Error("Invalid link type or status.");
      if (link.fromId === link.toId)
        throw new Error("A resource cannot link to itself.");
      transaction(() => {
        const from = liveResource(link.fromId, link.inputHash);
        const to = liveResource(link.toId);
        if (!from || !to)
          throw new Error(
            "Cannot save a link with missing, deleted, or stale input.",
          );
        const fromScope = prepare("SELECT account_scope, course_id FROM sources WHERE id = ?")
          .get(from.source_id)!;
        const toScope = prepare("SELECT account_scope, course_id FROM sources WHERE id = ?")
          .get(to.source_id)!;
        if (
          fromScope.account_scope !== toScope.account_scope ||
          fromScope.course_id !== toScope.course_id
        )
          throw new Error(
            "Automatic links must remain within one account and course.",
          );
        const existing = prepare("SELECT * FROM links WHERE id = ?")
          .get(link.id) as Row | undefined;
        if (
          existing &&
          (existing.from_id !== link.fromId ||
            existing.to_id !== link.toId ||
            existing.type !== link.type)
        )
          throw new Error(
            "A link ID cannot be reassigned to different endpoints or type.",
          );
        prepare(
          `INSERT INTO links (id, from_id, to_id, type, reason, status, input_hash, target_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET reason = excluded.reason, input_hash = excluded.input_hash, target_hash = excluded.target_hash,
            status = CASE WHEN links.status IN ('accepted', 'rejected') THEN links.status ELSE excluded.status END`,
        ).run(
          link.id,
          link.fromId,
          link.toId,
          link.type,
          link.reason,
          link.status,
          link.inputHash,
          to.content_hash,
        );
      });
    },
    decideLink(id, status) {
      if (!["accepted", "rejected"].includes(status))
        throw new Error("Invalid link decision.");
      const result = prepare(
          `UPDATE links SET status = ? WHERE id = ? AND EXISTS
        (SELECT 1 FROM resources f JOIN resources t ON t.id = links.to_id
          WHERE f.id = links.from_id AND f.deleted = 0 AND t.deleted = 0
            AND f.content_hash = links.input_hash AND t.content_hash = links.target_hash)`,
        )
        .run(status, id);
      if (!result.changes)
        throw new Error("Cannot decide a missing or stale link.");
    },
    enqueue,
    enqueueSubject(value, now) {
      const job = subjectJobSchema.parse(value);
      const time = timestamp(now);
      const resourceId =
        job.subjectKind === "resource" ? (job.resourceId ?? job.subjectId) : (job.resourceId ?? null);
      if (job.subjectKind === "resource" && resourceId !== job.subjectId)
        throw new Error("A resource job's subject is its resource.");
      const sourceId = job.sourceId ?? null;
      if (["course", "assessment", "source"].includes(job.subjectKind) && !sourceId)
        throw new Error("A course, assessment or source job names its source, so it cascades.");
      return transaction(() => {
        const row: Row = {
          subject_kind: job.subjectKind,
          subject_id: job.subjectId,
          resource_id: resourceId,
          source_id: sourceId,
          input_hash: job.inputHash,
        };
        if (sourceId && !prepare("SELECT 1 FROM sources WHERE id = ?").get(sourceId)) return false;
        if (!isFresh(row)) return false;
        return (
          Number(
            prepare(
              `INSERT OR IGNORE INTO jobs (id,kind,subject_kind,subject_id,resource_id,source_id,input_hash,status,attempts,run_after)
               VALUES (?,?,?,?,?,?,?,'pending',0,?)`,
            ).run(randomUUID(), job.kind, job.subjectKind, job.subjectId, resourceId, sourceId, job.inputHash, time)
              .changes,
          ) > 0
        );
      });
    },
    lease(now, leaseMs, kinds?: readonly string[]) {
      const time = timestamp(now);
      if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 3_600_000)
        throw new Error("Invalid job lease duration.");
      if (
        kinds !== undefined &&
        (!Array.isArray(kinds) || !kinds.length || kinds.length > 100 || !kinds.every((k) => typeof k === "string"))
      )
        throw new Error("Invalid job kinds.");
      const filter = kinds ? "AND kind IN (SELECT value FROM json_each(?))" : "";
      const params = kinds ? [JSON.stringify(kinds)] : [];
      return transaction(() => {
        // Only the head candidate is checked, so a lease is O(stale + 1), not a sweep of every job.
        for (;;) {
          const row = prepare(
            `SELECT * FROM jobs WHERE ((status = 'pending' AND run_after <= ?) OR (status = 'running' AND lease_until <= ?))
             ${filter} AND NOT EXISTS (
               SELECT 1 FROM preferences WHERE key = 'jobCooldown:' || jobs.kind AND value > ?
             ) ORDER BY run_after, rowid LIMIT 1`,
          ).get(time, time, ...params, time) as Row | undefined;
          if (!row) return undefined;
          const error =
            Number(row.attempts) >= MAX_ATTEMPTS
              ? "Retry limit reached."
              : !isFresh(row)
                ? "Resource changed or deleted."
                : undefined;
          if (error) {
            prepare(
              "UPDATE jobs SET status = 'failed', error = ?, lease_until = NULL, lease_token = NULL WHERE id = ?",
            ).run(error, row.id);
            continue;
          }
          const token = randomUUID();
          const until = new Date(Date.parse(time) + leaseMs).toISOString();
          prepare(
            `UPDATE jobs SET status = 'running', attempts = attempts + 1, lease_until = ?, lease_token = ?, error = NULL
            WHERE id = ?`,
          ).run(until, token, row.id);
          return readJob({
            ...row,
            status: "running",
            attempts: Number(row.attempts) + 1,
            lease_until: until,
            lease_token: token,
            error: null,
          });
        }
      });
    },
    jobCooldown(kind) {
      return (prepare("SELECT value FROM preferences WHERE key = ?").get(`jobCooldown:${kind}`) as Row | undefined)?.value as string | undefined;
    },
    defer(job, runAfter, reason, now = new Date().toISOString()) {
      const time = timestamp(now), until = timestamp(runAfter);
      if (until <= time) throw new Error("Job deferral must be in the future.");
      return transaction(() => {
        const row = prepare(
          `SELECT * FROM jobs WHERE id = ? AND status = 'running' AND lease_token = ?
           AND input_hash = ? AND kind = ? AND lease_until > ?`,
        ).get(job.id, job.leaseToken, job.inputHash, job.kind, time) as Row | undefined;
        if (!row || (row.resource_id ?? "") !== job.resourceId || !isFresh(row)) return false;
        prepare(`INSERT INTO preferences (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = MAX(value, excluded.value)`)
          .run(`jobCooldown:${job.kind}`, until);
        prepare(`UPDATE jobs SET status = 'pending', attempts = MAX(0, attempts - 1),
          run_after = ?, lease_until = NULL, lease_token = NULL, error = ? WHERE id = ?`)
          .run(until, reason.slice(0, 2000), job.id);
        return true;
      });
    },
    finish(job, error, now = new Date().toISOString()) {
      const time = timestamp(now);
      return transaction(() => {
        const row = prepare(
          `SELECT * FROM jobs WHERE id = ? AND status = 'running' AND lease_token = ?
          AND input_hash = ? AND lease_until > ?`,
        ).get(job.id, job.leaseToken, job.inputHash, time) as Row | undefined;
        if (!row || (row.resource_id ?? "") !== job.resourceId || !isFresh(row))
          return false;
        const failed = error !== undefined;
        const status = !failed
          ? "done"
          : Number(row.attempts) >= MAX_ATTEMPTS
            ? "failed"
            : "pending";
        const next = new Date(
          Date.parse(time) +
            Math.min(60_000, 1_000 * 2 ** (Number(row.attempts) - 1)),
        ).toISOString();
        prepare(
          `UPDATE jobs SET status = ?, run_after = ?, lease_until = NULL, lease_token = NULL, error = ? WHERE id = ?`,
        ).run(
          status,
          failed ? next : time,
          failed ? String(error).slice(0, 2000) : null,
          job.id,
        );
        return true;
      });
    },
    jobs() {
      return (
        prepare("SELECT * FROM jobs ORDER BY rowid").all() as Row[]
      ).map(readJob);
    },
    judgment(key) {
      const row = prepare(
          `SELECT j.* FROM judgments j JOIN resources r ON r.id = j.resource_id
        WHERE j.key = ? AND r.deleted = 0 AND (r.content_hash = j.input_hash OR r.text_hash = j.input_hash)`,
        )
        .get(key) as Row | undefined;
      return row ? readJudgment(row) : undefined;
    },
    putJudgment(value) {
      assertText(value.key, "judgment key", 4000);
      assertText(value.model, "judgment model");
      assertText(value.questionVersion, "question version");
      const createdAt = timestamp(value.createdAt);
      const result = JSON.stringify(value.result);
      if (result === undefined)
        throw new Error("A judgment result must be serializable.");
      return transaction(() => {
        if (!liveResource(value.resourceId, value.inputHash)) return false;
        const previous = prepare("SELECT * FROM judgments WHERE key = ?")
          .get(value.key) as Row | undefined;
        if (
          previous &&
          (previous.resource_id !== value.resourceId ||
            previous.input_hash !== value.inputHash ||
            previous.model !== value.model ||
            previous.question_version !== value.questionVersion)
        )
          throw new Error(
            "A judgment cache key cannot be reused for different inputs.",
          );
        if (previous && String(previous.created_at) > createdAt) return false;
        prepare(
          `INSERT INTO judgments VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET result = excluded.result, created_at = excluded.created_at`,
        ).run(
          value.key,
          value.resourceId,
          value.inputHash,
          value.model,
          value.questionVersion,
          result,
          createdAt,
        );
        return true;
      });
    },
    judgments() {
      return (
        prepare(
            `SELECT j.* FROM judgments j JOIN resources r ON r.id = j.resource_id
        WHERE r.deleted = 0 AND (r.content_hash = j.input_hash OR r.text_hash = j.input_hash) ORDER BY j.created_at, j.key`,
          )
          .all() as Row[]
      ).map(readJudgment);
    },
    addAttempt(value) {
      assertText(value.id, "attempt ID");
      assertText(value.itemId, "item ID");
      assertText(value.skill, "skill");
      if (!liveResource(value.resourceId))
        throw new Error(
          "Cannot record an attempt for a missing or deleted resource.",
        );
      if (
        !["none", "hint", "explained"].includes(value.assistance) ||
        typeof value.correct !== "boolean" ||
        typeof value.seenBefore !== "boolean" ||
        (value.confidence !== null &&
          (!Number.isFinite(value.confidence) ||
            value.confidence < 0 ||
            value.confidence > 1))
      )
        throw new Error("Invalid attempt evidence.");
      // Attempts are immutable; retries of an identical write are safe, conflicting IDs fail.
      const row = [
        value.id,
        value.resourceId,
        value.itemId,
        value.skill,
        Number(value.correct),
        value.assistance,
        Number(value.seenBefore),
        value.confidence,
        timestamp(value.createdAt),
      ] as const;
      const existing = prepare("SELECT * FROM attempts WHERE id = ?")
        .get(value.id);
      if (existing) {
        if (JSON.stringify(Object.values(existing)) !== JSON.stringify(row))
          throw new Error("An attempt ID cannot overwrite existing evidence.");
        return;
      }
      prepare("INSERT INTO attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        ...row,
      );
    },
    attempts(resourceId) {
      const rows =
        resourceId === undefined
          ? prepare("SELECT * FROM attempts ORDER BY created_at, id").all()
          : prepare(
                "SELECT * FROM attempts WHERE resource_id = ? ORDER BY created_at, id",
              )
              .all(resourceId);
      return (rows as Row[]).map((row): Attempt => ({
        id: String(row.id),
        resourceId: String(row.resource_id),
        itemId: String(row.item_id),
        skill: String(row.skill),
        correct: Boolean(row.correct),
        assistance: row.assistance as Attempt["assistance"],
        seenBefore: Boolean(row.seen_before),
        confidence: row.confidence === null ? null : Number(row.confidence),
        createdAt: String(row.created_at),
      }));
    },
    addReceipt(value) {
      addReceiptRow(value);
      // owner: platform-fix. At most one retention sweep a day while the app stays open.
      if (clock().getTime() - rolledUpAt > 86_400_000) rollUpReceipts();
    },
    receipts() {
      return (
        prepare("SELECT * FROM receipts ORDER BY created_at, id")
          .all() as Row[]
      ).map((row): EgressReceipt => ({
        id: String(row.id),
        recipient: String(row.recipient),
        purpose: String(row.purpose),
        categories: JSON.parse(String(row.categories)),
        resourceIds: JSON.parse(String(row.resource_ids)),
        characters: Number(row.characters),
        status: row.status as EgressReceipt["status"],
        createdAt: String(row.created_at),
      }));
    },
    purge() {
      // owner: platform-fix. Foreign keys off for the purge (the pragma is a no-op inside a
      // transaction, so it is set around it): every table empties whole, and no per-row FK check
      // or cascade runs. secure_delete stays on; the VACUUM below rewrites the file regardless.
      db.exec("PRAGMA foreign_keys = OFF");
      try {
        transaction(() => {
          // Every FTS index first, then every table in sqlite_schema, children before parents. Nothing
          // is listed by hand (P2 synthesis C3).
          for (const fts of ftsTables())
            db.exec(`INSERT INTO "${fts}"("${fts}") VALUES ('delete-all')`);
          for (const table of purgeOrder()) db.exec(`DELETE FROM "${table}"`);
          if (prepare("SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_sequence'").get())
            db.exec("DELETE FROM sqlite_sequence");
        });
      } finally {
        db.exec("PRAGMA foreign_keys = ON");
      }
      // The reader's receipt log names resources too: it goes with them.
      if (file) {
        const log = readerReceiptLogPath(path);
        for (const f of [log, `${log}.importing`]) rmSync(f, { force: true });
      }
      // end owner: platform-fix
      passageIndex.invalidate();
      // Compact the SQLite files. A reader holding a snapshot keeps its pages until it ends.
      db.exec(
        "PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);",
      );
      // The pre-migration backup is a full plaintext copy we wrote: it goes too.
      for (const backupFile of backupFiles()) rmSync(backupFile, { force: true });
    },
    passages: (resourceId) => passageIndex.passages(resourceId),
    passage: (pid) => passageIndex.passage(pid),
    rebuildPassages(resourceId) {
      return transaction(() => {
        const row = prepare(
          `SELECT r.id, r.version, r.text_hash, s.account_scope, s.course_id, v.payload FROM resources r
           JOIN sources s ON s.id = r.source_id
           JOIN resource_versions v ON v.resource_id = r.id AND v.version = r.version
           WHERE r.id = ? AND r.deleted = 0`,
        ).get(resourceId) as Row | undefined;
        if (!row) return 0;
        return passageIndex.index(
          resourceId,
          Number(row.version),
          String(row.text_hash),
          decodePayload(row.payload),
          courseScope(String(row.account_scope), String(row.course_id)),
        );
      });
    },
    searchPassages: (input) => passageIndex.search(input),
    changesAfter(after, limit = 200) {
      if (!Number.isSafeInteger(after) || after < 0) throw new Error("Invalid change cursor.");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000)
        throw new Error("Invalid change limit.");
      return (
        prepare(
          `SELECT c.*,s.account_scope,s.course_id,s.scope FROM resource_changes c JOIN sources s ON s.id=c.source_id
           WHERE c.seq > ? ORDER BY c.seq LIMIT ?`,
        ).all(after, limit) as Row[]
      ).map((r): ChangeWithSeq => ({
        id: String(r.id),
        resourceId: String(r.resource_id),
        sourceId: String(r.source_id),
        accountScope: String(r.account_scope),
        courseId: String(r.course_id),
        scope: String(r.scope),
        readId: String(r.read_id),
        observedAt: String(r.observed_at),
        type: r.type as ChangeType,
        oldValues: JSON.parse(String(r.old_values)),
        newValues: JSON.parse(String(r.new_values)),
        seq: Number(r.seq),
      }));
    },
    migrationBackup() {
      return migrationBackup && existsSync(migrationBackup) ? migrationBackup : null;
    },
    ...courseCore,
    ...graph,
    sourceResources(sourceId: string) {
      return (
        prepare(
          `SELECT r.*, v.payload, COALESCE(c.completed, 0) AS completed, ${FIELD_SEEN}
           FROM resources r JOIN resource_versions v ON v.resource_id = r.id AND v.version = r.version
           LEFT JOIN completions c ON c.resource_id = r.id WHERE r.source_id = ? AND r.deleted = 0 ORDER BY r.external_id`,
        ).all(sourceId) as Row[]
      ).map(readResource);
    },
    courseResources(course: CourseRef) {
      return (
        prepare(
          `SELECT r.*, v.payload, COALESCE(c.completed, 0) AS completed, s.scope AS source_scope, ${FIELD_SEEN}
           FROM resources r JOIN resource_versions v ON v.resource_id = r.id AND v.version = r.version
           JOIN sources s ON s.id = r.source_id LEFT JOIN completions c ON c.resource_id = r.id
           WHERE s.account_scope = ? AND s.course_id = ? AND r.deleted = 0 ORDER BY r.source_id, r.external_id`,
        ).all(course.accountScope, course.courseId) as Row[]
      ).map((row) => ({ ...readResource(row), scope: String(row.source_scope) }));
    },
    // owner: platform-fix
    importReaderReceipts,
    receiptCounts: readReceiptCounts,
    // end owner: platform-fix
  };
  // owner: platform-fix. The writer takes in what the reader logged while it was away. (The retention
  // sweep runs with the next receipt, never at open, so opening or migrating keeps every row.)
  if (!readOnly) importReaderReceipts();
  return api;
  // end owner: platform-fix
}
