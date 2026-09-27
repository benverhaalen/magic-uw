import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "@magic/storage";
import { createCore, launchWorkSet, selectWorkRetry, type WorkLaunchHost } from "@magic/core";
import { linkExactEvidence } from "../packages/core/src/evidence";
import { captureBatchSchema, type WorkSet } from "@magic/contracts";

const root = "/data/documents";
function batch(courseId: string, resources: object[], sourceId = `canvas-${courseId}`) {
  return captureBatchSchema.parse({
    source: {
      id: sourceId,
      label: "Synthetic Canvas",
      kind: "canvas",
      accountScope: "synthetic-account",
      courseId,
      scope: "assignments",
    },
    observedAt: "2026-09-26T18:00:00Z",
    complete: true,
    status: "ok",
    resources,
  });
}
const base = (courseId: string) => ({
  courseId,
  courseName: `Course ${courseId}`,
  deadlines: [],
  points: null,
  submitted: null,
});
function material(courseId: string, externalId: string, extra: object = {}) {
  return {
    ...base(courseId),
    externalId,
    kind: "material",
    title: `Reading ${externalId}`,
    url: `https://canvas.wisc.edu/courses/${courseId}/pages/${externalId}`,
    text: `Text of ${externalId}.`,
    ...extra,
  };
}
function setup() {
  const store = createStore(":memory:");
  const core = createCore(store, { fixture: batch("x", []) });
  const links = [
    "https://canvas.wisc.edu/courses/101/pages/slides",
    "https://canvas.wisc.edu/courses/101/pages/notes",
    "https://canvas.wisc.edu/courses/101/pages/script",
    "https://canvas.wisc.edu/courses/202/pages/foreign",
  ];
  store.ingest(
    batch("101", [
      {
        ...base("101"),
        externalId: "p3",
        kind: "assignment",
        title: "Project 3",
        url: "https://canvas.wisc.edu/courses/101/assignments/3",
        text: "Build the thing. See the slides and notes.",
        links,
        points: 40,
        submitted: false,
      },
      material("101", "slides", {
        contentType: "application/pdf",
        document: { localPath: `${root}/101/aa-slides`, extractionStatus: "ok", pages: [] },
      }),
      material("101", "notes"),
      material("101", "script", {
        title: "setup.command",
        contentType: "application/octet-stream",
        document: { localPath: `${root}/101/bb-script`, extractionStatus: "unsupported", pages: [] },
      }),
      material("101", "unlinked"),
    ]),
  );
  store.ingest(batch("202", [material("202", "foreign")]));
  linkExactEvidence(store);
  const id = (externalId: string) =>
    store.resources().find((r) => r.externalId === externalId)!.id;
  return { store, core, id };
}
function host(files: Record<string, string>, overrides: Partial<WorkLaunchHost> = {}) {
  const calls: string[] = [];
  const h: WorkLaunchHost = {
    async openExternal(url, activate) {
      calls.push(`web:${url}:${activate ? "front" : "back"}`);
    },
    async openPath(path) {
      calls.push(`file:${path}`);
      return "";
    },
    async materialize(path, extension) {
      return `${root}/.open/${path.split("/").pop()}${extension}`;
    },
    async realpath(path) {
      if (!(path in files)) throw new Error("ENOENT");
      return files[path]!;
    },
    documentsRoot: root,
    separator: "/",
    now: () => new Date("2026-09-27T03:00:00Z"),
    ...overrides,
  };
  return { h, calls };
}

test("work set opens only exactly linked same-course material, with the assignment last", async () => {
  const { core, id } = setup();
  const { workSet } = await core.execute({ type: "work-set", id: id("p3") });
  const set = workSet!;
  assert.deepEqual(
    set.items.map((i) => i.title),
    ["Reading slides", "Reading notes", "setup.command", "Project 3"],
  );
  assert.equal(set.items.at(-1)!.role, "instructions");
  assert.ok(!JSON.stringify(set).includes("foreign"), "other course never enters the set");
  assert.ok(!JSON.stringify(set).includes("unlinked"), "unlinked material is not guessed");
  assert.deepEqual(set.items[0]!.target, {
    kind: "file",
    path: `${root}/101/aa-slides`,
    extension: ".pdf",
    fallbackUrl: "https://canvas.wisc.edu/courses/101/pages/slides",
  });
  // A saved copy that extraction could not read as a document opens online instead.
  assert.equal(set.items[2]!.target.kind, "web");
});

test("suggested links are held, rejected links vanish, and an empty set says why", async () => {
  const { store, core, id } = setup();
  store.putLink({
    id: "fuzzy:1",
    fromId: id("unlinked"),
    toId: id("p3"),
    type: "specifies",
    reason: "Title overlap",
    status: "proposed",
    inputHash: store.resource(id("unlinked"))!.contentHash,
  });
  const exact = store.links().find((l) => l.fromId === id("notes"))!;
  store.decideLink(exact.id, "rejected");
  const set = (await core.execute({ type: "work-set", id: id("p3") })).workSet!;
  assert.ok(!set.items.some((i) => i.title === "Reading notes"));
  assert.ok(!set.items.some((i) => i.title === "Reading unlinked"));
  assert.match(set.held.find((h) => h.title === "Reading unlinked")!.reason, /Suggested/);

  for (const link of store.links()) store.decideLink(link.id, "rejected");
  const bare = (await core.execute({ type: "work-set", id: id("p3") })).workSet!;
  assert.deepEqual(bare.items.map((i) => i.role), ["instructions"]);
  assert.match(bare.notes[0]!, /only the assignment opens/);
});

