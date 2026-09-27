import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureBatchSchema } from "@magic/contracts";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { createIngestion } from "../apps/desktop/src/ingestion";
import { createSyntheticCanvasUniversity } from "../packages/connectors/src/canvas-fixture";
import {
  MaterialReadError,
  type PublicClient,
} from "../packages/connectors/src/network";

const origin = "https://canvas.wisc.edu";
const courseIds = ["101", "102", "103", "104", "105"];
const noPersistence = [
  "SYNTHETIC_CAPABILITY",
  "SYNTHETIC_DOWNLOAD_SECRET",
  "never-store@example.test",
  "Synthetic student - should not be stored",
  "author_id",
  "user_id",
];

/** An entirely synthetic host. Every possible network method terminates here. */
function publicHost() {
  const pageCalls: string[] = [],
    feedCalls: string[] = [];
  let revision = 1;
  const client: PublicClient = {
    isCanvas: (url) => new URL(url).origin === origin,
    async get(url, options) {
      options?.signal?.throwIfAborted();
      const parsed = new URL(url);
      assert.equal(parsed.origin, "https://courses.synthetic.test");
      assert.equal(parsed.search, "");
      const match = parsed.pathname.match(/^\/(10[1-5])\/(spec\.html)?$/);
      assert.ok(match, `Unexpected synthetic public path: ${parsed.pathname}`);
      pageCalls.push(url);
      const courseId = match[1]!;
      const body = match[2]
        ? `<h1>Extended requirements ${courseId}</h1><p>Public spec ${courseId}: justify every assumption and show a worked example.</p><a href="${origin}/courses/${courseId}/pages/spec">Canvas specification</a>`
        : `<h1>Course ${courseId}</h1><a href="spec.html">Extended requirements</a>`;
      return {
        url,
        redirects: [],
        response: new Response(body, {
          headers: { "content-type": "text/html" },
        }),
      };
    },
    async text(url, options) {
      options?.signal?.throwIfAborted();
      assert.equal(url, "https://courses.synthetic.test/robots.txt");
      throw new MaterialReadError("not_found");
    },
    async feed(url, canvasOrigin, signal) {
      signal?.throwIfAborted();
      assert.equal(canvasOrigin, origin);
      const parsed = new URL(url);
      assert.equal(parsed.origin, origin);
      const match = parsed.pathname.match(
        /^\/feeds\/calendars\/course_SYNTHETIC_CAPABILITY_(10[1-5])\.ics$/,
      );
      assert.ok(match);
      feedCalls.push(url);
      const courseId = match[1]!;
      const assignmentId =
        courseId === "105" ? "5001" : String(1000 + Number(courseId) - 100);
      return [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Synthetic runtime test//EN",
        "BEGIN:VEVENT",
        `UID:exact-assignment-${courseId}`,
        "DTSTAMP:20260926T170000Z",
        `LAST-MODIFIED:${revision === 1 ? "20260926T170000Z" : "20260927T170000Z"}`,
        `DTSTART:${revision === 1 ? "20260930T180000Z" : "20261001T180000Z"}`,
        `SUMMARY:Synthetic assignment ${assignmentId}`,
        `URL:${origin}/courses/${courseId}/assignments/${assignmentId}`,
        "END:VEVENT",
        // Matching titles alone must never become an assignment association.
        "BEGIN:VEVENT",
        `UID:unlinked-event-${courseId}`,
        "DTSTAMP:20260926T170000Z",
        "DTSTART;VALUE=DATE:20261002",
        "DTEND;VALUE=DATE:20261003",
        `SUMMARY:Synthetic assignment ${assignmentId}`,
        `URL:${origin}/courses/${courseId}`,
        "END:VEVENT",
        "END:VCALENDAR",
        "",
      ].join("\r\n");
    },
    async signedDownload() {
      assert.fail(
        "This runtime fixture must never attempt a signed file download",
      );
    },
  };
  return {
    client,
    pageCalls,
    feedCalls,
    changeFeed() {
      revision++;
    },
  };
}

