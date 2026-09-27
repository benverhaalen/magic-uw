// Notes: sessions from the enrollment and calendar, batch scaffolds for the rolling window, edits,
// templates, passages, the v11 migration and purge. Synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, SCHEMA_VERSION } from "@magic/storage";
import { createCore } from "@magic/core";
import type { CaptureBatch, NoteBlock, NotesResult, PlanningCapture, ResourceInput } from "@magic/contracts";
import { createNotesService, createSessionsAdapter, rollingWindow, NOTE_URL } from "../packages/notes/src/index";

const NOW = new Date("2026-09-28T15:00:00Z"); // Monday 10:00 in Madison
const ACCT = "canvas-acct";
const PLAN = "uw-session:00000000-0000-4000-8000-000000000001";
const COURSE = "C400";
const res = (id: string, kind: ResourceInput["kind"], extra: Partial<ResourceInput> = {}): ResourceInput => ({
  externalId: id,
  kind,
  courseId: COURSE,
  courseName: "COMPSCI400: Programming III (001) FA26",
  title: id,
  url: `https://canvas.example.test/courses/${COURSE}/${id}`,
  text: "",
  deadlines: [],
  points: null,
  submitted: null,
  policy: { mode: "coaching", evidence: "Synthetic." },
  ...extra,
});
const batch = (id: string, kind: CaptureBatch["source"]["kind"], resources: ResourceInput[]): CaptureBatch => ({
  source: { id, kind, label: id, accountScope: ACCT, courseId: COURSE, scope: id },
  observedAt: "2026-09-27T12:00:00.000Z",
  complete: true,
  status: "ok",
  resources,
});
const HASH_TEXT = "A hash table maps keys to buckets. Load factor is entries divided by buckets. Resizing keeps lookups fast.";
const provenance = (kind: "enrollment_term" | "subjects", key: string) => ({
  sourceUrl: "https://enroll.wisc.edu/",
  observedAt: "2026-09-27T12:00:00.000Z",
  scope: { kind, key },
});
const planning = (kind: "enrollment_term" | "subjects", key: string, records: PlanningCapture["records"]): PlanningCapture => ({
  schemaVersion: 1,
  id: `cap-${kind}`,
  accountScope: PLAN,
  source: "uw_enroll",
  scope: { kind, key },
  sourceUrl: "https://enroll.wisc.edu/",
  observedAt: "2026-09-27T12:00:00.000Z",
  status: "complete",
  completeness: "complete",
  records,
  diagnostics: [],
});
const meeting = (days: number[], start: number, end: number) => ({
  kind: "class" as const,
  mode: "scheduled" as const,
  days,
  startMinute: start,
  endMinute: end,
  startDate: "2026-09-02",
  endDate: "2026-12-10",
  timezone: "America/Chicago" as const,
  location: "Synthetic Hall 1",
});
function enrollment(meetings = [meeting([1, 3, 5], 595, 645), meeting([3], 800, 850)]) {
  return planning("enrollment_term", "1272", [
    {
      id: "current:1272:12345",
      kind: "enrollment_package",
      provenance: provenance("enrollment_term", "1272"),
      courseKey: "uw:266:400",
      termCode: "1272",
      sections: ["LEC 001", "DIS 312"],
      status: "open",
      enrollmentState: "enrolled",
      meetings,
      meetingsComplete: true,
      seatsAvailable: null,
      capacity: null,
      waitlistCount: null,
      instructorNames: [],
    },
  ]);
}

