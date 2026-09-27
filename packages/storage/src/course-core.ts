/**
 * Schema v6: the course core (T10). Every table is keyed to `sources(id) ON DELETE CASCADE`,
 * directly or through `resources`, except the few global ones purge clears explicitly
 * (`extraction_recipes`, `ledger`, `compile_runs`, `ui_events`, `counters`).
 * Only leaf tables are rebuilt (`jobs`, `field_observations`); `sources` and `resources` never are,
 * because rebuilding a parent cascades deletes into every child (P2 synthesis C2).
 */
import { createHash } from "node:crypto";
import type { StatementSync } from "node:sqlite";
import { validateQuote } from "../../retrieval/src/index";
import type { ResourceInput } from "@magic/contracts";
import {
  assessmentSchema,
  assessmentScopeSchema,
  compileRunSchema,
  courseBriefSchema,
  courseSessionSchema,
  courseSpaceSchema,
  extractionRecipeSchema,
  ledgerEntrySchema,
  LIFE_COURSE_ID,
  lifeItemSchema,
  mapLinkSchema,
  materialFactsSchema,
  uiEventSchema,
  type Assessment,
  type AssessmentScope,
  type CompileRun,
  type CourseAccessSummary,
  type CourseBrief,
  type CourseCoreStore,
  type CourseRef,
  type CourseSession,
  type CourseSpace,
  type ExtractionRecipe,
  type LedgerEntry,
  type LifeItem,
  type MapLink,
  type MaterialFact,
  type QuoteRef,
  type UiEvent,
  type WriteResult,
} from "../../contracts/src/course-core";
import { PASSAGE_SCHEMA } from "./passages";

type Row = Record<string, string | number | bigint | Uint8Array | null>;
type Prepare = (sql: string) => StatementSync;

