// The agent API v1: versioned, typed, read-only reads through a scoped grant, the sharing gate and
// the scrub projection, each within its token budget with one receipt; and the seq change cursor.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { captureBatchSchema, defaultPrivacy, type EgressReceipt, type QueryResult, type ResourceInput } from "@magic/contracts";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import { BUDGET_TOKENS, CONTRACT, createReadApi, SUPPORTED_VERSIONS, v1 } from "@magic/agent-api";
import { CHARS_PER_TOKEN } from "../packages/agent-api/src/budget";
import fixture from "../fixtures/course.json";

const at = "2026-09-26T12:00:00.000Z";
const token = "a".repeat(64);
const item = (externalId: string, extra: Partial<ResourceInput> = {}): ResourceInput => ({
  externalId,
  kind: "assignment",
  courseId: "c",
  courseName: "Genetics",
  title: `Problem set ${externalId}`,
  url: `https://canvas.example.test/courses/1/assignments/${externalId}`,
  text: `Punnett squares for problem set ${externalId}. Riley Stone asked about dominance.`,
  deadlines: [],
  policy: { mode: "unknown", evidence: "" },
  points: null,
  submitted: false,
  ...extra,
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "magic-agent-api-"));
  const file = join(dir, "workspace.sqlite");
  const writer = createStore(file);
  writer.setConsent!({ action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION }, at);
  writer.setPrivacy({ ...defaultPrivacy, mode: "selective_cloud", hostedProvider: "claude", shareCourseText: true });
  writer.setMcpGrant({
    id: "dev",
    label: "Study tool",
    recipient: "claude",
    enabled: true,
    courses: [{ accountScope: "a", courseId: "c" }],
    categories: ["course_text"],
    tokenHash: createHash("sha256").update(token).digest("hex"),
  });
  writer.ingest({
    source: { id: "s", label: "Assignments", kind: "canvas", accountScope: "a", courseId: "c", scope: "assignments" },
    observedAt: at,
    status: "ok",
    complete: true,
    resources: [
      item("1", {
        deadlines: [{ value: "2026-09-30T04:59:00.000Z", kind: "due", quote: "Due Sept 29", authority: "structured", scopeConfirmed: true }],
      }),
      item("2"),
      item("3", { kind: "material", title: "Mendel reading", text: "Mendel crossed peas. ".repeat(4000) }),
    ],
  });
  writer.ingest({
    source: { id: "x", label: "Other", kind: "canvas", accountScope: "a", courseId: "other", scope: "assignments" },
    observedAt: at,
    status: "ok",
    complete: true,
    resources: [item("9", { courseId: "other", title: "Not granted" })],
  });
  writer.recordAutoIdentity({ accountScope: "a", courseId: "c", authors: ["Riley Stone"] });
  writer.close();
  const reader = createStore(file, { readOnly: true });
  const receipts: EgressReceipt[] = [];
  const api = createReadApi(reader, { clientId: "dev", token }, { now: () => new Date(at), recordReceipt: (r) => void receipts.push(r) });
  return {
    api,
    reader,
    receipts,
    file,
    cleanup() {
      reader.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("v1 is versioned and every verb reads through the grant, scrubbed, in budget, with one receipt", () => {
  const f = setup();
  try {
    assert.deepEqual([...SUPPORTED_VERSIONS], ["1"]);
    assert.equal(f.api.contract, CONTRACT);
    assert.equal(f.api.version, v1.VERSION);
    const courses = f.api.courses();
    assert.deepEqual(courses.courses.map((c) => [c.courseId, c.resources, c.openAssignments, c.nextDueAt]), [
      ["c", 3, 2, "2026-09-30T04:59:00.000Z"],
    ]);
    const graph = f.api.courseGraph({ courseId: "c" }).graph!;
    assert.deepEqual([graph.kinds.assignment, graph.kinds.material, graph.assignmentsWithoutDueDate], [2, 1, 1]);
    assert.equal(f.api.courseGraph({ courseId: "other" }).graph, null, "an ungranted course reads as absent");
    const page = f.api.resources({ limit: 2 });
    assert.equal(page.total, 3);
    assert.equal(page.items.length, 2);
    for (const row of page.items) assert.equal("text" in row, false, "list rows carry no bodies");
    const rest = f.api.resources({ cursor: page.nextCursor });
    assert.equal(rest.items.length, 1);
    assert.equal(rest.nextCursor, undefined);
    const one = f.api.resource({ id: page.items[0]!.id }).item!;
    assert.match(one.text, /\[STUDENT_1\] asked about dominance/);
    const hits = f.api.searchPassages({ query: "Punnett squares" }).hits;
    assert.ok(hits.length >= 2);
    assert.equal(JSON.stringify(hits).includes("Riley"), false);
    const due = f.api.assignments({ days: 7 }).items;
    assert.deepEqual(due.map((a) => a.title), ["Problem set 1"]);
    assert.equal(f.api.assignments().items.length, 2);
    assert.equal(f.api.agenda().status, "not_built");
    const reading = f.api.resource({ id: rest.items[0]!.id });
    assert.ok(JSON.stringify(reading).length <= BUDGET_TOKENS.resource * CHARS_PER_TOKEN);
    assert.equal(f.receipts.length, 11, "one receipt per call");
    assert.ok(f.receipts.every((r) => r.purpose.startsWith("agent-api v1 ") && r.recipient === "claude"));
    assert.equal(f.reader.receipts().length, 0, "the read-only store was never written");
  } finally {
    f.cleanup();
  }
});

test("v1 refuses a revoked grant on the next call, a wrong token, and invalid input", () => {
  const f = setup();
  try {
    assert.equal(f.api.courses().courses.length, 1);
    const wrong = createReadApi(f.reader, { clientId: "dev", token: "b".repeat(64) });
    assert.throws(() => wrong.courses(), /revoked/);
    assert.throws(() => f.api.resources({ limit: 1000 }));
    assert.throws(() => f.api.resource({ id: "missing" }), /permissions/);
    const writer = createStore(f.file);
    try {
      const grant = writer.mcpGrants()[0]!;
      writer.setMcpGrant({ ...grant, enabled: false });
    } finally {
      writer.close();
    }
    assert.throws(() => f.api.courses(), /revoked/);
  } finally {
    f.cleanup();
  }
});

function narrow<V extends QueryResult["view"]>(result: QueryResult, view: V) {
  assert.equal(result.view, view);
  return result as Extract<QueryResult, { view: V }>;
}
test("core.query pages changes forward exactly with the seq cursor, however many changed", async () => {
  const store = createStore(":memory:");
  const batch = captureBatchSchema.parse(fixture);
  const core = createCore(store, { fixture: batch });
  try {
    await core.execute({ type: "fixture" });
    const start = narrow(core.query({ view: "summary" }), "summary").changesCursor;
    const caughtUp = narrow(core.query({ view: "changes", cursor: start }), "changes");
    assert.equal(caughtUp.complete, true);
    const later = new Date(Date.now() + 60_000).toISOString();
    store.ingest({ ...batch, observedAt: later, resources: batch.resources.map((r) => ({ ...r, title: `${r.title} (revised)` })) });
    const expected = store.changes({ since: later, limit: 2000 }).map((c) => c.id);
    assert.ok(expected.length > 3);
    const seen: string[] = [];
    let cursor = caughtUp.cursor;
    for (let pages = 0; pages < 100; pages++) {
      const page = narrow(core.query({ view: "changes", cursor, limit: 2 }), "changes");
      assert.ok(page.changes.length <= 2);
      seen.push(...page.changes.map((c) => c.id));
      cursor = page.cursor;
      if (page.complete) break;
    }
    assert.deepEqual(new Set(seen), new Set(expected));
    assert.equal(seen.length, expected.length, "no change twice");
    const after = narrow(core.query({ view: "changes", cursor }), "changes");
    assert.deepEqual([after.changes.length, after.complete], [0, true]);
  } finally {
    await core.close();
  }
});
