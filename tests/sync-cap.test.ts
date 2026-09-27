/**
 * sync-cap (operator decision, 2026-09-27): a Canvas scan closes after 30 seconds and treats
 * itself as populated; the next check probes. Synthetic Canvas only: no network, no course data.
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@magic/storage";
import { createIngestion, SYNC_CAP_MS } from "../apps/desktop/src/ingestion";
import type { CanvasConnectorOptions } from "../packages/connectors/src/canvas";
import { createRefreshCoordinator, type CourseProbe } from "../packages/core/src/refresh";

/** A read that never answers until its signal is aborted: a Canvas too slow to finish. */
const hang = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => queueMicrotask(resolve));
};

test("the coordinator ends a slow full read at the 30 s cap, keeps it as read, and the next check probes", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const time = { at: new Date(2026, 8, 27, 12) };
    const calls: string[] = [];
    const settled: boolean[] = [];
    const probe = (name: string) => async (): Promise<CourseProbe> => {
      calls.push(name);
      return { needsSignIn: false, courses: { a: "1" }, complete: true };
    };
    const coordinator = createRefreshCoordinator({
      settings: () => ({ enabled: true, intervalMinutes: 10, jitterFraction: 0, quietStartHour: 1, quietEndHour: 1 }),
      now: () => time.at,
      random: () => 0.5,
      hasSources: () => true,
      feeds: async () => ({ changed: false }),
      probe: async () => ({ needsSignIn: false }),
      full: (signal) => {
        calls.push("full");
        return hang(signal);
      },
      external: async () => {},
      record: () => {},
      hot: probe("hot"),
      content: probe("content"),
      warm: async (courses) => {
        calls.push(`warm:${courses.join(",")}`);
        return { needsSignIn: false };
      },
      capMs: SYNC_CAP_MS,
      settle: (capped) => void settled.push(capped),
    });
    let done = false;
    const running = coordinator.tick("manual").then((run) => ((done = true), run));
    await flush();
    assert.ok(calls.includes("full"), "the full read started");
    mock.timers.tick(SYNC_CAP_MS - 1);
    await flush();
    assert.equal(done, false, "still reading just before the cap");
    mock.timers.tick(1);
    const run = await running;
    assert.equal(run?.action, "refreshed", "a capped read finishes normally, not as a failure");
    assert.equal(run?.capped, true);
    assert.deepEqual(settled, [true], "the sources are settled as the run ends");
    // Six minutes later the background check only probes: no full read restarts after a capped one.
    time.at = new Date(time.at.getTime() + 6 * 60_000);
    calls.length = 0;
    const next = await coordinator.tick();
    assert.equal(next?.action, "unchanged");
    assert.deepEqual(calls, ["hot"], "probe only");
    assert.equal(next?.capped, undefined);
    await coordinator.stop();
  } finally {
    mock.timers.reset();
  }
});

const origin = "https://canvas.wisc.edu";
const fall = { id: 50, name: "Fall 2026-2027", start_at: "2026-09-02T05:00:00Z", end_at: "2026-12-23T06:00:00Z" };
const course = {
  id: 101, name: "SYNTH 400: Current course", course_code: "FA26 SYNTH 400 001", workflow_state: "available",
  enrollments: [{ type: "student", enrollment_state: "active" }], term: fall,
};

test("a capped Canvas sync ends near the cap, leaves no source reading, shows what it read as read, and records the cut", async () => {
  const directory = mkdtempSync(join(tmpdir(), "magic-sync-cap-"));
  const store = createStore(join(directory, "db.sqlite"));
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  let modulesRequested = 0;
  const fetch: CanvasConnectorOptions["fetch"] = async (input, init) => {
    const url = new URL(input);
    if (url.pathname === "/api/v1/users/self/profile") return json({ id: 7 });
    if (url.pathname === "/api/v1/courses") return json(url.searchParams.get("enrollment_state") === "completed" ? [] : [course]);
    if (url.pathname === "/api/v1/courses/101/assignments")
      // One valid assignment and one Canvas can't describe: the list is read, but partly.
      return json([
        { id: 1010, course_id: 101, name: "Synthetic problem set", description: "<p>Solve.</p>", due_at: "2026-10-01T23:00:00Z", lock_at: null, points_possible: 10, workflow_state: "published" },
        { unexpected: true },
      ]);
    if (url.pathname.startsWith("/api/v1/courses/101/modules")) {
      modulesRequested++;
      return hang((init?.signal as AbortSignal | undefined) ?? new AbortController().signal);
    }
    return json([]);
  };
  const offline = { isCanvas: () => false, async get() { throw new Error("offline"); }, async text() { throw new Error("offline"); }, async feed() { throw new Error("offline"); } } as never;
  const clock = { at: new Date(2026, 8, 27, 12) };
  const capMs = 300; // the injectable cap: the same code path as SYNC_CAP_MS, without a 30 s wait
  const ingestion = createIngestion(store, { directory, now: () => clock.at, canvasFetch: fetch, client: offline, secrets: async () => ({}), syncCapMs: capMs });
  try {
    // An earlier read left a partly read scope stamped "reading" (the connector's partial phase).
    store.ingest({
      source: { id: `canvas:stale:999:pages`, label: "Old · pages", kind: "canvas", accountScope: "stale", courseId: "999", scope: "pages" },
      observedAt: new Date(2026, 8, 27, 11).toISOString(), status: "partial", complete: false, resources: [],
      progress: { phase: "reading", completed: 0 },
    });
    const started = performance.now();
    const run = await ingestion.tick("manual");
    const elapsed = performance.now() - started;
    assert.ok(modulesRequested > 0, "the slow scope was requested");
    assert.ok(elapsed >= capMs - 20 && elapsed < capMs + 5_000, `ended near the cap (${Math.round(elapsed)} ms)`);
    assert.equal(run?.capped, true);
    assert.equal(run?.action, "refreshed");
    const sources = store.sources().filter((s) => s.kind === "canvas");
    assert.ok(sources.every((s) => s.progress?.phase !== "reading"), "no Canvas source is left reading");
    const stale = sources.find((s) => s.id === "canvas:stale:999:pages")!;
    assert.equal(stale.status, "partial", "a source this run did not read only loses its reading phase");
    const assignments = sources.find((s) => s.courseId === "101" && s.scope === "assignments")!;
    assert.ok(assignments, "the partly read list was saved before the cap");
    assert.equal(assignments.status, "ok");
    assert.equal(assignments.complete, true, "shown as read");
    assert.ok(assignments.diagnostics?.some((d) => d.code === "sync_capped"), "the data still says the read was cut short");
    assert.ok(store.resources().some((r) => r.courseId === "101" && r.kind === "assignment"), "what was read is kept");
    const recorded = store.syncRuns()[0]!;
    assert.equal(recorded.status, "partial", "the sync run records the cap");
    assert.ok(recorded.diagnostics?.some((d) => d.code === "sync_capped"));
    // The next background check probes; it does not restart the full read.
    clock.at = new Date(clock.at.getTime() + 6 * 60_000);
    modulesRequested = 0;
    const next = await ingestion.tick("background");
    assert.deepEqual(next?.probes, ["hot"]);
    assert.notEqual(next?.action, "failed");
    assert.equal(next?.warmCourses, undefined, "no course read again");
    assert.equal(modulesRequested, 0);
  } finally {
    await ingestion.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
