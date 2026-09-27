/**
 * The notes repository over the workspace's SQLite connection (schema v11, NOTES_V11). Storage
 * builds it with its own prepared-statement cache and transaction, like the learning store.
 */
import type { StatementSync } from "node:sqlite";
import type {
  NoteBlock,
  NoteSessionRef,
  NoteState,
  NoteSuggestion,
  NoteSyncProvider,
  NoteTemplateId,
  NoteVersionSummary,
  SessionType,
} from "../../contracts/src/notes";

type Row = Record<string, string | number | bigint | Uint8Array | null>;
type Prepare = (sql: string) => StatementSync;

/** Versions kept per note; a version kept for a sync conflict is never pruned. */
export const KEEP_VERSIONS = 20;

export interface NoteRecord {
  id: string;
  accountScope: string;
  courseId: string;
  sessionId: string | null;
  session: NoteSessionRef | null;
  sessionDate: string | null;
  sessionType: SessionType | null;
  moduleId: string | null;
  moduleName: string | null;
  title: string;
  template: NoteTemplateId;
  templateReason: string;
  state: NoteState;
  revision: number;
  scaffoldHash: string | null;
  scheduled: boolean;
  conflictVersion: number | null;
  createdAt: string;
  updatedAt: string;
  editedAt: string | null;
}
export type VersionOrigin = NoteVersionSummary["origin"];
export interface NoteRemoteRecord {
  noteId: string;
  provider: NoteSyncProvider;
  remoteId: string;
  webUrl: string | null;
  etag: string | null;
  modifiedTime: string | null;
  syncedVersion: number;
  syncedAt: string;
  status: "synced" | "pending" | "conflict" | "error";
  error: string | null;
}
export interface NoteSyncSetting {
  provider: NoteSyncProvider;
  enabled: boolean;
  enabledAt: string | null;
  lastCheckAt: string | null;
  message: string | null;
}
export type NotePatch = Partial<
  Pick<
    NoteRecord,
    | "title"
    | "template"
    | "templateReason"
    | "state"
    | "scaffoldHash"
    | "scheduled"
    | "conflictVersion"
    | "editedAt"
    | "session"
    | "sessionDate"
    | "sessionType"
    | "moduleId"
    | "moduleName"
  >
>;

const str = (v: Row[string]) => (v === null || v === undefined ? null : String(v));

