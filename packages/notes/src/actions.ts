/**
 * The notes actions for the shared intent router (Ctrl+K typed, Ctrl+Shift+Space dictation). Plain
 * objects: this file imports no router type. The router matches `patterns` (the code fast path)
 * or asks the student's AI for a typed intent, validates `argsSchema`, then calls `run`.
 * `courseRef`, `when` and `material` stay raw strings; `ctx.resolve` turns them into IDs and
 * dates (the router's job), and anything it can't resolve comes back as `needs_clarification`
 * with candidates; `run` never guesses. The assumed context is `NotesActionContext` below and in
 * docs/notes-setup.md.
 */
import { z } from "zod";
import type { NoteTemplateId, NotesRequest, NotesResult, SessionType } from "@magic/contracts";
import { noteTemplateIds } from "@magic/contracts";
import { TEMPLATES } from "./templates/index";

export type Resolved<T> = ({ status: "resolved" } & T) | { status: "needs_clarification"; message: string; candidates: { id: string; label: string }[] };
/** What `run` assumes the router passes in. */
export interface NotesActionContext {
  /** The notes seam: the same handler the `notes` command uses. */
  notes: {
    handle(request: NotesRequest, signal?: AbortSignal): Promise<NotesResult>;
    /** The course's session of that type on a local date, "today", or the next one ("next"). */
    sessionOn(courseId: string, date: string, type?: SessionType): { id: string } | null;
  };
  resolve: {
    /** "CS 400", "compsci400", "Programming III" → the course. */
    course(ref: string): Promise<Resolved<{ courseId: string; accountScope: string }>>;
    /** "today", "tomorrow", "Tuesday", "9/29", "next" → a local date, or "next" for the next session. */
    when(text: string, courseId: string): Promise<Resolved<{ date: string | "next" }>>;
    /** "the week 4 slides" → one material in the course (or any course when courseId is absent). */
    material(ref: string, courseId?: string): Promise<Resolved<{ resourceId: string; courseId: string }>>;
  };
  /** The note open in the UI, if any. */
  currentNoteId?: string;
  signal?: AbortSignal;
}
type Clarify = Extract<NotesResult, { status: "needs_clarification" }>;
const clarify = (op: NotesRequest["op"], message: string, candidates: { id: string; label: string }[] = []): Clarify =>
  ({ op, status: "needs_clarification", message, candidates }) as Clarify;
const sessionType = z.enum(["lecture", "discussion", "lab"]).default("lecture");

async function openFor(ctx: NotesActionContext, courseRef: string, when: string, type: SessionType): Promise<NotesResult> {
  const course = await ctx.resolve.course(courseRef);
  if (course.status !== "resolved") return clarify("notes.open", course.message, course.candidates);
  const day = await ctx.resolve.when(when, course.courseId);
  if (day.status !== "resolved") return clarify("notes.open", day.message, day.candidates);
  const session = ctx.notes.sessionOn(course.courseId, day.date, type);
  if (!session)
    return clarify("notes.open", `There's no ${type} for that course ${day.date === "next" ? "coming up" : `on ${day.date}`} in the schedule.`, [
      { id: "notes.new", label: "Make a separate note instead" },
    ]);
  return ctx.notes.handle({ op: "notes.open", sessionId: session.id }, ctx.signal);
}
/** The note to add to: the open note, else today's or the next session's note for the course. */
async function targetNote(ctx: NotesActionContext, courseRef: string | undefined, op: NotesRequest["op"]): Promise<string | Clarify> {
  if (ctx.currentNoteId && !courseRef) return ctx.currentNoteId;
  if (!courseRef) return clarify(op, "Which course's notes?");
  const course = await ctx.resolve.course(courseRef);
  if (course.status !== "resolved") return clarify(op, course.message, course.candidates);
  const session = ctx.notes.sessionOn(course.courseId, "today") ?? ctx.notes.sessionOn(course.courseId, "next");
  if (!session) return clarify(op, "That course has no session coming up in the schedule.", [{ id: "notes.new", label: "Make a separate note instead" }]);
  const opened = await ctx.notes.handle({ op: "notes.open", sessionId: session.id }, ctx.signal);
  return opened.status === "ok" && "note" in opened ? opened.note.id : clarify(op, "That session's note couldn't be opened.");
}
function templateByName(name: string): NoteTemplateId | null {
  const n = name.toLowerCase().replace(/[^a-z]+/g, " ").trim();
  const hits = noteTemplateIds.filter((id) => id.replace(/-/g, " ") === n || TEMPLATES[id].name.toLowerCase().replace(/[^a-z]+/g, " ").trim() === n);
  return hits.length === 1 ? hits[0]! : null;
}

