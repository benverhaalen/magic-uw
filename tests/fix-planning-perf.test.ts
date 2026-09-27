import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";
const remove = (file: string) => { for (const suffix of ["", "-wal", "-shm"]) rmSync(file + suffix, { force: true }); };
import type { PlanningCapture, PlanningSubject } from "@magic/contracts";
import { createStore, SCHEMA_VERSION } from "@magic/storage";
import { syncUwPlanning, type UwPlanningSyncResult } from "../packages/connectors/src/uw-planning-sync";
import type { UwPlanningReadRequest, UwPlanningReadResult } from "../packages/connectors/src/uw-planning-http";
import { pullGuideForSubject } from "../packages/connectors/src/planning-public";
import { PLANNING_V12 } from "../packages/storage/src/planning-v12";
import { planningSourceId } from "../packages/storage/src/planning";
import {
  PLANNING_ADD_DROP_MS, PLANNING_TERM_MS, planningHorizon, planningRefreshDue, publicSourceTermFresh,
  reconfirmedAuditCaptures, semesterPlanningHorizons, storedAuditReports, termFreshSearchSubjects,
} from "../packages/core/src/planning";
import { madgradesUpToDate } from "../packages/core/src/planning-grades";

// Synthetic fixtures only: no real student, course or report data.
const seed = "synthetic-installation-seed-0000000000000000";
const DAY = 24 * 60 * 60 * 1000;
const date = new Date("2026-09-26T18:00:00Z");
const hostOf: Record<string, string> = { "public-terms": "public.enroll.wisc.edu", "myuw-session": "my.wisc.edu", "canvas-profile": "canvas.wisc.edu" };
const ok = (data: unknown, request?: UwPlanningReadRequest): UwPlanningReadResult =>
  ({ status: "ok", data, bytes: 100, elapsedMs: 5, httpStatus: 200, host: hostOf[request?.kind ?? ""] ?? "enroll.wisc.edu", schemaVerified: false });
const student = () => ({
  personAttributes: { emplid: "98765432101234", netid: "synthetic", email: "synthetic@wisc.edu" },
  primaryCareer: { careerCode: "UGRD", programName: "Undergraduate", termCode: "1272" },
  enrollmentImpacts: { holds: [], registrationAppointments: [] }, studentAdvisorRelationships: [],
});
const metadata = (reportId: number, program: string) => ({
  darsDegreeAuditReportId: reportId, darsInstitutionCode: "UW", darsDegreeProgramCode: program, darsHonorsOptionCode: "",
  darsAuditRunDate: "2026-09-20T12:00:00Z", darsCatalogYearTerm: "20251",
});
const report = (program: string) => ({
  header: { darsDegreeProgramCode: program, darsCatalogYearTerm: "20251", degreeProgramTitle1: `Synthetic ${program}` },
  topSection: {}, completeText: "", requirementEndnote: "", bottomSection: {}, errorText: [],
  requirements: [{ requirementName: "TEST", status: { status: "OK", description: "ok" }, requirementContents: [
    { contentType: "okRequirementTitle", lines: ["Synthetic requirement"] },
    { contentType: "okSubrequirementTLine", lines: ["+ 1) Core course"] },
    { contentType: "okSubrequirementEarnedLine", lines: ["EARNED: 3.00 CREDITS"] },
  ] }],
});
const myuw = { person: { firstName: "x", lastName: "x", displayName: "x", userName: "x", sessionKey: "x", serverName: "synthetic.test", version: "1" } };

/** A fixture UW: every read returns synthetic data; `slow` reads wait until the signal aborts. */
function uw(slow: (request: UwPlanningReadRequest) => boolean = () => false) {
  const requests: UwPlanningReadRequest[] = [];
  return { requests, async read(request: UwPlanningReadRequest, signal?: AbortSignal): Promise<UwPlanningReadResult> {
    requests.push(request);
    if (slow(request)) {
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      return { status: "cancelled", code: "cancelled", bytes: 0, elapsedMs: 0, schemaVerified: false };
    }
    switch (request.kind) {
      case "student-info": return ok(student(), request);
      case "myuw-session": return ok(myuw, request);
      case "degree-plans": case "current-enrollment": return ok([], request);
      case "audit-metadata": return ok([metadata(123, "TEST-MAJOR"), metadata(200, "TEST-MINOR")], request);
      case "audit-report": return ok(report(request.reportId === "123" ? "TEST-MAJOR" : "TEST-MINOR"), request);
      default: return ok({}, request);
    }
  } };
}
const kinds = (http: ReturnType<typeof uw>, kind: string) => http.requests.filter((request) => request.kind === kind).length;

