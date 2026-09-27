import test from "node:test";
import assert from "node:assert/strict";
import { planningCaptureSchema } from "@magic/contracts";
import { createStore } from "@magic/storage";
import { buildUwPlanningRequest } from "../packages/connectors/src/uw-planning-http";
import {
  buildUwPublicCourseSearchRequest, buildUwPublicEnrollmentPackagesRequest,
  normalizeUwPublicCourseSearch, normalizeUwPublicEnrollmentPackages,
} from "../packages/connectors/src/uw-planning-catalog";

const observedAt = "2026-09-26T20:00:00Z";
const searchOptions = { termCode: "1272", subjectCode: "266", observedAt };
const course = { termCode: "1272", subjectCode: "266", courseId: "001001", catalogNumber: "101" };
const packageOptions = { course, observedAt };
// Synthetic fields in the observed public wire structure. No saved live fixture is committed.
function searchRow(id = course.courseId) {
  return { termCode: "1272", courseId: id, catalogNumber: "101", subject: { termCode: "1272", subjectCode: "266" },
    title: "Synthetic course", description: "A synthetic public course.", minimumCredits: 3, maximumCredits: 3,
    enrollmentPrerequisites: "Consent of instructor", typicallyOffered: "Fall",
    coreGeneralEducation: null, generalEd: null, ethnicStudies: null,
    breadths: [{ code: "N", description: "Natural Science" }], levels: [{ code: "E", description: "Elementary" }],
    unknownSecret: "discard-this-value" };
}
function meeting() {
  return { meetingOrExamNumber: "1", meetingType: "CLASS", meetingTimeStart: 19 * 3_600_000, meetingTimeEnd: 20 * 3_600_000,
    meetingDays: "TR" as string | null, meetingDaysList: ["TUESDAY", "THURSDAY"],
    building: { buildingName: "Synthetic Hall" }, room: "101", examDate: null as number | null,
    monday: false, tuesday: true, wednesday: false, thursday: true, friday: false, saturday: false, sunday: false,
    startDate: Date.parse("2026-09-02T00:00:00-05:00"), endDate: Date.parse("2026-12-10T00:00:00-06:00") };
}
function packageRow(id = "12345") {
  return { ...course, id, docId: `1272-A1-266-101-${id}`, enrollmentClassNumber: Number(id), published: true,
    sections: [{ classUniqueId: { termCode: "1272", classNumber: Number(id) },
      subject: { termCode: "1272", subjectCode: "266" }, courseId: course.courseId, catalogNumber: "101",
      type: "LEC", sectionNumber: "001", published: true, active: true, topic: null as { id: number } | null,
      instructors: [{ name: { first: "Synthetic", middle: null, last: "Instructor" },
        email: "discard-this-email", netid: "discard-this-netid", emplid: "discard-this-id" }] }],
    packageEnrollmentStatus: { availableSeats: 2, waitlistTotal: 0, status: "OPEN" },
    enrollmentStatus: { classUniqueId: { termCode: "1272", classNumber: Number(id) }, capacity: 30 },
    isAsynchronous: false, classMeetings: [meeting()], nestedClassMeetings: [meeting()],
    unknownSecret: "discard-this-value" };
}
const envelope = (hits: unknown[], found = hits.length) => ({ success: true, found, hits, message: null });

