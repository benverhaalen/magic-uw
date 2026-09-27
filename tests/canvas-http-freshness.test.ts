import assert from "node:assert/strict";
import test from "node:test";
import {
  CanvasFailure,
  CanvasHttp,
} from "../packages/connectors/src/canvas-http";
import { createFetchScheduler } from "../packages/connectors/src/fetch-scheduler";

const origin = "https://canvas.wisc.edu";
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

for (const [path, first, second] of [
  [
    "/api/v1/users/self/profile",
    { id: "9007199254740993" },
    { id: "9007199254740995" },
  ],
  [
    "/api/v1/files/9",
    { id: "9", locked_for_user: false },
    { id: "9", locked_for_user: true },
  ],
  [
    "/api/v1/courses/1/pages/reading",
    { body: "Version one" },
    { body: "Version two" },
  ],
] as const) {
  test(`fresh request bypasses completed cache for ${path} while retaining host scheduling`, async () => {
    const scheduler = createFetchScheduler({
      concurrency: 1,
      reuseMs: 120_000,
    });
    let calls = 0;
    const http = new CanvasHttp({
      scheduler,
      fetch: async (_url, init) => {
        assert.equal(
          new Headers(init?.headers).get("Accept"),
          "application/json+canvas-string-ids",
        );
        return json(++calls === 1 ? first : second);
      },
    });
    assert.deepEqual((await http.request(origin + path)).data, first);
    assert.deepEqual((await http.request(origin + path)).data, first);
    assert.equal(calls, 1);
    let release!: () => void;
    const held = scheduler.run(
      origin,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    while (!release) await Promise.resolve();
    const fresh = http.request(origin + path, undefined, undefined, 0, {
      fresh: true,
    });
    await Promise.resolve();
    assert.equal(calls, 1, "fresh read waits for the shared host slot");
    release();
    await held;
    assert.deepEqual((await fresh).data, second);
    assert.equal(calls, 2);
    assert.equal(scheduler.stats().maxInFlight, 1);
  });
}

test(
  "shared expiry reaches both readers with one confirmation at concurrency one",
  { timeout: 2000 },
  async () => {
    const scheduler = createFetchScheduler({
      concurrency: 1,
      reuseMs: 120_000,
    });
    let reads = 0,
      confirmations = 0;
    const fetch = async (url: string, init?: RequestInit) => {
      assert.equal(
        new Headers(init?.headers).get("Accept"),
        "application/json+canvas-string-ids",
      );
      if (url.endsWith("/profile")) {
        confirmations++;
        return json({ status: "unauthenticated" }, 401);
      }
      reads++;
      return json({ status: "unauthenticated" }, 403);
    };
    const a = new CanvasHttp({ scheduler, fetch });
    const b = new CanvasHttp({ scheduler, fetch });
    const url = `${origin}/api/v1/courses/1/files`;
    const results = await Promise.allSettled([a.request(url), b.request(url)]);
    for (const result of results) {
      assert.equal(result.status, "rejected");
      if (result.status === "rejected") {
        assert.ok(result.reason instanceof CanvasFailure);
        assert.equal(result.reason.status, "needs_sign_in");
      }
    }
    assert.equal(reads, 1);
    assert.equal(confirmations, 1);
    assert.equal(a.needsSignIn, true);
    assert.equal(b.needsSignIn, true);
    await assert.rejects(b.request(url));
    assert.equal(reads, 1);
  },
);

test(
  "ambiguous confirmation remains bounded under the shared scheduler",
  { timeout: 2000 },
  async () => {
    let confirmations = 0;
    const http = new CanvasHttp({
      scheduler: createFetchScheduler({ concurrency: 1, reuseMs: 120_000 }),
      fetch: async (url) => {
        if (url.endsWith("/profile")) {
          confirmations++;
          return json({}, 503);
        }
        return json({ status: "unauthenticated" }, 403);
      },
    });
    for (let i = 0; i < 8; i++)
      await assert.rejects(
        http.request(`${origin}/api/v1/courses/1/files`),
        (error: unknown) =>
          error instanceof CanvasFailure && error.status === "partial",
      );
    assert.equal(confirmations, 3);
    assert.equal(http.needsSignIn, false);
  },
);
