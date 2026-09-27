// owner: notes. Session notes: typed blocks, the notes request channel and its result shapes.
// The renderer imports these; the worker's notes service (packages/notes) answers them.
import { z } from "zod";

const id = z.string().min(1).max(500);
const text = (max: number) => z.string().max(max);

export const noteTemplateIds = [
  "cornell",
  "worked-problem",
  "concept-code-pitfalls",
  "lab-notebook",
  "vocab-grammar",
  "reading-response",
  "discussion-prep",
  "case-method",
  "outline",
] as const;
export type NoteTemplateId = (typeof noteTemplateIds)[number];
export const noteTemplateIdSchema = z.enum(noteTemplateIds);

export const sessionTypes = ["lecture", "discussion", "lab", "other"] as const;
export type SessionType = (typeof sessionTypes)[number];

/** What a block holds; the scaffold fills the first four, the student writes the rest. */
export const noteBlockKinds = [
  "context",
  "sources",
  "terms",
  "due",
  "section",
  "cues",
  "summary",
  "problems",
  "code",
  "pitfalls",
  "vocabulary",
  "grammar",
  "procedure",
  "data",
  "questions",
] as const;
export type NoteBlockKind = (typeof noteBlockKinds)[number];

export const noteItemSchema = z
  .object({
    id,
    text: text(20000),
    /** A link to a source: a Canvas item (resourceId) or its https URL. */
    link: z
      .object({ title: text(500), url: z.string().url().max(4000), resourceId: id.optional() })
      .strict()
      .optional(),
    origin: z.enum(["scaffold", "student", "fill", "remote"]),
  })
  .strict();
export type NoteItem = z.infer<typeof noteItemSchema>;
export const noteBlockSchema = z
  .object({
    id,
    kind: z.enum(noteBlockKinds),
    heading: z.string().min(1).max(200),
    /** A one-line prompt the editor shows while the block is empty; never exported as content. */
    hint: text(300).optional(),
    items: z.array(noteItemSchema).max(2000),
  })
  .strict();
export type NoteBlock = z.infer<typeof noteBlockSchema>;
export const noteBlocksSchema = z.array(noteBlockSchema).max(100);

export type NoteState = "untouched" | "edited";
export type NoteSyncProvider = "microsoft" | "google";
export const noteSyncProviderSchema = z.enum(["microsoft", "google"]);

export interface NoteSessionRef {
  id: string;
  type: SessionType;
  date: string;
  startMinute: number | null;
  endMinute: number | null;
  title: string;
  section: string | null;
  location: string | null;
  origin: "enrollment" | "course_session" | "calendar";
  /** How code decided the session type (for example "LEC section only" or "calendar title"). */
  typeBasis: string;
}
export interface NoteSummary {
  id: string;
  courseId: string;
  accountScope: string;
  title: string;
  sessionId: string | null;
  sessionType: SessionType | null;
  date: string | null;
  moduleName: string | null;
  template: NoteTemplateId;
  state: NoteState;
  /** synced: at least one provider holds this version; conflict: both sides changed (see versions). */
  sync: "local" | "synced" | "pending" | "conflict";
  revision: number;
  updatedAt: string;
  editedAt: string | null;
  preview: string;
  /** false once the schedule no longer lists the session; the note is kept. */
  scheduled: boolean;
}
export interface NoteVersionSummary {
  version: number;
  origin: "scaffold" | "student" | "remote" | "fill" | "template";
  createdAt: string;
  /** A version kept on purpose: local edits that were not yet synced when the remote changed. */
  conflict: boolean;
}
export interface NoteSuggestion {
  id: string;
  blockId: string;
  text: string;
  resourceId: string;
  quote: string;
  status: "pending" | "accepted" | "dismissed";
}
export interface NoteRemoteState {
  provider: NoteSyncProvider;
  webUrl: string | null;
  syncedVersion: number | null;
  syncedAt: string | null;
  status: "synced" | "pending" | "conflict" | "error";
  error: string | null;
}
export interface NoteDetail extends NoteSummary {
  blocks: NoteBlock[];
  session: NoteSessionRef | null;
  versions: NoteVersionSummary[];
  suggestions: NoteSuggestion[];
  remotes: NoteRemoteState[];
  /** Why the template was chosen (code's rule), or "chosen by you". */
  templateReason: string;
}
export interface NoteTreeSession {
  session: NoteSessionRef;
  note: NoteSummary | null;
}
export interface NoteTree {
  courseId: string;
  accountScope: string | null;
  courseName: string | null;
  modules: { moduleId: string | null; moduleName: string | null; sessions: NoteTreeSession[] }[];
  /** Notes outside any session (made with "new note"). */
  loose: NoteSummary[];
}
export interface NoteTemplateInfo {
  id: NoteTemplateId;
  name: string;
  description: string;
  blocks: { kind: NoteBlockKind; heading: string; hint: string }[];
}
export interface NotesSyncStatus {
  providers: {
    provider: NoteSyncProvider;
    enabled: boolean;
    connected: boolean;
    enabledAt: string | null;
    lastCheckAt: string | null;
    notes: number;
    conflicts: number;
    errors: number;
    message: string | null;
  }[];
}

