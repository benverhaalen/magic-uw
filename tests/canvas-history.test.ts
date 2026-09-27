import test from "node:test";
import assert from "node:assert/strict";
import { canvasConnector, type CanvasConnectorOptions } from "../packages/connectors/src/canvas";
import { courseSchema, courseResource } from "../packages/connectors/src/canvas-models";
import { courseSelection } from "../packages/connectors/src/canvas-selection";
import { checkedCanvasUrl, canvasNextPage } from "../packages/connectors/src/canvas-http";
import { type CaptureBatch } from "@magic/contracts";
import { createStore } from "@magic/storage";

const origin = "https://canvas.synthetic.test";
const now = () => new Date("2026-09-26T20:00:00Z");
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", ...headers },
});
const current = {
  id: 101, name: "Synthetic Current Course", course_code: "HISTORY 201", workflow_state: "available", concluded: false,
  term: { id: 1, name: "Fall 2026" }, enrollments: [{ type: "student", enrollment_state: "active", user_id: 99 }], syllabus_body: "",
};
const past = {
  ...current, id: 201, name: "Synthetic Past Course", course_code: "HISTORY 101", concluded: true,
  term: { id: 2, name: "Spring 2025" }, enrollments: [{ type: "student", enrollment_state: "active", user_id: 99 }],
};
function transport(active: unknown[], completed: unknown[] | ((url: URL) => Promise<Response> | Response), activeFailure = false) {
  const calls: URL[] = [];
  const fetch: CanvasConnectorOptions["fetch"] = async (input) => {
    const url = new URL(input); calls.push(url);
    if (url.pathname === "/api/v1/users/self/profile") return json({ id: 99, name: "private-profile-discard" });
    if (url.pathname === "/api/v1/courses") {
      if (url.searchParams.get("enrollment_state") === "completed") return typeof completed === "function" ? completed(url) : json(completed);
      return activeFailure ? json({ error: "private-error-discard" }, 403) : json(active);
    }
    if (url.pathname === "/api/v1/courses/101") return json(current);
    return json([]);
  };
  return { calls, fetch };
}
async function pull(fetch: CanvasConnectorOptions["fetch"], options: Partial<CanvasConnectorOptions> = {}) {
  const batches: CaptureBatch[] = [];
  for await (const batch of canvasConnector({ origin, fetch, now, sleep: async () => {}, random: () => 0, ...options }).pull()) batches.push(batch);
  return batches;
}
const courses = (batches: CaptureBatch[]) => [...new Map(batches.filter((batch) => batch.source.scope === "course")
  .map((batch) => [batch.source.courseId, batch])).values()];

test("active and completed discovery merge by ID and preserve restricted historical metadata without crawling it", async () => {
  const mock = transport([current], [past, { id: 202, access_restricted_by_date: true },
    { ...past, id: 101, name: "Historical duplicate must not replace active" }]);
  const progress: { scope: string; records: number }[] = [];
  const batches = await pull(mock.fetch, { onProgress: (event) => progress.push(event) });
  const catalog = courses(batches); assert.equal(catalog.length, 3);
  assert.equal(catalog.find((batch) => batch.source.courseId === "101")?.resources[0]?.title, current.name);
  const historical = catalog.find((batch) => batch.source.courseId === "201")!;
  assert.equal(historical.resources[0]?.course?.accessState, "concluded");
  assert.equal(historical.resources[0]?.course?.selection?.included, false);
  assert.ok(historical.diagnostics?.some((diagnostic) => diagnostic.code === "historical_course_metadata_only"));
  const restricted = catalog.find((batch) => batch.source.courseId === "202")!;
  assert.equal(restricted.status, "inaccessible"); assert.equal(restricted.complete, false);
  assert.equal(restricted.resources[0]?.course?.accessRestricted, true);
  assert.equal(restricted.resources[0]?.course?.accessState, "date_restricted");
  assert.equal(restricted.resources[0]?.course?.selection?.included, false);
  assert.ok(mock.calls.some((url) => url.pathname === "/api/v1/courses/101/assignments"));
  assert.ok(!mock.calls.some((url) => /^\/api\/v1\/courses\/20[12](?:\/|$)/.test(url.pathname)));
  const reads = mock.calls.filter((url) => url.pathname === "/api/v1/courses");
  assert.deepEqual(reads.map((url) => url.searchParams.get("enrollment_state")), ["active", "completed"]);
  assert.ok(!reads[1].searchParams.getAll("include[]").includes("syllabus_body"));
  assert.equal(batches.find((batch) => batch.source.scope === "courses-completed")?.stats?.records, 3);
  assert.ok(progress.some((event) => event.scope === "courses-completed" && event.records === 3));
  assert.equal(batches.filter((batch) => batch.source.scope === "connection").at(-1)?.complete, true);
});

