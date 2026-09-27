// MCP search runs on the passage FTS index (BM25, OR) scoped to the grant's account × course
// pairs; its ranking agrees with the scrubbed projection it returns; results fit a token budget.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createStore } from "@magic/storage";
import { defaultPrivacy, type ResourceInput, type Store } from "@magic/contracts";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import { createMcpService, MCP_BUDGET_TOKENS } from "../packages/core/src/mcp";
import { CHARS_PER_TOKEN } from "../packages/agent-api/src/budget";

const at = "2026-09-26T12:00:00.000Z";
const token = "f".repeat(64);
const item = (externalId: string, title: string, text: string, courseId = "c"): ResourceInput => ({
  externalId,
  kind: "material",
  courseId,
  courseName: "Course",
  title,
  url: `https://canvas.example.test/courses/1/pages/${externalId}`,
  text,
  deadlines: [],
  policy: { mode: "unknown", evidence: "" },
  points: null,
  submitted: false,
});
function ingest(store: Store, accountScope: string, courseId: string, resources: ResourceInput[]) {
  store.ingest({
    source: { id: `${accountScope}/${courseId}`, label: "Pages", kind: "canvas", accountScope, courseId, scope: "pages" },
    observedAt: at,
    status: "ok",
    complete: true,
    resources,
  });
}
function setup(recipient: "local" | "claude" = "local") {
  const store = createStore(":memory:");
  if (recipient === "claude") {
    store.setConsent!({ action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION }, at);
    store.setPrivacy({ ...defaultPrivacy, mode: "selective_cloud", hostedProvider: "claude", shareCourseText: true });
  }
  store.setMcpGrant({
    id: "g",
    label: "t",
    recipient,
    enabled: true,
    courses: [{ accountScope: "a", courseId: "c" }],
    categories: ["course_text"],
    tokenHash: createHash("sha256").update(token).digest("hex"),
  });
  return store;
}
type Hit = { id: string; title: string; text: string; excerpt: { start: number; end: number } };

test("search ranks by BM25 within the grant's account and course only", async () => {
  const store = setup();
  ingest(store, "a", "c", [
    item("title", "Glycolysis overview", "Glycolysis splits glucose. Glycolysis yields pyruvate."),
    item("body", "Week 3 notes", "The lecture ends with a short note on glycolysis."),
    item("none", "Syllabus", "Office hours are on Tuesdays."),
  ]);
  ingest(store, "b", "c", [item("foreign-account", "Glycolysis in account b", "glycolysis glycolysis glycolysis")]);
  ingest(store, "a", "other", [item("foreign-course", "Glycolysis elsewhere", "glycolysis glycolysis", "other")]);
  const mcp = createMcpService(store, "g", token);
  try {
    const hits = mcp.call("search", { query: "glycolysis" }) as Hit[];
    assert.deepEqual(hits.map((h) => h.title), ["Glycolysis overview", "Week 3 notes"]);
    const answer = mcp.call("answer_course_question", { query: "What does glycolysis yield?" }) as { evidence: Hit[] };
    assert.equal(answer.evidence[0]!.title, "Glycolysis overview");
    assert.deepEqual(mcp.call("search", { query: "photosynthesis" }), []);
  } finally {
    await mcp.server.close();
    store.close();
  }
});

test("a match only inside a scrubbed name is not returned, so names can't be probed through ranking", async () => {
  const store = setup("claude");
  ingest(store, "a", "c", [
    item("named", "Peer notes", "Jordan Quill wrote the feedback."),
    item("topic", "Rubric", "Specific feedback earns full credit."),
  ]);
  store.recordAutoIdentity({ accountScope: "a", courseId: "c", authors: ["Jordan Quill"] });
  const mcp = createMcpService(store, "g", token);
  try {
    assert.deepEqual(mcp.call("search", { query: "Jordan" }), [], "the only match was the scrubbed student name");
    assert.deepEqual(mcp.call("search", { query: "Jordan Quill" }), []);
    const hits = mcp.call("search", { query: "wrote" }) as Hit[];
    assert.deepEqual(hits.map((h) => h.title), ["Peer notes"]);
    assert.equal(hits[0]!.text, "[STUDENT_1] wrote the feedback.");
  } finally {
    await mcp.server.close();
    store.close();
  }
});

test("oversized results are trimmed to the tool's token budget around the match, never refused", async () => {
  const store = setup();
  const filler = "Background material without the keyword. ".repeat(3500); // ~147k characters
  ingest(store, "a", "c", [
    item("huge", "Long reading", `${filler}The chemiosmosis passage sits at the end.`),
    ...Array.from({ length: 30 }, (_, i) => item(`m${i}`, `Module ${i}`, `chemiosmosis ${"detail ".repeat(3000)}`)),
  ]);
  const mcp = createMcpService(store, "g", token);
  try {
    const huge = store.resources().find((r) => r.title === "Long reading")!;
    const one = mcp.call("get_item", { id: huge.id }) as Hit;
    assert.ok(JSON.stringify(one).length <= MCP_BUDGET_TOKENS.get_item * CHARS_PER_TOKEN);
    const hits = mcp.call("search", { query: "chemiosmosis", limit: 50 }) as Hit[];
    assert.ok(hits.length > 1);
    assert.ok(JSON.stringify(hits).length <= MCP_BUDGET_TOKENS.search * CHARS_PER_TOKEN);
    const long = mcp.call("answer_course_question", { query: "chemiosmosis passage end" }) as { evidence: Hit[] };
    const found = long.evidence.find((h) => h.title === "Long reading");
    assert.ok(found, "the late match is found");
    assert.ok(found.text.includes("chemiosmosis passage"), "the excerpt is cut around the match");
    assert.ok(found.excerpt.start > 140_000);
    const receipt = store.receipts().at(-1)!;
    assert.equal(receipt.characters, JSON.stringify(long).length, "the receipt counts what was sent");
  } finally {
    await mcp.server.close();
    store.close();
  }
});
