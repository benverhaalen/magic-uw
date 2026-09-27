import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@magic/storage";
import { createIngestion } from "../apps/desktop/src/ingestion";
import { createSyntheticCanvasUniversity } from "../packages/connectors/src/canvas-fixture";
import {
  cadenceMinutes,
  createRefreshCoordinator,
  movedCourses,
  type CourseProbe,
} from "../packages/core/src/refresh";

/**
 * The MT1 synthetic university (packages/connectors/src/canvas-fixture.ts), served through a
 * counting transport, with the endpoints the inventory and the probes add. `sized` gives each
 * course 8 modules and 12 pages, closer to a real course than the fixture's 1 module and 2 pages.
 * Entirely synthetic; no request leaves the test.
 */
function syntheticCanvas(options: { sized: boolean }) {
  const university = createSyntheticCanvasUniversity({ rateLimit: false, origin: "https://canvas.wisc.edu" });
  const origin = university.origin;
  const requests: string[] = [];
  const newFiles = new Map<string, { id: number; updated_at: string }>();
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" },
    });
  const moduleCount = options.sized ? 8 : 1,
    pageCount = options.sized ? 12 : 0;
  const extraItems = (course: string, module: number) =>
    module === 1
      ? []
      : Array.from({ length: 4 }, (_, k) => ({
          id: module * 100 + k,
          module_id: module,
          type: "Page",
          title: `Reading ${module}.${k}`,
          page_url: `p-${(module * 4 + k) % Math.max(1, pageCount)}`,
        }));
  async function items(course: string, module: number) {
    if (module !== 1) return extraItems(course, module);
    const base = (await (
      await university.fetch(`${origin}/api/v1/courses/${course}/modules/1/items`, {
        method: "GET",
        credentials: "include",
      })
    ).json()) as unknown[];
    const added = newFiles.get(course);
    return added
      ? [
          ...base,
          { id: 50, module_id: 1, type: "File", title: "Week 1 slides", content_id: added.id },
        ]
      : base;
  }
  const fetch = async (url: string, init?: RequestInit) => {
    requests.push(url);
    assert.equal(init?.method, "GET");
    const parsed = new URL(url);
    const path = parsed.pathname;
    const m = path.match(/^\/api\/v1\/courses\/(10[1-5])\/(.+)$/);
    if (m) {
      const [, course, tail] = m as unknown as [string, string, string];
      if (tail === "tabs" || tail === "external_tools") return json([]);
      if (tail === "activity_stream/summary") return json([]);
      if (tail === "modules") {
        const modules = await Promise.all(
          Array.from({ length: moduleCount }, async (_, i) => ({
            id: i + 1,
            name: `Week ${i + 1}`,
            position: i + 1,
            ...(parsed.searchParams.getAll("include[]").includes("items")
              ? { items: await items(course, i + 1) }
              : { items_count: (await items(course, i + 1)).length }),
          })),
        );
        return json(modules);
      }
      const moduleItems = tail.match(/^modules\/(\d+)\/items$/);
      if (moduleItems) return json(await items(course, Number(moduleItems[1])));
      if (tail === "files") {
        const base = (
          (await (
            await university.fetch(url.replace(/\?.*$/, ""), init)
          ).json()) as Array<Record<string, unknown>>
        ).map((row) => ({
          ...row,
          // Canvas file ids are global; the fixture reuses one id in every course, so make them unique.
          id: Number(course) * 1000 + Number(row.id),
          display_name: "Course reading.txt",
          "content-type": "text/plain",
        }));
        const added = newFiles.get(course);
        const rows = added
          ? [
              {
                id: added.id,
                folder_id: 1,
                display_name: "Week 1 slides.txt",
                size: 64,
                "content-type": "text/plain",
                updated_at: added.updated_at,
                url: "https://downloads.synthetic.test/slides.pdf?signature=SYNTHETIC",
              },
              ...base,
            ]
          : base;
        return json(parsed.searchParams.get("per_page") === "1" ? rows.slice(0, 1) : rows);
      }
      if (options.sized && tail === "pages")
        return json(
          Array.from({ length: pageCount }, (_, k) => ({
            page_id: 700 + k,
            url: `p-${k}`,
            title: `Reading page ${k}`,
            updated_at: "2026-09-20T12:00:00Z",
          })).slice(0, parsed.searchParams.get("per_page") === "1" ? 1 : undefined),
        );
      const page = tail.match(/^pages\/(p-\d+)$/);
      if (options.sized && page)
        return json({
          page_id: 700 + Number(page[1]!.slice(2)),
          url: page[1],
          title: `Reading page ${page[1]}`,
          updated_at: "2026-09-20T12:00:00Z",
          body: "<p>Synthetic reading.</p>",
        });
      if (tail === "pages" && parsed.searchParams.get("per_page") === "1") {
        const rows = (await (
          await university.fetch(url.replace(/\?.*$/, ""), init)
        ).json()) as unknown[];
        return json(rows.slice(0, 1));
      }
    }
    const file = path.match(/^\/api\/v1\/files\/(\d+)$/);
    if (file) return json({ id: Number(file[1]), display_name: "Course reading.txt", "content-type": "text/plain", locked_for_user: false, updated_at: newFiles.get(String(Math.floor(Number(file[1])/1000)))?.updated_at ?? "2026-09-25T12:00:00Z", url: `${origin}/files/${file[1]}/download` });
    return university.fetch(url, init);
  };
  return { origin, fetch, requests, newFiles };
}

