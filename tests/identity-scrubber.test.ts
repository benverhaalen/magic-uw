import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "@magic/storage";
import { createHash } from "node:crypto";
import { createCore, scrubText, rosterFor, toOriginalSpan, validateCitations } from "@magic/core";
import { gatewayClient } from "@magic/ai";
import { captureBatchSchema, defaultPrivacy, type CaptureBatch } from "@magic/contracts";
import { canvasConnector } from "../packages/connectors/src/canvas";
import { courseResource, courseSchema, profileIdentity } from "../packages/connectors/src/canvas-models";
import { createSyntheticCanvasUniversity } from "../packages/connectors/src/canvas-fixture";
import { createMcpService } from "../packages/core/src/mcp";

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
  for (const recipient of ["jev", "claude"] as const) store.setConsent!({ action: "grant", recipient, disclosureVersion: "setup-2026-09-26" }, "2026-09-26T12:00:00Z");
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
  const manifest = core.context(d.id, "claude");
  const sent = manifest.payload.text;
  const projectionId = manifest.citationProjections![0]!.projectionId;
  const quote = "[STUDENT_1] argued that the tariff shifted trade toward Chicago";
  const start = sent.indexOf(quote);
  const { citations } = await core.execute({
    type: "validate-citations",
    claims: [
      { resourceId: d.id, contentHash: d.contentHash, projectionId, quote },
      { resourceId: d.id, contentHash: d.contentHash, projectionId, quote, start, end: start + quote.length },
      { resourceId: d.id, contentHash: d.contentHash, projectionId, quote: "Maya Chen argued that the tariff", basis: "original" },
      { resourceId: d.id, contentHash: d.contentHash, projectionId, quote: "[STUDENT_1] argued that the  tariff" },
      { resourceId: d.id, contentHash: d.contentHash, projectionId, quote: "[student_1] argued that the tariff" },
      { resourceId: d.id, contentHash: d.contentHash, projectionId, quote: "Maya Chen argued" },
      { resourceId: d.id, contentHash: d.contentHash, projectionId, quote, start: start + 1, end: start + 1 + quote.length },
      { resourceId: d.id, contentHash: d.contentHash, projectionId, quote: "DENT_1] argued" },
      { resourceId: d.id, contentHash: d.contentHash, projectionId, quote: "[STUDENT_1]" },
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
      { resourceId: now.id, contentHash: now.contentHash, quote: "Chicago", basis: "original" },
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

test("Canvas profile fields become the student's own identity", () => {
  assert.deepEqual(
    profileIdentity({ id: "1", name: "Avery Quinlan", short_name: "Avery", sortable_name: "Quinlan, Avery", login_id: "aquinlan", primary_email: "AQuinlan@wisc.edu" }),
    { names: ["Avery Quinlan", "Avery"], emails: ["aquinlan@wisc.edu"], netIds: ["aquinlan"], studentIds: [] },
  );
  assert.equal(profileIdentity({ id: "1" }), undefined);
});

const syncNow = () => new Date("2026-09-26T15:00:00Z");
test("a fresh Canvas sync with zero manual setup scrubs the student's own name, email and NetID from the Jev payload", async () => {
  const university = createSyntheticCanvasUniversity({ rateLimit: false });
  const injected = "Lead: Avery Quinlan (aquinlan, aquinlan@wisc.edu). Pair with Rowan Tessier; questions to Dana Whitfield.";
  const fetch = (async (url: string, init?: RequestInit) => {
    const response = await university.fetch(url, init);
    if (!response.ok) return response;
    const path = new URL(url).pathname;
    if (path.endsWith("/users/self/profile")) return Response.json({ ...(await response.json()), name: "Avery Quinlan", login_id: "aquinlan", primary_email: "aquinlan@wisc.edu" });
    if (path !== "/api/v1/courses/101/assignments") return response;
    const rows = (await response.json()) as Array<{ id: number; description: string }>;
    for (const row of rows) if (row.id === 1001) row.description = `<p>${injected}</p>`;
    return new Response(JSON.stringify(rows), { status: response.status, headers: response.headers });
  }) as typeof globalThis.fetch;
  const store = createStore(":memory:");
  const batches: CaptureBatch[] = [];
  // Same hook the desktop ingestion passes: identities go to the local roster, batches to coursework.
  for await (const b of canvasConnector({
    origin: "https://canvas.synthetic.test", fetch, now: syncNow, sleep: async () => {}, random: () => 0,
    onIdentity: (identity) => store.recordAutoIdentity(identity),
  }).pull()) {
    batches.push(b);
    store.ingest(b);
  }
  store.recordAutoIdentity({ accountScope: batches.find((b) => b.source.courseId === "101")!.source.accountScope, courseId: "101", authors: ["Rowan Tessier"] });
  // Profile and topic-author identities never enter coursework (the assignment text above was injected on purpose).
  assert.ok(!JSON.stringify(batches).includes("Quinlan, Avery"));
  const discussions = batches.filter((b) => b.source.scope === "discussions" || b.source.scope === "announcements");
  assert.ok(discussions.length > 0);
  assert.ok(!JSON.stringify(discussions).includes("Rowan Tessier"));
  assert.ok(!JSON.stringify(discussions).includes("Dana Whitfield"));
  assert.deepEqual(store.identityRoster(), { peers: [], retain: [] });
  const bodies: string[] = [];
  let token: string | null = null;
  const fetcher = (async (url: URL, init: RequestInit) => {
    if (String(url).endsWith("/v1/devices")) return new Response(JSON.stringify({ token: "t".repeat(32) }), { status: 200 });
    bodies.push(String(init.body));
    return new Response(JSON.stringify(judgment), { status: 200 });
  }) as typeof globalThis.fetch;
  const gateway = gatewayClient("http://127.0.0.1:9/", { read: async () => token, write: async (t) => void (token = t) }, fetcher);
  // Real clock: jobs queued during ingest use the store's wall-clock time.
  for (const recipient of ["jev", "claude"] as const) store.setConsent!({ action: "grant", recipient, disclosureVersion: "setup-2026-09-26" }, "2026-09-26T12:00:00Z");
  const core = createCore(store, { fixture: batch(), gateway });
  const essay = core.snapshot().resources.find((r) => r.text.includes("Avery Quinlan"));
  assert.ok(essay, "injected assignment captured");
  await core.execute({ type: "privacy", value: { ...defaultPrivacy, mode: "selective_cloud", jevEnabled: true, shareCourseText: true } });
  await core.execute({ type: "enrich", id: essay.id });
  await core.settled();
  const sent = bodies.find((b) => b.includes("Lead:"));
  assert.ok(sent, "the injected assignment was sent to Jev");
  for (const secret of ["Avery", "Quinlan", "aquinlan", "Rowan", "Tessier"]) assert.ok(!sent.includes(secret), secret);
  assert.match(sent, /Lead: \[STUDENT_SELF\] \(\[NETID_1\], \[EMAIL_1\]\)\. Pair with \[STUDENT_1\]; questions to Dana Whitfield\./);
  await core.close();
});

test("automatic refreshes merge with, and never erase, manual roster entries", () => {
  const store = createStore(":memory:");
  store.ingest(batch());
  const person = (names: string[], netIds: string[] = []) => ({ names, emails: [], netIds, studentIds: [] });
  store.setIdentityRoster({ self: person(["Ben Student"]), peers: [person(["Maya Chen"])], retain: [] });
  store.recordAutoIdentity({ accountScope: "a", self: { ...person(["Avery Quinlan"], ["aquinlan"]), emails: ["aquinlan@wisc.edu"] } });
  store.recordAutoIdentity({ accountScope: "a", courseId: course, authors: ["Rowan Tessier"] });
  store.recordAutoIdentity({ accountScope: "a", self: person(["Avery Q. Quinlan"], ["aquinlan"]) });
  store.recordAutoIdentity({ accountScope: "a", courseId: course, authors: ["Jo Park"] });
  assert.deepEqual(store.identityRoster().peers[0]!.names, ["Maya Chen"]);
  assert.deepEqual(store.identityRoster().self!.names, ["Ben Student"]);
  assert.deepEqual(store.autoIdentities().accounts.a!.authorsByCourse[course], ["Rowan Tessier", "Jo Park"]);
  const r = rosterFor(store, course);
  assert.deepEqual(r.people.find((p) => p.token === "STUDENT_SELF")!.person.names, ["Ben Student", "Avery Q. Quinlan"]);
  // Peers: manual first, then derived authors (comment + topic authors) sorted.
  const text = scrubText("Ben Student, Avery Q. Quinlan, Maya Chen, Rowan Tessier, Jo Park and Elena Ruiz", r).text;
  assert.equal(text, "[STUDENT_SELF], [STUDENT_SELF], [STUDENT_1], [STUDENT_3], [STUDENT_2] and Elena Ruiz");
  store.close();
});

test("MCP output is scrubbed, keeps teacher names, and its citations resolve to original spans", async () => {
  const store = createStore(":memory:");
  const token = "m".repeat(64);
  const b = batch();
  store.ingest({ ...b, source: { ...b.source, kind: "canvas", accountScope: "acct" } });
  store.recordAutoIdentity({ accountScope: "acct", self: { names: ["Avery Quinlan"], emails: [], netIds: ["aquinlan"], studentIds: [] } });
  store.setIdentityRoster(roster);
  store.setPrivacy({ ...defaultPrivacy, mode: "selective_cloud", hostedProvider: "claude", shareCourseText: true, shareComments: true, shareCommunications: true });
  store.setMcpGrant({
    id: "claude-desktop", label: "Claude", recipient: "claude", enabled: true,
    courses: [{ accountScope: "acct", courseId: course }], categories: ["course_text", "comments", "communications"],
    tokenHash: createHash("sha256").update(token).digest("hex"),
  });
  store.setConsent!({ action: "grant", recipient: "claude", disclosureVersion: "setup-2026-09-26" }, "2026-09-26T12:00:00Z");
  const service = createMcpService(store, "claude-desktop", token, syncNow);
  const d = store.resources().find((r) => r.title === "Week 3: tariffs")!;
  const essay = store.resources().find((r) => r.title === "Tariff essay")!;
  const item = service.call("get_item", { id: d.id }) as { text: string; excerpt: { start: number; basis: string }; citation: { contentHash: string; projectionId: string } };
  const search = JSON.stringify(service.call("search", { query: "tariff Maya" }));
  const comments = JSON.stringify(service.call("get_item", { id: essay.id }));
  for (const out of [JSON.stringify(item), search, comments])
    for (const secret of ["Maya", "maya.chen", "Sam Rivera", "srivera7", "9081234567"]) assert.ok(!out.includes(secret), secret);
  assert.ok(item.text.includes("Professor Elena Ruiz"));
  assert.ok(comments.includes('"authorName":"Elena Ruiz"'));
  assert.ok(comments.includes('"authorName":"[STUDENT_2]"'));
  assert.equal(item.excerpt.basis, "outgoing");
  const quote = "[STUDENT_1] argued that the tariff";
  const at = item.text.indexOf(quote) + item.excerpt.start;
  const [result] = validateCitations(store, [{ resourceId: d.id, contentHash: item.citation.contentHash, projectionId: item.citation.projectionId, quote, start: at, end: at + quote.length }]);
  assert.equal(result!.status, "supported");
  assert.equal(result!.original!.text, "Maya Chen argued that the tariff");
  await service.server.close();
  store.close();
});