test("typed query builders compile observed fixed search filters and course IDs, including topic suffixes", () => {
  const request = buildUwPublicCourseSearchRequest({ ...searchOptions, query: "  ", enrollmentStatus: ["OPEN", "OPEN", "WAITLISTED"] });
  const descriptor = buildUwPlanningRequest(request);
  assert.equal(descriptor.method, "POST"); assert.equal(descriptor.url, "https://public.enroll.wisc.edu/api/search/v1");
  assert.deepEqual(JSON.parse(descriptor.body!), {
    selectedTerm: "1272", queryString: "*", page: 1, pageSize: 50, sortOrder: "CATALOG_NUMBER",
    filters: [{ term: { "subject.subjectCode": "266" } },
      { has_child: { type: "enrollmentPackage", query: { match: { "packageEnrollmentStatus.status": "OPEN WAITLISTED" } } } }],
  });
  const packageRequest = buildUwPublicEnrollmentPackagesRequest({ ...course, courseId: "001001.2" });
  assert.equal(buildUwPlanningRequest(packageRequest).url, "https://public.enroll.wisc.edu/api/search/v1/enrollmentPackages/1272/266/001001.2");
  assert.throws(() => buildUwPublicEnrollmentPackagesRequest({ ...course, courseId: "../101" }));
  assert.throws(() => buildUwPublicCourseSearchRequest({ ...searchOptions, page: 21 }));
  assert.throws(() => buildUwPublicCourseSearchRequest({ ...searchOptions, filters: { script: "arbitrary" } } as any));
});

test("search emits bounded public projections with source IDs and no inferred prerequisites", () => {
  const result = normalizeUwPublicCourseSearch(envelope([searchRow(), { ...searchRow("001001.2"), title: "Synthetic topic" }]), searchOptions);
  assert.equal(result.capture.status, "partial"); assert.equal(result.found, 2); assert.equal(result.nextPage, null);
  assert.equal(result.courses.length, 2); assert.equal(result.capture.records.length, 2);
  assert.equal(new Set(result.capture.records.map((row) => row.id)).size, 2);
  for (const record of result.capture.records) {
    assert.equal(record.kind, "catalog_course");
    if (record.kind === "catalog_course") { assert.equal(record.courseKey, "uw:266:101"); assert.equal(record.prerequisite, null); }
  }
  assert.equal(result.capture.accountScope, "public"); assert.equal(result.capture.source, "uw_public");
  assert.ok(!JSON.stringify(result).includes("discard-this"));
  assert.ok(planningCaptureSchema.safeParse(result.capture).success);
});

test("search page controls preserve scope across pages, reject mismatched identities and never claim full coverage", () => {
  const fifty = Array.from({ length: 50 }, (_, i) => searchRow(String(1000 + i)));
  const first = normalizeUwPublicCourseSearch(envelope(fifty, 51), searchOptions);
  const second = normalizeUwPublicCourseSearch(envelope([searchRow("2000")], 51), { ...searchOptions, page: 2 });
  assert.equal(first.nextPage, 2); assert.equal(second.nextPage, null);
  assert.deepEqual(first.capture.scope, second.capture.scope);
  const wrongSubject = searchRow(); wrongSubject.subject.subjectCode = "600";
  const wrongTerm = searchRow("2000"); wrongTerm.termCode = "1274";
  const duplicate = searchRow("3000");
  const result = normalizeUwPublicCourseSearch(envelope([wrongSubject, wrongTerm, duplicate, duplicate]), searchOptions);
  assert.equal(result.capture.records.length, 0); assert.equal(result.capture.status, "partial");
  assert.equal(normalizeUwPublicCourseSearch(envelope([]), searchOptions).capture.status, "partial");
  assert.equal(normalizeUwPublicCourseSearch(envelope([], 1), searchOptions).capture.status, "failed");
  assert.equal(normalizeUwPublicCourseSearch(envelope(fifty, 1001), { ...searchOptions, page: 20 }).nextPage, null);
});

test("search failures and field bounds stay sanitized and cannot become empty complete results", () => {
  for (const value of [null, [], { success: false, message: "discard-this-error", found: 0, hits: [] },
    envelope(Array(51).fill(searchRow())), envelope([], -1)]) {
    const result = normalizeUwPublicCourseSearch(value, searchOptions);
    assert.equal(result.capture.status, "failed"); assert.equal(result.found, null);
    assert.ok(!JSON.stringify(result).includes("discard-this"));
  }
  for (const row of [{ ...searchRow(), title: "x".repeat(501) }, { ...searchRow(), minimumCredits: 4, maximumCredits: 3 }])
    assert.equal(normalizeUwPublicCourseSearch(envelope([row]), searchOptions).capture.records.length, 0);
});

