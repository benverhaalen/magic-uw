// Notes: .docx export and import, the Microsoft and Google adapters, and two-way sync with a fake
// remote, including the conflict rule (neither side is dropped). Synthetic data only; no network.
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "@magic/storage";
import type { CaptureBatch, NoteBlock, NoteDetail, NotesResult, ResourceInput } from "@magic/contracts";
import {
  createNotesService,
  docxToHtml,
  googleRemote,
  htmlToBlocks,
  microsoftRemote,
  noteToDocx,
  type DriveRequest,
  type NotesRemote,
  type RemoteFile,
} from "../packages/notes/src/index";
import type { GraphRequest, GraphResponse } from "../packages/connectors/src/graph";

const NOW = new Date("2026-09-28T15:00:00Z");
const COURSE = "E177";
const res = (id: string, kind: ResourceInput["kind"], extra: Partial<ResourceInput> = {}): ResourceInput => ({
  externalId: id,
  kind,
  courseId: COURSE,
  courseName: "ENGL177: Literature and Popular Culture (001) FA26",
  title: id,
  url: `https://canvas.example.test/${encodeURIComponent(id)}`,
  text: "",
  deadlines: [],
  points: null,
  submitted: null,
  policy: { mode: "coaching", evidence: "Synthetic." },
  ...extra,
});
const batch = (id: string, kind: CaptureBatch["source"]["kind"], resources: ResourceInput[]): CaptureBatch => ({
  source: { id, kind, label: id, accountScope: "acct", courseId: COURSE, scope: id },
  observedAt: "2026-09-27T12:00:00.000Z",
  complete: true,
  status: "ok",
  resources,
});

/** An in-memory remote: files hold .docx bytes; `edit` simulates the student writing in Word. */
function fakeRemote(provider: "microsoft" | "google" = "microsoft") {
  const files = new Map<string, { bytes: Uint8Array; etag: string; path: string }>();
  let n = 0;
  const puts: string[] = [];
  const remote: NotesRemote = {
    provider,
    connected: async () => true,
    async put({ folders, name, bytes, remote }) {
      const id = remote?.remoteId ?? `file-${++n}`;
      const etag = `e${++n}`;
      files.set(id, { bytes, etag, path: [...folders, name].join("/") });
      puts.push(id);
      return { remoteId: id, webUrl: `https://remote.example.test/${id}`, etag, modifiedTime: null };
    },
    async get(file: RemoteFile) {
      const f = files.get(file.remoteId);
      if (!f) return { status: "missing" };
      return f.etag === file.etag ? { status: "unchanged" } : { status: "changed", format: "docx", bytes: f.bytes, etag: f.etag, modifiedTime: null };
    },
  };
  async function edit(id: string, change: (blocks: NoteBlock[]) => void) {
    const f = files.get(id)!;
    const { blocks } = htmlToBlocks(await docxToHtml(f.bytes), []);
    change(blocks);
    files.set(id, { ...f, bytes: await noteToDocx("Edited in Word", blocks), etag: `e${++n}` });
  }
  return { remote, files, puts, edit };
}

async function setup() {
  const store = createStore(":memory:", { now: () => NOW });
  store.ingest(
    batch("courses", "canvas", [
      res(COURSE, "course", { title: "ENGL177", course: { courseCode: "FA26 ENGL 177 001", startAt: "2026-09-02T05:00:00Z" } }),
    ]),
  );
  store.ingest(
    batch("calendar", "calendar", [
      res("event-1", "event", { title: "Lecture: Gothic fiction", calendar: { uid: "event-calendar-event-1", start: "2026-09-28T16:00:00Z", end: "2026-09-28T16:50:00Z", allDay: false } }),
    ]),
  );
  const fake = fakeRemote();
  const notes = createNotesService({ store, now: () => NOW, remotes: { microsoft: fake.remote } });
  notes.refresh();
  const opened = (await notes.handle({ op: "notes.open", sessionId: `${COURSE}/2026-09-28:lecture` })) as Extract<NotesResult, { note: NoteDetail }>;
  assert.equal(opened.status, "ok");
  return { store, notes, fake, note: opened.note };
}
const detailOf = (r: NotesResult): NoteDetail => {
  assert.equal(r.status, "ok", "message" in r ? r.message : "");
  return (r as Extract<NotesResult, { note: NoteDetail }>).note;
};
const withText = (blocks: NoteBlock[], id: string, text: string, origin: "student" | "remote" = "student") => {
  const copy = structuredClone(blocks);
  copy.find((b) => b.id === id)!.items.push({ id: `i-${text.length}-${origin}`, text, origin });
  return copy;
};

