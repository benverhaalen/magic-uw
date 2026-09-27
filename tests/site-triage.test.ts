// Host triage before any crawl (the operator: "not all sites need connection; they should be
// efficiently scanned and evaluated for what's needed"). A synthetic course links 20 hosts of
// each kind plus a few ambiguous ones; code decides from Canvas evidence only, one batched call
// settles the rest, the student's choice wins, and only `sync` hosts reach the crawler.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "@magic/storage";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import { defaultPrivacy, resourceInputSchema, type CaptureBatch, type ResourceInput } from "@magic/contracts";
import { createClaudeBackend, type CliCommand, type ModelRunner } from "../packages/runner/src/index";
import { createPackRuntime } from "../packages/packs/core/src/index";
import { applyConsent } from "../packages/core/src/egress";
import { createSiteTriage, readOnceTargets, syncSeeds, triageKey, type HostDecision } from "../packages/core/src/site-triage";
import { externalCourseConnector } from "../packages/connectors/src/external";
import { MaterialReadError, type PublicClient } from "../packages/connectors/src/network";
import { createIngestion } from "../apps/desktop/src/ingestion";
import { createCore } from "../packages/core/src/index";
import { captureBatchSchema } from "@magic/contracts";
import courseFixture from "../fixtures/course.json";
import { createSyntheticCanvasUniversity } from "../packages/connectors/src/canvas-fixture";

const here = dirname(fileURLToPath(import.meta.url));
const fake: CliCommand = { file: process.execPath, prefixArgs: [join(here, "fixtures", "fake-cli", "fake-cli.mjs"), "claude"] };
const CANVAS = "https://canvas.wisc.edu";
const ACCOUNT = "acct";
const COURSE = "564";
const COURSE_REF = { accountScope: ACCOUNT, courseId: COURSE };
const AT = "2026-09-20T15:00:00.000Z";
const N = 20;
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

// 20 per kind. Names say what code should conclude; nothing here is fetched.
const campus = range(10).map((i) => `https://service${i}.students.wisc.edu/help/`);
const images = range(10).map((i) => `https://photos${i}.example.org/figure-${i}.png`);
const platforms = [
  "https://piazza.com/wisc/fall2026/cs564", "https://www.gradescope.com/courses/1", "https://www.youtube.com/watch", "https://uwmadison.box.com/s/abc",
  "https://docs.google.com/document/d/x", "https://drive.google.com/file/d/y", "https://www.cengage.com/c/db", "https://learn.zybooks.com/zybook/X",
  "https://wisc.qualtrics.com/jfe/form/S", "https://app.tophat.com/e/1", "https://mediaspace.wisc.edu/media/1", "https://uwmadison.zoom.us/j/1",
  "https://forms.gle/abc", "https://www.turnitin.com/x", "https://app.honorlock.com/x", "https://app.perusall.com/x",
  "https://www.macmillanlearning.com/x", "https://www.pearson.com/x", "https://www.redshelf.com/x", "https://uwprod-my.sharepoint.com/x",
];
const articles = range(N).map((i) => `https://news${i}.example.com/2026/09/why-query-plans-matter-${i}.html`);
const courseSites = [
  ...range(9).map((i) => `https://dept${i}.example.edu/~prof/cs564/`),
  "https://dept9.example.edu/~cs564/", // a department's per-course home ("~cs354" on pages.cs.wisc.edu)
  ...range(5).map((i) => `https://cs564-team${i}.github.io/`),
  ...range(5).map((i) => `https://people${i}.example.edu/~hopperx/`),
];
const tools = range(6).map((i) => `https://tool${i}.example.app/`);
const expected: Record<HostDecision, string[]> = {
  ignore: [...campus, ...images],
  link_only: platforms,
  read_once: articles,
  sync: courseSites,
};
const host = (u: string) => new URL(u).hostname;