test("public packages are available evidence, with verified Chicago dates and source clock decoding", () => {
  const result = normalizeUwPublicEnrollmentPackages([packageRow()], packageOptions);
  assert.equal(result.status, "complete"); assert.equal(result.scope.key, "public-packages:1272:266:001001");
  const record = result.records[0]; assert.equal(record.kind, "enrollment_package");
  if (record.kind !== "enrollment_package") return;
  assert.equal(record.enrollmentState, "available"); assert.equal(record.status, "open");
  assert.equal(record.seatsAvailable, 2); assert.equal(record.capacity, 30); assert.equal(record.waitlistCount, 0);
  assert.deepEqual(record.sections, ["LEC 001"]); assert.deepEqual(record.instructorNames, ["Synthetic Instructor"]);
  assert.equal(record.meetingsComplete, true); assert.equal(record.meetings[0].startMinute, 13 * 60);
  assert.equal(record.meetings[0].startDate, "2026-09-02"); assert.equal(record.meetings[0].endDate, "2026-12-10");
  assert.ok(!JSON.stringify(result).includes("discard-this")); assert.ok(planningCaptureSchema.safeParse(result).success);
});

test("topic packages require corroborated base section ID and explicit topic number", () => {
  const row = packageRow(); row.courseId = "001001.2"; row.sections[0].topic = { id: 2 };
  const topicOptions = { ...packageOptions, course: { ...course, courseId: "001001.2" } };
  assert.equal(normalizeUwPublicEnrollmentPackages([row], topicOptions).records.length, 1);
  row.sections[0].topic = { id: 3 };
  const invalid = normalizeUwPublicEnrollmentPackages([row], topicOptions);
  assert.equal(invalid.status, "partial"); assert.equal(invalid.records.length, 0);
});

test("mismatched course, sections, publication and duplicate document IDs are omitted conservatively", () => {
  for (const change of [
    (row: ReturnType<typeof packageRow>) => { row.termCode = "1274"; },
    (row: ReturnType<typeof packageRow>) => { row.courseId = "001002"; },
    (row: ReturnType<typeof packageRow>) => { row.sections[0].subject.subjectCode = "600"; },
    (row: ReturnType<typeof packageRow>) => { row.published = false; },
    (row: ReturnType<typeof packageRow>) => { row.sections[0].active = false; },
    (row: ReturnType<typeof packageRow>) => { row.sections.push(structuredClone(row.sections[0])); },
  ]) {
    const row = packageRow(); change(row);
    const result = normalizeUwPublicEnrollmentPackages([row], packageOptions);
    assert.equal(result.status, "partial"); assert.equal(result.records.length, 0);
  }
  assert.equal(normalizeUwPublicEnrollmentPackages([packageRow(), packageRow()], packageOptions).records.length, 0);
});

test("unknown seat fields and incomplete meetings preserve package evidence without false clearance", () => {
  const row = packageRow(); row.packageEnrollmentStatus.status = "UNRECOGNIZED";
  row.enrollmentStatus.classUniqueId.classNumber = 999; row.nestedClassMeetings[0].meetingDaysList = [];
  const result = normalizeUwPublicEnrollmentPackages([row], packageOptions);
  assert.equal(result.status, "partial");
  const record = result.records[0]; assert.equal(record.kind, "enrollment_package");
  if (record.kind !== "enrollment_package") return;
  assert.equal(record.status, "unknown"); assert.equal(record.seatsAvailable, null); assert.equal(record.capacity, null);
  assert.equal(record.meetingsComplete, false); assert.ok(record.meetings.some((row) => row.mode === "unknown"));
});

