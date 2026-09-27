/**
 * fix/sync-events: no reruns. Synthetic probes only; no network, no course data.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureBatchSchema } from "@magic/contracts";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { createIngestion } from "../apps/desktop/src/ingestion";
import fixture from "../fixtures/course.json";
import {
  createRefreshCoordinator,
  parseRefreshSnapshot,
  type CourseProbe,
  type RefreshDependencies,
  type RefreshSnapshot,
} from "../packages/core/src/refresh";

const minutes = (n: number) => n * 60_000;
function coordinator(options: {
  saved: { value?: RefreshSnapshot };
  fingerprint: () => string;
  time: { at: Date };
  calls: string[];
  hot?: () => Record<string, string>;
  content?: () => Record<string, string>;
  extra?: Partial<RefreshDependencies>;
}) {
  const probe = (name: string, courses: () => Record<string, string>) => async (): Promise<CourseProbe> => {
    options.calls.push(name);
    return { needsSignIn: false, courses: courses(), complete: true };
  };
  return createRefreshCoordinator({
    settings: () => ({ enabled: true, intervalMinutes: 10, jitterFraction: 0, quietStartHour: 1, quietEndHour: 6 }),
    now: () => options.time.at,
    random: () => 0.5,
    hasSources: () => true,
    feeds: async () => ({ changed: false }),
    probe: async () => ({ needsSignIn: false }),
    full: async () => {
      options.calls.push("full");
      return { needsSignIn: false };
    },
    external: async () => {},
    record: () => {},
    hot: probe("hot", options.hot ?? (() => ({ a: "1" }))),
    content: probe("content", options.content ?? (() => ({ a: "1" }))),
    warm: async (courses) => {
      options.calls.push(`warm:${courses.join(",")}`);
      return { needsSignIn: false };
    },
    fingerprint: options.fingerprint,
    persist: {
      load: () => options.saved.value,
      save: (snapshot) => {
        options.saved.value = structuredClone(snapshot);
      },
    },
    ...options.extra,
  });
}

test("a second launch within the freshness window probes only; no full read", async () => {
  const saved: { value?: RefreshSnapshot } = {};
  const time = { at: new Date(2026, 8, 28, 12) };
  const calls: string[] = [];
  const first = coordinator({ saved, fingerprint: () => "inventory-1", time, calls });
  await first.tick("manual");
  assert.ok(calls.includes("full"));
  await first.stop();
  assert.ok(parseRefreshSnapshot(saved.value), "baselines were saved");
  // The app relaunches 10 minutes later: a new coordinator over the same saved state.
  time.at = new Date(time.at.getTime() + minutes(10));
  calls.length = 0;
  const second = coordinator({ saved, fingerprint: () => "inventory-1", time, calls });
  const run = await second.tick();
  assert.equal(run?.action, "unchanged");
  assert.deepEqual(calls, ["hot"], "probes only");
});

test("baselines for another stored inventory (a purge, an import) are discarded: a full read follows", async () => {
  const saved: { value?: RefreshSnapshot } = {};
  const time = { at: new Date(2026, 8, 28, 12) };
  const calls: string[] = [];
  await coordinator({ saved, fingerprint: () => "inventory-1", time, calls }).tick("manual");
  time.at = new Date(time.at.getTime() + minutes(10));
  calls.length = 0;
  await coordinator({ saved, fingerprint: () => "inventory-2", time, calls }).tick();
  assert.ok(calls.includes("full"));
});

test("a sign-in discards saved baselines, so a restart before the sign-in read still reads fully", async () => {
  const saved: { value?: RefreshSnapshot } = {};
  const time = { at: new Date(2026, 8, 28, 12) };
  const calls: string[] = [];
  const first = coordinator({ saved, fingerprint: () => "inventory-1", time, calls });
  await first.tick("manual");
  first.reconnected();
  await first.stop();
  time.at = new Date(time.at.getTime() + minutes(1));
  calls.length = 0;
  await coordinator({ saved, fingerprint: () => "inventory-1", time, calls }).tick();
  assert.ok(calls.includes("full"));
});

test("corrupt or foreign saved state is ignored", () => {
  assert.equal(parseRefreshSnapshot({ version: 2 }), undefined);
  assert.equal(parseRefreshSnapshot({ version: 1, fingerprint: "x", fullAt: "soon", contentAt: 0, componentBaseline: {} }), undefined);
  assert.equal(parseRefreshSnapshot({ version: 1, fingerprint: "x", fullAt: 1, contentAt: 0, componentBaseline: { a: { m: 3 } } }), undefined);
  assert.ok(parseRefreshSnapshot({ version: 1, fingerprint: "x", fullAt: 1, contentAt: 0, componentBaseline: { a: { m: "h" } } }));
});

test("a manual refresh probes first and reads only the courses that moved; never two full reads in a row", async () => {
  const saved: { value?: RefreshSnapshot } = {};
  const time = { at: new Date(2026, 8, 28, 12) };
  const calls: string[] = [];
  let content: Record<string, string> = { a: "1", b: "1" };
  const c = coordinator({ saved, fingerprint: () => "inventory-1", time, calls, hot: () => ({ a: "1", b: "1" }), content: () => content });
  await c.tick("manual");
  assert.ok(calls.includes("full"), "the first sync is a full read");
  time.at = new Date(time.at.getTime() + minutes(1));
  calls.length = 0;
  const unchanged = await c.tick("manual");
  assert.deepEqual(calls, ["hot", "content"], "nothing moved: probes only");
  assert.equal(unchanged?.action, "unchanged");
  content = { a: "1", b: "2" };
  time.at = new Date(time.at.getTime() + minutes(1));
  calls.length = 0;
  const moved = await c.tick("manual");
  assert.deepEqual(calls, ["hot", "content", "warm:b"]);
  assert.deepEqual(moved?.warmCourses, ["b"]);
});

test("a moved course the inventory doesn't know escalates to a full read; if that fails the move is kept", async () => {
  const saved: { value?: RefreshSnapshot } = {};
  const time = { at: new Date(2026, 8, 28, 12) };
  const calls: string[] = [];
  let hot: Record<string, string> = { a: "1" };
  let fullFails = false;
  const c = coordinator({
    saved, fingerprint: () => "inventory-1", time, calls, hot: () => hot,
    extra: {
      warm: async (courses) => {
        calls.push(`warm:${courses.join(",")}`);
        return { needsSignIn: false, complete: true, inventoryChanged: courses.includes("new") };
      },
      full: async () => {
        calls.push("full");
        return fullFails ? { needsSignIn: false, complete: false } : { needsSignIn: false };
      },
    },
  });
  await c.tick("manual");
  hot = { a: "1", new: "1" };
  fullFails = true;
  time.at = new Date(time.at.getTime() + minutes(6));
  calls.length = 0;
  await c.tick();
  assert.deepEqual(calls, ["hot", "warm:new", "full"]);
  fullFails = false;
  time.at = new Date(time.at.getTime() + minutes(6));
  calls.length = 0;
  await c.tick();
  assert.deepEqual(calls, ["hot", "warm:new", "full"], "the unread move is seen again");
  time.at = new Date(time.at.getTime() + minutes(6));
  calls.length = 0;
  await c.tick();
  assert.deepEqual(calls.filter((x) => x !== "hot" && x !== "content"), [], "then it's consumed");
});

test("a manual refresh runs the manual check and reads the courses it names and any with a pending retry", async () => {
  const saved: { value?: RefreshSnapshot } = {};
  const time = { at: new Date(2026, 8, 28, 12) };
  const calls: string[] = [];
  let content: Record<string, string> = { a: "1", b: "1" };
  let warmComplete = true;
  const c = coordinator({
    saved, fingerprint: () => "inventory-1", time, calls, hot: () => ({ a: "1", b: "1" }), content: () => content,
    extra: {
      manual: async () => {
        calls.push("manual");
        return { needsSignIn: false, courses: ["c"] };
      },
      warm: async (courses) => {
        calls.push(`warm:${courses.join(",")}`);
        return { needsSignIn: false, complete: warmComplete };
      },
    },
  });
  await c.tick("manual");
  content = { a: "1", b: "2" };
  warmComplete = false;
  time.at = new Date(time.at.getTime() + minutes(1));
  calls.length = 0;
  await c.tick("manual");
  assert.deepEqual(calls, ["hot", "content", "manual", "warm:b,c"]);
  // b's read didn't complete: its retry is saved, survives a relaunch, and the next manual refresh reads it at once.
  assert.ok(saved.value?.retryAt?.b);
  warmComplete = true;
  time.at = new Date(time.at.getTime() + minutes(1));
  calls.length = 0;
  const relaunched = coordinator({
    saved, fingerprint: () => "inventory-1", time, calls, hot: () => ({ a: "1", b: "1" }), content: () => content,
    extra: { manual: async () => ({ needsSignIn: false, courses: [] }), warm: async (courses) => (calls.push(`warm:${courses.join(",")}`), { needsSignIn: false }) },
  });
  await relaunched.tick("manual");
  assert.deepEqual(calls, ["hot", "content", "warm:b,c"], "both reads that didn't complete");
});

test("loaded times are clamped to now; forget() makes a course read again; a sign-in empties the saved state before the running read ends", async () => {
  const time = { at: new Date(2026, 8, 28, 12) };
  const future = time.at.getTime() + 24 * 3600_000;
  const saved: { value?: RefreshSnapshot } = {
    value: { version: 1, fingerprint: "inventory-1", hotBaseline: { a: "1" }, contentBaseline: { a: "1" }, componentBaseline: {}, fullAt: future, contentAt: future },
  };
  const calls: string[] = [];
  const c = coordinator({ saved, fingerprint: () => "inventory-1", time, calls });
  // fullAt in the future would postpone the backstop forever; clamped, the backstop comes 6 h from now.
  time.at = new Date(time.at.getTime() + 6 * 3600_000 + 1000);
  await c.tick();
  assert.ok(calls.includes("full"), "the backstop was not postponed by a future fullAt");
  time.at = new Date(time.at.getTime() + minutes(6));
  calls.length = 0;
  c.forget("a");
  await c.tick();
  assert.deepEqual(calls.filter((x) => x.startsWith("warm")), ["warm:a"], "a forgotten course is read again");
  c.invalidateSaved();
  assert.equal(saved.value?.fingerprint, "", "emptied at once");
  time.at = new Date(time.at.getTime() + minutes(6));
  await c.tick();
  assert.equal(saved.value?.fingerprint, "", "a run meanwhile can't save the old baselines back");
  c.reconnected();
  assert.equal(saved.value?.hotBaseline, undefined);
});

test("the real fingerprint changes across an import and a purge; Delete local data removes the saved baselines", async () => {
  const directory = mkdtempSync(join(tmpdir(), "magic-sync-events-"));
  const store = createStore(join(directory, "db.sqlite"));
  const core = createCore(store, { fixture: captureBatchSchema.parse(fixture) });
  const ingestion = createIngestion(store, {
    directory,
    canvasFetch: async () => new Response("{}", { status: 404, headers: { "content-type": "application/json" } }),
    secrets: async () => ({}),
    client: { isCanvas: () => false, async get() { throw new Error("offline"); }, async text() { throw new Error("offline"); }, async feed() { throw new Error("offline"); } } as never,
  });
  try {
    const first = store.generation!();
    assert.equal(store.generation!(), first, "stable between reads");
    await core.execute({ type: "import", batch: captureBatchSchema.parse(fixture) });
    const imported = store.generation!();
    assert.notEqual(imported, first, "an import replaces the workspace");
    // A saved snapshot beside the database, then Delete local data.
    const file = join(directory, "canvas-refresh.json");
    (await import("node:fs")).writeFileSync(file, JSON.stringify({ version: 1, fingerprint: "x", componentBaseline: {}, fullAt: 1, contentAt: 1 }));
    await core.execute({ type: "purge", confirmation: "DELETE LOCAL DATA" });
    ingestion.purged();
    assert.equal(existsSync(file), false, "the saved baselines were deleted");
    assert.notEqual(store.generation!(), imported, "after a purge the workspace is a new one");
  } finally {
    await ingestion.stop();
    await core.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
