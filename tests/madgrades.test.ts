import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import {
  captureBatchSchema, defaultPrivacy,
  type PlanningAudit, type PlanningCapture, type PlanningCatalogCourse, type PlanningCourseHistory, type PlanningCrosslist,
  type PlanningEnrollmentPackage, type PlanningProvenance, type PlanningRecord, type PlanningScope, type PlanningSubject, type Store,
} from "@magic/contracts";
import fixture from "../fixtures/course.json";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import { buildCourseIdentityTable } from "../packages/domain/src/planning";
import {
  MadgradesHttp, madgradesUrl, normalizeMadgradesGrades, parseMadgradesCourse, parseMadgradesGrades, pullMadgradesGrades,
  resolveMadgradesCourse, type MadgradesCourse, type MadgradesRequest, type MadgradesReadResult, type MadgradesTransport,
} from "../packages/connectors/src/madgrades";
import { summarizePlanningGrades } from "../packages/core/src/planning-grades";
import { comparePlanning } from "../packages/core/src/planning";
import { createMcpService } from "../packages/core/src/mcp";

// Synthetic fixtures shaped after the Madgrades server source (camelCase jbuilder views). No live response was used.
const observedAt = "2026-09-26T12:00:00Z", now = "2026-09-26T14:00:00Z";
const TOKEN = "0123456789abcdef0123456789abcdef";
const INSTRUCTOR_MARKER = "ZZ SYNTHETIC INSTRUCTOR MARKER";
const provenance = (kind: PlanningScope["kind"], key: string): PlanningProvenance => ({ sourceUrl: "https://guide.wisc.edu/courses/", observedAt, scope: { kind, key } });
const subject = (code: string, shortName: string): PlanningSubject => ({ id: `subject-${code}`, kind: "subject", provenance: provenance("subjects", "all"), code, shortName, formalName: shortName, aliases: [] });
const subjects = [subject("266", "COMP SCI"), subject("329", "E C E"), subject("600", "MATH")];
const crosslist = (keys: string[]): PlanningCrosslist => ({ id: `x-${keys.join("-")}`, kind: "crosslist", provenance: provenance("subjects", "all"), canonicalKey: [...keys].sort()[0]!, courseKeys: keys });
const table = (lists: PlanningCrosslist[] = []) => buildCourseIdentityTable(subjects, lists);
const U1 = "a3e3e1c3-543d-3bb5-ae65-5f2aec4ad1de", U2 = "b3e3e1c3-543d-3bb5-ae65-5f2aec4ad1de";
const mgCourse = (uuid: string, number: number, codes: string[], name = "Synthetic Course"): MadgradesCourse & { url: string } =>
  ({ uuid, number, name, subjects: codes.map((code) => ({ code, name: `Subject ${code}`, abbreviation: code })), url: `https://api.madgrades.com/v1/courses/${uuid}` });
const zero = { aCount: 0, abCount: 0, bCount: 0, bcCount: 0, cCount: 0, dCount: 0, fCount: 0, sCount: 0, uCount: 0, crCount: 0, nCount: 0, pCount: 0, iCount: 0, nwCount: 0, nrCount: 0, otherCount: 0 };
type Counts = Partial<typeof zero>;
const dist = (counts: Counts) => { const row = { ...zero, ...counts }; return { total: Object.values(row).reduce((a, b) => a + b, 0), ...row }; };
const add = (...rows: ReturnType<typeof dist>[]) => dist(Object.fromEntries(Object.keys(zero).map((key) => [key, rows.reduce((sum, row) => sum + row[key as keyof typeof zero], 0)])));
const section = (sectionNumber: number, instructors: { id: number; name: string }[], counts: Counts) => ({ sectionNumber, instructors, ...dist(counts) });
function gradesBody(uuid: string, offerings: { termCode: number; sections: ReturnType<typeof section>[] }[]) {
  const rows = offerings.map((offering) => ({ termCode: offering.termCode, cumulative: add(...offering.sections.map(({ sectionNumber, instructors, ...counts }) => counts)), sections: offering.sections }));
  return { courseUuid: uuid, cumulative: add(...rows.map((row) => row.cumulative)), courseOfferings: rows };
}
const offerings = (uuid: string, terms: number[]) => terms.map((termCode, index) => ({ uuid: `c${index.toString(16).padStart(7, "0")}-0000-4000-8000-000000000000`, courseUuid: uuid, termCode, name: "Synthetic Course", url: "https://api.madgrades.com/v1/course_offerings/x" }));
const standardGrades = gradesBody(U1, [
  { termCode: 1264, sections: [
    section(1, [{ id: 11, name: "Instructor One" }], { aCount: 10, bCount: 10, sCount: 2 }),
    section(2, [{ id: 22, name: "Instructor Two" }], { cCount: 4, fCount: 1, nwCount: 3 }),
    section(3, [{ id: 11, name: "Instructor One" }, { id: 22, name: "Instructor Two" }], { abCount: 6 }),
  ] },
  { termCode: 1262, sections: [section(1, [{ id: 11, name: "Instructor One" }], { aCount: 5, dCount: 5 })] },
]);