/** A cloud-sync folder found on disk (OneDrive, Google Drive, iCloud): zero setup, no sign-in. */
export interface DetectedLocalFolder {
  id: string;
  label: string;
  path: string;
}
export interface LocalFolderStatus {
  /** The folder the student picked, or null when notes aren't saved to a local folder. */
  folder: string | null;
  folders: DetectedLocalFolder[];
  lastError: string | null;
}

const notesOp = <T extends string, S extends z.ZodRawShape>(op: T, shape: S) =>
  z.object({ op: z.literal(op), ...shape }).strict();
export const notesRequestSchema = z.discriminatedUnion("op", [
  notesOp("notes.tree", { courseId: id, accountScope: id.optional() }),
  notesOp("notes.recent", { courseId: id, limit: z.number().int().min(1).max(20).default(5) }),
  notesOp("notes.open", { sessionId: id.optional(), noteId: id.optional() }),
  notesOp("notes.save", { noteId: id, blocks: noteBlocksSchema, revision: z.number().int().min(1) }),
  notesOp("notes.setTemplate", { noteId: id, template: noteTemplateIdSchema }),
  notesOp("notes.fill", { noteId: id, resourceIds: z.array(id).max(10).optional() }),
  notesOp("notes.suggestion", { noteId: id, suggestionId: id, action: z.enum(["accept", "dismiss"]) }),
  notesOp("notes.create", { courseId: id, accountScope: id.optional(), title: z.string().trim().min(1).max(200) }),
  notesOp("notes.append", { noteId: id, text: z.string().trim().min(1).max(20000) }),
  notesOp("notes.version", { noteId: id, version: z.number().int().min(1) }),
  notesOp("notes.templates", {}),
  notesOp("notes.sync.enable", { provider: noteSyncProviderSchema }),
  notesOp("notes.sync.disable", { provider: noteSyncProviderSchema }),
  notesOp("notes.sync.status", {}),
  /** The student asks for this note in Word or Google Docs: the only way a remote file is created. */
  notesOp("notes.sync.export", { noteId: id, provider: noteSyncProviderSchema }),
  /** OneDrive, Google Drive or iCloud folders already syncing on this device: zero setup. */
  notesOp("notes.localFolders.detect", {}),
  notesOp("notes.localFolders.status", {}),
  notesOp("notes.localFolders.choose", { folder: z.string().max(1000).nullable() }),
]);
export type NotesRequest = z.infer<typeof notesRequestSchema>;

export type NotesFailure =
  | "not_found"
  | "stale_revision"
  | "not_connected"
  | "sync_off"
  | "blocked"
  | "no_client"
  | "empty"
  | "failed"
  | "needs_clarification"
  | "not_built";
export type NotesResult =
  | { op: "notes.tree"; status: "ok"; tree: NoteTree }
  | { op: "notes.recent"; status: "ok"; notes: NoteSummary[] }
  | {
      op: "notes.open" | "notes.save" | "notes.setTemplate" | "notes.suggestion" | "notes.create" | "notes.append" | "notes.version";
      status: "ok";
      note: NoteDetail;
      created?: boolean;
    }
  | {
      op: "notes.fill";
      status: "ok";
      note: NoteDetail;
      suggestions: NoteSuggestion[];
      cached: boolean;
      tokens: { in: number; cached: number; out: number };
      dropped: number;
      receiptIds: string[];
    }
  | { op: "notes.templates"; status: "ok"; templates: NoteTemplateInfo[] }
  | { op: "notes.sync.enable" | "notes.sync.disable" | "notes.sync.status"; status: "ok"; sync: NotesSyncStatus }
  | { op: "notes.sync.export"; status: "ok"; webUrl: string; note: NoteDetail }
  | { op: "notes.localFolders.detect"; status: "ok"; folders: DetectedLocalFolder[] }
  | { op: "notes.localFolders.status" | "notes.localFolders.choose"; status: "ok"; local: LocalFolderStatus }
  | {
      op: NotesRequest["op"];
      status: NotesFailure;
      message: string;
      /** needs_clarification: what the student can pick from. */
      candidates?: { id: string; label: string }[];
      /** stale_revision: the current note, so the editor can merge. */
      note?: NoteDetail;
    };
// end owner: notes
