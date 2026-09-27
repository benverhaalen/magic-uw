/**
 * The end-to-end canary sweep (docs/ai-and-privacy.md, "Egress coverage"): a synthetic course
 * carries canary identities in every resource kind (material, assignment, discussion, mail,
 * OneNote notes, planning). Every egress path is driven with a recording fake, and no canary
 * string may appear in anything recorded. Quotes taken from the protected text still map back
 * to the original. Entirely synthetic people and coursework.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { captureBatchSchema, defaultPrivacy } from "@magic/contracts";
import { CONSENT_DISCLOSURE_VERSION, maySend } from "@magic/domain";
import fixture from "../fixtures/course.json";
import { createModelRunner, type BackendCall } from "../packages/runner/src/index";
import { createPackHandler } from "../packages/core/src/pack-handler";
import { memoryArtifactStore } from "../packages/packs/core/src/index";
import { createMcpService } from "../packages/core/src/mcp";
import { accountRoster, protectMail, validateProtectedCitations } from "../packages/core/src/privacy/protect";
import { configurePseudonymKey, pseudonymSession } from "../packages/core/src/privacy/pseudonyms";
import { rosterFor, scrubText } from "../packages/core/src/identity";

const at = "2026-09-26T12:00:00Z";
// The operator's rule (September 27): protect people and credentials, never rewrite teaching material.
const CANARIES = [
  "Quentin", "Zabrowski", "qzabrowski", "Ottoline", "Brackenridge", "obrack", "555-0142", "9081234567",
  "CANARYVERIFIER77", "4455667", "Canaryhill", "03/14/2004", "5555 5555 5555 4444", "219-09-9999", "CANARYDARS",
];
/** People and credentials: removed from every kind of text. */
const IDENTITY =
  "Quentin Zabrowski (qzabrowski@wisc.edu, NetID: qzabrowski) worked with Ottoline Brackenridge (obrack@wisc.edu). " +
  "Phone (608) 555-0142. Student ID: 9081234567. Slides: https://canvas.wisc.edu/files/77/download?download_frd=1&verifier=CANARYVERIFIER77 . " +
  "Profile https://canvas.wisc.edu/courses/5/users/4455667 .";
/** Someone's own numbers, written with person context: removed from personal content (posts, comments, mail, notes). */
const PERSONAL = `${IDENTITY} My card is 5555 5555 5555 4444. I live at 1234 Canaryhill Street. My DOB: 03/14/2004. My SSN is 219-09-9999.`;
/** Course content that looks like personal data: kept in teaching material, so the model understands it. */
const CONTENT = [
  "Configure the gateway at 192.168.1.1 and ping 10.0.0.7.",
  "The Luhn example 4111 1111 1111 1111 is valid; the sample SSN 123-45-6789 is fictional.",
  "The White House is at 1600 Pennsylvania Avenue.",
  "Turing was born June 23, 1912, and Keynes (1936) is cited.",
];
const KEPT = ["192.168.1.1", "10.0.0.7", "4111 1111 1111 1111", "123-45-6789", "1600 Pennsylvania Avenue", "June 23, 1912", "Keynes (1936)"];
const LESSON = "Quentin Zabrowski explained that a stack is a last-in first-out collection.";