/** Transport double: records requests, answers from a route map, never sees the token (like the desktop worker). */
function transport(routes: Record<string, unknown | MadgradesReadResult>) {
  const requests: MadgradesRequest[] = [];
  const read: MadgradesTransport["read"] = async (request) => {
    requests.push(request);
    const url = madgradesUrl(request);
    const value = routes[url];
    if (value === undefined) return { status: "not_found", code: "not_found" };
    return value && typeof value === "object" && "status" in value && !("courseUuid" in value) ? value as MadgradesReadResult : { status: "ok", data: value };
  };
  return { read, requests };
}
const search = (code: string, number: number, results: unknown[]) => ({ [`https://api.madgrades.com/v1/courses?subject=${code}&number=${number}&per_page=25&page=1`]: { currentPage: 1, totalPages: 1, totalCount: results.length, nextPageUrl: null, results } });
const detail = (course: ReturnType<typeof mgCourse>, terms: number[]) => ({ [`https://api.madgrades.com/v1/courses/${course.uuid}`]: { ...course, gradesUrl: `${course.url}/grades`, courseOfferings: offerings(course.uuid, terms) } });
const grades = (uuid: string, body: unknown) => ({ [`https://api.madgrades.com/v1/courses/${uuid}/grades`]: body });
function standardRoutes() {
  const course = mgCourse(U1, 400, ["266"]);
  return { ...search("266", 400, [course]), ...detail(course, [1264, 1262]), ...grades(U1, standardGrades) };
}

test("requests are fixed Madgrades URLs; identifiers are validated before any read", () => {
  assert.equal(madgradesUrl({ kind: "course-search", subjectCode: "266", number: "400" }), "https://api.madgrades.com/v1/courses?subject=266&number=400&per_page=25&page=1");
  assert.equal(madgradesUrl({ kind: "course-grades", uuid: U1 }), `https://api.madgrades.com/v1/courses/${U1}/grades`);
  assert.throws(() => madgradesUrl({ kind: "course", uuid: "../instructors/1" } as MadgradesRequest));
  assert.throws(() => madgradesUrl({ kind: "course-search", subjectCode: "COMP SCI", number: "400" } as MadgradesRequest));
});

test("HTTP transport sends the documented token header, never follows redirects, and paces requests", async () => {
  const seen: { url: string; init: RequestInit }[] = [], sleeps: number[] = [];
  let clock = 1000;
  const http = new MadgradesHttp({
    fetch: async (url, init) => { seen.push({ url, init }); return new Response(JSON.stringify({ ok: 1 }), { status: 200, headers: { "content-type": "application/json" } }); },
    token: async () => TOKEN, now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; },
  });
  const first = await http.read({ kind: "course", uuid: U1 });
  const second = await http.read({ kind: "course-grades", uuid: U1 });
  assert.deepEqual([first.status, second.status], ["ok", "ok"]);
  assert.equal((seen[0]!.init.headers as Record<string, string>).Authorization, `Token token=${TOKEN}`);
  assert.equal(seen[0]!.init.redirect, "manual");
  assert.equal(seen[0]!.init.credentials, "omit");
  assert.ok(seen.every((row) => !row.url.includes(TOKEN)));
  assert.equal(sleeps.at(-1), 1000, "second read waits for the pacing interval");
  assert.ok(!JSON.stringify([first, second]).includes(TOKEN));
});