test("fix 1: a slow DARS read keeps enrollment and history; only DARS is marked refresh_failed", async () => {
  const http = uw((request) => request.kind === "audit-metadata");
  const deadline = new AbortController();
  const running = syncUwPlanning({ http, accountSeed: seed, now: () => date, deadline: deadline.signal });
  // Fire the soft deadline once the DARS read is in flight.
  while (!http.requests.some((request) => request.kind === "audit-metadata")) await new Promise((resolve) => setTimeout(resolve, 1));
  deadline.abort();
  const result = await running;
  assert.equal(result.partial, true);
  const enrollment = result.captures.find((capture) => capture.scope.kind === "enrollment_term");
  const history = result.captures.find((capture) => capture.scope.kind === "degree_plan");
  assert.ok(enrollment && enrollment.status !== "failed", "enrollment arrived before the deadline and is kept");
  assert.ok(history && history.status !== "failed", "history arrived before the deadline and is kept");
  const dars = result.captures.filter((capture) => capture.source === "uw_dars");
  assert.ok(dars.length && dars.every((capture) => capture.status === "failed" && capture.diagnostics.some((item) => item.code === "refresh_failed")));
  assert.ok(result.captures.some((capture) => capture.diagnostics.some((item) => item.code === "account_verified")), "identity rechecked on its own budget");
  assert.equal(result.invalidated.some((item) => item.source === "uw_enroll"), false, "enrollment is not invalidated");
  const store = createStore(":memory:");
  try {
    store.ingestPlanningBatch(result.captures);
    assert.ok(store.planningSources().some((source) => source.scope.kind === "enrollment_term" && source.status === "complete"));
  } finally { store.close(); }
  // The hard cancel still discards everything.
  const cancel = new AbortController(); cancel.abort();
  await assert.rejects(syncUwPlanning({ http: uw(), accountSeed: seed, signal: cancel.signal }));
});

async function fullSync(store: ReturnType<typeof createStore>, http: ReturnType<typeof uw>, at: Date): Promise<UwPlanningSyncResult> {
  const now = at.toISOString();
  const result = await syncUwPlanning({ http, accountSeed: seed, now: () => at,
    storedAudits: storedAuditReports(store), freshSubjects: termFreshSearchSubjects(store, now) ?? undefined });
  const reconfirmed = reconfirmedAuditCaptures(store, result.reconfirmed ?? [], new Date(at.getTime() + 1).toISOString());
  store.ingestPlanningBatch([...reconfirmed, ...result.captures]);
  return result;
}

test("fix 2 + 6: a second sync fetches 0 stored reports, reconfirms them, and costs fewer requests", async () => {
  const store = createStore(":memory:");
  try {
    const first = uw(), second = uw();
    const before = await fullSync(store, first, date);
    assert.equal(kinds(first, "audit-report"), 2);
    const stored = storedAuditReports(store);
    assert.equal(stored.length, 2, "both reports are stored with complete coverage");
    const audits = () => store.planningRecords().filter((row) => row.kind === "audit" && !row.deleted);
    const after = await fullSync(store, second, new Date(date.getTime() + DAY));
    assert.equal(kinds(second, "audit-report"), 0, "no stored report is downloaded again");
    assert.equal(after.reconfirmed?.length, 2);
    assert.equal(audits().length, 2, "reconfirmed records are kept, not deleted");
    for (const row of audits()) assert.equal(row.provenance.observedAt, new Date(date.getTime() + DAY + 1).toISOString());
    const auditSources = store.planningSources().filter((source) => source.scope.kind === "audit_program" && source.status === "complete");
    assert.equal(auditSources.length, 2, "not left as audit_not_reconfirmed");
    // Measurement from each read's own metadata.
    assert.equal(before.metrics?.requests, first.requests.length);
    assert.equal(after.metrics?.requests, second.requests.length);
    assert.ok(after.metrics!.requests < before.metrics!.requests);
    assert.equal(before.metrics?.hosts["enroll.wisc.edu"]?.requests, first.requests.filter((request) => !hostOf[request.kind]).length);
    console.log(`planning requests per full sync: before ${before.metrics!.requests} (${JSON.stringify(Object.fromEntries(Object.entries(before.metrics!.hosts).map(([h, v]) => [h, v.requests])))}), repeat ${after.metrics!.requests}`);
  } finally { store.close(); }
});

