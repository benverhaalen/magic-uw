// The static routing table (packages/core/src/intent/routes.ts) is complete and is what the router
// runs: every registered command action and every ask kind has a route naming its evidence; a code
// route never acquires the student's client; the ask (a model route) lands on the session the bar
// pre-warmed for the open course, with no classify call.
import test from "node:test";
import assert from "node:assert/strict";
import { createCore } from "@magic/core";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import type { IntentCommandResult } from "@magic/contracts";
import { createModelRunner, type BackendCall, type WarmRequest } from "../packages/runner/src/index";
import { notesActions } from "../packages/notes/src/actions";
import { classifyPack } from "../packages/packs/intent/src/index";
import { createIntentRouter, fromNotes, type IntentHost, type NotesSeam } from "../packages/core/src/intent/index";
import { ACTION_ROUTES, ASK_ROUTES, BACKGROUND_ROUTES, routeOf, type AskKind, type Route } from "../packages/core/src/intent/routes";
import { NOW, TZ, workspace } from "./intent-fixtures";

const seam: NotesSeam = { handle: async () => ({ status: "ok" }), sessionOn: () => null };
const host: IntentHost = { workspace: async (v) => ({ verb: v.verb, status: "ok", items: [] }) };

async function setup() {
  const { store, batches } = workspace();
  const calls: BackendCall[] = [];
  const warmed: WarmRequest[] = [];
  let acquired = 0;
  const runner = createModelRunner({
    backend: {
      client: "claude",
      call: async (call) => (calls.push(call), { value: { found: false, sentences: [] }, usage: { in: 1, cached: 0, out: 1 }, model: "fake" }),
    },
  });
  const router = createIntentRouter({
    store,
    runner: () => (acquired++, runner),
    now: () => NOW,
    timeZone: TZ,
    actions: fromNotes({ notesActions }, seam),
    warm: async (r) => (warmed.push(r), true),
  });
  const core = createCore(store, { fixture: batches[0]!, now: () => NOW, timeZone: TZ, seams: { intent: router } });
  await core.execute({ type: "consent", value: { action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION } });
  return { router, calls, warmed, acquired: () => acquired, core };
}

test("every registered command action and every ask kind has a route, and every route names its evidence", async () => {
  const { router, core } = await setup();
  try {
    const registered = router.registry.list().map((a) => a.name);
    for (const name of registered) assert.ok(routeOf(name), `action ${name} has no route in routes.ts`);
    for (const name of Object.keys(ACTION_ROUTES)) assert.ok(registered.includes(name), `routes.ts lists ${name}, which no longer exists`);
    const kinds: AskKind[] = ["explain", "exam", "followUp", "allCourses", "notInMaterials"];
    assert.deepEqual(Object.keys(ASK_ROUTES).sort(), [...kinds].sort());
    const all: [string, Route][] = [...Object.entries(ACTION_ROUTES), ...Object.entries(ASK_ROUTES), ...Object.entries(BACKGROUND_ROUTES)];
    for (const [name, r] of all) {
      assert.ok(r.evidence.trim().length > 10, `${name} names no evidence`);
      if (r.route !== "code") assert.ok(["pass", "strong"].includes(r.tier) && ["interactive", "background"].includes(r.lane), `${name}: tier and lane`);
    }
    // The measured split (semester model rows 1-10): code answers due, changes, slides, grade and GPA
    // what-ifs; the model explains and answers exam questions; Jev only triages messages and kinds.
    for (const name of ["agenda.due", "changes.since", "materials.search", "grades.whatif", "grades.gpa"]) assert.equal(routeOf(name)?.route, "code", name);
    assert.equal(routeOf("ask")?.route, "model");
    assert.deepEqual(all.filter(([, r]) => r.route === "jev").map(([n]) => n).sort(), ["assignmentKind", "messageTriage"]);
  } finally {
    await core.close();
  }
});

test("a code route never acquires the student's client; the ask goes to the pre-warmed course session with no classify call", async () => {
  const h = await setup();
  try {
    for (const text of ["what's due tomorrow", "search for utilitarianism", "go to philosophy", "quiz me on recursion in cs 400", "flashcards due for econ"]) {
      const r = (await h.core.execute({ type: "command", value: { text } })).command as IntentCommandResult;
      assert.equal(r.path, "code", text);
      assert.equal(routeOf(r.status === "ran" ? r.action : "")?.route, "code", text);
    }
    assert.equal(h.acquired(), 0, "code routes never asked for the client");
    assert.equal(h.calls.length, 0);

    await h.core.execute({ type: "command", value: { text: "", mode: "prewarm", context: { courseId: "c400" } } });
    const askWarm = h.warmed.find((w) => w.pack.id !== classifyPack.id);
    assert.ok(askWarm, "the bar's prewarm warmed the open course's ask session");
    const r = (await h.core.execute({ type: "command", value: { text: "what does every recursive method need", context: { courseId: "c400" } } })).command as IntentCommandResult;
    assert.equal(r.path, "code", "code placed the ask");
    assert.equal(h.calls.length, 1, "one call: the ask, no classify");
    const [call] = h.calls;
    assert.notEqual(call!.pack.id, classifyPack.id);
    assert.equal(call!.lane, "interactive");
    assert.equal(call!.systemPrompt, askWarm.systemPrompt, "the ask's prefix is the one the prewarm started");
    assert.equal(call!.courseId, askWarm.courseId);
  } finally {
    await h.core.close();
  }
});