test("missing, malformed, or rejected tokens make no data request and never echo the token", async () => {
  let fetches = 0;
  const make = (token: string | undefined, status = 200) => new MadgradesHttp({ fetch: async () => { fetches++; return new Response("{}", { status }); }, token: async () => token, sleep: async () => {} });
  assert.deepEqual(await make(undefined).read({ kind: "course", uuid: U1 }), { status: "missing_token", code: "token_missing" });
  assert.deepEqual(await make("short").read({ kind: "course", uuid: U1 }), { status: "missing_token", code: "token_format" });
  assert.equal(fetches, 0);
  const rejected = await make(TOKEN, 401).read({ kind: "course", uuid: U1 });
  assert.equal(rejected.status, "unauthorized");
  const redirected = await make(TOKEN, 302).read({ kind: "course", uuid: U1 });
  assert.equal(redirected.status, "invalid_response");
  assert.ok(!JSON.stringify([rejected, redirected]).includes(TOKEN));
});

test("429 suppresses further reads until Retry-After; cancellation stops before fetch", async () => {
  let clock = 0, fetches = 0;
  const http = new MadgradesHttp({ fetch: async () => { fetches++; return new Response("", { status: 429, headers: { "retry-after": "30" } }); }, token: async () => TOKEN, now: () => clock, sleep: async () => {} });
  assert.equal((await http.read({ kind: "course", uuid: U1 })).status, "rate_limited");
  assert.equal((await http.read({ kind: "course", uuid: U1 })).status, "rate_limited");
  assert.equal(fetches, 1);
  clock = 31_000;
  const controller = new AbortController(); controller.abort();
  assert.equal((await http.read({ kind: "course", uuid: U1 }, controller.signal)).status, "cancelled");
  assert.equal(fetches, 1);
});

test("identity maps by exact subject code and number; cross-lists need explicit local evidence", () => {
  const plain = mgCourse(U1, 400, ["266"]);
  assert.equal(resolveMadgradesCourse("uw:266:400", table(), [plain]).status, "resolved");
  // Same name, different number: never matched.
  assert.equal(resolveMadgradesCourse("uw:266:401", table(), [plain]).status, "not_found");
  const shared = mgCourse(U2, 552, ["266", "329"]);
  assert.equal(resolveMadgradesCourse("uw:266:552", table(), [shared]).status, "unverified_crosslist");
  const listed = table([crosslist(["uw:266:552", "uw:329:552"])]);
  const resolved = resolveMadgradesCourse("uw:329:552", listed, [shared]);
  assert.equal(resolved.status, "resolved");
  assert.deepEqual(resolved.status === "resolved" && resolved.courseKeys, ["uw:266:552", "uw:329:552"]);
  // Two Madgrades courses for one local identity stay unresolved rather than combined.
  assert.equal(resolveMadgradesCourse("uw:266:552", listed, [shared, mgCourse(U1, 552, ["329"])]).status, "ambiguous");
});

test("pull searches every explicitly equivalent designation and keeps ambiguous identities unresolved", async () => {
  const listed = table([crosslist(["uw:266:552", "uw:329:552"])]);
  const split = transport({ ...search("266", 552, [mgCourse(U1, 552, ["266"])]), ...search("329", 552, [mgCourse(U2, 552, ["329"])]) });
  const outcome = await pullMadgradesGrades(split, { courseKey: "uw:329:552", table: listed, observedAt });
  assert.equal(outcome.status, "ambiguous");
  assert.deepEqual(split.requests.map((row) => row.kind), ["course-search", "course-search"]);
  assert.equal(outcome.capture?.status, "unsupported");
  assert.equal(outcome.capture?.records.length, 0);
  const truncated = transport({ [`https://api.madgrades.com/v1/courses?subject=266&number=400&per_page=25&page=1`]: { totalCount: 30, results: [mgCourse(U1, 400, ["266"])] } });
  assert.equal((await pullMadgradesGrades(truncated, { courseKey: "uw:266:400", table: table(), observedAt })).status, "ambiguous");
  const topic = transport({});
  assert.equal((await pullMadgradesGrades(topic, { courseKey: "uw:266:400X", table: table(), observedAt })).status, "unsupported_identity");
  assert.equal(topic.requests.length, 0);
});

