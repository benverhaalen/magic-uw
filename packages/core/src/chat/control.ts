import { randomUUID } from "node:crypto";
import { z } from "zod";
import { studyPrepPackName, type PackScope, type Resource, type Store } from "@magic/contracts";
import { openSession } from "../../../agent-api/src/session";
import { contentCategories } from "../access";
import type { ChatToolDef } from "./tools";

/**
 * App-control tools for the student's Claude Code agent (decisions.md, 2026-09-27): open a page, open
 * a saved item in Canvas, and make or show study material. The model supplies ids only; code checks
 * each id against the chat's grant (included courses, shared categories) and picks the destination
 * itself: page names come from a fixed list, and a Canvas link is the stored URL of that record on
 * the Canvas host, never a URL the model wrote. Each call writes a receipt like a read.
 */
export const PAGES = ["home", "course", "item", "prep", "study", "calendar", "data-ai"] as const;
export type AppPage = (typeof PAGES)[number];

/** What main does with the window: navigate, bring it forward, open the stored link. */
export interface AppControlPort {
  navigate(target: {
    page: AppPage;
    courseId?: string;
    accountScope?: string;
    resourceId?: string;
    action?: "cards" | "quiz" | "guide";
  }): Promise<boolean>;
  openExternal(url: string): Promise<void>;
  /** The existing pack command (cards, quiz, study-prep kinds). */
  pack(name: string, scope: PackScope): Promise<unknown>;
}

/** The Canvas host; the synthetic sample course opens its own sample links. */
export const CANVAS_HOSTS = new Set(["canvas.wisc.edu"]);

const id = z.string().min(1).max(256);
const openPageArgs = z.object({ page: z.enum(PAGES), courseId: id.optional(), itemId: id.optional() }).strict();
const canvasArgs = z
  .object({ itemId: id.optional(), courseId: id.optional() })
  .strict()
  .refine((a) => !!a.itemId !== !!a.courseId, "Give exactly one of itemId or courseId.");
const itemArgs = z.object({ itemId: id }).strict();
const schema = (s: z.ZodType) => z.toJSONSchema(s, { io: "input" }) as Record<string, unknown>;

export const CONTROL_TOOLS: ChatToolDef[] = [
  {
    name: "open_page",
    description: `Open a page of the My Magic UW app in its window and bring it to the front. page is one of ${PAGES.join(", ")}. course needs courseId; item and prep need itemId (an id a read tool returned).`,
    inputSchema: schema(openPageArgs),
  },
  {
    name: "open_in_canvas",
    description: "Open a saved item or course in Canvas in the student's browser, using the link saved with it. Pass itemId or courseId from a read tool; never a URL.",
    inputSchema: schema(z.object({ itemId: id.optional(), courseId: id.optional() }).strict()),
  },
  {
    name: "show_flashcards",
    description: "Make (or reuse) flashcards from a saved item with the app's checked-quote cards generator, then open them.",
    inputSchema: schema(itemArgs),
  },
  {
    name: "start_practice_quiz",
    description: "Make (or reuse) a practice quiz from a saved item with the app's generator, then open it.",
    inputSchema: schema(itemArgs),
  },
  {
    name: "prep_assessment",
    description: "Prepare study material for an assessment (exam, quiz, assignment) from its saved sources, then open its prep space.",
    inputSchema: schema(itemArgs),
  },
];
export const CONTROL_TOOL_NAMES = CONTROL_TOOLS.map((t) => t.name);

export class ControlRefused extends Error {}

