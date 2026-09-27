// notes.fill through the protection pass (docs/ai-and-privacy.md, "Egress coverage"): a hosted fill
// sends the slides with student names, emails, phones and signed links replaced and the teaching
// content intact; a quote returned against the protected text is checked against the original.
// Entirely synthetic; a fake client, no network.
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
const SLIDES =
  "Quentin Zabrowski asked why a hash table maps keys to buckets. Mail qzab@wisc.edu or call (608) 555-0142. " +
  "Slides: https://canvas.example.test/files/9/download?verifier=CANARYVERIFIER77 . Hash the address 192.168.1.1 into 16 buckets.";
const res = (id: string, kind: ResourceInput["kind"], extra: Partial<ResourceInput> = {}): ResourceInput => ({
  externalId: id, kind, courseId: COURSE, courseName: "COMPSCI400: Programming III (001) FA26", title: id,
  url: `https://canvas.example.test/${encodeURIComponent(id)}`, text: "", deadlines: [], points: null, submitted: null,
  policy: { mode: "coaching", evidence: "Synthetic: AI help is allowed for study." }, ...extra,
});
const batch = (id: string, kind: CaptureBatch["source"]["kind"], resources: ResourceInput[]): CaptureBatch => ({
  source: { id, kind, label: id, accountScope: "acct", courseId: COURSE, scope: id },
  observedAt: "2026-09-27T12:00:00.000Z", complete: true, status: "ok", resources,
});

test("notes.fill sends protected slides and maps the returned quote back to the original", async () => {
  const inputs: string[] = [];
  const runner: ModelRunner = {
    client: "claude",
    async run<T>(request: RunRequest<T>): Promise<RunResult<T>> {
      const sent = request.beforeCall ? request.beforeCall({ systemPrompt: request.systemPrompt, input: request.input } as never) : { input: request.input };
      inputs.push(JSON.stringify(sent));
      const sourceId = /(p\d+)/.exec(request.input)![1]!;
      const quote = /\[STUDENT_SELF\] asked why a hash table maps keys to buckets\./.exec(request.input)![0];
      const parsed = request.schema.parse({ bullets: [{ blockId: "concepts", text: "Hash tables map keys to buckets", sourceId, quote }] });
      return { output: parsed, usage: { in: 9, cached: 0, out: 3 }, model: "fake", latencyMs: 1, attempts: 1, client: "claude", tier: "pass", escalated: false };
    },
  };
  const store = createStore(":memory:", { now: () => NOW });
  store.recordAutoIdentity({ accountScope: "acct", self: { names: ["Quentin Zabrowski"], emails: ["qzab@wisc.edu"], netIds: [], studentIds: [] } });
  const courses = batch("courses", "canvas", [
    res(COURSE, "course", { course: { courseCode: "FA26 COMPSCI 400 001", startAt: "2026-09-02T05:00:00Z" } }),
    res("Slides 9/28 Hashing.pdf", "material", { text: SLIDES }),
  ]);
  store.ingest(courses);
  store.ingest(batch("calendar", "calendar", [res("event-1", "event", { title: "Lecture", calendar: { uid: "event-calendar-event-1", start: "2026-09-28T14:55:00Z", end: "2026-09-28T15:45:00Z", allDay: false } })]));
  store.setPrivacy({ ...defaultPrivacy, mode: "selective_cloud", hostedProvider: "claude", shareCourseText: true });
  const notes = createNotesService({ store, now: () => NOW, runner: () => runner });
  const core = createCore(store, { fixture: courses, seams: { notes }, now: () => NOW });
  await core.execute({ type: "consent", value: { action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION } });
  const opened = (await notes.handle({ op: "notes.open", sessionId: `${COURSE}/2026-09-28:lecture` })) as Extract<NotesResult, { note: NoteDetail }>;
  const filled = await notes.handle({ op: "notes.fill", noteId: opened.note.id });
  assert.equal(filled.status, "ok", "message" in filled ? filled.message : "");
  const result = filled as Extract<NotesResult, { op: "notes.fill"; status: "ok" }>;
  assert.equal(inputs.length, 1);
  for (const canary of ["Quentin", "Zabrowski", "qzab@wisc.edu", "555-0142", "CANARYVERIFIER77"]) assert.ok(!inputs[0]!.includes(canary), canary);
  assert.ok(inputs[0]!.includes("192.168.1.1"), "teaching content is kept");
  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0]!.quote, "Quentin Zabrowski asked why a hash table maps keys to buckets.", "the quote is the original span");
  const receipt = store.receipts().find((r) => r.status === "sent");
  assert.ok(receipt?.protection?.student_name, "the receipt counts what was protected");
  await core.close();
});
