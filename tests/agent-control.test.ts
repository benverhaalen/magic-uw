// owner: claude-chat. The voice agent's app-control tools: ids only, checked against the grant; the
// Canvas link is the stored one on the Canvas host, never a model-written URL.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@magic/storage";
import { defaultPrivacy, type ResourceInput, type Store } from "@magic/contracts";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import { createControlTools, refreshChatGrant, CHAT_GRANT_ID, ControlRefused } from "../packages/core/src/chat/index";

const at = "2099-01-01T12:00:00.000Z";
const item = (id: string, courseId: string, url: string): ResourceInput => ({
  externalId: id, kind: "assignment", courseId, courseName: courseId, title: `Item ${id}`, url, text: "Midterm review",
  deadlines: [], points: null, submitted: false, policy: { mode: "unknown", evidence: "" },
});
function ingest(store: Store, courseId: string, resources: ResourceInput[]) {
  store.ingest({ source: { id: `a/${courseId}`, label: courseId, kind: "canvas", accountScope: "a", courseId, scope: "assignments" }, observedAt: at, status: "ok", complete: true, readId: `r-${courseId}`, resources });
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "magic-agent-control-"));
  const store = createStore(join(dir, "w.sqlite"));
  ingest(store, "math", [item("ok", "math", "https://canvas.wisc.edu/courses/1/assignments/1"), item("ext", "math", "https://evil.example.com/x")]);
  ingest(store, "secret", [item("hid", "secret", "https://canvas.wisc.edu/courses/2/assignments/2")]);
  store.setCourseOverride({ accountScope: "a", courseId: "secret", included: false });
  store.setConsent!({ action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION }, at);
  store.setPrivacy({ ...defaultPrivacy, mode: "selective_cloud", hostedProvider: "claude", shareCourseText: true, shareStudentWork: true });
  const token = refreshChatGrant(store);
  const log: string[] = [];
  const tools = createControlTools(store, { clientId: CHAT_GRANT_ID, token }, {
    navigate: async (t) => (log.push(`nav ${t.page} ${t.resourceId ?? t.courseId ?? ""}`), true),
    openExternal: async (url) => void log.push(`open ${url}`),
    pack: async (name) => (log.push(`pack ${name}`), { status: "ready", message: "ok" }),
  });
  const id = (ext: string) => store.resources().find((r) => r.url.includes(ext === "ok" ? "/1/" : ext === "hid" ? "/2/" : "evil"))!.id;
  return { store, tools, log, id, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } };
}

test("open_in_canvas opens only the stored Canvas link; a model URL, a non-Canvas link and an excluded course are refused", async () => {
  const f = fixture();
  try {
    await f.tools.call("open_in_canvas", { itemId: f.id("ok") });
    assert.deepEqual(f.log, ["open https://canvas.wisc.edu/courses/1/assignments/1"]);
    await assert.rejects(f.tools.call("open_in_canvas", { url: "https://evil.example.com" }));
    await assert.rejects(f.tools.call("open_in_canvas", { itemId: f.id("ext") }), ControlRefused);
    await assert.rejects(f.tools.call("open_in_canvas", { itemId: f.id("hid") }), ControlRefused);
    await assert.rejects(f.tools.call("open_in_canvas", { itemId: "not-an-id" }), ControlRefused);
    assert.equal(f.log.length, 1, "nothing else opened");
    assert.ok(f.store.receipts().some((r) => r.purpose === "Chat control open_in_canvas" && r.resourceIds.includes(f.id("ok"))));
  } finally {
    f.cleanup();
  }
});

test("open_page validates the page and ids; prep runs the study-prep pack then opens the item's prep", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.tools.call("open_page", { page: "settings/../evil" }));
    await assert.rejects(f.tools.call("open_page", { page: "item" }), ControlRefused);
    await assert.rejects(f.tools.call("open_page", { page: "item", itemId: f.id("hid") }), ControlRefused);
    await assert.rejects(f.tools.call("open_page", { page: "course", courseId: "secret" }), ControlRefused);
    await f.tools.call("open_page", { page: "calendar" });
    await f.tools.call("prep_assessment", { itemId: f.id("ok") });
    assert.deepEqual(f.log, ["nav calendar ", "pack study-prep-guide-quiz-cards", `nav prep ${f.id("ok")}`]);
    // Sharing off: nothing is readable, so nothing opens.
    f.store.setPrivacy({ ...f.store.privacy(), shareCourseText: false, shareStudentWork: false });
    await assert.rejects(f.tools.call("show_flashcards", { itemId: f.id("ok") }));
  } finally {
    f.cleanup();
  }
});
