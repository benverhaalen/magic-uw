import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { mcpCategorySchema, type McpCategory, type Store } from "@magic/contracts";
import { maySend } from "@magic/domain";
import { courseInclusion } from "../access";
import { createMcpService, mcpArgumentsSchema, toolDescriptions, type ToolName } from "../mcp";
import { CONTROL_TOOL_NAMES, createControlTools, type AppControlPort } from "./control";

/**
 * The in-app Claude chat's read tools (decisions.md, 2026-09-27: the chat is one Claude Code session
 * harnessed on the local database). The course tools are the MCP course bank's own handlers
 * (`createMcpService`): one grant check, sharing gate, course inclusion, scrub projection, budget and
 * receipt per read. `degree_plan` is gated by Data & AI's "Degree plan and audit" row. All read-only.
 */
export const CHAT_SERVER = "magic";
export const CHAT_GRANT_ID = "in-app-claude-chat";
const DEGREE_PLAN = "degree_plan";
export const CHAT_TOOL_NAMES = [...(Object.keys(toolDescriptions) as ToolName[]), DEGREE_PLAN, ...CONTROL_TOOL_NAMES] as const;
/** The `--allowedTools` list: exactly the app's own read and app-control tools, nothing built in. */
export const CHAT_ALLOWED_TOOLS = CHAT_TOOL_NAMES.map((name) => `mcp__${CHAT_SERVER}__${name}`);

const degreePlanArgs = z.object({ query: z.string().max(200).optional() }).strict();

/** Included courses, as grant pairs: the chat never sees an excluded course. */
export function includedCourses(store: Store): { accountScope: string; courseId: string }[] {
  const included = courseInclusion(store);
  const sources = new Map(store.sources().map((s) => [s.id, s]));
  const pairs = new Map<string, { accountScope: string; courseId: string }>();
  for (const r of store.resources()) {
    if (r.deleted || !included(r)) continue;
    const accountScope = sources.get(r.sourceId)?.accountScope;
    if (!accountScope || !r.courseId) continue;
    pairs.set(`${accountScope}\u0000${r.courseId}`, { accountScope, courseId: r.courseId });
    if (pairs.size >= 500) break;
  }
  return [...pairs.values()];
}

/**
 * Writes the chat's own grant (recipient claude, the included courses, the categories the student
 * shares) with a fresh token, and returns the token. Called before every question, so an exclusion
 * or a sharing change applies to the next read; each read rechecks both anyway.
 */
export function refreshChatGrant(store: Store, token?: string): string {
  const value = token ?? randomBytes(32).toString("hex");
  const privacy = store.privacy();
  const categories = mcpCategorySchema.options.filter((c: McpCategory) => maySend(privacy, "claude", [c]).allowed);
  store.setMcpGrant({
    id: CHAT_GRANT_ID,
    label: "In-app chat (Claude Code)",
    recipient: "claude",
    enabled: true,
    courses: includedCourses(store),
    categories,
    tokenHash: createHash("sha256").update(value).digest("hex"),
  });
  return value;
}

export interface ChatToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function createChatTools(store: Store, token: string, now = () => new Date(), control?: AppControlPort) {
  const mcp = createMcpService(store, CHAT_GRANT_ID, token, now);
  const controls = control ? createControlTools(store, { clientId: CHAT_GRANT_ID, token }, control, now) : null;
  const courseSchema = z.toJSONSchema(mcpArgumentsSchema, { io: "input" }) as Record<string, unknown>;
  const list: ChatToolDef[] = [
    ...(Object.entries(toolDescriptions) as [ToolName, string][]).map(([name, description]) => ({ name, description, inputSchema: courseSchema })),
    {
      name: DEGREE_PLAN,
      description:
        "Read the student's saved degree audit (DARS) requirements with their status, completed and planned courses, and catalog entries for courses that satisfy open requirements. Refused unless the student shares their degree plan and audit.",
      inputSchema: z.toJSONSchema(degreePlanArgs, { io: "input" }) as Record<string, unknown>,
    },
    ...(controls?.list ?? []),
  ];

  function degreePlan(raw: unknown) {
    const args = degreePlanArgs.parse(raw ?? {});
    const privacy = store.privacy();
    const gate = maySend(privacy, "claude", ["planning", "audit"]);
    if (!gate.allowed) throw new Error(gate.reason);
    const grades = maySend(privacy, "claude", ["grades"]).allowed;
    const records = store.planningRecords().filter((r) => !r.deleted);
    const history = records.flatMap((r) =>
      r.kind === "course_history"
        ? [{ course: r.courseKey, term: r.termCode, state: r.state, credits: r.credits, ...(grades ? { grade: r.grade } : {}) }]
        : [],
    );
    const open = new Set<string>();
    const audits = records.flatMap((r) =>
      r.kind === "audit"
        ? [{
            program: r.programKey,
            generatedAt: r.generatedAt,
            coverage: r.coverage,
            requirements: r.nodes.slice(0, 200).map((n) => {
              if (n.status !== "completed") for (const k of n.acceptableCourseKeys.slice(0, 40)) open.add(k);
              return {
                title: n.title,
                kind: n.requirementKind,
                status: n.status,
                needsCourses: n.needsCourses,
                needsCredits: n.needsCredits,
                acceptable: n.acceptableCourseKeys.slice(0, 40),
                applied: n.appliedCourses.slice(0, 20).map((a) => ({ course: a.courseKey ?? a.rawCourse, term: a.termCode, state: a.state })),
              };
            }),
          }]
        : [],
    );
    const q = args.query?.toLowerCase();
    const catalog = records
      .flatMap((r) => (r.kind === "catalog_course" ? [r] : []))
      .filter((c) => open.has(c.courseKey) || (q && `${c.courseKey} ${c.title}`.toLowerCase().includes(q)))
      .slice(0, 60)
      .map((c) => ({ course: c.courseKey, title: c.title, credits: [c.creditMin, c.creditMax], prerequisite: c.prerequisiteText?.slice(0, 400) ?? null, offered: c.offeringFrequency }));
    const value = { audits, history, catalog, note: audits.length ? undefined : "No degree audit is saved on this computer yet." };
    const text = JSON.stringify(value);
    store.addReceipt({
      id: randomUUID(),
      recipient: "claude",
      purpose: "Chat degree_plan",
      categories: ["planning", "audit", ...(grades && history.some((h) => "grade" in h) ? ["grades"] : [])],
      resourceIds: [],
      characters: text.length,
      status: "sent",
      createdAt: now().toISOString(),
    });
    return value;
  }

  return {
    list,
    /** One read or app action. Throws when the grant, sharing or inclusion refuses it. */
    async call(name: string, args: unknown): Promise<unknown> {
      if (controls && (CONTROL_TOOL_NAMES as readonly string[]).includes(name)) return controls.call(name, args);
      if (name === DEGREE_PLAN) return degreePlan(args);
      if (!(name in toolDescriptions)) throw new Error("Unknown tool.");
      return mcp.call(name as ToolName, args ?? {});
    },
  };
}
export type ChatTools = ReturnType<typeof createChatTools>;
