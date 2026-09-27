import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "@magic/storage";
import { createCore, scrubText, rosterFor, toOriginalSpan } from "@magic/core";
import { gatewayClient } from "@magic/ai";
import { captureBatchSchema, defaultPrivacy, type CaptureBatch } from "@magic/contracts";
import { courseResource, courseSchema } from "../packages/connectors/src/canvas-models";

// Entirely synthetic people and coursework.
const course = "hist-210";
const courseName = "History 210";
const discussion =
  "Week 3 discussion. Professor Elena Ruiz asked us to respond to one classmate. Maya Chen argued that the tariff shifted trade toward Chicago, and Chen cites the 1846 debates. Email maya.chen@wisc.edu if the link breaks.";
const assignmentText =
  "Write 800 words on the 1846 tariff. Peer reviewer: Sam Rivera (NetID: srivera7, ID 9081234567, phone (608) 555-0142). Read Frederick Jackson Turner before starting. Questions go to Elena Ruiz.";
function batch(overrides: { discussion?: string } = {}): CaptureBatch {
  const base = { courseId: course, courseName, deadlines: [], points: null, submitted: null };
  return captureBatchSchema.parse({
    source: { id: "synthetic-hist", label: "Synthetic history", kind: "fixture", accountScope: "synthetic", courseId: course, scope: "all" },
    observedAt: "2026-09-26T18:00:00Z",
    complete: true,
    status: "ok",
    resources: [
      { ...base, externalId: "course", kind: "course", title: courseName, url: "https://example.org/hist", text: "", course: { instructors: ["Elena Ruiz"] } },
      { ...base, externalId: "disc-3", kind: "message", title: "Week 3: tariffs", url: "https://example.org/hist/d3", text: overrides.discussion ?? discussion },
      {
        ...base,
        externalId: "essay-2",
        kind: "assignment",
        title: "Tariff essay",
        url: "https://example.org/hist/e2",
        text: assignmentText,
        policy: { mode: "coaching", evidence: "AI may explain; Maya Chen's draft is not shared." },
        submission: { comments: [{ text: "Nice start", authorName: "Sam Rivera" }, { text: "See rubric", authorName: "Elena Ruiz" }] },
      },
    ],
  });
}
const roster = {
  self: { names: ["Ben Student"], emails: ["bstudent@wisc.edu"], netIds: ["bstudent"], studentIds: [] },
  peers: [{ names: ["Maya Chen"], emails: [], netIds: [], studentIds: [] }],
  retain: [],
};
const judgment = {
  kind: "essay" as const,
  probabilities: { essay: 0.97, problem_set: 0.005, quiz: 0.005, exam: 0.005, discussion: 0.005, project: 0.005, reading: 0.005, other: 0 },
  model: "synthetic-model",
  questionVersion: "assignment.kind.v1" as const,
};
async function setup(gateway?: Parameters<typeof createCore>[1]["gateway"]) {
  const store = createStore(":memory:");
  const core = createCore(store, { fixture: batch(), ...(gateway ? { gateway } : {}) });
  await core.execute({ type: "fixture" });
  await core.execute({ type: "identity-roster", value: roster });
  const byTitle = (t: string) => core.snapshot().resources.find((r) => r.title === t)!;
  return { store, core, byTitle };
}

test("hosted preview removes a classmate's name from a discussion post but keeps the professor", async () => {
  const { core, byTitle } = await setup();
  const d = byTitle("Week 3: tariffs");
  const result = await core.execute({ type: "context", id: d.id, recipient: "claude" });
  const m = result.manifest!;
  assert.ok(!m.payload.text.includes("Maya"));
  assert.ok(!/\bChen\b/.test(m.payload.text));
  assert.ok(!m.payload.text.includes("maya.chen@wisc.edu"));
  assert.ok(m.payload.text.includes("Professor Elena Ruiz"));
  assert.ok(m.payload.text.includes("[STUDENT_1] argued"));
  assert.ok(m.payload.text.includes("[STUDENT_1] cites"));
  assert.equal(m.redaction?.applied, true);
  assert.equal(m.redaction?.counts.student_name, 2);
  assert.equal(m.redaction?.counts.email, 1);
  assert.equal(m.characters, JSON.stringify(m.payload).length);
  // Local recipients see the original; the redaction map never enters the manifest.
  const local = core.context(d.id, "local");
  assert.equal(local.payload.text, discussion);
  assert.equal(local.redaction, undefined);
  assert.ok(!JSON.stringify(m).includes("Maya"));
  await core.close();
});

