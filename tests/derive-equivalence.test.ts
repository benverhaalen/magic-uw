/**
 * owner: drain. No capability loss, checked: the per-row job path (`pipelineJobRegistry`: passages,
 * link and course-pass jobs) and the reconcile (`appJobRegistry` with `derive`) write the same
 * derived rows on the same workspace, first and after later captures. The notes' incremental
 * `reconcile()` writes the same notes as `refresh()`. Keep until the per-row path is deleted.
 *
 * Resource IDs are random per store, so every compared value names a resource by its source and
 * external ID. Rows whose order comes from those random IDs (a join or a set) are compared sorted;
 * rows with a meaningful order (passages, facts, references) keep it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "@magic/storage";
import type { CaptureBatch } from "@magic/contracts";
import { appJobRegistry, pipelineJobRegistry } from "../packages/core/src/jobs/default-registry";
import { createPipelineLoop } from "../packages/core/src/jobs/pipeline";
import { enqueueOnSave } from "../packages/core/src/jobs/registry";
import { courseGraph, references } from "../packages/core/src/graph/index";
import { createNotesService } from "../packages/notes/src/index";
import { batches as smallBatches, NOW } from "./pipeline-fixture";
import { bigWorkspaceBatches, BIG_NOW } from "./derive-fixture";

type S = ReturnType<typeof createStore>;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

function seed(list: CaptureBatch[]): S {
  const store = createStore(":memory:");
  for (const b of list) assert.ok(!store.ingest(b).rejected, `fixture batch ${b.source.id} was rejected`);
  return store;
}
async function oldPath(store: S, at: string, sources?: string[]) {
  const registry = pipelineJobRegistry();
  const loop = createPipelineLoop({ store, registry, now: () => at });
  if (sources) for (const id of sources) enqueueOnSave(store, registry, id, at);
  else await loop.backfill();
  const report = await loop.runToIdle();
  assert.equal(report.failed, 0);
  await loop.stop();
}
async function newPath(store: S, at: string) {
  const loop = createPipelineLoop({ store, registry: appJobRegistry(), now: () => at, derive: true });
  await loop.runToIdle();
  assert.deepEqual(loop.derived.errors, []);
  await loop.stop();
  return loop.derived;
}

/** Every derived row, with resources named by source and external ID. */
function derived(store: S) {
  const live = store.resources();
  const key = new Map(live.map((r) => [r.id, `${r.sourceId}/${r.externalId}`]));
  const name = (value: unknown) => JSON.stringify(value).replace(UUID, (id) => key.get(id) ?? "(deleted)");
  const sorted = (values: unknown[]) => values.map(name).sort();
  const ordered = [...live].sort((a, b) => (key.get(a.id)! < key.get(b.id)! ? -1 : 1));
  const courses = [...new Map(store.sources().map((s) => [`${s.accountScope}\u0000${s.courseId}`, { accountScope: s.accountScope, courseId: s.courseId }])).values()];
  return {
    passages: ordered.map((r) => name([r.id, store.passages(r.id).map(({ pid: _pid, ...p }) => p)])),
    // Search hits in rank order, each with its resource, offsets and score (the pid is a row number).
    search: ["vectors", "matrix notes", "eigenvalues determinant", "homework", "kernel operator", "spectral radius"].map((query) =>
      name([query, store.searchPassages({ query, k: 8 }).hits.map(({ pid: _pid, ...h }) => h)]),
    ),
    facts: ordered.map((r) => name([r.id, store.materialFacts(r.id).map(({ id: _id, ...f }) => f)])),
    refs: ordered.map((r) => name([r.id, store.resourceRefs(r.id)])),
    externals: courses.map((c) => sorted(store.externalRefs(c).map(({ foundInResourceId: _f, title: _t, ...e }) => e))),
    externalOrigins: courses.map((c) => store.externalRefs(c).map((e) => ({ id: e.id, foundIn: e.foundInResourceId, title: e.title }))),
    counts: courses.map((c) => sorted(store.graphCounts(c))),
    graph: courses.map((c) => {
      const g = courseGraph(store, c) as unknown as Record<string, unknown>;
      return Object.fromEntries(Object.entries(g).map(([k, v]) => [k, Array.isArray(v) ? sorted(v) : name(v)]));
    }),
    references: sorted(live.filter((r) => r.kind === "assignment").map((r) => [r.id, references(store, r.id)])),
  };
}
/**
 * Where an external link was first found, and its title, are first-writer and last-writer values:
 * on the per-row path they follow the job lease order. Both paths must record a resource that
 * links to it and a title one of those links carries.
 */