test("fix 4: term-fresh public search reads are skipped and stored subjects feed the audits", async () => {
  const store = createStore(":memory:");
  try {
    const subject: PlanningSubject = { kind: "subject", id: "266", code: "266", shortName: "COMP SCI", formalName: "Computer Sciences", aliases: [],
      provenance: { sourceUrl: "https://enroll.wisc.edu/api/search/v1/subjectsMap/0000", observedAt: date.toISOString(), scope: { kind: "subjects", key: "search-subjects-map:0000" } } };
    const base = { schemaVersion: 1 as const, accountScope: "public", source: "uw_public" as const, observedAt: date.toISOString(), status: "complete" as const, completeness: "complete" as const, diagnostics: [] };
    store.ingestPlanningBatch([
      { ...base, id: "s", scope: subject.provenance.scope, sourceUrl: subject.provenance.sourceUrl, records: [subject] },
      { ...base, id: "t", scope: { kind: "terms", key: "public-search-terms" }, sourceUrl: "https://public.enroll.wisc.edu/api/search/v1/aggregate", records: [] },
    ] satisfies PlanningCapture[]);
    const later = new Date(date.getTime() + 30 * DAY).toISOString();
    assert.deepEqual(termFreshSearchSubjects(store, later)?.map((row) => row.id), ["266"]);
    assert.equal(termFreshSearchSubjects(store, new Date(date.getTime() + PLANNING_TERM_MS + DAY).toISOString()), null, "stale after a term");
    const http = uw();
    await syncUwPlanning({ http, accountSeed: seed, now: () => new Date(later), freshSubjects: termFreshSearchSubjects(store, later) });
    assert.equal(kinds(http, "public-terms") + kinds(http, "subjects-map"), 0);
    // An invalid hint is ignored: the reads happen.
    const checked = uw();
    await syncUwPlanning({ http: checked, accountSeed: seed, now: () => date, freshSubjects: [{ kind: "subject", id: "<bad>" }] });
    assert.equal(kinds(checked, "public-terms"), 1);
    // Registrar pages follow the same rule.
    const registrar = store.planningSource(planningSourceId("uw_public", "public", { kind: "terms", key: "public-search-terms" }));
    assert.equal(publicSourceTermFresh(registrar, later), true);
    assert.equal(publicSourceTermFresh(undefined, later), false);
  } finally { store.close(); }
});

test("fix 4: the Guide index is read once per term, and read again after a miss", async () => {
  const index = '<a href="/courses/comp_sci/">Computer Sciences (COMP SCI)</a>';
  const page = '<div class="courseblock"></div>';
  const urls: string[] = [];
  const client = { async text(url: string) { urls.push(url); return { text: url.endsWith("/courses/") ? index : page, url }; } } as any;
  const subject: PlanningSubject = { kind: "subject", id: "266", code: "266", shortName: "COMP SCI", formalName: "Computer Sciences", aliases: [],
    provenance: { sourceUrl: "https://enroll.wisc.edu/x", observedAt: date.toISOString(), scope: { kind: "subjects", key: "k" } } };
  await pullGuideForSubject(client, subject, [subject], date.toISOString());
  await pullGuideForSubject(client, subject, [subject], date.toISOString());
  assert.equal(urls.filter((url) => url.endsWith("/courses/")).length, 1);
  await assert.rejects(pullGuideForSubject(client, { ...subject, shortName: "NOPE" }, [subject], date.toISOString()));
  await pullGuideForSubject(client, subject, [subject], date.toISOString());
  assert.equal(urls.filter((url) => url.endsWith("/courses/")).length, 2, "the miss used the cached index, then dropped it");
});

test("fix 3: freshness horizons per source kind, add/drop-aware for enrollment", () => {
  const now = "2026-09-10T12:00:00Z";
  const addDrop = { start: "2026-08-01T00:00:00Z", end: "2026-09-16T00:00:00Z" };
  assert.equal(planningHorizon("enrollment", now, addDrop), PLANNING_ADD_DROP_MS);
  assert.equal(planningHorizon("enrollment", "2026-10-10T12:00:00Z", addDrop), PLANNING_TERM_MS);
  assert.equal(planningHorizon("enrollment", now, null), PLANNING_ADD_DROP_MS, "unknown window is treated as add/drop");
  for (const kind of ["history", "audit", "catalog"] as const) assert.equal(planningHorizon(kind, now, addDrop), PLANNING_TERM_MS);
  assert.equal(PLANNING_ADD_DROP_MS, 7 * DAY);
  assert.equal(semesterPlanningHorizons(now, addDrop)("prerequisite"), PLANNING_TERM_MS);
});

