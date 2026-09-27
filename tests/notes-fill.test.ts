// Notes: "fill from slides" is one checked call on request; quotes are verified by code; bullets
// arrive as suggestions and never overwrite what the student wrote. A fake client, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import { defaultPrivacy, type CaptureBatch, type NoteDetail, type NotesResult, type ResourceInput } from "@magic/contracts";
import type { ModelRunner, RunRequest, RunResult } from "../packages/runner/src/index";
import { createNotesService } from "../packages/notes/src/index";

const NOW = new Date("2026-09-28T15:00:00Z");
const COURSE = "C400";
const SLIDES = "A hash table maps keys to buckets. Load factor is entries divided by buckets. Resizing keeps lookups fast.";
const res = (id: string, kind: ResourceInput["kind"], extra: Partial<ResourceInput> = {}): ResourceInput => ({
  externalId: id,
  kind,
  courseId: COURSE,
  courseName: "COMPSCI400: Programming III (001) FA26",
  title: id,
  url: `https://canvas.example.test/${encodeURIComponent(id)}`,
  text: "",
  deadlines: [],
  points: null,
  submitted: null,
  policy: { mode: "coaching", evidence: "Synthetic: AI help is allowed for study." },
  ...extra,
});
const batch = (id: string, kind: CaptureBatch["source"]["kind"], resources: ResourceInput[]): CaptureBatch => ({
  source: { id, kind, label: id, accountScope: "acct", courseId: COURSE, scope: id },
  observedAt: "2026-09-27T12:00:00.000Z",
  complete: true,
  status: "ok",
  resources,
});

function fakeRunner(output: (sourceId: string) => unknown) {
  const calls: RunRequest<unknown>[] = [];
  const runner: ModelRunner = {
    client: "claude",
    async run<T>(request: RunRequest<T>): Promise<RunResult<T>> {
      calls.push(request as RunRequest<unknown>);
      const sourceId = /\[(p\d+)\]|"(p\d+)"|(p\d+)/.exec(request.input)!.slice(1).find(Boolean)!;
      const parsed = request.schema.parse(output(sourceId));
      const errors = request.check?.(parsed) ?? [];
      if (errors.length) throw new Error(errors.join("; "));
      return { output: parsed, usage: { in: 900, cached: 0, out: 120 }, model: "fake", latencyMs: 1, attempts: 1, client: "claude", tier: "pass", escalated: false };
    },
  };
  return { runner, calls };
}

async function setup(runner: ModelRunner | null, consent = true) {
  const store = createStore(":memory:", { now: () => NOW });
  const courses = batch("courses", "canvas", [
    res(COURSE, "course", { course: { courseCode: "FA26 COMPSCI 400 001", startAt: "2026-09-02T05:00:00Z" } }),
    res("Slides 9/28 Hashing.pdf", "material", { text: SLIDES }),
  ]);
  store.ingest(courses);
  store.ingest(
    batch("calendar", "calendar", [
      res("event-1", "event", { title: "Lecture", calendar: { uid: "event-calendar-event-1", start: "2026-09-28T14:55:00Z", end: "2026-09-28T15:45:00Z", allDay: false } }),
    ]),
  );
  store.setPrivacy({ ...defaultPrivacy, mode: "selective_cloud", hostedProvider: "claude", shareCourseText: true });
  const notes = createNotesService({ store, now: () => NOW, runner: () => runner });
  const core = createCore(store, { fixture: courses, seams: { notes }, now: () => NOW });
  if (consent) await core.execute({ type: "consent", value: { action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION } });
  const opened = (await notes.handle({ op: "notes.open", sessionId: `${COURSE}/2026-09-28:lecture` })) as Extract<NotesResult, { note: NoteDetail }>;
  return { store, notes, note: opened.note };
}
const bullets = (sourceId: string) => ({
  bullets: [
    { blockId: "concepts", text: "Hash tables map keys to buckets", sourceId, quote: "A hash table maps keys to buckets." },
    { blockId: "concepts", text: "Load factor = entries / buckets", sourceId, quote: "Load factor is entries divided by buckets." },
    { blockId: "pitfalls", text: "Resizing matters for speed", sourceId, quote: "Resizing keeps lookups fast." },
  ],
});

test("fill proposes quote-checked suggestions; accepting adds them; the student's text is untouched", async () => {
  const fake = fakeRunner(bullets);
  const { notes, note, store } = await setup(fake.runner);
  const blocks = structuredClone(note.blocks);
  blocks.find((b) => b.id === "concepts")!.items.push({ id: "mine", text: "Load factor = entries / buckets", origin: "student" });
  const saved = (await notes.handle({ op: "notes.save", noteId: note.id, blocks, revision: note.revision })) as Extract<NotesResult, { note: NoteDetail }>;
  const filled = await notes.handle({ op: "notes.fill", noteId: note.id });
  assert.equal(filled.status, "ok", "message" in filled ? filled.message : "");
  const result = filled as Extract<NotesResult, { op: "notes.fill"; status: "ok" }>;
  assert.equal(fake.calls.length, 1, "one call");
  assert.equal(result.suggestions.length, 2, "the bullet the student already wrote is dropped");
  assert.equal(result.dropped, 1);
  assert.ok(result.suggestions.every((s) => SLIDES.includes(s.quote)));
  assert.equal(result.note.revision, saved.note.revision, "fill writes suggestions, not the note");
  assert.ok(result.receiptIds.length >= 1, "a receipt for what was sent");
  assert.ok(!/Synthetic Hall|9:55|LEC/.test(fake.calls[0]!.input), "no class meeting details are sent");
  assert.ok(!fake.calls[0]!.input.includes("mine"), "the student's notes are not sent");
  const accepted = await notes.handle({ op: "notes.suggestion", noteId: note.id, suggestionId: result.suggestions[1]!.id, action: "accept" });
  const after = (accepted as Extract<NotesResult, { note: NoteDetail }>).note;
  const pitfalls = after.blocks.find((b) => b.id === "pitfalls")!;
  assert.deepEqual(pitfalls.items.map((i) => [i.text, i.origin]), [["Resizing matters for speed", "fill"]]);
  assert.ok(after.blocks.find((b) => b.id === "concepts")!.items.some((i) => i.id === "mine"));
  // A repeat with unchanged slides is a cache hit: no second call, 0 tokens.
  const again = (await notes.handle({ op: "notes.fill", noteId: note.id })) as Extract<NotesResult, { op: "notes.fill"; status: "ok" }>;
  assert.equal(again.cached, true);
  assert.deepEqual(again.tokens, { in: 0, cached: 0, out: 0 });
  assert.equal(fake.calls.length, 1);
  assert.ok(store.ledger().length >= 1);
});

test("fill is blocked without consent, answers no_client without a client, and never runs on its own", async () => {
  const fake = fakeRunner(bullets);
  const blocked = await setup(fake.runner, false);
  blocked.notes.refresh();
  assert.equal(fake.calls.length, 0, "the batch scaffolds spend no tokens");
  const r = await blocked.notes.handle({ op: "notes.fill", noteId: blocked.note.id });
  assert.equal(r.status, "blocked");
  assert.equal(fake.calls.length, 0);
  const none = await setup(null);
  assert.equal((await none.notes.handle({ op: "notes.fill", noteId: none.note.id })).status, "no_client");
});
