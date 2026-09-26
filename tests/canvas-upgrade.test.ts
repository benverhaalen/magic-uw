import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canvasConnector,
  courseSelection,
  parseAcademicTerm,
  fetchCanvasActivitySummary,
  type CanvasConnectorOptions,
} from "../packages/connectors/src/canvas";
import {
  CanvasHttp,
  checkedCanvasUrl,
} from "../packages/connectors/src/canvas-http";
import { canvasContent } from "../packages/connectors/src/canvas-content";
import { createSyntheticCanvasUniversity } from "../packages/connectors/src/canvas-fixture";
import { createStore } from "@magic/storage";
import { type CaptureBatch } from "@magic/contracts";
const now = () => new Date("2026-09-26T15:00:00Z");
const sleep = async () => {};
async function run(options: CanvasConnectorOptions) {
  const batches: CaptureBatch[] = [];
  for await (const batch of canvasConnector({
    now,
    sleep,
    random: () => 0,
    ...options,
  }).pull())
    batches.push(batch);
  return batches;
}
const json = (
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

test("synthetic university selects five classes, records exclusions, captures whole scopes, and keeps secrets out", async () => {
  const university = createSyntheticCanvasUniversity();
  const feeds: string[] = [],
    progress: Array<{ scope: string; complete: boolean }> = [];
  const batches = await run({
    fetch: university.fetch,
    origin: university.origin,
    onCalendarFeed: (feed) => {
      feeds.push(feed.url);
    },
    onProgress: (event) => progress.push(event),
  });
  const catalog = [
    ...new Map(
      batches
        .filter((b) => b.source.scope === "course")
        .map((batch) => [batch.source.courseId, batch]),
    ).values(),
  ];
  assert.equal(catalog.length, 11);
  assert.equal(
    catalog.filter((b) => b.resources[0]?.course?.selection?.included).length,
    5,
  );
  assert.equal(
    catalog.find((b) => b.source.courseId === "301")?.status,
    "not_published",
  );
  assert.ok(
    catalog
      .filter((b) => !b.resources[0]?.course?.selection?.included)
      .every((b) => b.resources[0]!.course!.selection!.reasons.length),
  );
  assert.equal(feeds.length, 5);
  const stored = JSON.stringify(batches);
  for (const secret of [
    "SYNTHETIC_CAPABILITY",
    "SYNTHETIC_DOWNLOAD_SECRET",
    "never-store@example.test",
    "author_id",
  ])
    assert.ok(!stored.includes(secret), secret);
  const scopes = new Set(
    batches
      .filter((b) => b.source.courseId === "101")
      .map((b) => b.source.scope),
  );
  for (const scope of [
    "assignments",
    "modules",
    "module-items:1",
    "announcements",
    "pages",
    "page:7",
    "files",
    "folders",
    "assignment-groups",
    "quizzes",
    "discussions",
    "details",
    "syllabus",
    "submissions",
    "account-todo",
  ])
    assert.ok(scopes.has(scope), scope);
  assert.ok(
    batches
      .find((b) => b.source.scope === "page:7")!
      .resources[0]!.text.includes("Complete specification"),
  );
  assert.ok(
    university.calls.some((call) => call.url.endsWith("/pages/unreferenced")),
  );
  assert.ok(
    batches.some(
      (b) => b.source.scope === "page:8" && b.complete && b.resources[0]?.text,
    ),
  );
  assert.ok(
    university.calls.findIndex((call) => call.url.endsWith("/pages/spec")) <
      university.calls.findIndex((call) =>
        call.url.endsWith("/pages/unreferenced"),
      ),
  );
  assert.equal(
    batches.find(
      (b) => b.source.scope === "assignments" && b.source.courseId === "101",
    )!.resources[0]!.text,
    "",
  );
  assert.ok(university.stats().rateSent);
  assert.ok(
    university.stats().maxActive > 1 && university.stats().maxActive <= 8,
  );
  assert.ok(progress.some((p) => !p.complete));
  const paged = batches.filter(
    (b) => b.source.scope === "assignments" && b.source.courseId === "105",
  );
  assert.deepEqual(
    paged.map((b) => [b.resources.length, b.complete]),
    [
      [100, false],
      [200, false],
      [205, true],
    ],
  );
  assert.deepEqual(
    paged.map((b) => b.stats!.requests),
    [1, 2, 3],
  );
  assert.equal(
    batches.find(
      (b) => b.source.scope === "assignments" && b.source.courseId === "102",
    )!.stats!.requests,
    2,
  );
  assert.ok(
    batches.findIndex((b) => b.source.scope === "account-todo") <
      batches.findIndex((b) => b.source.scope === "assignments"),
  );
  for (const call of university.calls) {
    const url = new URL(call.url);
    assert.equal(url.origin, university.origin);
    assert.equal(call.credentials, "include");
    assert.equal(call.method, "GET");
    assert.equal(call.headers.has("cookie"), false);
    assert.equal(call.headers.has("authorization"), false);
    if (url.pathname.endsWith("/announcements")) {
      assert.ok(url.searchParams.has("start_date"));
      assert.ok(url.searchParams.has("end_date"));
      assert.equal(url.searchParams.getAll("context_codes[]").length, 1);
    }
    if (
      /\/(?:assignments|modules|items|announcements|files|folders|assignment_groups|quizzes|discussion_topics|pages|todo|upcoming_events|activity_stream|summary|submissions)$/.test(
        url.pathname,
      )
    )
      assert.equal(url.searchParams.get("per_page"), "100");
  }
  const comments = batches.find((b) => b.source.scope === "submissions")!
    .resources[0]!;
  assert.match(
    comments.submission!.comments![0]!.text,
    /Private synthetic feedback/,
  );
  assert.equal(comments.text, "");
});

test("selection retains reasons, restricts account overrides, checks enrollment locally, and parses term ranges", () => {
  const university = createSyntheticCanvasUniversity();
  const non = university.courses.find((c) => c.id === 201)!;
  assert.equal(courseSelection(non).included, false);
  assert.equal(
    courseSelection(non, {
      accountScope: "a",
      courseOverrides: [{ accountScope: "b", courseId: "201", included: true }],
    }).included,
    false,
  );
  assert.equal(
    courseSelection(non, {
      accountScope: "a",
      courseOverrides: [{ accountScope: "a", courseId: "201", included: true }],
    }).included,
    true,
  );
  assert.equal(
    courseSelection(university.courses[0]!, { selectedTerm: "Spring 2027" })
      .included,
    false,
  );
  assert.equal(
    courseSelection({
      ...university.courses[0]!,
      enrollments: [{ type: "teacher", enrollment_state: "active" }],
    }).included,
    false,
  );
  assert.equal(
    courseSelection(
      {
        ...university.courses[0]!,
        workflow_state: "unpublished",
        access_restricted_by_date: false,
      },
      {
        accountScope: "a",
        courseOverrides: [
          { accountScope: "a", courseId: "101", included: true },
        ],
      },
    ).included,
    false,
  );
  assert.deepEqual(parseAcademicTerm("Fall 2026 to 2027"), {
    season: "fall",
    year: 2026,
    endYear: 2027,
    key: "fall:2026",
  });
  assert.equal(parseAcademicTerm("Default Term"), null);
});

test("individual malformed records retain valid neighbors and diagnostics only name fields", async () => {
  const university = createSyntheticCanvasUniversity({
    malformedAssignment: true,
  });
  const batches = await run({
    fetch: university.fetch,
    origin: university.origin,
  });
  const assignments = batches.find(
    (b) => b.source.scope === "assignments" && b.source.courseId === "103",
  )!;
  assert.equal(assignments.complete, false);
  assert.equal(assignments.status, "partial");
  assert.equal(assignments.resources.length, 1);
  assert.ok(assignments.diagnostics?.some((d) => d.path.includes("due_at")));
  assert.ok(!JSON.stringify(batches).includes("INVALID_PRIVATE_VALUE"));
});

test("unknown submission status survives as evidence without inferring completion", async () => {
  const university = createSyntheticCanvasUniversity({ rateLimit: false });
  const fetch: CanvasConnectorOptions["fetch"] = async (url, init) => {
    const response = await university.fetch(url, init);
    if (!new URL(url).pathname.endsWith("/assignments")) return response;
    const rows = (await response.json()) as Array<Record<string, unknown>>;
    for (const row of rows)
      row.submission = { workflow_state: "new_canvas_state" };
    return json(rows);
  };
  const batches = await run({ fetch, origin: university.origin });
  const capture = batches.find((b) => b.source.scope === "assignments")!;
  assert.equal(capture.complete, true);
  assert.equal(capture.resources[0]!.submitted, null);
  assert.equal(
    capture.resources[0]!.submission!.workflowState,
    "new_canvas_state",
  );
  assert.ok(
    capture.diagnostics?.some((d) => d.code === "unknown_submission_state"),
  );
});

test("rate-limit 403 retries four times, records budgets, and never masquerades as sign-in", async () => {
  let requests = 0;
  const waits: number[] = [];
  const http = new CanvasHttp({
    origin: "https://canvas.synthetic.test",
    fetch: async () => {
      requests++;
      return json({ errors: [{ message: "Rate Limit Exceeded" }] }, 403, {
        "retry-after": "0",
        "x-rate-limit-remaining": "90",
        "x-request-cost": "1.5",
      });
    },
    sleep: async (ms) => {
      waits.push(ms);
    },
    random: () => 0,
  });
  await assert.rejects(
    http.request("https://canvas.synthetic.test/api/v1/courses"),
    (error) =>
      error instanceof Error && "status" in error && error.status === "partial",
  );
  assert.equal(requests, 5);
  assert.equal(http.needsSignIn, false);
  assert.equal(http.rate.remaining, 90);
  assert.equal(http.rate.cost, 1.5);
  assert.ok(waits.includes(625));
  const auth = new CanvasHttp({
    origin: "https://canvas.synthetic.test",
    fetch: async () => json({ message: "not authorized" }, 403),
    sleep,
  });
  await assert.rejects(
    auth.request("https://canvas.synthetic.test/api/v1/courses"),
  );
  assert.equal(auth.needsSignIn, true);
});

test("expiry halts further Canvas requests, preserves earlier pages, and cannot remove stored items", async () => {
  const directory = mkdtempSync(join(tmpdir(), "canvas-expiry-")),
    store = createStore(join(directory, "test.sqlite"));
  try {
    const first = createSyntheticCanvasUniversity();
    for (const batch of await run({ fetch: first.fetch, origin: first.origin }))
      store.ingest(batch);
    const expired = createSyntheticCanvasUniversity({
      expireDuringPagination: true,
    });
    const batches = await run({
      fetch: expired.fetch,
      origin: expired.origin,
      metadataConcurrency: 1,
      now: () => new Date("2026-09-27T15:00:00Z"),
    });
    for (const batch of batches) store.ingest(batch);
    const last = batches
      .filter(
        (b) => b.source.scope === "assignments" && b.source.courseId === "105",
      )
      .at(-1)!;
    assert.equal(last.status, "needs_sign_in");
    assert.equal(last.complete, false);
    assert.equal(last.resources.length, 100);
    assert.equal(
      store
        .resources()
        .filter(
          (r) =>
            r.courseId === "105" &&
            r.sourceId.endsWith(":assignments") &&
            !r.deleted,
        ).length,
      205,
    );
    assert.match(
      expired.calls.at(-1)!.url,
      /courses\/105\/assignments.*page=2/,
    );
    assert.equal(batches.at(-1)!.status, "needs_sign_in");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("revision ingestion yields date, requirement, grading, removal and restoration events; warm pages skip bodies", async () => {
  const directory = mkdtempSync(join(tmpdir(), "canvas-changes-")),
    store = createStore(join(directory, "test.sqlite"));
  try {
    const first = createSyntheticCanvasUniversity();
    for (const batch of await run({ fetch: first.fetch, origin: first.origin }))
      store.ingest(batch);
    const warm = createSyntheticCanvasUniversity();
    await run({
      fetch: warm.fetch,
      origin: warm.origin,
      knownResources: store.resources(),
    });
    assert.equal(
      warm.calls.filter((c) => /\/pages\/spec$/.test(c.url)).length,
      0,
    );
    const changed = createSyntheticCanvasUniversity({ revision: 2 });
    for (const batch of await run({
      fetch: changed.fetch,
      origin: changed.origin,
      now: () => new Date("2026-09-27T15:00:00Z"),
    }))
      store.ingest(batch);
    const kinds = new Set(
      store.changes({ limit: 2000 }).map((event) => event.type),
    );
    for (const kind of [
      "date_changed",
      "requirements_changed",
      "graded",
      "removed",
    ] as const)
      assert.ok(kinds.has(kind), kind);
    const restored = createSyntheticCanvasUniversity({ revision: 3 });
    for (const batch of await run({
      fetch: restored.fetch,
      origin: restored.origin,
      now: () => new Date("2026-09-28T15:00:00Z"),
    }))
      store.ingest(batch);
    assert.ok(
      store.changes({ limit: 2000 }).some((event) => event.type === "restored"),
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("complete catalog absence excludes a known course without deleting its coursework or enriching it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "canvas-catalog-")),
    store = createStore(join(directory, "test.sqlite"));
  try {
    const first = createSyntheticCanvasUniversity({ rateLimit: false });
    for (const batch of await run({ fetch: first.fetch, origin: first.origin }))
      store.ingest(batch);
    assert.equal(
      store
        .resources()
        .filter(
          (resource) =>
            resource.kind === "course" &&
            resource.courseId === "101" &&
            !resource.deleted,
        ).length,
      1,
    );
    const second = createSyntheticCanvasUniversity({ rateLimit: false });
    const fetch: CanvasConnectorOptions["fetch"] = async (url, init) => {
      const response = await second.fetch(url, init);
      if (new URL(url).pathname !== "/api/v1/courses") return response;
      const courses = (await response.json()) as Array<{ id: number }>;
      return json(courses.filter((course) => course.id !== 101));
    };
    const batches = await run({
      fetch,
      origin: second.origin,
      knownResources: store.resources(),
      now: () => new Date("2026-09-27T15:00:00Z"),
    });
    for (const batch of batches) store.ingest(batch);
    const course = store
      .resources()
      .find(
        (resource) =>
          resource.kind === "course" &&
          resource.courseId === "101" &&
          !resource.deleted,
      )!;
    assert.equal(course.course!.selection!.included, false);
    assert.ok(
      batches.some(
        (batch) =>
          batch.source.courseId === "101" &&
          batch.diagnostics?.some(
            (diagnostic) =>
              diagnostic.code === "absent_from_active_course_catalog",
          ),
      ),
    );
    assert.ok(
      store
        .resources()
        .some(
          (resource) =>
            resource.courseId === "101" &&
            resource.sourceId.endsWith(":assignments") &&
            !resource.deleted,
        ),
    );
    assert.ok(
      !second.calls.some((call) => /\/courses\/101(?:\/|\?)/.test(call.url)),
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("strict API query checks and evidence scrubbing reject credentials while retaining stable file identities", () => {
  const origin = "https://canvas.synthetic.test";
  assert.equal(
    checkedCanvasUrl(`${origin}/api/v1/files/19`, origin),
    `${origin}/api/v1/files/19`,
  );
  for (const url of [
    `${origin}/api/v1/files/19?verifier=secret`,
    `${origin}/api/v1/files/no`,
    `${origin}/api/v1/courses?enrollment_type=student`,
    `${origin}/api/v1/courses?access_token=secret`,
    "https://outside.test/api/v1/courses",
  ])
    assert.throws(() => checkedCanvasUrl(url, origin));
  const content = canvasContent(
    `<a href='/courses/101/files/9?verifier=SECRET'>File</a><a href='${origin}/feeds/calendars/course_SECRET.ics'>Feed</a><a href='https://outside.test/?access_token=SECRET'>Outside</a>`,
    origin,
  );
  assert.ok(!JSON.stringify(content).includes("SECRET"));
  assert.deepEqual(content.links, [{ url: `${origin}/courses/101/files/9` }]);
});

test("summary probe is bounded, session-only, and hashes values without account profile capture", async () => {
  const university = createSyntheticCanvasUniversity();
  const result = await fetchCanvasActivitySummary({
    fetch: university.fetch,
    origin: university.origin,
    sleep,
  });
  assert.equal(result.status, "ok");
  assert.match(result.hash!, /^[a-f0-9]{64}$/);
  assert.equal(university.calls.length, 1);
  assert.ok(university.calls[0]!.url.includes("activity_stream/summary"));
});