function harness(options: { sized: boolean }) {
  const canvas = syntheticCanvas(options);
  const directory = mkdtempSync(join(tmpdir(), "magic-refresh-course-"));
  const store = createStore(join(directory, "db.sqlite"));
  // Local noon, outside the default quiet hours.
  let time = new Date(2026, 8, 28, 12, 0, 0);
  const runtime = createIngestion(store, {
    directory,
    now: () => time,
    canvasFetch: canvas.fetch,
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
      async signedDownload(url) {
        assert.match(url, /^https:\/\/canvas\.wisc\.edu\/files\/\d+\/download$/);
        return {
          url,
          redirects: [],
          response: new Response("Synthetic reading text.", {
            headers: { "content-type": "text/plain" },
          }),
        };
      },
    },
    async secrets() {
      return {};
    },
  });
  return {
    canvas,
    store,
    runtime,
    advance(ms: number) {
      time = new Date(time.getTime() + ms);
    },
    now: () => time,
    close: async () => {
      await runtime.stop();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
const minutes = (n: number) => n * 60_000;
/** Advances the clock in the worker's 30-second steps until a background run happens. */
async function nextRun(h: ReturnType<typeof harness>) {
  for (let i = 0; i < 60; i++) {
    h.advance(30_000);
    const run = await h.runtime.tick();
    if (run) return run;
  }
  throw new Error("no background run within 30 minutes");
}

// The origin the synthetic university uses is not canvas.wisc.edu; the ingestion reads through
// the fetch seam, so point its Canvas reader at the synthetic origin.
async function measure(sized: boolean) {
  const h = harness({ sized });
  try {
    const count = () => h.canvas.requests.length;
    const manual = await h.runtime.tick("manual");
    assert.equal(manual?.action, "refreshed");
    // Every Canvas scope of the included courses, documents included, read completely.
    const incomplete = h.store
      .sources()
      .filter((s) => s.kind === "canvas" && /^10[1-5]$/.test(s.courseId) && s.status !== "ok");
    assert.deepEqual(incomplete.map((s) => [s.scope, s.courseId, s.status]), []);
    const full = count();
    const fullProbes = h.runtime.probeRequests();
    assert.ok(full > 50, `full sync made ${full} requests`);
    // Zero-change background runs: the hot tick alone, then one with the content probe due.
    let before = count();
    const hotRun = await nextRun(h);
    assert.equal(hotRun.action, "unchanged");
    assert.deepEqual(hotRun.probes, ["hot"]);
    const hot = count() - before;
    let contentRun = hotRun,
      withContent = 0;
    for (let i = 0; i < 6 && !contentRun.probes?.includes("content"); i++) {
      before = count();
      contentRun = await nextRun(h);
      withContent = count() - before;
    }
    assert.deepEqual(contentRun.probes, ["hot", "content"]);
    assert.equal(contentRun.action, "unchanged");
    assert.equal(contentRun.warmCourses, undefined);
    const metadataRequests = h.canvas.requests.slice(before).filter(url => {
      const path = new URL(url).pathname;
      return !/\/courses\/[^/]+\/pages\/[^/]+$|\/files\/[^/]+$|\/users\/self\/profile$/.test(path);
    }).length;
    return { h, full, fullProbes, hot, withContent, metadataRequests };
  } catch (error) {
    await h.close();
    throw error;
  }
}

test("a zero-change hot tick stays below 10%; content revalidation obeys its explicit budget", async (t) => {
  for (const sized of [false, true]) {
    const { h, full, fullProbes, hot, withContent, metadataRequests } = await measure(sized);
    try {
      const report = {
        fixture: sized ? "sized (8 modules, 12 pages per course)" : "MT1 synthetic university",
        courses: 5,
        fullSyncRequests: full,
        fullSyncProbeRequests: fullProbes,
        hotTickRequests: hot,
        hotTickRatio: +(hot / full).toFixed(3),
        contentTickRequests: withContent,
        contentTickRatio: +(withContent / full).toFixed(3),
        per15MinutesRatio: +((2 * hot + withContent) / (3 * full)).toFixed(3),
      };
      t.diagnostic(JSON.stringify(report));
      assert.equal(hot, 2, "the hot tick is two requests");
      assert.ok(hot / full <= 0.1);
      // Preserve T17's absolute metadata budget against its recorded 208-request baseline.
      // Direct authorization/body freshness is separately bounded below.
      assert.ok(metadataRequests <= 4 * 5);
      assert.ok(metadataRequests / 208 <= 0.1);
      // Probe: 1+3/course. Direct freshness: at most20 pages plus5 files;
      // the synthetic unauthorized file download checks its profile once per file.
      assert.equal(withContent, hot + 1 + 3 * 5 + (sized ? 20 : 10) + 10);
      assert.ok(withContent < full, `content tick ${withContent}/${full}`);
    } finally {
      await h.close();
    }
  }
});

test("a new undated module file is detected by the content probe within 15 minutes, and only that course is re-read", async (t) => {
  const { h } = await measure(false);
  try {
    const mutatedAt = h.now().getTime();
    const fileId = 9901;
    h.canvas.newFiles.set("103", { id: fileId, updated_at: new Date(mutatedAt).toISOString() });
    const has = () =>
      h.store.resources().some((r) => r.courseId === "103" && r.file?.id === String(fileId));
    assert.equal(has(), false);
    // The hot tick carries only dated items: it doesn't see the file.
    const runs = [];
    let warm: string[] | undefined;
    const before = h.canvas.requests.length;
    for (let i = 0; i < 10 && !has(); i++) {
      const run = await nextRun(h);
      runs.push(run);
      if (run.warmCourses) warm = run.warmCourses;
    }
    assert.ok(has(), "the new file was stored");
    const detectedAfter = h.now().getTime() - mutatedAt;
    assert.ok(detectedAfter <= minutes(cadenceMinutes.content), `detected after ${detectedAfter / 60_000} min`);
    assert.deepEqual(warm, ["103"], JSON.stringify(runs));
    assert.ok(runs.slice(0, -1).every((r) => r.action === "unchanged"));
    const courseReads = h.canvas.requests
      .slice(before)
      .map((u) => new URL(u).pathname.match(/^\/api\/v1\/courses\/(\d+)\//)?.[1])
      .filter(Boolean);
    const warmRun = runs.at(-1)!;
    assert.deepEqual(warmRun.probes, ["hot", "content"]);
    // Other courses receive only their probe and two bounded page revalidations.
    const perCourse = new Map<string, number>();
    for (const id of courseReads) perCourse.set(id!, (perCourse.get(id!) ?? 0) + 1);
    for (const id of ["101", "102", "104", "105"]) assert.equal(perCourse.get(id), 5 * runs.filter((r) => r.probes?.includes("content")).length, id);
    assert.ok((perCourse.get("103") ?? 0) > 10);
    t.diagnostic(JSON.stringify({ detectedAfterMinutes: detectedAfter / 60_000, runs: runs.length, course103Requests: perCourse.get("103"), otherCourseRequestsEach: perCourse.get("101") }));
  } finally {
    await h.close();
  }
});

test("app focus runs the content probe on the next tick, at most once a minute", async () => {
  const { h } = await measure(false);
  try {
    h.runtime.focus();
    h.advance(1000);
    const run = await h.runtime.tick();
    assert.deepEqual(run?.probes, ["hot", "content"]);
    h.runtime.focus();
    h.advance(1000);
    assert.equal(await h.runtime.tick(), undefined, "focus within a minute doesn't force a run");
  } finally {
    await h.close();
  }
});

test("the coordinator: probes before the full read, warm reads only moved courses, keeps the presence gate", async () => {
  let time = new Date(2026, 8, 28, 12);
  const calls: string[] = [];
  let hot: Record<string, string> = { a: "1", b: "1" },
    content: Record<string, string> = { a: "1", b: "1" },
    warmComplete = true;
  const probe = (courses: () => Record<string, string>, name: string) => async (): Promise<CourseProbe> => {
    calls.push(name);
    return { needsSignIn: false, courses: courses(), complete: true };
  };
  const c = createRefreshCoordinator({
    settings: () => ({ enabled: true, intervalMinutes: 10, jitterFraction: 0, quietStartHour: 1, quietEndHour: 6 }),
    now: () => time,
    random: () => 0.5,
    hasSources: () => true,
    feeds: async () => ({ changed: false }),
    probe: async () => {
      calls.push("summary");
      return { needsSignIn: false };
    },
    full: async () => {
      calls.push("full");
      return { needsSignIn: false };
    },
    external: async () => {},
    record: () => {},
    hot: probe(() => hot, "hot"),
    content: probe(() => content, "content"),
    warm: async (courses) => {
      calls.push(`warm:${courses.join(",")}`);
      return { needsSignIn: false, complete: warmComplete };
    },
  });
  const step = async (ms: number) => {
    time = new Date(time.getTime() + ms);
    calls.length = 0;
    return c.tick();
  };
  assert.equal((await c.tick())?.action, "refreshed");
  assert.deepEqual(calls, ["hot", "content", "full"]);
  // 5 min: the hot interval is min(setting, 5).
  assert.equal(await step(minutes(4)), undefined);
  assert.equal((await step(minutes(1)))?.action, "unchanged");
  assert.deepEqual(calls, ["hot"]);
  hot = { ...hot, b: "2" };
  assert.deepEqual((await step(minutes(5)))?.warmCourses, ["b"]);
  assert.deepEqual(calls, ["hot", "warm:b"]);
  assert.equal((await step(minutes(5)))?.action, "unchanged");
  assert.deepEqual(calls, ["hot", "content"]);
  // A warm read that doesn't complete is read again after the retry delay, not on every tick.
  content = { ...content, a: "2" };
  warmComplete = false;
  c.focus();
  assert.deepEqual((await step(1000))?.warmCourses, ["a"]);
  assert.deepEqual(calls, ["hot", "content", "warm:a"]);
  warmComplete = true;
  let retriedAfter = 0,
    retried: string[] | undefined;
  for (let i = 0; i < 10 && !retried; i++) {
    const run = await step(minutes(5));
    retriedAfter += 5;
    retried = run?.warmCourses;
  }
  assert.deepEqual(retried, ["a"]);
  assert.equal(retriedAfter, cadenceMinutes.retry);
  // An incomplete probe never reads a missing course as gone.
  assert.deepEqual(movedCourses({ a: "1", b: "1" }, { a: "1" }, true), []);
  assert.deepEqual(movedCourses({ a: "1", b: "1" }, { a: "1" }), ["b"]);
  // Away: signed-in reads hold (T05d's gate); no probe runs.
  c.presence(false);
  assert.equal((await step(minutes(6)))?.action, "feeds_only");
  assert.deepEqual(calls, []);
  c.presence(true);
  assert.deepEqual((await step(1000))?.probes, ["hot"]);
  // A sign-in re-baselines with a full read; the legacy summary probe never runs.
  c.reconnected();
  await step(1000);
  assert.deepEqual(calls, ["hot", "content", "full"]);
  assert.deepEqual(movedCourses({ a: "1", account: "x" }, { a: "1", c: "1", account: "y" }), ["c"]);
});
