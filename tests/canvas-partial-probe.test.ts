import assert from "node:assert/strict";
import test from "node:test";
import { CanvasHttp } from "../packages/connectors/src/canvas-http";
import { fetchCanvasContentProbe } from "../packages/connectors/src/canvas-selection";
import {
  createRefreshCoordinator,
  type CourseProbe,
} from "../packages/core/src/refresh";

test("partial probes preserve successful module signals while malformed neighbors stay unknown", async () => {
  let title = "Before";
  const http = new CanvasHttp({
    sleep: async () => {},
    fetch: async (url) =>
      new Response(
        JSON.stringify(
          url.includes("/modules")
            ? [{ id: "1", name: title, items_count: 0, items: [] }]
            : { unexpected: "not a list" },
        ),
        { headers: { "content-type": "application/json" } },
      ),
  });
  const first = await fetchCanvasContentProbe(http, ["42"]);
  title = "After";
  const second = await fetchCanvasContentProbe(http, ["42"]);
  assert.equal(second.status, "partial");
  assert.deepEqual(second.courses, {});
  assert.deepEqual(Object.keys(second.components!["42"]!), ["modules"]);
  assert.notEqual(
    first.components!["42"]!.modules,
    second.components!["42"]!.modules,
  );
});

test("partial component baselines detect real changes without treating missing signals as changes", async () => {
  let at = new Date(2026, 8, 28, 12),
    modules = "a",
    partial = false;
  const warm: string[][] = [];
  const content = async (): Promise<CourseProbe> => ({
    needsSignIn: false,
    complete: !partial,
    courses: {},
    components: {
      "42": partial
        ? { modules }
        : { modules, file: "same", page: "same", stream: "same" },
    },
  });
  const c = createRefreshCoordinator({
    now: () => at,
    random: () => 0.5,
    settings: () => ({
      enabled: true,
      intervalMinutes: 5,
      jitterFraction: 0,
      quietStartHour: 0,
      quietEndHour: 0,
    }),
    hasSources: () => true,
    feeds: async () => ({ changed: false }),
    probe: async () => ({ needsSignIn: false }),
    full: async () => ({ needsSignIn: false, complete: true }),
    external: async () => {},
    record: () => {},
    hot: async () => ({ needsSignIn: false, complete: true, courses: {} }),
    content,
    warm: async (ids) => {
      warm.push(ids);
      return { needsSignIn: false, complete: true };
    },
  });
  await c.tick("manual");
  partial = true;
  at = new Date(at.getTime() + 15 * 60_000);
  await c.tick();
  assert.equal(warm.length, 0);
  modules = "b";
  at = new Date(at.getTime() + 15 * 60_000);
  await c.tick();
  assert.deepEqual(warm, [["42"]]);
  partial = false;
  at = new Date(at.getTime() + 15 * 60_000);
  await c.tick();
  assert.equal(warm.length, 1);
});
