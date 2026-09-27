/**
 * owner: drain. The storage side of core's derivation reconcile (`packages/core/src/jobs/derive.ts`):
 * indexed, set-based reads of what is out of date, and the per-course marker. No schema change:
 * the marker is a `derive.course` row in `jobs` (status done, keyed by the course's input hash,
 * naming one of the course's sources), so it cascades with the source and empties with purge.
 *
 * Every read here is indexed: passages by (resource_id, ord), resources by id and by
 * (source_id, external_id), sources by (account_scope, course_id), facts by (resource_id,
 * analyzer_version), references by (from_resource_id, ord), jobs by their unique key.
 */
import { createHash, randomUUID } from "node:crypto";
import type { StatementSync } from "node:sqlite";
import type { Resource } from "@magic/contracts";
import type { CourseRef } from "../../contracts/src/course-core";
import { decodePayload } from "./payload";

type Row = Record<string, string | number | bigint | Uint8Array | null>;
type Prepare = (sql: string) => StatementSync;

export const DERIVED_COURSE_KIND = "derive.course";

export interface DuePassage {
  resourceId: string;
  accountScope: string;
  courseId: string;
}
/** A stored fact of one analyzer version, in insertion order. */
export interface StoredFact {
  textHash: string;
  kind: string;
  start: number;
  end: number;
  value: string;
  basis: string;
  quote: string | null;
}
/** A stored outgoing reference, in `ord` order. */
export interface StoredRef {
  inputHash: string;
  toResourceId: string | null;
  externalRefId: string | null;
  target: string;
  kind: string;
  strength: string;
  reason: string;
}
export type DerivedResource = Resource & { scope: string; textHash: string };

export interface DeriveMethods {
  /** Live resources whose passages are missing, from an older version, or from an older splitter. */
  passagesDue(splitter: string): DuePassage[];
  /** A course's live resources, in the course index's order (source, then external ID). */
  courseResourceIds(course: CourseRef): string[];
  /** Live resources by ID, decoded, with their source scope and text hash (no field history). */
  resourcesByIds(ids: readonly string[]): DerivedResource[];
  /** The stored facts (one analyzer version) and references of these resources. */
  derivedRows(ids: readonly string[], analyzerVersion: string): { facts: Map<string, StoredFact[]>; refs: Map<string, StoredRef[]> };
  /** The input hash the course was last derived at, if any. */
  courseDerivedHash(course: CourseRef): string | undefined;
  /**
   * Records the course as derived at `hash` (replacing its older marker) and retires the course's
   * still-pending rows of the per-row kinds the derivation replaced.
   */
  markCourseDerived(value: { course: CourseRef; hash: string; sourceId: string; now: string; retire: readonly string[] }): void;
  /** The analyzer saw these external links again: `last_seen` moves forward, nothing else changes. */
  touchExternalRefs(course: CourseRef, urls: readonly string[], at: string): void;
  /** A digest of a course's live resources (content) and their completion: the notes' course input. */
  courseDigest(course: CourseRef): string;
}

