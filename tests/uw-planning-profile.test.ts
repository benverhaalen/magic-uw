import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "@magic/storage";
import { getUwPrimaryTerm, normalizeUwPublicTerms, normalizeUwStudentInfo, normalizeUwSubjectsMap, verifyMyUwSession } from "../packages/connectors/src/uw-planning-profile";

// Synthetic rows modeled on observed shape files; no student capture is a fixture.
const observedAt = "2026-09-26T18:00:00Z";
const context = { accountScope: "uw-account:synthetic", observedAt };
const appointment = (registrationDateTime = Date.parse("2026-03-08T03:30:00-05:00")) => ({
  careerCode: "UGRD", termCode: "1272", termDescription: "Fall 2026-2027", registrationDateTime,
});
const program = (description: string, graduation = "1284") => ({ description, isPrimaryProgramInTerm: true,
  expectedGraduationTerm: { code: graduation, description: "Synthetic graduation term" } });
function student() {
  return {
    personAttributes: { emplid: "DO_NOT_COPY_ID", name: { first: "DO_NOT_COPY_NAME" }, netid: "DO_NOT_COPY_NETID", email: "DO_NOT_COPY_EMAIL" },
    primaryCareer: { careerCode: "UGRD", programName: "Undergraduate", termCode: "1272", academicLevelDescription: "DO_NOT_COPY_LEVEL" },
    enrollmentImpacts: { holds: [] as unknown[], registrationAppointments: [appointment()] as unknown[] },
    studentAdvisorRelationships: [] as unknown[],
    academicObjective: { academicObjectiveTerms: [
      { term: { code: "1262", description: "Historical" }, studentPrograms: [program("DO_NOT_COPY_OLD_PROGRAM", "1264")] },
      { term: { code: "1272", description: "Current" }, studentPrograms: [program("Synthetic current program"), program("Synthetic certificate")] },
    ] },
    academicSummary: [{ cumulativeGpa: 4, credits: 400, identity: "DO_NOT_COPY_ACADEMICS" }],
    unrecognized: { instructions: "DO_NOT_COPY_INSTRUCTIONS", sessionKey: "DO_NOT_COPY_SESSION" },
  };
}
const scope = (captures: ReturnType<typeof normalizeUwStudentInfo>, key: string) => captures.find((capture) => capture.scope.key === `student-info:${key}`)!;
const publishedTerm = (code = "1272") => ({
  termCode: code, academicYear: "2026-27", longDescription: "Fall 2026-2027", shortDescription: "2026 Fall", pastTerm: false,
  beginDate: Date.parse("2026-08-24T00:00:00-05:00"), endDate: Date.parse("2026-12-20T23:59:59-06:00"),
  instructionBeginDate: Date.parse("2026-09-02T00:00:00-05:00"), instructionEndDate: Date.parse("2026-12-10T23:59:59-06:00"),
});
const aggregate = () => ({ terms: [publishedTerm()], subjects: {
  "0000": [{ subjectCode: "266", formalDescription: "Computer Sciences", termCode: "0000" }, { subjectCode: "320", formalDescription: "Electrical and Computer Engineering", termCode: "0000" }],
  "1262": [{ subjectCode: "266", formalDescription: "Historical subject name", termCode: "1262" }],
} });

test("student projection keeps current-term programs and discards identities, raw academics and historical programs", () => {
  const result = normalizeUwStudentInfo(student(), context);
  const summary = scope(result, "summary");
  assert.equal(summary.status, "partial");
  assert.equal(summary.completeness, "partial");
  assert.equal(summary.accountScope, context.accountScope);
  assert.deepEqual(summary.records[0], {
    kind: "student_summary", id: "primary", provenance: { sourceUrl: "https://enroll.wisc.edu/api/enroll/v1/studentInfo", observedAt, scope: summary.scope },
    career: "Undergraduate", programNames: ["Synthetic current program", "Synthetic certificate"], expectedGraduationTerm: "1284",
    cumulativeGpa: null, earnedCredits: null, attemptedCredits: null,
  });
  assert.equal(JSON.stringify(result).includes("DO_NOT_COPY"), false);
  assert.equal(getUwPrimaryTerm(student()), "1272");
  assert.equal(getUwPrimaryTerm({ primaryCareer: { ...student().primaryCareer, termCode: "1273" } }), null);
  assert.equal(getUwPrimaryTerm({}), null);
});