function checkOrigins(store: S, origins: ReturnType<typeof derived>["externalOrigins"]) {
  const courses = [...new Map(store.sources().map((s) => [`${s.accountScope}\u0000${s.courseId}`, { accountScope: s.accountScope, courseId: s.courseId }])).values()];
  const linking = new Map<string, Set<string>>();
  for (const r of store.resources())
    for (const ref of store.resourceRefs(r.id))
      if (ref.externalRefId) linking.set(ref.externalRefId, (linking.get(ref.externalRefId) ?? new Set()).add(r.id));
  courses.forEach((_c, i) => {
    for (const o of origins[i]!) if (o.foundIn) assert.ok(linking.get(o.id)?.has(o.foundIn), `external ${o.id} was found in a resource that links to it`);
  });
}
function assertSame(a: S, b: S) {
  const x = derived(a), y = derived(b);
  for (const part of ["passages", "search", "facts", "refs", "externals", "counts", "graph", "references"] as const)
    assert.deepEqual(y[part], x[part], `${part} differ between the per-row path and the reconcile`);
  checkOrigins(a, x.externalOrigins);
  checkOrigins(b, y.externalOrigins);
  return x;
}

test("the reconcile writes what the per-row jobs wrote: the pipeline fixture", async () => {
  const a = seed(smallBatches()), b = seed(smallBatches());
  await oldPath(a, NOW);
  const report = await newPath(b, NOW);
  assert.ok(report.courses > 0 && report.writes > 0);
  const rows = assertSame(a, b);
  assert.ok(rows.facts.some((f) => f.includes('"lecture"')) && rows.refs.some((r) => r.includes('"direct"')), "the comparison has content");
  a.close();
  b.close();
});

test("the reconcile writes what the per-row jobs wrote: 2,000+ resources, then later captures", async () => {
  const list = bigWorkspaceBatches();
  const a = seed(list), b = seed(list);
  assert.ok(a.resources().length >= 2000);
  await oldPath(a, BIG_NOW);
  await newPath(b, BIG_NOW);
  const first = assertSame(a, b);
  assert.ok(first.refs.filter((r) => r.includes('"named"')).length > 10, "named references are compared");
  assert.ok(first.facts.filter((f) => f.includes('"definition"')).length > 10, "text facts are compared");

  // Later captures: a missing link target arrives, a page's text changes, a file disappears.
  const later = "2026-10-02T15:00:00.000Z";
  const changed: CaptureBatch[] = [];
  const pages = structuredClone(list.find((x) => x.source.id === "big-302-pages")!);
  pages.observedAt = "2026-10-02T12:00:00.000Z";
  pages.resources[0] = { ...pages.resources[0]!, text: `${pages.resources[0]!.text}\nA norm is defined as a length function on vectors.` };
  changed.push(pages);
  const files = structuredClone(list.find((x) => x.source.id === "big-304-files")!);
  files.observedAt = "2026-10-02T12:00:00.000Z";
  files.resources = files.resources.slice(1);
  changed.push(files);
  const modules = structuredClone(list.find((x) => x.source.id === "big-305-module-items:m0")!);
  modules.observedAt = "2026-10-02T12:00:00.000Z";
  const extra = structuredClone(list.find((x) => x.source.id === "big-305-pages")!);
  extra.observedAt = "2026-10-02T12:00:00.000Z";
  extra.resources.push({ ...extra.resources[0]!, externalId: "p-late", title: "Late notes", url: "https://canvas.wisc.edu/courses/305/pages/late-notes", text: "Late notes\nSee the week 1 notes." });
  const linking = structuredClone(list.find((x) => x.source.id === "big-305-assignments")!);
  linking.observedAt = "2026-10-02T12:00:00.000Z";
  linking.resources[0] = { ...linking.resources[0]!, links: [...(linking.resources[0]!.links ?? []), { url: "https://canvas.wisc.edu/courses/305/pages/late-notes", text: "late notes" }] };
  changed.push(linking, extra, modules);
  for (const store of [a, b]) for (const batch of changed) assert.ok(!store.ingest(batch).rejected);
  await oldPath(a, later, changed.map((x) => x.source.id));
  const again = await newPath(b, later);
  assert.ok(again.courses >= 3, "the changed courses are recomputed");
  assertSame(a, b);

  // Nothing changed: one comparison per course, nothing written.
  const loop = createPipelineLoop({ store: b, registry: appJobRegistry(), now: () => later, derive: true });
  await loop.runToIdle();
  assert.equal(loop.derived.writes, 0);
  assert.equal(loop.derived.transactions, 0);
  assert.equal(loop.derived.courses, 0);
  await loop.stop();
  a.close();
  b.close();
});

