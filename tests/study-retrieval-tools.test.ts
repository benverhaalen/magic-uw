import assert from "node:assert/strict";
import { test } from "node:test";
import type { Resource, SourceHealth } from "@magic/contracts";
import { textHash } from "../packages/retrieval/src/index";
import { courseSearch, runStudyToolLoop, StudyToolError, type StudyToolStore } from "../packages/runner/src/study-retrieval";
import type { ModelBackend } from "../packages/runner/src/types";

function fixture() {
  const make = (id: string, sourceId: string, text: string) => ({
    id, sourceId, courseId: "course-a", title: id, text, contentHash: `hash-${id}`,
    version: 1, deleted: false, kind: "material", policy: { mode: "allowed", evidence: "" },
    observedAt: "2026-09-27T00:00:00Z", url: `https://example.test/${id}`, deadlines: [],
  }) as unknown as Resource;
  const a = make("selected", "signed-in", "Mitosis has prophase, metaphase, anaphase, and telophase.");
  const b = make("unselected", "signed-in", "Mitosis mitosis mitosis mitosis in a different source.");
  const c = make("other-account", "other", "Mitosis mitosis mitosis in another account.");
  const sources = [
    { id: "signed-in", accountScope: "account-a", courseId: "course-a" },
    { id: "other", accountScope: "account-b", courseId: "course-a" },
  ] as SourceHealth[];
  const resources = new Map([a, b, c].map((r) => [r.id, r]));
  const passages = new Map([a, b, c].map((r, i) => [r.id, [{ pid: i + 1, resourceId: r.id, version: 1, textHash: textHash(r.title, r.text), ord: 0, start: 0, end: r.text.length, page: null, slide: null, tStart: null, tEnd: null, heading: null, tokEst: 20, redacted: false }]]));
  const store = {
    resource: (id: string) => resources.get(id), sources: () => sources,
    courseIntelligence: () => [], passages: (id: string) => passages.get(id) ?? [],
    passage: (pid: number) => {
      const r = [a, b, c][pid - 1]; const p = r && passages.get(r.id)?.[0];
      return r && p ? { passage: p, text: r.text, title: r.title, url: r.url } : undefined;
    },
  } as StudyToolStore;
  return { a, b, c, store, resources };
}
function backend(actions: unknown[]) {
  let calls = 0;
  return { client: "codex" as const, async call() { return { value: actions[calls++], usage: { in: 1, cached: 0, out: 1 }, model: "fixture" }; }, count: () => calls } satisfies ModelBackend & { count: () => number };
}
test("selected IDs filter before ranking and top-k", () => {
  const { a, store } = fixture();
  const found = courseSearch(store, [a], "mitosis", 1);
  assert.deepEqual(found.map((h) => h.citation.resourceId), ["selected"]);
  assert.equal(found[0]?.citation.quote, a.text);
});
test("agent search and read produce typed receipts without broad tool access", async () => {
  const { a, store } = fixture();
  let calls = 0;
  const model = { client: "codex" as const, async call(call: { input: string }) {
    calls++;
    const observation = JSON.parse(call.input).observation as string;
    const action = calls === 1 ? { action: "search", query: "mitosis" } : calls === 2 ? { action: "read", pid: 1 } : { action: "finish", answer: "Mitosis has four listed phases.", citationIds: [JSON.parse(observation).items[0].citationId] };
    return { value: action, usage: { in: 1, cached: 0, out: 1 }, model: "fixture" };
  } } satisfies ModelBackend;
  const result = await runStudyToolLoop({ store, backend: model, grant: { accountScope: "account-a", courseId: "course-a", coveredResourceIds: ["selected"], selected: [{ resourceId: a.id, contentHash: a.contentHash }] }, question: "What is mitosis?", authorizeEgress: () => true });
  assert.deepEqual(result.toolReceipts.map((r) => r.action), ["search", "read"]);
  assert.deepEqual(result.toolReceipts.map((r) => r.resourceIds), [["selected"], ["selected"]]);
  assert.equal(result.model, "fixture");
  assert.equal(result.citations.length, 1);
  assert.equal(result.sources[0]?.resourceId, "selected");
});
test("cross-account, changed hash, consent and cancellation fail before egress", async () => {
  const { a, c, store } = fixture();
  const model = backend([]);
  const base = { store, backend: model, question: "What is mitosis?", authorizeEgress: () => true };
  await assert.rejects(runStudyToolLoop({ ...base, grant: { accountScope: "account-a", courseId: "course-a", coveredResourceIds: ["selected"], selected: [{ resourceId: c.id, contentHash: c.contentHash }] } }), (e: unknown) => e instanceof StudyToolError && e.code === "invalid_grant");
  await assert.rejects(runStudyToolLoop({ ...base, grant: { accountScope: "account-a", courseId: "course-a", coveredResourceIds: ["selected"], selected: [{ resourceId: a.id, contentHash: "old" }] } }), (e: unknown) => e instanceof StudyToolError && e.code === "scope_changed");
  await assert.rejects(runStudyToolLoop({ ...base, grant: { accountScope: "account-a", courseId: "course-a", coveredResourceIds: ["selected"], selected: [{ resourceId: a.id, contentHash: a.contentHash }] }, authorizeEgress: () => false }), (e: unknown) => e instanceof StudyToolError && e.code === "egress_denied");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runStudyToolLoop({ ...base, grant: { accountScope: "account-a", courseId: "course-a", coveredResourceIds: ["selected"], selected: [{ resourceId: a.id, contentHash: a.contentHash }] }, signal: controller.signal }), (e: unknown) => e instanceof StudyToolError && e.code === "aborted");
  assert.equal(model.count(), 0);
});