test("emails, NetIDs, 10-digit IDs and phones are removed; comment authors who are not teachers are scrubbed", async () => {
  const { core, byTitle } = await setup();
  const payload = core.context(byTitle("Tariff essay").id, "jev").payload;
  for (const secret of ["Sam", "Rivera", "srivera7", "9081234567", "555-0142", "Maya"]) assert.ok(!JSON.stringify(payload).includes(secret), secret);
  assert.match(payload.text, /Peer reviewer: \[STUDENT_2\] \(NetID: \[NETID_1\], ID \[STUDENT_ID_1\], phone \[PHONE_1\]\)/);
  // Instructor from course metadata and a cited author are kept.
  assert.ok(payload.text.includes("Questions go to Elena Ruiz."));
  assert.ok(payload.text.includes("Frederick Jackson Turner"));
  assert.equal(payload.policy, "AI may explain; [STUDENT_1]'s draft is not shared.");
  await core.close();
});

test("overlapping names: longest match wins, shared bare first names are scrubbed, ordinary words survive", () => {
  const roster = {
    people: [
      { token: "STUDENT_1", person: { names: ["Jordan Smith"], emails: [], netIds: [], studentIds: [] } },
      { token: "STUDENT_2", person: { names: ["Will Grant"], emails: [], netIds: [], studentIds: [] } },
      { token: "STUDENT_3", person: { names: ["Ann Lee"], emails: [], netIds: [], studentIds: [] } },
    ],
    retain: ["Jordan Park", "Annabel Leeds"],
    version: "t",
  };
  const text =
    "Jordan Park said Jordan Smith will present; Smith, Jordan and Jordan then asked Professor Park. SMITH replied. Annabel Leeds and Ann Lee met Will, who will write. jordan.park@wisc.edu";
  const out = scrubText(text, roster).text;
  assert.equal(
    out,
    "Jordan Park said [STUDENT_1] will present; [STUDENT_1] and [STUDENT_1] then asked Professor Park. [STUDENT_1] replied. Annabel Leeds and [STUDENT_3] met [STUDENT_2], who will write. [EMAIL_1]",
  );
});

test("a student listed as a teacher elsewhere is never retained", () => {
  const store = createStore(":memory:");
  store.ingest(batch());
  store.setIdentityRoster({ peers: [{ names: ["Elena Ruiz"], emails: [], netIds: [], studentIds: [] }], retain: ["Elena Ruiz"] });
  const r = rosterFor(store, course);
  assert.deepEqual(r.retain, []);
  assert.equal(scrubText("Ask Elena Ruiz", r).text, "Ask [STUDENT_1]");
  store.close();
});

test("a quote from scrubbed text resolves to the exact original span; non-exact quotes are rejected", async () => {
  const { core, byTitle } = await setup();
  const d = byTitle("Week 3: tariffs");
  const sent = core.context(d.id, "claude").payload.text;
  const quote = "[STUDENT_1] argued that the tariff shifted trade toward Chicago";
  const start = sent.indexOf(quote);
  const { citations } = await core.execute({
    type: "validate-citations",
    claims: [
      { resourceId: d.id, contentHash: d.contentHash, quote },
      { resourceId: d.id, contentHash: d.contentHash, quote, start, end: start + quote.length },
      { resourceId: d.id, contentHash: d.contentHash, quote: "Maya Chen argued that the tariff", basis: "original" },
      { resourceId: d.id, contentHash: d.contentHash, quote: "[STUDENT_1] argued that the  tariff" },
      { resourceId: d.id, contentHash: d.contentHash, quote: "[student_1] argued that the tariff" },
      { resourceId: d.id, contentHash: d.contentHash, quote: "Maya Chen argued" },
      { resourceId: d.id, contentHash: d.contentHash, quote, start: start + 1, end: start + 1 + quote.length },
      { resourceId: d.id, contentHash: d.contentHash, quote: "DENT_1] argued" },
      { resourceId: d.id, contentHash: d.contentHash, quote: "[STUDENT_1]" },
    ],
  });
  const [exact, offsets, original, spaced, cased, unscrubbed, shifted, split, ambiguous] = citations!;
  const span = "Maya Chen argued that the tariff shifted trade toward Chicago";
  const at = discussion.indexOf(span);
  assert.deepEqual(exact!.original, { start: at, end: at + span.length, text: span });
  assert.equal(exact!.status, "supported");
  assert.equal(exact!.containsRedaction, true);
  assert.deepEqual(offsets!.original, exact!.original);
  assert.equal(original!.status, "supported");
  assert.equal(original!.original!.start, at);
  assert.equal(spaced!.reason, "quote_not_found");
  assert.equal(cased!.reason, "quote_not_found");
  // Outgoing-basis claims can only quote what was actually sent.
  assert.equal(unscrubbed!.reason, "quote_not_found");
  assert.equal(shifted!.reason, "offset_mismatch");
  assert.equal(split!.reason, "quote_splits_redaction");
  assert.equal(ambiguous!.reason, "ambiguous_quote");
  for (const c of [spaced, cased, shifted, split, ambiguous]) assert.equal(c!.original, undefined);
  await core.close();
});