function seed() {
  const store = createStore(":memory:");
  store.setPrivacy({ ...defaultPrivacy, mode: "selective_cloud", hostedProvider: "claude", jevEnabled: true, shareCourseText: true, shareComments: true, shareGrades: true, shareCommunications: true });
  for (const recipient of ["claude", "jev"] as const) store.setConsent!({ action: "grant", recipient, disclosureVersion: CONSENT_DISCLOSURE_VERSION }, at);
  store.recordAutoIdentity({ accountScope: "acct", self: { names: ["Quentin Zabrowski"], emails: ["qzabrowski@wisc.edu"], netIds: ["qzabrowski"], studentIds: ["9081234567"] } });
  store.recordAutoIdentity({ accountScope: "acct", courseId: "c", authors: ["Ottoline Brackenridge"] });
  const base = { courseId: "c", courseName: "CS 400 Synthetic", deadlines: [], policy: { mode: "coaching" as const, evidence: "AI may explain concepts." } };
  store.ingest({
    source: { id: "canvas", label: "CS 400", kind: "canvas", accountScope: "acct", courseId: "c", scope: "course" },
    observedAt: at, status: "ok", complete: true,
    resources: [
      { ...base, externalId: "course", kind: "course", title: "CS 400 Synthetic", text: "", url: "https://canvas.wisc.edu/courses/5", course: { instructors: ["Ada Lovelace"] } },
      { ...base, externalId: "stacks", kind: "material", title: "Stacks", text: `${LESSON} ${IDENTITY} ${CONTENT.join(" ")} Professor Ada Lovelace teaches stacks.`, url: "https://canvas.wisc.edu/courses/5/pages/stacks" },
      { ...base, externalId: "lab1", kind: "assignment", title: "Lab 1", text: `Lab 1 with a partner. ${IDENTITY} ${CONTENT.join(" ")}`, url: "https://canvas.wisc.edu/courses/5/assignments/1",
        submission: { comments: [{ text: `Nice work. ${PERSONAL}`, authorName: "Ottoline Brackenridge" }] } },
      { ...base, externalId: "disc", kind: "message", title: "Week 3 discussion", text: `Reply from Ottoline Brackenridge. ${PERSONAL}`, url: "https://canvas.wisc.edu/courses/5/discussion_topics/3" },
    ],
  });
  store.ingest({
    source: { id: "notes", label: "OneNote", kind: "notes", accountScope: "acct", courseId: "c", scope: "graph_notes" },
    observedAt: at, status: "ok", complete: true,
    resources: [{ ...base, externalId: "note1", kind: "material", title: "My notes", text: `Notes on queues. ${PERSONAL}`, url: "https://onenote.com/p/1", notes: { sourceSubtype: "onenote", itemId: "pg1" } }],
  });
  store.ingest({
    source: { id: "mail", label: "Outlook mail", kind: "mail", accountScope: "acct", courseId: "outlook-mail", scope: "graph_mail" },
    observedAt: at, status: "ok", complete: true,
    resources: [{
      externalId: "mail:1", kind: "message", courseId: "outlook-mail", courseName: "Outlook mail", title: "Lab partner question from Ottoline Brackenridge",
      text: `Hi Quentin, it's Ottoline. ${PERSONAL}`, url: "https://outlook.office.com/mail/", deadlines: [],
      mail: { messageId: "m1", folder: "inbox", fromName: "Ottoline Brackenridge", fromAddress: "obrack@wisc.edu", receivedAt: at, preview: `Hi Quentin. My card is 5555 5555 5555 4444; I live at 1234 Canaryhill Street, call (608) 555-0142.`, category: "course", categoryReason: "Matched CS 400.", courseId: "c", courseAccountScope: "acct" },
    }],
  });
  store.ingestPlanning({
    schemaVersion: 1, id: "primary", accountScope: "academic", source: "uw_enroll", scope: { kind: "degree_plan", key: "primary" },
    sourceUrl: "https://enroll.wisc.edu/", observedAt: at, status: "complete", completeness: "complete", diagnostics: [],
    records: [{ kind: "course_history", id: "CANARYDARS-Quentin-Zabrowski", courseKey: "uw:266:400", termCode: "1264", grade: "AB", credits: 3, state: "completed", gpaEligible: null,
      provenance: { scope: { kind: "degree_plan", key: "primary" }, sourceUrl: "https://enroll.wisc.edu/", observedAt: at } }],
  });
  return store;
}

