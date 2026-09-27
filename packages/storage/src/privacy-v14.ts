/**
 * owner: privacy. Migration v14 (the lead renumbers at integration): additive and idempotent.
 * - `receipts.protection`: replacement counts per kind for each hosted send (never values).
 * - Marks existing rows for the lazy seal pass. Sealing needs the key, which only arrives from
 *   main after the store is open, so the migration cannot encrypt; `sealExistingRows` runs on
 *   the first `setAtRestKey` after it (and again after any unsealed write).
 * - The pre-migration backup of a database older than v14 is a plaintext copy of mail, notes and
 *   planning. After the migration commits, `verifyAndDropBackup` checks the live database
 *   (`PRAGMA integrity_check`, and every carried-over table's row count against the backup) and
 *   deletes the backup; a failed check keeps it and reports why.
 */
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  LIFE_GIST_AAD,
  LIFE_SENDER_AAD,
  PLANNING_CAPTURE_AAD,
  PLANNING_VERSION_AAD,
  isSealed,
  sensitiveItem,
  type AtRestCodec,
} from "../../core/src/privacy/at-rest";
import { decodePayload, encodePayload } from "./payload";
import type { ResourceInput } from "@magic/contracts";

export const PRIVACY_SCHEMA_VERSION = 14;

export type BackupCheck = { status: "deleted"; tables: number } | { status: "kept"; path: string; reason: string };
/**
 * Tables whose row counts a migration after `from` changes by design: v6 keeps only the latest
 * observation per field; v12 prunes the planning capture log.
 */
const rewrittenAfter = (from: number) => new Set([...(from < 6 ? ["field_observations"] : []), ...(from < 12 ? ["planning_captures"] : [])]);

function ordinaryTables(db: DatabaseSync): string[] {
  const all = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  const virtual = all.filter((t) => /^CREATE VIRTUAL TABLE/i.test(String(t.sql))).map((t) => String(t.name));
  const shadow = (name: string) => virtual.some((v) => name.startsWith(`${v}_`));
  return all.map((t) => String(t.name)).filter((n) => !virtual.includes(n) && !shadow(n));
}
const count = (db: DatabaseSync, table: string) => Number(db.prepare(`SELECT count(*) AS n FROM "${table.replaceAll('"', '""')}"`).get()!.n);

/** Verify a committed migration against its backup; delete the backup only if both checks pass. */
export function verifyAndDropBackup(db: DatabaseSync, backupPath: string, from: number): BackupCheck {
  const kept = (reason: string): BackupCheck => ({ status: "kept", path: backupPath, reason });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").all().map((r) => String(Object.values(r)[0]));
    if (integrity.length !== 1 || integrity[0] !== "ok") return kept(`integrity_check: ${integrity.slice(0, 3).join("; ")}`);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    let tables = 0;
    try {
      const live = new Set(ordinaryTables(db));
      const skip = rewrittenAfter(from);
      for (const table of ordinaryTables(backup)) {
        if (!live.has(table) || skip.has(table)) continue;
        const [before, after] = [count(backup, table), count(db, table)];
        if (before !== after) return kept(`row count of ${table}: ${before} before, ${after} after`);
        tables++;
      }
    } finally {
      backup.close();
    }
    rmSync(backupPath, { force: true });
    return { status: "deleted", tables };
  } catch (error) {
    return kept(error instanceof Error ? error.message : "the check could not run");
  }
}

export function privacyMigration(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(receipts)").all().map((r) => String(r.name));
  if (!columns.includes("protection")) db.exec("ALTER TABLE receipts ADD COLUMN protection TEXT");
  db.exec(`
    CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO preferences(key, value) VALUES ('privacy.seal', 'pending')
      ON CONFLICT(key) DO UPDATE SET value = 'pending';
    PRAGMA user_version = ${PRIVACY_SCHEMA_VERSION};`);
}

/**
 * Seal every sensitive row still in plaintext; reindex current mail versions so the full-text
 * index holds only subject and category. The caller runs it inside a transaction.
 */
export function sealExistingRows(
  db: DatabaseSync,
  codec: AtRestCodec,
  reindex: (resourceId: string, version: number, textHash: string, item: ResourceInput, accountScope: string, courseId: string) => void,
): number {
  if (!codec.hasKey()) return 0;
  let sealed = 0;
  const update = db.prepare("UPDATE resource_versions SET payload = ? WHERE resource_id = ? AND version = ?");
  for (const row of db.prepare("SELECT resource_id, version, payload FROM resource_versions").all()) {
    const item = decodePayload(row.payload) as ResourceInput & { __sealed?: unknown };
    if (!sensitiveItem(item) || item.__sealed) continue;
    update.run(encodePayload(codec.sealItem(item)), String(row.resource_id), Number(row.version));
    sealed++;
  }
  for (const row of db
    .prepare(
      `SELECT r.id, r.version, r.text_hash, s.account_scope, s.course_id, v.payload FROM resources r
       JOIN sources s ON s.id = r.source_id
       JOIN resource_versions v ON v.resource_id = r.id AND v.version = r.version WHERE r.deleted = 0`,
    )
    .all()) {
    const item = codec.openItem(decodePayload(row.payload));
    if (!item.mail) continue;
    reindex(String(row.id), Number(row.version), String(row.text_hash), item, String(row.account_scope), String(row.course_id));
  }
  // life_items: the sender and gist columns.
  const life = db.prepare("UPDATE life_items SET sender = ?, gist = ? WHERE id = ?");
  for (const row of db.prepare("SELECT id, sender, gist FROM life_items").all()) {
    const sender = row.sender === null ? null : String(row.sender), gist = String(row.gist);
    if ((sender === null || isSealed(sender)) && isSealed(gist)) continue;
    life.run(sender === null || isSealed(sender) ? sender : codec.sealText(sender, LIFE_SENDER_AAD), isSealed(gist) ? gist : codec.sealText(gist, LIFE_GIST_AAD), String(row.id));
    sealed++;
  }
  for (const [table, key, aad] of [
    ["planning_captures", "source_id, observed_at", PLANNING_CAPTURE_AAD],
    ["planning_versions", "local_id, version", PLANNING_VERSION_AAD],
  ] as const) {
    const [a, b] = key.split(", ") as [string, string];
    const write = db.prepare(`UPDATE ${table} SET payload = ? WHERE ${a} = ? AND ${b} = ?`);
    for (const row of db.prepare(`SELECT ${key}, payload FROM ${table}`).all()) {
      const payload = String(row.payload);
      if (isSealed(payload)) continue;
      write.run(codec.sealJson(JSON.parse(payload), aad), row[a] as string | number, row[b] as string | number);
      sealed++;
    }
  }
  return sealed;
}
