import assert from "node:assert/strict";
import test from "node:test";
import { captureBatchSchema, type CaptureBatch } from "@magic/contracts";
import { canvasConnector, type CanvasConnectorOptions } from "../packages/connectors/src/canvas";
import { createSyntheticCanvasUniversity } from "../packages/connectors/src/canvas-fixture";
import { createFetchScheduler } from "../packages/connectors/src/fetch-scheduler";

// A course's page bodies start together, but only the scheduler's slots run at once. A page's
// time budget covers its own request, not the time it waited behind the rest of the wave.
const now = () => new Date("2026-09-26T15:00:00Z");
const PAGES = 30;
const pageScopes = Array.from({ length: PAGES }, (_, index) => `page:${1000 + index}`);

function wait(ms: number, signal?: AbortSignal | null) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
/** The synthetic university, with course 101 holding many pages whose bodies take `delay(n)` ms. */
function manyPages(delay: (index: number) => number, onBody?: (index: number) => void) {
  const university = createSyntheticCanvasUniversity({ rateLimit: false });
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const fetch: CanvasConnectorOptions["fetch"] = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/api/v1/courses/101/pages")
      return json(Array.from({ length: PAGES }, (_, index) => ({
        page_id: 1000 + index,
        url: `p-${index}`,
        title: `Synthetic page ${index}`,
        updated_at: "2026-09-25T12:00:00Z",
      })));
    const body = path.match(/^\/api\/v1\/courses\/101\/pages\/p-(\d+)$/);
    if (body) {
      const index = Number(body[1]);
      onBody?.(index);
      await wait(delay(index), init?.signal);
      return json({
        page_id: 1000 + index,
        url: `p-${index}`,
        title: `Synthetic page ${index}`,
        updated_at: "2026-09-25T12:00:00Z",
        body: `<p>Synthetic guidance ${index}.</p>`,
      });
    }
    return university.fetch(url, init);
  };
  return { fetch, origin: university.origin };
}
async function pull(options: Partial<CanvasConnectorOptions> & Pick<CanvasConnectorOptions, "fetch">, signal?: AbortSignal) {
  const batches: CaptureBatch[] = [];
  let error: unknown;
  try {
    for await (const batch of canvasConnector({ now, sleep: async () => {}, random: () => 0, ...options }).pull(signal)) {
      captureBatchSchema.parse(batch);
      batches.push(batch);
    }
  } catch (caught) {
    error = caught;
  }
  return { batches, error };
}
const last = (batches: CaptureBatch[], scope: string) =>
  batches.filter((b) => b.source.courseId === "101" && b.source.scope === scope).at(-1);
const codes = (batch: CaptureBatch | undefined) => batch?.diagnostics?.map((d) => d.code) ?? [];

test("a page's time budget excludes the time it queued behind the rest of the page wave", async () => {
  // 30 pages x 25 ms through 2 slots is at least 375 ms of queue; each page's own read is 25 ms.
  const { fetch, origin } = manyPages(() => 25);
  const { batches, error } = await pull({
    fetch,
    origin,
    scopeTimeoutMs: 200,
    scheduler: createFetchScheduler({ concurrency: 2 }),
  });
  assert.equal(error, undefined);
  for (const scope of pageScopes) {
    const batch = last(batches, scope);
    assert.ok(batch, scope);
    assert.deepEqual(codes(batch), [], `${scope}: ${codes(batch).join(",")}`);
    assert.equal(batch.status, "ok", scope);
    assert.equal(batch.resources.length, 1, scope);
  }
});

test("a scope whose own request outlasts its budget still ends at the scope time limit", async () => {
  const { fetch, origin } = manyPages((index) => (index === 3 ? 5_000 : 5));
  const started = performance.now();
  const { batches, error } = await pull({
    fetch,
    origin,
    scopeTimeoutMs: 150,
    scheduler: createFetchScheduler({ concurrency: 2 }),
  });
  assert.equal(error, undefined);
  assert.ok(performance.now() - started < 2_000, "the slow page was stopped by its budget");
  const slow = last(batches, "page:1003");
  assert.equal(slow?.status, "partial");
  assert.equal(slow?.complete, false);
  assert.deepEqual(codes(slow), ["scope_time_limit"]);
  for (const scope of pageScopes.filter((scope) => scope !== "page:1003"))
    assert.equal(last(batches, scope)?.status, "ok", scope);
});

test("scopes still queued when the run is stopped record nothing and are not timed out", async () => {
  const stop = new AbortController();
  const read = new Set<number>();
  const { fetch, origin } = manyPages(
    () => 50,
    (index) => {
      read.add(index);
      // Stop the run while the first page body is in flight and the rest of the wave is queued.
      if (read.size === 1) setTimeout(() => stop.abort(), 10);
    },
  );
  const { batches, error } = await pull(
    { fetch, origin, scopeTimeoutMs: 100_000, scheduler: createFetchScheduler({ concurrency: 1 }) },
    stop.signal,
  );
  assert.ok(error, "the stopped run still reports its abort");
  assert.ok(read.size < PAGES);
  const pages = batches.filter((b) => b.source.courseId === "101" && b.source.scope.startsWith("page:"));
  assert.ok(!pages.some((b) => codes(b).includes("scope_time_limit")));
  // A scope that never reached the network keeps its prior stored state: no batch at all, so no
  // more page batches than page bodies actually fetched.
  assert.ok(pages.length <= read.size, `${pages.length} page batches for ${read.size} pages read`);
});
