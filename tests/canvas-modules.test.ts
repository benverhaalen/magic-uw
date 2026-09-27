import test from "node:test";
import assert from "node:assert/strict";
import { CanvasHttp } from "../packages/connectors/src/canvas-http";
import {
  createCanvasModuleRun,
  readCanvasModules,
  moduleItemsHash,
} from "../packages/connectors/src/canvas-modules";
import { fetchCanvasContentProbe } from "../packages/connectors/src/canvas-selection";
import { readCanvasInventory } from "../packages/connectors/src/canvas-inventory";
const origin = "https://canvas.wisc.edu";
const item = (id = 11, extra = {}) => ({
  id,
  module_id: 1,
  title: `Item ${id}`,
  type: "Page",
  page_url: `page-${id}`,
  ...extra,
});
function client(reply: (url: URL) => unknown | Response) {
  const calls: URL[] = [];
  const http = new CanvasHttp({
    origin,
    sleep: async () => {},
    fetch: async (input) => {
      const url = new URL(input);
      calls.push(url);
      const data = reply(url);
      return data instanceof Response
        ? data
        : new Response(JSON.stringify(data), {
            headers: { "content-type": "application/json" },
          });
    },
  });
  return { http, calls };
}
test("inline empty/items are complete and one run shares acquisition with inventory", async () => {
  const { http, calls } = client((url) =>
    url.pathname.endsWith("/modules")
      ? [
          { id: 1, name: "Week", items_count: 1, items: [item()] },
          { id: 2, name: "Empty", items_count: 0, items: [] },
        ]
      : [],
  );
  const run = createCanvasModuleRun("synthetic-account");
  const acquired = await readCanvasModules(http, "42", undefined, run);
  assert.equal(acquired.complete, true);
  assert.equal(acquired.requests, 1);
  const inventory = await readCanvasInventory(
    http,
    { id: "42" },
    [],
    undefined,
    run,
  );
  assert.equal(inventory.status, "ok");
  assert.equal(
    calls.filter((url) => url.pathname.endsWith("/modules")).length,
    1,
  );
  assert.equal(
    calls[0]!.searchParams.getAll("include[]").includes("items"),
    true,
  );
  assert.equal(acquired.accountScope, "synthetic-account");
});
for (const inline of [
  undefined,
  null,
  [{ invalid: true }],
  [item(11, { module_id: 99 })],
  [item(), item()],
]) {
  test(`untrusted inline ${JSON.stringify(inline)} falls back to checked paginated items`, async () => {
    const { http } = client((url) => {
      if (url.pathname.endsWith("/modules"))
        return [{ id: 1, name: "Week", items_count: 2, items: inline }];
      if (url.searchParams.get("page") === "2") return [item(12)];
      return new Response(JSON.stringify([item()]), {
        headers: {
          "content-type": "application/json",
          link: `<${origin}/api/v1/courses/42/modules/1/items?per_page=100&page=2>; rel="next"`,
        },
      });
    });
    const result = await readCanvasModules(http, "42");
    assert.equal(result.complete, true);
    assert.equal(result.requests, 3);
    assert.deepEqual(
      result.modules[0]!.items.map((row) => row.id),
      ["11", "12"],
    );
  });
}
test("malformed list neighbor and fallback count/identity failures retain evidence without complete membership", async () => {
  const { http } = client((url) =>
    url.pathname.endsWith("/modules")
      ? [
          { id: 1, name: "Week", items_count: 3, items: [item()] },
          { id: "invalid" },
        ]
      : [item(), item(), item(12, { module_id: 99 })],
  );
  const result = await readCanvasModules(http, "42");
  assert.equal(result.complete, false);
  assert.equal(result.listComplete, false);
  assert.equal(result.modules[0]!.complete, false);
  assert.deepEqual(
    result.modules[0]!.items.map((row) => row.id),
    ["11"],
  );
  assert.ok(result.modules[0]!.diagnostics.includes("module_id_mismatch"));
  const inventory = await readCanvasInventory(http, { id: "42" }, []);
  assert.equal(inventory.moduleHash, undefined);
});
test("same-count fallback replacement and retitle change module signatures", async () => {
  let current = item();
  const { http } = client((url) =>
    url.pathname.endsWith("/modules")
      ? [{ id: 1, name: "Week", items_count: 1 }]
      : [current],
  );
  async function signature() {
    const result = await readCanvasModules(http, "42");
    assert.equal(result.complete, true);
    return moduleItemsHash(
      result.modules.map((entry) => ({ ...entry.module, items: entry.items })),
    );
  }
  const original = await signature();
  current = item(12);
  const replacement = await signature();
  current = item(12, { title: "Revised" });
  assert.notEqual(original, replacement);
  assert.notEqual(replacement, await signature());
});
for (const newest of [
  { unexpected: true },
  [null],
  [{}],
  [{ id: 7, updated_at: "garbage" }],
]) {
  test(`content probe rejects malformed newest ${JSON.stringify(newest)} instead of signing empty`, async () => {
    const { http } = client((url) =>
      url.pathname.endsWith("/files") ? newest : [],
    );
    const probe = await fetchCanvasContentProbe(http, ["42"]);
    assert.equal(probe.status, "partial");
    assert.equal(probe.courses["42"], undefined);
  });
}
test("content probe fetches omitted module children and detects a same-count replacement", async () => {
  let current = item();
  const { http } = client((url) =>
    url.pathname.endsWith("/modules")
      ? [{ id: 1, name: "Week", items_count: 1, items: null }]
      : url.pathname.endsWith("/items")
        ? [current]
        : [],
  );
  const first = await fetchCanvasContentProbe(http, ["42"]);
  current = item(12);
  const second = await fetchCanvasContentProbe(http, ["42"]);
  assert.equal(first.status, "ok");
  assert.equal(first.requests, 5);
  assert.notEqual(first.courses["42"], second.courses["42"]);
});
test("module pagination plus fallback pagination is measured across the shared observation", async () => {
  const { http } = client((url) => {
    if (url.pathname.endsWith("/modules")) {
      if (url.searchParams.has("page"))
        return [{ id: 2, name: "Second", items_count: 0, items: [] }];
      return new Response(
        JSON.stringify([{ id: 1, name: "First", items_count: 2 }]),
        {
          headers: {
            "content-type": "application/json",
            link: `<${origin}/api/v1/courses/42/modules?per_page=100&page=2>; rel="next"`,
          },
        },
      );
    }
    if (url.searchParams.has("page")) return [item(12)];
    return new Response(JSON.stringify([item()]), {
      headers: {
        "content-type": "application/json",
        link: `<${origin}/api/v1/courses/42/modules/1/items?per_page=100&page=2>; rel="next"`,
      },
    });
  });
  const result = await readCanvasModules(http, "42");
  assert.equal(result.complete, true);
  assert.equal(result.requests, 4);
  assert.equal(result.modules.length, 2);
});
test("normal connector journey discovers syllabus, announcement, discussion and nested pages despite denied Pages list", async () => {
  const { canvasConnector } = await import("../packages/connectors/src/canvas");
  const course = {
    id: 42,
    name: "Synthetic",
    course_code: "HISTORY 201",
    workflow_state: "available",
    term: { name: "Fall 2026" },
    enrollments: [{ type: "student", enrollment_state: "active" }],
    syllabus_body: `<a href="${origin}/courses/42/pages/syllabus-page">Guide</a>`,
  };
  const readPages: string[] = [];
  const batches = [];
  for await (const batch of canvasConnector({
    origin,
    sleep: async () => {},
    fetch: async (input) => {
      const url = new URL(input),
        path = url.pathname;
      let data: unknown = [];
      if (path.endsWith("/profile")) data = { id: 123 };
      else if (path === "/api/v1/courses") data = [course];
      else if (path === "/api/v1/courses/42")
        data = {
          ...course,
          syllabus_body: `${course.syllabus_body}<a href="${origin}/courses/42/pages/late-syllabus">Late guide</a>`,
        };
      else if (path === "/api/v1/announcements")
        data = [
          {
            id: 77,
            title: "News",
            message: `<a href="${origin}/courses/42/pages/news-page">News details</a>`,
          },
        ];
      else if (path.endsWith("/discussion_topics"))
        data = [
          {
            id: 78,
            title: "Discuss",
            message: `<a href="${origin}/courses/42/pages/discussion-page">Discussion details</a>`,
          },
        ];
      else if (path === "/api/v1/courses/42/pages")
        return new Response('{"errors":[{"message":"unauthorized"}]}', {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      else if (path.startsWith("/api/v1/courses/42/pages/")) {
        const slug = path.split("/").at(-1)!;
        readPages.push(slug);
        data = {
          page_id: readPages.length + 100,
          title: slug,
          url: slug,
          body:
            slug === "syllabus-page"
              ? `<a href="${origin}/courses/42/pages/nested-page">Nested</a>`
              : `<a href="${origin}/courses/42/pages/syllabus-page">Cycle</a><a href="${origin}/courses/42/files/900/download">PDF</a>`,
        };
      }
      return new Response(JSON.stringify(data), {
        headers: { "content-type": "application/json" },
      });
    },
  }).pull())
    batches.push(batch);
  assert.deepEqual([...readPages].sort(), [
    "discussion-page",
    "late-syllabus",
    "nested-page",
    "news-page",
    "syllabus-page",
  ]);
  assert.equal(
    batches.find((batch) => batch.source.scope === "pages")?.complete,
    false,
  );
  assert.equal(
    batches.filter((batch) => batch.source.scope?.startsWith("page:")).length,
    5,
  );
});