test("package bounds fail safely; complete empty enumeration affects only the exact selected course", () => {
  const store = createStore(":memory:");
  try {
    const initial = normalizeUwPublicEnrollmentPackages([packageRow()], packageOptions);
    store.ingestPlanning(initial);
    for (const value of [{ error: "discard-this-error" }, Array(501).fill(packageRow())]) {
      const failed = normalizeUwPublicEnrollmentPackages(value, { ...packageOptions, observedAt: "2026-09-26T21:00:00Z" });
      assert.equal(failed.status, "failed"); store.ingestPlanning(failed);
      assert.equal(store.planningRecords().filter((record) => !record.deleted).length, 1);
    }
    store.ingestPlanning(normalizeUwPublicEnrollmentPackages([], { ...packageOptions,
      course: { ...course, courseId: "001002" }, observedAt: "2026-09-26T22:00:00Z" }));
    assert.equal(store.planningRecords().filter((record) => !record.deleted).length, 1);
    const empty = normalizeUwPublicEnrollmentPackages([], { ...packageOptions, observedAt: "2026-09-26T23:00:00Z" });
    assert.equal(empty.status, "complete"); store.ingestPlanning(empty);
    assert.equal(store.planningRecords().filter((record) => !record.deleted).length, 0);
  } finally { store.close(); }
});

test("normal core commands load search then sections; failed refresh preserves records and invalidates seats", async () => {
  const { createCore } = await import("@magic/core");
  const { captureBatchSchema } = await import("@magic/contracts");
  const fixture = (await import("../fixtures/course.json")).default;
  const store = createStore(":memory:");
  let fail = false, tick = Date.parse(observedAt);
  const core = createCore(store, { fixture: captureBatchSchema.parse(fixture), now: () => new Date(tick), planningHttp: { async read(request) {
    if (fail) return { status: "error", code: "network_failed", bytes: 0, elapsedMs: 0, schemaVerified: false };
    return { status: "ok", data: request.kind === "public-search" ? envelope([searchRow()]) : [packageRow()], bytes: 0, elapsedMs: 0, schemaVerified: false };
  } } });
  try {
    const searched = await core.execute({ type: "planning-search", termCode: "1272", subjectCode: "266", page: 1 });
    const record = searched.snapshot.planning!.records.find(r => r.kind === "catalog_course")!;
    tick += 1000;
    const sections = await core.execute({ type: "planning-sections", recordId: record.localId });
    assert.equal(sections.snapshot.planning!.records.filter(r => r.kind === "enrollment_package").length, 1);
    assert.ok(sections.snapshot.planning!.sources.some(s => s.scope.key.startsWith("public-packages:") && s.status === "complete"));
    fail = true; tick += 1000;
    const failed = await core.execute({ type: "planning-sections", recordId: record.localId });
    assert.equal(failed.snapshot.planning!.records.filter(r => r.kind === "enrollment_package" && !r.deleted).length, 1);
    assert.ok(failed.snapshot.planning!.sources.some(s => s.scope.key.startsWith("public-packages:") && s.status === "failed"));
    assert.match(failed.message!, /need verification/);
    assert.equal(failed.snapshot.resources.length, 0);
  } finally { await core.close(); }
});

test("a late public search cannot restore planning data after local purge", async () => {
  const { createCore } = await import("@magic/core");
  const { captureBatchSchema } = await import("@magic/contracts");
  const fixture = (await import("../fixtures/course.json")).default;
  const store = createStore(":memory:");
  let finish!: (value: any) => void;
  const core = createCore(store, { fixture: captureBatchSchema.parse(fixture), planningHttp: { read: () => new Promise(resolve => { finish = resolve; }) } });
  try {
    const read = core.execute({ type: "planning-search", termCode: "1272", subjectCode: "266", page: 1 });
    const rejected = assert.rejects(read);
    await core.execute({ type: "purge", confirmation: "DELETE LOCAL DATA" });
    finish({ status: "ok", data: envelope([searchRow()]), bytes: 0, elapsedMs: 0, schemaVerified: false });
    await rejected;
    assert.equal(store.planningRecords().length, 0);
  } finally { await core.close(); }
});