test("missing, conflicting, duplicate and oversized current programs never fall back to historical programs", () => {
  for (const mutate of [
    (s: ReturnType<typeof student>) => { s.academicObjective.academicObjectiveTerms.pop(); },
    (s: ReturnType<typeof student>) => { s.academicObjective.academicObjectiveTerms.push(s.academicObjective.academicObjectiveTerms[1]); },
    (s: ReturnType<typeof student>) => { s.academicObjective.academicObjectiveTerms[1].studentPrograms = Array.from({ length: 31 }, () => program("Too many")); },
  ]) {
    const input = student(); mutate(input);
    const summary = scope(normalizeUwStudentInfo(input, context), "summary").records[0];
    assert.ok(summary.kind === "student_summary");
    assert.deepEqual(summary.programNames, []); assert.equal(summary.expectedGraduationTerm, null);
  }
  const conflict = student();
  conflict.academicObjective.academicObjectiveTerms[1].studentPrograms[1].expectedGraduationTerm.code = "1294";
  const summary = scope(normalizeUwStudentInfo(conflict, context), "summary").records[0];
  assert.ok(summary.kind === "student_summary"); assert.equal(summary.expectedGraduationTerm, null);
});

test("holds and advisors establish empty coverage only for explicit empty recognized arrays", () => {
  const empty = normalizeUwStudentInfo(student(), context);
  for (const name of ["holds", "advisors"]) {
    assert.equal(scope(empty, name).status, "complete");
    assert.equal(scope(empty, name).completeness, "complete");
  }
  const input = student();
  input.enrollmentImpacts.holds = [{ blocksEnrollment: false, title: "DO_NOT_COPY_HOLD" }];
  input.studentAdvisorRelationships = [{ name: "DO_NOT_COPY_ADVISOR" }];
  const unknown = normalizeUwStudentInfo(input, context);
  for (const name of ["holds", "advisors"]) {
    assert.equal(scope(unknown, name).status, "partial");
    assert.equal(scope(unknown, name).completeness, "unknown");
    assert.deepEqual(scope(unknown, name).records, []);
  }
  assert.equal(JSON.stringify(unknown).includes("DO_NOT_COPY"), false);
  for (const invalid of [{}, { primaryCareer: null }, { ...student(), enrollmentImpacts: null, studentAdvisorRelationships: null }, { ...student(), primaryCareer: { ...student().primaryCareer, programName: "x".repeat(101) } }]) {
    const result = normalizeUwStudentInfo(invalid, context);
    assert.notEqual(scope(result, "holds").status, "complete");
    assert.notEqual(scope(result, "advisors").status, "complete");
  }
});

test("appointment epoch milliseconds remain exact across DST and IDs are stable without identities", () => {
  const input = student();
  const dates = ["2026-03-08T01:30:00-06:00", "2026-03-08T03:30:00-05:00", "2026-11-01T01:30:00-05:00", "2026-11-01T01:30:00-06:00"];
  input.enrollmentImpacts.registrationAppointments = dates.map((date) => appointment(Date.parse(date)));
  const result = scope(normalizeUwStudentInfo(input, context), "appointments");
  assert.equal(result.status, "complete");
  assert.deepEqual(result.records.map((row) => row.kind === "appointment" ? row.startsAt : null), ["2026-03-08T07:30:00.000Z", "2026-03-08T08:30:00.000Z", "2026-11-01T06:30:00.000Z", "2026-11-01T07:30:00.000Z"]);
  assert.ok(result.records.every((row) => row.kind === "appointment" && row.endsAt === null));
  assert.equal(new Set(result.records.map((row) => row.id)).size, 4);
  input.enrollmentImpacts.registrationAppointments.push(input.enrollmentImpacts.registrationAppointments[0]);
  assert.deepEqual(scope(normalizeUwStudentInfo(input, context), "appointments").records, result.records);
});

test("malformed and bounded appointment rows preserve valid rows with partial coverage", () => {
  const input = student();
  input.enrollmentImpacts.registrationAppointments.push(...[NaN, Infinity, 1788000000, "1788000000000", Date.UTC(2100, 0, 1)].map((value) => ({ ...appointment(), registrationDateTime: value })));
  const result = scope(normalizeUwStudentInfo(input, context), "appointments");
  assert.equal(result.status, "partial"); assert.equal(result.records.length, 1);
  input.enrollmentImpacts.registrationAppointments = Array.from({ length: 501 }, () => appointment());
  assert.equal(scope(normalizeUwStudentInfo(input, context), "appointments").status, "failed");
  input.enrollmentImpacts.holds = Array.from({ length: 501 }, () => ({}));
  assert.equal(scope(normalizeUwStudentInfo(input, context), "holds").status, "failed");
  assert.throws(() => normalizeUwStudentInfo(student(), { ...context, accountScope: "public" }), /^Error: Invalid private planning capture context\.$/);
  assert.throws(() => normalizeUwStudentInfo(student(), { ...context, observedAt: "DO_NOT_COPY_INVALID" }), /^Error: Invalid private planning capture context\.$/);
});

