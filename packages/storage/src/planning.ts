import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  planningCaptureSchema, planningRecordSchema,
  type PlanningCapture, type PlanningRecord, type PlanningSourceHealth, type StoredPlanningRecord,
} from "@magic/contracts";
// owner: privacy. Captures (DARS, transcript) and record versions are sealed at rest.
import { PLANNING_CAPTURE_AAD, PLANNING_VERSION_AAD, type AtRestCodec } from "../../core/src/privacy/at-rest";

const digest = (value: unknown): string => createHash("sha256").update(stable(value)).digest("hex");
const privateKinds = new Set<PlanningRecord["kind"]>(["course_history", "audit", "hold", "appointment", "advisor", "student_summary", "account_link"]);
const scopeKinds: Record<PlanningCapture["scope"]["kind"], readonly PlanningRecord["kind"][]> = {
  terms: ["term"], subjects: ["subject", "crosslist"], student_record: ["hold", "appointment", "advisor", "student_summary", "account_link"],
  degree_plan: ["course_history"], audit_program: ["audit"], catalog_term: ["catalog_course", "enrollment_package", "crosslist"],
  enrollment_term: ["enrollment_package"], grade_course: ["grade_distribution"], academic_calendar: [], policy: [],
};
function recordMatchesScope(record: PlanningRecord, capture: PlanningCapture): boolean {
  if (record.provenance.scope.kind !== capture.scope.kind || record.provenance.scope.key !== capture.scope.key || !scopeKinds[capture.scope.kind].includes(record.kind)) return false;
  if (capture.accountScope === "public" && (privateKinds.has(record.kind) || record.kind === "enrollment_package" && record.enrollmentState === "enrolled")) return false;
  if (capture.scope.kind === "enrollment_term" && (record.kind !== "enrollment_package" || record.termCode !== capture.scope.key)) return false;
  // A dated catalog scope cannot contain a different term's offerings. Annual Guide scopes can be undated.
  if (capture.scope.kind === "catalog_term" && /^1\d{2}[246]$/.test(capture.scope.key) && "termCode" in record && record.termCode !== null && record.termCode !== capture.scope.key) return false;
  return true;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Account-wide academic records are isolated from coursework search, MCP, and AI context. */
export function planningRepository(db: DatabaseSync, atRest?: AtRestCodec) {
  // owner: privacy. Without a codec (or a key) values stay JSON; a value that cannot be opened is skipped.
  const sealJson = (value: unknown, aad: string) => (atRest ? atRest.sealJson(value, aad) : JSON.stringify(value));
  const openVersion = (text: string): PlanningRecord | null => {
    try {
      return (atRest ? atRest.openJson(text, PLANNING_VERSION_AAD) : JSON.parse(text)) as PlanningRecord;
    } catch {
      return null;
    }
  };
  function sources(): PlanningSourceHealth[] {
    return db.prepare("SELECT payload FROM planning_sources ORDER BY id").all().map((r) => JSON.parse(String(r.payload)));
  }
  return {
    planningSources: sources,
    planningRecords(): StoredPlanningRecord[] {
      return db.prepare(`SELECT r.*, v.payload FROM planning_records r JOIN planning_versions v ON v.local_id=r.local_id AND v.version=r.version ORDER BY r.local_id`).all().flatMap((r) => {
        const record = openVersion(String(r.payload)); // owner: privacy
        return record ? [{ r, record }] : [];
      }).map(({ r, record }) => ({
        ...record,
        provenance: { ...record.provenance, observedAt: String(r.observed_at) },
        localId: String(r.local_id), sourceId: String(r.source_id),
        accountScope: String(r.account_scope), contentHash: String(r.content_hash), version: Number(r.version), deleted: Boolean(r.deleted),
      }));
    },
    ingestPlanning(input: unknown) {
      // Validate metadata before any write; isolate malformed records and downgrade deletion authority.
      if (!input || typeof input !== "object" || !Array.isArray((input as any).records) || (input as any).records.length > 10000) throw new Error("Invalid planning capture.");
      const raw = input as PlanningCapture;
      let capture = planningCaptureSchema.parse({ ...raw, records: [] });
      const sourceId = digest([capture.source, capture.accountScope, capture.scope]);
      const valid: PlanningRecord[] = [];
      const parsedRows = raw.records.map((value) => planningRecordSchema.safeParse(value));
      const keyCounts = new Map<string, number>();
      for (const parsed of parsedRows) if (parsed.success) {
        const key = `${parsed.data.kind}:${parsed.data.id}`;
        keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
      }
      let rejected = 0;
      for (const parsed of parsedRows) {
        const key = parsed.success ? `${parsed.data.kind}:${parsed.data.id}` : "";
        if (!parsed.success || keyCounts.get(key) !== 1 || !recordMatchesScope(parsed.data, capture)) { rejected++; continue; }
        const old = db.prepare("SELECT observed_at FROM planning_records WHERE local_id=?").get(digest([sourceId, parsed.data.kind, parsed.data.id]));
        if (Date.parse(parsed.data.provenance.observedAt) > Date.parse(capture.observedAt) || old && Date.parse(parsed.data.provenance.observedAt) < Date.parse(String(old.observed_at))) { rejected++; continue; }
        valid.push(parsed.data);
      }
      if (rejected) capture = { ...capture,
        status: capture.status === "complete" ? "partial" : capture.status,
        completeness: "partial", diagnostics: [...capture.diagnostics.slice(0, 99), { code: "invalid_records", message: "Some records could not be validated; prior data was retained." }] };
      const previousRow = db.prepare("SELECT payload FROM planning_sources WHERE id=?").get(sourceId);
      const previous = previousRow ? JSON.parse(String(previousRow.payload)) as PlanningSourceHealth : undefined;
      const stamp = new Date(capture.observedAt).toISOString();
      if (previous && stamp <= previous.observedAt) return { sourceId, accepted: 0, rejected, ignored: true };
      const writable = capture.status === "complete" || capture.status === "partial";
      const health: PlanningSourceHealth = {
        id: sourceId, source: capture.source, accountScope: capture.accountScope, scope: capture.scope,
        sourceUrl: capture.sourceUrl, status: capture.status, completeness: capture.completeness,
        observedAt: stamp, lastSuccessAt: capture.status === "complete" && capture.completeness === "complete" ? stamp : previous?.lastSuccessAt ?? null, diagnostics: capture.diagnostics,
      };
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("INSERT INTO planning_sources(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(sourceId, JSON.stringify(health));
        db.prepare("INSERT INTO planning_captures(source_id,observed_at,payload) VALUES(?,?,?)").run(sourceId, stamp, sealJson({ ...capture, records: writable ? valid : [] }, PLANNING_CAPTURE_AAD));
        const seen = new Set<string>();
        if (writable) for (const record of valid) {
          const localId = digest([sourceId, record.kind, record.id]); seen.add(localId);
          const old = db.prepare("SELECT version,content_hash,deleted FROM planning_records WHERE local_id=?").get(localId);
          const hash = digest({ ...record, provenance: { ...record.provenance, observedAt: undefined } });
          const version = Number(old?.version ?? 0) + (old?.content_hash !== hash || old?.deleted ? 1 : 0);
          if (!old || version !== Number(old.version)) {
            db.prepare("INSERT INTO planning_versions(local_id,version,payload) VALUES(?,?,?)").run(localId, version, sealJson(record, PLANNING_VERSION_AAD));
          }
          // A repeated unchanged read is still an observation; old versions remain immutable.
          db.prepare(`INSERT INTO planning_records(local_id,source_id,account_scope,version,content_hash,deleted,observed_at) VALUES(?,?,?,?,?,0,?) ON CONFLICT(local_id) DO UPDATE SET version=excluded.version,content_hash=excluded.content_hash,deleted=0,observed_at=excluded.observed_at`).run(localId, sourceId, capture.accountScope, version, hash, new Date(record.provenance.observedAt).toISOString());
        }
        if (capture.status === "complete" && capture.completeness === "complete") {
          for (const old of db.prepare("SELECT local_id FROM planning_records WHERE source_id=? AND deleted=0").all(sourceId)) {
            if (!seen.has(String(old.local_id))) db.prepare("UPDATE planning_records SET deleted=1 WHERE local_id=?").run(String(old.local_id));
          }
        }
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      return { sourceId, accepted: writable ? valid.length : 0, rejected, ignored: false };
    },
  };
}

export const planningMigration = `
  CREATE TABLE planning_sources(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
  CREATE TABLE planning_captures(source_id TEXT NOT NULL REFERENCES planning_sources(id) ON DELETE CASCADE,observed_at TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(source_id,observed_at));
  CREATE TABLE planning_records(local_id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES planning_sources(id) ON DELETE CASCADE,account_scope TEXT NOT NULL,version INTEGER NOT NULL,content_hash TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,observed_at TEXT NOT NULL);
  CREATE TABLE planning_versions(local_id TEXT NOT NULL,version INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(local_id,version));
`;