type Store = ReturnType<typeof createStore>;
const a = (url: string, text: string) => `<a href="${url}">${text}</a>`;
function canvas(store: Store) {
  const base = { courseId: COURSE, courseName: "COMP SCI 564: Database Systems" };
  const batch = (scope: string, resources: ResourceInput[]): CaptureBatch => ({
    source: { id: `canvas-${scope}`, kind: "canvas", accountScope: ACCOUNT, courseId: COURSE, scope, label: `CS 564 ${scope}` },
    observedAt: AT, complete: true, status: "ok", resources,
  });
  const r = (x: Record<string, unknown>) => resourceInputSchema.parse({ ...base, text: "", ...x });
  store.ingest(batch("course", [r({ externalId: COURSE, kind: "course", title: "CS 564", url: `${CANVAS}/courses/${COURSE}`, course: { courseCode: "COMP SCI 564", termName: "Fall 2026", instructors: ["Grace Hopperx"] } })]));
  const syllabusHtml = `<p>SECRET-BODY-TEXT: the midterm covers chapters one to four.</p>${campus.map((u, i) => a(u, `Campus service ${i}`)).join(" ")} ${courseSites.slice(0, 10).map((u) => a(u, "Course website")).join(" ")} ${a(platforms[0]!, "Piazza")}`;
  store.ingest(batch("syllabus", [r({ externalId: "syllabus", kind: "material", title: "Syllabus", url: `${CANVAS}/courses/${COURSE}/assignments/syllabus`, rawHtml: syllabusHtml, text: "Syllabus", links: [...campus, ...courseSites.slice(0, 10), platforms[0]!] })]));
  store.ingest(batch("page", [r({ externalId: "figures", kind: "material", title: "Figures", url: `${CANVAS}/courses/${COURSE}/pages/figures`, rawHtml: images.map((u) => `<img src="${u}">${a(u, "figure")}`).join(""), text: "Figures", links: images })]));
  store.ingest(batch("module-items:1", [
    ...courseSites.slice(10).map((u, i) => r({ externalId: `mi-site-${i}`, kind: "material", title: "Schedule", url: `${CANVAS}/courses/${COURSE}/modules/items/${100 + i}`, moduleItem: { type: "ExternalUrl", title: "Schedule", externalUrl: u } })),
    ...tools.map((u, i) => r({ externalId: `mi-tool-${i}`, kind: "material", title: `Tool ${i}`, url: `${CANVAS}/courses/${COURSE}/modules/items/${200 + i}`, moduleItem: { type: "ExternalUrl", title: `Interactive ${i}`, externalUrl: u } })),
    ...platforms.slice(1).map((u, i) => r({ externalId: `mi-platform-${i}`, kind: "material", title: `Platform ${i}`, url: `${CANVAS}/courses/${COURSE}/modules/items/${300 + i}`, moduleItem: { type: "ExternalUrl", title: `Open platform ${i}`, externalUrl: u } })),
  ]));
  store.ingest(batch("assignments", articles.map((u, i) => r({
    externalId: `hw${i}`, kind: "assignment", title: `Reading response ${i}`, url: `${CANVAS}/courses/${COURSE}/assignments/${1000 + i}`,
    rawHtml: `<p>Read ${a(u, "this article")} and respond.</p>`, text: "Read this article and respond.", links: [u],
  }))));
}
function consent(store: Store) {
  store.setPrivacy({ ...defaultPrivacy, mode: "selective_cloud", hostedProvider: "claude", shareCourseText: true });
  applyConsent(store, { action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION }, AT);
}
async function fakeRunner(outputs: unknown[]): Promise<{ runner: ModelRunner; inputs: () => Promise<string[]> }> {
  const dir = await mkdtemp(join(tmpdir(), "site-triage-"));
  const log = join(dir, "log.jsonl");
  const env = { FAKE_CLI_LOG: log, FAKE_CLI_STATE: join(dir, "state"), FAKE_CLI_RESPONSES: JSON.stringify(outputs.map((output) => ({ output }))) };
  const runner = createPackRuntime(createClaudeBackend({ command: fake, workDir: dir, env }), { dailyBackgroundTokens: 1_000_000 }).runner;
  return { runner, inputs: async () => (existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n").map((l) => (JSON.parse(l) as { stdin: string }).stdin ?? "") : []) };
}
const toolAnswer = { hosts: [{ id: "h0", decision: "link_only" }, { id: "h1", decision: "link_only" }, { id: "h2", decision: "link_only" }, { id: "h3", decision: "read_once" }, { id: "h4", decision: "sync" }, { id: "h5", decision: "ignore" }] };

test("20 hosts of each kind: code decides from Canvas evidence alone; one batched call settles the rest; no connection", async () => {
  const store = createStore(":memory:");
  canvas(store);
  consent(store);
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => { fetched++; throw new Error("triage never connects"); }) as typeof fetch;
  try {
    const ai = await fakeRunner([toolAnswer]);
    const triage = createSiteTriage({ store, runner: () => ai.runner, now: () => new Date(AT) });
    const report = await triage.decide(COURSE_REF);
    const byHost = new Map(report.hosts.map((h) => [h.host, h]));
    for (const [decision, urls] of Object.entries(expected) as [HostDecision, string[]][])
      for (const u of urls) {
        const h = byHost.get(host(u));
        assert.ok(h, `${host(u)} was triaged`);
        assert.deepEqual([h.decision, h.by], [decision, "code"], `${host(u)}: ${h.reason}`);
      }
    const byCode = report.hosts.filter((h) => h.by === "code");
    assert.deepEqual(
      Object.fromEntries((["ignore", "link_only", "read_once", "sync"] as const).map((d) => [d, byCode.filter((h) => h.decision === d).length])),
      { ignore: 20, link_only: 20, read_once: 20, sync: 20 },
    );
    assert.equal(report.ambiguous, 6);
    assert.equal(report.modelCalls, 1, "one batched call for every ambiguous host");
    assert.deepEqual(tools.map((u) => byHost.get(host(u))!.decision), ["link_only", "link_only", "link_only", "read_once", "sync", "ignore"]);
    assert.ok(tools.every((u) => byHost.get(host(u))!.by === "model"));
    assert.match(byHost.get("dept0.example.edu")!.reason, /course number 564/);
    assert.match(byHost.get("people0.example.edu")!.reason, /~hopperx/);
    assert.match(byHost.get("service0.students.wisc.edu")!.reason, /campus-service link in the syllabus/);
    // What the model saw: host, paths, link texts and locations; never page content.
    const [prompt] = await ai.inputs();
    assert.match(prompt!, /h0: host=tool0\.example\.app paths=\/ texts="Interactive 0" linked from: module×1 \(1 items\)/);
    assert.doesNotMatch(prompt!, /SECRET-BODY-TEXT|midterm|respond/);
    assert.doesNotMatch(prompt!, /news0|dept0|piazza/, "hosts code settled are not sent");
    assert.equal(store.receipts().filter((r) => r.recipient === "claude" && r.status === "sent").length, 1);
    // Stored per host in the recipe store, keyed by a hash of the course (no course ID).
    const key = triageKey(ACCOUNT, COURSE);
    assert.doesNotMatch(key, /564|acct/);
    const row = store.extractionRecipe("dept0.example.edu", key)!;
    assert.deepEqual([(row.recipe as { decision: string }).decision, (row.recipe as { by: string }).by], ["sync", "code"]);

    // Again: the cached judgment is reused (no call), and unchanged code decisions write nothing.
    const again = await triage.decide(COURSE_REF);
    assert.equal(again.modelCalls, 0);
    assert.deepEqual(again.hosts, report.hosts);
    assert.equal(store.extractionRecipe("dept0.example.edu", key)!.version, 1);

    // One tool gains a link from a page: only that host is asked again. A host an announcement
    // alone links is never sent (messages are communications, not course text): it stays a link.
    store.ingest({
      source: { id: "canvas-page-lab", kind: "canvas", accountScope: ACCOUNT, courseId: COURSE, scope: "page:lab", label: "CS 564 lab page" },
      observedAt: AT, complete: true, status: "ok",
      resources: [resourceInputSchema.parse({ externalId: "lab", kind: "material", courseId: COURSE, courseName: "COMP SCI 564: Database Systems", title: "Lab", url: `${CANVAS}/courses/${COURSE}/pages/lab`, text: "Use the tool.", links: ["https://tool2.example.app/lab-7"] })],
    });
    store.ingest({
      source: { id: "canvas-announcements", kind: "canvas", accountScope: ACCOUNT, courseId: COURSE, scope: "announcements", label: "CS 564 announcements" },
      observedAt: AT, complete: true, status: "ok",
      resources: [resourceInputSchema.parse({ externalId: "ann1", kind: "message", courseId: COURSE, courseName: "COMP SCI 564: Database Systems", title: "Office hours moved", url: `${CANVAS}/courses/${COURSE}/discussion_topics/1`, rawHtml: `<a href="https://announced.example.net/">PRIVATE-ANNOUNCEMENT-TEXT</a>`, text: "Office hours moved.", links: ["https://announced.example.net/"] })],
    });
    const ai2 = await fakeRunner([{ hosts: [{ id: "h0", decision: "read_once" }] }]);
    const changed = await createSiteTriage({ store, runner: () => ai2.runner, now: () => new Date(AT) }).decide(COURSE_REF);
    assert.equal(changed.modelCalls, 1);
    const [second] = await ai2.inputs();
    assert.match(second!, /h0: host=tool2\.example\.app paths=\/, \/lab-7/);
    assert.doesNotMatch(second!, /h1:|announced|PRIVATE-ANNOUNCEMENT-TEXT|Office hours/);
    assert.equal(changed.hosts.find((h) => h.host === "tool2.example.app")!.decision, "read_once");
    assert.deepEqual(
      [changed.hosts.find((h) => h.host === "announced.example.net")!.decision, changed.hosts.find((h) => h.host === "announced.example.net")!.by],
      ["link_only", "default"],
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(fetched, 0);
});

test("the student's choice wins; without the student's AI, ambiguous hosts stay links", async () => {
  const store = createStore(":memory:");
  canvas(store);
  consent(store);
  const triage = createSiteTriage({ store, runner: () => null, now: () => new Date(AT) });
  const first = await triage.decide(COURSE_REF);
  for (const u of tools) {
    const h = first.hosts.find((x) => x.host === host(u))!;
    assert.deepEqual([h.decision, h.by], ["link_only", "default"]);
    assert.match(h.reason, /not decided yet/);
  }
  triage.override(COURSE_REF, "service3.students.wisc.edu", "sync");
  triage.override(COURSE_REF, "news4.example.com", "ignore");
  const after = await createSiteTriage({ store, now: () => new Date(AT) }).decide(COURSE_REF);
  const pick = (h: string) => after.hosts.find((x) => x.host === h)!;
  assert.deepEqual([pick("service3.students.wisc.edu").decision, pick("service3.students.wisc.edu").by], ["sync", "student"]);
  assert.deepEqual([pick("news4.example.com").decision, pick("news4.example.com").by], ["ignore", "student"]);
  // A later default run with a runner does judge the tools, but never the student's hosts.
  const ai = await fakeRunner([toolAnswer]);
  const judged = await createSiteTriage({ store, runner: () => ai.runner, now: () => new Date(AT) }).decide(COURSE_REF);
  assert.equal(judged.modelCalls, 1);
  assert.equal(judged.hosts.find((x) => x.host === "service3.students.wisc.edu")!.decision, "sync");
});

test("an AI outage never downgrades a host the model judged sync: the earlier judgment stands and is asked again later", async () => {
  const store = createStore(":memory:");
  canvas(store);
  consent(store);
  const ai = await fakeRunner([toolAnswer]);
  const first = await createSiteTriage({ store, runner: () => ai.runner, now: () => new Date(AT) }).decide(COURSE_REF);
  const synced = first.hosts.find((h) => h.by === "model" && h.decision === "sync")!;
  assert.ok(synced, "the model judged one tool host sync");
  // New Canvas evidence for that host changes its signals; the student's AI is now unavailable.
  store.ingest({
    source: { id: "canvas-page-new", kind: "canvas", accountScope: ACCOUNT, courseId: COURSE, scope: "page:new", label: "CS 564 new page" },
    observedAt: AT, complete: true, status: "ok",
    resources: [resourceInputSchema.parse({ externalId: "new", kind: "material", courseId: COURSE, courseName: "COMP SCI 564: Database Systems", title: "New", url: `${CANVAS}/courses/${COURSE}/pages/new`, text: "See it.", links: [`https://${synced.host}/week-3`] })],
  });
  const offline = await createSiteTriage({ store, runner: () => null, now: () => new Date(AT) }).decide(COURSE_REF);
  const kept = offline.hosts.find((h) => h.host === synced.host)!;
  assert.deepEqual([kept.decision, kept.by], ["sync", "model"]);
  assert.deepEqual(syncSeeds([`https://${synced.host}/`], new Map(offline.hosts.map((h) => [h.host, h]))), [`https://${synced.host}/`], "the crawl still seeds it");
  // The stored judgment's signals are stale, so the next run with the AI asks about it again.
  const back = await fakeRunner([{ hosts: [] }]);
  const again = await createSiteTriage({ store, runner: () => back.runner, now: () => new Date(AT) }).decide(COURSE_REF);
  assert.equal(again.modelCalls, 1);
  assert.match((await back.inputs())[0]!, new RegExp(`host=${synced.host.replace(/\./g, "\\.")}`));
});

test("only sync hosts reach the crawler; read_once links are an item's own, read when it opens", async () => {
  const store = createStore(":memory:");
  canvas(store);
  consent(store);
  const ai = await fakeRunner([toolAnswer]);
  const triage = createSiteTriage({ store, runner: () => ai.runner, now: () => new Date(AT) });
  const decided = new Map((await triage.decide(COURSE_REF)).hosts.map((h) => [h.host, h]));
  const everyLink = [...campus, ...images, ...platforms, ...articles, ...courseSites, ...tools];
  const seeds = syncSeeds(everyLink, decided);
  assert.deepEqual(seeds.map(host).sort(), [...courseSites.map(host), "tool4.example.app"].sort());
  const requested: string[] = [];
  const client: PublicClient = {
    isCanvas: (u) => new URL(u).origin === CANVAS,
    async get(u) {
      requested.push(u);
      return { url: u, redirects: [], response: new Response("<html><head><title>Site</title></head><body><p>ok</p></body></html>", { headers: { "content-type": "text/html" } }) };
    },
    async text(u) {
      requested.push(u);
      throw new MaterialReadError("not_found", { status: 404 });
    },
    async feed() { throw new Error("unused"); },
    async signedDownload() { throw new Error("unused"); },
  };
  for await (const _ of externalCourseConnector({ accountScope: ACCOUNT, courseId: COURSE, courseName: "CS 564", seeds, client, maxDepth: 0, now: () => new Date(AT) }).pull());
  const syncHosts = new Set(seeds.map(host));
  assert.ok(requested.length > 0 && requested.every((u) => syncHosts.has(host(u))), "no request to a host that isn't sync");
  const hw3 = store.resources().find((r) => r.externalId === "hw3")!;
  assert.deepEqual(readOnceTargets(hw3, decided), [articles[3]]);
  const syllabus = store.resources().find((r) => r.externalId === "syllabus")!;
  assert.deepEqual(readOnceTargets(syllabus, decided), [], "campus services and course sites are never read on open");
});

test("the app's sync: triage runs first and the crawler skips hosts not decided sync; opening an item reads its read_once link once", async () => {
  const origin = "https://canvas.wisc.edu";
  const directory = mkdtempSync(join(tmpdir(), "site-triage-sync-"));
  const store = createStore(join(directory, "coursework.sqlite"));
  const university = createSyntheticCanvasUniversity({ origin, rateLimit: false });
  store.setIngestionSettings({ ...store.ingestionSettings(), jitterRatio: 0, quietHours: { enabled: false, start: 1, end: 6 } });
  const pageCalls: string[] = [];
  const client: PublicClient = {
    isCanvas: (u) => new URL(u).origin === origin,
    async get(u) {
      pageCalls.push(u);
      return { url: u, redirects: [], response: new Response(`<html><head><title>Spec</title></head><body><h1>Spec</h1><p>Justify every assumption and show a worked example of the method.</p></body></html>`, { headers: { "content-type": "text/html" } }) };
    },
    async text(u) {
      pageCalls.push(u);
      throw new MaterialReadError("not_found", { status: 404 });
    },
    async feed() { throw new Error("no feeds in this test"); },
    async signedDownload() { throw new Error("no downloads in this test"); },
  };
  let decision: HostDecision = "link_only";
  const triaged: string[] = [];
  const vault: Record<string, string> = {};
  const runtime = createIngestion(store, {
    directory,
    client,
    now: () => new Date("2026-09-26T17:00:00Z"),
    canvasFetch: (url, init) => university.fetch(url, init),
    async secrets(operation, key, value) {
      if (operation === "list") return { ...vault };
      vault[key!] = value!;
    },
    async triage(accountScope, courseId) {
      triaged.push(`${accountScope}:${courseId}`);
      return new Map([["courses.synthetic.test", { decision }]]);
    },
  });
  const first = await runtime.tick("manual");
  assert.equal(first?.action, "refreshed");
  assert.ok(triaged.length >= 5, "each course was triaged before its crawl");
  assert.equal(pageCalls.length, 0, "a link_only host gets no request at all: no crawl, no robots.txt, no access probe");

  // read_once: opening an assignment that links the spec reads that one page, once.
  decision = "read_once";
  const canvasSources = new Set(store.sources().filter((x) => x.kind === "canvas").map((x) => x.id));
  const targetsOf = (r: (typeof all)[number]) => [...(r.links ?? []).map((l) => (typeof l === "string" ? l : l.url)), r.moduleItem?.externalUrl ?? ""];
  const all = store.resources();
  const linking = all.find((r) => canvasSources.has(r.sourceId) && r.kind !== "message" && targetsOf(r).some((u) => u === "https://courses.synthetic.test/101/spec.html"));
  assert.ok(linking, "a Canvas item links the spec page");
  // Through the core's `ui_event` command, the path the renderer's open event takes (the worker
  // wires the seam to `onUiEvent` the same way).
  let pending: Promise<void> | undefined;
  const core = createCore(store, {
    fixture: captureBatchSchema.parse(courseFixture),
    seams: { uiEvent: (event) => void (pending = runtime.onUiEvent(event)) },
  });
  await core.execute({ type: "ui_event", value: { kind: "open", subject: linking.id } });
  assert.ok(pending, "the ui_event command reached the runtime");
  await pending;
  assert.ok(pageCalls.every((u) => host(u) === "courses.synthetic.test") && pageCalls.filter((u) => !u.endsWith("robots.txt")).length === 1);
  const once = store.sources().find((s) => s.scope === "linked_pages")!;
  assert.ok(store.resources().some((r) => r.sourceId === once.id && /worked example/.test(r.text)));
  assert.equal((await runtime.readLinked(linking.id)).read, 0, "already read: no second request");

  // Decided sync: the next sync crawls it (robots.txt first) into the crawler's own source.
  decision = "sync";
  const before = pageCalls.length;
  await runtime.tick("manual");
  const crawled = pageCalls.slice(before);
  assert.ok(crawled.some((u) => u.endsWith("/robots.txt")) && crawled.some((u) => /\/10[1-5]\/$/.test(u)), JSON.stringify(crawled.slice(0, 6)));
  assert.ok(store.sources().some((x) => x.scope === "course_websites"));
  assert.ok(store.sources().some((x) => x.scope === "linked_pages"), "the read-once page is still there");
  runtime.closeExtraction?.();
});
