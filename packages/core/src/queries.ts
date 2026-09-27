/**
 * Scoped queries instead of full snapshots (T15, backend optimization O1).
 *
 * Every command used to return the whole workspace: every resource with its full text, every
 * link, job, receipt and change (28.8 MB at 5,000 resources, MT1). A view asks for what it
 * shows: a lean workspace summary, one page of one course's resources without their bodies, one
 * resource in full, or the changes since a cursor. The full snapshot stays available (the
 * `snapshot` command) for debugging.
 */
import type {
  CourseCoreStore,
  QueryRequest,
  QueryResult,
  Resource,
  ResourceChange,
  ResourceSummary,
  ResourceView,
  Store,
} from "@magic/contracts";
import { resolveDeadline } from "@magic/domain";
import { judgmentResultSchema } from "@magic/ai";
import { evidenceFor } from "./evidence";
import { courseIncluded, courseInclusion } from "./access";
import { createHash } from "node:crypto";
import { guideQuery } from "../../packs/guide/src/query"; // owner: guides

/** Canvas submission types that name the kind exactly; code decides these, Jev never sees them. */
const EXACT_KINDS: Record<string, "quiz" | "discussion"> = { online_quiz: "quiz", discussion_topic: "discussion" };
/** The assignment kind code can decide from Canvas `submissionTypes`, or null when it is ambiguous. */
export function codeAssignmentKind(r: Pick<Resource, "kind" | "submissionTypes">): "quiz" | "discussion" | null {
  if (r.kind !== "assignment" || !r.submissionTypes?.length) return null;
  const kinds = new Set(r.submissionTypes.map((t) => EXACT_KINDS[t] ?? null));
  return kinds.size === 1 ? [...kinds][0]! : null;
}

/** The one mapping from stored resources to what a view shows: deadline, label, order. */
export function resourceViews(store: Store, list: Resource[]): ResourceView[] {
  const included = courseInclusion(store);
  const sources = new Map(store.sources().map(source => [source.id, source]));
  const permitted = (resource: Resource) => !resource.deleted && included(resource) && sources.get(resource.sourceId)?.status !== "inaccessible";
  const evidence = evidenceFor(store, permitted);
  const judgments = store.judgments();
  return list
    .map((r) => {
      // store.judgments() holds only judgments whose input (content or text hash) is current,
      // so a text-hash judgment stays visible after a grade or submission change (O5).
      const judgment = judgments.findLast(
        (j) =>
          j.resourceId === r.id &&
          j.questionVersion === "assignment.kind.v1",
      );
      const parsed = judgmentResultSchema.safeParse(judgment?.result);
      // Provisional display threshold; never presented as calibrated correctness.
      const exact = codeAssignmentKind(r);
      const label = exact ??
        (parsed.success &&
        parsed.data.kind !== "other" &&
        (parsed.data.probabilities[parsed.data.kind] ?? 0) >= 0.9
          ? parsed.data.kind.replaceAll("_", " ")
          : null);
      return {
        ...r,
        deadline: permitted(r) ? resolveDeadline(evidence.deadlines(r), evidence.unresolvedDeadlines(r)) : resolveDeadline([]),
        deadlineContributors: evidence.contributors(r).map(source => ({ resourceId: source.id, contentHash: source.contentHash })),
        kindLabel: label,
      };
    })
    .sort(
      (a, b) =>
        Number(a.completed) - Number(b.completed) ||
        (a.deadline.planningAt ?? "9999").localeCompare(
          b.deadline.planningAt ?? "9999",
        ) ||
        a.title.localeCompare(b.title),
    );
}
const EXCERPT = 280;
/** A list row: everything but the bodies (text, raw HTML, parts, document pages). */
export function summarize(view: ResourceView): ResourceSummary {
  const {
    text,
    rawHtml: _html,
    parts: _parts,
    document,
    ...rest
  } = view as ResourceView & { rawHtml?: unknown; parts?: unknown };
  return {
    ...rest,
    excerpt: text.length > EXCERPT ? `${text.slice(0, EXCERPT - 1)}…` : text,
    textLength: text.length,
    ...(document
      ? {
          document: {
            ...document,
            ...("pages" in document ? { pages: undefined } : {}),
          },
        }
      : {}),
  } as ResourceSummary;
}
function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
function decode<T>(cursor: string | undefined, check: (v: unknown) => v is T): T | undefined {
  if (!cursor) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (check(value)) return value;
  } catch {}
  throw new Error("Invalid cursor.");
}
const isOffset = (v: unknown): v is { o: number } =>
  !!v && typeof v === "object" && Number.isSafeInteger((v as { o?: unknown }).o) && (v as { o: number }).o >= 0;
