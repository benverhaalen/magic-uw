import assert from "node:assert/strict";
import test from "node:test";
import {
  buildUwPlanningRequest,
  UwPlanningHttp,
  UwPlanningInputError,
  type UwPlanningFetch,
  type UwPlanningMetric,
  type UwPlanningReadRequest,
} from "../packages/connectors/src/uw-planning-http";

const json = (data: unknown = {}, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
const request: UwPlanningReadRequest = { kind: "student-info" };
const search: UwPlanningReadRequest = {
  kind: "public-search", term: "1272", query: "COMP SCI", page: 1, pageSize: 25,
  sort: "SCORE", filters: { subjectCode: "266", enrollmentStatus: ["OPEN", "WAITLISTED"] },
};
function fixture(reply: UwPlanningFetch = async () => json()) {
  let now = 1_000_000;
  const calls: Array<{ url: string; init: RequestInit; at: number }> = [];
  const sleeps: number[] = [];
  const metrics: UwPlanningMetric[] = [];
  const client = new UwPlanningHttp({
    fetch: async (url, init) => { calls.push({ url, init, at: now }); return reply(url, init); },
    now: () => now,
    sleep: async (ms, signal) => { signal?.throwIfAborted(); sleeps.push(ms); now += ms; },
    onMetric: (metric) => metrics.push(metric),
  });
  return { client, calls, sleeps, metrics, advance: (ms: number) => { now += ms; } };
}

test("the read boundary reconstructs only known fixed UW paths", () => {
  const cases: Array<[UwPlanningReadRequest, string]> = [
    [{ kind: "public-terms" }, "https://public.enroll.wisc.edu/api/search/v1/aggregate"],
    [{ kind: "subjects-map" }, "https://enroll.wisc.edu/api/search/v1/subjectsMap/0000"],
    [{ kind: "enrollment-packages", term: "1272", subject: "266", courseId: "004289" }, "https://public.enroll.wisc.edu/api/search/v1/enrollmentPackages/1272/266/004289"],
    [request, "https://enroll.wisc.edu/api/enroll/v1/studentInfo"],
    [{ kind: "current-enrollment", term: "1272" }, "https://enroll.wisc.edu/api/enroll/v1/current/1272"],
    [{ kind: "degree-plans" }, "https://enroll.wisc.edu/api/planner/v1/degreePlan"],
    [{ kind: "degree-plan-detail", planId: "12345" }, "https://enroll.wisc.edu/api/planner/v1/degreePlan/12345/termcourses"],
    [{ kind: "roadmap", term: "1272" }, "https://enroll.wisc.edu/api/planner/v1/roadmap/1272"],
    [{ kind: "degree-programs" }, "https://enroll.wisc.edu/api/dars/student-degree-programs"],
    [{ kind: "audit-metadata" }, "https://enroll.wisc.edu/api/dars/audit-metadata"],
    [{ kind: "audit-report", reportId: "synthetic-report_7" }, "https://enroll.wisc.edu/api/dars/reports/synthetic-report_7"],
    [{ kind: "myuw-session" }, "https://my.wisc.edu/portal/web/session.json"],
    [{ kind: "enrollment-appointments" }, "https://my.wisc.edu/aries/proxy/enrollmentlookup"],
    [{ kind: "canvas-profile" }, "https://canvas.wisc.edu/api/v1/users/self/profile"],
  ];
  for (const [operation, url] of cases) {
    const descriptor = buildUwPlanningRequest(operation);
    assert.equal(descriptor.url, url);
    assert.equal(descriptor.method, "GET");
    assert.equal(descriptor.body, undefined);
    assert.equal(descriptor.schemaVerified, false);
    assert.equal(Object.isFrozen(descriptor), true);
  }
  assert.throws(() => buildUwPlanningRequest({ kind: "degree-plan-detail", planId: "synthetic" }),
    (error) => error instanceof UwPlanningInputError && error.status === "invalid_schema");
});

test("traversal, encoded paths, cross-host URLs, query injection and every write shape fail before fetch", async () => {
  const { client, calls } = fixture();
  const bad: unknown[] = [
    "https://enroll.wisc.edu/api/enroll/v1/studentInfo",
    { kind: "student-info", url: "https://attacker.example/" },
    { kind: "student-info", method: "POST" },
    { kind: "student-info", headers: { Authorization: "secret" } },
    { kind: "student-info", body: "{}" },
    { kind: "student-info", query: "action=enroll" },
    { kind: "current-enrollment", term: "1272?write=true" },
    { kind: "roadmap", term: "1272/../cart" },
    { kind: "enrollment-packages", term: "1272", subject: "266", courseId: "004289%2f.." },
    ...["..", "../studentInfo", "%2e%2e", "%252e%252e", "safe%2fwrite", "safe%5cwrite", "safe/write", "safe\\write", "id?q=x", "id#x", "https://attacker.example", "//attacker.example", "id\n", "id\u0000", "x".repeat(129)].map((reportId) => ({ kind: "audit-report", reportId })),
    ...["enroll", "drop", "swap", "waitlist", "cart-write", "audit-create", "what-if-audit"].map((kind) => ({ kind })),
  ];
  for (const operation of bad) {
    const result = await client.read(operation as UwPlanningReadRequest);
    assert.equal(result.status, "invalid_schema", JSON.stringify(operation));
  }
  assert.equal(calls.length, 0);
});

test("public search has a single POST target, bounded structured filters, and an explicitly unverified schema", async () => {
  const { client, calls } = fixture();
  const result = await client.read(search);
  assert.equal(result.status, "ok");
  assert.equal(result.schemaVerified, false);
  assert.equal(calls[0]!.url, "https://public.enroll.wisc.edu/api/search/v1");
  assert.equal(calls[0]!.init.method, "POST");
  const body = JSON.parse(calls[0]!.init.body as string);
  assert.deepEqual(body, {
    selectedTerm: "1272", queryString: "COMP SCI", page: 1, pageSize: 25, sortOrder: "SCORE",
    filters: [{ term: { "subject.subjectCode": "266" } }, { has_child: { type: "enrollmentPackage", query: { match: { "packageEnrollmentStatus.status": "OPEN WAITLISTED" } } } }],
  });
  for (const changes of [
    { term: "1273" }, { query: "x".repeat(501) }, { query: "x\nscript" }, { page: 0 },
    { page: 1.5 }, { pageSize: 101 }, { sort: "script" },
    { filters: { script: "anything" } },
    { filters: { subjectCode: "266", enrollmentStatus: ["OPEN"], subjects: ["266"] } },
    { filters: { subjectCode: "266", enrollmentStatus: ["OPEN"], published: true } },
  ]) {
    const invalid = await client.read({ ...search, ...changes } as UwPlanningReadRequest);
    assert.equal(invalid.status, "invalid_schema");
  }
  assert.equal(calls.length, 1);
});

test("headers stay on the fixed host and telemetry contains only status, host, bytes and timing", async () => {
  const sensitive = { studentName: "SYNTHETIC_PRIVATE_NAME", reportId: "SYNTHETIC_PRIVATE_ID" };
  const { client, calls, metrics } = fixture(async () => json(sensitive));
  const result = await client.read({ kind: "audit-report", reportId: sensitive.reportId });
  assert.equal(result.status, "ok");
  if (result.status === "ok") assert.deepEqual(result.data, sensitive);
  const headers = new Headers(calls[0]!.init.headers);
  assert.equal(headers.get("accept"), "application/json");
  assert.equal(headers.get("referer"), "https://enroll.wisc.edu/");
  assert.equal(headers.get("origin"), "https://enroll.wisc.edu");
  assert.equal(headers.get("x-requested-with"), "XMLHttpRequest");
  assert.equal(headers.has("cookie"), false);
  assert.equal(headers.has("authorization"), false);
  assert.equal(calls[0]!.init.credentials, "include");
  assert.equal(calls[0]!.init.redirect, "manual");
  assert.deepEqual(Object.keys(metrics[0]!).sort(), ["bytes", "elapsedMs", "host", "status"]);
  assert.equal(metrics[0]!.bytes, Buffer.byteLength(JSON.stringify(sensitive)));
  assert.equal(JSON.stringify(metrics).includes("SYNTHETIC_PRIVATE"), false);
  assert.equal(JSON.stringify(metrics).includes("reports"), false);
});

test("JSON and one whole comment wrapper parse without evaluating anything", async () => {
  for (const body of ['{"synthetic":true}', '  /* {"synthetic":true} */  ']) {
    const { client } = fixture(async () => new Response(body, { headers: { "content-type": "text/plain" } }));
    const result = await client.read(request);
    assert.equal(result.status, "ok");
    if (result.status === "ok") assert.deepEqual(result.data, { synthetic: true });
  }
  for (const body of ["", "/*{}*/ extra", "/*{}*/ /*{}*/", "callback({})", "{} trailing", "/* never closes", "<!doctype html><title>Login</title>"] ) {
    const { client } = fixture(async () => new Response(body));
    assert.equal((await client.read(request)).status, "invalid_schema");
  }
  const { client } = fixture(async () => new Response("{}", { headers: { "content-type": "text/html" } }));
  assert.equal((await client.read(request)).status, "invalid_schema");
});

test("403 is forbidden, never reauthentication, and each source probe remains independent", async () => {
  const { client, calls } = fixture(async (url) => url.includes("enroll.wisc.edu")
    ? new Response("", { status: 403, headers: { "content-type": "text/html" } }) : json({}));
  assert.equal((await client.probe("enroll")).status, "forbidden");
  assert.equal((await client.probe("myuw")).status, "ok");
  assert.equal((await client.probe("canvas")).status, "ok");
  assert.equal((await client.probe("enroll")).status, "forbidden");
  assert.equal(calls.length, 4);
  const unauthorized = fixture(async () => json({}, 401));
  assert.equal((await unauthorized.client.read(request)).status, "needs_sign_in");
});

test("login redirects and unexpected response URLs are rejected without following them", async () => {
  const login = fixture(async () => new Response(null, { status: 302, headers: { location: "https://login.wisc.edu/idp/profile/SAML2/Redirect/SSO" } }));
  assert.equal((await login.client.read(request)).status, "needs_sign_in");
  assert.equal(login.calls.length, 1);
  const other = fixture(async () => new Response(null, { status: 302, headers: { location: "https://attacker.example/read" } }));
  assert.equal((await other.client.read(request)).status, "invalid_schema");
  const followed = fixture(async () => {
    const response = json({});
    Object.defineProperties(response, { redirected: { value: true }, url: { value: "https://my.wisc.edu/login" } });
    return response;
  });
  assert.equal((await followed.client.read(request)).status, "needs_sign_in");
  for (const url of ["https://attacker.example/api/enroll/v1/studentInfo", "https://enroll.wisc.edu/api/enroll/v1/studentInfo?secret=x"]) {
    const wrong = fixture(async () => { const response = json({}); Object.defineProperty(response, "url", { value: url }); return response; });
    assert.equal((await wrong.client.read(request)).status, "invalid_schema");
  }
});

test("unsupported scopes are negatively cached briefly without hiding another scope", async () => {
  for (const status of [404, 405, 501]) {
    const { client, calls, advance } = fixture(async () => json({}, status));
    assert.equal((await client.read(request)).status, "unsupported");
    const cached = await client.read(request);
    assert.equal(cached.status, "unsupported");
    assert.equal(cached.cached, true);
    assert.equal(calls.length, 1);
    await client.read({ kind: "degree-plans" });
    assert.equal(calls.length, 2);
    advance(30_001);
    await client.read(request);
    assert.equal(calls.length, 3);
  }
});

test("429 suppresses the host for Retry-After without blocking, retries or affecting other hosts", async () => {
  let count = 0;
  const { client, calls, sleeps, advance } = fixture(async (url) => {
    if (url.includes("enroll.wisc.edu") && count++ === 0) return json({}, 429, { "retry-after": "120" });
    return json({});
  });
  const limited = await client.read(request);
  assert.equal(limited.status, "rate_limited");
  assert.equal(limited.retryAfterMs, 120_000);
  const suppressed = await client.read({ kind: "degree-plans" });
  assert.equal(suppressed.status, "rate_limited");
  assert.equal(calls.length, 1);
  assert.equal(sleeps.some((ms) => ms >= 60_000), false);
  assert.equal((await client.probe("myuw")).status, "ok");
  advance(119_999);
  assert.equal((await client.read(request)).status, "rate_limited");
  advance(1);
  assert.equal((await client.read(request)).status, "ok");
  assert.equal(calls.length, 3);
});

test("Retry-After dates, missing headers and very long cooldowns never cause early retries", async () => {
  for (const [header, expected] of [[new Date(1_090_000).toUTCString(), 90_000], ["not-a-date", 60_000], ["999999999", 999999999000]] as const) {
    const { client, calls } = fixture(async () => json({}, 429, { "retry-after": header }));
    const result = await client.read(request);
    assert.equal(result.status, "rate_limited");
    assert.equal(result.retryAfterMs, expected);
    await client.read(request);
    assert.equal(calls.length, 1);
  }
});

test("requests serialize with gentle default spacing per host", async () => {
  const { client, calls } = fixture();
  const results = await Promise.all([client.read(request), client.read({ kind: "degree-plans" }), client.read({ kind: "audit-metadata" })]);
  assert.ok(results.every((result) => result.status === "ok"));
  assert.deepEqual(calls.map((call) => call.at), [1_000_000, 1_002_000, 1_004_000]);
});

test("response byte limits apply to declared and streamed bytes", async () => {
  const declared = fixture(async () => json({}, 200, { "content-length": String(8 * 1024 * 1024 + 1) }));
  const declaredResult = await declared.client.read(request);
  assert.equal(declaredResult.status, "invalid_schema");
  assert.equal(declaredResult.code, "response_byte_limit");
  const streamed = fixture(async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(8 * 1024 * 1024));
    controller.enqueue(new Uint8Array(1));
    controller.close();
  } })));
  const streamedResult = await streamed.client.read(request);
  assert.equal(streamedResult.status, "invalid_schema");
  assert.equal(streamedResult.code, "response_byte_limit");
});