function readNote(row: Row): NoteRecord {
  return {
    id: String(row.id),
    accountScope: String(row.account_scope),
    courseId: String(row.course_id),
    sessionId: str(row.session_id),
    session: row.session_json ? (JSON.parse(String(row.session_json)) as NoteSessionRef) : null,
    sessionDate: str(row.session_date),
    sessionType: str(row.session_type) as SessionType | null,
    moduleId: str(row.module_id),
    moduleName: str(row.module_name),
    title: String(row.title),
    template: String(row.template) as NoteTemplateId,
    templateReason: String(row.template_reason),
    state: String(row.state) as NoteState,
    revision: Number(row.revision),
    scaffoldHash: str(row.scaffold_hash),
    scheduled: Boolean(row.scheduled),
    conflictVersion: row.conflict_version === null ? null : Number(row.conflict_version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    editedAt: str(row.edited_at),
  };
}
const columns: Record<keyof NotePatch, string> = {
  title: "title",
  template: "template",
  templateReason: "template_reason",
  state: "state",
  scaffoldHash: "scaffold_hash",
  scheduled: "scheduled",
  conflictVersion: "conflict_version",
  editedAt: "edited_at",
  session: "session_json",
  sessionDate: "session_date",
  sessionType: "session_type",
  moduleId: "module_id",
  moduleName: "module_name",
};
function sqlValue(key: keyof NotePatch, value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (key === "session") return JSON.stringify(value);
  if (key === "scheduled") return value ? 1 : 0;
  return value as string | number;
}

export function createSqlNotesStore(prepare: Prepare, transaction: <T>(run: () => T) => T, now: () => string) {
  function note(id: string): NoteRecord | undefined {
    const row = prepare("SELECT * FROM notes WHERE id = ?").get(id) as Row | undefined;
    return row ? readNote(row) : undefined;
  }
  function patch(id: string, value: NotePatch, touch = true) {
    const keys = (Object.keys(value) as (keyof NotePatch)[]).filter((k) => value[k] !== undefined);
    if (!keys.length && !touch) return;
    const sets = keys.map((k) => `${columns[k]} = ?`);
    if (touch) sets.push("updated_at = ?");
    prepare(`UPDATE notes SET ${sets.join(", ")} WHERE id = ?`).run(
      ...keys.map((k) => sqlValue(k, value[k])),
      ...(touch ? [now()] : []),
      id,
    );
  }
  function prune(noteId: string) {
    const keep = note(noteId)?.conflictVersion ?? -1;
    prepare(
      `DELETE FROM note_versions WHERE note_id = ? AND version <> ? AND version NOT IN
       (SELECT version FROM note_versions WHERE note_id = ? ORDER BY version DESC LIMIT ?)`,
    ).run(noteId, keep, noteId, KEEP_VERSIONS);
  }
  return {
    note,
    noteBySession(accountScope: string, courseId: string, sessionId: string) {
      const row = prepare("SELECT * FROM notes WHERE account_scope = ? AND course_id = ? AND session_id = ?").get(
        accountScope,
        courseId,
        sessionId,
      ) as Row | undefined;
      return row ? readNote(row) : undefined;
    },
    notes(filter: { accountScope?: string; courseId?: string } = {}): NoteRecord[] {
      return (
        prepare(
          `SELECT * FROM notes WHERE (?1 IS NULL OR account_scope = ?1) AND (?2 IS NULL OR course_id = ?2)
           ORDER BY COALESCE(session_date, substr(created_at, 1, 10)), title, id`,
        ).all(filter.accountScope ?? null, filter.courseId ?? null) as Row[]
      ).map(readNote);
    },
    /** A new note with its first version (revision 1). */
    insert(value: Omit<NoteRecord, "revision" | "createdAt" | "updatedAt" | "conflictVersion">, blocks: NoteBlock[], origin: VersionOrigin) {
      const at = now();
      transaction(() => {
        prepare(
          `INSERT INTO notes (id,account_scope,course_id,session_id,session_json,session_date,session_type,module_id,module_name,
           title,template,template_reason,state,revision,scaffold_hash,scheduled,conflict_version,created_at,updated_at,edited_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,NULL,?,?,?)`,
        ).run(
          value.id,
          value.accountScope,
          value.courseId,
          value.sessionId,
          value.session ? JSON.stringify(value.session) : null,
          value.sessionDate,
          value.sessionType,
          value.moduleId,
          value.moduleName,
          value.title,
          value.template,
          value.templateReason,
          value.state,
          value.scaffoldHash,
          value.scheduled ? 1 : 0,
          at,
          at,
          value.editedAt,
        );
        prepare("INSERT INTO note_versions VALUES (?,1,?,?,?)").run(value.id, JSON.stringify(blocks), origin, at);
      });
      return note(value.id)!;
    },
    /** Appends a version and makes it current; returns the new revision. */
    addVersion(noteId: string, blocks: NoteBlock[], origin: VersionOrigin, value: NotePatch = {}): number {
      return transaction(() => {
        const current = note(noteId);
        if (!current) throw new Error("Note not found.");
        const revision = current.revision + 1;
        prepare("INSERT INTO note_versions VALUES (?,?,?,?,?)").run(noteId, revision, JSON.stringify(blocks), origin, now());
        prepare("UPDATE notes SET revision = ? WHERE id = ?").run(revision, noteId);
        patch(noteId, value);
        prune(noteId);
        return revision;
      });
    },
    patch,
    blocks(noteId: string, version?: number): NoteBlock[] | undefined {
      const row = prepare(
        `SELECT v.blocks FROM note_versions v JOIN notes n ON n.id = v.note_id
         WHERE v.note_id = ? AND v.version = COALESCE(?, n.revision)`,
      ).get(noteId, version ?? null) as Row | undefined;
      return row ? (JSON.parse(String(row.blocks)) as NoteBlock[]) : undefined;
    },
    versions(noteId: string): NoteVersionSummary[] {
      const keep = note(noteId)?.conflictVersion ?? null;
      return (
        prepare("SELECT version, origin, created_at FROM note_versions WHERE note_id = ? ORDER BY version DESC").all(noteId) as Row[]
      ).map((r) => ({
        version: Number(r.version),
        origin: String(r.origin) as VersionOrigin,
        createdAt: String(r.created_at),
        conflict: keep === Number(r.version),
      }));
    },
    setLinks(noteId: string, links: { resourceId: string; role: string; reason: string }[]) {
      transaction(() => {
        prepare("DELETE FROM note_links WHERE note_id = ?").run(noteId);
        for (const l of links)
          prepare("INSERT OR IGNORE INTO note_links VALUES (?,?,?,?)").run(noteId, l.resourceId, l.role, l.reason);
      });
    },
    links(noteId: string) {
      return (prepare("SELECT resource_id, role, reason FROM note_links WHERE note_id = ?").all(noteId) as Row[]).map((r) => ({
        resourceId: String(r.resource_id),
        role: String(r.role),
        reason: String(r.reason),
      }));
    },
    templateChoice(accountScope: string, courseId: string, sessionType: string): NoteTemplateId | undefined {
      const row = prepare(
        "SELECT template FROM note_template_choices WHERE account_scope = ? AND course_id = ? AND session_type = ?",
      ).get(accountScope, courseId, sessionType) as Row | undefined;
      return row ? (String(row.template) as NoteTemplateId) : undefined;
    },
    setTemplateChoice(accountScope: string, courseId: string, sessionType: string, template: NoteTemplateId) {
      prepare(
        `INSERT INTO note_template_choices VALUES (?,?,?,?)
         ON CONFLICT(account_scope, course_id, session_type) DO UPDATE SET template = excluded.template`,
      ).run(accountScope, courseId, sessionType, template);
    },
    addSuggestions(noteId: string, values: Omit<NoteSuggestion, "status">[]) {
      transaction(() => {
        for (const s of values)
          prepare("INSERT OR IGNORE INTO note_suggestions VALUES (?,?,?,?,?,?,'pending',?)").run(
            s.id,
            noteId,
            s.blockId,
            s.text,
            s.resourceId,
            s.quote,
            now(),
          );
      });
    },
    suggestions(noteId: string): NoteSuggestion[] {
      return (
        prepare("SELECT * FROM note_suggestions WHERE note_id = ? ORDER BY created_at, id").all(noteId) as Row[]
      ).map((r) => ({
        id: String(r.id),
        blockId: String(r.block_id),
        text: String(r.text),
        resourceId: String(r.resource_id),
        quote: String(r.quote),
        status: String(r.status) as NoteSuggestion["status"],
      }));
    },
    setSuggestionStatus(id: string, status: NoteSuggestion["status"]) {
      prepare("UPDATE note_suggestions SET status = ? WHERE id = ?").run(status, id);
    },
    remote(noteId: string, provider: NoteSyncProvider): NoteRemoteRecord | undefined {
      const row = prepare("SELECT * FROM note_remotes WHERE note_id = ? AND provider = ?").get(noteId, provider) as Row | undefined;
      return row ? readRemote(row) : undefined;
    },
    remotes(filter: { noteId?: string; provider?: NoteSyncProvider } = {}): NoteRemoteRecord[] {
      return (
        prepare("SELECT * FROM note_remotes WHERE (?1 IS NULL OR note_id = ?1) AND (?2 IS NULL OR provider = ?2) ORDER BY note_id").all(
          filter.noteId ?? null,
          filter.provider ?? null,
        ) as Row[]
      ).map(readRemote);
    },
    putRemote(value: NoteRemoteRecord) {
      prepare(
        `INSERT INTO note_remotes VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(note_id, provider) DO UPDATE SET remote_id=excluded.remote_id, web_url=excluded.web_url, etag=excluded.etag,
         modified_time=excluded.modified_time, synced_version=excluded.synced_version, synced_at=excluded.synced_at,
         status=excluded.status, error=excluded.error`,
      ).run(
        value.noteId,
        value.provider,
        value.remoteId,
        value.webUrl,
        value.etag,
        value.modifiedTime,
        value.syncedVersion,
        value.syncedAt,
        value.status,
        value.error,
      );
    },
    syncSetting(provider: NoteSyncProvider): NoteSyncSetting {
      const row = prepare("SELECT * FROM note_sync_settings WHERE provider = ?").get(provider) as Row | undefined;
      return {
        provider,
        enabled: Boolean(row?.enabled),
        enabledAt: row ? str(row.enabled_at) : null,
        lastCheckAt: row ? str(row.last_check_at) : null,
        message: row ? str(row.message) : null,
      };
    },
    setSyncSetting(value: NoteSyncSetting) {
      prepare(
        `INSERT INTO note_sync_settings VALUES (?,?,?,?,?) ON CONFLICT(provider) DO UPDATE SET enabled=excluded.enabled,
         enabled_at=excluded.enabled_at, last_check_at=excluded.last_check_at, message=excluded.message`,
      ).run(value.provider, value.enabled ? 1 : 0, value.enabledAt, value.lastCheckAt, value.message);
    },
    transaction,
  };
}
function readRemote(row: Row): NoteRemoteRecord {
  return {
    noteId: String(row.note_id),
    provider: String(row.provider) as NoteSyncProvider,
    remoteId: String(row.remote_id),
    webUrl: str(row.web_url),
    etag: str(row.etag),
    modifiedTime: str(row.modified_time),
    syncedVersion: Number(row.synced_version),
    syncedAt: String(row.synced_at),
    status: String(row.status) as NoteRemoteRecord["status"],
    error: str(row.error),
  };
}
export type SqlNotesStore = ReturnType<typeof createSqlNotesStore>;