function setup() {
  const store = createStore(":memory:", { now: () => NOW });
  store.ingest(
    batch("courses", "canvas", [
      res(COURSE, "course", {
        title: "COMPSCI400: Programming III (001) FA26",
        course: { courseCode: "FA26 COMPSCI 400 001", termName: "Fall 2026-2027", startAt: "2026-09-02T05:00:00Z", endAt: "2026-12-23T06:00:00Z" },
      }),
      res("Slides 9/28 Hashing.pdf", "material", { text: HASH_TEXT }),
      res("Week 5: Hashing", "material", { module: { id: "m5", position: 5 } }),
      res("Syllabus", "material", { text: "Course policies." }),
      res("P2 Hash table", "assignment", { dueAt: "2026-10-01T04:59:00Z", deadlines: [{ value: "2026-10-01T04:59:00Z", kind: "due", quote: "Due Sep 30, 11:59 PM", authority: "structured", scopeConfirmed: true }] }),
    ]),
  );
  store.ingest(
    batch("calendar", "calendar", [
      res("event-assignment-9", "event", { title: "P2 Hash table", calendar: { uid: "event-assignment-9", start: "2026-09-30T04:59:00Z", allDay: false } }),
      res("event-77", "event", { title: "Review lab", calendar: { uid: "event-calendar-event-77", start: "2026-09-29T19:00:00Z", end: "2026-09-29T20:50:00Z", allDay: false } }),
    ]),
  );
  store.ingestPlanning(
    planning("subjects", "registrar-subjects", [
      { id: "266", kind: "subject", code: "266", shortName: "COMP SCI", formalName: "Computer Sciences", aliases: ["COMPSCI"], provenance: provenance("subjects", "registrar-subjects") },
    ]),
  );
  store.ingestPlanning(enrollment());
  const slides = store.resources().find((r) => r.title.startsWith("Slides"))!;
  const textHash = store.passages(slides.id)[0]!.textHash;
  const at = HASH_TEXT.indexOf("Load factor");
  store.putMaterialFacts({ resourceId: slides.id, textHash, analyzerVersion: "t1", facts: [{ kind: "term", start: at, end: at + 11, value: "Load factor" }] });
  const notes = createNotesService({ store, now: () => NOW });
  const ask = async (request: Parameters<typeof notes.handle>[0]) => notes.handle(request);
  return { store, notes, ask, slides };
}
const ok = <T extends NotesResult["op"]>(r: NotesResult, op: T) => {
  assert.equal(r.status, "ok", "message" in r ? r.message : "");
  assert.equal(r.op, op);
  return r as Extract<NotesResult, { status: "ok" }> & { note?: never } as any;
};

test("sessions resolve from the enrollment's meetings and timed calendar events, never assignment events", () => {
  const { store } = setup();
  const port = createSessionsAdapter(store);
  const window = rollingWindow(NOW);
  assert.deepEqual(window, { from: "2026-09-28", to: "2026-10-11" });
  const sessions = port.sessions(COURSE, window);
  const count = (type: string) => sessions.filter((s) => s.type === type).length;
  assert.equal(count("lecture"), 6); // MWF, two weeks
  assert.equal(count("discussion"), 2); // Wednesdays
  assert.equal(count("lab"), 1); // the calendar's "Review lab"
  const lecture = sessions.find((s) => s.date === "2026-09-28" && s.type === "lecture")!;
  assert.equal(lecture.origin, "enrollment");
  assert.equal(lecture.startMinute, 595);
  assert.equal(lecture.section, "LEC 001");
  assert.match(lecture.typeBasis, /LEC/);
  assert.equal(sessions.find((s) => s.type === "discussion")!.section, "DIS 312");
  assert.equal(sessions.find((s) => s.type === "lab")!.date, "2026-09-29");
  assert.ok(!sessions.some((s) => s.title.includes("P2")));
});

