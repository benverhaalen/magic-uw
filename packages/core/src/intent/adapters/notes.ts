/**
 * Session notes (#16, `notesActions` in packages/notes/src/actions.ts). Those actions are plain
 * objects over raw strings (`courseRef`, `when`, `material`, `text`, `title`, `template`) that
 * resolve through a `NotesActionContext`. This adapter maps the router's code-resolved slots onto
 * those names, validates them with the action's own `argsSchema`, and hands the action our
 * resolvers, so a course or date the router can't resolve comes back as a clarification.
 * Nothing here imports the notes package: the worker passes the module once it is on main.
 */
import { z } from "zod";
import { baseArgs } from "../action-args";
import { resolveDate } from "../dates";
import type { AnyAction } from "../registry";
import type { ActionContext, ResolvedArgs, SlotName } from "../types";

type Resolved<T> = ({ status: "resolved" } & T) | { status: "needs_clarification"; message: string; candidates: { id: string; label: string }[] };
/** The notes seam the actions call (core's `notes` handler plus a session lookup). */
export interface NotesSeam {
  handle(request: unknown, signal?: AbortSignal): Promise<unknown>;
  sessionOn(courseId: string, date: string, type?: string): { id: string } | null;
}
interface NotesPlainAction {
  name: string;
  description: string;
  argsSchema: z.ZodType;
  examples?: readonly string[];
  patterns?: readonly RegExp[];
  run(args: never, ctx: unknown): Promise<unknown>;
}
function isNotesAction(v: unknown): v is NotesPlainAction {
  const a = v as Partial<NotesPlainAction> | null;
  return !!a && typeof a.name === "string" && typeof a.description === "string" && typeof a.run === "function" && a.argsSchema instanceof z.ZodType;
}
const shapeKeys = (schema: z.ZodType): string[] => (schema instanceof z.ZodObject ? Object.keys(schema.shape) : []);

/** Their argument names → the router's slot vocabulary (what the catalogue lists and the model fills). */
const SLOT_OF: Record<string, SlotName> = { courseRef: "course", when: "date", text: "query", title: "query", template: "query", material: "query" };
const FIRST_GROUP = ["title", "template", "material"];

function argsFor(action: NotesPlainAction, a: ResolvedArgs): Record<string, unknown> {
  const keys = shapeKeys(action.argsSchema);
  const groups = (() => {
    for (const p of action.patterns ?? []) {
      const m = new RegExp(p.source, p.flags.replace("g", "")).exec(a.text.trim());
      if (m) return m.slice(1).filter((g): g is string => typeof g === "string");
    }
    return [] as string[];
  })();
  const out: Record<string, unknown> = {};
  if (keys.includes("courseRef")) {
    const ref = a.course ? (a.course.code ?? a.course.name) : groups.length >= 2 && !keys.includes("text") ? groups[groups.length - 1] : undefined;
    if (ref) out.courseRef = ref;
  }
  if (keys.includes("when")) out.when = a.date ? a.date.from : /\bnext\b/i.test(a.text) ? "next" : "today";
  if (keys.includes("type")) {
    const t = /\b(lecture|discussion|lab)\b/i.exec(a.text)?.[1]?.toLowerCase();
    if (t) out.type = t;
  }
  if (keys.includes("text")) {
    const t = groups.length ? groups[groups.length - 1] : a.query;
    if (t) out.text = t.trim();
  }
  for (const k of FIRST_GROUP)
    if (keys.includes(k)) {
      const v = groups[0] ?? a.query;
      if (v) out[k] = k === "material" ? v.replace(/\s+in\s+[a-z &]+\s*\d{3}\s*$/i, "").trim() : v.trim();
    }
  return out;
}

function contextFor(ctx: ActionContext, notes: NotesSeam, currentNoteId: string | undefined) {
  const clarify = (message: string, candidates: { id: string; label: string }[] = []) => ({ status: "needs_clarification" as const, message, candidates });
  return {
    notes,
    currentNoteId,
    signal: ctx.signal,
    resolve: {
      async course(ref: string): Promise<Resolved<{ courseId: string; accountScope: string }>> {
        const r = ctx.resolve.course(ref);
        if (r.status === "ok") return { status: "resolved", courseId: r.value.courseId, accountScope: r.value.accountScope };
        const options = r.status === "ambiguous" ? r.options : ctx.resolve.courses();
        return clarify(r.status === "ambiguous" ? `Which course did you mean by "${ref}"?` : `I couldn't find a course called "${ref}".`, options.slice(0, 8).map((c) => ({ id: c.courseId, label: c.code ?? c.name })));
      },
      async when(text: string): Promise<Resolved<{ date: string | "next" }>> {
        if (/^next$/i.test(text.trim())) return { status: "resolved", date: "next" };
        if (/^\d{4}-\d{2}-\d{2}$/.test(text.trim())) return { status: "resolved", date: text.trim() };
        const d = resolveDate(text, ctx.now, ctx.timeZone);
        return d ? { status: "resolved", date: d.from } : clarify(`I couldn't read the date "${text}".`);
      },
      async material(ref: string, courseId?: string): Promise<Resolved<{ resourceId: string; courseId: string }>> {
        const courses = ctx.resolve.courses().filter((c) => !courseId || c.courseId === courseId);
        const found = ctx.store.searchPassages({ query: ref, courses: courses.map((c) => ({ accountScope: c.accountScope, courseId: c.courseId })), k: 10, mode: "lookup" });
        const byResource = [...new Map(found.hits.map((h) => [h.resourceId, h])).values()];
        if (byResource.length === 1) return { status: "resolved", resourceId: byResource[0]!.resourceId, courseId: byResource[0]!.courseId };
        return clarify(byResource.length ? `Which material did you mean by "${ref}"?` : `I couldn't find "${ref}" in your materials.`, byResource.slice(0, 5).map((h) => ({ id: h.resourceId, label: h.title })));
      },
    },
  };
}

/** The notes module's `notesActions` as registry actions; empty when the module or seam is absent. */
export function fromNotes(mod: unknown, notes: NotesSeam | undefined): AnyAction[] {
  const list = (mod as { notesActions?: unknown } | undefined)?.notesActions;
  if (!notes || !Array.isArray(list)) return [];
  return list.filter(isNotesAction).map((action): AnyAction => {
    const slots: AnyAction["slots"] = {};
    for (const k of shapeKeys(action.argsSchema)) if (SLOT_OF[k]) slots[SLOT_OF[k]] = "optional";
    return {
      name: action.name,
      description: action.description,
      slots,
      argsSchema: baseArgs,
      examples: [...(action.examples ?? [])],
      patterns: (action.patterns ?? []).map((p) => new RegExp(p.source, p.flags.replace("g", ""))),
      matchOn: "raw",
      async run(a, ctx) {
        const parsed = action.argsSchema.safeParse(argsFor(action, a));
        if (!parsed.success) return { op: action.name, status: "needs_clarification", message: "I need a bit more detail for that note.", candidates: [] };
        return action.run(parsed.data as never, contextFor(ctx, notes, ctx.request.noteId));
      },
    };
  });
}
