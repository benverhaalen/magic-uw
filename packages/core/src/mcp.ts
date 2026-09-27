import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import type { Resource, Store } from "@magic/contracts";
import { resolveDeadline } from "@magic/domain";
// The course bank is an adapter over the agent API's grant session: one grant check, one sharing
// gate, one scrub projection, one budget and one receipt path for MCP and the v1 API alike.
import { openSession, withOneRead, type SessionOptions } from "../../agent-api/src/session";
import { fitToBudget, type DetailLevel } from "../../agent-api/src/budget";

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
/** Per-tool token budgets. A larger result is trimmed (narrower excerpts, then fewer items), never refused. */
export const MCP_BUDGET_TOKENS: Record<ToolName, number> = {
  search: 8000,
  answer_course_question: 8000,
  get_item: 12000,
  due_soon: 8000,
  recent_changes: 6000,
  course_overview: 4000,
};

/**
 * Authentication identifies a grant; each read rechecks live grants and global privacy settings.
 * `options.recordReceipt`: the read-only reader passes its receipt log; the default is the store.
 */
export function createMcpService(
  store: Store,
  clientId: string,
  token: string,
  now = () => new Date(),
  options: Pick<SessionOptions, "recordReceipt"> = {},
) {
  /** One tool call over one decode of the store. */
  function call(name: ToolName, raw: unknown) {
    return withOneRead(store, () => read(name, raw));
  }
  function read(name: ToolName, raw: unknown) {
    const args = mcpArgumentsSchema.parse(raw);
    const session = openSession(
      store,
      { clientId, token },
      { now, recordReceipt: options.recordReceipt },
      { courseId: args.courseId },
    );
    let selected: Resource[] = [];
    let fitted: { value: unknown; text: string; count: number };
    const projectAll = (items: { resource: Resource; around?: number }[]) =>
      fitToBudget(MCP_BUDGET_TOKENS[name], items.length, (level: DetailLevel, n, final) =>
        items.slice(0, n).map((f) => session.project(f.resource, { level, around: f.around, dry: !final })),
      );
    if (name === "get_item") {
      const r = session.resources().find((x) => x.id === args.id);
      if (!r) throw new Error("Item unavailable within this connection's permissions.");
      fitted = fitToBudget(MCP_BUDGET_TOKENS.get_item, 1, (level, _n, final) =>
        session.project(r, { level, dry: !final }),
      );
      selected = [r];
    } else if (name === "recent_changes") {
      const events = store
        .changes({ since: args.since, limit: 500 })
        .filter((e) => {
          const r = store.resource(e.resourceId);
          return r && session.allowed(r, true);
        })
        .slice(0, args.limit);
      const values = (value: Record<string, unknown>, keys: string[]) =>
        Object.fromEntries(Object.entries(value).filter(([k]) => keys.includes(k)));
      const rows = events.map((e) => ({
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
      fitted = fitToBudget(MCP_BUDGET_TOKENS.recent_changes, rows.length, (_level, n) => rows.slice(0, n));
      const kept = new Set(rows.slice(0, fitted.count).map((e) => e.resourceId));
      selected = [...kept].map((id) => store.resource(id)!);
    } else if (name === "course_overview") {
      const resources = session.resources();
      const visibleSources = new Set(resources.map((r) => r.sourceId));
      const sources = [...session.sourceMap.values()].filter(
        (s) =>
          visibleSources.has(s.id) ||
          (session.permitted("course_text") &&
            session.grantedCourse(s.accountScope, s.courseId) &&
            session.included({ sourceId: s.id, courseId: s.courseId } as Resource)),
      );
      const coverage = sources.map((s) => ({
        source: session.out(s.label, s.courseId, s.accountScope),
        status: s.status,
        complete: s.complete,
        lastSuccessAt: s.lastSuccessAt,
      }));
      const head = {
        items: resources.length,
        kinds: Object.fromEntries(
          ["assignment", "material", "event", "message", "course"].map((k) => [
            k,
            resources.filter((r) => r.kind === k).length,
          ]),
        ),
      };
      const itemsWithNoDueDate = resources.filter(
        (r) => r.kind === "assignment" && !session.deadlineFor(r).dueAt,
      ).length;
      fitted = fitToBudget(MCP_BUDGET_TOKENS.course_overview, coverage.length, (_level, n) => ({
        ...head,
        coverage: coverage.slice(0, n),
        itemsWithNoDueDate,
      }));
      selected = resources;
    } else if (name === "due_soon") {
      const evidence = session.evidence();
      const start = now().getTime();
      const cutoff = start + args.days * 86_400_000;
      const due = session
        .resources()
        .filter((r) => {
          const at = resolveDeadline(evidence.deadlines(r), evidence.unresolvedDeadlines(r)).planningAt;
          return at && Date.parse(at) >= start && Date.parse(at) <= cutoff;
        })
        .sort((a, b) =>
          (session.deadlineFor(a).planningAt ?? "").localeCompare(session.deadlineFor(b).planningAt ?? ""),
        )
        .slice(0, args.limit)
        .map((resource) => ({ resource }));
      fitted = projectAll(due);
      selected = due.slice(0, fitted.count).map((f) => f.resource);
    } else {
      // search and answer_course_question: the FTS index (BM25, OR) within the grant's courses.
      const found = session.search(args.query ?? "", args.limit);
      const items = found.length || (args.query ?? "").trim()
        ? found
        : session.resources().slice(0, args.limit).map((resource) => ({ resource, around: undefined }));
      const projected = projectAll(items);
      selected = items.slice(0, projected.count).map((f) => f.resource);
      fitted =
        name === "answer_course_question"
          ? fitToBudget(MCP_BUDGET_TOKENS[name], 1, () => ({
              mode: "source_passages",
              answer: selected.length
                ? "These saved passages address the question. Check coverage and source dates; missing evidence is not proof that no requirement exists."
                : "No matching passage was found in the permitted saved sources.",
              evidence: projected.value,
            }))
          : projected;
    }
    // Synchronous projection and receipt share the same grant snapshot; no network/model can race revocation.
    session.receipt(
      `MCP ${name}`,
      selected,
      fitted.text.length,
      name !== "recent_changes" && name !== "course_overview",
    );
    return fitted.value;
  }
  const server = new McpServer({ name: "My Magic UW", version: "0.3.0" });
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
                text: "This read was blocked or unavailable. Check the connection's course and data permissions in My Magic UW.",
              },
            ],
          };
        }
      },
    );
  return { server, call };
}