test("normalization keeps per-term and per-section rows with instructor IDs, public scope, and madgrades source", async () => {
  const outcome = await pullMadgradesGrades(transport(standardRoutes()), { courseKey: "uw:266:400", table: table(), observedAt });
  assert.equal(outcome.status, "saved");
  const capture = outcome.capture!;
  assert.equal(capture.source, "madgrades");
  assert.equal(capture.accountScope, "public");
  assert.deepEqual(capture.scope, { kind: "grade_course", key: "madgrades:uw:266:400" });
  assert.equal(capture.status, "complete");
  const rows = capture.records.filter((row) => row.kind === "grade_distribution");
  assert.equal(rows.length, 2 + 4);
  const term = rows.find((row) => row.termCode === "1264" && row.section === null)!;
  assert.equal(term.coverage, "partial", "the source omits sections without a linked instructor");
  assert.equal(term.provenance.sourceUrl, `https://madgrades.com/courses/${U1}`);
  const coTaught = rows.find((row) => row.section === "003")!;
  assert.deepEqual(coTaught.instructorIds, ["11", "22"]);
  // snake_case (as in the published OpenAPI document) normalizes to the same records.
  const snake = JSON.parse(JSON.stringify(standardGrades).replace(/"([a-z]+)([A-Z])([a-z]*)"/g, (_, a, b, c) => `"${a}_${b.toLowerCase()}${c}"`));
  const parsed = parseMadgradesGrades(snake);
  assert.ok(parsed.success);
});

test("terms with several offerings or inconsistent totals are omitted, not combined", () => {
  const course = parseMadgradesCourse({ ...mgCourse(U1, 400, ["266"]), courseOfferings: [...offerings(U1, [1264, 1264, 1262])] });
  assert.ok(course.success);
  const body = gradesBody(U1, [
    { termCode: 1264, sections: [section(1, [{ id: 11, name: "A" }], { aCount: 3 })] },
    { termCode: 1262, sections: [section(1, [{ id: 11, name: "A" }], { aCount: 3 })] },
  ]);
  body.courseOfferings[1]!.cumulative.aCount = 99;
  const parsed = parseMadgradesGrades(body);
  assert.ok(parsed.success);
  const capture = normalizeMadgradesGrades({ courseKey: "uw:266:400", table: table(), course: course.data, grades: parsed.data, observedAt });
  assert.equal(capture.records.length, 0);
  assert.equal(capture.status, "partial");
  assert.ok(capture.diagnostics.some((row) => row.code === "ambiguous_term_offerings"));
  assert.ok(capture.diagnostics.some((row) => row.code === "inconsistent_term_counts"));
});