export const COURSE_CORE_SCHEMA = `
  -- C4c: text_hash, so text judgments and passages survive submission and grade changes.
  ALTER TABLE resources ADD COLUMN text_hash TEXT NOT NULL DEFAULT '';
  ALTER TABLE resource_versions ADD COLUMN text_hash TEXT NOT NULL DEFAULT '';
  UPDATE resource_versions SET text_hash = magic_text_hash(payload);
  UPDATE resources SET text_hash = (SELECT v.text_hash FROM resource_versions v
    WHERE v.resource_id = resources.id AND v.version = resources.version);

  -- C11: a stored monotonic change counter for cursors (VACUUM may renumber implicit rowids).
  ALTER TABLE resource_changes ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
  UPDATE resource_changes SET seq = o.n FROM (SELECT rowid AS r,
    row_number() OVER (ORDER BY observed_at, rowid) AS n FROM resource_changes) AS o
    WHERE o.r = resource_changes.rowid;
  CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL) WITHOUT ROWID;
  INSERT INTO counters SELECT 'change_seq', COALESCE(MAX(seq), 0) FROM resource_changes;
  CREATE INDEX resource_changes_seq ON resource_changes(seq);

  -- C4a: index every cascade and per-resource lookup.
  CREATE INDEX judgments_resource ON judgments(resource_id);
  CREATE INDEX links_from ON links(from_id);
  CREATE INDEX links_to ON links(to_id);
  CREATE INDEX resource_changes_resource ON resource_changes(resource_id);
  CREATE INDEX resource_changes_source ON resource_changes(source_id);
  CREATE INDEX sources_course ON sources(account_scope, course_id);

  -- Jobs gain a subject (leaf-table rebuild; row order kept).
  CREATE TABLE jobs_v6 (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL,
    subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL,
    resource_id TEXT REFERENCES resources(id) ON DELETE CASCADE,
    source_id TEXT REFERENCES sources(id) ON DELETE CASCADE,
    input_hash TEXT NOT NULL, status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, run_after TEXT NOT NULL,
    lease_until TEXT, lease_token TEXT, error TEXT,
    UNIQUE (kind, subject_kind, subject_id, input_hash)
  );
  INSERT INTO jobs_v6 (id,kind,subject_kind,subject_id,resource_id,source_id,input_hash,status,attempts,run_after,lease_until,lease_token,error)
    SELECT id,kind,'resource',resource_id,resource_id,NULL,input_hash,status,attempts,run_after,lease_until,lease_token,error
    FROM jobs ORDER BY rowid;
  DROP TABLE jobs;
  ALTER TABLE jobs_v6 RENAME TO jobs;
  CREATE INDEX jobs_available ON jobs (status, run_after);
  CREATE INDEX jobs_kind ON jobs (kind, status, run_after);
  CREATE INDEX jobs_resource ON jobs (resource_id);
  CREATE INDEX jobs_source ON jobs (source_id);

  -- D4 (C15): the latest observation per field; history was never read and grew 20% per re-sync.
  CREATE TABLE field_seen (
    resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE, field TEXT NOT NULL,
    observed_at TEXT NOT NULL, read_id TEXT NOT NULL, version INTEGER NOT NULL,
    PRIMARY KEY (resource_id, field)
  ) WITHOUT ROWID;
  INSERT INTO field_seen SELECT resource_id, field, MAX(observed_at), read_id, version
    FROM field_observations GROUP BY resource_id, field;
  DROP TABLE field_observations;
  ALTER TABLE field_seen RENAME TO field_observations;

  ${PASSAGE_SCHEMA}

  CREATE TABLE assessments (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    account_scope TEXT NOT NULL, course_id TEXT NOT NULL,
    resource_id TEXT REFERENCES resources(id) ON DELETE SET NULL,
    kind TEXT NOT NULL, title TEXT NOT NULL, date TEXT, weight REAL, format TEXT,
    origin TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX assessments_source ON assessments(source_id);
  CREATE INDEX assessments_course ON assessments(account_scope, course_id);
  CREATE INDEX assessments_resource ON assessments(resource_id);
  CREATE TABLE assessment_scope (
    id TEXT PRIMARY KEY, assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
    stated TEXT NOT NULL, quote TEXT, resource_id TEXT REFERENCES resources(id) ON DELETE SET NULL,
    version INTEGER, start INTEGER, "end" INTEGER, window_start TEXT, window_end TEXT,
    status TEXT NOT NULL, rung TEXT NOT NULL, corrected_at TEXT, updated_at TEXT NOT NULL
  );
  CREATE INDEX assessment_scope_assessment ON assessment_scope(assessment_id);
  CREATE INDEX assessment_scope_resource ON assessment_scope(resource_id);
  CREATE TABLE course_sessions (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    account_scope TEXT NOT NULL, course_id TEXT NOT NULL, date TEXT, ordinal INTEGER,
    title TEXT NOT NULL, topic_ids TEXT NOT NULL, origin TEXT NOT NULL
  );
  CREATE INDEX course_sessions_source ON course_sessions(source_id);
  CREATE INDEX course_sessions_course ON course_sessions(account_scope, course_id, date);
  CREATE TABLE map_links (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    account_scope TEXT NOT NULL, course_id TEXT NOT NULL,
    from_kind TEXT NOT NULL, from_id TEXT NOT NULL,
    to_resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, tier TEXT NOT NULL, reason TEXT NOT NULL, rung TEXT NOT NULL,
    status TEXT NOT NULL, input_hash TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX map_links_source ON map_links(source_id);
  CREATE INDEX map_links_to ON map_links(to_resource_id);
  CREATE INDEX map_links_from ON map_links(from_kind, from_id);
  CREATE INDEX map_links_course ON map_links(account_scope, course_id);
  CREATE TABLE extraction_recipes (
    id TEXT PRIMARY KEY, host TEXT NOT NULL, layout_hash TEXT NOT NULL, version INTEGER NOT NULL,
    recipe TEXT NOT NULL, validated_at TEXT, hits INTEGER NOT NULL DEFAULT 0, misses INTEGER NOT NULL DEFAULT 0,
    UNIQUE (host, layout_hash, version)
  );
  CREATE TABLE course_spaces (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    account_scope TEXT NOT NULL, course_id TEXT NOT NULL, kind TEXT NOT NULL, host TEXT NOT NULL,
    url TEXT NOT NULL, title TEXT,
    found_in_resource_id TEXT REFERENCES resources(id) ON DELETE SET NULL,
    route TEXT NOT NULL, read_state TEXT NOT NULL,
    read_source_id TEXT REFERENCES sources(id) ON DELETE SET NULL, last_read_at TEXT,
    recipe_id TEXT REFERENCES extraction_recipes(id) ON DELETE SET NULL,
    access_state TEXT NOT NULL, access_reason TEXT, checked_at TEXT NOT NULL, store_or_link TEXT NOT NULL
  );
  CREATE INDEX course_spaces_source ON course_spaces(source_id);
  CREATE INDEX course_spaces_course ON course_spaces(account_scope, course_id);
  CREATE INDEX course_spaces_found_in ON course_spaces(found_in_resource_id);
  CREATE INDEX course_spaces_read_source ON course_spaces(read_source_id);
  CREATE INDEX course_spaces_recipe ON course_spaces(recipe_id);
  CREATE TABLE course_briefs (
    account_scope TEXT NOT NULL, course_id TEXT NOT NULL, text_hash TEXT NOT NULL, pass_version TEXT NOT NULL,
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    syllabus_resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    version INTEGER NOT NULL, brief TEXT NOT NULL, prefix_text TEXT NOT NULL, prefix_hash TEXT NOT NULL,
    compile_run_id TEXT, created_at TEXT NOT NULL,
    PRIMARY KEY (account_scope, course_id, text_hash, pass_version)
  );
  CREATE INDEX course_briefs_source ON course_briefs(source_id);
  CREATE INDEX course_briefs_syllabus ON course_briefs(syllabus_resource_id);
  CREATE TABLE material_facts (
    id INTEGER PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    text_hash TEXT NOT NULL, kind TEXT NOT NULL, start INTEGER NOT NULL, "end" INTEGER NOT NULL,
    value TEXT NOT NULL, analyzer_version TEXT NOT NULL
  );
  CREATE INDEX material_facts_resource ON material_facts(resource_id, analyzer_version);
  CREATE TABLE life_items (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    area TEXT NOT NULL, course_id TEXT, sender TEXT, title TEXT NOT NULL, date TEXT,
    labels TEXT NOT NULL, link TEXT NOT NULL, duplicate_of TEXT, gist TEXT NOT NULL
  );
  CREATE INDEX life_items_source ON life_items(source_id);
  CREATE INDEX life_items_area ON life_items(area, date);
  CREATE TABLE compile_runs (
    id TEXT PRIMARY KEY, account_scope TEXT NOT NULL, course_id TEXT NOT NULL, pack_version TEXT NOT NULL,
    model TEXT NOT NULL, tier TEXT NOT NULL, input_hash TEXT NOT NULL, tokens INTEGER NOT NULL,
    latency_ms REAL NOT NULL, check_failures INTEGER NOT NULL, escalated INTEGER NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX compile_runs_course ON compile_runs(account_scope, course_id, created_at);
  CREATE TABLE ledger (
    id TEXT PRIMARY KEY, pack TEXT NOT NULL, pack_version TEXT NOT NULL, tier TEXT NOT NULL, model TEXT NOT NULL,
    tokens_in INTEGER NOT NULL, tokens_cached INTEGER NOT NULL, tokens_out INTEGER NOT NULL,
    latency_ms REAL NOT NULL, check_failures INTEGER NOT NULL, escalated INTEGER NOT NULL,
    account_scope TEXT, course_id TEXT, created_at TEXT NOT NULL
  );
  CREATE INDEX ledger_time ON ledger(created_at);
  CREATE TABLE ui_events (
    id INTEGER PRIMARY KEY, kind TEXT NOT NULL, subject TEXT NOT NULL, created_at TEXT NOT NULL
  );
`;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
const nullable = <T>(v: T | null | undefined): T | null => (v === undefined ? null : v);
const str = (v: Row[string]): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: Row[string]): number | null => (v === null || v === undefined ? null : Number(v));

