import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@magic/storage";
import { createIngestion } from "../apps/desktop/src/ingestion";
import { createSyntheticCanvasUniversity } from "../packages/connectors/src/canvas-fixture";
import { canvasConnector } from "../packages/connectors/src/canvas";
import { hashCanvas } from "../packages/connectors/src/canvas-models";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const json = (data: unknown) =>
  new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  });

test(
  "reconnect drains the cancelled run and validates a new identity before accepting late transport results",
  { timeout: 10_000 },
  async () => {
    const origin = "https://canvas.wisc.edu";
    const directory = mkdtempSync(join(tmpdir(), "magic-reconnect-"));
    const store = createStore(":memory:");
    const university = createSyntheticCanvasUniversity({
      origin,
      rateLimit: false,
    });
    const oldEntered = barrier(),
      releaseOld = barrier(),
      oldReturned = barrier();
    const newProfileEntered = barrier(),
      releaseNewProfile = barrier();
    let identity = "9001",
      heldOld = false,
      oldSignal: AbortSignal | null | undefined;
    let oldSettled = false,
      nextSettled = false;
    const profileIds: string[] = [];
    const runtime = createIngestion(store, {
      directory,
      now: () => new Date("2026-09-26T17:00:00Z"),
      secrets: async () => ({}),
      client: {
        isCanvas: (value) => new URL(value).origin === origin,
        get: async () => {
          throw new Error("Synthetic public reads unavailable");
        },
        text: async () => {
          throw new Error("Synthetic public reads unavailable");
        },
        feed: async () => "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR",
        signedDownload: async () => {
          throw new Error("Synthetic downloads unavailable");
        },
      },
      canvasFetch: async (url, init) => {
        const path = new URL(url).pathname;
        const requestIdentity = identity;
        if (path === "/api/v1/users/self/profile") {
          profileIds.push(requestIdentity);
          if (requestIdentity === "9002") {
            assert.ok(
              oldSettled,
              "new identity validation starts after the old coordinator settles",
            );
            newProfileEntered.release();
            await releaseNewProfile.promise;
          }
          return json({ id: requestIdentity });
        }
        if (
          path === "/api/v1/courses/101/assignments" &&
          requestIdentity === "9001" &&
          !heldOld
        ) {
          heldOld = true;
          oldSignal = init?.signal;
          oldEntered.release();
          // Deliberately ignore cancellation: this transport completes after the new run starts.
          await releaseOld.promise;
          const response = await university.fetch(url, init);
          const rows = (await response.json()) as Array<
            Record<string, unknown>
          >;
          for (const row of rows) {
            row.id = "998877";
            row.name = "LATE_OLD_SESSION_RESPONSE";
          }
          oldReturned.release();
          return json(rows);
        }
        const response = await university.fetch(url, init);
        if (requestIdentity === "9002" && /\/assignments$/.test(path)) {
          const rows = (await response.json()) as Array<
            Record<string, unknown>
          >;
          for (const row of rows) row.name = "NEW_SESSION_ASSIGNMENT";
          return json(rows);
        }
        return response;
      },
    });
    store.setIngestionSettings({
      ...store.ingestionSettings(),
      enabled: true,
      quietHours: { enabled: false, start: 1, end: 6 },
    });
    store.ingest({
      source: {
        id: "canvas:synthetic-connection",
        label: "Synthetic connection",
        kind: "canvas",
        accountScope: "synthetic",
        courseId: "connection",
        scope: "connection",
      },
      observedAt: "2026-09-26T16:00:00Z",
      complete: false,
      status: "needs_sign_in",
      resources: [],
    });
    try {
      await runtime.reconnected();
      const oldRun = runtime.tick("background");
      void oldRun.then(() => {
        oldSettled = true;
      });
      await oldEntered.promise;
      identity = "9002";
      const reconnect = runtime.reconnected();
      const nextRun = runtime.tick("manual");
      void nextRun.then(() => {
        nextSettled = true;
      });
      assert.notEqual(
        nextRun,
        oldRun,
        "post-sign-in tick must not join the old run",
      );
      assert.equal(oldSignal?.aborted, true);
      await newProfileEntered.promise;
      await reconnect;
      assert.equal(
        nextSettled,
        false,
        "post-sign-in success requires the new profile response",
      );
      releaseOld.release();
      await oldReturned.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        store.resources().some((r) => r.title === "LATE_OLD_SESSION_RESPONSE"),
        false,
      );
      releaseNewProfile.release();
      const [oldResult, newResult] = await Promise.all([oldRun, nextRun]);
      assert.equal(oldResult?.action, "failed");
      assert.equal(newResult?.action, "refreshed");
      assert.equal(newResult?.needsSignIn, false);
      assert.notEqual(newResult, oldResult);
      assert.deepEqual(profileIds.slice(0, 2), ["9001", "9002"]);
      const sources = new Map(store.sources().map((s) => [s.id, s]));
      const captured = store
        .resources()
        .filter((r) => r.title === "NEW_SESSION_ASSIGNMENT");
      assert.ok(captured.length > 0);
      assert.ok(
        captured.every(
          (r) =>
            sources.get(r.sourceId)?.accountScope ===
            hashCanvas(`${origin}\n9002`),
        ),
      );
      assert.equal(
        store.resources().some((r) => r.title === "LATE_OLD_SESSION_RESPONSE"),
        false,
      );
    } finally {
      releaseOld.release();
      releaseNewProfile.release();
      await runtime.stop();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);


test("cancellation during identity reporting cannot publish a module run or start course reads", async () => {
  const entered = barrier(), release = barrier();
  const controller = new AbortController();
  const requests: string[] = [];
  let moduleRuns = 0;
  const connector = canvasConnector({
    fetch: async (url) => {
      requests.push(new URL(url).pathname);
      return json({ id: "9001", name: "Synthetic Student" });
    },
    onIdentity: async () => {
      entered.release();
      await release.promise;
    },
    onModuleRun: () => { moduleRuns++; },
  });
  const run = (async () => {
    for await (const _batch of connector.pull(controller.signal)) {}
  })();
  // Install the rejection handler before aborting the pending iterator.
  const rejected = assert.rejects(run, { name: "AbortError" });
  await entered.promise;
  controller.abort();
  release.release();
  await rejected;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(moduleRuns, 0);
  assert.deepEqual(requests, ["/api/v1/users/self/profile"]);
});

test("Canvas reconnect cannot advance Graph deltas for batches discarded during cancellation", { timeout: 10_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "magic-reconnect-graph-"));
  const store = createStore(":memory:");
  const entered = barrier(), release = barrier();
  const writes: string[] = [];
  let canvasReads = 0;
  const runtime = createIngestion(store, {
    directory,
    secrets: async () => ({}),
    canvasFetch: async () => { canvasReads++; return json({ id: "9001" }); },
    graph: {
      scopes: () => ["Calendars.Read"],
      state: {
        get: async () => undefined,
        set: async (key) => { writes.push(key); },
      },
      transport: async () => {
        entered.release();
        // A transport already completing can deliver its last page after cancellation.
        await release.promise;
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ value: [], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=synthetic" }),
        };
      },
    },
  });
  store.setIngestionSettings({ ...store.ingestionSettings(), enabled: true });
  try {
    const run = runtime.tick("manual");
    await entered.promise;
    const reconnect = runtime.reconnected();
    release.release();
    await Promise.all([run, reconnect]);
    assert.equal(store.sources().some((source) => source.scope === "graph_calendar"), false);
    assert.deepEqual(writes, [], "a discarded batch must be replayed from the old delta cursor");
    assert.equal(canvasReads, 0);
  } finally {
    release.release();
    await runtime.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