test("planning-grades averages use the UW rule with excluded counts, per term and per instructor ID", async () => {
  const store = createStore(":memory:");
  try {
    ingestSubjects(store);
    const same = gradesBody(U1, [
      { termCode: 1264, sections: [
        section(1, [{ id: 11, name: "Instructor One" }], { aCount: 10, bCount: 10, sCount: 2 }),
        section(2, [{ id: 22, name: "Instructor One" }], { cCount: 4, fCount: 1, nwCount: 3 }),
        section(3, [{ id: 11, name: "Instructor One" }, { id: 22, name: "Instructor One" }], { abCount: 6 }),
      ] },
      { termCode: 1262, sections: [section(1, [{ id: 11, name: "Instructor One" }], { aCount: 5, dCount: 5 })] },
    ]);
    const course = mgCourse(U1, 400, ["266"]);
    const core = createCore(store, { fixture: captureBatchSchema.parse(fixture), now: () => new Date(now),
      madgrades: transport({ ...search("266", 400, [course]), ...detail(course, [1264, 1262]), ...grades(U1, same) }) });
    const result = await core.execute({ type: "planning-grades", courseKey: "uw:266:400", refresh: true });
    const summary = result.planningGrades!;
    assert.equal(summary.refresh?.status, "saved");
    const spring = summary.terms.find((row) => row.termCode === "1264")!;
    // (10*4 + 6*3.5 + 10*3 + 4*2 + 1*0) / 31 ; S and NW are excluded, not zero.
    assert.equal(spring.includedCount, 31);
    assert.equal(spring.excludedCount, 5);
    assert.equal(spring.totalCount, 36);
    assert.ok(Math.abs(spring.average! - 99 / 31) < 1e-12);
    assert.equal(spring.status, "partial");
    assert.equal(spring.label, "Spring 2026");
    assert.equal(summary.overall?.termCount, 2);
    assert.equal(summary.overall?.includedCount, 41);
    assert.ok(Math.abs(summary.overall!.average! - (99 + 25) / 41) < 1e-12);
    // Identical names with different Madgrades IDs stay separate; the co-taught section is excluded from both.
    assert.equal(summary.instructors.length, 2);
    const one = summary.instructors.find((row) => row.instructorId === "madgrades:11")!, two = summary.instructors.find((row) => row.instructorId === "madgrades:22")!;
    assert.deepEqual([one.sectionCount, one.includedCount, one.excludedCount, one.coTaughtSectionsExcluded], [2, 30, 2, 1]);
    assert.deepEqual(one.termCodes, ["1264", "1262"]);
    assert.ok(Math.abs(one.average! - (40 + 30 + 20 + 5) / 30) < 1e-12);
    assert.deepEqual([two.sectionCount, two.includedCount, two.excludedCount], [1, 5, 3]);
    assert.ok(summary.warnings.some((row) => row.includes("Co-taught")));
    assert.ok(summary.warnings.some((row) => row.includes("Not a prediction")));
    // A second course-level row for a term (another source) makes that term and the all-term average ambiguous.
    const extra = { id: "imported-1264", kind: "grade_distribution" as const, provenance: { sourceUrl: "https://madgrades.com/", observedAt, scope: { kind: "grade_course" as const, key: "uw:266:400" } },
      courseKey: "uw:266:400", termCode: "1264", section: null, instructorNames: [], counts: [{ grade: "A", count: 1 }], coverage: "published" as const };
    store.ingestPlanning(capture([extra], { kind: "grade_course", key: "uw:266:400" }));
    const again = (await core.execute({ type: "planning-grades", courseKey: "uw:266:400" })).planningGrades!;
    assert.equal(again.refresh, null);
    assert.deepEqual(again.terms.map((row) => row.termCode), ["1262"]);
    assert.equal(again.overall, null);
    await core.close();
  } finally { store.close(); }
});