type CourseCoreMethods = Omit<
  CourseCoreStore,
  "lease" | "enqueueSubject" | "passages" | "passage" | "rebuildPassages" | "searchPassages" | "changesAfter" | "migrationBackup"
>;

/** The version text of a live resource at the named version, for quote and offset checks. */
export interface VersionText {
  resourceId: string;
  sourceId: string;
  version: number;
  currentVersion: number;
  textHash: string;
  item: ResourceInput;
}

export function courseCoreRepository(
  prepare: Prepare,
  deps: {
    transaction<T>(operation: () => T): T;
    timestamp(value: string): string;
    versionText(resourceId: string, version?: number): VersionText | undefined;
  },
): CourseCoreMethods {
  const { transaction, timestamp, versionText } = deps;

  function sourceCourse(sourceId: string): { accountScope: string; courseId: string } {
    const row = prepare("SELECT account_scope, course_id FROM sources WHERE id = ?").get(sourceId);
    if (!row) throw new Error("Unknown source.");
    return { accountScope: String(row.account_scope), courseId: String(row.course_id) };
  }
  function courseFilter(course: CourseRef | undefined, alias = ""): [string, string[]] {
    return course
      ? [`WHERE ${alias}account_scope = ? AND ${alias}course_id = ?`, [course.accountScope, course.courseId]]
      : ["", []];
  }
  /** A resource in the same account and course as the source (links never cross courses). */
  function assertSameCourse(resourceId: string, course: { accountScope: string; courseId: string }) {
    const row = prepare(
      "SELECT s.account_scope, s.course_id FROM resources r JOIN sources s ON s.id = r.source_id WHERE r.id = ?",
    ).get(resourceId);
    if (!row || row.account_scope !== course.accountScope || row.course_id !== course.courseId)
      throw new Error("A course record must reference a resource in its own course.");
  }
  function checkQuote(ref: QuoteRef): { ok: true; start: number; end: number } | { ok: false; error: string } {
    const source = versionText(ref.resourceId, ref.version);
    if (!source) return { ok: false, error: "The quoted resource version is not available." };
    const check = validateQuote(
      { version: source.version, text: source.item.text },
      { version: ref.version, quote: ref.quote, start: ref.start, end: ref.end },
    );
    return check.ok ? { ok: true, start: check.start, end: check.end } : { ok: false, error: `Quote ${check.reason}.` };
  }

  function readAssessment(r: Row): Assessment {
    return {
      id: String(r.id),
      sourceId: String(r.source_id),
      accountScope: String(r.account_scope),
      courseId: String(r.course_id),
      resourceId: str(r.resource_id),
      kind: r.kind as Assessment["kind"],
      title: String(r.title),
      date: str(r.date),
      weight: num(r.weight),
      format: str(r.format),
      origin: r.origin as Assessment["origin"],
      updatedAt: String(r.updated_at),
    };
  }
  function readScope(r: Row): AssessmentScope {
    return {
      id: String(r.id),
      assessmentId: String(r.assessment_id),
      stated: String(r.stated),
      evidence:
        r.quote === null || r.resource_id === null
          ? null
          : {
              resourceId: String(r.resource_id),
              version: Number(r.version),
              quote: String(r.quote),
              start: Number(r.start),
              end: Number(r.end),
            },
      windowStart: str(r.window_start),
      windowEnd: str(r.window_end),
      status: r.status as AssessmentScope["status"],
      rung: r.rung as AssessmentScope["rung"],
      correctedAt: str(r.corrected_at),
      updatedAt: String(r.updated_at),
    };
  }
  function readSpace(r: Row): CourseSpace {
    return {
      id: String(r.id),
      sourceId: String(r.source_id),
      accountScope: String(r.account_scope),
      courseId: String(r.course_id),
      kind: String(r.kind),
      host: String(r.host),
      url: String(r.url),
      title: str(r.title),
      foundInResourceId: str(r.found_in_resource_id),
      route: r.route as CourseSpace["route"],
      readState: r.read_state as CourseSpace["readState"],
      readSourceId: str(r.read_source_id),
      lastReadAt: str(r.last_read_at),
      recipeId: str(r.recipe_id),
      accessState: r.access_state as CourseSpace["accessState"],
      accessReason: str(r.access_reason),
      checkedAt: str(r.checked_at),
      storeOrLink: r.store_or_link as CourseSpace["storeOrLink"],
    };
  }

  return {
    putAssessment(value, at) {
      const a = assessmentSchema.parse(value);
      const course = sourceCourse(a.sourceId);
      if (a.resourceId) assertSameCourse(a.resourceId, course);
      prepare(
        `INSERT INTO assessments (id,source_id,account_scope,course_id,resource_id,kind,title,date,weight,format,origin,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET source_id=excluded.source_id,
         account_scope=excluded.account_scope,course_id=excluded.course_id,resource_id=excluded.resource_id,kind=excluded.kind,
         title=excluded.title,date=excluded.date,weight=excluded.weight,format=excluded.format,origin=excluded.origin,
         updated_at=excluded.updated_at`,
      ).run(
        a.id, a.sourceId, course.accountScope, course.courseId, a.resourceId, a.kind, a.title,
        a.date, a.weight, a.format, a.origin, timestamp(at),
      );
    },
    assessments(course) {
      const [where, params] = courseFilter(course);
      return (prepare(`SELECT * FROM assessments ${where} ORDER BY date, id`).all(...params) as Row[]).map(
        readAssessment,
      );
    },
    putAssessmentScope(value, at) {
      const parsed = assessmentScopeSchema.safeParse(value);
      if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => i.message) };
      const s = parsed.data;
      if (s.status === "corrected" && s.rung !== "student")
        return { ok: false, errors: ["Only the student corrects a scope."] };
      return transaction((): WriteResult => {
        const assessment = prepare("SELECT account_scope, course_id FROM assessments WHERE id = ?").get(
          s.assessmentId,
        );
        if (!assessment) return { ok: false, errors: ["Unknown assessment."] };
        const existing = prepare("SELECT status, assessment_id FROM assessment_scope WHERE id = ?").get(s.id);
        if (existing && existing.assessment_id !== s.assessmentId)
          return { ok: false, errors: ["A scope ID cannot move to another assessment."] };
        // D33: a correction wins; only another student correction replaces it.
        if (existing?.status === "corrected" && s.rung !== "student")
          return { ok: false, errors: ["The student's correction stands."] };
        let span: { start: number; end: number } | undefined;
        if (s.evidence) {
          assertSameCourse(s.evidence.resourceId, {
            accountScope: String(assessment.account_scope),
            courseId: String(assessment.course_id),
          });
          const check = checkQuote(s.evidence);
          if (!check.ok) return { ok: false, errors: [check.error] };
          span = check;
        }
        const time = timestamp(at);
        prepare(
          `INSERT INTO assessment_scope (id,assessment_id,stated,quote,resource_id,version,start,"end",window_start,window_end,status,rung,corrected_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET stated=excluded.stated,quote=excluded.quote,
           resource_id=excluded.resource_id,version=excluded.version,start=excluded.start,"end"=excluded."end",
           window_start=excluded.window_start,window_end=excluded.window_end,status=excluded.status,rung=excluded.rung,
           corrected_at=excluded.corrected_at,updated_at=excluded.updated_at`,
        ).run(
          s.id, s.assessmentId, s.stated, s.evidence?.quote ?? null, s.evidence?.resourceId ?? null,
          s.evidence?.version ?? null, span?.start ?? null, span?.end ?? null, s.windowStart, s.windowEnd,
          s.status, s.rung, s.status === "corrected" ? time : null, time,
        );
        return { ok: true };
      });
    },
    assessmentScopes(assessmentId) {
      return (
        prepare("SELECT * FROM assessment_scope WHERE assessment_id = ? ORDER BY updated_at, id").all(
          assessmentId,
        ) as Row[]
      ).map(readScope);
    },
    putCourseSession(value) {
      const s = courseSessionSchema.parse(value);
      const course = sourceCourse(s.sourceId);
      prepare(
        `INSERT INTO course_sessions VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET source_id=excluded.source_id,
         account_scope=excluded.account_scope,course_id=excluded.course_id,date=excluded.date,ordinal=excluded.ordinal,
         title=excluded.title,topic_ids=excluded.topic_ids,origin=excluded.origin`,
      ).run(
        s.id, s.sourceId, course.accountScope, course.courseId, s.date, s.ordinal, s.title,
        JSON.stringify(s.topicIds), s.origin,
      );
    },
    courseSessions(course) {
      const [where, params] = courseFilter(course);
      return (
        prepare(`SELECT * FROM course_sessions ${where} ORDER BY date, ordinal, id`).all(...params) as Row[]
      ).map((r): CourseSession => ({
        id: String(r.id),
        sourceId: String(r.source_id),
        accountScope: String(r.account_scope),
        courseId: String(r.course_id),
        date: str(r.date),
        ordinal: num(r.ordinal),
        title: String(r.title),
        topicIds: JSON.parse(String(r.topic_ids)),
        origin: r.origin as CourseSession["origin"],
      }));
    },
    putMapLink(value, at) {
      const parsed = mapLinkSchema.safeParse(value);
      if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => i.message) };
      const l = parsed.data;
      return transaction((): WriteResult => {
        const course = sourceCourse(l.sourceId);
        const target = versionText(l.toResourceId);
        if (!target) return { ok: false, errors: ["The target resource is missing or deleted."] };
        assertSameCourse(l.toResourceId, course);
        const existing = prepare("SELECT rung, status, from_kind, from_id, to_resource_id FROM map_links WHERE id = ?").get(l.id);
        if (
          existing &&
          (existing.from_kind !== l.fromKind || existing.from_id !== l.fromId || existing.to_resource_id !== l.toResourceId)
        )
          return { ok: false, errors: ["A link ID cannot be reassigned to different endpoints."] };
        // A student's move or rejection is never rewritten by code, Jev or a pass.
        if (existing?.rung === "student" && l.rung !== "student")
          return { ok: false, errors: ["The student's decision stands."] };
        prepare(
          `INSERT INTO map_links VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,
           tier=excluded.tier,reason=excluded.reason,rung=excluded.rung,status=excluded.status,input_hash=excluded.input_hash,
           updated_at=excluded.updated_at`,
        ).run(
          l.id, l.sourceId, course.accountScope, course.courseId, l.fromKind, l.fromId, l.toResourceId,
          l.kind, l.tier, l.reason, l.rung, l.status, target.textHash, timestamp(at),
        );
        return { ok: true };
      });
    },
    mapLinks(course) {
      const [where, params] = courseFilter(course, "m.");
      return (
        prepare(
          `SELECT m.*, (r.deleted = 0 AND r.text_hash = m.input_hash) AS current FROM map_links m
           JOIN resources r ON r.id = m.to_resource_id ${where} ORDER BY m.from_kind, m.from_id, m.tier, m.id`,
        ).all(...params) as Row[]
      ).map((r): MapLink => ({
        id: String(r.id),
        sourceId: String(r.source_id),
        accountScope: String(r.account_scope),
        courseId: String(r.course_id),
        fromKind: r.from_kind as MapLink["fromKind"],
        fromId: String(r.from_id),
        toResourceId: String(r.to_resource_id),
        kind: r.kind as MapLink["kind"],
        tier: r.tier as MapLink["tier"],
        reason: String(r.reason),
        rung: r.rung as MapLink["rung"],
        status: r.status as MapLink["status"],
        inputHash: String(r.input_hash),
        current: Boolean(r.current),
        updatedAt: String(r.updated_at),
      }));
    },

    putCourseSpace(value) {
      const s = courseSpaceSchema.parse(value);
      const course = sourceCourse(s.sourceId);
      if (course.courseId === LIFE_COURSE_ID) throw new Error("Course spaces belong to a course.");
      if (s.foundInResourceId) assertSameCourse(s.foundInResourceId, course);
      if (s.readSourceId) {
        const readCourse = sourceCourse(s.readSourceId);
        if (readCourse.accountScope !== course.accountScope || readCourse.courseId !== course.courseId)
          throw new Error("A space read source must belong to its course.");
      }
      const existing = prepare("SELECT account_scope, course_id FROM course_spaces WHERE id = ?").get(s.id);
      if (existing && (existing.account_scope !== course.accountScope || existing.course_id !== course.courseId))
        throw new Error("A space identity cannot move between accounts or courses.");
      prepare(
        `INSERT INTO course_spaces VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
         source_id=excluded.source_id,account_scope=excluded.account_scope,course_id=excluded.course_id,kind=excluded.kind,
         host=excluded.host,url=excluded.url,title=excluded.title,found_in_resource_id=excluded.found_in_resource_id,
         route=excluded.route,read_state=excluded.read_state,read_source_id=excluded.read_source_id,
         last_read_at=excluded.last_read_at,recipe_id=excluded.recipe_id,access_state=excluded.access_state,
         access_reason=excluded.access_reason,checked_at=excluded.checked_at,store_or_link=excluded.store_or_link`,
      ).run(
        s.id, s.sourceId, course.accountScope, course.courseId, s.kind, s.host, s.url, s.title,
        s.foundInResourceId, s.route, s.readState, s.readSourceId, s.lastReadAt && timestamp(s.lastReadAt),
        s.recipeId, s.accessState, s.accessReason, s.checkedAt && timestamp(s.checkedAt), s.storeOrLink,
      );
    },
    courseSpaces(course) {
      const [where, params] = courseFilter(course);
      return (prepare(`SELECT * FROM course_spaces ${where} ORDER BY account_scope, course_id, kind, id`).all(
        ...params,
      ) as Row[]).map(readSpace);
    },
    courseAccessSummary() {
      return (
        prepare(
          `SELECT account_scope, course_id, count(*) AS total,
             sum(access_state = 'readable') AS readable, sum(access_state = 'needs-uw-signin') AS uw,
             sum(access_state = 'needs-own-login') AS own, sum(access_state = 'link-only') AS link,
             sum(access_state = 'blocked') AS blocked, max(checked_at) AS checked
           FROM course_spaces WHERE course_id <> ? GROUP BY account_scope, course_id ORDER BY account_scope, course_id`,
        ).all(LIFE_COURSE_ID) as Row[]
      ).map((r): CourseAccessSummary => ({
        accountScope: String(r.account_scope),
        courseId: String(r.course_id),
        total: Number(r.total),
        readable: Number(r.readable),
        needsUwSignin: Number(r.uw),
        needsOwnLogin: Number(r.own),
        linkOnly: Number(r.link),
        blocked: Number(r.blocked),
        needsAttention: Number(r.uw) + Number(r.own),
        lastCheckedAt: str(r.checked),
      }));
    },
    putExtractionRecipe(value) {
      const r = extractionRecipeSchema.parse(value);
      prepare(
        `INSERT INTO extraction_recipes (id,host,layout_hash,version,recipe,validated_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET recipe=excluded.recipe, validated_at=excluded.validated_at`,
      ).run(r.id, r.host, r.layoutHash, r.version, JSON.stringify(r.recipe), r.validatedAt && timestamp(r.validatedAt));
    },
    extractionRecipe(host, layoutHash) {
      const r = prepare(
        "SELECT * FROM extraction_recipes WHERE host = ? AND layout_hash = ? ORDER BY version DESC LIMIT 1",
      ).get(host, layoutHash) as Row | undefined;
      return r
        ? ({
            id: String(r.id),
            host: String(r.host),
            layoutHash: String(r.layout_hash),
            version: Number(r.version),
            recipe: JSON.parse(String(r.recipe)),
            validatedAt: str(r.validated_at),
            hits: Number(r.hits),
            misses: Number(r.misses),
          } satisfies ExtractionRecipe)
        : undefined;
    },
    recordRecipeUse(id, hit) {
      prepare(`UPDATE extraction_recipes SET ${hit ? "hits = hits + 1" : "misses = misses + 1"} WHERE id = ?`).run(id);
    },

    putCourseBrief(value, at) {
      const parsed = courseBriefSchema.safeParse(value);
      if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => i.message) };
      const b = parsed.data;
      return transaction((): WriteResult => {
        const course = sourceCourse(b.sourceId);
        const syllabus = versionText(b.syllabusResourceId);
        if (!syllabus) return { ok: false, errors: ["The syllabus is missing or deleted."] };
        assertSameCourse(b.syllabusResourceId, course);
        if (syllabus.textHash !== b.textHash) return { ok: false, errors: ["The syllabus text changed; re-derive the brief."] };
        // Code checks every field's quote against the syllabus version, and fixes offsets only when unique.
        const errors: string[] = [];
        const brief = structuredClone(b.brief);
        for (const [section, entries] of Object.entries(brief) as [string, { quote: string; start: number; end: number }[]][])
          entries.forEach((entry, i) => {
            const check = validateQuote(
              { version: syllabus.version, text: syllabus.item.text },
              { version: syllabus.version, quote: entry.quote, start: entry.start, end: entry.end },
            );
            if (!check.ok) errors.push(`${section}[${i}]: quote ${check.reason}.`);
            else {
              entry.start = check.start;
              entry.end = check.end;
            }
          });
        if (errors.length) return { ok: false, errors };
        prepare(
          `INSERT INTO course_briefs VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_scope,course_id,text_hash,pass_version)
           DO UPDATE SET source_id=excluded.source_id,syllabus_resource_id=excluded.syllabus_resource_id,version=excluded.version,
           brief=excluded.brief,prefix_text=excluded.prefix_text,prefix_hash=excluded.prefix_hash,
           compile_run_id=excluded.compile_run_id,created_at=excluded.created_at`,
        ).run(
          course.accountScope, course.courseId, b.textHash, b.passVersion, b.sourceId, b.syllabusResourceId,
          syllabus.version, JSON.stringify(brief), b.prefixText, sha256(b.prefixText), b.compileRunId, timestamp(at),
        );
        return { ok: true };
      });
    },
    courseBrief(course) {
      // Only a brief derived from the syllabus's current text is served.
      const r = prepare(
        `SELECT b.* FROM course_briefs b JOIN resources r ON r.id = b.syllabus_resource_id
         WHERE b.account_scope = ? AND b.course_id = ? AND r.deleted = 0 AND r.text_hash = b.text_hash
         ORDER BY b.created_at DESC LIMIT 1`,
      ).get(course.accountScope, course.courseId) as Row | undefined;
      return r
        ? ({
            accountScope: String(r.account_scope),
            courseId: String(r.course_id),
            sourceId: String(r.source_id),
            syllabusResourceId: String(r.syllabus_resource_id),
            textHash: String(r.text_hash),
            passVersion: String(r.pass_version),
            version: Number(r.version),
            brief: JSON.parse(String(r.brief)),
            prefixText: String(r.prefix_text),
            prefixHash: String(r.prefix_hash),
            compileRunId: str(r.compile_run_id),
            createdAt: String(r.created_at),
          } satisfies CourseBrief)
        : undefined;
    },
    putMaterialFacts(value) {
      const parsed = materialFactsSchema.safeParse(value);
      if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => i.message) };
      const m = parsed.data;
      return transaction((): WriteResult => {
        const source = versionText(m.resourceId);
        if (!source) return { ok: false, errors: ["The resource is missing or deleted."] };
        if (source.textHash !== m.textHash) return { ok: false, errors: ["The text changed; re-run the analyzer."] };
        // v9: offsets cut the text, the title, or (structure) the stored quote itself.
        const base = (f: (typeof m.facts)[number]) =>
          f.basis === "title" ? source.item.title : f.basis === "structure" ? (f.quote ?? "") : source.item.text;
        const errors = m.facts.flatMap((f, i) => {
          const within = base(f);
          if (f.end <= f.start || f.end > within.length) return [`facts[${i}]: offsets outside the ${f.basis ?? "text"}.`];
          if (f.quote !== undefined && f.basis !== "structure" && within.slice(f.start, f.end) !== f.quote)
            return [`facts[${i}]: the quote does not match its offsets.`];
          return [];
        });
        if (errors.length) return { ok: false, errors };
        prepare("DELETE FROM material_facts WHERE resource_id = ? AND analyzer_version = ?").run(
          m.resourceId,
          m.analyzerVersion,
        );
        const insert = prepare(
          `INSERT INTO material_facts (resource_id,text_hash,kind,start,"end",value,analyzer_version,basis,quote) VALUES (?,?,?,?,?,?,?,?,?)`,
        );
        for (const f of m.facts)
          insert.run(
            m.resourceId, m.textHash, f.kind, f.start, f.end, f.value, m.analyzerVersion,
            f.basis ?? "text", f.quote ?? base(f).slice(f.start, f.end),
          );
        return { ok: true };
      });
    },
    materialFacts(resourceId) {
      return (
        prepare(
          `SELECT f.* FROM material_facts f JOIN resources r ON r.id = f.resource_id
           WHERE f.resource_id = ? AND r.deleted = 0 AND r.text_hash = f.text_hash ORDER BY f.start, f.id`,
        ).all(resourceId) as Row[]
      ).map((r): MaterialFact => ({
        id: Number(r.id),
        resourceId: String(r.resource_id),
        textHash: String(r.text_hash),
        kind: r.kind as MaterialFact["kind"],
        start: Number(r.start),
        end: Number(r.end),
        value: String(r.value),
        analyzerVersion: String(r.analyzer_version),
        basis: (r.basis ?? "text") as MaterialFact["basis"],
        quote: str(r.quote),
      }));
    },

    addLedgerEntry(value) {
      const e = ledgerEntrySchema.parse(value);
      prepare("INSERT INTO ledger VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING").run(
        e.id, e.pack, e.packVersion, e.tier, e.model, e.tokensIn, e.tokensCached, e.tokensOut, e.latencyMs,
        e.checkFailures, Number(e.escalated), e.course?.accountScope ?? null, e.course?.courseId ?? null,
        timestamp(e.createdAt),
      );
    },
    ledger(limit = 200) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) throw new Error("Invalid ledger limit.");
      return (prepare("SELECT * FROM ledger ORDER BY created_at DESC, id LIMIT ?").all(limit) as Row[]).map(
        (r): LedgerEntry => ({
          id: String(r.id),
          pack: String(r.pack),
          packVersion: String(r.pack_version),
          tier: String(r.tier),
          model: String(r.model),
          tokensIn: Number(r.tokens_in),
          tokensCached: Number(r.tokens_cached),
          tokensOut: Number(r.tokens_out),
          latencyMs: Number(r.latency_ms),
          checkFailures: Number(r.check_failures),
          escalated: Boolean(r.escalated),
          course:
            r.account_scope === null ? null : { accountScope: String(r.account_scope), courseId: String(r.course_id) },
          createdAt: String(r.created_at),
        }),
      );
    },
    addCompileRun(value) {
      const c = compileRunSchema.parse(value);
      prepare("INSERT INTO compile_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING").run(
        c.id, c.course.accountScope, c.course.courseId, c.packVersion, c.model, c.tier, c.inputHash, c.tokens,
        c.latencyMs, c.checkFailures, Number(c.escalated), timestamp(c.createdAt),
      );
    },
    compileRuns(course) {
      const [where, params] = courseFilter(course);
      return (prepare(`SELECT * FROM compile_runs ${where} ORDER BY created_at, id`).all(...params) as Row[]).map(
        (r): CompileRun => ({
          id: String(r.id),
          course: { accountScope: String(r.account_scope), courseId: String(r.course_id) },
          packVersion: String(r.pack_version),
          model: String(r.model),
          tier: String(r.tier),
          inputHash: String(r.input_hash),
          tokens: Number(r.tokens),
          latencyMs: Number(r.latency_ms),
          checkFailures: Number(r.check_failures),
          escalated: Boolean(r.escalated),
          createdAt: String(r.created_at),
        }),
      );
    },
    addUiEvent(value) {
      const e = uiEventSchema.parse(value);
      prepare("INSERT INTO ui_events (kind,subject,created_at) VALUES (?,?,?)").run(e.kind, e.subject, timestamp(e.createdAt));
    },
    uiEvents(limit = 200) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) throw new Error("Invalid event limit.");
      return (prepare("SELECT * FROM ui_events ORDER BY id DESC LIMIT ?").all(limit) as Row[]).map(
        (r): UiEvent & { id: number } => ({
          id: Number(r.id),
          kind: r.kind as UiEvent["kind"],
          subject: String(r.subject),
          createdAt: String(r.created_at),
        }),
      );
    },
    putLifeItem(value) {
      const l = lifeItemSchema.parse(value);
      sourceCourse(l.sourceId);
      prepare(
        `INSERT INTO life_items VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET source_id=excluded.source_id,
         area=excluded.area,course_id=excluded.course_id,sender=excluded.sender,title=excluded.title,date=excluded.date,
         labels=excluded.labels,link=excluded.link,duplicate_of=excluded.duplicate_of,gist=excluded.gist`,
      ).run(
        l.id, l.sourceId, l.area, l.courseId, nullable(l.sender), l.title, l.date && timestamp(l.date),
        JSON.stringify(l.labels), l.link, l.duplicateOf, l.gist,
      );
    },
    lifeItems(area) {
      const rows = (
        area
          ? prepare("SELECT * FROM life_items WHERE area = ? ORDER BY date DESC, id").all(area)
          : prepare("SELECT * FROM life_items ORDER BY date DESC, id").all()
      ) as Row[];
      return rows.map((r): LifeItem => ({
        id: String(r.id),
        sourceId: String(r.source_id),
        area: r.area as LifeItem["area"],
        courseId: str(r.course_id),
        sender: str(r.sender),
        title: String(r.title),
        date: str(r.date),
        labels: JSON.parse(String(r.labels)),
        link: String(r.link),
        duplicateOf: str(r.duplicate_of),
        gist: String(r.gist),
      }));
    },
  };
}