test("runtime refresh saves scoped evidence, compiles supporting context, and keeps feeds live after Canvas expiry", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "magic-ingestion-runtime-"));
  const database = join(directory, "coursework.sqlite");
  const store = createStore(database);
  const vault: Record<string, string> = {};
  const publicReads = publicHost();
  let date = new Date("2026-09-26T17:00:00Z");
  let university = createSyntheticCanvasUniversity({
    origin,
    rateLimit: false,
  });
  const firstUniversity = university;
  store.setIngestionSettings({
    ...store.ingestionSettings(),
    jitterRatio: 0,
    quietHours: { enabled: false, start: 1, end: 6 },
  });
  const runtime = createIngestion(store, {
    directory,
    client: publicReads.client,
    now: () => date,
    async canvasFetch(url, init) {
      const response = await university.fetch(url, init);
      if (
        new URL(url).pathname !== "/api/v1/courses/101/assignments" ||
        !response.ok
      )
        return response;
      const rows = (await response.json()) as Array<{
        id: number;
        description: string;
      }>;
      // Still no assignment text; one exact empty anchor makes the support relation explicit.
      // The other empty assignment (1099) remains unlinked as a negative control.
      for (const row of rows)
        if (row.id === 1001)
          row.description = '<a href="/courses/101/pages/spec"></a>';
      return new Response(JSON.stringify(rows), {
        status: response.status,
        headers: response.headers,
      });
    },
    async secrets(operation, key, value) {
      if (operation === "list") return { ...vault };
      assert.ok(key);
      assert.ok(value);
      vault[key] = value;
    },
  });
  const core = createCore(store, {
    now: () => date,
    // Core's optional fixture action is never invoked by this integration test.
    fixture: captureBatchSchema.parse({
      source: {
        id: "unused-fixture",
        kind: "fixture",
        label: "Unused synthetic fixture",
        accountScope: "unused",
        courseId: "unused",
        scope: "unused",
      },
      observedAt: date.toISOString(),
      complete: true,
      status: "ok",
      resources: [],
    }),
  });
  try {
    const first = await runtime.tick("manual");
    assert.equal(first?.action, "refreshed");
    assert.equal(first?.needsSignIn, false);

    await t.test(
      "first refresh includes only current student courses and records bounded sync statistics",
      () => {
        const sources = new Map(
          store.sources().map((source) => [source.id, source]),
        );
        const catalog = store
          .resources()
          .filter(
            (resource) =>
              resource.kind === "course" &&
              sources.get(resource.sourceId)?.scope === "course",
          );
        assert.equal(catalog.length, 11);
        assert.deepEqual(
          catalog
            .filter((resource) => resource.course?.selection?.included)
            .map((resource) => resource.courseId)
            .sort(),
          courseIds,
        );
        assert.ok(
          catalog
            .filter((resource) => !resource.course?.selection?.included)
            .every((resource) => resource.course?.selection?.reasons.length),
        );
        assert.ok(
          !firstUniversity.calls.some((call) =>
            /\/courses\/(?:20[1-5]|301)(?:\/|\?|$)/.test(call.url),
          ),
        );
        assert.equal(Object.keys(vault).length, 5);
        assert.equal(publicReads.feedCalls.length, 5);
        assert.equal(publicReads.pageCalls.length, 10);
        assert.ok(
          store
            .sources()
            .filter(
              (source) => source.kind === "web" || source.kind === "calendar",
            )
            .every((source) => courseIds.includes(source.courseId)),
        );
        const paged = store
          .sources()
          .find(
            (source) =>
              source.courseId === "105" && source.scope === "assignments",
          )!;
        assert.equal(paged.stats?.requests, 3);
        assert.equal(paged.resourceCount, 205);
        const run = store.syncRuns()[0]!;
        assert.equal(run.action, "manual");
        assert.equal(run.status, "partial"); // Missing file API remains explicitly incomplete.
        assert.ok((run.sourceCount ?? 0) > 60);
        assert.ok((run.stats?.durationMs ?? -1) >= 0);
        assert.ok((run.stats?.firstValueMs ?? -1) >= 0);
        assert.ok(
          firstUniversity.calls.every(
            (call) =>
              call.method === "GET" &&
              call.credentials === "include" &&
              !call.headers.has("cookie") &&
              !call.headers.has("authorization"),
          ),
        );
      },
    );

    await t.test(
      "calendar and web evidence keep independent scopes and only exact associations reach context",
      () => {
        const sources = new Map(
          store.sources().map((source) => [source.id, source]),
        );
        const resources = store.resources();
        const assignment = resources.find(
          (resource) =>
            resource.courseId === "101" &&
            resource.externalId === "1001" &&
            sources.get(resource.sourceId)?.scope === "assignments",
        )!;
        const unrelated = resources.find(
          (resource) =>
            resource.courseId === "101" &&
            resource.externalId === "1099" &&
            sources.get(resource.sourceId)?.scope === "assignments",
        )!;
        const calendar = resources.filter(
          (resource) => resource.courseId === "101" && resource.calendar,
        );
        assert.equal(assignment.text, "");
        assert.equal(calendar.length, 2);
        assert.ok(
          calendar.every(
            (resource) =>
              sources.get(resource.sourceId)?.kind === "calendar" &&
              sources.get(resource.sourceId)?.scope === "calendar_feed",
          ),
        );
        const exact = calendar.find(
          (resource) => resource.calendar?.assignmentExternalId === "1001",
        )!;
        const unlinked = calendar.find(
          (resource) => !resource.calendar?.assignmentExternalId,
        )!;
        assert.ok(
          store
            .links()
            .some(
              (link) =>
                link.fromId === exact.id &&
                link.toId === assignment.id &&
                link.type === "same_as" &&
                link.status === "accepted",
            ),
        );
        assert.ok(
          !store
            .links()
            .some(
              (link) => link.fromId === unlinked.id && link.type === "same_as",
            ),
        );
        assert.equal(unlinked.calendar?.start, "2026-10-02");
        assert.equal(unlinked.calendar?.end, "2026-10-03");
        assert.equal(unlinked.deadlines.length, 0);
        assert.equal(assignment.deadlines[0]?.value, "2026-09-29T23:00:00Z");
        assert.equal(exact.deadlines[0]?.value, "2026-09-30T18:00:00.000Z");
        const resolved = core
          .snapshot()
          .resources.find(
            (resource) => resource.id === assignment.id,
          )!.deadline;
        assert.equal(resolved.conflict, true);
        assert.equal(resolved.dueAt, null);
        assert.equal(resolved.planningAt, "2026-09-29T23:00:00.000Z");
        assert.ok(
          resources.some(
            (resource) =>
              resource.courseId === "101" &&
              sources.get(resource.sourceId)?.kind === "web" &&
              resource.text.includes("Public spec 101"),
          ),
        );
        const context = core.context(assignment.id, "local");
        assert.equal(context.allowed, true);
        assert.match(
          context.payload.text,
          /Explain the method, show your steps, and cite course evidence/,
        );
        assert.match(
          context.payload.text,
          /Public spec 101: justify every assumption/,
        );
        assert.doesNotMatch(
          context.payload.text,
          /Public spec 102|Private synthetic feedback/,
        );
        assert.equal(core.context(unrelated.id, "local").payload.text, "");
        assert.equal(store.receipts().length, 0);
        // No model judgment without a gateway; only local lexical link-suggestion records exist.
        assert.equal(
          store.judgments().filter((j) => j.model !== "local-lexical").length,
          0,
        );
        assert.equal(core.snapshot().fixtureMode, false);
      },
    );

    const lastPageId = store
      .resources()
      .find(
        (resource) =>
          resource.courseId === "105" && resource.externalId === "5205",
      )!.id;
    const lastPageHash = store.resource(lastPageId)!.contentHash;
    const savedPageIds = store
      .resources()
      .filter(
        (resource) =>
          resource.courseId === "105" &&
          resource.sourceId.endsWith(":assignments"),
      )
      .map((resource) => resource.id);
    date = new Date("2026-09-27T17:00:00Z");
    publicReads.changeFeed();
    university = createSyntheticCanvasUniversity({
      origin,
      revision: 2,
      rateLimit: false,
      expireDuringPagination: true,
    });
    const expired = await runtime.tick("manual");
    await t.test(
      "expiry preserves unvisited pages and continues independent feed reads",
      () => {
        assert.equal(expired?.needsSignIn, true);
        assert.ok(university.stats().expired);
        assert.equal(store.syncRuns()[0]?.status, "needs_sign_in");
        assert.ok(
          store
            .sources()
            .filter((source) => source.kind === "canvas")
            .every((source) => source.status === "needs_sign_in"),
        );
        for (const id of savedPageIds)
          assert.equal(store.resource(id)?.deleted, false);
        assert.equal(store.resource(lastPageId)?.contentHash, lastPageHash);
        assert.ok(
          !store
            .changes({ limit: 2000 })
            .some(
              (change) =>
                change.type === "removed" &&
                savedPageIds.includes(change.resourceId),
            ),
        );
        assert.ok(
          store
            .sources()
            .filter((source) => source.kind === "calendar")
            .every((source) => source.status === "ok"),
        );
        const event = store
          .resources()
          .find(
            (resource) =>
              resource.courseId === "101" &&
              resource.calendar?.assignmentExternalId === "1001",
          )!;
        assert.equal(event.deadlines[0]?.value, "2026-10-01T18:00:00.000Z");
        assert.equal(publicReads.feedCalls.length, 15);
      },
    );

    const canvasCallsBeforeBackoff = university.calls.length;
    const publicCallsBeforeBackoff = publicReads.pageCalls.length;
    date = new Date(date.getTime() + 11 * 60_000);
    const backoff = await runtime.tick("background");
    await t.test(
      "backoff refreshes feeds without probing expired Canvas or recrawling before six hours",
      () => {
        assert.equal(backoff?.action, "feeds_only");
        assert.equal(backoff?.needsSignIn, true);
        assert.equal(university.calls.length, canvasCallsBeforeBackoff);
        assert.equal(publicReads.feedCalls.length, 20);
        assert.equal(publicReads.pageCalls.length, publicCallsBeforeBackoff);
        assert.equal(store.syncRuns().length, 3);
        assert.equal(store.syncRuns()[0]?.action, "background");
      },
    );

    await t.test(
      "vault capabilities and identity fields never persist in current or historical SQLite records",
      () => {
        assert.ok(
          Object.values(vault).every((url) =>
            url.includes("SYNTHETIC_CAPABILITY"),
          ),
        );
        const current = JSON.stringify(core.snapshot());
        const persisted = readdirSync(directory)
          .filter((name) => name.startsWith("coursework.sqlite"))
          .map((name) => readFileSync(join(directory, name)).toString("utf8"))
          .join("\n");
        for (const canary of noPersistence) {
          assert.ok(
            !current.includes(canary),
            `Snapshot leaked synthetic canary ${canary}`,
          );
          assert.ok(
            !persisted.includes(canary),
            `Database leaked synthetic canary ${canary}`,
          );
        }
        assert.doesNotMatch(
          current,
          /feeds\/calendars|[?&](?:signature|verifier)=/,
        );
        assert.doesNotMatch(
          persisted,
          /feeds\/calendars|[?&](?:signature|verifier)=/,
        );
      },
    );
  } finally {
    await runtime.stop();
    await core.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