test("missing token refresh keeps saved evidence, stores nothing new, and the token never reaches records, database, or logs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "magic-madgrades-"));
  const logged: string[] = [];
  const original = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const key of Object.keys(original) as (keyof typeof original)[]) console[key] = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try {
    const store = createStore(join(dir, "workspace.sqlite"));
    ingestSubjects(store);
    // The real host transport with a protected token source, wrapped exactly as the worker boundary would be.
    let tokenValue: string | undefined = TOKEN;
    const routes = standardRoutes();
    const http = new MadgradesHttp({
      token: async () => tokenValue, sleep: async () => {},
      fetch: async (url, init) => {
        assert.equal((init.headers as Record<string, string>).Authorization, `Token token=${TOKEN}`);
        const body = routes[url as keyof typeof routes];
        return new Response(JSON.stringify(body), { status: body ? 200 : 404 });
      },
    });
    const core = createCore(store, { fixture: captureBatchSchema.parse(fixture), now: () => new Date(now), madgrades: { read: (request, signal) => http.read(request, signal) } });
    const saved = await core.execute({ type: "planning-grades", courseKey: "uw:266:400", refresh: true });
    assert.equal(saved.planningGrades?.refresh?.status, "saved");
    const before = store.planningRecords().filter((row) => row.kind === "grade_distribution").length;
    assert.equal(before, 6);
    tokenValue = undefined;
    const missing = await core.execute({ type: "planning-grades", courseKey: "uw:266:400", refresh: true });
    assert.equal(missing.planningGrades?.refresh?.status, "missing_token");
    assert.match(missing.message ?? "", /Add a Madgrades API token/);
    assert.equal(store.planningRecords().filter((row) => row.kind === "grade_distribution" && !row.deleted).length, before);
    assert.equal(missing.planningGrades?.terms.length, 2, "saved evidence is still summarized");
    await assert.rejects(core.execute({ type: "madgrades-token", token: TOKEN }), /desktop app/);
    const serialized = JSON.stringify([saved, missing, store.planningRecords(), store.planningSources()]);
    assert.ok(!serialized.includes(TOKEN));
    await core.close();
    store.close();
    for (const file of readdirSync(dir)) assert.ok(!readFileSync(join(dir, file)).includes(TOKEN), `${file} contains the token`);
    assert.ok(!logged.join("\n").includes(TOKEN));
  } finally {
    Object.assign(console, original);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Madgrades evidence stays excluded from MCP, hosted AI/Jev, and local tutoring context", async () => {
  const store = createStore(":memory:");
  const accessed: string[] = [];
  const guarded = new Proxy(store, { get(target, key) {
    if (key === "planningRecords" || key === "planningSources") accessed.push(String(key));
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } }) as Store;
  const payloads: unknown[] = [];
  const core = createCore(guarded, { fixture: captureBatchSchema.parse(fixture), gateway: { async evaluate(payload) {
    payloads.push(payload);
    return { kind: "essay", probabilities: { essay: 0.97, problem_set: 0.005, quiz: 0.005, exam: 0.005, discussion: 0.005, project: 0.005, reading: 0.005, other: 0 }, model: "synthetic-model", questionVersion: "assignment.kind.v1" };
  } } });
  try {
    await core.execute({ type: "fixture" });
    await core.settled();
    ingestSubjects(store);
    const course = mgCourse(U1, 400, ["266"]);
    const marked = gradesBody(U1, [{ termCode: 1264, sections: [section(1, [{ id: 11, name: INSTRUCTOR_MARKER }], { aCount: 7 })] }]);
    const pulled = await pullMadgradesGrades(transport({ ...search("266", 400, [course]), ...detail(course, [1264]), ...grades(U1, marked) }), { courseKey: "uw:266:400", table: table(), observedAt });
    store.ingestPlanning(pulled.capture!);
    assert.ok(JSON.stringify(store.planningRecords()).includes(INSTRUCTOR_MARKER), "the marker is saved locally");
    // Every sharing flag on, including the reserved planning flags: planning still has no egress path.
    const open = Object.fromEntries(Object.entries(defaultPrivacy).map(([key, value]) => [key, typeof value === "boolean" ? true : value]));
    await core.execute({ type: "privacy", value: { ...open, mode: "selective_cloud", hostedProvider: defaultPrivacy.hostedProvider } });
    await core.execute({ type: "consent", value: { action: "grant", recipient: "jev", disclosureVersion: CONSENT_DISCLOSURE_VERSION } });
    const resources = store.resources();
    // Hosted/Jev judgment jobs: their payloads are checked below. (The command result's local UI snapshot
    // may read planning storage; that stays on this device.)
    for (const resource of resources) await core.execute({ type: "enrich", id: resource.id });
    await core.settled();
    accessed.length = 0;
    const contexts = resources.flatMap((resource) => (["jev", "local", "claude", "chatgpt", "gemini"] as const).map((recipient) => core.context(resource.id, recipient)));
    const token = randomBytes(16).toString("hex");
    guarded.setMcpGrant({ id: "client", label: "Test", recipient: "local", enabled: true,
      courses: [...new Map(store.sources().map((row) => [`${row.accountScope}/${row.courseId}`, { accountScope: row.accountScope, courseId: row.courseId }])).values()],
      categories: ["course_text", "student_work", "grades", "comments", "communications"], tokenHash: createHash("sha256").update(token).digest("hex") });
    const mcp = createMcpService(guarded, "client", token, () => new Date(now));
    const outputs: unknown[] = [];
    for (const tool of ["search", "due_soon", "recent_changes", "course_overview", "answer_course_question"] as const)
      outputs.push(mcp.call(tool, { query: "Synthetic Course grades instructor", days: 90 }));
    for (const resource of resources) outputs.push(mcp.call("get_item", { id: resource.id }));
    await mcp.server.close();
    assert.deepEqual(accessed, [], "MCP, context, and AI paths never read planning storage");
    const shared = JSON.stringify([contexts, payloads, outputs]);
    for (const marker of [INSTRUCTOR_MARKER, "madgrades", U1, "grade_distribution"]) assert.ok(!shared.toLowerCase().includes(marker.toLowerCase()), `shared output contains ${marker}`);
    assert.ok(payloads.length > 0 && outputs.length > 0, "the egress paths were actually exercised");
  } finally { await core.close(); store.close(); }
});

