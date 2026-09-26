import assert from "node:assert/strict";
import test from "node:test";
import {
  canvasConnector,
  type CanvasConnectorOptions,
} from "../packages/connectors/src/canvas";
import { captureBatchSchema, type CaptureBatch } from "@magic/contracts";

const origin = "https://canvas.wisc.edu";
const fixedNow = () => new Date("2026-09-26T15:00:00.000Z");
const course = {
  id: 42,
  name: "Synthetic Course",
  course_code: "HISTORY 201",
  workflow_state: "available",
  term: { id: 1, name: "Fall 2026" },
  enrollments: [{ type: "student", enrollment_state: "active" }],
  syllabus_body: "<h1>Course</h1><p>Discuss your reasoning.</p>",
};
const assignment = (id = 7, extra: Record<string, unknown> = {}) => ({
  id,
  course_id: 42,
  name: `Synthetic assignment ${id}`,
  description:
    "<p>Explain &amp; compare.</p><script>steal()</script><style>private</style><p>Then reflect.</p>",
  due_at: "2026-09-29T23:59:00-05:00",
  lock_at: "2026-09-30T23:59:00-05:00",
  points_possible: 10,
  ...extra,
});
const json = (data: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json", ...headers },
  });
function transport(
  assignmentReply: (url: URL) => Response | Promise<Response>,
  courseReply?: (url: URL) => Response | Promise<Response>,
) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetch: CanvasConnectorOptions["fetch"] = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init: init ?? {} });
    if (url.pathname === "/api/v1/users/self/profile")
      return json({
        id: 123,
        name: "Not stored",
        primary_email: "private@example.test",
      });
    if (url.pathname === "/api/v1/courses")
      return courseReply ? courseReply(url) : json([course]);
    if (url.pathname === "/api/v1/courses/42/assignments")
      return assignmentReply(url);
    if (url.pathname === "/api/v1/courses/42") return json(course);
    return json([]);
  };
  return { fetch, calls };
}
async function pull(
  fetch: CanvasConnectorOptions["fetch"],
  signal?: AbortSignal,
) {
  const batches: CaptureBatch[] = [];
  for await (const batch of canvasConnector({
    fetch,
    now: fixedNow,
    sleep: async () => {},
    random: () => 0,
  }).pull(signal)) {
    captureBatchSchema.parse(batch);
    batches.push(batch);
  }
  return batches;
}
const assignments = (batches: CaptureBatch[]) =>
  batches.filter((batch) => batch.source.scope === "assignments").at(-1)!;

test("Canvas maps current-user due and lock separately, uses submission evidence, and preserves markup without storing profile data", async () => {
  const mock = transport(() =>
    json([
      assignment(7, {
        submission: {
          assignment_id: 7,
          workflow_state: "submitted",
          submitted_at: "2026-09-26T10:00:00Z",
        },
        html_url: "javascript:alert(1)",
      }),
      assignment(8, {
        submission: { workflow_state: "unsubmitted", submitted_at: null },
      }),
      assignment(9, {
        submission: { workflow_state: "graded", submitted_at: null },
      }),
      assignment(10, { has_submitted_submissions: true }),
    ]),
  );
  const batches = await pull(mock.fetch);
  const batch = assignments(batches);
  assert.equal(batch.status, "ok");
  assert.equal(batch.complete, true);
  assert.deepEqual(
    batch.resources.map((row) => row.submitted),
    [true, false, null, null],
  );
  const row = batch.resources[0]!;
  assert.equal(row.text, "Explain & compare.\n\nThen reflect.");
  assert.equal(row.url, `${origin}/courses/42/assignments/7`);
  assert.equal(row.points, 10);
  assert.equal(row.policy.mode, "unknown");
  assert.deepEqual(
    row.deadlines.map(({ kind, value }) => ({ kind, value })),
    [
      { kind: "due", value: "2026-09-29T23:59:00-05:00" },
      { kind: "lock", value: "2026-09-30T23:59:00-05:00" },
    ],
  );
  assert.match(batch.source.accountScope, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(batches).includes("private@example.test"));
  assert.equal(
    batches.find((value) => value.source.scope === "syllabus")!.resources[0]!
      .text,
    "Course\n\nDiscuss your reasoning.",
  );
  for (const call of mock.calls) {
    assert.equal(call.init.method, "GET");
    assert.equal(call.init.credentials, "include");
    assert.equal(call.init.redirect, "manual");
    assert.deepEqual(call.init.headers, { Accept: "application/json" });
  }
  assert.equal(
    mock.calls
      .find((call) => call.url.pathname === "/api/v1/courses")!
      .url.searchParams.get("enrollment_state"),
    "active",
  );
  assert.equal(
    mock.calls
      .find((call) => call.url.pathname.endsWith("/assignments"))!
      .url.searchParams.get("include[]"),
    "submission",
  );
});