test("canary sweep: no canary leaves through any egress path, and quotes still validate", async () => {
  configurePseudonymKey(Buffer.alloc(32, 3));
  const store = seed();
  const recorded: { path: string; body: string }[] = [];
  const record = (path: string, body: unknown) => recorded.push({ path, body: typeof body === "string" ? body : JSON.stringify(body) });
  const judgment = {
    kind: "problem_set" as const,
    probabilities: { essay: 0.005, problem_set: 0.97, quiz: 0.005, exam: 0.005, discussion: 0.005, project: 0.005, reading: 0.005, other: 0 },
    model: "synthetic-model", questionVersion: "assignment.kind.v1" as const,
  };
  const core = createCore(store, {
    fixture: captureBatchSchema.parse(fixture),
    gateway: { async evaluate(payload: unknown) { record("jev.gateway", payload); return judgment; } },
  } as Parameters<typeof createCore>[1]);
  try {
    const live = store.resources().filter((r) => !r.deleted && r.kind !== "course");
    const stacks = live.find((r) => r.title === "Stacks")!;

    // 1. Context manifests (the explain path and its preview) for every resource and hosted recipient.
    let citation: { projectionId: string; text: string } | undefined;
    for (const r of live)
      for (const recipient of ["claude", "jev"] as const) {
        const m = (await core.execute({ type: "context", id: r.id, recipient })).manifest!;
        record(`context.${recipient}`, m.payload);
        assert.ok(m.protection && Object.keys(m.protection).length, "the manifest counts what was protected");
        if (r.id === stacks.id && recipient === "claude") citation = { projectionId: m.citationProjections![0]!.projectionId, text: m.payload.text };
      }
    // 2. Jev (the enrich drain through the gateway).
    const lab = live.find((r) => r.title === "Lab 1")!;
    await core.execute({ type: "enrich", id: lab.id });
    await core.settled();
    assert.ok(recorded.some((x) => x.path === "jev.gateway"), "the Jev gateway was called");
    const receipt = store.receipts().find((x) => x.recipient === "jev" && x.status === "sent");
    assert.ok(receipt?.protection?.student_name, "the Jev receipt records protected counts");
    assert.ok(!JSON.stringify(receipt).includes("Quentin"), "receipts carry counts, never values");

    // 3. Packs (quiz, cards) and the study-guide kinds through a recording client.
    const calls: BackendCall[] = [];
    const sourceId = `p${store.passages(stacks.id)[0]!.pid}`;
    const runner = createModelRunner({ backend: { client: "claude", async call(call) {
      calls.push(call);
      const quote = /\[STUDENT_[A-Z0-9]+\] explained that a stack is a last-in first-out collection\./.exec(call.input)?.[0] ?? "";
      return { value: { cards: [{ kind: "term", front: "Stack", back: "A last-in first-out collection", topics: ["Stacks"], section: "Collections", sourceId, quote }] }, usage: { in: 10, cached: 0, out: 10 }, model: "synthetic" };
    } } });
    const handler = createPackHandler({ store, artifacts: memoryArtifactStore(), runner: () => runner });
    const cards = await handler.run("cards", { courseId: "c" });
    assert.equal(cards.status, "done");
    await handler.run("quiz", { courseId: "c" });
    for (const kind of ["guide", "briefing", "faq", "timeline", "compare", "conceptmap"]) await handler.pack(kind, { courseId: "c" }, new AbortController().signal);
    assert.ok(calls.length >= 3, `pack calls: ${calls.length}`);
    for (const call of calls) record("pack.call", { systemPrompt: call.systemPrompt, input: call.input, courseId: call.courseId });
    // The quote the model returned (protected text) maps back to the exact original span.
    const saved = store.learning.items({ courseRef: "acct:c" }).map((x) => JSON.stringify(x));
    assert.ok(saved.some((x) => x.includes(LESSON)), "the stored quote is the original sentence");

    // 4. MCP tools (a hosted AI client reads through them).
    const token = "synthetic-canary-token";
    store.setMcpGrant({ id: "g", label: "Claude", recipient: "claude", enabled: true, courses: [{ accountScope: "acct", courseId: "c" }, { accountScope: "acct", courseId: "outlook-mail" }],
      categories: ["course_text", "grades", "comments", "communications"], tokenHash: createHash("sha256").update(token).digest("hex") });
    const mcp = createMcpService(store, "g", token);
    try {
      for (const r of live) {
        try { record("mcp.get_item", mcp.call("get_item", { id: r.id })); } catch { /* not granted: nothing leaves */ }
      }
      for (const query of ["stack", "Quentin Zabrowski", "lab partner"]) {
        record("mcp.search", mcp.call("search", { query }));
        record("mcp.answer", mcp.call("answer_course_question", { query }));
      }
      record("mcp.overview", mcp.call("course_overview", {}));
    } finally {
      await mcp.server.close();
    }

    // 5. Mail as a hosted prompt would read it (mail.gist): content protected, sender pseudonymised.
    const mail = store.resources().find((r) => r.mail)!;
    const session = pseudonymSession("mail.gist:acct");
    const projected = protectMail({ subject: mail.title, mail: mail.mail! }, accountRoster(store, "acct", "outlook-mail"), session);
    record("mail.gist", projected);
    assert.match(projected.fromAddress!, /^\[EMAIL_\d+\]$/);
    assert.match(projected.from!, /^\[STUDENT_\d+\]$/);

    // 6. Planning stays hard-blocked from every hosted recipient.
    for (const recipient of ["claude", "chatgpt", "gemini", "openrouter", "jev"]) assert.equal(maySend(store.privacy(), recipient, ["planning"]).allowed, false, recipient);

    // Controls: the canaries are really in the sources, the local route still sees them, and the
    // roster scrubber alone (before this layer) lets the non-roster identifiers through.
    const local = (await core.execute({ type: "context", id: stacks.id, recipient: "local" })).manifest!;
    assert.ok(JSON.stringify(local.payload).includes("Quentin Zabrowski"));
    const before = scrubText(PERSONAL, rosterFor(store, "c", "acct")).text;
    for (const leak of ["CANARYVERIFIER77", "Canaryhill", "03/14/2004", "4455667", "5555 5555 5555 4444", "219-09-9999"]) assert.ok(before.includes(leak), leak);
    assert.ok(recorded.filter((x) => x.path === "mcp.get_item").length >= 3, "MCP served items");
    // The sweep: nothing recorded carries a canary (case-insensitive).
    assert.ok(recorded.length > 20, `recorded ${recorded.length} payloads`);
    for (const { path, body } of recorded)
      for (const canary of CANARIES) assert.ok(!body.toLowerCase().includes(canary.toLowerCase()), `${canary} leaked through ${path}`);
    // Retained instructor names and the teaching content still reach the model unchanged.
    assert.ok(recorded.some((x) => x.body.includes("Ada Lovelace")));
    const stacksContext = recorded.find((x) => x.path === "context.claude" && x.body.includes("Stacks"))!.body;
    for (const kept of KEPT) assert.ok(stacksContext.includes(kept), `teaching content kept: ${kept}`);
    const cardsCall = recorded.find((x) => x.path === "pack.call")!.body;
    for (const kept of KEPT) assert.ok(cardsCall.includes(kept), `teaching content kept in the pack prompt: ${kept}`);

    // Citations against the protected projection still resolve to the original text.
    const quote = /\[STUDENT_[A-Z0-9]+\] explained that a stack/.exec(citation!.text)![0];
    const [checked] = validateProtectedCitations(store, [{ resourceId: stacks.id, contentHash: stacks.contentHash, projectionId: citation!.projectionId, quote }]);
    assert.equal(checked!.status, "supported");
    assert.equal(checked!.original!.text, "Quentin Zabrowski explained that a stack");
  } finally {
    await core.close();
    configurePseudonymKey(null);
  }
});