test("unparsed holds cannot erase an earlier hold while explicit verified empty scope can", () => {
  const store = createStore(":memory:");
  try {
    const initial = scope(normalizeUwStudentInfo(student(), context), "holds");
    store.ingestPlanning({ ...initial, records: [{ kind: "hold", id: "synthetic", title: "Synthetic hold", description: "", blocksEnrollment: true, resolutionUrl: null,
      provenance: { sourceUrl: initial.sourceUrl, observedAt, scope: initial.scope } }] });
    const input = student(); input.enrollmentImpacts.holds = [{ unexpected: true }];
    store.ingestPlanning(scope(normalizeUwStudentInfo(input, { ...context, observedAt: "2026-09-26T18:01:00Z" }), "holds"));
    assert.equal(store.planningRecords().filter((row) => !row.deleted).length, 1);
    store.ingestPlanning(scope(normalizeUwStudentInfo(student(), { ...context, observedAt: "2026-09-26T18:02:00Z" }), "holds"));
    assert.equal(store.planningRecords().filter((row) => !row.deleted).length, 0);
  } finally { store.close(); }
});

test("MyUW verification is a bounded boolean structural check with no identity extraction", () => {
  const input = { person: { firstName: "Synthetic", lastName: "Student", displayName: "Synthetic Student", userName: "synthetic", sessionKey: "synthetic-key", serverName: "synthetic-server", version: "1", extra: "DO_NOT_COPY" } };
  assert.equal(verifyMyUwSession(input), true);
  for (const value of [null, {}, { person: {} }, { person: { ...input.person, userName: "" } }, { person: { ...input.person, sessionKey: "x".repeat(4097) } }, { person: { ...input.person, firstName: 2 } }]) {
    assert.equal(verifyMyUwSession(value), false);
  }
});

test("public terms corroborate labels and explicit flags without inferring past status or dates", () => {
  const result = normalizeUwPublicTerms(aggregate(), observedAt);
  assert.equal(result.status, "complete"); assert.equal(result.accountScope, "public");
  assert.equal(result.scope.key, "public-search-terms");
  assert.equal(result.records.length, 1);
  const term = result.records[0]; assert.ok(term.kind === "term");
  assert.deepEqual([term.code, term.label, term.past], ["1272", "Fall 2026", false]);
  assert.equal("beginDate" in term, false);
  const past = normalizeUwPublicTerms({ terms: [{ ...publishedTerm(), pastTerm: true }] }, "2020-01-01T00:00:00Z");
  assert.equal(past.records[0].kind === "term" && past.records[0].past, true);
  for (const altered of [{ longDescription: "Fall 2025-2026" }, { shortDescription: "2027 Fall" }, { academicYear: "2025-26" }, { termCode: "1273" }, { pastTerm: "false" }, { endDate: 0 }]) {
    assert.equal(normalizeUwPublicTerms({ terms: [{ ...publishedTerm(), ...altered }] }, observedAt).status, "failed");
  }
  assert.equal(normalizeUwPublicTerms({ terms: [] }, observedAt).status, "failed");
  assert.equal(normalizeUwPublicTerms({ terms: Array.from({ length: 101 }, () => publishedTerm()) }, observedAt).status, "failed");
  assert.equal(normalizeUwPublicTerms({ terms: [publishedTerm(), { ...publishedTerm(), pastTerm: true }] }, observedAt).records.length, 0);
});

test("subject map joins only matching aggregate 0000 rows and ambiguous or malformed names stay partial", () => {
  const map = { "266": "COMP SCI", "320": "E C E" };
  const result = normalizeUwSubjectsMap(map, aggregate(), observedAt);
  assert.equal(result.status, "complete"); assert.equal(result.scope.key, "search-subjects-map:0000");
  assert.deepEqual(result.records.map((row) => row.kind === "subject" ? [row.code, row.shortName, row.formalName] : null), [["266", "COMP SCI", "Computer Sciences"], ["320", "E C E", "Electrical and Computer Engineering"]]);
  const conflict = aggregate(); conflict.subjects["0000"].push({ subjectCode: "266", formalDescription: "Conflicting name", termCode: "0000" });
  const partial = normalizeUwSubjectsMap(map, conflict, observedAt);
  assert.equal(partial.status, "partial"); assert.deepEqual(partial.records.map((row) => row.id), ["320"]);
  assert.equal(normalizeUwSubjectsMap({ ...map, "999": "UNKNOWN" }, aggregate(), observedAt).status, "partial");
  assert.equal(normalizeUwSubjectsMap({ "266": "x".repeat(101) }, aggregate(), observedAt).status, "failed");
  assert.equal(normalizeUwSubjectsMap(map, { subjects: { "1272": aggregate().subjects["0000"] } }, observedAt).status, "failed");
  assert.equal(normalizeUwSubjectsMap({}, aggregate(), observedAt).status, "failed");
  assert.equal(normalizeUwSubjectsMap(Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [String(i), "SHORT"])), aggregate(), observedAt).status, "failed");
});
