import assert from "node:assert/strict";
import test from "node:test";
import { createFetchScheduler } from "../packages/connectors/src/fetch-scheduler";
import { CanvasHttp } from "../packages/connectors/src/canvas-http";

const origin = "https://canvas.synthetic.test";
const host = origin;
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

test("the scheduler never has more requests in flight than its per-host limit", async () => {
  const scheduler = createFetchScheduler({ concurrency: 3 });
  let active = 0,
    max = 0;
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      scheduler.run(host, async () => {
        active++;
        max = Math.max(max, active);
        await tick();
        active--;
        return index;
      }),
    ),
  );
  assert.deepEqual(results, Array.from({ length: 20 }, (_, index) => index));
  assert.equal(max, 3);
  assert.equal(scheduler.stats().maxInFlight, 3);
  // Hosts are independent: each gets its own limit.
  active = 0;
  max = 0;
  await Promise.all(
    ["https://a.test", "https://b.test"].flatMap((name) =>
      Array.from({ length: 6 }, () =>
        scheduler.run(name, async () => {
          active++;
          max = Math.max(max, active);
          await tick();
          active--;
        }),
      ),
    ),
  );
  assert.equal(max, 6);
});

test("a healthy budget adds no sleep; a low X-Rate-Limit-Remaining narrows the slots and paces", async () => {
  const waits: number[] = [];
  const scheduler = createFetchScheduler({
    concurrency: 6,
    now: () => 0,
    random: () => 0,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  let active = 0,
    max = 0;
  const burst = () =>
    Promise.all(
      Array.from({ length: 12 }, () =>
        scheduler.run(host, async () => {
          active++;
          max = Math.max(max, active);
          await tick();
          active--;
        }),
      ),
    );
  scheduler.observe(host, { remaining: 600 });
  await burst();
  assert.equal(max, 6);
  assert.deepEqual(waits, [], "no pacing sleep while the budget is healthy");
  // 150 left: one pre-flight penalty (50) above the low-water mark (100) → 2 slots.
  max = 0;
  scheduler.observe(host, { remaining: 150 });
  await burst();
  assert.equal(max, 2);
  assert.deepEqual(waits, []);
  // Below the low-water mark: one at a time, each after the 625 ms pause (600 + 25 + jitter 0).
  max = 0;
  scheduler.observe(host, { remaining: 40 });
  await burst();
  assert.equal(max, 1);
  assert.equal(waits.length, 12);
  assert.ok(waits.every((ms) => ms === 625));
});

test("the budget refills at Canvas's outflow rate, so a low reading recovers over time", () => {
  let now = 0;
  const scheduler = createFetchScheduler({ now: () => now });
  scheduler.observe(host, { remaining: 0 });
  assert.equal(scheduler.remaining(host), 0);
  now = 10_000; // 10 s at 10 per second
  assert.equal(scheduler.remaining(host), 100);
  now = 600_000;
  assert.equal(scheduler.remaining(host), 600, "never above the high-water mark");
});

test("a 429 honours Retry-After and pauses every request to the host", async () => {
  const waits: number[] = [];
  let calls = 0;
  const http = new CanvasHttp({
    origin,
    random: () => 0,
    sleep: async (ms) => {
      waits.push(ms);
    },
    fetch: async () => {
      calls++;
      return calls === 1
        ? json({ errors: [{ message: "Rate Limit Exceeded" }] }, 429, {
            "retry-after": "2",
            "x-rate-limit-remaining": "0.0",
          })
        : json([{ id: 1 }], 200, { "x-rate-limit-remaining": "550" });
    },
  });
  const result = await http.request(`${origin}/api/v1/courses?per_page=100`);
  assert.deepEqual(result.data, [{ id: 1 }]);
  assert.equal(calls, 2);
  assert.ok(waits.includes(2000), `waited ${waits.join(", ")}`);
  // The host-wide pause: another request on the same scheduler waits out what is left of it.
  let now = 0;
  const pauses: number[] = [];
  const scheduler = createFetchScheduler({
    now: () => now,
    sleep: async (ms) => {
      pauses.push(ms);
      now += ms;
    },
  });
  scheduler.pause(host, 1500);
  now = 500;
  await scheduler.run(host, async () => {});
  assert.equal(pauses[0], 1000);
});

test("Canvas's own throttle answer, a 403 'Rate Limit Exceeded' with no Retry-After, backs off exponentially", async () => {
  const waits: number[] = [];
  let calls = 0;
  const http = new CanvasHttp({
    origin,
    random: () => 0,
    sleep: async (ms) => {
      waits.push(ms);
    },
    fetch: async () => {
      calls++;
      // The exact response of instructure/canvas-lms app/middleware/request_throttle.rb.
      return calls <= 2
        ? new Response("403 Forbidden (Rate Limit Exceeded)\n", {
            status: 403,
            headers: {
              "content-type": "text/plain; charset=utf-8",
              "x-rate-limit-remaining": "0.0",
            },
          })
        : json([{ id: 2 }], 200, { "x-rate-limit-remaining": "590" });
    },
  });
  const result = await http.request(`${origin}/api/v1/courses?per_page=100`);
  assert.deepEqual(result.data, [{ id: 2 }]);
  assert.equal(calls, 3);
  assert.equal(http.needsSignIn, false);
  // 1 s, then 2 s: the backoff itself (the paced waits for the empty budget are 625 ms).
  assert.ok(waits.includes(1000) && waits.includes(2000), `waited ${waits.join(", ")}`);
});

test("identical concurrent GETs are read once (singleflight) and each caller gets its own copy", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const http = new CanvasHttp({
    origin,
    fetch: async () => {
      calls++;
      await gate;
      return json([{ id: 7, name: "Week one" }]);
    },
  });
  const url = `${origin}/api/v1/courses/1/modules?per_page=100&include[]=items`;
  const both = Promise.all([http.request(url), http.request(url)]);
  release();
  const [a, b] = await both;
  assert.equal(calls, 1);
  assert.deepEqual(a.data, b.data);
  assert.notEqual(a.data, b.data, "a follower gets a copy, not the leader's object");
  // Without a reuse window, a later identical GET reads again.
  await http.request(url);
  assert.equal(calls, 2);
  // With one (a sync's scheduler), it is served from the finished read.
  const reuse = new CanvasHttp({
    origin,
    scheduler: createFetchScheduler({ reuseMs: 60_000 }),
    fetch: async () => {
      calls++;
      return json([{ id: 8 }]);
    },
  });
  calls = 0;
  await reuse.request(url);
  await reuse.request(url);
  assert.equal(calls, 1);
});

test("a follower whose leader was cancelled reads for itself", async () => {
  let calls = 0;
  const http = new CanvasHttp({
    origin,
    fetch: async (_url, init) => {
      calls++;
      if (calls === 1)
        await new Promise((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }),
        );
      return json([{ id: 9 }]);
    },
  });
  const url = `${origin}/api/v1/courses?per_page=100`;
  const leader = new AbortController();
  const first = http.request(url, leader.signal);
  const second = http.request(url);
  await tick();
  leader.abort();
  await assert.rejects(first);
  assert.deepEqual((await second).data, [{ id: 9 }]);
  assert.equal(calls, 2);
});

test("queued requests start in priority order", async () => {
  const scheduler = createFetchScheduler({ concurrency: 1 });
  const order: string[] = [];
  let release!: () => void;
  const hold = scheduler.run(host, () => new Promise<void>((resolve) => (release = resolve)));
  const queued = [
    scheduler.run(host, async () => void order.push("background"), { priority: 2 }),
    scheduler.run(host, async () => void order.push("page"), { priority: 1 }),
    scheduler.run(host, async () => void order.push("essential"), { priority: 0 }),
  ];
  await tick();
  release();
  await Promise.all([hold, ...queued]);
  assert.deepEqual(order, ["essential", "page", "background"]);
});
