/**
 * v11 "notes" (v10 is reserved for another lane): session notes (packages/notes). Additive: new tables only, nothing existing changes.
 * A note belongs to a course and, usually, one scheduled session; its content lives in versions
 * (the last N kept, plus any version kept for a sync conflict). Purge deletes every table here
 * through the generic purge order; the note's passage-backed resource goes with the resources.
 * IF NOT EXISTS: a file whose version was rolled back below 11 may still hold these tables.
 */
export const NOTES_V11 = `
CREATE TABLE IF NOT EXISTS notes (
 id TEXT PRIMARY KEY,
 account_scope TEXT NOT NULL, course_id TEXT NOT NULL,
 session_id TEXT, session_json TEXT,
 session_date TEXT, session_type TEXT,
 module_id TEXT, module_name TEXT,
 title TEXT NOT NULL, template TEXT NOT NULL, template_reason TEXT NOT NULL,
 state TEXT NOT NULL CHECK (state IN ('untouched','edited')),
 revision INTEGER NOT NULL, scaffold_hash TEXT,
 scheduled INTEGER NOT NULL DEFAULT 1,
 conflict_version INTEGER,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, edited_at TEXT,
 UNIQUE (account_scope, course_id, session_id)
);
CREATE INDEX IF NOT EXISTS notes_course ON notes(account_scope, course_id, session_date);
CREATE TABLE IF NOT EXISTS note_versions (
 note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
 version INTEGER NOT NULL, blocks TEXT NOT NULL, origin TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY (note_id, version)
);
CREATE TABLE IF NOT EXISTS note_links (
 note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
 resource_id TEXT NOT NULL, role TEXT NOT NULL, reason TEXT NOT NULL,
 PRIMARY KEY (note_id, resource_id)
);
CREATE TABLE IF NOT EXISTS note_template_choices (
 account_scope TEXT NOT NULL, course_id TEXT NOT NULL, session_type TEXT NOT NULL, template TEXT NOT NULL,
 PRIMARY KEY (account_scope, course_id, session_type)
);
CREATE TABLE IF NOT EXISTS note_suggestions (
 id TEXT PRIMARY KEY, note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
 block_id TEXT NOT NULL, text TEXT NOT NULL, resource_id TEXT NOT NULL, quote TEXT NOT NULL,
 status TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS note_suggestions_note ON note_suggestions(note_id);
CREATE TABLE IF NOT EXISTS note_remotes (
 note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
 provider TEXT NOT NULL, remote_id TEXT NOT NULL, web_url TEXT, etag TEXT, modified_time TEXT,
 synced_version INTEGER NOT NULL, synced_at TEXT NOT NULL, status TEXT NOT NULL, error TEXT,
 PRIMARY KEY (note_id, provider)
);
CREATE TABLE IF NOT EXISTS note_sync_settings (
 provider TEXT PRIMARY KEY, enabled INTEGER NOT NULL, enabled_at TEXT, last_check_at TEXT, message TEXT
);
`;
