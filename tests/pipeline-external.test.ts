import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@magic/storage";
import { compileCourse, courseGraph } from "../packages/core/src/graph/index";
import { batches, course } from "./pipeline-fixture";

test("external links: one compact record per course and URL, first and last seen kept", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-ext-"));
  const file = join(dir, "w.sqlite");
  try {
    const store = createStore(file);
    for (const b of batches()) store.ingest(b);
    await compileCourse(store, course, "2026-10-01T10:00:00.000Z");
    // A second page links the same article with another query string: still one record.
    store.ingest({
      source: { id: "src-page:extra", label: "Example Canvas", kind: "canvas", accountScope: course.accountScope, courseId: course.courseId, scope: "page:extra" },
      observedAt: "2026-10-01T11:00:00.000Z",
      complete: true,
      status: "ok",
      resources: [
        {
          externalId: "p9", kind: "material", courseId: course.courseId, courseName: "Linear Algebra Example", title: "Extra reading",
          url: "https://canvas.wisc.edu/courses/101/pages/extra-reading", text: "See https://example.org/article?id=3 again.",
          deadlines: [], points: null, submitted: null, policy: { mode: "unknown", evidence: "" },
        },
      ],
    });
    await compileCourse(store, course, "2026-10-02T10:00:00.000Z");
    const refs = store.externalRefs(course);
    const article = refs.filter((r) => r.url.startsWith("https://example.org/article"));
    assert.equal(article.length, 1);
    assert.equal(article[0]!.url, "https://example.org/article");
    assert.equal(article[0]!.firstSeen, "2026-10-01T10:00:00.000Z");
    assert.equal(article[0]!.lastSeen, "2026-10-02T10:00:00.000Z");
    assert.equal(article[0]!.treatment, "link", "an unknown host stays a link until classified");
    const video = refs.find((r) => r.host === "www.youtube.com");
    assert.ok(video && video.hostClass && video.title === "Vectors video");
    // Nothing is fetched: the record holds only the URL, title and classification.
    assert.deepEqual(Object.keys(article[0]!).sort(), [
      "accountScope", "courseId", "firstSeen", "foundInResourceId", "host", "hostClass", "id", "lastSeen", "sourceId", "title", "treatment", "url",
    ]);

    // The coverage report sees the uncaptured file link and counts the external records.
    const graph = courseGraph(store, course);
    assert.ok(graph.coverage.unresolvedLinks.some((l) => l.target.includes("/files/5999")));
    assert.equal(graph.references.externalRecords, refs.length);
    assert.ok(graph.modules.length === 3 && graph.modules[0]!.items.length > 0);

    // Purge clears every new row.
    store.purge();
    store.close();
    const db = new DatabaseSync(file, { readOnly: true });
    for (const table of ["external_refs", "resource_refs", "material_facts", "passages", "jobs"])
      assert.equal(Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n), 0, table);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schema v9 migrates additively and stays at the store's version", () => {
  const store = createStore(":memory:");
  for (const b of batches()) store.ingest(b);
  assert.equal(store.externalRefs(course).length, 0);
  assert.equal(store.putResourceRefs("missing", "h", []).ok, false);
  store.close();

});