test("a slow historical query does not block current-course assignments", async () => {
  let release: (() => void) | undefined;
  const historyReady = new Promise<void>((resolve) => { release = resolve; });
  const mock = transport([current], async () => { await historyReady; return json([past]); });
  let startedAssignments = false;
  const fetch: CanvasConnectorOptions["fetch"] = async (input, init) => {
    if (new URL(input).pathname === "/api/v1/courses/101/assignments") { startedAssignments = true; release!(); }
    return mock.fetch(input, init);
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => { release!(); controller.abort(); }, 1500);
  try {
    const batches: CaptureBatch[] = [];
    for await (const batch of canvasConnector({ origin, fetch, now, sleep: async () => {}, random: () => 0 }).pull(controller.signal)) batches.push(batch);
    assert.equal(startedAssignments, true); assert.equal(courses(batches).length, 2);
  } finally { clearTimeout(timeout); release!(); }
});

test("completed enrollment discovery explicitly includes available and completed course states", async () => {
  const concludedWorkflow = { ...past, id: 203, workflow_state: "completed" };
  // Canvas defaults students to available courses even when enrollment_state
  // is completed. Model that default so a missing state filter loses this row.
  const mock = transport([], (url) => {
    const states = url.searchParams.getAll("state[]");
    return json([
      ...(states.length === 0 || states.includes("available") ? [past] : []),
      ...(states.includes("completed") ? [concludedWorkflow] : []),
    ]);
  });
  const batches = await pull(mock.fetch);
  const read = mock.calls.find((url) => url.searchParams.get("enrollment_state") === "completed")!;
  assert.deepEqual(read.searchParams.getAll("state[]"), ["available", "completed"]);
  assert.deepEqual(courses(batches).map((batch) => batch.source.courseId).sort(), ["201", "203"]);
  assert.equal(courses(batches).find((batch) => batch.source.courseId === "203")?.resources[0]?.course?.accessState, "concluded");
  assert.equal(batches.find((batch) => batch.source.scope === "courses-completed")?.stats?.records, 2);
});

test("course-state filters are restricted to the course list and retained across pagination", () => {
  const initial = `${origin}/api/v1/courses?enrollment_state=completed&state[]=available&state[]=completed&per_page=100`;
  assert.deepEqual(new URL(checkedCanvasUrl(initial, origin)).searchParams.getAll("state[]"), ["available", "completed"]);
  const next = canvasNextPage(`<${origin}/api/v1/courses?page=2>; rel="next"`, initial, initial, origin)!;
  assert.deepEqual(new URL(next).searchParams.getAll("state[]"), ["available", "completed"]);
  assert.equal(new URL(next).searchParams.get("enrollment_state"), "completed");
  for (const url of [
    `${origin}/api/v1/courses?state[]=deleted`,
    `${origin}/api/v1/courses?state[]=unpublished`,
    `${origin}/api/v1/courses/101?state[]=completed`,
    `${origin}/api/v1/courses/101/assignments?state[]=completed`,
  ]) assert.throws(() => checkedCanvasUrl(url, origin));
  assert.throws(() => canvasNextPage(`<${origin}/api/v1/courses?page=2&state[]=available>; rel="next"`, initial, initial, origin));
});

test("historical pagination remains partial until enumeration finishes and reports validated counts", async () => {
  const mock = transport([], (url) => url.searchParams.get("page") === "2" ? json([{ ...past, id: 202 }]) : json([past], 200, {
    link: `<${origin}/api/v1/courses?enrollment_state=completed&page=2&per_page=100>; rel="next"`,
  }));
  const batches = await pull(mock.fetch);
  const reads = batches.filter((batch) => batch.source.scope === "courses-completed");
  assert.equal(reads.length, 2); assert.equal(reads[0].complete, false); assert.equal(reads[1].complete, true);
  assert.equal(reads[1].stats?.records, 2); assert.equal(courses(batches).length, 2);
  for (const url of mock.calls.filter((url) => url.searchParams.get("enrollment_state") === "completed"))
    assert.deepEqual(url.searchParams.getAll("state[]"), ["available", "completed"]);
});

test("failed historical or active catalogs preserve known course selection and cannot establish absence", async () => {
  const store = createStore(":memory:");
  try {
    const initial = transport([current], [past]);
    for (const batch of await pull(initial.fetch)) store.ingest(batch);
    const known = store.resources();
    for (const mock of [transport([], () => json({ error: "private-error-discard" }, 403)), transport([], [], true)]) {
      const batches = await pull(mock.fetch, { knownResources: known, now: () => new Date("2026-09-27T20:00:00Z") });
      assert.ok(!batches.some((batch) => batch.diagnostics?.some((row) => row.code === "absent_from_active_course_catalog")));
      assert.equal(batches.filter((batch) => batch.source.scope === "connection").at(-1)?.complete, false);
      for (const batch of batches) store.ingest(batch);
      assert.equal(store.resources().filter((resource) => resource.kind === "course" && !resource.deleted).length, 2);
      assert.equal(store.resources().find((resource) => resource.kind === "course" && resource.courseId === "101")?.course?.selection?.included, true);
      assert.ok(!JSON.stringify(batches).includes("private-error-discard"));
    }
  } finally { store.close(); }
});