test("cancellation works before fetch, while queued, during fetch and during body reads", async () => {
  const pre = new AbortController(); pre.abort();
  const before = fixture();
  assert.equal((await before.client.read(request, pre.signal)).status, "cancelled");
  assert.equal(before.calls.length, 0);

  let release!: (response: Response) => void;
  let started!: () => void;
  const start = new Promise<void>((resolve) => { started = resolve; });
  let callCount = 0;
  const client = new UwPlanningHttp({ minSpacingMs: 0, fetch: async () => {
    callCount++;
    if (callCount === 1) { started(); return new Promise<Response>((resolve) => { release = resolve; }); }
    return json({});
  } });
  const first = client.read(request);
  await start;
  const queuedController = new AbortController();
  const queued = client.read({ kind: "degree-plans" }, queuedController.signal);
  queuedController.abort();
  assert.equal((await queued).status, "cancelled");
  assert.equal(callCount, 1);
  release(json({}));
  assert.equal((await first).status, "ok");
  assert.equal((await client.read(request)).status, "ok");
  assert.equal(callCount, 2);

  const activeController = new AbortController();
  const active = new UwPlanningHttp({ fetch: async (_url, init) => {
    assert.ok(init.signal);
    activeController.abort();
    return new Promise<Response>(() => {});
  } });
  assert.equal((await active.read(request, activeController.signal)).status, "cancelled");

  const bodyController = new AbortController();
  const reading = new UwPlanningHttp({ fetch: async () => new Response(new ReadableStream({ pull() { bodyController.abort(); } })) });
  assert.equal((await reading.read(request, bodyController.signal)).status, "cancelled");
});

