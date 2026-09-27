import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@magic/storage";
import { captureBatchSchema, type CaptureBatch } from "@magic/contracts";
import { canvasConnector, type CanvasConnectorOptions } from "../packages/connectors/src/canvas";
import { createSyntheticCanvasUniversity } from "../packages/connectors/src/canvas-fixture";
import { createIngestion } from "../apps/desktop/src/ingestion";

const now = () => new Date("2026-09-26T15:00:00Z");
async function pull(options: Partial<CanvasConnectorOptions> & Pick<CanvasConnectorOptions, "fetch">) {
  const batches: CaptureBatch[] = [];
  for await (const batch of canvasConnector({ now, sleep: async () => {}, random: () => 0, ...options }).pull()) {
    captureBatchSchema.parse(batch);
    batches.push(batch);
  }
  return batches;
}
const paths = (calls: Array<{ url: string }>) => calls.map((call) => new URL(call.url).pathname);

test("modules arrive with their items in one request per course, under the per-host limit", async () => {
  const university = createSyntheticCanvasUniversity({ rateLimit: false, modulesPerCourse: 9 });
  const batches = await pull({ fetch: university.fetch, origin: university.origin });
  const requested = paths(university.calls);
  assert.equal(requested.filter((p) => /\/modules\/\d+\/items$/.test(p)).length, 0);
  assert.equal(requested.filter((p) => /\/modules$/.test(p)).length, 5);
  for (const call of university.calls.filter((c) => /\/modules$/.test(new URL(c.url).pathname)))
    assert.deepEqual(new URL(call.url).searchParams.getAll("include[]"), ["items", "content_details"]);
  // Every module still writes its own complete item batch, as when each was read on its own.
  for (const course of ["101", "102", "103", "104", "105"])
    for (let module = 1; module <= 9; module++) {
      const batch = batches.find((b) => b.source.courseId === course && b.source.scope === `module-items:${module}`);
      assert.ok(batch, `${course} module-items:${module}`);
      assert.equal(batch.status, "ok");
      assert.equal(batch.complete, true);
      assert.equal(batch.resources.length, module === 1 ? 2 : 3);
      assert.equal(batch.stats?.requests, 0, "inline items cost no request");
    }
  const stats = university.stats();
  assert.ok(stats.maxActive > 1, "courses are read concurrently");
  assert.ok(stats.maxActive <= 6, `at most 6 in flight, saw ${stats.maxActive}`);
});

test("a module whose items Canvas omitted or truncated is read through List Module Items", async () => {
  const university = createSyntheticCanvasUniversity({ rateLimit: false, modulesPerCourse: 4 });
  const fetch: CanvasConnectorOptions["fetch"] = async (url, init) => {
    const response = await university.fetch(url, init);
    if (!/\/courses\/101\/modules$/.test(new URL(url).pathname)) return response;
    const modules = (await response.json()) as Array<Record<string, unknown>>;
    // Module 2: omitted (Canvas does this above Api::MAX_PER_PAGE items). Module 3: fewer inline
    // items than items_count. Module 4: complete.
    delete modules[1]!.items;
    modules[2]!.items = (modules[2]!.items as unknown[]).slice(0, 1);
    return new Response(JSON.stringify(modules), { status: 200, headers: response.headers });
  };
  const batches = await pull({ fetch, origin: university.origin });
  const itemReads = university.calls
    .map((call) => new URL(call.url).pathname)
    .filter((p) => /\/modules\/\d+\/items$/.test(p));
  assert.deepEqual(itemReads.sort(), ["/api/v1/courses/101/modules/2/items", "/api/v1/courses/101/modules/3/items"]);
  for (const module of [2, 3]) {
    const batch = batches.find((b) => b.source.courseId === "101" && b.source.scope === `module-items:${module}`)!;
    assert.equal(batch.status, "ok");
    assert.equal(batch.resources.length, 3);
    assert.equal(batch.stats?.requests, 1);
  }
});