test("a note round-trips through .docx: ids, kinds and links survive", async () => {
  const blocks: NoteBlock[] = [
    { id: "sources", kind: "sources", heading: "Slides and readings", items: [{ id: "src-1", text: "Week 5 slides", link: { title: "Week 5 slides", url: "https://canvas.example.test/w5" }, origin: "scaffold" }] },
    { id: "cues", kind: "cues", heading: "Cues and questions", items: [{ id: "c1", text: "Why the uncanny?", origin: "student" }] },
    { id: "notes", kind: "section", heading: "Notes", items: [{ id: "n1", text: "Freud & the double <em>", origin: "student" }] },
  ];
  const bytes = await noteToDocx("ENGL 177 Lecture", blocks);
  assert.ok(bytes.length > 1000);
  const back = htmlToBlocks(await docxToHtml(bytes), blocks);
  assert.equal(back.title, "ENGL 177 Lecture");
  assert.deepEqual(back.blocks.map((b) => [b.id, b.kind]), [["sources", "sources"], ["cues", "cues"], ["notes", "section"]]);
  assert.deepEqual(back.blocks[0]!.items[0], blocks[0]!.items[0]);
  assert.equal(back.blocks[2]!.items[0]!.text, "Freud & the double <em>");
  assert.equal(back.blocks[2]!.items[0]!.id, "n1");
});

test("Google's HTML export: headings become blocks, google.com/url links are unwrapped, new text is marked remote", () => {
  const html = `<html><head><style>.c1{}</style></head><body><p class="title"><span>My note</span></p>
    <h2 id="h.1"><span>Notes</span></h2><ul><li class="c2"><span>First &amp; best</span></li>
    <li><span><a href="https://www.google.com/url?q=https://canvas.example.test/w5&amp;sa=D">slides</a></span></li></ul>
    <h2><span>New heading</span></h2><p><span>Typed in Docs</span></p></body></html>`;
  const prior: NoteBlock[] = [{ id: "notes", kind: "section", heading: "Notes", items: [{ id: "n1", text: "First & best", origin: "student" }] }];
  const { title, blocks } = htmlToBlocks(html, prior);
  assert.equal(title, "My note");
  assert.equal(blocks[0]!.id, "notes");
  assert.deepEqual(blocks[0]!.items[0], prior[0]!.items[0]);
  assert.equal(blocks[0]!.items[1]!.link?.url, "https://canvas.example.test/w5");
  assert.equal(blocks[1]!.heading, "New heading");
  assert.equal(blocks[1]!.items[0]!.origin, "remote");
});

