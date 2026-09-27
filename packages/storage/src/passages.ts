/**
 * Stored passages and the contentless passage FTS (T11b). A passage row holds offsets only; its
 * text is cut from the resource version's text. `passage_fts` is contentless-delete, keyed by
 * `passages.pid`, and a trigger deletes an FTS row with its passage (cascades included).
 */
import { createHash } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import {
  coverage,
  excerpt,
  matchExpression,
  MAX_SEARCH_K,
  NOT_FOUND_COVERAGE,
  porterStem,
  queryTerms,
  SPLITTER_VERSION,
  splitPassages,
} from "../../retrieval/src/index";
import type { ResourceInput } from "@magic/contracts";
import { decodePayload } from "./payload";
import {
  passageSearchSchema,
  type CourseRef,
  type Passage,
  type PassageHit,
  type PassageSearchInput,
  type PassageSearchResult,
  type PassageText,
} from "../../contracts/src/course-core";

type Row = Record<string, string | number | bigint | Uint8Array | null>;
type Prepare = (sql: string) => StatementSync;

export const PASSAGE_SCHEMA = `
  CREATE TABLE passages (
    pid INTEGER PRIMARY KEY AUTOINCREMENT,
    resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    version INTEGER NOT NULL, text_hash TEXT NOT NULL, ord INTEGER NOT NULL,
    start INTEGER NOT NULL, "end" INTEGER NOT NULL, page INTEGER, slide INTEGER,
    t_start REAL, t_end REAL, heading TEXT, tok_est INTEGER NOT NULL,
    redacted INTEGER NOT NULL DEFAULT 0, splitter TEXT NOT NULL,
    UNIQUE (resource_id, ord)
  );
  CREATE VIRTUAL TABLE passage_fts USING fts5(scope, ctx, body, content='', contentless_delete=1,
    tokenize='porter unicode61 remove_diacritics 2');
  INSERT INTO passage_fts(passage_fts, rank) VALUES('rank', 'bm25(0.0, 0.5, 1.0)');
  CREATE VIRTUAL TABLE passage_vocab USING fts5vocab(passage_fts, 'row');
  CREATE TRIGGER passages_fts_delete AFTER DELETE ON passages BEGIN
    DELETE FROM passage_fts WHERE rowid = old.pid;
  END;
`;

/** A course's scope token: one FTS5 token (letters then digits, so porter leaves it alone). */
export function scopeToken(accountScope: string, courseId: string): string {
  const hex = createHash("sha256").update(`${accountScope}\u0000${courseId}`).digest("hex");
  return `zc${BigInt(`0x${hex.slice(0, 13)}`).toString()}`;
}

/** Terms in more than this share of passages carry ~0 bm25 weight; they're dropped from the OR. */
const COMMON_SHARE = 0.5;
const COMMON_MIN_PASSAGES = 50;
const RESOURCE_SEARCH_LIMIT = MAX_SEARCH_K;
const DEFAULT_K = 8;

function readPassage(row: Row): Passage {
  return {
    pid: Number(row.pid),
    resourceId: String(row.resource_id),
    version: Number(row.version),
    textHash: String(row.text_hash),
    ord: Number(row.ord),
    start: Number(row.start),
    end: Number(row.end),
    page: row.page === null ? null : Number(row.page),
    slide: row.slide === null ? null : Number(row.slide),
    tStart: row.t_start === null ? null : Number(row.t_start),
    tEnd: row.t_end === null ? null : Number(row.t_end),
    heading: row.heading === null ? null : String(row.heading),
    tokEst: Number(row.tok_est),
    redacted: Boolean(row.redacted),
  };
}

