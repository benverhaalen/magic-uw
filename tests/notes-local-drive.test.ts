// The local-folder notes path: detecting OneDrive/Google Drive/iCloud on disk (fake env and
// home, real temp directories standing in for drive roots — never a real cloud folder), path
// sanitisation, hash-skip, the conflict copy, and never deleting a file this code didn't write.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, utimesSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NoteBlock } from "@magic/contracts";
import { detectCloudFolders, safeSegment, writeLocalNote, createLocalNotesDrive } from "../packages/notes/src/local-drive";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
const blocks = (text: string): NoteBlock[] => [{ id: "notes", kind: "section", heading: "Notes", items: [{ id: "n1", text, origin: "student" }] }];

// ---------------------------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------------------------
test("detection: OneDrive personal from %OneDrive%, and the default ~/OneDrive fallback", () => {
  const home = tempDir("magic-home-");
  const onedrive = join(home, "OneDrive-custom");
  mkdirSync(onedrive, { recursive: true });
  const viaEnv = detectCloudFolders({ platform: "win32", env: { OneDrive: onedrive }, home });
  assert.deepEqual(viaEnv.find((f) => f.id === "onedrive-personal"), { id: "onedrive-personal", label: "OneDrive", path: onedrive });

  const home2 = tempDir("magic-home-");
  mkdirSync(join(home2, "OneDrive"), { recursive: true });
  const viaDefault = detectCloudFolders({ platform: "win32", env: {}, home: home2 });
  assert.deepEqual(viaDefault.find((f) => f.id === "onedrive-personal"), { id: "onedrive-personal", label: "OneDrive", path: join(home2, "OneDrive") });

  const home3 = tempDir("magic-home-");
  assert.equal(detectCloudFolders({ platform: "win32", env: {}, home: home3 }).find((f) => f.id === "onedrive-personal"), undefined);
});

test("detection: OneDrive for school/work via %OneDriveCommercial%, else a 'OneDrive - *' folder (a UW account)", () => {
  const home = tempDir("magic-home-");
  const commercial = join(home, "OneDrive - Contoso");
  mkdirSync(commercial, { recursive: true });
  const viaEnv = detectCloudFolders({ platform: "win32", env: { OneDriveCommercial: commercial }, home });
  assert.deepEqual(viaEnv.find((f) => f.id === "onedrive-work"), { id: "onedrive-work", label: "OneDrive - Contoso", path: commercial });

  const home2 = tempDir("magic-home-");
  const uw = join(home2, "OneDrive - UW-Madison");
  mkdirSync(uw, { recursive: true });
  const viaFolderName = detectCloudFolders({ platform: "win32", env: {}, home: home2 });
  assert.deepEqual(viaFolderName.find((f) => f.id === "onedrive-work"), { id: "onedrive-work", label: "OneDrive - UW-Madison", path: uw });
});

test("detection: Google Drive for desktop on Windows, checked at each given drive root", () => {
  const home = tempDir("magic-home-");
  const rootA = tempDir("magic-drive-a-");
  const rootB = tempDir("magic-drive-b-");
  mkdirSync(join(rootB, "My Drive"), { recursive: true });
  const found = detectCloudFolders({ platform: "win32", env: {}, home, driveRoots: [rootA, rootB] });
  assert.deepEqual(found.find((f) => f.id === "google-drive"), { id: "google-drive", label: "Google Drive", path: join(rootB, "My Drive") });

  const noneFound = detectCloudFolders({ platform: "win32", env: {}, home, driveRoots: [rootA] });
  assert.equal(noneFound.find((f) => f.id === "google-drive"), undefined);
});

test("detection: Google Drive and iCloud on macOS, from the CloudStorage and Mobile Documents folders", () => {
  const home = tempDir("magic-home-");
  mkdirSync(join(home, "Library", "CloudStorage", "GoogleDrive-student@wisc.edu", "My Drive"), { recursive: true });
  mkdirSync(join(home, "Library", "Mobile Documents", "com~apple~CloudDocs"), { recursive: true });
  const found = detectCloudFolders({ platform: "darwin", env: {}, home });
  assert.deepEqual(found.find((f) => f.id === "google-drive"), {
    id: "google-drive",
    label: "Google Drive",
    path: join(home, "Library", "CloudStorage", "GoogleDrive-student@wisc.edu", "My Drive"),
  });
  assert.deepEqual(found.find((f) => f.id === "icloud"), {
    id: "icloud",
    label: "iCloud Drive",
    path: join(home, "Library", "Mobile Documents", "com~apple~CloudDocs"),
  });
});