test("compare ordering is unchanged by Madgrades averages; the course-level row is shown as evidence only", async () => {
  const run = (withGrades: boolean) => {
    const store = seededCompare();
    try {
      if (withGrades) {
        // Deliberately opposite averages: the progress/schedule order must not move.
        for (const [number, uuid, letter] of [["400", U1, "fCount"], ["577", U2, "aCount"]] as const) {
          const course = parseMadgradesCourse({ ...mgCourse(uuid, Number(number), ["266"]), courseOfferings: offerings(uuid, [1264]) });
          const body = parseMadgradesGrades(gradesBody(uuid, [{ termCode: 1264, sections: [section(1, [{ id: 1, name: "X" }], { [letter]: 20 }), section(2, [{ id: 2, name: "Y" }], { [letter]: 5 })] }]));
          assert.ok(course.success && body.success);
          store.ingestPlanning(normalizeMadgradesGrades({ courseKey: `uw:266:${number}`, table: table(), course: course.data, grades: body.data, observedAt }));
        }
      }
      return comparePlanning(store, "1272", "balanced", now);
    } finally { store.close(); }
  };
  const without = run(false), withGrades = run(true);
  assert.deepEqual(withGrades.candidates.map((row) => [row.courseKey, row.packageId]), without.candidates.map((row) => [row.courseKey, row.packageId]));
  assert.equal(without.candidates[0]!.courseKey, "uw:266:400");
  const first = withGrades.candidates[0]!;
  assert.equal(first.historicalAverage, 0);
  assert.equal(first.historicalCount, 25);
  assert.ok(first.evidence.some((row) => row.label === "Grades · Spring 2026 · Course data · Partial" && row.url === `https://madgrades.com/courses/${U1}`));
  assert.ok(!withGrades.warnings.some((row) => row.includes("No arbitrary section average")));
});