export function createPassageIndex(db: DatabaseSync, prepare: Prepare) {
  let generation = 0;
  let passageCount: number | undefined;
  const docFrequency = new Map<string, number>();
  const invalidate = () => {
    generation++;
    passageCount = undefined;
    docFrequency.clear();
  };

  /** Split one version into passages and index them. The caller runs inside a transaction. */
  function index(
    resourceId: string,
    version: number,
    textHash: string,
    item: Pick<ResourceInput, "title" | "text" | "parts">,
    scope: string,
  ): number {
    remove(resourceId);
    const spans = splitPassages(item.text, item.parts);
    // A resource without text keeps one empty passage, so its title stays findable.
    const rows = spans.length ? spans : [{ ord: 0, start: 0, end: 0, tokEst: 0 } as (typeof spans)[number]];
    const insert = prepare(
      `INSERT INTO passages (resource_id,version,text_hash,ord,start,"end",page,slide,heading,tok_est,splitter)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const fts = prepare("INSERT INTO passage_fts(rowid,scope,ctx,body) VALUES (?,?,?,?)");
    for (const span of rows) {
      const result = insert.run(
        resourceId,
        version,
        textHash,
        span.ord,
        span.start,
        span.end,
        span.page ?? null,
        span.slide ?? null,
        span.heading ?? null,
        span.tokEst,
        SPLITTER_VERSION,
      );
      const ctx = span.heading ? `${item.title}\n${span.heading}` : item.title;
      fts.run(result.lastInsertRowid, scope, ctx, item.text.slice(span.start, span.end));
    }
    invalidate();
    return spans.length;
  }

  /** Delete a resource's passages; the trigger removes their FTS rows. */
  function remove(resourceId: string): void {
    const result = prepare("DELETE FROM passages WHERE resource_id = ?").run(resourceId);
    if (result.changes) invalidate();
  }

  function count(): number {
    passageCount ??= Number(prepare("SELECT count(*) AS n FROM passages").get()!.n);
    return passageCount;
  }

  function frequency(term: string): number {
    const stem = porterStem(term);
    let df = docFrequency.get(stem);
    if (df === undefined) {
      const row = prepare("SELECT doc FROM passage_vocab WHERE term = ?").get(stem);
      df = row ? Number(row.doc) : 0;
      docFrequency.set(stem, df);
    }
    return df;
  }

  /** A term in most passages carries ~0 bm25 weight (its IDF is clamped), and costs a full scan. */
  function isCommon(term: string): boolean {
    const n = count();
    return n >= COMMON_MIN_PASSAGES && frequency(term) > n * COMMON_SHARE;
  }

  function scopeExpression(courses: readonly CourseRef[] | undefined): string {
    if (!courses) return "";
    return ` AND scope : (${courses.map((c) => `"${scopeToken(c.accountScope, c.courseId)}"`).join(" OR ")})`;
  }

  /**
   * Rank passages for OR-ed terms. Common terms are dropped when a rarer one is present; when all
   * are common, title and heading matches (ctx) rank first, and the whole index only fills the rest.
   */
  function rankTerms(
    exact: readonly string[],
    prefix: string | undefined,
    scope: string,
    limit: number,
    enough: (top: { pid: number; score: number }[]) => boolean,
    resourceIds?: readonly string[],
  ) {
    const rare = exact.filter((t) => !isCommon(t));
    const prefixRare = prefix !== undefined && !isCommon(prefix);
    const or = (terms: readonly string[], last?: string) =>
      [...terms.map((t) => matchExpression([t], "or")), ...(last ? [matchExpression([last], "or", true)] : [])].join(" OR ");
    if (rare.length || prefixRare)
      return topPassages(`{ctx body} : (${or(rare, prefixRare ? prefix : undefined)})${scope}`, limit, resourceIds);
    const common = prefix === undefined ? [...exact] : [...exact, prefix];
    const titled = topPassages(`ctx : (${or(common)})${scope}`, limit, resourceIds);
    if (enough(titled)) return titled;
    const seen = new Set(titled.map((t) => t.pid));
    return [
      ...titled,
      ...topPassages(`{ctx body} : (${or(common)})${scope}`, limit, resourceIds).filter((t) => !seen.has(t.pid)),
    ].slice(0, limit);
  }

  function topPassages(match: string, limit: number, resourceIds?: readonly string[]): { pid: number; score: number }[] {
    return (
      prepare(`SELECT passage_fts.rowid AS pid, passage_fts.rank FROM passage_fts
        JOIN passages p ON p.pid = passage_fts.rowid
        JOIN resources r ON r.id = p.resource_id AND r.deleted = 0 AND r.version = p.version
        WHERE passage_fts MATCH ? AND p.redacted = 0
          ${resourceIds ? "AND p.resource_id IN (SELECT value FROM json_each(?))" : ""}
        ORDER BY passage_fts.rank LIMIT ?`).all(
        match,
        ...(resourceIds ? [JSON.stringify(resourceIds)] : []),
        limit,
      ) as Row[]
    ).map((r) => ({ pid: Number(r.pid), score: Number(r.rank) }));
  }

  function search(input: PassageSearchInput): PassageSearchResult {
    const parsed = passageSearchSchema.parse(input);
    const k = parsed.k ?? DEFAULT_K;
    const { terms, content } = queryTerms(parsed.query);
    const empty: PassageSearchResult = { hits: [], notFound: true, coverage: 0, terms: content };
    if (!content.length || parsed.courses?.length === 0 || parsed.resourceIds?.length === 0) return empty;
    const lookup = parsed.mode === "lookup";
    const scope = scopeExpression(parsed.courses);
    const top = lookup
      ? topPassages(`{ctx body} : (${matchExpression(terms, "and", true)})${scope}`, k, parsed.resourceIds)
      : rankTerms(content, undefined, scope, k, (t) => t.length >= k, parsed.resourceIds);
    if (!top.length) return empty;
    const rows = new Map(
      (
        prepare(
          `SELECT p.*, r.source_id, s.account_scope, s.course_id, v.payload FROM passages p
           JOIN resources r ON r.id = p.resource_id AND r.deleted = 0 AND r.version = p.version
           JOIN resource_versions v ON v.resource_id = p.resource_id AND v.version = p.version
           JOIN sources s ON s.id = r.source_id
           WHERE p.pid IN (SELECT value FROM json_each(?))`,
        ).all(JSON.stringify(top.map((t) => t.pid))) as Row[]
      ).map((r) => [Number(r.pid), r]),
    );
    // Which of these passages each term matches: one probe per term, not one per term and passage.
    const found = prepare(
      "SELECT rowid AS pid FROM passage_fts WHERE passage_fts MATCH ? AND rowid IN (SELECT value FROM json_each(?))",
    );
    const listed = JSON.stringify([...rows.keys()]);
    const hitsOf = new Map(
      content.map((t) => [t, new Set((found.all(`{ctx body} : "${t}"`, listed) as Row[]).map((r) => Number(r.pid)))]),
    );
    // A resource's payload is decoded once per search, however many of its passages hit.
    const items = new Map<string, ReturnType<typeof decodePayload>>();
    const hits: PassageHit[] = [];
    for (const { pid, score } of top) {
      const row = rows.get(pid);
      if (!row) continue;
      const version = `${row.resource_id}\u0000${row.version}`;
      let item = items.get(version);
      if (!item) items.set(version, (item = decodePayload(row.payload)));
      const passage = readPassage(row);
      const matched = new Set(content.filter((t) => hitsOf.get(t)!.has(pid)));
      hits.push({
        pid,
        resourceId: passage.resourceId,
        sourceId: String(row.source_id),
        accountScope: String(row.account_scope),
        courseId: String(row.course_id),
        title: item.title,
        url: item.url,
        version: passage.version,
        start: passage.start,
        end: passage.end,
        page: passage.page,
        slide: passage.slide,
        heading: passage.heading,
        score,
        excerpt: excerpt(item.text, passage.start, passage.end),
        coverage: coverage(content, matched),
      });
    }
    const best = hits.reduce((m, h) => Math.max(m, h.coverage), 0);
    return {
      hits,
      notFound: !hits.length || (!lookup && best < NOT_FOUND_COVERAGE),
      coverage: best,
      terms: content,
    };
  }

  /**
   * Resource-level typed search (the list filter): content terms OR-ed, the last one
   * prefix-matched while the student types, ranked by each resource's best passage.
   */
  function resourceIds(query: string): string[] | undefined {
    const { content } = queryTerms(query);
    if (!content.length) return undefined;
    const owners = (top: { pid: number }[]) => {
      const byPid = new Map(
        (
          prepare("SELECT pid, resource_id FROM passages WHERE pid IN (SELECT value FROM json_each(?))").all(
            JSON.stringify(top.map((t) => t.pid)),
          ) as Row[]
        ).map((r) => [Number(r.pid), String(r.resource_id)]),
      );
      const ids: string[] = [];
      for (const { pid } of top) {
        const id = byPid.get(pid);
        if (id && !ids.includes(id)) ids.push(id);
        if (ids.length >= RESOURCE_SEARCH_LIMIT) break;
      }
      return ids;
    };
    const top = rankTerms(
      content.slice(0, -1),
      content[content.length - 1]!,
      "",
      RESOURCE_SEARCH_LIMIT * 4,
      (t) => owners(t).length >= RESOURCE_SEARCH_LIMIT,
    );
    return top.length ? owners(top) : [];
  }

  function passages(resourceId: string): Passage[] {
    return (prepare("SELECT * FROM passages WHERE resource_id = ? ORDER BY ord").all(resourceId) as Row[]).map(
      readPassage,
    );
  }

  function passage(pid: number): PassageText | undefined {
    if (!Number.isSafeInteger(pid)) return undefined;
    const row = prepare(
      `SELECT p.*, v.payload FROM passages p
       JOIN resources r ON r.id = p.resource_id AND r.deleted = 0 AND r.version = p.version
       JOIN resource_versions v ON v.resource_id = p.resource_id AND v.version = p.version WHERE p.pid = ?`,
    ).get(pid) as Row | undefined;
    if (!row) return undefined;
    const item = decodePayload(row.payload);
    const value = readPassage(row);
    return { passage: value, text: item.text.slice(value.start, value.end), title: item.title, url: item.url };
  }

  return {
    index,
    remove,
    search,
    resourceIds,
    passages,
    passage,
    invalidate,
    get generation() {
      return generation;
    },
  };
}
export type PassageIndex = ReturnType<typeof createPassageIndex>;