test("timeouts and thrown network errors are bounded and never disclose raw errors", async () => {
  const hung = new UwPlanningHttp({ requestTimeoutMs: 5, fetch: async () => new Promise<Response>(() => {}) });
  const timed = await hung.read(request);
  assert.equal(timed.status, "error");
  assert.equal(timed.code, "request_timeout");
  const broken = fixture(async () => { throw new Error("SYNTHETIC_SECRET_URL_AND_TOKEN"); });
  const result = await broken.client.read(request);
  assert.equal(result.status, "error");
  assert.equal(JSON.stringify(result).includes("SYNTHETIC_SECRET"), false);
  assert.equal(JSON.stringify(broken.metrics).includes("SYNTHETIC_SECRET"), false);
});

test("invalid UTF-8 is a schema failure, and telemetry callbacks cannot change read outcomes", async () => {
  const invalid = fixture(async () => new Response(new Uint8Array([0x22, 0xff, 0x22])));
  const result = await invalid.client.read(request);
  assert.equal(result.status, "invalid_schema");
  assert.equal(result.code, "invalid_encoding");
  const client = new UwPlanningHttp({ fetch: async () => json({}), onMetric: () => { throw new Error("telemetry failed"); } });
  assert.equal((await client.read(request)).status, "ok");
});