test("non-assignments and missing items are refused", async () => {
  const { core, id } = setup();
  await assert.rejects(core.execute({ type: "work-set", id: id("slides") }), /assignments/);
  await assert.rejects(core.execute({ type: "work-set", id: "missing" }), /no longer available/);
});

test("launcher opens a named copy of the cached document and never opens an unreadable file", async () => {
  const { core, id } = setup();
  const set = (await core.execute({ type: "work-set", id: id("p3") })).workSet!;
  const { h, calls } = host({
    [`${root}/101/aa-slides`]: `${root}/101/aa-slides`,
  });
  const receipt = await launchWorkSet(set, h);
  assert.deepEqual(calls, [
    `file:${root}/.open/aa-slides.pdf`,
    "web:https://canvas.wisc.edu/courses/101/pages/notes:back",
    "web:https://canvas.wisc.edu/courses/101/pages/script:back",
    "web:https://canvas.wisc.edu/courses/101/assignments/3:front",
  ]);
  assert.deepEqual(
    receipt.opened.map((o) => o.via),
    ["file", "browser", "browser", "browser"],
  );
  assert.equal(receipt.failed.length, 0);
});

test("launcher rejects paths escaping the document folder and unsafe links, continuing with the rest", async () => {
  const set: WorkSet = {
    previewHash: "test",
    assignmentId: "a",
    assignmentTitle: "A",
    contentHash: "h",
    held: [],
    notes: [],
    items: [
      {
        resourceId: "m1",
        title: "Symlinked out",
        role: "material",
        reason: "",
        target: { kind: "file", path: `${root}/x`, extension: ".pdf", fallbackUrl: "https://example.org/x" },
      },
      {
        resourceId: "m2",
        title: "Prefix trick",
        role: "material",
        reason: "",
        target: { kind: "file", path: `${root}-evil/y`, extension: ".pdf", fallbackUrl: "javascript:alert(1)" },
      },
      {
        resourceId: "m4",
        title: "Executable type",
        role: "material",
        reason: "",
        target: { kind: "file", path: `${root}/z`, extension: ".command", fallbackUrl: "https://example.org/z" },
      },
      {
        resourceId: "m3",
        title: "Credentialed",
        role: "material",
        reason: "",
        target: { kind: "web", url: "https://user:pw@example.org/" },
      },
      {
        resourceId: "a",
        title: "A",
        role: "instructions",
        reason: "",
        target: { kind: "web", url: "https://example.org/a" },
      },
    ],
  };
  const { h, calls } = host({
    [`${root}/x`]: "/Users/someone/secret.pdf",
    [`${root}-evil/y`]: `${root}-evil/y`,
    [`${root}/z`]: `${root}/z`,
  });
  const receipt = await launchWorkSet(set, h);
  assert.deepEqual(calls, [
    "web:https://example.org/x:back",
    "web:https://example.org/z:back",
    "web:https://example.org/a:front",
  ]);
  assert.match(receipt.notes.join(" "), /not opened automatically/);
  assert.deepEqual(receipt.failed.map((f) => f.title), ["Prefix trick", "Credentialed"]);
  assert.match(receipt.notes[0]!, /outside the app's document folder/);
});

test("a failing opener or missing copy degrades per item; dry run opens nothing", async () => {
  const { core, id } = setup();
  const set = (await core.execute({ type: "work-set", id: id("p3") })).workSet!;
  const missing = host({});
  const receipt = await launchWorkSet(set, {
    ...missing.h,
    async openExternal(url) {
      if (url.includes("notes")) throw new Error("No default browser.");
      missing.calls.push(url);
    },
  });
  assert.equal(receipt.opened.find((o) => o.title === "Reading slides")!.via, "browser_fallback");
  assert.match(receipt.notes.join(" "), /no longer on this device/);
  assert.deepEqual(receipt.failed, [
    { resourceId: id("notes"), title: "Reading notes", reason: "No default browser." },
  ]);
  assert.ok(receipt.opened.some((o) => o.title === "Project 3"));

  const dry = host({ [`${root}/101/aa-slides`]: `${root}/101/aa-slides` }, { dryRun: true });
  const planned = await launchWorkSet(set, dry.h);
  assert.equal(planned.mode, "dry_run");
  assert.deepEqual(dry.calls, []);
  assert.equal(planned.opened.length, 4);
});

test("imported captures and the sample course get exact links, so Start work opens the linked reading", async () => {
  const store = createStore(":memory:");
  const fixture = (await import("../fixtures/course.json")).default;
  const core = createCore(store, { fixture: captureBatchSchema.parse(fixture) });
  await core.execute({ type: "fixture" });
  const essay = store.resources().find((r) => r.externalId === "essay-1")!;
  const set = (await core.execute({ type: "work-set", id: essay.id })).workSet!;
  assert.deepEqual(set.items.map((i) => i.title), ["Argument and evidence", "Comparative analysis"]);
  await core.close();
});

test("materialized copies are named, private, reused, and refuse non-document types", async () => {
  const { mkdtemp, writeFile, readFile, stat, rm, realpath } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { materializeCopy } = await import("@magic/core");
  const dir = await mkdtemp(join(tmpdir(), "magic-start-work-"));
  try {
    const cached = join(dir, "abc-123");
    await writeFile(cached, "%PDF-1.4 synthetic");
    const first = await materializeCopy(dir, cached, ".pdf");
    assert.equal(first, join(await realpath(dir), ".open", "abc-123.pdf"));
    assert.equal(await readFile(first, "utf8"), "%PDF-1.4 synthetic");
    assert.equal((await stat(join(dir, ".open"))).mode & 0o077, 0);
    assert.equal(await materializeCopy(dir, cached, ".pdf"), first);
    await assert.rejects(materializeCopy(dir, cached, ".command"), /not opened automatically/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("preview identity changes with material contents and retry cannot add an unfailed target", async () => {
  const { store, core, id } = setup();
  const first = (await core.execute({ type: "work-set", id: id("p3") })).workSet!;
  const failed = new Set([id("notes")]);
  assert.deepEqual(selectWorkRetry(first, first.previewHash, [id("notes")], failed).items.map(item => item.resourceId), [id("notes")]);
  assert.throws(() => selectWorkRetry(first, first.previewHash, [id("slides")], failed), /failed items/);
  assert.throws(() => selectWorkRetry(first, first.previewHash, [], failed), /failed items/);
  const changed = batch("101", [material("101","notes",{ text:"New instructions for this same linked resource" })]);
  store.ingest({ ...changed, complete:false, observedAt:"2026-09-27T18:00:00Z" });
  const next = (await core.execute({ type: "work-set", id: id("p3") })).workSet!;
  assert.notEqual(next.previewHash, first.previewHash);
  assert.throws(() => selectWorkRetry(next, first.previewHash), /changed/);
  await core.close();
});

test("excluded course cannot prepare work even through direct ID", async () => {
  const { store, core, id } = setup();
  store.setCourseOverride({ accountScope:"synthetic-account",courseId:"101",included:false });
  await assert.rejects(core.execute({type:"work-set",id:id("p3")}), /not currently available/);
  await core.close();
});

test("revoked launch permission stops remaining targets with per-target failure receipts", async () => {
  const { core, id } = setup();
  const set = (await core.execute({type:"work-set",id:id("p3")})).workSet!;
  let checked = 0;
  const { h,calls } = host({}, { beforeItem: async()=> { if (++checked > 1) throw new Error("Consent withdrawn"); } });
  const receipt = await launchWorkSet(set,h);
  assert.equal(calls.length,1);
  assert.equal(receipt.failed.length,set.items.length-1);
  assert.ok(receipt.failed.every(item=>item.reason === "Consent withdrawn"));
  await core.close();
});


test("materializing rejects escaped source and symlinked opening folder or destination", async () => {
  const { mkdtemp, writeFile, mkdir, symlink, rm, realpath } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { materializeCopy } = await import("@magic/core");
  const base = await mkdtemp(join(tmpdir(), "magic-open-boundary-"));
  try {
    const root = join(base, "documents"), outside = join(base,"outside");
    await mkdir(root); await mkdir(outside);
    const cached = join(root,"cached"), external = join(outside,"external");
    await writeFile(cached,"safe document"); await writeFile(external,"outside document");
    await symlink(external, join(root,"escaped"));
    await assert.rejects(materializeCopy(root,join(root,"escaped"),".pdf"), /outside/);
    await symlink(outside,join(root,".open"));
    await assert.rejects(materializeCopy(root,cached,".pdf"), /symlink/);
    await rm(join(root,".open")); await mkdir(join(root,".open"));
    await symlink(external,join(root,".open","cached.pdf"));
    await assert.rejects(materializeCopy(root,cached,".pdf"), /Unsafe/);
  } finally { await rm(base,{recursive:true,force:true}); }
});

test("accepted indirect evidence is not labeled direct, and partial saved sources stay visible", async () => {
  const {store,core,id}=setup();
  store.putLink({id:"manual-support",fromId:id("unlinked"),toId:id("p3"),type:"specifies",reason:"Accepted by student",status:"accepted",inputHash:store.resource(id("unlinked"))!.contentHash});
  const partial=batch("101",[]);
  store.ingest({...partial,complete:false,status:"partial",observedAt:"2026-09-27T18:00:00Z"});
  const set=(await core.execute({type:"work-set",id:id("p3")})).workSet!;
  assert.match(set.items.find(item=>item.resourceId===id("unlinked"))!.reason,/not a direct/);
  assert.match(set.notes.join(" "),/partial.*out of date/);
  await core.close();
});
