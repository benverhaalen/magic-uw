import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@magic/storage";
import { createIngestion } from "../apps/desktop/src/ingestion";
import { createSyntheticCanvasUniversity } from "../packages/connectors/src/canvas-fixture";
import { canvasFileId } from "../packages/connectors/src/canvas-references";
import {
  CanvasHttp,
  classifyCanvasAuth,
} from "../packages/connectors/src/canvas-http";
import type { PublicClient } from "../packages/connectors/src/network";
const origin = "https://canvas.wisc.edu";
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

test("file reference identity rejects foreign contexts and strips capabilities", () => {
  assert.equal(
    canvasFileId(
      `${origin}/courses/101/files/9007199254740993/preview?verifier=secret`,
      origin,
      "101",
    ),
    "9007199254740993",
  );
  assert.equal(canvasFileId(`${origin}/files/9/download`, origin, "101"), "9");
  assert.equal(
    canvasFileId(`${origin}/courses/102/files/9`, origin, "101"),
    undefined,
  );
  assert.equal(
    canvasFileId("https://evil.test/files/9", origin, "101"),
    undefined,
  );
});
test("auth evidence precedes generic 403; sequential ambiguous checks are bounded", async () => {
  assert.equal(
    classifyCanvasAuth(403, JSON.stringify({ status: "unauthenticated" })),
    "suspect",
  );
  let profiles = 0;
  const http = new CanvasHttp({
    fetch: async (url, init) => {
      assert.equal(
        new Headers(init?.headers).get("Accept"),
        "application/json+canvas-string-ids",
      );
      if (url.includes("/profile")) {
        profiles++;
        return json({}, 503);
      }
      return new Response("<html>temporary failure</html>", {
        headers: { "content-type": "text/html" },
      });
    },
  });
  for (let i = 0; i < 8; i++)
    await assert.rejects(http.request(`${origin}/api/v1/courses/101/pages`));
  assert.equal(profiles, 3);
  assert.equal(http.needsSignIn, false);
});

