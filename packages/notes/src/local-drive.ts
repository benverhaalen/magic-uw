/**
 * Notes saved straight into a folder the student's own OneDrive, Google Drive or iCloud client
 * already syncs: zero setup, no sign-in, no network call from here (the folder's sync client
 * uploads it). One way only (app -> file): re-exporting a changed note never reads the file back,
 * a file this code didn't write is never deleted, and a file the student edited (its mtime newer
 * than our last write here, and its bytes differ from what we wrote) is kept — the new version is
 * saved next to it as "<title> (from My Magic UW).docx" instead of overwriting it.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import type { DetectedLocalFolder, NoteBlock } from "@magic/contracts";
import { noteToDocx } from "./docx";

export const LOCAL_APP_FOLDER = "My Magic UW";

// ---------------------------------------------------------------------------------------------
// Detection: known cloud-sync folder locations only, never a broader scan.
// ---------------------------------------------------------------------------------------------
export interface DriveDetectOptions {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
  /** Windows only: drive roots to probe for a Google Drive "My Drive" folder (default: real drive letters present on this machine). */
  driveRoots?: string[];
}

function isDirectory(path: string): boolean {
  try {
    return fs.statSync(path).isDirectory();
  } catch {
    return false;
  }
}
function listDirectory(path: string): string[] {
  try {
    return fs.readdirSync(path);
  } catch {
    return [];
  }
}
function defaultWindowsDriveRoots(): string[] {
  const roots: string[] = [];
  for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
    const root = `${letter}:\\`;
    if (isDirectory(root)) roots.push(root);
  }
  return roots;
}

/**
 * OneDrive personal (`%OneDrive%`, else `~/OneDrive`), OneDrive for school/work
 * (`%OneDriveCommercial%`, or a `OneDrive - *` folder in the home directory — a UW account syncs
 * as "OneDrive - UW-Madison"), Google Drive for desktop (a "My Drive" folder at a Windows drive
 * root, or a "GoogleDrive-*" folder under `~/Library/CloudStorage` holding "My Drive" on macOS), and iCloud Drive on macOS
 * (`~/Library/Mobile Documents/com~apple~CloudDocs`). Nothing beyond these known locations.
 */
export function detectCloudFolders(options: DriveDetectOptions): DetectedLocalFolder[] {
  const { platform, env, home } = options;
  const found: DetectedLocalFolder[] = [];

  const personal = env.OneDrive?.trim() || join(home, "OneDrive");
  if (isDirectory(personal)) found.push({ id: "onedrive-personal", label: "OneDrive", path: personal });

  const commercial = env.OneDriveCommercial?.trim();
  if (commercial && isDirectory(commercial)) {
    const name = commercial.split(/[\\/]/).filter(Boolean).pop() ?? "OneDrive (work/school)";
    found.push({ id: "onedrive-work", label: name, path: commercial });
  } else {
    const match = listDirectory(home).find((name) => /^OneDrive - .+/i.test(name) && isDirectory(join(home, name)));
    if (match) found.push({ id: "onedrive-work", label: match, path: join(home, match) });
  }

  if (platform === "win32") {
    const roots = options.driveRoots ?? defaultWindowsDriveRoots();
    for (const root of roots) {
      const candidate = join(root, "My Drive");
      if (isDirectory(candidate)) {
        found.push({ id: "google-drive", label: "Google Drive", path: candidate });
        break;
      }
    }
  } else if (platform === "darwin") {
    const cloudStorage = join(home, "Library", "CloudStorage");
    const match = listDirectory(cloudStorage).find(
      (name) => /^GoogleDrive-/.test(name) && isDirectory(join(cloudStorage, name, "My Drive")),
    );
    if (match) found.push({ id: "google-drive", label: "Google Drive", path: join(cloudStorage, match, "My Drive") });
  }

  if (platform === "darwin") {
    const icloud = join(home, "Library", "Mobile Documents", "com~apple~CloudDocs");
    if (isDirectory(icloud)) found.push({ id: "icloud", label: "iCloud Drive", path: icloud });
  }

  return found;
}

// ---------------------------------------------------------------------------------------------
// Path sanitisation: OneDrive and Google Drive both refuse some characters; Windows also refuses
// a handful of device names as a bare filename, with or without an extension.
// ---------------------------------------------------------------------------------------------
const RESERVED = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);
export function safeSegment(value: string, max = 120): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  let base = (cleaned || "Untitled").slice(0, max).replace(/[. ]+$/, "");
  if (!base) base = "Untitled";
  const stem = base.split(".")[0]!.toUpperCase();
  return RESERVED.has(stem) ? `${base} note` : base;
}

// ---------------------------------------------------------------------------------------------
// Writing one note. Pure with respect to the outside world except the filesystem calls in
// `baseFolder`; the caller keeps `previous` (the state after the last write) and persists what
// this returns.
// ---------------------------------------------------------------------------------------------
export interface LocalNoteState {
  /** sha256 of the note's title and blocks (not the .docx bytes, which the docx library doesn't
   * serialize deterministically run to run): whether a re-export is needed at all. */
  sourceHash: string;
  /** sha256 of the .docx bytes this code actually wrote last time: whether the file on disk still
   * holds them, so a student's edit in between is never mistaken for our own last write. */
  writtenHash: string;
  /** This process's clock at the moment of that write (ms since epoch). */
  writtenAtMs: number;
}
export type LocalWriteResult =
  | { status: "unchanged"; path: string }
  | { status: "written"; path: string }
  | { status: "conflict"; path: string; conflictPath: string; message: string };