/** v9: discovery is not an access check. Historical readable rows without a successful
 * read are ambiguous; preserve their membership but clear the unsupported access claim. */
export const COURSE_SPACE_OBSERVATION_MIGRATION = `
  ALTER TABLE course_spaces RENAME TO course_spaces_v7;
  CREATE TABLE course_spaces (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    account_scope TEXT NOT NULL, course_id TEXT NOT NULL, kind TEXT NOT NULL, host TEXT NOT NULL,
    url TEXT NOT NULL, title TEXT,
    found_in_resource_id TEXT REFERENCES resources(id) ON DELETE SET NULL,
    route TEXT NOT NULL, read_state TEXT NOT NULL,
    read_source_id TEXT REFERENCES sources(id) ON DELETE SET NULL, last_read_at TEXT,
    recipe_id TEXT REFERENCES extraction_recipes(id) ON DELETE SET NULL,
    access_state TEXT NOT NULL, access_reason TEXT, checked_at TEXT, store_or_link TEXT NOT NULL
  );
  INSERT INTO course_spaces SELECT id,source_id,account_scope,course_id,kind,host,url,title,
    found_in_resource_id,route,read_state,read_source_id,last_read_at,recipe_id,
    CASE WHEN access_state='readable' AND last_read_at IS NULL THEN 'unknown' ELSE access_state END,
    access_reason, CASE WHEN access_state='readable' AND last_read_at IS NULL THEN NULL ELSE checked_at END,
    store_or_link FROM course_spaces_v7;
  DROP TABLE course_spaces_v7;
  CREATE INDEX course_spaces_source ON course_spaces(source_id);
  CREATE INDEX course_spaces_course ON course_spaces(account_scope,course_id);
  CREATE INDEX course_spaces_found_in ON course_spaces(found_in_resource_id);
  CREATE INDEX course_spaces_read_source ON course_spaces(read_source_id);
  CREATE INDEX course_spaces_recipe ON course_spaces(recipe_id);
`;
