/**
 * The target schema every side populates, and the gold's row shapes. One definition: the prompt
 * shows TARGET_SQL verbatim, the runner pre-creates it in each agent's empty database, our exporter
 * writes it, and the scorer reads it. Canvas IDs are text; instants are ISO 8601 UTC.
 */
import { DatabaseSync } from "node:sqlite";

export const TARGET_SQL = `CREATE TABLE courses (
  id TEXT PRIMARY KEY,            -- Canvas course id
  name TEXT NOT NULL,
  course_code TEXT,
  term TEXT,                      -- the term's name as Canvas shows it
  is_current INTEGER NOT NULL CHECK (is_current IN (0, 1))
);
CREATE TABLE modules (
  id TEXT PRIMARY KEY,            -- Canvas module id
  course_id TEXT NOT NULL,
  name TEXT NOT NULL,
  position INTEGER
);
CREATE TABLE module_items (
  id TEXT PRIMARY KEY,            -- Canvas module item id
  module_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  title TEXT NOT NULL,
  type TEXT NOT NULL,             -- Canvas item type: Page, File, Assignment, Quiz, Discussion, ExternalUrl, ExternalTool, SubHeader
  content_id TEXT,                -- the linked assignment, quiz, file or discussion id, when there is one
  page_url TEXT,                  -- the page's url slug, for Page items
  position INTEGER
);
CREATE TABLE assignment_groups (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  name TEXT NOT NULL,
  weight REAL                     -- percent of the final grade, when the course weights groups
);
CREATE TABLE assignments (
  id TEXT PRIMARY KEY,            -- Canvas assignment id (graded quizzes and discussions have one too)
  course_id TEXT NOT NULL,
  name TEXT NOT NULL,
  due_at TEXT,                    -- ISO 8601 UTC, e.g. 2026-10-02T04:59:00Z; NULL when undated
  points_possible REAL,
  assignment_group_id TEXT,
  description TEXT                -- plain text of the description
);
CREATE TABLE pages (
  course_id TEXT NOT NULL,
  url TEXT NOT NULL,              -- the page's url slug, as in /courses/<id>/pages/<slug>
  title TEXT NOT NULL,
  updated_at TEXT,
  body_text TEXT,                 -- plain text of the page body
  PRIMARY KEY (course_id, url)
);
CREATE TABLE files (
  id TEXT PRIMARY KEY,            -- Canvas file id
  course_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  content_type TEXT,
  size INTEGER,
  updated_at TEXT,
  text TEXT                       -- the document's extracted text (PDF, DOCX, PPTX, ...)
);
CREATE TABLE syllabus (
  course_id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('syllabus_body', 'page', 'file')),
  text TEXT NOT NULL
);`;

export interface CourseRow { id: string; name: string; course_code: string | null; term: string | null; is_current: number }
export interface ModuleRow { id: string; course_id: string; name: string; position: number | null }
export interface ItemRow {
  id: string; module_id: string; course_id: string; title: string; type: string;
  content_id: string | null; page_url: string | null; position: number | null;
}
export interface GroupRow { id: string; course_id: string; name: string; weight: number | null }
export interface AssignmentRow {
  id: string; course_id: string; name: string; due_at: string | null; points_possible: number | null;
  assignment_group_id: string | null; description: string | null;
}
export interface PageRow { course_id: string; url: string; title: string; updated_at: string | null; body_text: string | null }
export interface FileRow {
  id: string; course_id: string; display_name: string; content_type: string | null; size: number | null;
  updated_at: string | null; text: string | null;
}
export interface SyllabusRow { course_id: string; source: "syllabus_body" | "page" | "file"; text: string }
export interface TargetRows {
  courses: CourseRow[];
  modules: ModuleRow[];
  module_items: ItemRow[];
  assignment_groups: GroupRow[];
  assignments: AssignmentRow[];
  pages: PageRow[];
  files: FileRow[];
  syllabus: SyllabusRow[];
}
export const TABLES = [
  "courses", "modules", "module_items", "assignment_groups", "assignments", "pages", "files", "syllabus",
] as const satisfies readonly (keyof TargetRows)[];