export const notesActions = [
  {
    name: "notes.open",
    description: "Open or create the note for a class session",
    argsSchema: z.object({ courseRef: z.string().min(1).max(200), when: z.string().min(1).max(100), type: sessionType }),
    examples: ["notes for today's CS 400 lecture", "open my ECE 203 lab notes for Thursday", "notes for the next PHILOS 101 discussion"],
    patterns: [/^notes for (.+)$/i],
    run: (args: { courseRef: string; when: string; type: SessionType }, ctx: NotesActionContext) => openFor(ctx, args.courseRef, args.when, args.type),
  },
  {
    name: "notes.append",
    description: "Add a line to the current or next session's note",
    argsSchema: z.object({ courseRef: z.string().min(1).max(200).optional(), text: z.string().trim().min(1).max(20000) }),
    examples: ["add to my CS 400 notes: hash tables resize at load factor 0.75"],
    patterns: [/^add to my (.+?) notes?\s*:\s*(.+)$/is],
    run: async (args: { courseRef?: string; text: string }, ctx: NotesActionContext): Promise<NotesResult> => {
      const target = await targetNote(ctx, args.courseRef, "notes.append");
      return typeof target === "string" ? ctx.notes.handle({ op: "notes.append", noteId: target, text: args.text }, ctx.signal) : target;
    },
  },
  {
    name: "notes.fillFrom",
    description: "Suggest note bullets from one course material (one checked AI call; nothing is overwritten)",
    argsSchema: z.object({ material: z.string().min(1).max(300), courseRef: z.string().min(1).max(200).optional() }),
    examples: ["make notes from the week 4 slides", "make notes from Lecture 7 in ECE 203"],
    patterns: [/^make notes from (.+)$/i],
    run: async (args: { material: string; courseRef?: string }, ctx: NotesActionContext): Promise<NotesResult> => {
      let courseId: string | undefined;
      if (args.courseRef) {
        const course = await ctx.resolve.course(args.courseRef);
        if (course.status !== "resolved") return clarify("notes.fill", course.message, course.candidates);
        courseId = course.courseId;
      }
      const material = await ctx.resolve.material(args.material, courseId);
      if (material.status !== "resolved") return clarify("notes.fill", material.message, material.candidates);
      let noteId = ctx.currentNoteId;
      if (!noteId) {
        const session = ctx.notes.sessionOn(material.courseId, "today") ?? ctx.notes.sessionOn(material.courseId, "next");
        if (!session) return clarify("notes.fill", "Open a note first, or pick a course with a session coming up.");
        const opened = await ctx.notes.handle({ op: "notes.open", sessionId: session.id }, ctx.signal);
        if (opened.status !== "ok" || !("note" in opened)) return clarify("notes.fill", "That session's note couldn't be opened.");
        noteId = opened.note.id;
      }
      return ctx.notes.handle({ op: "notes.fill", noteId, resourceIds: [material.resourceId] }, ctx.signal);
    },
  },
  {
    name: "notes.new",
    description: "Make a separate note (not tied to a session) in a course",
    argsSchema: z.object({ title: z.string().trim().min(1).max(200), courseRef: z.string().min(1).max(200) }),
    examples: ["new note midterm review in MATH 234"],
    patterns: [/^new note (.+?) in (.+)$/i],
    run: async (args: { title: string; courseRef: string }, ctx: NotesActionContext): Promise<NotesResult> => {
      const course = await ctx.resolve.course(args.courseRef);
      if (course.status !== "resolved") return clarify("notes.create", course.message, course.candidates);
      return ctx.notes.handle({ op: "notes.create", courseId: course.courseId, accountScope: course.accountScope, title: args.title }, ctx.signal);
    },
  },
  {
    name: "notes.setTemplate",
    description: "Switch the open note's template (your content moves with it)",
    argsSchema: z.object({ template: z.string().min(1).max(100) }),
    examples: ["switch template to Cornell", "switch template to lab notebook"],
    patterns: [/^switch template to (.+)$/i],
    run: async (args: { template: string }, ctx: NotesActionContext): Promise<NotesResult> => {
      const template = templateByName(args.template);
      if (!template)
        return clarify(
          "notes.setTemplate",
          "Which template?",
          noteTemplateIds.map((id) => ({ id, label: TEMPLATES[id].name })),
        );
      if (!ctx.currentNoteId) return clarify("notes.setTemplate", "Open the note to switch first.");
      return ctx.notes.handle({ op: "notes.setTemplate", noteId: ctx.currentNoteId, template }, ctx.signal);
    },
  },
] as const;
export type NotesAction = (typeof notesActions)[number];