test("refresh pre-creates a code-built scaffold for every session in the window (0 tokens)", async () => {
  const { notes, ask, store } = setup();
  const stats = notes.refresh();
  assert.equal(stats.created, 9);
  assert.equal(notes.refresh().skipped, true, "nothing changed: the tick skips");
  const recent = ok(await ask({ op: "notes.recent", courseId: COURSE, limit: 5 }), "notes.recent");
  assert.equal(recent.notes.length, 5);
  assert.ok(recent.notes.every((n: { state: string }) => n.state === "untouched"));
  const opened = ok(await ask({ op: "notes.open", sessionId: `${COURSE}/2026-09-28:lecture` }), "notes.open");
  assert.equal(opened.created, false, "the batch already made it");
  const note = opened.note;
  assert.equal(note.template, "concept-code-pitfalls");
  const block = (id: string) => note.blocks.find((b: NoteBlock) => b.id === id)!;
  assert.match(block("context").items[0].text, /Mon Sep 28 · 9:55 AM–10:45 AM/);
  assert.ok(block("context").items.some((i: { text: string }) => i.text === "Section: LEC 001"));
  assert.deepEqual(block("sources").items.map((i: { text: string }) => i.text), ["Slides 9/28 Hashing.pdf"]);
  assert.equal(block("sources").items[0].link.url, "https://canvas.example.test/courses/C400/Slides%209/28%20Hashing.pdf");
  assert.deepEqual(block("terms").items.map((i: { text: string }) => i.text), ["Load factor"]);
  assert.match(block("due").items[0].text, /^P2 Hash table — due /);
  assert.ok(note.blocks.some((b: NoteBlock) => b.kind === "code"), "template blocks follow the head");
  assert.equal(store.ledger().length, 0, "no model call");
});

test("an edited scaffold survives a schedule refresh; an untouched one refreshes as a new version", async () => {
  const { notes, ask, store } = setup();
  notes.refresh();
  const mon = ok(await ask({ op: "notes.open", sessionId: `${COURSE}/2026-09-28:lecture` }), "notes.open").note;
  const wed = ok(await ask({ op: "notes.open", sessionId: `${COURSE}/2026-09-30:lecture` }), "notes.open").note;
  const blocks = structuredClone(mon.blocks) as NoteBlock[];
  blocks.find((b) => b.id === "concepts")!.items.push({ id: "s1", text: "Chaining vs probing", origin: "student" });
  const saved = ok(await ask({ op: "notes.save", noteId: mon.id, blocks, revision: mon.revision }), "notes.save").note;
  assert.equal(saved.state, "edited");
  // The schedule moves: lectures now start at 11:00. New material appears.
  store.ingestPlanning({ ...enrollment([meeting([1, 3, 5], 660, 710), meeting([3], 800, 850)]), id: "cap-2", observedAt: "2026-09-28T12:00:00.000Z" });
  const stats = notes.refresh();
  assert.ok(stats.refreshed >= 5, JSON.stringify(stats));
  const monAfter = ok(await ask({ op: "notes.open", noteId: mon.id }), "notes.open").note;
  assert.equal(monAfter.revision, saved.revision, "an edited note is never regenerated");
  assert.ok(monAfter.blocks.find((b: NoteBlock) => b.id === "concepts").items.some((i: { text: string }) => i.text === "Chaining vs probing"));
  assert.equal(monAfter.session.startMinute, 660, "its session details follow the schedule");
  const wedAfter = ok(await ask({ op: "notes.open", noteId: wed.id }), "notes.open").note;
  assert.equal(wedAfter.revision, wed.revision + 1);
  assert.match(wedAfter.blocks[0].items[0].text, /11:00 AM/);
  assert.deepEqual(wedAfter.versions.map((v: { origin: string }) => v.origin), ["scaffold", "scaffold"]);
  // A save against an old revision is refused, never merged silently.
  const stale = await ask({ op: "notes.save", noteId: mon.id, blocks, revision: mon.revision });
  assert.equal(stale.status, "stale_revision");
});

test("a session outside the window is created when opened; the tree groups by module", async () => {
  const { notes, ask } = setup();
  const later = ok(await ask({ op: "notes.open", sessionId: `${COURSE}/2026-10-23:lecture` }), "notes.open");
  assert.equal(later.created, true);
  assert.equal((await ask({ op: "notes.open", sessionId: `${COURSE}/2026-10-24:lecture` })).status, "not_found", "Saturday has no lecture");
  notes.refresh();
  const tree = ok(await ask({ op: "notes.tree", courseId: COURSE }), "notes.tree").tree;
  const sessions = tree.modules.flatMap((m: { sessions: unknown[] }) => m.sessions);
  assert.ok(sessions.length >= 9 + 12);
  assert.ok(sessions.some((s: { note: { id: string } | null }) => s.note?.id === later.note.id));
});

