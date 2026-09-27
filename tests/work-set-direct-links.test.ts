import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "@magic/storage";
import { createCore, directLinkId, launchWorkSet, selectWorkRetry } from "@magic/core";
import { linkExactEvidence } from "../packages/core/src/evidence";
import { captureBatchSchema } from "@magic/contracts";

// Shape of the MHR 322 assignment (synthetic text): one direct link to an
// external project site that Magic has not saved.
const PROJECT = "https://sites.google.com/undergroundshirts.com/mhr-322-ugp-t-shirt-project/home";
function setup(links: unknown[]) {
  const store = createStore(":memory:");
  const core = createCore(store, { fixture: captureBatchSchema.parse({ source: { id: "x", label: "x", kind: "canvas", accountScope: "a", courseId: "x", scope: "assignments" }, observedAt: "2026-09-26T18:00:00Z", complete: true, status: "ok", resources: [] }) });
  store.ingest(captureBatchSchema.parse({
    source: { id: "canvas-322", label: "Synthetic Canvas", kind: "canvas", accountScope: "synthetic-account", courseId: "322", scope: "assignments" },
    observedAt: "2026-09-26T18:00:00Z", complete: true, status: "ok",
    resources: [
      { externalId: "ugp", kind: "assignment", courseId: "322", courseName: "MHR 322", title: "UGP T-shirt project", url: "https://canvas.wisc.edu/courses/322/assignments/9", text: "Work through the project site.", links, deadlines: [], points: 20, submitted: false },
      { externalId: "brief", kind: "material", courseId: "322", courseName: "MHR 322", title: "Project brief", url: "https://canvas.wisc.edu/courses/322/pages/brief", text: "Brief.", deadlines: [], points: null, submitted: null },
    ],
  }));
  linkExactEvidence(store);
  const id = store.resources().find(r => r.externalId === "ugp")!.id;
  return { store, core, id };
}

test("MHR 322 shape: the direct project link reaches the work set with provenance", async () => {
  const { core, id } = setup([{ url: PROJECT }]);
  const set = (await core.execute({ type: "work-set", id })).workSet!;
  assert.deepEqual(set.items.map(i => [i.role, i.target.kind === "web" ? i.target.url : ""]), [
    ["material", PROJECT],
    ["instructions", "https://canvas.wisc.edu/courses/322/assignments/9"],
  ]);
  const project = set.items[0]!;
  assert.equal(project.provenance, "assignment_link");
  assert.equal(project.resourceId, directLinkId(id, PROJECT));
  assert.equal(project.title, "sites.google.com/undergroundshirts.com/mhr-322-ugp-t-shirt-project/home");
  assert.match(project.reason, /Linked directly in the saved assignment/);
  assert.ok(!set.notes.some(n => /only the assignment opens/.test(n)));
  // It launches through the existing reviewed path and can be retried by its ID.
  const calls: string[] = [];
  const receipt = await launchWorkSet(set, { dryRun: false, openExternal: async (u, front) => { calls.push(`${u}:${front}`); }, openPath: async () => "", realpath: async p => p, materialize: async p => p, documentsRoot: "/d", separator: "/", now: () => new Date(0) });
  assert.deepEqual(calls, [`${PROJECT}:false`, "https://canvas.wisc.edu/courses/322/assignments/9:true"]);
  assert.equal(selectWorkRetry(set, set.previewHash, [project.resourceId], new Set([project.resourceId])).items.length, 1);
  assert.equal(receipt.failed.length, 0);
});

test("direct links never pull in the assignment site's own navigation or other courses", async () => {
  const { core, id } = setup([
    "https://canvas.wisc.edu/courses/322/pages/brief",            // saved: evidence path
    "https://canvas.wisc.edu/courses/322/modules",                // assignment's own site, unsaved: never opened
    "https://canvas.wisc.edu/courses/999/pages/other",            // another course on the same site
    { url: PROJECT, text: "  Project site  " },
    `${PROJECT}#top`,                                             // same page again
  ]);
  const set = (await core.execute({ type: "work-set", id })).workSet!;
  assert.deepEqual(set.items.map(i => [i.title, i.provenance ?? null]), [
    ["Project brief", "assignment_link"],
    ["Project site", "assignment_link"],
    ["UGP T-shirt project", null],
  ]);
  const text = JSON.stringify(set);
  for (const absent of ["modules", "courses/999"]) assert.ok(!text.includes(absent), absent);
});

test("a changed direct link changes the reviewed preview", async () => {
  const a = setup([{ url: PROJECT }]);
  const b = setup([{ url: "https://sites.google.com/other/home" }]);
  const [sa, sb] = [(await a.core.execute({ type: "work-set", id: a.id })).workSet!, (await b.core.execute({ type: "work-set", id: b.id })).workSet!];
  assert.notEqual(sa.previewHash, sb.previewHash);
});