test("fix 4: cadence is weekly in add/drop, once per term otherwise, only after a first connection", () => {
  const store = createStore(":memory:");
  try {
    const at = "2026-09-01T12:00:00Z";
    assert.equal(planningRefreshDue(store, at), false, "never connected: no background sign-in reads");
    store.ingestPlanning({ schemaVersion: 1, id: "c", source: "uw_enroll", accountScope: `uw-account:${"a".repeat(64)}`, scope: { kind: "student_record", key: "connection:student-info" },
      sourceUrl: "https://enroll.wisc.edu/api/enroll/v1/studentInfo", observedAt: at, status: "complete", completeness: "complete", records: [], diagnostics: [] });
    const after = (days: number) => new Date(Date.parse(at) + days * DAY).toISOString();
    const inWindow = { start: "2026-08-01T00:00:00Z", end: "2026-12-31T00:00:00Z" }, outside = { start: "2026-01-01T00:00:00Z", end: "2026-01-15T00:00:00Z" };
    assert.equal(planningRefreshDue(store, after(6), inWindow), false);
    assert.equal(planningRefreshDue(store, after(7), inWindow), true);
    assert.equal(planningRefreshDue(store, after(30), outside), false);
    assert.equal(planningRefreshDue(store, after(120), outside), true);
  } finally { store.close(); }
});

test("fix 4: the sync reports the add/drop window from the published term dates", async () => {
  const begin = Date.parse("2026-08-26T00:00:00Z"), instruction = Date.parse("2026-09-02T00:00:00Z");
  const http = uw();
  const read = http.read.bind(http);
  http.read = async (request, signal) => request.kind === "public-terms" ? ok({ terms: [{ termCode: "1272", longDescription: "Fall 2026", shortDescription: "2026 Fall",
    academicYear: "2026-2027", pastTerm: false, beginDate: begin, endDate: Date.parse("2027-01-20T00:00:00Z"), instructionBeginDate: instruction, instructionEndDate: Date.parse("2026-12-10T00:00:00Z") }] }, request) : read(request, signal);
  const result = await syncUwPlanning({ http, accountSeed: seed, now: () => date });
  assert.deepEqual(result.addDrop, { start: new Date(begin).toISOString(), end: new Date(instruction + 14 * DAY).toISOString() });
});

test("fix 4: Madgrades is skipped only when the latest past term is saved", () => {
  const store = createStore(":memory:");
  try {
    const at = date.toISOString();
    const term = (code: string, past: boolean) => ({ kind: "term", id: code, code, season: code.endsWith("2") ? "fall" : "spring", year: code.endsWith("2") ? 2000 + Number(code.slice(1, 3)) - 1 : 2000 + Number(code.slice(1, 3)), label: "x", past,
      provenance: { sourceUrl: "https://public.enroll.wisc.edu/api/search/v1/aggregate", observedAt: at, scope: { kind: "terms", key: "public-search-terms" } } });
    const subject = { kind: "subject", id: "266", code: "266", shortName: "COMP SCI", formalName: "Computer Sciences", aliases: [],
      provenance: { sourceUrl: "https://enroll.wisc.edu/api/search/v1/subjectsMap/0000", observedAt: at, scope: { kind: "subjects", key: "search-subjects-map:0000" } } };
    const base = { schemaVersion: 1, accountScope: "public", observedAt: at, status: "complete", completeness: "complete", diagnostics: [] };
    store.ingestPlanningBatch([
      { ...base, id: "t", source: "uw_public", scope: { kind: "terms", key: "public-search-terms" }, sourceUrl: "https://public.enroll.wisc.edu/api/search/v1/aggregate", records: [term("1264", true), term("1272", false)] },
      { ...base, id: "s", source: "uw_public", scope: { kind: "subjects", key: "search-subjects-map:0000" }, sourceUrl: "https://enroll.wisc.edu/api/search/v1/subjectsMap/0000", records: [subject] },
    ]);
    assert.equal(madgradesUpToDate(store, "uw:266:300"), false, "nothing saved yet");
    const grades = (termCode: string) => ({ ...base, id: "g" + termCode, source: "madgrades", scope: { kind: "grade_course", key: "madgrades:uw:266:300" },
      observedAt: new Date(date.getTime() + Number(termCode)).toISOString(),
      sourceUrl: "https://api.madgrades.com/v1/courses/x/grades", records: [{ kind: "grade_distribution", id: `${termCode}:course`, courseKey: "uw:266:300", termCode, section: null,
        instructorIds: [], instructorNames: [], counts: [{ grade: "A", count: 10 }], coverage: "published",
        provenance: { sourceUrl: "https://api.madgrades.com/v1/courses/x/grades", observedAt: new Date(date.getTime() + Number(termCode)).toISOString(), scope: { kind: "grade_course", key: "madgrades:uw:266:300" } } }] });
    const saved = store.ingestPlanning(grades("1262"));
    assert.equal(saved.rejected, 0, "fixture grade row is valid");
    assert.equal(madgradesUpToDate(store, "uw:266:300"), false, "an older term only");
    store.ingestPlanning(grades("1264"));
    assert.equal(madgradesUpToDate(store, "uw:266:300"), true);
  } finally { store.close(); }
});