test("nothing syncs until the student turns sync on; exporting is the only way a remote file is made", async () => {
  const { notes, fake, note } = await setup();
  assert.equal((await notes.handle({ op: "notes.sync.export", noteId: note.id, provider: "microsoft" })).status, "sync_off");
  await notes.syncTick({ force: true });
  assert.equal(fake.files.size, 0);
  assert.equal((await notes.handle({ op: "notes.sync.enable", provider: "google" })).status, "not_connected");
  const enabled = await notes.handle({ op: "notes.sync.enable", provider: "microsoft" });
  assert.equal(enabled.status, "ok");
  await notes.syncTick({ force: true });
  assert.equal(fake.files.size, 0, "enabling sync creates nothing in the background");
  const exported = await notes.handle({ op: "notes.sync.export", noteId: note.id, provider: "microsoft" });
  assert.equal(exported.status, "ok");
  assert.equal(fake.files.size, 1);
  assert.equal([...fake.files.values()][0]!.path, "ENGL 177/2026-09-28 lecture.docx");
  assert.equal(detailOf(await notes.handle({ op: "notes.open", noteId: note.id })).sync, "synced");
});

test("two-way: local edits push; remote edits pull as a new version", async () => {
  const { notes, fake, note } = await setup();
  await notes.handle({ op: "notes.sync.enable", provider: "microsoft" });
  await notes.handle({ op: "notes.sync.export", noteId: note.id, provider: "microsoft" });
  const id = [...fake.files.keys()][0]!;
  const saved = detailOf(await notes.handle({ op: "notes.save", noteId: note.id, blocks: withText(note.blocks, "notes", "Local line"), revision: note.revision }));
  assert.equal(saved.sync, "pending");
  let stats = await notes.syncTick({ force: true });
  assert.equal(stats.pushed, 1);
  await fake.edit(id, (blocks) => blocks.find((b) => b.heading === "Summary")!.items.push({ id: "x", text: "Written in Word", origin: "remote" }));
  stats = await notes.syncTick({ force: true });
  assert.equal(stats.pulled, 1);
  const after = detailOf(await notes.handle({ op: "notes.open", noteId: note.id }));
  assert.equal(after.versions[0]!.origin, "remote");
  assert.ok(after.blocks.find((b) => b.id === "summary")!.items.some((i) => i.text === "Written in Word" && i.origin === "remote"));
  assert.ok(after.blocks.find((b) => b.id === "notes")!.items.some((i) => i.text === "Local line" && i.origin === "student"), "ids and origins kept");
  assert.equal(after.sync, "synced");
  stats = await notes.syncTick({ force: true });
  assert.deepEqual([stats.pulled, stats.pushed], [0, 0], "a conditional check with nothing new does nothing");
});

test("conflict: remote and local both changed; both are kept as versions and nothing is dropped", async () => {
  const { notes, fake, note } = await setup();
  await notes.handle({ op: "notes.sync.enable", provider: "microsoft" });
  await notes.handle({ op: "notes.sync.export", noteId: note.id, provider: "microsoft" });
  const id = [...fake.files.keys()][0]!;
  await fake.edit(id, (blocks) => blocks.find((b) => b.heading === "Notes")!.items.push({ id: "w", text: "Remote line", origin: "remote" }));
  const local = detailOf(await notes.handle({ op: "notes.save", noteId: note.id, blocks: withText(note.blocks, "notes", "Unsynced local line"), revision: note.revision }));
  const stats = await notes.syncTick({ force: true });
  assert.equal(stats.conflicts, 1);
  const after = detailOf(await notes.handle({ op: "notes.open", noteId: note.id }));
  assert.equal(after.sync, "conflict");
  assert.ok(after.blocks.find((b) => b.id === "notes")!.items.some((i) => i.text === "Remote line"), "remote edits are the new version");
  const kept = after.versions.find((v) => v.conflict)!;
  assert.equal(kept.version, local.revision, "the unsynced local version is kept and flagged");
  const restored = detailOf(await notes.handle({ op: "notes.version", noteId: note.id, version: kept.version }));
  assert.ok(restored.blocks.find((b) => b.id === "notes")!.items.some((i) => i.text === "Unsynced local line"));
  // Many later edits never prune the conflict version.
  let current = restored;
  for (let i = 0; i < 25; i++)
    current = detailOf(await notes.handle({ op: "notes.save", noteId: note.id, blocks: withText(current.blocks, "summary", `edit ${i}`), revision: current.revision }));
  const versions = detailOf(await notes.handle({ op: "notes.open", noteId: note.id })).versions;
  assert.ok(versions.length <= 21);
  assert.equal(fake.files.size, 1);
});