test("Canvas only marks assignments complete after all same-scope pages finish", async () => {
  const mock = transport((url) =>
    url.searchParams.get("page") === "2"
      ? json([assignment(8)])
      : json([assignment()], {
          link: `<${origin}/api/v1/courses/42/assignments?per_page=100&include[]=submission&page=2>; rel="next", <${origin}/api/v1/courses/42/assignments?page=1>; rel="current"`,
        }),
  );
  const batch = assignments(await pull(mock.fetch));
  assert.equal(batch.complete, true);
  assert.equal(batch.resources.length, 2);
  assert.equal(
    mock.calls.filter((call) => call.url.pathname.endsWith("/assignments"))
      .length,
    2,
  );
});

test("Canvas preserves a successful page when pagination drifts across origins or course scopes", async () => {
  for (const next of [
    "https://attacker.example/api/v1/courses/42/assignments?page=2",
    `${origin}/api/v1/courses/99/assignments?page=2`,
    `${origin}/login`,
    `${origin}/api/v1/courses/42/assignments?access_token=secret`,
  ]) {
    const mock = transport(() =>
      json([assignment()], { link: `<${next}>; rel="next"` }),
    );
    const batch = assignments(await pull(mock.fetch));
    assert.equal(batch.complete, false);
    assert.equal(batch.status, "partial");
    assert.equal(batch.resources.length, 1);
    assert.equal(
      mock.calls.filter((call) => call.url.pathname.endsWith("/assignments"))
        .length,
      1,
    );
  }
});

test("Canvas rejects login redirects, HTML login pages and authorization failures without following them", async () => {
  for (const response of [
    new Response(null, {
      status: 302,
      headers: { location: "https://login.wisc.edu/" },
    }),
    new Response("<html>NetID</html>", {
      headers: { "content-type": "text/html" },
    }),
    new Response(null, { status: 401 }),
    new Response(null, { status: 403 }),
  ]) {
    let calls = 0;
    const batches = await pull(async () => {
      calls++;
      return response;
    });
    assert.equal(calls, 1);
    assert.equal(batches.length, 1);
    assert.equal(batches[0]!.status, "needs_sign_in");
    assert.equal(batches[0]!.complete, false);
    assert.deepEqual(batches[0]!.resources, []);
  }
});

test("Canvas marks an expired session mid-course and retains its validated earlier page", async () => {
  const mock = transport((url) =>
    url.searchParams.has("page")
      ? new Response(null, { status: 401 })
      : json([assignment()], {
          link: `<${origin}/api/v1/courses/42/assignments?page=2>; rel="next"`,
        }),
  );
  const batches = await pull(mock.fetch);
  const batch = assignments(batches);
  assert.equal(batch.complete, false);
  assert.equal(batch.status, "needs_sign_in");
  assert.equal(batch.resources.length, 1);
  assert.equal(batches.at(-1)!.source.scope, "connection");
  assert.equal(batches.at(-1)!.status, "needs_sign_in");
});

test("Canvas schema drift and wrong course IDs cannot replace local records or prove deletion", async () => {
  for (const raw of [
    assignment(7, { course_id: 99 }),
    assignment(7, { due_at: undefined }),
    assignment(7, { id: "P1" }),
    assignment(7, {
      submission: { assignment_id: 99, workflow_state: "submitted" },
    }),
  ]) {
    const mock = transport(() => json([raw]));
    const batch = assignments(await pull(mock.fetch));
    assert.equal(batch.complete, false);
    assert.equal(batch.status, "partial");
    assert.deepEqual(batch.resources, []);
  }
});