test("detection: iCloud is never offered on Windows, even if the folder exists", () => {
  const home = tempDir("magic-home-");
  mkdirSync(join(home, "Library", "Mobile Documents", "com~apple~CloudDocs"), { recursive: true });
  const found = detectCloudFolders({ platform: "win32", env: {}, home });
  assert.equal(found.find((f) => f.id === "icloud"), undefined);
});

test("detection: only the known locations are checked, nothing else in the home directory", () => {
  const home = tempDir("magic-home-");
  mkdirSync(join(home, "Dropbox"), { recursive: true });
  mkdirSync(join(home, "Some Random Synced Folder"), { recursive: true });
  const found = detectCloudFolders({ platform: "win32", env: {}, home, driveRoots: [] });
  assert.deepEqual(found, []);
});

// ---------------------------------------------------------------------------------------------
// Path sanitisation
// ---------------------------------------------------------------------------------------------
test("safeSegment: forbidden characters, trailing dots/spaces, and reserved Windows device names", () => {
  assert.equal(safeSegment('CS/400: Data "Structures" <2026>'), "CS 400 Data Structures 2026");
  assert.equal(safeSegment("Week 5 notes..."), "Week 5 notes");
  assert.equal(safeSegment("Week 5 notes   "), "Week 5 notes");
  assert.equal(safeSegment("CON"), "CON note");
  assert.equal(safeSegment("con"), "con note");
  assert.equal(safeSegment("COM1"), "COM1 note");
  assert.equal(safeSegment("LPT9"), "LPT9 note");
  assert.equal(safeSegment("PRN.docx"), "PRN.docx note");
  assert.equal(safeSegment(""), "Untitled");
  assert.equal(safeSegment('a|b*c?d:e"f<g>h\\i/j'), "a b c d e f g h i j");
  assert.equal(safeSegment("x".repeat(200), 10).length <= 10, true);
});

// ---------------------------------------------------------------------------------------------
// writeLocalNote: hash-skip, the conflict copy, and never deleting.
// ---------------------------------------------------------------------------------------------
test("writeLocalNote: writes once, skips an unchanged note (no filesystem write), re-exports a changed one", async () => {
  const base = tempDir("magic-drive-");
  let clock = 1_000_000;
  const now = () => clock;
  const first = await writeLocalNote({ baseFolder: base, course: "ENGL 177", title: "Lecture 5", blocks: blocks("first"), previous: null, now });
  assert.equal(first.result.status, "written");
  const path = join(base, "My Magic UW", "ENGL 177", "Lecture 5.docx");
  assert.equal(first.result.path, path);
  assert.ok(existsSync(path));
  const writtenBytes = readFileSync(path);

  clock += 1000;
  const skip = await writeLocalNote({ baseFolder: base, course: "ENGL 177", title: "Lecture 5", blocks: blocks("first"), previous: first.state, now });
  assert.equal(skip.result.status, "unchanged");
  assert.deepEqual(readFileSync(path), writtenBytes, "an unchanged note is never rewritten");

  clock += 1000;
  const changed = await writeLocalNote({ baseFolder: base, course: "ENGL 177", title: "Lecture 5", blocks: blocks("second"), previous: skip.state, now });
  assert.equal(changed.result.status, "written");
  assert.notDeepEqual(readFileSync(path), writtenBytes, "a changed note is re-exported");
});

test("writeLocalNote: a folder or note name with unsafe characters is sanitised on disk", async () => {
  const base = tempDir("magic-drive-");
  const { result } = await writeLocalNote({ baseFolder: base, course: 'CS/400: "Systems"', title: "Lab 2: I/O <redo>", blocks: blocks("x"), previous: null });
  assert.equal(result.path, join(base, "My Magic UW", "CS 400 Systems", "Lab 2 I O redo.docx"));
  assert.ok(existsSync(result.path));
});