test("adapters: Microsoft to the Graph app folder signature; Google drive.file requests", async () => {
  // Microsoft: graph.ts's appFolderPut/appFolderGet over a fake main proxy (GraphTransport).
  const calls: GraphRequest[] = [];
  const ms = microsoftRemote(async (request): Promise<GraphResponse> => {
    calls.push(request);
    if (request.method === "PUT")
      return { status: 201, headers: {}, body: JSON.stringify({ id: "item-1", webUrl: "https://onedrive.example.test/item-1", eTag: "\"1\"" }) };
    if (request.url.includes("/items/gone/")) return { status: 404, headers: {}, body: "{}" };
    if (request.ifNoneMatch === "\"1\"") return { status: 304, headers: {}, body: "" };
    return { status: 200, headers: { etag: "\"2\"" }, body: Buffer.from([1, 2, 3]).toString("base64") };
  }, async () => true);
  const put = await ms.put({ folders: ["ENGL 177"], name: "2026-09-28 lecture.docx", bytes: new Uint8Array([1, 2]), remote: null });
  assert.equal(calls[0]!.url, "https://graph.microsoft.com/v1.0/me/drive/special/approot:/ENGL%20177/2026-09-28%20lecture.docx:/content", "relative to approot: no doubled app folder");
  assert.equal(calls[0]!.contentType, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(calls[0]!.bodyBase64, Buffer.from([1, 2]).toString("base64"));
  assert.deepEqual(put, { remoteId: "item-1", webUrl: "https://onedrive.example.test/item-1", etag: "\"1\"", modifiedTime: null });
  assert.deepEqual(await ms.get(put), { status: "unchanged" });
  const changed = await ms.get({ ...put, etag: "\"0\"" });
  assert.equal(changed.status, "changed");
  assert.deepEqual(changed.status === "changed" ? [...changed.bytes] : [], [1, 2, 3]);
  assert.deepEqual(await ms.get({ ...put, remoteId: "gone" }), { status: "missing" });

  const requests: DriveRequest[] = [];
  const reply = (status: number, body: unknown) => ({ status, body: new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)) });
  const google = googleRemote(async (request) => {
    requests.push(request);
    if (request.url.includes("?q=")) return reply(200, { files: [] });
    if (request.method === "POST" && request.url.endsWith("fields=id")) return reply(200, { id: `folder-${requests.length}` });
    if (request.method === "POST") return reply(200, { id: "doc-1", webViewLink: "https://docs.google.com/document/d/doc-1", modifiedTime: "2026-09-28T15:00:00.000Z" });
    if (request.url.includes("/export?")) return reply(200, "<h2>Notes</h2><p>From Docs</p>");
    return reply(200, { id: "doc-1", modifiedTime: "2026-09-28T16:00:00.000Z" });
  }, async () => true);
  const doc = await google.put({ folders: ["ENGL 177"], name: "2026-09-28 lecture.docx", bytes: await noteToDocx("t", []), remote: null });
  assert.equal(doc.remoteId, "doc-1");
  const upload = requests.find((r) => r.url.startsWith("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart"))!;
  const body = new TextDecoder().decode(upload.body!);
  assert.match(body, /"mimeType":"application\/vnd.google-apps.document"/, "converted to a Google Doc on upload");
  assert.match(upload.headers!["content-type"]!, /^multipart\/related; boundary=/);
  assert.ok(requests.every((r) => r.url.startsWith("https://www.googleapis.com/")));
  const read = await google.get(doc);
  assert.equal(read.status, "changed");
  assert.deepEqual(await google.get({ ...doc, modifiedTime: "2026-09-28T16:00:00.000Z" }), { status: "unchanged" });
});
