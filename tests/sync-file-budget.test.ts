import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@magic/storage";
import { createIngestion } from "../apps/desktop/src/ingestion";
import { createSyntheticCanvasUniversity } from "../packages/connectors/src/canvas-fixture";

test("file budget is shared across a full run's drains and deferred files advance next run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "magic-file-budget-"));
  const store = createStore(":memory:"),
    origin = "https://canvas.wisc.edu";
  const university = createSyntheticCanvasUniversity({
    origin,
    rateLimit: false,
  });
  let at = new Date("2026-09-26T17:00:00Z");
  const checks: string[] = [];
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });
  const runtime = createIngestion(store, {
    directory,
    now: () => at,
    secrets: async () => ({}),
    client: {
      isCanvas: (url) => new URL(url).origin === origin,
      get: async () => {
        throw new Error("Synthetic public read unavailable");
      },
      text: async () => {
        throw new Error("Synthetic public read unavailable");
      },
      feed: async () => "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR",
      signedDownload: async () => {
        throw new Error("Locked files must not download");
      },
    },
    canvasFetch: async (url, init) => {
      const path = new URL(url).pathname;
      if (/^\/api\/v1\/courses\/\d+\/modules$/.test(path)) {
        const response = await university.fetch(url, init);
        const modules = (await response.json()) as Array<
          Record<string, unknown>
        >;
        for (const module of modules) {
          delete module.items;
          if (String(module.id) === "1") module.items_count = 22;
        }
        return json(modules);
      }
      const module = /^\/api\/v1\/courses\/(\d+)\/modules\/1\/items$/.exec(
        path,
      );
      if (module)
        return json(
          Array.from({ length: 22 }, (_, i) => ({
            id: String(i + 1),
            module_id: "1",
            type: "File",
            title: `Reading ${i}`,
            content_id: String(Number(module[1]) * 100 + i),
          })),
        );
      if (/^\/api\/v1\/courses\/\d+\/files$/.test(path)) return json({}, 403);
      const file = /^\/api\/v1\/files\/(\d+)$/.exec(path);
      if (file) {
        checks.push(file[1]!);
        return json({
          id: file[1],
          display_name: "Restricted reading",
          locked_for_user: true,
        });
      }
      return university.fetch(url, init);
    },
  });
  try {
    await runtime.tick("manual");
    assert.equal(checks.length, 100);
    assert.ok(
      store
        .sources()
        .some((s) =>
          s.diagnostics?.some((d) => d.code === "file_budget_deferred"),
        ),
    );
    const first = new Set(checks);
    at = new Date(at.getTime() + 3600_000);
    await runtime.tick("manual");
    assert.equal(checks.length, 200);
    assert.ok(
      checks.slice(100).some((id) => !first.has(id)),
      "deferred work progresses before recently attempted work",
    );
  } finally {
    await runtime.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