test("Canvas rejects a broken second page but preserves data validated before it", async () => {
  const mock = transport((url) =>
    url.searchParams.has("page")
      ? json([assignment(8, { due_at: "tomorrow" })])
      : json([assignment()], {
          link: `<${origin}/api/v1/courses/42/assignments?page=2>; rel="next"`,
        }),
  );
  const batch = assignments(await pull(mock.fetch));
  assert.equal(batch.complete, false);
  assert.equal(batch.status, "partial");
  assert.deepEqual(
    batch.resources.map((row) => row.externalId),
    ["7"],
  );
});

test("Canvas bounds pagination and duplicate identities cannot overwrite an earlier page", async () => {
  const bounded = transport((url) => {
    const page = Number(url.searchParams.get("page") ?? "1");
    return json([assignment(page)], {
      link: `<${origin}/api/v1/courses/42/assignments?page=${page + 1}>; rel="next"`,
    });
  });
  const boundedBatch = assignments(await pull(bounded.fetch));
  assert.equal(boundedBatch.resources.length, 20);
  assert.equal(boundedBatch.complete, false);
  assert.equal(boundedBatch.status, "partial");
  assert.equal(
    bounded.calls.filter((call) => call.url.pathname.endsWith("/assignments"))
      .length,
    20,
  );
  const duplicate = transport((url) =>
    json(
      [assignment()],
      url.searchParams.has("page")
        ? {}
        : {
            link: `<${origin}/api/v1/courses/42/assignments?page=2>; rel="next"`,
          },
    ),
  );
  const duplicateBatch = assignments(await pull(duplicate.fetch));
  assert.equal(duplicateBatch.complete, false);
  assert.equal(duplicateBatch.resources.length, 1);
});

test("Canvas distinguishes absent syllabus from known empty and does not infer AI permission", async () => {
  for (const [syllabus_body, complete, status] of [
    [undefined, false, "partial"],
    [null, true, "ok"],
    ["", true, "ok"],
  ] as const) {
    const mock = transport(
      () => json([]),
      () => json([{ ...course, syllabus_body }]),
    );
    const batch = (await pull(mock.fetch)).find(
      (value) => value.source.scope === "syllabus",
    )!;
    assert.equal(batch.complete, complete);
    assert.equal(batch.status, status);
    assert.deepEqual(batch.resources, []);
  }
});

test("Canvas cancellation propagates and network failure never authorizes deletion", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  await assert.rejects(
    () =>
      pull(async () => {
        called = true;
        return json({});
      }, controller.signal),
    { name: "AbortError" },
  );
  assert.equal(called, false);
  const mock = transport(() => {
    throw new Error("Do not expose network detail or credentials");
  });
  const batch = assignments(await pull(mock.fetch));
  assert.equal(batch.status, "error");
  assert.equal(batch.complete, false);
  assert.deepEqual(batch.resources, []);
});

test("Canvas preserves indentation in course code examples", async () => {
  const mock = transport(() =>
    json([
      assignment(7, {
        description: "<pre>if ready:\n    run()\nelse:\n    wait()</pre>",
      }),
    ]),
  );
  const batch = assignments(await pull(mock.fetch));
  assert.equal(
    batch.resources[0]!.text,
    "if ready:\n    run()\nelse:\n    wait()",
  );
});

test("Canvas uses validated courses after a later course-list failure without claiming full coverage", async () => {
  const mock = transport(
    () => json([assignment()]),
    (url) =>
      url.searchParams.has("page")
        ? json([{ id: "invalid", name: null }])
        : json([course], {
            link: `<${origin}/api/v1/courses?page=2>; rel="next"`,
          }),
  );
  const batches = await pull(mock.fetch);
  const connection = batches.find(
    (batch) => batch.source.scope === "connection",
  )!;
  assert.equal(connection.status, "partial");
  assert.equal(connection.complete, false);
  assert.equal(assignments(batches).complete, true);
  assert.equal(assignments(batches).source.courseId, "42");
});