test("template switch keeps the student's text; append and restore add versions; notes become passages", async () => {
  const { notes, ask, store } = setup();
  notes.refresh();
  const note = ok(await ask({ op: "notes.open", sessionId: `${COURSE}/2026-09-28:lecture` }), "notes.open").note;
  const appended = ok(await ask({ op: "notes.append", noteId: note.id, text: "Rehash when the load factor passes 0.75" }), "notes.append").note;
  assert.equal(appended.blocks.find((b: NoteBlock) => b.id === "concepts").items[0].text, "Rehash when the load factor passes 0.75");
  const switched = ok(await ask({ op: "notes.setTemplate", noteId: note.id, template: "cornell" }), "notes.setTemplate").note;
  assert.equal(switched.template, "cornell");
  assert.ok(switched.blocks.find((b: NoteBlock) => b.id === "notes").items.some((i: { text: string }) => /0\.75/.test(i.text)));
  // The choice is remembered for the course's lectures.
  const next = ok(await ask({ op: "notes.open", sessionId: `${COURSE}/2026-10-26:lecture` }), "notes.open").note;
  assert.equal(next.template, "cornell");
  assert.equal(next.templateReason, "chosen by you for this course");
  const restored = ok(await ask({ op: "notes.version", noteId: note.id, version: appended.revision }), "notes.version").note;
  assert.equal(restored.template, "cornell", "restoring content keeps the note's template");
  assert.equal(restored.revision, switched.revision + 1);
  // Search reads the note through the passage index, scoped to the course.
  const hits = store.searchPassages({ query: "rehash load factor", courses: [{ accountScope: ACCT, courseId: COURSE }], k: 5 });
  const noteResource = store.resources().find((r) => r.url.startsWith(NOTE_URL))!;
  assert.ok(noteResource, "the edited note is a resource of the notes source");
  assert.equal(noteResource.kind, "material");
  assert.ok(hits.hits.some((h) => h.resourceId === noteResource.id));
  assert.equal(store.sources().find((s) => s.id === noteResource.sourceId)!.kind, "notes");
  // Untouched scaffolds are not indexed.
  assert.equal(store.resources().filter((r) => r.url.startsWith(NOTE_URL)).length, 1);
});

test("the notes command reaches the service through core; purge deletes every note", async () => {
  const { store } = setup();
  const notes = createNotesService({ store, now: () => NOW });
  const core = createCore(store, { fixture: batch("fixture", "fixture", []), seams: { notes }, now: () => NOW });
  notes.refresh();
  const result = await core.execute({ type: "notes", request: { op: "notes.recent", courseId: COURSE } });
  assert.equal(result.notes?.status, "ok");
  const bare = createCore(store, { fixture: batch("fixture", "fixture", []) });
  assert.equal((await bare.execute({ type: "notes", request: { op: "notes.templates" } })).notes?.status, "not_built");
  await core.execute({ type: "purge", confirmation: "DELETE LOCAL DATA" });
  const after = await notes.handle({ op: "notes.recent", courseId: COURSE, limit: 5 });
  assert.deepEqual((after as { notes: unknown[] }).notes, []);
});

test("v11 migration: an existing v9 file gains the notes tables and keeps its data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "notes-v11-"));
  const path = join(dir, "workspace.sqlite");
  const first = createStore(path);
  first.ingest(batch("courses", "canvas", [res(COURSE, "course", { title: "COMPSCI400" })]));
  first.close();
  // Roll the file back to v9 by dropping the notes tables, as a v9 build left it.
  const raw = new DatabaseSync(path);
  for (const t of ["note_sync_settings", "note_remotes", "note_suggestions", "note_template_choices", "note_links", "note_versions", "notes"])
    raw.exec(`DROP TABLE ${t}`);
  raw.exec("PRAGMA user_version = 9");
  raw.close();
  const store = createStore(path);
  assert.equal(SCHEMA_VERSION, 11);
  assert.equal(store.resources().length, 1);
  assert.deepEqual(store.notes.notes(), []);
  assert.ok(store.migrationBackup());
  store.close();
});