test("complete active and completed absence keeps coursework but removes automatic inclusion", async () => {
  const store = createStore(":memory:");
  try {
    const initial = transport([current], [past]);
    for (const batch of await pull(initial.fetch)) store.ingest(batch);
    const mock = transport([], []);
    const batches = await pull(mock.fetch, { knownResources: store.resources(), now: () => new Date("2026-09-27T20:00:00Z") });
    const known = courses(batches);
    assert.equal(known.length, 2); assert.ok(known.every((batch) => batch.resources[0]?.course?.selection?.included === false));
    assert.ok(known.every((batch) => batch.complete === false));
    for (const batch of batches) store.ingest(batch);
    assert.equal(store.resources().filter((resource) => resource.kind === "course" && !resource.deleted).length, 2);
  } finally { store.close(); }
});

test("only own student grade claims survive, with every enrollment and current/final distinction intact", () => {
  const parsed = courseSchema.parse({ ...past, enrollments: [
    { type: "student", user_id: 99, enrollment_state: "completed", computed_current_grade: "B", computed_final_grade: "AB",
      computed_current_score: 80.5, computed_final_score: 87.2, computed_current_letter_grade: "IGNORE", role: "StudentEnrollment", role_id: 77 },
    { type: "StudentEnrollment", user_id: 99, enrollment_state: "completed", computed_current_grade: null, computed_final_grade: null,
      computed_current_score: null, computed_final_score: 102.3 },
    { type: "student", user_id: 500, computed_final_grade: "OTHER_STUDENT" },
    { type: "teacher", user_id: 99, computed_final_grade: "TEACHER" },
  ] });
  const resource = courseResource(parsed, origin, {}, "99");
  assert.deepEqual(resource.course?.gradeEvidence, [
    { enrollmentState: "completed", currentGrade: "B", finalGrade: "AB", currentScore: 80.5, finalScore: 87.2 },
    { enrollmentState: "completed", currentGrade: null, finalGrade: null, currentScore: null, finalScore: 102.3 },
  ]);
  const stored = JSON.stringify(resource);
  for (const value of ["OTHER_STUDENT", "TEACHER", "IGNORE", "user_id", "role_id", "computed_", "StudentEnrollment"]) assert.ok(!stored.includes(value));
  assert.equal(courseResource(parsed, origin, {}).course?.gradeEvidence, undefined);
  assert.equal(courseSchema.safeParse({ ...past, enrollments: [{ type: "student", computed_final_score: Infinity }] }).success, false);
});

test("detail metadata that omits grades retains this refresh's explicit catalog claims", async () => {
  const withGrades = { ...current, enrollments: [{ ...current.enrollments[0], computed_current_grade: null, computed_final_grade: "A",
    computed_current_score: 95, computed_final_score: 90 }] };
  const mock = transport([withGrades], []);
  const batches = await pull(mock.fetch);
  const resource = courses(batches).find((batch) => batch.source.courseId === "101")?.resources[0];
  assert.deepEqual(resource?.course?.gradeEvidence, [{ enrollmentState: "active", currentGrade: null, finalGrade: "A", currentScore: 95, finalScore: 90 }]);
  assert.ok(mock.calls.find((url) => url.pathname === "/api/v1/courses/101")?.searchParams.getAll("include[]").includes("total_scores"));
});

test("historical-only selection cannot admit old assignments by default or reinterpret restriction as conclusion", () => {
  const selection = courseSelection({ ...past, concluded: false, historicalOnly: true }, {
    accountScope: "synthetic", courseOverrides: [{ accountScope: "synthetic", courseId: "201", included: true }],
  });
  assert.equal(selection.included, false); assert.equal(selection.override, true);
  assert.ok(selection.reasons.some((reason) => reason.includes("metadata only")));
  const restricted = courseResource({ id: "202", historicalOnly: true, access_restricted_by_date: true }, origin, {});
  assert.equal(restricted.course?.accessState, "date_restricted");
  assert.equal(restricted.course?.selection?.included, false);
});

test("cancellation of pending historical discovery emits no stale completed-course records", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const mock = transport([current], async () => { await gate; return json([past]); });
  const controller = new AbortController();
  const batches: CaptureBatch[] = [];
  const puller = (async () => {
    for await (const batch of canvasConnector({ origin, fetch: mock.fetch, now, sleep: async () => {}, random: () => 0 }).pull(controller.signal)) {
      batches.push(batch);
      if (batch.source.scope === "assignments") controller.abort();
    }
  })();
  try { await assert.rejects(puller); }
  finally { release(); }
  assert.ok(!batches.some((batch) => batch.source.courseId === "201"));
});
