/**
 * Schema v9: the course graph (the material pipeline). Additive only: two new tables keyed to
 * `sources`/`resources` with ON DELETE CASCADE (purge clears them with every other table), and two
 * columns on `material_facts` so a fact can quote a title or a structured field, not only text.
 */
import { createHash } from "node:crypto";
import type { StatementSync } from "node:sqlite";
import {
  externalRefSchema,
  resourceRefSchema,
  type CourseRef,
  type ExternalRef,
  type GraphCounts,
  type GraphStore,
  type ResourceRef,
  type WriteResult,
} from "../../contracts/src/course-core";

type Row = Record<string, string | number | bigint | Uint8Array | null>;
type Prepare = (sql: string) => StatementSync;

/**
 * The v9 step. Guarded (IF NOT EXISTS, and the two columns only when absent) so a database that
 * already holds any of these objects, such as a hand-downgraded test fixture, still upgrades.
 */
export function migrateGraph(db: { exec(sql: string): void; prepare(sql: string): StatementSync }): void {
  const columns = new Set(
    (db.prepare("SELECT name FROM pragma_table_info('material_facts')").all() as Row[]).map((r) => String(r.name)),
  );
  if (!columns.has("basis")) db.exec("ALTER TABLE material_facts ADD COLUMN basis TEXT NOT NULL DEFAULT 'text';");
  if (!columns.has("quote")) db.exec("ALTER TABLE material_facts ADD COLUMN quote TEXT;");
  db.exec(GRAPH_SCHEMA);
}

export const GRAPH_SCHEMA = `
  CREATE INDEX IF NOT EXISTS material_facts_kind ON material_facts(kind, value);
  CREATE TABLE IF NOT EXISTS external_refs (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    account_scope TEXT NOT NULL, course_id TEXT NOT NULL, url TEXT NOT NULL, title TEXT,
    host TEXT NOT NULL, host_class TEXT NOT NULL, treatment TEXT NOT NULL,
    found_in_resource_id TEXT REFERENCES resources(id) ON DELETE SET NULL,
    first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
    UNIQUE (account_scope, course_id, url)
  );
  CREATE INDEX IF NOT EXISTS external_refs_source ON external_refs(source_id);
  CREATE INDEX IF NOT EXISTS external_refs_found_in ON external_refs(found_in_resource_id);
  CREATE TABLE IF NOT EXISTS resource_refs (
    from_resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    ord INTEGER NOT NULL, input_hash TEXT NOT NULL,
    to_resource_id TEXT REFERENCES resources(id) ON DELETE CASCADE,
    external_ref_id TEXT REFERENCES external_refs(id) ON DELETE CASCADE,
    target TEXT NOT NULL, kind TEXT NOT NULL, strength TEXT NOT NULL, reason TEXT NOT NULL,
    PRIMARY KEY (from_resource_id, ord)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS resource_refs_to ON resource_refs(to_resource_id);
  CREATE INDEX IF NOT EXISTS resource_refs_external ON resource_refs(external_ref_id);
`;

const str = (v: Row[string] | undefined): string | null => (v === null || v === undefined ? null : String(v));

export function externalRefId(accountScope: string, courseId: string, url: string): string {
  return createHash("sha256").update(`${accountScope}\u0000${courseId}\u0000${url}`).digest("hex").slice(0, 32);
}

type GraphMethods = Omit<GraphStore, "sourceResources" | "courseResources">;