test("a citation against a stale source version or a missing source is rejected", async () => {
  const { store, core, byTitle } = await setup();
  const old = byTitle("Week 3: tariffs");
  store.ingest({ ...batch({ discussion: discussion.replace("1846", "1842") }), observedAt: "2026-09-27T18:00:00Z" });
  const now = byTitle("Week 3: tariffs");
  assert.notEqual(now.contentHash, old.contentHash);
  const { citations } = await core.execute({
    type: "validate-citations",
    claims: [
      { resourceId: old.id, contentHash: old.contentHash, quote: "Chicago" },
      { resourceId: now.id, contentHash: now.contentHash, quote: "Chicago" },
      { resourceId: "missing", contentHash: "x", quote: "Chicago" },
    ],
  });
  assert.equal(citations![0]!.reason, "stale_version");
  assert.equal(citations![1]!.status, "supported");
  assert.equal(citations![2]!.reason, "source_missing");
  await core.close();
});

test("the real Jev gateway client sends the scrubbed payload over HTTP, identical to the preview", async () => {
  const bodies: string[] = [];
  let token: string | null = null;
  const fetcher = (async (url: URL, init: RequestInit) => {
    if (String(url).endsWith("/v1/devices")) return new Response(JSON.stringify({ token: "t".repeat(32) }), { status: 200 });
    bodies.push(String(init.body));
    return new Response(JSON.stringify(judgment), { status: 200 });
  }) as typeof fetch;
  const gateway = gatewayClient("http://127.0.0.1:9/", { read: async () => token, write: async (t) => void (token = t) }, fetcher);
  const { store, core, byTitle } = await setup(gateway);
  const essay = byTitle("Tariff essay");
  await core.execute({ type: "privacy", value: { ...defaultPrivacy, mode: "selective_cloud", jevEnabled: true, shareCourseText: true } });
  await core.execute({ type: "enrich", id: essay.id });
  await core.settled();
  assert.equal(bodies.length, 1);
  for (const secret of ["Sam Rivera", "Rivera", "srivera7", "9081234567", "Maya Chen"]) assert.ok(!bodies[0]!.includes(secret), secret);
  assert.ok(bodies[0]!.includes("Elena Ruiz"));
  const preview = (await core.execute({ type: "context", id: essay.id, recipient: "jev" })).manifest!;
  assert.deepEqual(JSON.parse(bodies[0]!), { state: preview.payload });
  assert.equal(store.receipts().find((r) => r.status === "sent")?.characters, preview.characters);
  await core.close();
});

test("offset mapping handles boundaries at and around placeholders", () => {
  const r = { people: [{ token: "STUDENT_1", person: { names: ["Al Bo"], emails: [], netIds: [], studentIds: [] } }], retain: [], version: "t" };
  const s = scrubText("x Al Bo y Al Bo z", r);
  assert.equal(s.text, "x [STUDENT_1] y [STUDENT_1] z");
  assert.deepEqual(toOriginalSpan(s, 0, 2), { start: 0, end: 2 });
  assert.deepEqual(toOriginalSpan(s, 2, 13), { start: 2, end: 7 });
  assert.deepEqual(toOriginalSpan(s, 13, 16), { start: 7, end: 10 });
  assert.deepEqual(toOriginalSpan(s, 16, s.text.length), { start: 10, end: 17 });
  assert.equal(toOriginalSpan(s, 3, 13), null);
  assert.equal(toOriginalSpan(s, 2, 12), null);
});

test("roster persists locally and is cleared by purge; Canvas teachers become retained instructors", async () => {
  const { store, core } = await setup();
  assert.deepEqual(store.identityRoster().peers[0]!.names, ["Maya Chen"]);
  await core.execute({ type: "purge", confirmation: "DELETE LOCAL DATA" });
  assert.deepEqual(store.identityRoster(), { peers: [], retain: [] });
  await core.close();
  const parsed = courseSchema.parse({ id: 7, name: "History 210", teachers: [{ display_name: "Elena Ruiz", id: 3, avatar_image_url: "x" }, { display_name: null }] });
  const resource = courseResource(parsed, "https://canvas.example.edu", {});
  assert.deepEqual(resource.course?.instructors, ["Elena Ruiz"]);
  assert.ok(!JSON.stringify(resource).includes("avatar"));
});