export async function writeLocalNote(params: {
  baseFolder: string;
  course: string;
  title: string;
  blocks: NoteBlock[];
  previous: LocalNoteState | null;
  now?: () => number;
}): Promise<{ result: LocalWriteResult; state: LocalNoteState }> {
  const now = params.now ?? Date.now;
  const folder = join(params.baseFolder, LOCAL_APP_FOLDER, safeSegment(params.course));
  const fileName = `${safeSegment(params.title, 150)}.docx`;
  const filePath = join(folder, fileName);
  const sourceHash = createHash("sha256").update(JSON.stringify({ title: params.title, blocks: params.blocks })).digest("hex");
  if (params.previous && params.previous.sourceHash === sourceHash) {
    return { result: { status: "unchanged", path: filePath }, state: params.previous };
  }
  await fs.promises.mkdir(folder, { recursive: true });
  let existingBytes: Buffer | null = null;
  let existingMtimeMs = 0;
  try {
    existingBytes = await fs.promises.readFile(filePath);
    existingMtimeMs = (await fs.promises.stat(filePath)).mtimeMs;
  } catch {
    /* nothing there yet */
  }
  const bytes = await noteToDocx(params.title, params.blocks);
  if (existingBytes) {
    const existingHash = createHash("sha256").update(existingBytes).digest("hex");
    const isOurs = params.previous !== null && existingHash === params.previous.writtenHash;
    const editedSinceOurWrite = params.previous !== null && existingHash !== params.previous.writtenHash && existingMtimeMs > params.previous.writtenAtMs;
    // No prior write recorded but a file is already there: unknown provenance, so it's treated
    // the same as a student edit rather than assumed to be ours.
    if (!isOurs && (params.previous === null || editedSinceOurWrite)) {
      const conflictName = `${safeSegment(params.title, 130)} (from My Magic UW).docx`;
      const conflictPath = join(folder, conflictName);
      await fs.promises.writeFile(conflictPath, bytes);
      return {
        result: {
          status: "conflict",
          path: filePath,
          conflictPath,
          message: `You edited "${fileName}", so the new version was saved as "${conflictName}" next to it instead of overwriting your changes.`,
        },
        state: { sourceHash, writtenHash: createHash("sha256").update(bytes).digest("hex"), writtenAtMs: now() },
      };
    }
  }
  await fs.promises.writeFile(filePath, bytes);
  return { result: { status: "written", path: filePath }, state: { sourceHash, writtenHash: createHash("sha256").update(bytes).digest("hex"), writtenAtMs: now() } };
}

// ---------------------------------------------------------------------------------------------
// The service-facing port: detection, the student's choice, and exporting every edited note.
// State (the chosen folder, and each note's last-written hash/time) is a small JSON file beside
// the workspace database, not the SQLite store.
// ---------------------------------------------------------------------------------------------
export interface LocalNotesDriveItem {
  id: string;
  course: string;
  title: string;
  blocks: NoteBlock[];
}
export interface LocalNotesDrivePort {
  detect(): DetectedLocalFolder[];
  folder(): string | null;
  lastError(): string | null;
  choose(folder: string | null): void;
  exportAll(items: LocalNotesDriveItem[]): Promise<{ written: number; conflicts: number; errors: number }>;
}
interface PersistedLocalDriveState {
  folder: string | null;
  notes: Record<string, LocalNoteState>;
}
function loadPersisted(statePath: string): PersistedLocalDriveState {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as Partial<PersistedLocalDriveState>;
    return {
      folder: typeof parsed.folder === "string" ? parsed.folder : null,
      notes: parsed.notes && typeof parsed.notes === "object" ? (parsed.notes as Record<string, LocalNoteState>) : {},
    };
  } catch {
    return { folder: null, notes: {} };
  }
}
function savePersisted(statePath: string, state: PersistedLocalDriveState): void {
  try {
    fs.mkdirSync(dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state));
  } catch {
    /* the next export retries; nothing here is load-bearing for correctness */
  }
}

export function createLocalNotesDrive(options: { statePath: string; detect: () => DetectedLocalFolder[] }): LocalNotesDrivePort {
  let state = loadPersisted(options.statePath);
  let error: string | null = null;
  return {
    detect: options.detect,
    folder: () => state.folder,
    lastError: () => error,
    choose(folder) {
      state = { ...state, folder };
      savePersisted(options.statePath, state);
    },
    async exportAll(items) {
      const stats = { written: 0, conflicts: 0, errors: 0 };
      const folder = state.folder;
      if (!folder) return stats;
      let touched = false;
      for (const item of items) {
        try {
          const previous = state.notes[item.id] ?? null;
          const { result, state: nextState } = await writeLocalNote({ baseFolder: folder, course: item.course, title: item.title, blocks: item.blocks, previous });
          if (result.status !== "unchanged") {
            state.notes[item.id] = nextState;
            touched = true;
          }
          if (result.status === "written") stats.written++;
          if (result.status === "conflict") stats.conflicts++;
          error = null;
        } catch (e) {
          stats.errors++;
          error = e instanceof Error ? e.message.slice(0, 300) : "Saving a note to your folder failed.";
        }
      }
      if (touched) savePersisted(options.statePath, state);
      return stats;
    },
  };
}
