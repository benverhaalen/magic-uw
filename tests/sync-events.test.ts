/**
 * fix/sync-events: no reruns. Synthetic probes only; no network, no course data.
 */
import test from "node:test";
import assert from "node:assert/strict";
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