export function createControlTools(store: Store, credentials: { clientId: string; token: string }, port: AppControlPort, now = () => new Date()) {
  const session = () => openSession(store, credentials, { now });
  function item(itemId: string) {
    const s = session();
    const r = s.resources().find((x) => x.id === itemId);
    if (!r) throw new ControlRefused("That item isn't available: it may be in a course that isn't included or a kind of data that isn't shared.");
    return { s, r, accountScope: s.sourceMap.get(r.sourceId)!.accountScope };
  }
  function course(courseId: string) {
    const s = session();
    const r = s.resources().find((x) => x.courseId === courseId);
    if (!r) throw new ControlRefused("That course isn't included in My Magic UW.");
    const courseRecord = s.resources().find((x) => x.courseId === courseId && x.kind === "course") ?? r;
    return { s, r: courseRecord, accountScope: s.sourceMap.get(r.sourceId)!.accountScope };
  }
  function receipt(tool: string, selected: Resource[], result: unknown) {
    store.addReceipt({
      id: randomUUID(),
      recipient: "claude",
      purpose: `Chat control ${tool}`,
      categories: [...new Set(selected.flatMap(contentCategories))],
      resourceIds: selected.map((r) => r.id),
      characters: JSON.stringify(result).length,
      status: "sent",
      createdAt: now().toISOString(),
    });
  }
  /** The stored link, only on the Canvas host (a sample source opens its own sample link). */
  function canvasUrl(r: Resource): string {
    const fixture = store.sources().find((s) => s.id === r.sourceId)?.kind === "fixture";
    let url: URL;
    try {
      url = new URL(r.url);
    } catch {
      throw new ControlRefused("This record has no saved Canvas link.");
    }
    if (url.protocol !== "https:" || url.username || url.password || (!CANVAS_HOSTS.has(url.host.toLowerCase()) && !fixture))
      throw new ControlRefused("This record's saved link isn't a Canvas link, so it wasn't opened.");
    return url.toString();
  }
  const packOutcome = (v: unknown) => {
    const o = v as { status?: unknown; message?: unknown; cached?: unknown } | null;
    return { status: typeof o?.status === "string" ? o.status : "unknown", message: typeof o?.message === "string" ? o.message : "", cached: o?.cached === true };
  };

  async function call(name: string, raw: unknown): Promise<unknown> {
    switch (name) {
      case "open_page": {
        const a = openPageArgs.parse(raw ?? {});
        if (a.page === "course") {
          if (!a.courseId) throw new ControlRefused("The course page needs a courseId.");
          const c = course(a.courseId);
          const opened = await port.navigate({ page: "course", courseId: a.courseId, accountScope: c.accountScope });
          const result = { opened, page: "course", course: c.r.courseName };
          receipt(name, [c.r], result);
          return result;
        }
        if (a.page === "item" || a.page === "prep") {
          if (!a.itemId) throw new ControlRefused(`The ${a.page} page needs an itemId.`);
          const i = item(a.itemId);
          const opened = await port.navigate({ page: a.page, courseId: i.r.courseId, accountScope: i.accountScope, resourceId: i.r.id });
          const result = { opened, page: a.page, title: i.r.title };
          receipt(name, [i.r], result);
          return result;
        }
        const opened = await port.navigate({ page: a.page });
        const result = { opened, page: a.page };
        receipt(name, [], result);
        return result;
      }
      case "open_in_canvas": {
        const a = canvasArgs.parse(raw ?? {});
        const target = a.itemId ? item(a.itemId).r : course(a.courseId!).r;
        const url = canvasUrl(target);
        await port.openExternal(url);
        const result = { opened: true, title: target.title, course: target.courseName };
        receipt(name, [target], result);
        return result;
      }
      case "show_flashcards":
      case "start_practice_quiz":
      case "prep_assessment": {
        const a = itemArgs.parse(raw ?? {});
        const i = item(a.itemId);
        const [pack, scope, action]: [string, PackScope, "cards" | "quiz" | "guide"] =
          name === "show_flashcards"
            ? ["cards", { courseId: i.r.courseId, resourceIds: [i.r.id] }, "cards"]
            : name === "start_practice_quiz"
              ? ["quiz", { courseId: i.r.courseId, resourceIds: [i.r.id] }, "quiz"]
              : [studyPrepPackName(["guide", "cards", "quiz"]), { courseId: i.r.courseId, assessmentId: i.r.id }, "guide"];
        const made = packOutcome(await port.pack(pack, scope));
        const opened = await port.navigate({ page: "prep", courseId: i.r.courseId, accountScope: i.accountScope, resourceId: i.r.id, action });
        const result = { ...made, opened, title: i.r.title };
        receipt(name, [i.r], result);
        return result;
      }
      default:
        throw new Error("Unknown tool.");
    }
  }
  return { list: CONTROL_TOOLS, call };
}