test("denied indexes still produce usable versioned linked documents and survive restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "magic-resilience-"));
  const database = join(directory, "db.sqlite");
  let store = createStore(database);
  let revision = 1,
    locked = false,
    scan = false,
    downloads = 0,
    bodyRevision = 1,
    missingBody = false;
  let date = new Date("2026-09-26T17:00:00Z");
  const university = createSyntheticCanvasUniversity({
    origin,
    rateLimit: false,
  });
  const client: PublicClient = {
    isCanvas: (url) => new URL(url).origin === origin,
    async get() {
      throw new Error("public fixture deliberately unavailable");
    },
    async text() {
      throw new Error("public fixture deliberately unavailable");
    },
    async feed() {
      return "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR";
    },
    async signedDownload(url) {
      downloads++;
      return {
        url,
        redirects: [],
        response: new Response(
          `Revision ${revision}: planted dependent learning material`,
          { headers: { "content-type": "text/plain" } },
        ),
      };
    },
  };
  const host = {
    directory,
    client,
    now: () => date,
    async secrets() {
      return {};
    },
    async canvasFetch(url: string, init?: RequestInit) {
      const path = new URL(url).pathname;
      if (/^\/api\/v1\/courses\/\d+\/(files|pages|quizzes)$/.test(path))
        return json({ status: "unauthorized" }, 403);
      if (path.endsWith("/pages/spec"))
        return json({
          page_id: 7,
          url: "spec",
          title: "Specification",
          updated_at: "2026-09-25T12:00:00Z",
          ...(missingBody
            ? {}
            : {
                body: `<p>Body revision ${bodyRevision}</p><a href="${origin}/files/9/preview">Reading</a>`,
              }),
        });
      if (path === "/api/v1/files/9")
        return json({
          id: "9",
          display_name: "Shared reading.txt",
          "content-type": "text/plain",
          updated_at: `2026-09-${25 + revision}T12:00:00Z`,
          locked_for_user: locked,
          url: `https://instructure-uploads.s3.amazonaws.com/9?signature=EPHEMERAL_ONLY`,
        });
      if (/^\/api\/v1\/courses\/\d+\/modules$/.test(path)) {
        const response = await university.fetch(url, init);
        const modules = (await response.json()) as Array<
          Record<string, unknown>
        >;
        for (const module of modules) {
          delete module.items;
          module.items_count = 2;
        }
        return json(modules);
      }
      if (path.endsWith("/modules/1/items"))
        return json([
          {
            id: 2,
            module_id: 1,
            type: "Page",
            page_url: "spec",
            title: "Spec",
          },
          {
            id: 3,
            module_id: 1,
            type: "File",
            content_id: 9,
            title: "Reading",
          },
        ]);
      return university.fetch(url, init);
    },
    extractor: {
      async extract(path: string) {
        const text = scan ? "" : readFileSync(path, "utf8");
        return {
          text,
          parts: text ? [{ text }] : [],
          pages: [],
          status: scan ? ("needs_ocr" as const) : ("ok" as const),
          diagnostics: scan ? ["ocr_unavailable"] : [],
        };
      },
    },
  };
  store.setIngestionSettings({
    ...store.ingestionSettings(),
    quietHours: { enabled: false, start: 1, end: 6 },
  });
  try {
    let runtime = createIngestion(store, host);
    const first = await runtime.tick("manual");
    assert.equal(first?.needsSignIn, false);
    assert.equal(
      downloads,
      5,
      "one download per course despite duplicate module/page discovery",
    );
    assert.equal(
      store
        .resources()
        .filter(
          (r) =>
            r.document?.fileId === "9" && r.text.includes("planted dependent"),
        ).length,
      5,
    );
    assert.ok(
      store
        .sources()
        .some(
          (s) =>
            s.courseId === "101" &&
            s.scope === "files" &&
            s.status === "inaccessible",
        ),
    );
    assert.ok(!JSON.stringify(store.resources()).includes("EPHEMERAL_ONLY"));
    assert.ok(
      store.resources("planted").length > 0,
      "actual stored extraction is searchable",
    );
    assert.ok(
      store
        .courseSpaces()
        .some((s) => s.url.endsWith("/files/9/preview") && s.lastReadAt),
      "file aliases resolve to actual saved text",
    );
    bodyRevision = 2;
    date = new Date(date.getTime() + 61_000);
    runtime.focus();
    await runtime.tick();
    assert.ok(
      store
        .resources()
        .filter((r) => r.url.endsWith("/pages/spec"))
        .every((r) => r.text.includes("Body revision 2")),
      "unchanged list metadata cannot hide a changed body",
    );
    missingBody = true;
    date = new Date(date.getTime() + 61_000);
    runtime.focus();
    await runtime.tick();
    assert.ok(
      store
        .resources()
        .filter((r) => r.url.endsWith("/pages/spec"))
        .every((r) => r.text.includes("Body revision 2")),
      "missing body preserves prior captured evidence",
    );
    missingBody = false;
    await runtime.stop();
    store.close();
    store = createStore(database);
    runtime = createIngestion(store, host);
    assert.equal(
      store.resources().filter((r) => r.document?.fileId === "9").length,
      5,
    );
    revision = 2;
    date = new Date("2026-09-27T17:00:00Z");
    await runtime.tick("manual");
    assert.ok(
      store
        .resources()
        .filter((r) => r.document)
        .every((r) => r.text.startsWith("Revision 2")),
    );
    locked = true;
    date = new Date("2026-09-28T17:00:00Z");
    const before = downloads;
    await runtime.tick("manual");
    assert.equal(
      downloads,
      before,
      "fresh lock blocks download even with saved readable metadata",
    );
    assert.ok(
      store
        .resources()
        .some((r) => r.document && r.text.startsWith("Revision 2")),
      "denial retains saved text",
    );
    locked = false;
    scan = true;
    revision = 3;
    date = new Date("2026-09-29T17:00:00Z");
    await runtime.tick("manual");
    assert.ok(
      store
        .resources()
        .filter((r) => r.document)
        .every(
          (r) => r.document?.extractionStatus === "needs_ocr" && r.text === "",
        ),
      "new unextractable version cannot be represented by old text",
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