test("notes: the incremental reconcile writes what refresh() writes", async () => {
  const list = bigWorkspaceBatches();
  const a = seed(list), b = seed(list);
  const at = () => new Date(BIG_NOW);
  const na = createNotesService({ store: a, now: at }), nb = createNotesService({ store: b, now: at });
  const notesOf = (store: S) => {
    const key = new Map(store.resources().map((r) => [r.id, `${r.sourceId}/${r.externalId}`]));
    const name = (value: unknown) => JSON.stringify(value).replace(UUID, (id) => key.get(id) ?? "(deleted)");
    return store.notes
      .notes({})
      .map((n) => name([n.id, n.sessionId, n.title, n.template, n.moduleName, n.state, n.scheduled, n.revision, store.notes.blocks(n.id), (store.notes.links(n.id) as unknown[]).map(name).sort()]))
      .sort();
  };
  const full = na.refresh();
  const first = await nb.reconcile();
  assert.equal(first.created, full.created);
  assert.ok(first.created >= 50, "the window has sessions");
  assert.deepEqual(notesOf(b), notesOf(a));
  assert.equal((await nb.reconcile()).skipped, true, "nothing changed: skipped");

  // One course's material changes: only that course is recomputed, with the same result.
  for (const store of [a, b]) {
    const pages = structuredClone(list.find((x) => x.source.id === "big-303-pages")!);
    pages.observedAt = "2026-10-01T12:00:00.000Z";
    pages.resources[0] = { ...pages.resources[0]!, title: "Week 1 notes (revised)", createdAt: "2026-09-29T05:00:00.000Z" };
    assert.ok(!store.ingest(pages).rejected);
  }
  const all = na.refresh();
  const one = await nb.reconcile();
  assert.equal(one.courses, 1);
  assert.equal(one.unchanged, all.courses - 1);
  assert.equal(one.refreshed, all.refreshed);
  assert.ok(one.refreshed > 0, "the change reached a scaffold");
  assert.deepEqual(notesOf(b), notesOf(a));
  a.close();
  b.close();
});

test("notes: the reconcile never rebuilds a note the student edited", async () => {
  const store = seed(bigWorkspaceBatches(2));
  const notes = createNotesService({ store, now: () => new Date(BIG_NOW) });
  await notes.reconcile();
  const page = structuredClone(bigWorkspaceBatches(2).find((x) => x.source.id === "big-301-pages")!);
  page.observedAt = "2026-10-01T12:00:00.000Z";
  page.resources = page.resources.map((r) => ({ ...r, createdAt: "2026-09-29T05:00:00.000Z", title: `${r.title} (new)` }));
  assert.ok(!store.ingest(page).rejected);
  // The student edits every note of the course, then the course's materials change.
  for (const n of store.notes.notes({ accountScope: "student-big", courseId: "301" }))
    store.notes.addVersion(n.id, store.notes.blocks(n.id) ?? [], "student", { state: "edited", editedAt: BIG_NOW });
  const stats = await notes.reconcile({ budgetMs: 0 });
  assert.ok(stats.sessions > 0);
  assert.equal(stats.refreshed, 0);
  for (const n of store.notes.notes({ accountScope: "student-big", courseId: "301" }))
    assert.equal(store.notes.versions(n.id)[0]?.origin, "student", "the student's version stays the latest");
  store.close();
});
