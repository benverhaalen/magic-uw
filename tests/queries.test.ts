import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { captureBatchSchema, queryRequestSchema, type QueryResult } from "@magic/contracts";
import fixture from "../fixtures/course.json";
import { syntheticCorpus, COURSES } from "../evals/perf/synthetic";

const batch = captureBatchSchema.parse(fixture);
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const LIMIT = 256 * 1024;
function narrow<V extends QueryResult["view"]>(result: QueryResult, view: V) {
  assert.equal(result.view, view);
  return result as Extract<QueryResult, { view: V }>;
}

test("at 5,000 resources the scoped views stay under 256 KB; the full snapshot stays for debugging", async (t) => {
  const store = createStore(":memory:");
  const corpus = syntheticCorpus(5000);
  for (const b of corpus.batches) store.ingest(b);
  const core = createCore(store, { fixture: batch, now: () => new Date("2026-09-26T16:00:00Z") });
  try {
    const full = bytes(await core.execute({ type: "snapshot" }));
    const summary = core.query({ view: "summary" });
    const course = COURSES[0]!.id;
    const page = core.query({ view: "resources", courseId: course, limit: 50 });
    const list = narrow(page, "resources");
    const one = core.query({ view: "resource", id: list.items[0]!.id });
    const report = {
      resources: corpus.resources,
      fullSnapshotBytes: full,
      summaryBytes: bytes(summary),
      coursePageBytes: bytes(page),
      oneResourceBytes: bytes(one),
      reduction: +(full / Math.max(bytes(summary), bytes(page))).toFixed(1),
    };
    t.diagnostic(JSON.stringify(report));
    assert.ok(full > 10 * LIMIT, "the full snapshot is the large payload this replaces");
    assert.ok(bytes(summary) <= LIMIT);
    assert.ok(bytes(page) <= LIMIT);
    assert.ok(bytes(one) <= LIMIT);
    assert.equal(narrow(summary, "summary").courses.length, COURSES.length);
    // The change cursor stays compact at volume, and a view can follow it right away.
    const request = queryRequestSchema.parse({ view: "changes", cursor: narrow(summary, "summary").changesCursor });
    assert.deepEqual(narrow(core.query(request), "changes").changes, []);
    // The debugging snapshot is unchanged: every resource, with its text.
    const snapshot = core.snapshot();
    assert.equal(snapshot.resources.length, store.resources().length);
    assert.ok(snapshot.resources.some((r) => r.text.length > 0));
  } finally {
    await core.close();
  }
});

test("resource pages are course-scoped, bodiless, in the snapshot's order, and cover the course once", async () => {
  const store = createStore(":memory:");
  for (const b of syntheticCorpus(600).batches) store.ingest(b);
  const core = createCore(store, { fixture: batch });
  try {
    const course = COURSES[1]!.id;
    const seen: string[] = [];
    let cursor: string | undefined,
      total = 0,
      pages = 0;
    do {
      const page = narrow(
        core.query({ view: "resources", courseId: course, limit: 37, ...(cursor ? { cursor } : {}) }),
        "resources",
      );
      total = page.total;
      pages++;
      for (const item of page.items) {
        assert.equal(item.courseId, course);
        assert.equal("text" in item, false);
        assert.equal("rawHtml" in item, false);
        assert.equal("parts" in item, false);
        assert.ok(item.excerpt.length <= 280);
        seen.push(item.id);
      }
      cursor = page.nextCursor;
    } while (cursor);
    assert.equal(seen.length, total);
    assert.equal(new Set(seen).size, total);
    assert.ok(pages > 1);
    const expected = core
      .snapshot()
      .resources.filter((r) => r.courseId === course)
      .map((r) => r.id);
    assert.deepEqual(seen, expected);
    const one = narrow(core.query({ view: "resource", id: seen[0]! }), "resource");
    assert.equal(typeof one.resource.text, "string");
    assert.throws(() => core.query({ view: "resources", cursor: "not-a-cursor" }), /Invalid cursor/);
    assert.equal(queryRequestSchema.safeParse({ view: "resources", limit: 1000 }).success, false);
    assert.equal(queryRequestSchema.safeParse({ view: "everything" }).success, false);
  } finally {
    await core.close();
  }
});

test("the change cursor returns only what changed after it, oldest first, and asks for a reload on overflow", async () => {
  const store = createStore(":memory:");
  const core = createCore(store, { fixture: batch });
  try {
    await core.execute({ type: "fixture" });
    const cursor = narrow(core.query({ view: "summary" }), "summary").changesCursor;
    const none = narrow(core.query({ view: "changes", cursor }), "changes");
    assert.deepEqual([none.changes.length, none.complete], [0, true]);
    const later = new Date(Date.now() + 60_000).toISOString();
    store.ingest({
      ...batch,
      observedAt: later,
      resources: batch.resources.map((r) => ({ ...r, title: `${r.title} (revised)` })),
    });
    const next = narrow(core.query({ view: "changes", cursor }), "changes");
    assert.ok(next.changes.length > 0);
    assert.ok(next.changes.every((c) => c.observedAt >= later));
    const sorted = [...next.changes].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
    assert.deepEqual(next.changes, sorted);
    const after = narrow(core.query({ view: "changes", cursor: next.cursor }), "changes");
    assert.deepEqual([after.changes.length, after.complete], [0, true]);
    const overflow = narrow(core.query({ view: "changes", cursor, limit: 1 }), "changes");
    assert.ok(next.changes.length > 1);
    assert.deepEqual([overflow.changes.length, overflow.complete, overflow.cursor], [0, false, cursor]);
  } finally {
    await core.close();
  }
});