test("fix 5: one source by ID, batch in one transaction, captures pruned to 3, index present", () => {
  const store = createStore(":memory:");
  try {
    const scope = { kind: "terms" as const, key: "registrar-session-terms" };
    const capture = (minute: number): PlanningCapture => ({ schemaVersion: 1, id: `c${minute}`, source: "uw_public", accountScope: "public", scope,
      sourceUrl: "https://registrar.wisc.edu/sessioncodes/", observedAt: new Date(date.getTime() + minute * 60_000).toISOString(),
      status: "failed", completeness: "unknown", records: [], diagnostics: [] });
    const results = store.ingestPlanningBatch([capture(1), { bad: true }, capture(2), capture(3), capture(4), capture(5)]);
    assert.equal(results[1], null, "a malformed capture is skipped, the rest are written");
    const id = planningSourceId("uw_public", "public", scope);
    assert.equal(store.planningSource(id)?.observedAt, capture(5).observedAt);
    assert.equal(store.planningSource("missing"), undefined);
  } finally { store.close(); }
  const file = `${process.env.TEMP ?? "/tmp"}/fix-planning-perf-${process.pid}.sqlite`;
  const writer = createStore(file);
  const scope = { kind: "terms" as const, key: "registrar-session-terms" };
  for (let minute = 1; minute <= 5; minute++) writer.ingestPlanning({ schemaVersion: 1, id: `c${minute}`, source: "uw_public", accountScope: "public", scope,
    sourceUrl: "https://registrar.wisc.edu/sessioncodes/", observedAt: new Date(date.getTime() + minute * 60_000).toISOString(), status: "failed", completeness: "unknown", records: [], diagnostics: [] });
  writer.close();
  const db = new DatabaseSync(file);
  try {
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM planning_captures").get()!.n), 3);
    assert.equal(Number(db.prepare("PRAGMA user_version").get()!.user_version), SCHEMA_VERSION);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='planning_records_source'").get());
    // The migration is idempotent and prunes an older unbounded log.
    db.exec("PRAGMA foreign_keys=OFF; INSERT INTO planning_captures SELECT source_id, '2000-01-0' || x || 'T00:00:00.000Z', payload FROM (SELECT * FROM planning_captures LIMIT 1), (SELECT 1 AS x UNION SELECT 2 UNION SELECT 3);");
    db.exec(PLANNING_V12); db.exec(PLANNING_V12);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM planning_captures").get()!.n), 3);
  } finally { db.close(); remove(file); }
});

test("fix 5: the v12 step applies to a v9 database", () => {
  const file = `${process.env.TEMP ?? "/tmp"}/fix-planning-perf-v9-${process.pid}.sqlite`;
  createStore(file).close();
  const db = new DatabaseSync(file);
  db.exec("DROP INDEX planning_records_source; PRAGMA user_version = 9;");
  db.close();
  createStore(file).close();
  const check = new DatabaseSync(file);
  try {
    assert.equal(Number(check.prepare("PRAGMA user_version").get()!.user_version), SCHEMA_VERSION);
    assert.ok(check.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='planning_records_source'").get());
  } finally { check.close(); remove(file); }
});
