/**
 * One grant-checked read session: the part every agent-facing read shares (the v1 API and the MCP
 * course bank). It authenticates the grant, rechecks sharing, course inclusion and categories on
 * every call, scrubs only what it returns, cuts excerpts to a budget and writes one receipt.
 * It never writes the database: receipts go to the caller's sink (the reader logs them to a file).
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  evidenceUrlSchema,
  type EgressReceipt,
  type McpCategory,
  type McpGrant,
  type Resource,
  type SourceHealth,
  type Store,
} from "@magic/contracts";
import type { CourseCoreStore, CourseRef } from "../../contracts/src/course-core";
import { maySend, resolveDeadline } from "../../domain/src/index";
import { contentCategories, courseInclusion } from "../../core/src/access";
import { evidenceFor } from "../../core/src/evidence";
import { outgoingProjection, payloadScrubber } from "../../core/src/identity";
import { porterStem, queryTerms, MAX_SEARCH_K } from "../../retrieval/src/index";
import type { DetailLevel } from "./budget";

export interface Credentials {
  clientId: string;
  token: string;
}
export interface SessionOptions {
  now?: () => Date;
  /** Where receipts go. Default: the store (in-process, the writer). The reader passes a log sink. */
  recordReceipt?: (receipt: EgressReceipt) => void;
}

/** The live, enabled grant whose token hash matches; anything else reads as revoked. */
export function authorize(store: Store, credentials: Credentials): McpGrant {
  const g = store.mcpGrants().find((g) => g.id === credentials.clientId && g.enabled);
  const hash = createHash("sha256").update(credentials.token).digest();
  const expected = Buffer.from(g?.tokenHash ?? "", "hex");
  if (!g || expected.length !== hash.length || !timingSafeEqual(hash, expected))
    throw new Error("This connection is unavailable or has been revoked.");
  return g;
}

/**
 * Runs one synchronous read with the store's whole-table reads decoded once: every helper it calls
 * (inclusion, deadline evidence, the identity roster behind each projection) shares one decode of
 * `resources()` and `sources()` instead of one each. The store is restored before returning; nothing
 * else can run in between, since the work is synchronous.
 */
export function withOneRead<T>(store: Store, work: () => T): T {
  const resources = store.resources;
  const sources = store.sources;
  let all: Resource[] | undefined;
  let health: SourceHealth[] | undefined;
  try {
    store.resources = (search?: string) =>
      search ? resources.call(store, search) : (all ??= resources.call(store)).slice();
    store.sources = () => (health ??= sources.call(store)).slice();
  } catch {
    return work(); // a frozen store: correct, only slower
  }
  try {
    return work();
  } finally {
    store.resources = resources;
    store.sources = sources;
  }
}

export interface ProjectOptions {
  level: DetailLevel;
  /** An offset in the scrubbed text to centre the excerpt on (a search match). */
  around?: number;
  /**
   * Sizing only: the same JSON length without registering a citation projection (each registration
   * scrubs the whole item again). The budget sizes with dry builds and projects once, for real.
   */
  dry?: boolean;
}
const DRY_PROJECTION_ID = "00000000-0000-4000-8000-000000000000";

