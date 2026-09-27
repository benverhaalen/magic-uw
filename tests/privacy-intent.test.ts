// The command bar through the protection pass (docs/ai-and-privacy.md, "Egress coverage"): the
// classify call gets the student's command with people and credentials replaced; the grounded ask
// gets protected passages and question, and its quotes and sentences come back in the original
// words, checked by code against the original text. Entirely synthetic; a fake client.
import test from "node:test";
import assert from "node:assert/strict";
import { createCore } from "@magic/core";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import { createModelRunner, type BackendCall } from "../packages/runner/src/index";
import { memoryArtifactStore, memoryLedgerStore } from "../packages/packs/core/src/index";
import { createIntentRouter, type IntentHost } from "../packages/core/src/intent/index";
import { groundedAsk } from "../packages/core/src/intent/ask";
import { intentProtection } from "../packages/core/src/privacy/intent";
import { NOW, TZ, workspace } from "./intent-fixtures";

const CANARIES = ["Ottoline", "Brackenridge", "obrack@wisc.edu", "555-0142", "Quentin", "Zabrowski"];
const LESSON = "Ottoline Brackenridge explained that every recursive method needs a base case. Test it on 192.168.1.1 first.";
const host: IntentHost = { workspace: async (v) => ({ verb: v.verb, status: "ok", items: [] }) };

async function setup(reply: (call: BackendCall) => unknown) {
  const { store, batches } = workspace();
  store.recordAutoIdentity({ accountScope: "acct", self: { names: ["Quentin Zabrowski"], emails: [], netIds: [], studentIds: [] } });
  store.recordAutoIdentity({ accountScope: "acct", courseId: "c400", authors: ["Ottoline Brackenridge"] });
  store.ingest({
    source: { id: "canvas-c400-extra", kind: "canvas", accountScope: "acct", courseId: "c400", scope: "extra", label: "extra" },
    observedAt: NOW.toISOString(), complete: true, status: "ok",
    resources: [{ externalId: "lesson", kind: "material", courseId: "c400", courseName: "COMPSCI 400", title: "Base cases", text: LESSON, url: "https://canvas.example.test/lesson", deadlines: [], policy: { mode: "coaching", evidence: "AI may explain." } }],
  });
  const core = createCore(store, { fixture: batches[0]!, now: () => NOW });
  await core.execute({ type: "consent", value: { action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION } });
  const calls: BackendCall[] = [];
  const runner = createModelRunner({ backend: { client: "claude", async call(call) { calls.push(call); return { value: reply(call), usage: { in: 5, cached: 0, out: 5 }, model: "fake" }; } } });
  return { store, core, calls, runner };
}

test("classify: the command reaches the model protected, and the model's arguments come back in the student's words", async () => {
  const x = await setup((call) => {
    const person = /\[STUDENT_\d+\]/.exec(call.input)?.[0] ?? "none";
    return { action: "materials.search", args: { course: null, assignment: null, topics: null, date: null, time: null, query: `notes from ${person}`, kind: null, count: null, scope: null }, confidence: "high", alternatives: null, question: null };
  });
  const router = createIntentRouter({ store: x.store, runner: () => x.runner, now: () => NOW, timeZone: TZ });
  router.ready();
  const r = await router.handle({ text: "zq ask Ottoline Brackenridge (obrack@wisc.edu, 608-555-0142) what is due" }, host, new AbortController().signal);
  assert.equal(r.path, "ai", JSON.stringify(r));
  assert.equal(x.calls.length, 1);
  const sent = JSON.stringify(x.calls[0]);
  for (const c of CANARIES) assert.ok(!sent.includes(c) && !sent.includes(c.toLowerCase()), c);
  assert.equal(r.status, "ran");
  assert.equal(String((r as { args: { query?: string } }).args.query).toLowerCase(), "notes from ottoline brackenridge", "the placeholder is restored");
  await x.core.close();
});

test("ask: protected passages and question; quotes are checked against the original text; teaching content kept", async () => {
  const x = await setup((call) => {
    const sourceId = /\[(p\d+)\]|"(p\d+)"|(p\d+)/.exec(call.input)!.slice(1).find(Boolean)!;
    const quote = /\[STUDENT_\d+\] explained that every recursive method needs a base case\./.exec(call.input)![0];
    const who = quote.slice(0, quote.indexOf("]") + 1);
    return { found: true, sentences: [{ text: `${who} says every recursive method needs a base case.`, citations: [{ sourceId, quote }] }] };
  });
  const router = createIntentRouter({ store: x.store, runner: () => x.runner, now: () => NOW, timeZone: TZ });
  const courses = router.resolve.courses().filter((c) => c.courseId === "c400");
  const r = await groundedAsk(
    { store: x.store, runner: async () => x.runner, artifacts: memoryArtifactStore(), ledger: memoryLedgerStore(), now: () => NOW, protection: intentProtection(x.store) },
    "what did Ottoline Brackenridge say about base cases",
    courses,
    new AbortController().signal,
  );
  assert.equal(x.calls.length, 1);
  const sent = JSON.stringify(x.calls[0]);
  for (const c of CANARIES) assert.ok(!sent.includes(c), c);
  assert.ok(sent.includes("192.168.1.1"), "teaching content is kept");
  assert.equal(r.notFound, false, JSON.stringify(r));
  assert.equal(r.citations[0]!.quote, "Ottoline Brackenridge explained that every recursive method needs a base case.");
  assert.ok(r.citations[0]!.start !== null, "the quote is located in the original text");
  assert.match(r.text, /^Ottoline Brackenridge says every recursive method needs a base case\./);
  await x.core.close();
});