export function deriveRepository(prepare: Prepare, deps: { timestamp(value: string): string }): DeriveMethods {
  const str = (v: Row[string] | undefined) => (v === null || v === undefined ? null : String(v));
  return {
    passagesDue(splitter) {
      return (
        prepare(
          `SELECT r.id, s.account_scope, s.course_id FROM resources r JOIN sources s ON s.id = r.source_id
           WHERE r.deleted = 0 AND NOT EXISTS (
             SELECT 1 FROM passages p WHERE p.resource_id = r.id AND p.version = r.version AND p.splitter = ?)`,
        ).all(splitter) as Row[]
      ).map((r) => ({ resourceId: String(r.id), accountScope: String(r.account_scope), courseId: String(r.course_id) }));
    },
    courseResourceIds(course) {
      return (
        prepare(
          `SELECT r.id FROM resources r JOIN sources s ON s.id = r.source_id
           WHERE s.account_scope = ? AND s.course_id = ? AND r.deleted = 0 ORDER BY r.source_id, r.external_id`,
        ).all(course.accountScope, course.courseId) as Row[]
      ).map((r) => String(r.id));
    },
    resourcesByIds(ids) {
      if (!ids.length) return [];
      const rows = prepare(
        `SELECT r.*, v.payload, COALESCE(c.completed, 0) AS completed, s.scope AS source_scope
         FROM resources r JOIN resource_versions v ON v.resource_id = r.id AND v.version = r.version
         JOIN sources s ON s.id = r.source_id LEFT JOIN completions c ON c.resource_id = r.id
         WHERE r.id IN (SELECT value FROM json_each(?)) AND r.deleted = 0`,
      ).all(JSON.stringify(ids)) as Row[];
      const byId = new Map(
        rows.map((row) => [
          String(row.id),
          {
            ...decodePayload(row.payload),
            id: String(row.id),
            sourceId: String(row.source_id),
            contentHash: String(row.content_hash),
            version: Number(row.version),
            observedAt: String(row.observed_at),
            capturedAt: String(row.captured_at),
            deleted: false,
            completed: Boolean(row.completed),
            fieldLastSeen: {},
            scope: String(row.source_scope),
            textHash: String(row.text_hash),
          } as DerivedResource,
        ]),
      );
      return ids.flatMap((id) => byId.get(id) ?? []);
    },
    derivedRows(ids, analyzerVersion) {
      const facts = new Map<string, StoredFact[]>();
      const refs = new Map<string, StoredRef[]>();
      if (!ids.length) return { facts, refs };
      const list = JSON.stringify(ids);
      for (const f of prepare(
        `SELECT resource_id, text_hash, kind, start, "end", value, basis, quote FROM material_facts
         WHERE resource_id IN (SELECT value FROM json_each(?)) AND analyzer_version = ? ORDER BY resource_id, id`,
      ).all(list, analyzerVersion) as Row[]) {
        const id = String(f.resource_id);
        const row: StoredFact = {
          textHash: String(f.text_hash),
          kind: String(f.kind),
          start: Number(f.start),
          end: Number(f.end),
          value: String(f.value),
          basis: String(f.basis ?? "text"),
          quote: str(f.quote),
        };
        const list = facts.get(id);
        if (list) list.push(row);
        else facts.set(id, [row]);
      }
      for (const r of prepare(
        `SELECT * FROM resource_refs WHERE from_resource_id IN (SELECT value FROM json_each(?)) ORDER BY from_resource_id, ord`,
      ).all(list) as Row[]) {
        const id = String(r.from_resource_id);
        const row: StoredRef = {
          inputHash: String(r.input_hash),
          toResourceId: str(r.to_resource_id),
          externalRefId: str(r.external_ref_id),
          target: String(r.target),
          kind: String(r.kind),
          strength: String(r.strength),
          reason: String(r.reason),
        };
        const list = refs.get(id);
        if (list) list.push(row);
        else refs.set(id, [row]);
      }
      return { facts, refs };
    },
    courseDerivedHash(course) {
      const row = prepare(
        `SELECT input_hash FROM jobs WHERE kind = ? AND subject_kind = 'course' AND subject_id = ? AND status = 'done' LIMIT 1`,
      ).get(DERIVED_COURSE_KIND, `${course.accountScope}:${course.courseId}`) as Row | undefined;
      return row ? String(row.input_hash) : undefined;
    },
    markCourseDerived({ course, hash, sourceId, now, retire }) {
      const time = deps.timestamp(now);
      const subject = `${course.accountScope}:${course.courseId}`;
      prepare(`DELETE FROM jobs WHERE kind = ? AND subject_kind = 'course' AND subject_id = ? AND input_hash <> ?`).run(
        DERIVED_COURSE_KIND,
        subject,
        hash,
      );
      prepare(
        `INSERT INTO jobs (id,kind,subject_kind,subject_id,resource_id,source_id,input_hash,status,attempts,run_after)
         SELECT ?,?,'course',?,NULL,id,?,'done',0,? FROM sources WHERE id = ?
         ON CONFLICT (kind, subject_kind, subject_id, input_hash) DO UPDATE SET status = 'done', source_id = excluded.source_id`,
      ).run(randomUUID(), DERIVED_COURSE_KIND, subject, hash, time, sourceId);
      if (!retire.length) return;
      const kinds = JSON.stringify(retire);
      prepare(
        `UPDATE jobs SET status = 'done', error = NULL, lease_until = NULL, lease_token = NULL
         WHERE status = 'pending' AND kind IN (SELECT value FROM json_each(?)) AND subject_kind = 'course' AND subject_id = ?`,
      ).run(kinds, subject);
      prepare(
        `UPDATE jobs SET status = 'done', error = NULL, lease_until = NULL, lease_token = NULL
         WHERE status = 'pending' AND kind IN (SELECT value FROM json_each(?)) AND resource_id IN (
           SELECT r.id FROM resources r JOIN sources s ON s.id = r.source_id WHERE s.account_scope = ? AND s.course_id = ?)`,
      ).run(kinds, course.accountScope, course.courseId);
    },
    touchExternalRefs(course, urls, at) {
      if (!urls.length) return;
      prepare(
        `UPDATE external_refs SET last_seen = MAX(last_seen, ?)
         WHERE account_scope = ? AND course_id = ? AND url IN (SELECT value FROM json_each(?))`,
      ).run(deps.timestamp(at), course.accountScope, course.courseId, JSON.stringify(urls));
    },
    courseDigest(course) {
      const hash = createHash("sha256");
      for (const r of prepare(
        `SELECT r.id, r.content_hash, COALESCE(c.completed, 0) AS completed FROM resources r
         JOIN sources s ON s.id = r.source_id LEFT JOIN completions c ON c.resource_id = r.id
         WHERE s.account_scope = ? AND s.course_id = ? AND r.deleted = 0 ORDER BY r.id`,
      ).iterate(course.accountScope, course.courseId) as Iterable<Row>)
        hash.update(`${r.id}:${r.content_hash}:${r.completed};`);
      return hash.digest("hex");
    },
  };
}
