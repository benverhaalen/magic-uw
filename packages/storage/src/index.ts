import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  captureBatchSchema,
  defaultPrivacy,
  instant,
  privacySchema,
  type Attempt,
  type CaptureBatch,
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

const SCHEMA_VERSION = 2;
const MAX_ATTEMPTS = 3;
type Row = Record<string, string | number | bigint | Uint8Array | null>;

function timestamp(value: string): string {
  return new Date(instant.parse(value)).toISOString();
}

function contentHash(value: ResourceInput): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertText(value: string, name: string, max = 512): void {
  if (typeof value !== "string" || !value.length || value.length > max)
    throw new Error(`Invalid ${name}.`);
}

/** One local writer. Network requests and model inference must happen outside its transactions. */
export function createStore(path: string): Store {
  if (path !== ":memory:")
    mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  if (path !== ":memory:") chmodSync(path, 0o600);
  db.exec(
    "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;",
  );
  const schemaVersion = Number(
    db.prepare("PRAGMA user_version").get()!.user_version,
  );
  if (schemaVersion > SCHEMA_VERSION) {
    db.close();
    throw new Error(
      "This database was created by a newer Magic Canvas version.",
    );
  }

  function transaction<T>(operation: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  if (schemaVersion === 0)
    transaction(() => {
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
    });

  if (schemaVersion < 2)
    transaction(() => {
      // Old links lack target evidence versions: hide them until their evidence is checked again.
      db.exec(
        "ALTER TABLE links ADD COLUMN target_hash TEXT NOT NULL DEFAULT ''; PRAGMA user_version = 2;",
      );
    });

  function resourceRow(id: string): Row | undefined {
    return db
      .prepare(
        `SELECT r.*, v.payload, COALESCE(c.completed, 0) AS completed
      FROM resources r JOIN resource_versions v ON v.resource_id = r.id AND v.version = r.version
      LEFT JOIN completions c ON c.resource_id = r.id WHERE r.id = ?`,
      )
      .get(id) as Row | undefined;
  }

  function readResource(row: Row): Resource {
    return {
      ...(JSON.parse(String(row.payload)) as ResourceInput),
      id: String(row.id),
      sourceId: String(row.source_id),
      contentHash: String(row.content_hash),
      version: Number(row.version),
      observedAt: String(row.observed_at),
      capturedAt: String(row.captured_at),
      deleted: Boolean(row.deleted),
      completed: Boolean(row.completed),
    };
  }

  function liveResource(id: string, hash?: string): Row | undefined {
    const row = db
      .prepare("SELECT * FROM resources WHERE id = ? AND deleted = 0")
      .get(id) as Row | undefined;
    return row && (hash === undefined || row.content_hash === hash)
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
    db.prepare(
      `INSERT OR IGNORE INTO jobs
      (id, kind, resource_id, input_hash, status, attempts, run_after)
      VALUES (?, ?, ?, ?, 'pending', 0, ?)`,
    ).run(randomUUID(), kind, resourceId, inputHash, time);
  }

  function readJob(row: Row): Job {
    return {
      id: String(row.id),
      kind: String(row.kind),
      resourceId: String(row.resource_id),
      inputHash: String(row.input_hash),
      status: row.status as Job["status"],
      attempts: Number(row.attempts),
      runAfter: String(row.run_after),
      leaseUntil: row.lease_until === null ? null : String(row.lease_until),
      leaseToken: row.lease_token === null ? null : String(row.lease_token),
      error: row.error === null ? null : String(row.error),
    };
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

  let closed = false;
  return {
    close() {
      if (!closed) {
        db.close();
        closed = true;
      }
    },

    ingest(input: CaptureBatch): IngestReport {
      const batch = captureBatchSchema.parse(input);
      const observedAt = timestamp(batch.observedAt);
      const capturedAt = new Date().toISOString();
      const source = batch.source;
      const complete = batch.status === "ok" && batch.complete;
      const identities = new Set<string>();
      for (const item of batch.resources) {
        if (item.courseId !== source.courseId)
          throw new Error("Resource course does not match its capture scope.");
        if (identities.has(item.externalId))
          throw new Error(
            "A capture contains duplicate external resource IDs.",
          );
        identities.add(item.externalId);
      }
      return transaction(() => {
        const prior = db
          .prepare("SELECT * FROM sources WHERE id = ?")
          .get(source.id) as Row | undefined;
        if (
          prior &&
          (prior.account_scope !== source.accountScope ||
            prior.course_id !== source.courseId ||
            prior.scope !== source.scope ||
            prior.kind !== source.kind)
        ) {
          throw new Error(
            "A source ID cannot be reassigned to another account, course, kind, or scope.",
          );
        }
        const report: IngestReport = {
          created: 0,
          changed: 0,
          unchanged: 0,
          deleted: 0,
          ignored: false,
        };
        // Equal timestamps are retries, not a second opportunity to rewrite an observation.
        if (prior && observedAt <= String(prior.last_attempt_at))
          return { ...report, ignored: true };
        db.prepare(
          `INSERT INTO sources
          (id, label, kind, account_scope, course_id, scope, status, last_attempt_at, last_success_at, complete)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET label = excluded.label, status = excluded.status,
            last_attempt_at = excluded.last_attempt_at,
            last_success_at = COALESCE(excluded.last_success_at, sources.last_success_at), complete = excluded.complete`,
        ).run(
          source.id,
          source.label,
          source.kind,
          source.accountScope,
          source.courseId,
          source.scope,
          batch.status,
          observedAt,
          complete ? observedAt : null,
          Number(complete),
        );
        db.prepare(
          `INSERT INTO source_observations VALUES (?, ?, ?, ?, ?)`,
        ).run(
          source.id,
          observedAt,
          batch.status,
          Number(complete),
          batch.resources.length,
        );

        for (const item of batch.resources) {
          const hash = contentHash(item);
          const existing = db
            .prepare(
              "SELECT * FROM resources WHERE source_id = ? AND external_id = ?",
            )
            .get(source.id, item.externalId) as Row | undefined;
          const id = existing ? String(existing.id) : randomUUID();
          const modified = !existing || existing.content_hash !== hash;
          const revived = Boolean(existing?.deleted);
          const version = existing
            ? Number(existing.version) + Number(modified)
            : 1;
          if (!existing) {
            db.prepare(
              `INSERT INTO resources (id, source_id, external_id, content_hash, version, observed_at, captured_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
            ).run(
              id,
              source.id,
              item.externalId,
              hash,
              version,
              observedAt,
              capturedAt,
            );
            report.created++;
          } else {
            db.prepare(
              `UPDATE resources SET content_hash = ?, version = ?, observed_at = ?,
              captured_at = ?, deleted = 0 WHERE id = ?`,
            ).run(
              hash,
              version,
              observedAt,
              modified ? capturedAt : existing.captured_at,
              id,
            );
            if (modified || revived) report.changed++;
            else report.unchanged++;
          }
          if (modified)
            db.prepare(
              "INSERT INTO resource_versions VALUES (?, ?, ?, ?, ?)",
            ).run(id, version, hash, JSON.stringify(item), capturedAt);
          db.prepare("INSERT INTO observations VALUES (?, ?, ?, 0)").run(
            id,
            observedAt,
            version,
          );
          if (modified || revived) {
            db.prepare("DELETE FROM resource_search WHERE resource_id = ?").run(
              id,
            );
            db.prepare(
              "INSERT INTO resource_search(resource_id, title, course_name, body) VALUES (?, ?, ?, ?)",
            ).run(id, item.title, item.courseName, item.text);
            db.prepare(
              `UPDATE jobs SET status = 'failed', error = 'Resource changed.', lease_until = NULL, lease_token = NULL
              WHERE resource_id = ? AND input_hash <> ? AND status IN ('pending', 'running')`,
            ).run(id, hash);
            db.prepare(
              `UPDATE jobs SET status = 'pending', attempts = 0, run_after = ?, error = NULL
              WHERE resource_id = ? AND input_hash = ? AND status = 'failed'
                AND error IN ('Resource changed.', 'Resource deleted.', 'Resource changed or deleted.')`,
            ).run(capturedAt, id, hash);
            enqueue("enrich.resource", id, hash, capturedAt);
          }
        }
        // Only a complete enumeration of this exact source scope proves absence.
        if (complete) {
          const present = db
            .prepare(
              "SELECT id, external_id, version FROM resources WHERE source_id = ? AND deleted = 0",
            )
            .all(source.id) as Row[];
          for (const row of present)
            if (!identities.has(String(row.external_id))) {
              const id = String(row.id);
              db.prepare(
                "UPDATE resources SET deleted = 1, observed_at = ? WHERE id = ?",
              ).run(observedAt, id);
              db.prepare("INSERT INTO observations VALUES (?, ?, ?, 1)").run(
                id,
                observedAt,
                row.version,
              );
              db.prepare(
                "DELETE FROM resource_search WHERE resource_id = ?",
              ).run(id);
              db.prepare(
                `UPDATE jobs SET status = 'failed', error = 'Resource deleted.', lease_until = NULL, lease_token = NULL
              WHERE resource_id = ? AND status IN ('pending', 'running')`,
              ).run(id);
              report.deleted++;
            }
        }
        return report;
      });
    },

    resources(search?: string): Resource[] {
      // Treat all input as literal search terms, never as FTS operators or SQL.
      const terms =
        search
          ?.normalize("NFKC")
          .match(/[\p{L}\p{N}_]+/gu)
          ?.slice(0, 50) ?? [];
      if (search?.trim() && !terms.length) return [];
      const match = terms.map((term) => `"${term}"*`).join(" AND ");
      const base = `SELECT r.*, v.payload, COALESCE(c.completed, 0) AS completed
        FROM resources r JOIN resource_versions v ON v.resource_id = r.id AND v.version = r.version
        LEFT JOIN completions c ON c.resource_id = r.id`;
      const rows = match
        ? db
            .prepare(
              `${base} JOIN resource_search s ON s.resource_id = r.id
            WHERE r.deleted = 0 AND resource_search MATCH ? ORDER BY rank, r.id`,
            )
            .all(match)
        : db
            .prepare(
              `${base} WHERE r.deleted = 0 ORDER BY r.source_id, r.external_id`,
            )
            .all();
      return (rows as Row[]).map(readResource);
    },
    resource(id) {
      const row = resourceRow(id);
      return row ? readResource(row) : undefined;
    },
    sources() {
      return (
        db
          .prepare(
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
      }));
    },
    privacy() {
      const row = db
        .prepare("SELECT value FROM preferences WHERE key = 'privacy'")
        .get();
      return row
        ? privacySchema.parse(JSON.parse(String(row.value)))
        : { ...defaultPrivacy };
    },
    setPrivacy(value: PrivacyPreferences) {
      const parsed = privacySchema.parse(value);
      db.prepare(
        "INSERT INTO preferences VALUES ('privacy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(JSON.stringify(parsed));
    },
    setCompleted(id, completed) {
      if (!liveResource(id))
        throw new Error(
          "Cannot change completion for a missing or deleted resource.",
        );
      db.prepare(
        `INSERT INTO completions VALUES (?, ?) ON CONFLICT(resource_id) DO UPDATE SET completed = excluded.completed`,
      ).run(id, Number(completed));
    },
    links() {
      return (
        db
          .prepare(
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
        const fromScope = db
          .prepare("SELECT account_scope, course_id FROM sources WHERE id = ?")
          .get(from.source_id)!;
        const toScope = db
          .prepare("SELECT account_scope, course_id FROM sources WHERE id = ?")
          .get(to.source_id)!;
        if (
          fromScope.account_scope !== toScope.account_scope ||
          fromScope.course_id !== toScope.course_id
        )
          throw new Error(
            "Automatic links must remain within one account and course.",
          );
        const existing = db
          .prepare("SELECT * FROM links WHERE id = ?")
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
        db.prepare(
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
      const result = db
        .prepare(
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
    lease(now, leaseMs) {
      const time = timestamp(now);
      if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 3_600_000)
        throw new Error("Invalid job lease duration.");
      return transaction(() => {
        db.prepare(
          `UPDATE jobs SET status = 'failed', error = 'Resource changed or deleted.', lease_until = NULL, lease_token = NULL
          WHERE status IN ('pending', 'running') AND NOT EXISTS
          (SELECT 1 FROM resources r WHERE r.id = jobs.resource_id AND r.content_hash = jobs.input_hash AND r.deleted = 0)`,
        ).run();
        db.prepare(
          `UPDATE jobs SET status = 'failed', error = 'Retry limit reached.', lease_until = NULL, lease_token = NULL
          WHERE attempts >= ? AND ((status = 'running' AND lease_until <= ?) OR status = 'pending')`,
        ).run(MAX_ATTEMPTS, time);
        const row = db
          .prepare(
            `SELECT * FROM jobs WHERE attempts < ? AND
          ((status = 'pending' AND run_after <= ?) OR (status = 'running' AND lease_until <= ?))
          ORDER BY run_after, rowid LIMIT 1`,
          )
          .get(MAX_ATTEMPTS, time, time) as Row | undefined;
        if (!row) return undefined;
        const token = randomUUID();
        const until = new Date(Date.parse(time) + leaseMs).toISOString();
        db.prepare(
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
      });
    },
    finish(job, error, now = new Date().toISOString()) {
      const time = timestamp(now);
      return transaction(() => {
        const row = db
          .prepare(
            `SELECT * FROM jobs WHERE id = ? AND status = 'running' AND lease_token = ?
          AND resource_id = ? AND input_hash = ? AND lease_until > ?`,
          )
          .get(job.id, job.leaseToken, job.resourceId, job.inputHash, time) as
          Row | undefined;
        if (!row || !liveResource(job.resourceId, job.inputHash)) return false;
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
        db.prepare(
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
        db.prepare("SELECT * FROM jobs ORDER BY rowid").all() as Row[]
      ).map(readJob);
    },
    judgment(key) {
      const row = db
        .prepare(
          `SELECT j.* FROM judgments j JOIN resources r ON r.id = j.resource_id
        WHERE j.key = ? AND r.deleted = 0 AND r.content_hash = j.input_hash`,
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
        const previous = db
          .prepare("SELECT * FROM judgments WHERE key = ?")
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
        db.prepare(
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
        db
          .prepare(
            `SELECT j.* FROM judgments j JOIN resources r ON r.id = j.resource_id
        WHERE r.deleted = 0 AND r.content_hash = j.input_hash ORDER BY j.created_at, j.key`,
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
      const existing = db
        .prepare("SELECT * FROM attempts WHERE id = ?")
        .get(value.id);
      if (existing) {
        if (JSON.stringify(Object.values(existing)) !== JSON.stringify(row))
          throw new Error("An attempt ID cannot overwrite existing evidence.");
        return;
      }
      db.prepare("INSERT INTO attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        ...row,
      );
    },
    attempts(resourceId) {
      const rows =
        resourceId === undefined
          ? db.prepare("SELECT * FROM attempts ORDER BY created_at, id").all()
          : db
              .prepare(
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
      assertText(value.id, "receipt ID");
      assertText(value.recipient, "receipt recipient");
      assertText(value.purpose, "receipt purpose", 2000);
      if (
        !["blocked", "sent", "failed"].includes(value.status) ||
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
      db.prepare(
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
    },
    receipts() {
      return (
        db
          .prepare("SELECT * FROM receipts ORDER BY created_at, id")
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
      transaction(() => {
        db.exec(`DELETE FROM receipts; DELETE FROM preferences; DELETE FROM resource_search; DELETE FROM sources;
          INSERT INTO resource_search(resource_search) VALUES ('optimize');`);
      });
      // Delete live database content and compact SQLite files; this is not a promise to erase backups or SSD history.
      db.exec(
        "PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);",
      );
    },
  };
}
