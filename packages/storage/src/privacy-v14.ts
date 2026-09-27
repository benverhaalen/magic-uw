/**
 * owner: privacy. Migration v14 (the lead renumbers at integration): additive and idempotent.
 * - `receipts.protection`: replacement counts per kind for each hosted send (never values).
 * - Marks existing rows for the lazy seal pass. Sealing needs the key, which only arrives from
 *   main after the store is open, so the migration cannot encrypt; `sealExistingRows` runs on
 *   the first `setAtRestKey` after it (and again after any unsealed write).
 */
import type { DatabaseSync } from "node:sqlite";
import {
  PLANNING_CAPTURE_AAD,
  PLANNING_VERSION_AAD,
  isSealed,
  sensitiveItem,
  type AtRestCodec,
} from "../../core/src/privacy/at-rest";
import { decodePayload, encodePayload } from "./payload";
import type { ResourceInput } from "@magic/contracts";

export const PRIVACY_SCHEMA_VERSION = 14;

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