export function graphRepository(
  prepare: Prepare,
  deps: { transaction<T>(operation: () => T): T; timestamp(value: string): string },
): GraphMethods {
  const { transaction, timestamp } = deps;
  const readRef = (r: Row): ResourceRef => ({
    fromResourceId: String(r.from_resource_id),
    ord: Number(r.ord),
    inputHash: String(r.input_hash),
    toResourceId: str(r.to_resource_id),
    externalRefId: str(r.external_ref_id),
    target: String(r.target),
    kind: r.kind as ResourceRef["kind"],
    strength: r.strength as ResourceRef["strength"],
    reason: String(r.reason),
  });
  return {
    courseInventoryHash(course: CourseRef) {
      const hash = createHash("sha256");
      for (const r of prepare(
        `SELECT r.id, r.content_hash FROM resources r JOIN sources s ON s.id = r.source_id
         WHERE s.account_scope = ? AND s.course_id = ? AND r.deleted = 0 ORDER BY r.id`,
      ).iterate(course.accountScope, course.courseId) as Iterable<Row>)
        hash.update(`${r.id}:${r.content_hash};`);
      return hash.digest("hex");
    },
    resourceTextHash(resourceId) {
      const row = prepare("SELECT text_hash FROM resources WHERE id = ? AND deleted = 0").get(resourceId);
      return row ? String(row.text_hash) : undefined;
    },
    putResourceRefs(fromResourceId, inputHash, refs): WriteResult {
      const parsed = refs.map((r) => resourceRefSchema.safeParse(r));
      const errors = parsed.flatMap((p, i) => (p.success ? [] : [`refs[${i}]: ${p.error.issues[0]?.message}`]));
      if (errors.length) return { ok: false, errors };
      return transaction((): WriteResult => {
        const live = prepare("SELECT content_hash FROM resources WHERE id = ? AND deleted = 0").get(fromResourceId);
        if (!live) return { ok: false, errors: ["The resource is missing or deleted."] };
        if (String(live.content_hash) !== inputHash)
          return { ok: false, errors: ["The resource changed; re-run the link pass."] };
        prepare("DELETE FROM resource_refs WHERE from_resource_id = ?").run(fromResourceId);
        const insert = prepare(
          `INSERT INTO resource_refs (from_resource_id,ord,input_hash,to_resource_id,external_ref_id,target,kind,strength,reason)
           VALUES (?,?,?,
             (SELECT id FROM resources WHERE id = ? AND deleted = 0),
             (SELECT id FROM external_refs WHERE id = ?),?,?,?,?)`,
        );
        parsed.forEach((p, ord) => {
          const r = p.data!;
          insert.run(fromResourceId, ord, inputHash, r.toResourceId, r.externalRefId, r.target, r.kind, r.strength, r.reason);
        });
        return { ok: true };
      });
    },
    resourceRefs(fromResourceId) {
      return (
        prepare(
          `SELECT f.* FROM resource_refs f JOIN resources r ON r.id = f.from_resource_id
           WHERE f.from_resource_id = ? AND r.deleted = 0 AND r.content_hash = f.input_hash ORDER BY f.ord`,
        ).all(fromResourceId) as Row[]
      ).map(readRef);
    },
    putExternalRef(value, at) {
      const e = externalRefSchema.parse(value);
      const time = timestamp(at);
      return transaction(() => {
        const source = prepare("SELECT account_scope, course_id FROM sources WHERE id = ?").get(e.sourceId);
        if (!source) throw new Error("Unknown source.");
        const url = new URL(e.url);
        const id = externalRefId(String(source.account_scope), String(source.course_id), e.url);
        prepare(
          `INSERT INTO external_refs (id,source_id,account_scope,course_id,url,title,host,host_class,treatment,found_in_resource_id,first_seen,last_seen)
           VALUES (?,?,?,?,?,?,?,?,?,(SELECT id FROM resources WHERE id = ?),?,?)
           ON CONFLICT(id) DO UPDATE SET
             title = COALESCE(excluded.title, external_refs.title),
             host_class = excluded.host_class, treatment = excluded.treatment,
             found_in_resource_id = COALESCE(external_refs.found_in_resource_id, excluded.found_in_resource_id),
             first_seen = MIN(external_refs.first_seen, excluded.first_seen),
             last_seen = MAX(external_refs.last_seen, excluded.last_seen)`,
        ).run(
          id, e.sourceId, source.account_scope, source.course_id, e.url, e.title, url.host.toLowerCase(),
          e.hostClass, e.treatment, e.foundInResourceId, time, time,
        );
        return id;
      });
    },
    externalRefs(course) {
      return (
        prepare("SELECT * FROM external_refs WHERE account_scope = ? AND course_id = ? ORDER BY url").all(
          course.accountScope,
          course.courseId,
        ) as Row[]
      ).map(
        (r): ExternalRef => ({
          id: String(r.id),
          sourceId: String(r.source_id),
          accountScope: String(r.account_scope),
          courseId: String(r.course_id),
          url: String(r.url),
          title: str(r.title),
          host: String(r.host),
          hostClass: String(r.host_class),
          treatment: r.treatment as ExternalRef["treatment"],
          foundInResourceId: str(r.found_in_resource_id),
          firstSeen: String(r.first_seen),
          lastSeen: String(r.last_seen),
        }),
      );
    },
    graphCounts(course) {
      return (
        prepare(
          `SELECT r.id,
             (SELECT count(*) FROM passages p WHERE p.resource_id = r.id AND p.version = r.version) AS passages,
             (SELECT count(*) FROM material_facts f WHERE f.resource_id = r.id AND f.text_hash = r.text_hash) AS facts,
             (SELECT count(*) FROM resource_refs x WHERE x.from_resource_id = r.id AND x.input_hash = r.content_hash) AS refs
           FROM resources r JOIN sources s ON s.id = r.source_id
           WHERE s.account_scope = ? AND s.course_id = ? AND r.deleted = 0`,
        ).all(course.accountScope, course.courseId) as Row[]
      ).map(
        (r): GraphCounts => ({
          resourceId: String(r.id),
          passages: Number(r.passages),
          facts: Number(r.facts),
          refs: Number(r.refs),
        }),
      );
    },
  };
}