test("writeLocalNote: the student's edit (newer mtime, different bytes) is kept; a '(from My Magic UW)' copy is written instead, and nothing is deleted", async () => {
  const base = tempDir("magic-drive-");
  let clock = 2_000_000;
  const now = () => clock;
  const first = await writeLocalNote({ baseFolder: base, course: "ENGL 177", title: "Lecture 5", blocks: blocks("first"), previous: null, now });
  const path = join(base, "My Magic UW", "ENGL 177", "Lecture 5.docx");
  const originalWrittenBytes = readFileSync(path);

  // The student edits the file in their own Word app; its mtime moves forward.
  clock += 60_000;
  writeFileSync(path, Buffer.concat([originalWrittenBytes, Buffer.from("student edit")]));
  utimesSync(path, new Date(clock), new Date(clock));

  clock += 1000;
  const conflict = await writeLocalNote({ baseFolder: base, course: "ENGL 177", title: "Lecture 5", blocks: blocks("second"), previous: first.state, now });
  assert.equal(conflict.result.status, "conflict");
  assert.ok(conflict.result.status === "conflict" && conflict.result.conflictPath.includes("(from My Magic UW)"));
  // The student's file is untouched, byte for byte.
  assert.deepEqual(readFileSync(path), Buffer.concat([originalWrittenBytes, Buffer.from("student edit")]));
  // The new version lives beside it, never overwriting or deleting the student's file.
  assert.ok(existsSync(conflict.result.status === "conflict" ? conflict.result.conflictPath : ""));
  const entries = readdirSync(join(base, "My Magic UW", "ENGL 177"));
  assert.equal(entries.length, 2, "both files are kept");
});

test("writeLocalNote: a file already there with no prior write (unknown provenance) is treated like a student's file, not overwritten", async () => {
  const base = tempDir("magic-drive-");
  const folder = join(base, "My Magic UW", "ENGL 177");
  mkdirSync(folder, { recursive: true });
  const path = join(folder, "Lecture 5.docx");
  writeFileSync(path, "not ours");
  const outcome = await writeLocalNote({ baseFolder: base, course: "ENGL 177", title: "Lecture 5", blocks: blocks("first"), previous: null });
  assert.equal(outcome.result.status, "conflict");
  assert.equal(readFileSync(path, "utf8"), "not ours");
});

test("writeLocalNote: an edit that doesn't move the file's mtime forward is treated as ours (no false conflicts from clock skew)", async () => {
  const base = tempDir("magic-drive-");
  let clock = 5_000_000;
  const now = () => clock;
  const first = await writeLocalNote({ baseFolder: base, course: "ENGL 177", title: "Lecture 5", blocks: blocks("first"), previous: null, now });
  const path = join(base, "My Magic UW", "ENGL 177", "Lecture 5.docx");
  const mtimeBefore = statSync(path).mtimeMs;
  // Not moved forward: same mtime as our own write (a copy or restore, not a live edit).
  utimesSync(path, new Date(mtimeBefore), new Date(mtimeBefore));
  clock += 1000;
  const outcome = await writeLocalNote({ baseFolder: base, course: "ENGL 177", title: "Lecture 5", blocks: blocks("second"), previous: first.state, now });
  assert.equal(outcome.result.status, "written");
});

// ---------------------------------------------------------------------------------------------
// createLocalNotesDrive: the service-facing port (choose, exportAll, persistence).
// ---------------------------------------------------------------------------------------------
test("createLocalNotesDrive: no folder chosen exports nothing; choosing one exports and persists across instances", async () => {
  const base = tempDir("magic-drive-");
  const statePath = join(tempDir("magic-state-"), "notes-local-drive.json");
  const drive = createLocalNotesDrive({ statePath, detect: () => [] });
  assert.equal(drive.folder(), null);
  let stats = await drive.exportAll([{ id: "note-1", course: "ENGL 177", title: "Lecture 5", blocks: blocks("a") }]);
  assert.deepEqual(stats, { written: 0, conflicts: 0, errors: 0 });
  assert.equal(existsSync(join(base, "My Magic UW")), false);

  drive.choose(base);
  stats = await drive.exportAll([{ id: "note-1", course: "ENGL 177", title: "Lecture 5", blocks: blocks("a") }]);
  assert.deepEqual(stats, { written: 1, conflicts: 0, errors: 0 });
  stats = await drive.exportAll([{ id: "note-1", course: "ENGL 177", title: "Lecture 5", blocks: blocks("a") }]);
  assert.deepEqual(stats, { written: 0, conflicts: 0, errors: 0 }, "unchanged on the second pass");

  // A fresh instance over the same state file remembers the folder and each note's hash.
  const reopened = createLocalNotesDrive({ statePath, detect: () => [] });
  assert.equal(reopened.folder(), base);
  const again = await reopened.exportAll([{ id: "note-1", course: "ENGL 177", title: "Lecture 5", blocks: blocks("a") }]);
  assert.deepEqual(again, { written: 0, conflicts: 0, errors: 0 }, "the note's last-written hash survived a restart");
});