export function openSession(
  store: Store,
  credentials: Credentials,
  options: SessionOptions = {},
  filter: { courseId?: string } = {},
) {
  const now = options.now ?? (() => new Date());
  const g = authorize(store, credentials);
  const privacy = store.privacy();
  const permitted = (category: McpCategory) =>
    g.categories.includes(category) && maySend(privacy, g.recipient, [category]).allowed;
  if (!g.categories.some(permitted)) throw new Error("Sharing is disabled for this connection.");
  const view = store;
  const included = courseInclusion(view);
  const sourceMap = new Map(view.sources().map((s) => [s.id, s]));
  const grantedCourse = (accountScope: string, courseId: string) =>
    g.courses.some((c) => c.accountScope === accountScope && c.courseId === courseId) &&
    (!filter.courseId || courseId === filter.courseId);
  const allowed = (r: Resource, includeDeleted = false) => {
    const source = sourceMap.get(r.sourceId);
    return (
      (includeDeleted || !r.deleted) &&
      !!source &&
      grantedCourse(source.accountScope, r.courseId) &&
      included(r) &&
      contentCategories(r).every(permitted)
    );
  };
  // Agent output goes to AI clients: every free-text field passes the hosted-payload scrubber.
  // Excerpt offsets are in scrubbed ("outgoing") coordinates; validate-citations maps them back.
  const scrubbers = new Map<string, ReturnType<typeof payloadScrubber>>();
  const memo = new Map<string, string>();
  const out = (value: string, courseId: string, scope?: string) => {
    const scopeKey = scope ?? "";
    let scrubber = scrubbers.get(scopeKey);
    if (!scrubber) scrubbers.set(scopeKey, (scrubber = payloadScrubber(store, true, scope)));
    const key = `${scopeKey}\u0000${courseId}\u0000${value}`;
    let v = memo.get(key);
    if (v === undefined) memo.set(key, (v = scrubber.field(value, courseId)));
    return v;
  };
  const scrubFor = (r: Resource) => (value: string) =>
    out(value, r.courseId, sourceMap.get(r.sourceId)?.accountScope);
  let allowedList: Resource[] | undefined;
  const resources = () => (allowedList ??= view.resources().filter((r) => allowed(r)));
  let evidence: ReturnType<typeof evidenceFor> | undefined;
  const evidenceOf = () => (evidence ??= evidenceFor(view, (r) => allowed(r)));
  const contributors = new Map<string, Resource>();
  function deadlineFor(r: Resource) {
    const e = evidenceOf();
    for (const c of e.contributors(r)) contributors.set(c.id, c);
    return resolveDeadline(e.deadlines(r), e.unresolvedDeadlines(r));
  }
  function projectedDeadline(r: Resource) {
    const s = scrubFor(r);
    const scrubValue = (v: unknown): unknown =>
      typeof v === "string"
        ? s(v)
        : Array.isArray(v)
          ? v.map(scrubValue)
          : v && typeof v === "object"
            ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubValue(x)]))
            : v;
    return scrubValue(deadlineFor(r));
  }
  const safeUrl = (url: string) => (evidenceUrlSchema.safeParse(url).success ? url : undefined);
  const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);

  /** A resource as an agent sees it: scrubbed, cited, excerpted to the level's window. */
  function project(r: Resource, { level, around, dry }: ProjectOptions) {
    const source = sourceMap.get(r.sourceId)!;
    const s = scrubFor(r);
    const text = s(r.text);
    const lead = Math.min(500, Math.floor(level.window / 4));
    const start = around === undefined ? 0 : Math.max(0, Math.min(around - lead, text.length - level.window));
    // The scrubbed text here is the projection's own (same scrubber, same roster), so a dry build
    // has exactly the real build's length.
    const projection = dry
      ? { id: DRY_PROJECTION_ID, text: text.slice(start, start + level.window), start, end: Math.min(text.length, start + level.window) }
      : outgoingProjection(store, r, "text", { start, end: start + level.window });
    return {
      id: r.id,
      courseId: r.courseId,
      course: s(r.courseName),
      title: s(r.title),
      kind: r.kind,
      text: projection.text,
      excerpt: {
        start: projection.start,
        end: projection.end,
        basis: "outgoing" as const,
        ...(projection.end < text.length || projection.start > 0 ? { of: text.length } : {}),
      },
      deadline: projectedDeadline(r),
      citation: {
        url: safeUrl(r.url),
        version: r.version,
        contentHash: r.contentHash,
        projectionId: projection.id,
        observedAt: r.observedAt,
        source: s(source.label),
      },
      parts: r.parts?.slice(0, level.parts).map((p) => ({
        page: p.page,
        slide: p.slide,
        section: p.section ? s(p.section) : undefined,
        offsetBasis: "original_source" as const,
        start: p.start,
        end: p.end,
        text: clip(s(p.text), level.partChars),
      })),
      freshness: {
        status: source.status,
        complete: source.complete,
        lastSuccessAt: source.lastSuccessAt,
      },
      ...(permitted("grades") && r.submission
        ? {
            grade: {
              score: r.submission.score,
              grade: typeof r.submission.grade === "string" ? s(r.submission.grade) : r.submission.grade,
              late: r.submission.late,
              missing: r.submission.missing,
              excused: r.submission.excused,
            },
          }
        : {}),
      ...(permitted("comments") && r.submission
        ? {
            comments: r.submission.comments?.slice(0, level.comments).map((c) => ({
              createdAt: c.createdAt,
              text: clip(s(c.text), level.commentChars),
              ...(c.authorName ? { authorName: s(c.authorName) } : {}),
            })),
          }
        : {}),
      // No raw HTML, identities, local paths, secret URLs, or arbitrary source payloads.
    };
  }

  /** Where a query's first term falls in the scrubbed text; undefined if the projection lacks it. */
  function matchIn(text: string, terms: readonly string[], near = 0): number | undefined {
    const lower = text.toLocaleLowerCase();
    let best: number | undefined;
    for (const t of terms)
      for (const form of new Set([t, porterStem(t)])) {
        const after = lower.indexOf(form, Math.max(0, near));
        const at = after >= 0 ? after : lower.indexOf(form);
        if (at >= 0 && (best === undefined || at < best)) best = at;
      }
    return best;
  }

  /**
   * Passage search through the FTS index (BM25, OR), scoped to the grant's account × course pairs.
   * A hit counts only if the scrubbed projection it would return still holds a query term, so a
   * scrubbed name can't be probed through ranking. Only the returned resources are scrubbed.
   */
  function search(query: string, limit: number): { resource: Resource; around: number }[] {
    const { content } = queryTerms(query);
    const courses: CourseRef[] = g.courses.filter((c) => !filter.courseId || c.courseId === filter.courseId);
    if (!content.length || !courses.length) return [];
    const searchPassages = (store as Store & Partial<Pick<CourseCoreStore, "searchPassages">>).searchPassages;
    if (!searchPassages) throw new Error("The search index is unavailable.");
    const { hits } = searchPassages.call(store, { query, courses, k: MAX_SEARCH_K });
    const found: { resource: Resource; around: number }[] = [];
    const seen = new Set<string>();
    for (const hit of hits) {
      if (found.length >= limit) break;
      if (seen.has(hit.resourceId)) continue;
      seen.add(hit.resourceId);
      const r = view.resource(hit.resourceId);
      if (!r || !allowed(r)) continue;
      const s = scrubFor(r);
      const inText = matchIn(s(r.text), content, hit.start);
      if (inText === undefined && matchIn(s(r.title), content) === undefined) continue;
      found.push({ resource: r, around: inText ?? 0 });
    }
    return found;
  }

  /** One receipt per call, over what was returned and what contributed to it. */
  function receipt(purpose: string, selected: Resource[], characters: number, withPrivate: boolean) {
    const all = [...new Map([...selected, ...contributors.values()].map((r) => [r.id, r])).values()];
    const categories = [
      ...new Set(
        all.flatMap((r) => [
          ...contentCategories(r),
          ...(withPrivate && permitted("grades") && r.submission ? (["grades"] as const) : []),
          ...(withPrivate && permitted("comments") && r.submission?.comments ? (["comments"] as const) : []),
        ]),
      ),
    ];
    const value: EgressReceipt = {
      id: randomUUID(),
      recipient: g.recipient,
      purpose,
      categories,
      resourceIds: all.map((r) => r.id),
      characters,
      status: "sent",
      createdAt: now().toISOString(),
    };
    (options.recordReceipt ?? ((r: EgressReceipt) => store.addReceipt(r)))(value);
  }

  return {
    grant: g,
    now,
    permitted,
    allowed,
    included,
    sourceMap,
    view,
    out,
    scrubFor,
    resources,
    evidence: evidenceOf,
    deadlineFor,
    project,
    search,
    receipt,
    grantedCourse,
  };
}
export type ReadSession = ReturnType<typeof openSession>;