interface ChangeCursor {
  /** The newest observation the view has. */
  at: string;
  /** How many changes it has at exactly that time, and a hash of their ids. */
  n: number;
  h: string;
}
const isChangeCursor = (v: unknown): v is ChangeCursor =>
  !!v &&
  typeof v === "object" &&
  typeof (v as { at?: unknown }).at === "string" &&
  !Number.isNaN(Date.parse((v as { at: string }).at)) &&
  Number.isSafeInteger((v as { n?: unknown }).n) &&
  typeof (v as { h?: unknown }).h === "string";
function idsHash(ids: string[]) {
  return createHash("sha256").update([...ids].sort().join("\n")).digest("base64url").slice(0, 22);
}
/**
 * The change cursor, compact whatever the volume: the newest observation seen, with the count
 * and a hash of the change ids at exactly that time. `changes` must hold every change at its
 * newest time. (T10's monotonic `seq` on resource_changes replaces this.)
 */
export function changeCursor(changes: ResourceChange[]): string {
  if (!changes.length) return encode({ at: "1970-01-01T00:00:00.000Z", n: 0, h: "" });
  const at = changes.reduce((max, c) => (c.observedAt > max ? c.observedAt : max), changes[0]!.observedAt);
  const ids = changes.filter((c) => c.observedAt === at).map((c) => c.id);
  return encode({ at, n: ids.length, h: idsHash(ids) });
}
export interface QueryContext {
  now(): string;
  gatewayConfigured: boolean;
}
/** Runs one scoped query. Pure over the store; the caller owns caching and IPC. */
export function runQuery(store: Store, request: QueryRequest, context: QueryContext): QueryResult {
  switch (request.view) {
    case "courseSpaces": {
      const core = store as Store & Partial<CourseCoreStore>;
      return { view: "courseSpaces", items: core.courseSpaces?.({ accountScope: request.accountScope, courseId: request.courseId }) ?? [] };
    }
    case "summary": {
      const sources = store.sources();
      const all = store.resources();
      const views = resourceViews(store, all.filter((r) => r.kind === "assignment"));
      const courses = new Map<string, { accountScope: string; courseId: string; courseName: string; resources: number; open: number; nextDue: string | null; included: boolean }>();
      const scopeOf = new Map(sources.map((s) => [s.id, s.accountScope]));
      for (const r of all) {
        if (r.courseId === "account" || r.courseId === "connection") continue;
        const accountScope = scopeOf.get(r.sourceId) ?? "";
        const key = `${accountScope}\n${r.courseId}`;
        const row = courses.get(key) ?? {
          accountScope,
          courseId: r.courseId,
          courseName: r.courseName,
          resources: 0,
          open: 0,
          nextDue: null,
          included: courseIncluded(store, r),
        };
        row.resources++;
        courses.set(key, row);
      }
      const start = context.now();
      for (const v of views) {
        const row = courses.get(`${scopeOf.get(v.sourceId) ?? ""}\n${v.courseId}`);
        if (!row || v.completed) continue;
        row.open++;
        const due = v.deadline.dueAt;
        if (due && due >= start && (!row.nextDue || due < row.nextDue)) row.nextDue = due;
      }
      const jobs = store.jobs();
      // The cursor names every change at the newest observation, so none of them comes back.
      const newest = store.changes({ limit: 1 })[0];
      const changes = newest
        ? store
            .changes({ since: newest.observedAt, limit: 2000 })
            .filter((c) => c.observedAt === newest.observedAt)
        : [];
      return {
        view: "summary",
        generatedAt: start,
        sources,
        privacy: store.privacy(),
        consents: store.consents?.() ?? [],
        ingestionSettings: store.ingestionSettings(),
        courseOverrides: store.courseOverrides(),
        gatewayConfigured: context.gatewayConfigured,
        fixtureMode: sources.some((s) => s.kind === "fixture"),
        courses: [...courses.values()].sort((a, b) => a.courseName.localeCompare(b.courseName)),
        jobs: {
          pending: jobs.filter((j) => j.status === "pending").length,
          running: jobs.filter((j) => j.status === "running").length,
          failed: jobs.filter((j) => j.status === "failed").length,
          done: jobs.filter((j) => j.status === "done").length,
        },
        receipts: store.receipts().slice(-20),
        syncRuns: store.syncRuns().slice(0, 10),
        changesCursor: changeCursor(changes),
      };
    }
    case "resources": {
      const offset = decode(request.cursor, isOffset)?.o ?? 0;
      const scopes = new Map(store.sources().map((s) => [s.id, s.accountScope]));
      const kinds = request.kinds ? new Set<string>(request.kinds) : undefined;
      const rows = store
        .resources(request.search)
        .filter(
          (r) =>
            (!request.courseId || r.courseId === request.courseId) &&
            (!request.accountScope || scopes.get(r.sourceId) === request.accountScope) &&
            (!kinds || kinds.has(r.kind)),
        );
      const views = resourceViews(store, rows);
      const limit = request.limit ?? 50;
      const page = views.slice(offset, offset + limit).map(summarize);
      return {
        view: "resources",
        items: page,
        total: views.length,
        ...(offset + limit < views.length ? { nextCursor: encode({ o: offset + limit }) } : {}),
      };
    }
    case "resource": {
      const r = store.resource(request.id);
      if (!r || r.deleted) throw new Error("This item is no longer available.");
      const [view] = resourceViews(store, [r]);
      return {
        view: "resource",
        resource: view!,
        links: store.links().filter((l) => l.fromId === r.id || l.toId === r.id),
        changes: store.changes({ resourceId: r.id, limit: 50 }),
      };
    }
    // owner: T30. The agent layer's mail search: stored fields only (subject, preview, gist,
    // sender, category, org, course). Bodies are never stored, so they are never searched.
    case "mail.search": {
      const terms = (request.text ?? "")
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 1)
        .slice(0, 12);
      const from = request.from?.toLowerCase();
      const org = request.org?.toLowerCase();
      const since = request.since ? Date.parse(request.since) : undefined;
      const items = store
        .resources()
        .filter((r) => r.kind === "message" && !r.deleted && r.mail)
        .filter((r) => {
          const m = r.mail!;
          if (request.category && m.category !== request.category) return false;
          if (request.courseId && m.courseId !== request.courseId) return false;
          if (org && !(m.org ?? "").toLowerCase().includes(org)) return false;
          if (from && !`${m.fromName ?? ""} ${m.fromAddress ?? ""}`.toLowerCase().includes(from))
            return false;
          if (since !== undefined && Date.parse(m.receivedAt) < since) return false;
          if (!terms.length) return true;
          const hay = `${r.title} ${m.preview} ${m.gist ?? ""} ${m.org ?? ""} ${m.fromName ?? ""}`.toLowerCase();
          return terms.every((t) => hay.includes(t));
        })
        .sort((a, b) => b.mail!.receivedAt.localeCompare(a.mail!.receivedAt))
        .slice(0, request.limit)
        .map((r) => {
          const m = r.mail!;
          return {
            id: r.id,
            subject: r.title,
            webLink: r.url,
            receivedAt: m.receivedAt,
            ...(m.fromName ? { fromName: m.fromName } : {}),
            category: m.category,
            categoryReason: m.categoryReason,
            ...(m.courseId ? { courseId: m.courseId } : {}),
            ...(m.org ? { org: m.org } : {}),
            preview: m.preview,
            ...(m.gist ? { gist: m.gist } : {}),
            ...(m.importance ? { importance: m.importance } : {}),
            ...(m.hasAttachments !== undefined ? { hasAttachments: m.hasAttachments } : {}),
          };
        });
      return { view: "mail.search", items };
    }
    // end owner: T30
    case "changes": {
      const previous = decode(request.cursor, isChangeCursor);
      const limit = request.limit ?? 100;
      // The store lists newest first; ask for one more than the page to know whether it is whole.
      let rows = store.changes({
        ...(previous ? { since: previous.at } : {}),
        ...(request.courseId ? { courseId: request.courseId } : {}),
        limit: Math.min(2000, limit + 1 + (previous?.n ?? 0)),
      });
      if (previous) {
        // The changes at the cursor's own time are the view's already, unless one arrived at that
        // same time since; then that time's changes come again (ids let the view de-duplicate).
        const same = rows.filter((c) => c.observedAt === previous.at);
        if (same.length === previous.n && idsHash(same.map((c) => c.id)) === previous.h)
          rows = rows.filter((c) => c.observedAt !== previous.at);
      }
      // The store lists newest first, so a page that overflows can't say what's older. Until
      // resource_changes gains its monotonic seq (T10), an overflow asks the view to reload.
      if (rows.length > limit)
        return {
          view: "changes",
          changes: [],
          cursor: request.cursor ?? changeCursor([]),
          complete: false,
        };
      const page = rows.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
      return {
        view: "changes",
        changes: page,
        cursor: page.length ? changeCursor(page) : (request.cursor ?? changeCursor([])),
        complete: true,
      };
    }
    // owner: guides. guide.view: the personalised view of a cached study guide, 0 model calls.
    case "guide":
      return guideQuery(store, request, context.now());
    // end owner: guides
  }
}
