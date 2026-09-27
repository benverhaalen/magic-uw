/**
 * Repeated work removed from the read paths: each fix gives the same output as the per-item path
 * it replaced, with fewer statements. Statements are counted at node:sqlite (every executed
 * statement), so an N+1 that comes back fails here whatever the machine's speed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { createStore } from "@magic/storage";
import { judgmentResultSchema } from "@magic/ai";
import { courseIncluded, courseInclusion } from "../packages/core/src/access";
import { codeAssignmentKind, resourceViews, runQuery } from "../packages/core/src/queries";
import { agenda, compileCourse, courseGraph, courseIndex, graphCall, references } from "../packages/core/src/graph/index";
import { readOnce } from "../packages/core/src/graph/read-once";
import { selectGuideInputs } from "../packages/packs/guide/src/inputs";
import { coverage } from "../packages/retrieval/src/search";
import { syntheticCorpus } from "../evals/perf/synthetic";
import { batches, course, NOW, seededStore, TODAY, TZ } from "./pipeline-fixture";

// ------------------------------------------------------------------ statement counter
const executed: string[] = [];
let recording = false;
for (const method of ["all", "get", "run", "iterate"] as const) {
  const original = StatementSync.prototype[method] as (...args: unknown[]) => unknown;
  (StatementSync.prototype as unknown as Record<string, unknown>)[method] = function (this: StatementSync, ...args: unknown[]) {
    if (recording) executed.push(this.sourceSQL);
    return original.apply(this, args);
  };
}
function counted<T>(run: () => T): { value: T; sql: string[] } {
  executed.length = 0;
  recording = true;
  try {
    return { value: run(), sql: [...executed] };
  } finally {
    recording = false;
  }
}
const LIST = /FROM resources r JOIN resource_versions v[\s\S]*WHERE r\.deleted = 0 ORDER BY r\.source_id, r\.external_id/;
const INVENTORY = /SELECT r\.id, r\.content_hash FROM resources r JOIN sources s/;

function fileStore() {
  const directory = mkdtempSync(join(tmpdir(), "magic-repeat-"));
  const file = join(directory, "workspace.sqlite");
  const store = createStore(file);
  return {
    store,
    file,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("storage: a resource list is one statement; fieldLastSeen equals the per-resource read, key order included", () => {
  const { store, file, close } = fileStore();
  const reference = new DatabaseSync(file, { readOnly: true });
  try {
    for (const b of batches()) store.ingest(b);
    // A later read of one source moves some fields' last-seen time forward.
    const later = batches()[0]!;
    store.ingest({ ...later, observedAt: "2026-10-02T15:00:00.000Z" });
    const perResource = reference.prepare("SELECT field, observed_at FROM field_observations WHERE resource_id = ?");
    const expected = (id: string) =>
      JSON.stringify(
        Object.fromEntries((perResource.all(id) as { field: string; observed_at: string }[]).map((v) => [String(v.field), String(v.observed_at)])),
      );

    const { value: all, sql } = counted(() => store.resources());
    assert.equal(sql.length, 1, "one statement for every resource");
    assert.ok(all.length > 10);
    assert.ok(all.some((r) => Object.keys(r.fieldLastSeen ?? {}).length > 1));
    assert.ok(new Set(all.flatMap((r) => Object.values(r.fieldLastSeen ?? {}))).size > 1, "more than one observation time");
    for (const r of all) assert.equal(JSON.stringify(r.fieldLastSeen), expected(r.id), r.id);

    // Every other reader of resource rows returns the same fieldLastSeen.
    const one = counted(() => store.resource(all[0]!.id));
    assert.equal(one.sql.length, 1);
    assert.equal(JSON.stringify(one.value!.fieldLastSeen), expected(all[0]!.id));
    for (const r of store.sourceResources(all[0]!.sourceId)) assert.equal(JSON.stringify(r.fieldLastSeen), expected(r.id));
    for (const r of store.courseResources(course)) assert.equal(JSON.stringify(r.fieldLastSeen), expected(r.id));
    for (const r of store.resources("matrix")) assert.equal(JSON.stringify(r.fieldLastSeen), expected(r.id));
  } finally {
    reference.close();
    close();
  }
});

test("summary: inclusion and evidence read every resource once; rows match per-resource inclusion", () => {
  const store = seededStore();
  try {
    for (const b of syntheticCorpus(60).batches) store.ingest(b);
    store.setCourseOverride({ accountScope: "perf-synthetic", courseId: "perf-102", included: false });
    const context = { now: () => NOW, gatewayConfigured: false };
    const { value: summary, sql } = counted(() => runQuery(store, { view: "summary" }, context));
    assert.equal(sql.filter((s) => LIST.test(s)).length, 1, "every resource is read once, whatever the number of courses");
    assert.ok(summary.view === "summary");
    const courses = summary.courses;
    assert.ok(courses.length >= 6);
    assert.ok(courses.some((c) => !c.included) && courses.some((c) => c.included));
    const scopes = new Map(store.sources().map((s) => [s.id, s.accountScope]));
    for (const row of courses) {
      const r = store.resources().find((x) => x.courseId === row.courseId && scopes.get(x.sourceId) === row.accountScope)!;
      assert.equal(row.included, courseIncluded(store, r), row.courseId);
    }

    // The evidence reuses the caller's list: the same views, one list read fewer.
    const all = store.resources();
    const list = all.filter((r) => r.kind === "assignment");
    const fresh = counted(() => resourceViews(store, list));
    const shared = counted(() => resourceViews(store, list, all));
    assert.deepEqual(shared.value, fresh.value);
    assert.equal(fresh.sql.filter((s) => LIST.test(s)).length, 1);
    assert.equal(shared.sql.filter((s) => LIST.test(s)).length, 0);

    // readOnce serves only the unsearched list; inclusion decides the same for every resource.
    const once = readOnce(store, all);
    const included = counted(() => courseInclusion(once));
    assert.equal(included.sql.filter((s) => LIST.test(s)).length, 0);
    const direct = courseInclusion(store);
    for (const r of all) assert.equal(included.value(r), direct(r), r.id);
    assert.deepEqual(once.resources("matrix"), store.resources("matrix"));
  } finally {
    store.close();
  }
});

test("resource views: the kind label comes from the last current kind judgment, as findLast picked it", () => {
  const store = seededStore();
  try {
    // An assignment whose kind code cannot decide, so the judgment decides the label.
    const assignment = store.resources().find((r) => r.kind === "assignment" && codeAssignmentKind(r) === null)!;
    assert.ok(assignment);
    const kinds = judgmentResultSchema.shape.kind.options.filter((k) => k !== "other");
    const judge = (key: string, inputHash: string, kind: (typeof kinds)[number], createdAt: string) =>
      assert.ok(
        store.putJudgment({
          key,
          resourceId: assignment.id,
          inputHash,
          model: "test",
          questionVersion: "assignment.kind.v1",
          result: { kind, probabilities: { [kind]: 0.95 }, model: "test", questionVersion: "assignment.kind.v1" },
          createdAt,
        }),
      );
    judge(`${assignment.id}:content`, assignment.contentHash, kinds[0]!, "2026-10-01T10:00:00.000Z");
    judge(`${assignment.id}:text`, store.resourceTextHash(assignment.id)!, kinds[1]!, "2026-10-01T11:00:00.000Z");
    const last = store.judgments().findLast((j) => j.resourceId === assignment.id && j.questionVersion === "assignment.kind.v1")!;
    assert.equal(store.judgments().filter((j) => j.resourceId === assignment.id).length, 2, "both judgments are current");
    const [view] = resourceViews(store, [assignment]);
    assert.equal(view!.kindLabel, (last.result as { kind: string }).kind.replaceAll("_", " "));
    assert.equal(view!.kindLabel, kinds[1]!.replaceAll("_", " "));
  } finally {
    store.close();
  }
});

test("graph: one call shares the course index and references; outputs equal per-assignment reads", async () => {
  const store = seededStore();
  try {
    await compileCourse(store, course, NOW);
    const index = courseIndex(store, course);
    const ids = [...index.resources.values()].filter((r) => r.kind === "assignment" || r.moduleItem?.type === "Assignment").map((r) => r.id);
    assert.ok(ids.length >= 4);
    const call = graphCall(store);
    for (const id of ids) assert.deepEqual(references(store, id, call), references(store, id), id);

    // The agenda and the course graph read the course's inventory once per call, not per assignment.
    const day = counted(() => agenda(store, { date: TODAY, tz: TZ, days: 14, now: NOW }));
    const withRefs = day.value.entries.filter((e) => e.kind !== "event" && e.kind !== "class").length;
    assert.ok(withRefs >= 3, "several entries carry references");
    assert.equal(day.sql.filter((s) => INVENTORY.test(s)).length, 1);
    for (const e of day.value.entries)
      if (e.references.length) assert.ok(e.resourceIds.some((id) => JSON.stringify(references(store, id)) === JSON.stringify(e.references)), e.key);
    const graph = counted(() => courseGraph(store, course));
    assert.equal(graph.sql.filter((s) => INVENTORY.test(s)).length, 1);
    assert.deepEqual(
      graph.value.coverage.assignmentsWithoutReferences,
      [...new Set([...index.assignmentById.values(), ...index.quizById.values()])]
        .filter((r) => r.kind === "assignment" && !references(store, r.id).length)
        .map((r) => r.id),
    );
  } finally {
    store.close();
  }
});

test("passage search: one FTS probe per term; matched terms equal the per-hit probe", () => {
  const { store, file, close } = fileStore();
  const reference = new DatabaseSync(file, { readOnly: true });
  try {
    for (const b of syntheticCorpus(200).batches) store.ingest(b);
    const probe = reference.prepare("SELECT 1 FROM passage_fts WHERE passage_fts MATCH ? AND rowid = ?");
    const PROBE = /passage_fts MATCH \? AND rowid/;
    for (const query of ["eigenvalue matrix basis", "what is dynamic programming", "treaty revolution empire trade"]) {
      const { value: result, sql } = counted(() => store.searchPassages({ query, k: 8 }));
      assert.ok(result.hits.length > 1, query);
      assert.equal(sql.filter((s) => PROBE.test(s)).length, result.terms.length, "one probe per term");
      for (const hit of result.hits) {
        const matched = new Set(result.terms.filter((t) => probe.get(`{ctx body} : "${t}"`, hit.pid) !== undefined));
        assert.equal(hit.coverage, coverage(result.terms, matched), `${query} ${hit.pid}`);
        const r = store.resource(hit.resourceId)!;
        assert.equal(hit.title, r.title);
        assert.equal(hit.url, r.url);
      }
    }
  } finally {
    reference.close();
    close();
  }
});

test("guide inputs read every resource once; the selection is unchanged", async () => {
  const store = seededStore();
  try {
    await compileCourse(store, course, NOW);
    const { value: picked, sql } = counted(() => selectGuideInputs(store, "guide", { courseId: course.courseId }));
    assert.equal(sql.filter((s) => LIST.test(s)).length, 1);
    assert.ok(picked.ok);
    // Inclusion over the shared list decides exactly as the store-wide helper does.
    const included = courseInclusion(store);
    const expected = store
      .resources()
      .filter((r) => r.courseId === course.courseId && included(r) && r.text.trim().length > 0)
      .map((r) => r.id);
    for (const r of picked.selection.resources) assert.ok(expected.includes(r.id), r.id);
  } finally {
    store.close();
  }
});

test("course pass: no full resource read per resource unless the course changed while it yielded", async () => {
  const ROW = /LEFT JOIN completions c ON c\.resource_id = r\.id WHERE r\.id = \?/;
  const quiet = seededStore();
  try {
    const n = courseIndex(quiet, course).resources.size;
    executed.length = 0;
    recording = true;
    const report = await compileCourse(quiet, course, NOW, 2).finally(() => (recording = false));
    assert.deepEqual(report.errors, []);
    assert.equal(executed.filter((s) => ROW.test(s)).length, 0, `was one per resource (${n})`);
  } finally {
    quiet.close();
  }
  // A source removed while the pass yields: its resources are skipped, exactly as before.
  const busy = seededStore();
  try {
    const removed = busy.sourceResources("src-assignments").map((r) => r.id);
    assert.ok(removed.length > 1);
    setImmediate(() => busy.removeSource("src-assignments"));
    executed.length = 0;
    recording = true;
    const report = await compileCourse(busy, course, NOW, 1).finally(() => (recording = false));
    assert.deepEqual(report.errors, []);
    assert.ok(executed.filter((s) => ROW.test(s)).length > 0, "the rest of the pass checks each resource");
    for (const id of removed) assert.deepEqual(busy.resourceRefs(id), []);
  } finally {
    busy.close();
  }
});
