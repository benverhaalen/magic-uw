/**
 * The agent API, contract v1: typed, versioned, read-only reads over the local course store
 * (plan D42, spec F3). Every call takes a scoped grant (an MCP grant's id and token), rechecks it,
 * passes the same sharing gate (`maySend`) and scrub projection as the MCP course bank, fits a
 * token budget by trimming, and records one receipt. Nothing here writes coursework or evidence.
 *
 * Within a major version a result never changes shape; new fields arrive in a minor version.
 */
import { z } from "zod";
import type { Resource, Store } from "@magic/contracts";
import { fitToBudget, type DetailLevel } from "./budget";
import { openSession, withOneRead, type Credentials, type ReadSession, type SessionOptions } from "./session";
import { renderCourseBrief } from "../../core/src/course-facts/brief"; // owner: course-facts

export const CONTRACT = "magic.agent-api" as const;
export const VERSION = "1.0.0" as const;

/** Per-verb token budgets. Results are trimmed to fit, never refused for size. */
export const BUDGET_TOKENS = {
  courses: 4000,
  courseGraph: 4000,
  resources: 8000,
  resource: 12000,
  searchPassages: 8000,
  assignments: 6000,
  agenda: 6000,
  courseBrief: 6000, // owner: course-facts
} as const;
export type Verb = keyof typeof BUDGET_TOKENS;

const id = z.string().min(1).max(256);
const kinds = ["assignment", "material", "event", "message", "course"] as const;
export const inputSchemas = {
  courses: z.object({}).strict(),
  courseGraph: z.object({ courseId: id }).strict(),
  resources: z
    .object({
      courseId: id.optional(),
      kinds: z.array(z.enum(kinds)).max(5).optional(),
      cursor: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(100).default(25),
    })
    .strict(),
  resource: z.object({ id }).strict(),
  searchPassages: z
    .object({
      query: z.string().min(1).max(1000),
      courseId: id.optional(),
      limit: z.number().int().min(1).max(20).default(8),
    })
    .strict(),
  assignments: z
    .object({
      courseId: id.optional(),
      /** Only those due from now to `days` ahead; omitted: every assignment, dated or not. */
      days: z.number().int().min(1).max(180).optional(),
    })
    .strict(),
  agenda: z.object({ days: z.number().int().min(1).max(60).default(7) }).strict(),
  courseBrief: z.object({ courseId: id }).strict(), // owner: course-facts
} satisfies Record<Verb, z.ZodType>;
export type Input<V extends Verb> = z.input<(typeof inputSchemas)[V]>;

export type ResourceKind = (typeof kinds)[number];
export interface SourceCoverage {
  source: string;
  status: string;
  complete: boolean;
  lastSuccessAt: string | null;
}
export interface CourseV1 {
  courseId: string;
  course: string;
  resources: number;
  openAssignments: number;
  nextDueAt: string | null;
  coverage: SourceCoverage[];
}
export interface CourseGraphV1 {
  courseId: string;
  course: string;
  kinds: Record<ResourceKind, number>;
  /** Accepted links between permitted items, by type. */
  links: { specifies: number; supports: number; same_as: number };
  assignmentsWithoutDueDate: number;
  coverage: SourceCoverage[];
}
/** A list row: no bodies. */
export interface ResourceSummaryV1 {
  id: string;
  courseId: string;
  course: string;
  title: string;
  kind: ResourceKind;
  url?: string;
  version: number;
  observedAt: string;
  dueAt: string | null;
  textLength: number;
}
export type ItemV1 = ReturnType<ReadSession["project"]>;
export interface AssignmentV1 {
  id: string;
  courseId: string;
  course: string;
  title: string;
  url?: string;
  dueAt: string | null;
  planningAt: string | null;
  conflict: boolean;
  completed: boolean;
}
interface Meta {
  contract: typeof CONTRACT;
  version: typeof VERSION;
  /** True when the budget trimmed excerpts or items. */
  trimmed: boolean;
}
export interface ResultsV1 {
  courses: Meta & { courses: CourseV1[] };
  courseGraph: Meta & { graph: CourseGraphV1 | null };
  resources: Meta & { items: ResourceSummaryV1[]; total: number; nextCursor?: string };
  resource: Meta & { item: ItemV1 | null };
  searchPassages: Meta & { hits: ItemV1[] };
  assignments: Meta & { items: AssignmentV1[] };
  agenda: Meta & { status: "not_built"; items: [] };
  // owner: course-facts. The course's syllabus.md, scrubbed for this connection.
  courseBrief: Meta & { brief: CourseBriefV1 };
}
/** owner: course-facts. The checked course brief (syllabus.md): code-rendered, quote-verified. */
export interface CourseBriefV1 {
  courseId: string;
  /** Markdown; roster names, emails and phone numbers replaced. */
  text: string;
  /** sha256 of the brief before this connection's scrub: equal hashes mean an unchanged brief. */
  hash: string;
}