/** Creates an empty target database (the runner does this before an agent starts). */
export function createTargetDb(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(TARGET_SQL);
  } finally {
    db.close();
  }
}

/** Writes rows into a fresh target database (our exporter and the fake agent). */
export function writeTargetDb(path: string, rows: TargetRows): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(TARGET_SQL);
    db.exec("BEGIN");
    for (const table of TABLES) {
      const list = rows[table] as unknown as Record<string, unknown>[];
      if (!list.length) continue;
      const columns = Object.keys(list[0]!);
      const insert = db.prepare(
        `INSERT OR REPLACE INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
      );
      for (const row of list) insert.run(...columns.map((c) => sqlValue(row[c])));
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}
function sqlValue(value: unknown): string | number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return JSON.stringify(value);
}

const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Reads whatever an agent left, tolerating a missing table (it scores as empty) but not renamed
 * columns: the schema was given verbatim and pre-created. Opened read-only; never modified.
 */
export function readTargetDb(path: string): { rows: TargetRows; problems: string[] } {
  const problems: string[] = [];
  const rows: TargetRows = {
    courses: [], modules: [], module_items: [], assignment_groups: [], assignments: [], pages: [], files: [], syllabus: [],
  };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const all = (table: string): Record<string, unknown>[] => {
      try {
        return db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
      } catch (error) {
        problems.push(`${table}: ${error instanceof Error ? error.message.slice(0, 120) : "unreadable"}`);
        return [];
      }
    };
    rows.courses = all("courses").map((r) => ({
      id: String(r.id), name: String(r.name ?? ""), course_code: text(r.course_code), term: text(r.term),
      is_current: Number(r.is_current) === 1 ? 1 : 0,
    }));
    rows.modules = all("modules").map((r) => ({
      id: String(r.id), course_id: String(r.course_id), name: String(r.name ?? ""), position: num(r.position),
    }));
    rows.module_items = all("module_items").map((r) => ({
      id: String(r.id), module_id: String(r.module_id), course_id: String(r.course_id), title: String(r.title ?? ""),
      type: String(r.type ?? ""), content_id: text(r.content_id), page_url: text(r.page_url), position: num(r.position),
    }));
    rows.assignment_groups = all("assignment_groups").map((r) => ({
      id: String(r.id), course_id: String(r.course_id), name: String(r.name ?? ""), weight: num(r.weight),
    }));
    rows.assignments = all("assignments").map((r) => ({
      id: String(r.id), course_id: String(r.course_id), name: String(r.name ?? ""), due_at: text(r.due_at),
      points_possible: num(r.points_possible), assignment_group_id: text(r.assignment_group_id), description: text(r.description),
    }));
    rows.pages = all("pages").map((r) => ({
      course_id: String(r.course_id), url: String(r.url), title: String(r.title ?? ""), updated_at: text(r.updated_at),
      body_text: text(r.body_text),
    }));
    rows.files = all("files").map((r) => ({
      id: String(r.id), course_id: String(r.course_id), display_name: String(r.display_name ?? ""),
      content_type: text(r.content_type), size: num(r.size), updated_at: text(r.updated_at), text: text(r.text),
    }));
    rows.syllabus = all("syllabus").map((r) => ({
      course_id: String(r.course_id),
      source: (["syllabus_body", "page", "file"].includes(String(r.source)) ? String(r.source) : "syllabus_body") as SyllabusRow["source"],
      text: String(r.text ?? ""),
    }));
  } finally {
    db.close();
  }
  return { rows, problems };
}

/** A consistent copy of a database another process is writing (WAL-safe): VACUUM INTO. */
export function snapshotDb(source: string, target: string): void {
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
}