function capture(records: PlanningRecord[], scope: PlanningScope, accountScope = "public", extra: Partial<PlanningCapture> = {}): PlanningCapture {
  return { schemaVersion: 1, id: `fixture-${scope.kind}-${scope.key}-${Math.random()}`, accountScope, source: "normalized_import", scope, sourceUrl: "https://enroll.wisc.edu/", observedAt, status: "complete", completeness: "complete", records, diagnostics: [], ...extra };
}
function ingestSubjects(store: Store) {
  store.ingestPlanning(capture(subjects, { kind: "subjects", key: "all" }));
}
function seededCompare() {
  const store = createStore(":memory:");
  const p = (kind: PlanningScope["kind"], key: string): PlanningProvenance => ({ sourceUrl: "https://enroll.wisc.edu/", observedAt, scope: { kind, key } });
  const course = (number: string): PlanningCatalogCourse => ({ id: `course-${number}`, kind: "catalog_course", provenance: p("catalog_term", "1272"), courseKey: `uw:266:${number}`, termCode: "1272", title: `Synthetic course ${number}`, description: "Synthetic", creditMin: 3, creditMax: 3, designations: [], prerequisiteText: null, prerequisite: { kind: "none" }, prerequisiteCheckedAt: observedAt, offeringFrequency: null });
  const pkg = (number: string, start: number): PlanningEnrollmentPackage => ({ id: `package-${number}`, kind: "enrollment_package", provenance: p("catalog_term", "1272"), courseKey: `uw:266:${number}`, termCode: "1272", sections: ["001"], status: "open", enrollmentState: "available", meetings: [{ kind: "class", mode: "scheduled", days: [1, 3, 5], startMinute: start, endMinute: start + 50, startDate: "2026-09-02", endDate: "2026-12-10", timezone: "America/Chicago", location: null }], meetingsComplete: true, seatsAvailable: 4, capacity: 40, waitlistCount: 0, instructorNames: [] });
  const history: PlanningCourseHistory = { id: "taken-300", kind: "course_history", provenance: p("degree_plan", "primary"), courseKey: "uw:266:300", termCode: "1264", state: "completed", credits: 3, grade: "AB", gpaEligible: true };
  // 400 is scarce major core (one option); 577 is an elective. Progress, not grades, orders them.
  const audit: PlanningAudit = { id: "audit", kind: "audit", provenance: p("audit_program", "program"), programKey: "program", generatedAt: observedAt, catalogTerm: "20251", coverage: "complete", nodes: [
    { nodeId: "core", parentId: null, index: 0, kind: "requirement", title: "Core", requirementKind: "major_core", rawStatus: "NO", status: "incomplete", flags: [], earnedCredits: 0, earnedGpa: null, needsCourses: 1, needsCredits: 3, acceptableCourseKeys: ["uw:266:400"], appliedCourses: [], coverage: "complete", evidence: [{ blockId: "core", quote: "COMP SCI 400" }] },
    { nodeId: "elective", parentId: null, index: 1, kind: "requirement", title: "Elective", requirementKind: "elective", rawStatus: "NO", status: "incomplete", flags: [], earnedCredits: 0, earnedGpa: null, needsCourses: 1, needsCredits: 3, acceptableCourseKeys: ["uw:266:577"], appliedCourses: [], coverage: "complete", evidence: [{ blockId: "elective", quote: "COMP SCI 577" }] },
  ] };
  ingestSubjects(store);
  store.ingestPlanning(capture([history], { kind: "degree_plan", key: "primary" }, "student-hash"));
  store.ingestPlanning(capture([audit], { kind: "audit_program", key: "program" }, "student-hash"));
  store.ingestPlanning(capture([course("400"), course("577"), pkg("400", 540), pkg("577", 600)], { kind: "catalog_term", key: "1272" }));
  store.ingestPlanning(capture([], { kind: "enrollment_term", key: "1272" }, "student-hash"));
  return store;
}

test("private account cross-lists cannot establish public Madgrades course identity", async () => {
  const store = createStore(":memory:");
  const course = mgCourse(U1, 400, ["266", "329"]);
  const client = transport({ ...search("266", 400, [course]) });
  const core = createCore(store, { fixture: captureBatchSchema.parse(fixture), madgrades: client });
  try {
    ingestSubjects(store);
    store.ingestPlanning(capture([crosslist(["uw:266:400", "uw:329:400"])], { kind: "subjects", key: "all" }, "different-account"));
    const result = await core.execute({ type: "planning-grades", courseKey: "uw:266:400", refresh: true });
    assert.equal(result.planningGrades?.refresh?.status, "unverified_crosslist");
    assert.equal(client.requests.length, 1);
    assert.equal(result.planningGrades?.overall, null);
  } finally { await core.close(); store.close(); }
});

test("purge cancels an in-flight Madgrades read and late transport replies cannot restore records", async () => {
  const store = createStore(":memory:");
  let release!: (value: MadgradesReadResult) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let calls = 0;
  let readSignal: AbortSignal | undefined;
  const core = createCore(store, { fixture: captureBatchSchema.parse(fixture), madgrades: { async read(_request, signal) {
    calls++; readSignal = signal; entered();
    return new Promise<MadgradesReadResult>((resolve) => { release = resolve; });
  } } });
  try {
    ingestSubjects(store);
    const pending = core.execute({ type: "planning-grades", courseKey: "uw:266:400", refresh: true });
    const rejected = assert.rejects(pending, /cancelled/);
    await started;
    await core.execute({ type: "purge", confirmation: "DELETE LOCAL DATA" });
    assert.equal(readSignal?.aborted, true);
    release({ status: "ok", data: { totalCount: 1, results: [mgCourse(U1, 400, ["266"])] } });
    await rejected;
    assert.equal(calls, 1);
    assert.deepEqual(store.planningRecords(), []);
    assert.deepEqual(store.planningSources(), []);
  } finally { await core.close(); store.close(); }
});