const meta = (trimmed: boolean): Meta => ({ contract: CONTRACT, version: VERSION, trimmed });
const encodeCursor = (offset: number) => Buffer.from(JSON.stringify({ o: offset })).toString("base64url");
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString()) as { o?: unknown };
    if (Number.isSafeInteger(value.o) && (value.o as number) >= 0) return value.o as number;
  } catch {}
  throw new Error("Invalid cursor.");
}

export interface ReadApiV1 {
  readonly contract: typeof CONTRACT;
  readonly version: typeof VERSION;
  courses(input?: Input<"courses">): ResultsV1["courses"];
  courseGraph(input: Input<"courseGraph">): ResultsV1["courseGraph"];
  resources(input?: Input<"resources">): ResultsV1["resources"];
  resource(input: Input<"resource">): ResultsV1["resource"];
  searchPassages(input: Input<"searchPassages">): ResultsV1["searchPassages"];
  assignments(input?: Input<"assignments">): ResultsV1["assignments"];
  agenda(input?: Input<"agenda">): ResultsV1["agenda"];
  courseBrief(input: Input<"courseBrief">): ResultsV1["courseBrief"]; // owner: course-facts
}

/** The v1 reader for one grant. The store may be the read-only reader or the app's writer. */
export function createReadApi(store: Store, credentials: Credentials, options: SessionOptions = {}): ReadApiV1 {
  /** One call: parse, open a fresh session (the grant is rechecked), fit the budget, one receipt. */
  function run<V extends Verb>(
    verb: V,
    raw: unknown,
    body: (
      session: ReadSession,
      input: z.output<(typeof inputSchemas)[V]>,
    ) => {
      count: number;
      /** `final` false: a sizing build (no citation projection is registered). */
      build: (level: DetailLevel, count: number, final: boolean) => ResultsV1[V];
      items: (count: number) => Resource[];
      from?: number;
      private?: boolean;
    },
  ): ResultsV1[V] {
    const input = inputSchemas[verb].parse(raw ?? {}) as z.output<(typeof inputSchemas)[V]>;
    return withOneRead(store, () => {
      const session = openSession(store, credentials, options, "courseId" in input ? { courseId: input.courseId as string | undefined } : {});
      const plan = body(session, input);
      const fitted = fitToBudget(BUDGET_TOKENS[verb], plan.count, plan.build, plan.from ?? 0);
      session.receipt(`agent-api v1 ${verb}`, plan.items(fitted.count), fitted.text.length, plan.private ?? false);
      return fitted.value;
    });
  }
  const coverage = (session: ReadSession, courseId: string, accountScope: string): SourceCoverage[] =>
    [...session.sourceMap.values()]
      .filter(
        (s) =>
          s.courseId === courseId &&
          s.accountScope === accountScope &&
          session.grantedCourse(s.accountScope, s.courseId) &&
          session.included({ sourceId: s.id, courseId: s.courseId } as Resource),
      )
      .map((s) => ({
        source: session.out(s.label, s.courseId, s.accountScope),
        status: s.status,
        complete: s.complete,
        lastSuccessAt: s.lastSuccessAt,
      }));
  const scopeOf = (session: ReadSession, r: Resource) => session.sourceMap.get(r.sourceId)?.accountScope ?? "";
  const summary = (session: ReadSession, r: Resource): ResourceSummaryV1 => {
    const s = session.scrubFor(r);
    return {
      id: r.id,
      courseId: r.courseId,
      course: s(r.courseName),
      title: s(r.title),
      kind: r.kind,
      ...(r.url ? { url: r.url } : {}),
      version: r.version,
      observedAt: r.observedAt,
      dueAt: session.deadlineFor(r).dueAt,
      textLength: r.text.length,
    };
  };
  return {
    contract: CONTRACT,
    version: VERSION,
    courses: (input) =>
      run("courses", input, (session) => {
        const groups = new Map<string, Resource[]>();
        for (const r of session.resources()) {
          if (r.courseId === "account" || r.courseId === "connection") continue;
          const key = `${scopeOf(session, r)}\n${r.courseId}`;
          groups.set(key, [...(groups.get(key) ?? []), r]);
        }
        const now = session.now().toISOString();
        const rows: { course: CourseV1; items: Resource[] }[] = [...groups.entries()].map(([key, items]) => {
          const [accountScope, courseId] = key.split("\n") as [string, string];
          const open = items.filter((r) => r.kind === "assignment" && !r.completed);
          const due = open
            .map((r) => session.deadlineFor(r).dueAt)
            .filter((d): d is string => !!d && d >= now)
            .sort()[0];
          return {
            items,
            course: {
              courseId,
              course: session.out(items[0]!.courseName, courseId, accountScope),
              resources: items.length,
              openAssignments: open.length,
              nextDueAt: due ?? null,
              coverage: coverage(session, courseId, accountScope),
            },
          };
        });
        rows.sort((a, b) => a.course.course.localeCompare(b.course.course));
        return {
          count: rows.length,
          build: (_level, n) => ({ ...meta(n < rows.length), courses: rows.slice(0, n).map((r) => r.course) }),
          items: () => [],
        };
      }),
    courseGraph: (input) =>
      run("courseGraph", input, (session, { courseId }) => {
        const items = session.resources().filter((r) => r.courseId === courseId);
        const ids = new Set(items.map((r) => r.id));
        const links = { specifies: 0, supports: 0, same_as: 0 };
        for (const l of session.view.links())
          if (l.status === "accepted" && ids.has(l.fromId) && ids.has(l.toId)) links[l.type]++;
        const counts = Object.fromEntries(kinds.map((k) => [k, items.filter((r) => r.kind === k).length])) as Record<
          ResourceKind,
          number
        >;
        const first = items[0];
        const graph: CourseGraphV1 | null = first
          ? {
              courseId,
              course: session.scrubFor(first)(first.courseName),
              kinds: counts,
              links,
              assignmentsWithoutDueDate: items.filter((r) => r.kind === "assignment" && !session.deadlineFor(r).dueAt)
                .length,
              coverage: coverage(session, courseId, scopeOf(session, first)),
            }
          : null;
        return {
          count: 1,
          build: () => ({ ...meta(false), graph }),
          items: () => [],
        };
      }),
    resources: (input) =>
      run("resources", input, (session, { kinds: only, cursor, limit }) => {
        const offset = decodeCursor(cursor);
        const wanted = only ? new Set<string>(only) : undefined;
        const all = session.resources().filter((r) => !wanted || wanted.has(r.kind));
        const page = all.slice(offset, offset + limit);
        const rows = page.map((r) => summary(session, r));
        return {
          count: rows.length,
          build: (_level, n) => ({
            ...meta(n < rows.length),
            items: rows.slice(0, n),
            total: all.length,
            ...(offset + n < all.length ? { nextCursor: encodeCursor(offset + n) } : {}),
          }),
          items: (n) => page.slice(0, n),
        };
      }),
    resource: (input) =>
      run("resource", input, (session, { id: wanted }) => {
        const r = session.resources().find((x) => x.id === wanted);
        if (!r) throw new Error("Item unavailable within this connection's permissions.");
        return {
          count: 1,
          build: (level, n, final) => ({
            ...meta(level.window < 8000 || n < 1),
            item: n ? session.project(r, { level, dry: !final }) : null,
          }),
          items: (n) => (n ? [r] : []),
          private: true,
        };
      }),
    searchPassages: (input) =>
      run("searchPassages", input, (session, { query, limit }) => {
        const found = session.search(query, limit);
        return {
          count: found.length,
          // Search returns excerpts: it starts at the 2,000-character window, not a whole item.
          from: 2,
          build: (level, n, final) => ({
            ...meta(level.window < 2000 || n < found.length),
            hits: found.slice(0, n).map((f) => session.project(f.resource, { level, around: f.around, dry: !final })),
          }),
          items: (n) => found.slice(0, n).map((f) => f.resource),
          private: true,
        };
      }),
    assignments: (input) =>
      run("assignments", input, (session, { days }) => {
        const now = session.now().getTime();
        const rows = session
          .resources()
          .filter((r) => r.kind === "assignment")
          .map((r) => ({ r, d: session.deadlineFor(r) }))
          .filter(
            ({ d }) =>
              days === undefined ||
              (!!d.planningAt && Date.parse(d.planningAt) >= now && Date.parse(d.planningAt) <= now + days * 86_400_000),
          )
          .sort((a, b) => (a.d.planningAt ?? "9999").localeCompare(b.d.planningAt ?? "9999"));
        const items = rows.map(({ r, d }): AssignmentV1 => {
          const s = session.scrubFor(r);
          return {
            id: r.id,
            courseId: r.courseId,
            course: s(r.courseName),
            title: s(r.title),
            ...(r.url ? { url: r.url } : {}),
            dueAt: d.dueAt,
            planningAt: d.planningAt,
            conflict: d.conflict,
            completed: r.completed,
          };
        });
        return {
          count: items.length,
          build: (_level, n) => ({ ...meta(n < items.length), items: items.slice(0, n) }),
          items: (n) => rows.slice(0, n).map((x) => x.r),
        };
      }),
    // TODO(D42): the core agenda (packages/core/src/graph/agenda.ts) merges the planning enrollment's
    // class meetings, and planning data never leaves through the platform. v1 answers "not_built"
    // until a planning-free agenda variant exists, rather than guessing or leaking.
    // owner: course-facts. Same grant, scrub and receipt path as every verb; refused when any source
    // the brief draws on isn't shared with this connection.
    courseBrief: (input) =>
      run("courseBrief", input, (session, { courseId }) => {
        const items = session.resources().filter((r) => r.courseId === courseId);
        const first = items[0];
        if (!first) throw new Error("Course unavailable within this connection's permissions.");
        const brief = renderCourseBrief(store, { accountScope: scopeOf(session, first), courseId });
        const allowed = new Map(items.map((r) => [r.id, r]));
        if (!brief || brief.resourceIds.some((id) => !allowed.has(id)))
          throw new Error("The course brief draws on sources this connection can't read.");
        const text = session.scrubFor(first)(brief.text);
        const used = brief.resourceIds.map((id) => allowed.get(id)!);
        return {
          count: 1,
          build: (level) => {
            // Over budget: whole lines from the top (the header and sources come first).
            const limit = level.window * 3;
            const cut = text.length <= limit ? text : text.slice(0, text.lastIndexOf("\n", limit) + 1);
            return { ...meta(cut.length < text.length), brief: { courseId, text: cut, hash: brief.hash } };
          },
          items: () => used,
          private: true,
        };
      }),
    // end owner: course-facts
    agenda: (input) =>
      run("agenda", input, () => ({
        count: 0,
        build: () => ({ ...meta(false), status: "not_built" as const, items: [] as [] }),
        items: () => [],
      })),
  };
}
