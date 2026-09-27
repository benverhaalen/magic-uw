import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import {
  evidenceUrlSchema,
  type Store,
  type Resource,
  type McpCategory,
} from "@magic/contracts";
import { maySend, resolveDeadline } from "@magic/domain";
import { contentCategories, courseInclusion } from "./access";
import { evidenceFor } from "./evidence";
import { outgoingProjection, payloadScrubber } from "./identity";

export const mcpArgumentsSchema = z
  .object({
    query: z.string().max(1000).optional(),
    courseId: z.string().max(256).optional(),
    id: z.string().max(256).optional(),
    days: z.number().int().min(1).max(90).default(14),
    since: z.iso.datetime({ offset: true }).optional(),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();
type ToolName =
  | "search"
  | "due_soon"
  | "recent_changes"
  | "course_overview"
  | "get_item"
  | "answer_course_question";
const toolDescriptions: Record<ToolName, string> = {
  search:
    "Search permitted local course evidence. Returns bounded excerpts and citations.",
  due_soon:
    "List saved due dates and conflicting claims for permitted courses, with source freshness.",
  recent_changes:
    "List deterministic changes. Private old/new grade values require a separate grant.",
  course_overview:
    "Summarize available material and source coverage for a permitted course.",
  get_item: "Read a permitted item with page citations and source timestamps.",
  answer_course_question:
    "Answer from matching source passages with exact quotes and citations. Extractive evidence only; makes no model call.",
};

/** Authentication identifies a grant; each read rechecks live grants and global privacy settings. */
export function createMcpService(
  store: Store,
  clientId: string,
  token: string,
  now = () => new Date(),
) {
  function grant() {
    const g = store.mcpGrants().find((g) => g.id === clientId && g.enabled);
    const hash = createHash("sha256").update(token).digest();
    const expected = Buffer.from(g?.tokenHash ?? "", "hex");
    if (
      !g ||
      expected.length !== hash.length ||
      !timingSafeEqual(hash, expected)
    )
      throw new Error("This connection is unavailable or has been revoked.");
    return g;
  }
  function call(name: ToolName, raw: unknown) {
    const args = mcpArgumentsSchema.parse(raw);
    const g = grant();
    const permitted = (category: McpCategory) =>
      g.categories.includes(category) &&
      maySend(store.privacy(), g.recipient, [category]).allowed;
    if (!g.categories.some(permitted))
      throw new Error("Sharing is disabled for this connection.");
    const included = courseInclusion(store);
    const sourceMap = new Map(store.sources().map((s) => [s.id, s]));
    const allowed = (r: Resource, includeDeleted = false) => {
      const source = sourceMap.get(r.sourceId);
      return (
        (includeDeleted || !r.deleted) &&
        included(r) &&
        !!source &&
        g.courses.some(
          (c) =>
            c.accountScope === source.accountScope && c.courseId === r.courseId,
        ) &&
        (!args.courseId || r.courseId === args.courseId) &&
        contentCategories(r).every(permitted)
      );
    };
    // MCP output goes to hosted AI clients: scrub every free-text field with the
    // same scrubber as hosted payloads. Excerpt offsets are in scrubbed ("outgoing")
    // coordinates of the item's text, so validate-citations maps them back locally.
    const scrubbers = new Map<string, ReturnType<typeof payloadScrubber>>();
    const memo = new Map<string, string>();
    const out = (value: string, courseId: string, scope?: string) => {
      const scopeKey = scope ?? "";
      let scrubber = scrubbers.get(scopeKey);
      if (!scrubber) scrubbers.set(scopeKey, scrubber = payloadScrubber(store, true, scope));
      const key = `${scopeKey}\u0000${courseId}\u0000${value}`;
      let v = memo.get(key);
      if (v === undefined) memo.set(key, (v = scrubber.field(value, courseId)));
      return v;
    };
    const allResources = store.resources();
    const resources = allResources.filter((r) => allowed(r));
    const evidence = evidenceFor(store, (r) => allowed(r));
    const safeUrl = (url: string) =>
      evidenceUrlSchema.safeParse(url).success ? url : undefined;
    const terms =
      (args.query ?? "")
        .toLocaleLowerCase()
        .match(/[\p{L}\p{N}]{2,}/gu)
        ?.filter(
          (t) =>
            ![
              "what",
              "when",
              "where",
              "does",
              "the",
              "and",
              "for",
              "how",
              "this",
              "that",
              "with",
              "are",
            ].includes(t),
        ) ?? [];
    const contributors = new Map<string, Resource>();
    function deadlineFor(r: Resource) {
      for (const contributor of evidence.contributors(r)) contributors.set(contributor.id, contributor);
      return resolveDeadline(evidence.deadlines(r), evidence.unresolvedDeadlines(r));
    }
    function projectedDeadline(r: Resource) {
      const scrubValue = (v: unknown): unknown => typeof v === "string" ? out(v, r.courseId, sourceMap.get(r.sourceId)?.accountScope) : Array.isArray(v) ? v.map(scrubValue) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubValue(x)])) : v;
      return scrubValue(deadlineFor(r));
    }
    function project(r: Resource) {
      const source = sourceMap.get(r.sourceId)!;
      const s = (value: string) => out(value, r.courseId, source.accountScope);
      const text = s(r.text);
      const match =
        terms
          .map((t) => text.toLocaleLowerCase().indexOf(t))
          .filter((n) => n >= 0)
          .sort((a, b) => a - b)[0] ?? 0;
      const start =
        name === "answer_course_question" || name === "search"
          ? Math.max(0, match - 500)
          : 0;
      const projection = outgoingProjection(store, r, "text", { start, end: start + 8000 });
      return {
        id: r.id,
        courseId: r.courseId,
        course: s(r.courseName),
        title: s(r.title),
        kind: r.kind,
        text: projection.text,
        excerpt: { start, end: Math.min(text.length, start + 8000), basis: "outgoing" as const },
        deadline: projectedDeadline(r),
        citation: {
          url: safeUrl(r.url),
          version: r.version,
          contentHash: r.contentHash,
          projectionId: projection.id,
          observedAt: r.observedAt,
          source: s(source.label),
        },
        parts: r.parts?.slice(0, 40).map((p) => ({
          page: p.page,
          slide: p.slide,
          section: p.section,
          offsetBasis: "original_source" as const,
          start: p.start,
          end: p.end,
          text: s(p.text).slice(0, 2000),
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
                grade: r.submission.grade,
                late: r.submission.late,
                missing: r.submission.missing,
                excused: r.submission.excused,
              },
            }
          : {}),
        ...(permitted("comments") && r.submission
          ? {
              comments: r.submission.comments?.map((c) => ({
                ...c,
                text: s(c.text),
                ...(c.authorName ? { authorName: s(c.authorName) } : {}),
              })),
            }
          : {}),
        // No raw HTML, identities, local paths, secret URLs, or arbitrary source payloads.
      };
    }
    let selected = resources,
      result: unknown;
    if (name === "get_item") {
      selected = resources.filter((r) => r.id === args.id);
      if (!selected.length)
        throw new Error(
          "Item unavailable within this connection's permissions.",
        );
      result = project(selected[0]);
    } else if (name === "recent_changes") {
      const events = store
        .changes({ since: args.since, limit: 500 })
        .filter((e) => {
          const r = store.resource(e.resourceId);
          return r && allowed(r, true);
        })
        .slice(0, args.limit);
      selected = [
        ...new Map(
          events.map((e) => {
            const r = store.resource(e.resourceId)!;
            return [r.id, r] as const;
          }),
        ).values(),
      ];
      const values = (value: Record<string, unknown>, keys: string[]) =>
        Object.fromEntries(
          Object.entries(value).filter(([k]) => keys.includes(k)),
        );
      result = events.map((e) => ({
        id: e.id,
        resourceId: e.resourceId,
        type: e.type,
        observedAt: e.observedAt,
        ...(e.type === "date_changed"
          ? {
              oldValues: values(e.oldValues, ["dueAt", "unlockAt", "lockAt"]),
              newValues: values(e.newValues, ["dueAt", "unlockAt", "lockAt"]),
            }
          : {}),
      }));
    } else if (name === "course_overview") {
      const visibleSources = new Set(resources.map((r) => r.sourceId));
      const sources = [...sourceMap.values()].filter(
        (s) =>
          visibleSources.has(s.id) ||
          (permitted("course_text") &&
            g.courses.some(
              (c) =>
                c.accountScope === s.accountScope && c.courseId === s.courseId,
            ) &&
            (!args.courseId || s.courseId === args.courseId) &&
            included({ sourceId: s.id, courseId: s.courseId } as Resource)),
      );
      result = {
        items: resources.length,
        kinds: Object.fromEntries(
          ["assignment", "material", "event", "message", "course"].map((k) => [
            k,
            resources.filter((r) => r.kind === k).length,
          ]),
        ),
        coverage: sources.map((s) => ({
          source: out(s.label, s.courseId, s.accountScope),
          status: s.status,
          complete: s.complete,
          lastSuccessAt: s.lastSuccessAt,
        })),
        itemsWithNoDueDate: resources.filter(
          (r) =>
            r.kind === "assignment" &&
            !deadlineFor(r).dueAt,
        ).length,
      };
    } else {
      if (name === "due_soon") {
        const cutoff = now().getTime() + args.days * 86_400_000;
        selected = resources
          .filter((r) => {
            const due = resolveDeadline(evidence.deadlines(r), evidence.unresolvedDeadlines(r)).planningAt;
            return (
              due &&
              Date.parse(due) >= now().getTime() &&
              Date.parse(due) <= cutoff
            );
          })
          .sort((a, b) =>
            (
              deadlineFor(a).planningAt ?? ""
            ).localeCompare(
              deadlineFor(b).planningAt ?? "",
            ),
          );
      } else {
        const ranked = resources.map((r) => ({
          r,
          score: terms.reduce(
            (n, t) =>
              n +
              (out(r.title, r.courseId).toLowerCase().includes(t) ? 4 : 0) +
              (out(r.text, r.courseId).toLowerCase().includes(t) ? 1 : 0),
            0,
          ),
        }));
        selected = ranked
          .filter((x) => terms.length === 0 || x.score > 0)
          .sort((a, b) => b.score - a.score)
          .map((x) => x.r);
      }
      selected = selected.slice(0, args.limit);
      result =
        name === "answer_course_question"
          ? {
              mode: "source_passages",
              answer: selected.length
                ? "These saved passages address the question. Check coverage and source dates; missing evidence is not proof that no requirement exists."
                : "No matching passage was found in the permitted saved sources.",
              evidence: selected.map(project),
            }
          : selected.map(project);
    }
    // Synchronous projection and receipt share the same grant snapshot; no network/model can race revocation.
    const text = JSON.stringify(result);
    if (text.length > 200_000)
      throw new Error(
        "Result exceeds the sharing budget. Request fewer items.",
      );
    const categories = [
      ...new Set(
        [...new Map([...selected, ...contributors.values()].map((r) => [r.id, r])).values()].flatMap((r) => [
          ...contentCategories(r),
          ...(permitted("grades") &&
          r.submission &&
          name !== "recent_changes" &&
          name !== "course_overview"
            ? ["grades" as const]
            : []),
          ...(permitted("comments") &&
          r.submission?.comments &&
          name !== "recent_changes" &&
          name !== "course_overview"
            ? ["comments" as const]
            : []),
        ]),
      ),
    ];
    store.addReceipt({
      id: randomUUID(),
      recipient: g.recipient,
      purpose: `MCP ${name}`,
      categories,
      resourceIds: [...new Set([...selected.map((r) => r.id), ...contributors.keys()])],
      characters: text.length,
      status: "sent",
      createdAt: now().toISOString(),
    });
    return result;
  }
  const server = new McpServer({ name: "Magic Canvas", version: "0.2.0" });
  for (const [name, description] of Object.entries(toolDescriptions))
    server.registerTool(
      name,
      {
        description,
        inputSchema: mcpArgumentsSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async (args) => {
        try {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(call(name as ToolName, args)),
              },
            ],
          };
        } catch {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: "This read was blocked or unavailable. Check the connection's course and data permissions in Magic Canvas.",
              },
            ],
          };
        }
      },
    );
  return { server, call };
}