test("the course list's calendar and syllabus stand in for the per-course detail read", async () => {
  const university = createSyntheticCanvasUniversity({ rateLimit: false });
  const feeds: string[] = [];
  const batches = await pull({
    fetch: university.fetch,
    origin: university.origin,
    onCalendarFeed: (feed) => void feeds.push(feed.courseId),
  });
  assert.equal(paths(university.calls).filter((p) => /^\/api\/v1\/courses\/\d+$/.test(p)).length, 0);
  assert.deepEqual(feeds.sort(), ["101", "102", "103", "104", "105"]);
  const details = batches.filter((b) => b.source.scope === "details");
  assert.equal(details.length, 5);
  assert.ok(details.every((b) => b.status === "ok" && b.diagnostics?.some((d) => d.code === "details_from_course_list")));
  // A list row without the calendar still gets the detail read.
  const bare = createSyntheticCanvasUniversity({ rateLimit: false });
  const withoutCalendar: CanvasConnectorOptions["fetch"] = async (url, init) => {
    const response = await bare.fetch(url, init);
    if (new URL(url).pathname !== "/api/v1/courses") return response;
    const rows = (await response.json()) as Array<Record<string, unknown>>;
    for (const row of rows) delete row.calendar;
    return new Response(JSON.stringify(rows), { status: 200, headers: response.headers });
  };
  await pull({ fetch: withoutCalendar, origin: bare.origin });
  assert.equal(paths(bare.calls).filter((p) => /^\/api\/v1\/courses\/\d+$/.test(p)).length, 5);
});

function harness() {
  const university = createSyntheticCanvasUniversity({ rateLimit: false, origin: "https://canvas.wisc.edu" });
  const requests: string[] = [];
  const directory = mkdtempSync(join(tmpdir(), "magic-sync-speed-"));
  const store = createStore(join(directory, "db.sqlite"));
  let time = new Date(2026, 8, 28, 12, 0, 0); // local noon, outside quiet hours
  const runtime = createIngestion(store, {
    directory,
    now: () => time,
    canvasFetch: async (url, init) => {
      requests.push(url);
      return university.fetch(url, init);
    },
    client: {
      isCanvas: (url) => new URL(url).origin === "https://canvas.wisc.edu",
      async get() {
        throw new Error("offline");
      },
      async text() {
        throw new Error("offline");
      },
      async feed() {
        throw new Error("offline");
      },
      async signedDownload() {
        throw new Error("offline");
      },
    },
    async secrets() {
      return {};
    },
  });
  return {
    requests,
    runtime,
    advance(ms: number) {
      time = new Date(time.getTime() + ms);
    },
    async close() {
      await runtime.stop();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("within one sync an identical GET is read once: the probes' lists serve the full read", async () => {
  const h = harness();
  try {
    const run = await h.runtime.tick("manual");
    assert.equal(run?.action, "refreshed");
    const seen = new Map<string, number>();
    for (const url of h.requests) seen.set(url, (seen.get(url) ?? 0) + 1);
    // The fixture gives every course the same file id and answers /files/:id with a 404; a
    // failed read is never reused, so that one URL is read once per course, by design.
    const repeated = [...seen]
      .filter(([url, n]) => n > 1 && !/\/api\/v1\/files\/9$/.test(url))
      .map(([url]) => url);
    assert.deepEqual(repeated, []);
    // The hot probe's to-do list and the full read's are one request.
    assert.equal(h.requests.filter((u) => new URL(u).pathname === "/api/v1/users/self/todo").length, 1);
  } finally {
    await h.close();
  }
});

test("one sync after sign-in: the renderer's call right after a background sign-in read reuses it", async () => {
  const h = harness();
  try {
    await h.runtime.tick("manual"); // first connect creates the sources
    h.advance(60_000);
    // Main confirms the sign-in; a background tick gets to the read first.
    h.runtime.reconnected();
    const background = await h.runtime.tick();
    assert.equal(background?.action, "refreshed");
    const before = h.requests.length;
    h.advance(5_000);
    const manual = await h.runtime.tick("manual"); // the renderer's startSignIn → syncCanvas
    assert.equal(manual, background, "answered by the sign-in read");
    assert.equal(h.requests.length, before, "no second read");
    // Only that one call: a later manual sync reads again.
    h.advance(5_000);
    await h.runtime.tick("manual");
    assert.ok(h.requests.length > before);
    // When the renderer's call is the one that reads, nothing is suppressed afterwards.
    h.advance(120_000);
    h.runtime.reconnected();
    const owner = await h.runtime.tick("manual");
    assert.equal(owner?.action, "refreshed");
    const after = h.requests.length;
    h.advance(5_000);
    await h.runtime.tick("manual");
    assert.ok(h.requests.length > after);
  } finally {
    await h.close();
  }
});
