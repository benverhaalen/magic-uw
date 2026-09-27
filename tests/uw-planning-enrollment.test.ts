import test from "node:test";
import assert from "node:assert/strict";
import { normalizeUwClassMeetings, normalizeUwCurrentEnrollment } from "../packages/connectors/src/uw-planning-enrollment";
import { planningCaptureSchema } from "@magic/contracts";
import { checkPackageConflicts } from "../packages/domain/src/planning";
import { createStore } from "@magic/storage";

const options = { accountScope: "synthetic-student", observedAt: "2026-09-26T18:00:00Z", termCode: "1272" };
const epoch = (day: string, offset: string) => Date.parse(`${day}T00:00:00${offset}`);
// UW's public frontend decodes a fixed UTC-6 epoch clock, not milliseconds from local midnight.
const wireTime = (hour: number, minute = 0) => ((hour + 6) * 60 + minute) * 60_000;
// Synthetic values in the observed wire structure; no private capture is used by these tests.
function classMeeting() {
  return {
    meetingOrExamNumber: "1", meetingType: "CLASS", meetingTimeStart: wireTime(9), meetingTimeEnd: wireTime(10),
    meetingDays: "TR" as string | null, meetingDaysList: ["TUESDAY", "THURSDAY"],
    building: { buildingName: "Synthetic Hall", buildingCode: "0000" } as { buildingName: string; buildingCode: string } | null,
    room: "100" as string | null, examDate: null as number | null,
    monday: false, tuesday: true, wednesday: false, thursday: true, friday: false, saturday: false, sunday: false,
    startDate: epoch("2026-09-02", "-05:00") as number | null, endDate: epoch("2026-12-10", "-06:00") as number | null,
  };
}
function examMeeting() {
  return { ...classMeeting(), meetingType: "EXAM", meetingDays: null, meetingDaysList: [],
    tuesday: false, thursday: false, examDate: epoch("2026-12-17", "-06:00"),
    meetingTimeStart: wireTime(19), meetingTimeEnd: wireTime(21), building: null, room: null };
}
function wireRow(classNumber = 10001) {
  const row = {
    id: "synthetic-ignored-id", termCode: "1272", subjectCode: "266", catalogNumber: "101", courseId: "synthetic-course-id",
    enrollmentClassNumber: classNumber, studentEnrollmentStatus: "E", credits: 3, isAsynchronous: false,
    packageEnrollmentStatus: { availableSeats: 0, waitlistTotal: 2, status: "CLOSED" },
    enrollmentStatus: { classUniqueId: { termCode: "1272", classNumber }, capacity: 30 },
    sections: [{ subjectCode: "266", courseCatalogNumber: " 101 ", courseId: "synthetic-course-id", classNumber: String(classNumber),
      classSection: "001", classSSRComponent: "LEC", enrollmentStatus: "E", numCreditsTaken: 3, isAuditing: false, grade: null as string | null }],
    classMeetings: [classMeeting(), examMeeting()], nestedClassMeetings: [classMeeting(), examMeeting()],
    details: { termCode: "1272", courseId: "synthetic-course-id", catalogNumber: "101", subject: { termCode: "1272", subjectCode: "266" },
      title: "Synthetic introduction", description: "A synthetic catalog description.", minimumCredits: 3, maximumCredits: 3,
      enrollmentPrerequisites: "Consent of instructor", typicallyOffered: "Fall",
      coreGeneralEducation: null, generalEd: null, ethnicStudies: null,
      breadths: [{ code: "N", description: "Natural science" }], levels: [{ code: "E", description: "Elementary" }] },
  };
  return row;
}
function syncMeetings(row: ReturnType<typeof wireRow>) { row.classMeetings = structuredClone(row.nestedClassMeetings); }
function packages(input: unknown) {
  return normalizeUwCurrentEnrollment(input, options)[0].records.filter((record) => record.kind === "enrollment_package");
}

test("observed E status establishes enrollment independently of closed seat availability", () => {
  const captures = normalizeUwCurrentEnrollment([wireRow()], options);
  assert.ok(captures.every((capture) => planningCaptureSchema.safeParse(capture).success));
  const pkg = packages([wireRow()])[0];
  assert.equal(pkg.enrollmentState, "enrolled"); assert.equal(pkg.status, "closed");
  assert.equal(pkg.seatsAvailable, 0); assert.equal(pkg.capacity, 30);
  assert.equal(captures[0].status, "complete"); assert.equal(pkg.meetingsComplete, true);
  assert.deepEqual(captures.map((capture) => capture.scope), [
    { kind: "enrollment_term", key: "1272" },
    { kind: "degree_plan", key: "current-enrollment:1272" },
    { kind: "catalog_term", key: "current-enrollment:1272" },
  ]);
  const history = captures[1].records[0];
  assert.equal(history.kind === "course_history" && history.state, "in_progress");
  assert.equal(captures[1].completeness, "partial");
  const catalog = captures[2].records[0];
  assert.equal(catalog.kind === "catalog_course" && catalog.prerequisite, null);
});

test("Chicago midnight dates cross DST and exam days come from the actual exam date", () => {
  const pkg = packages([wireRow()])[0], [meeting, exam] = pkg.meetings;
  assert.deepEqual(meeting.days, [2, 4]); assert.equal(meeting.startMinute, 540);
  assert.equal(meeting.startDate, "2026-09-02"); assert.equal(meeting.endDate, "2026-12-10");
  assert.equal(exam.kind, "exam"); assert.equal(exam.startDate, "2026-12-17");
  assert.equal(exam.endDate, "2026-12-17"); assert.deepEqual(exam.days, [4]);
  assert.equal(exam.startMinute, 1140); assert.equal(exam.mode, "scheduled");
  assert.equal(checkPackageConflicts(pkg, []).status, "clear");
});

test("UW clock decoding agrees with public frontend arithmetic, including encoded values above 24 hours", () => {
  // The public package counterexample that exposed the offset: 83,100,000 -> 17:05,
  // 90,300,000 -> 19:05. Dates and other fields here remain synthetic.
  const row = wireRow();
  row.nestedClassMeetings[0].meetingTimeStart = 68_400_000;
  row.nestedClassMeetings[0].meetingTimeEnd = 81_300_000;
  row.nestedClassMeetings[1].meetingTimeStart = 83_100_000;
  row.nestedClassMeetings[1].meetingTimeEnd = 90_300_000;
  syncMeetings(row);
  const schedule = normalizeUwClassMeetings(row);
  assert.equal(schedule.complete, true);
  assert.deepEqual(schedule.meetings.map((meeting) => [meeting.startMinute, meeting.endMinute]), [[780, 995], [1025, 1145]]);
  const midnight = { ...classMeeting(), meetingTimeStart: wireTime(23), meetingTimeEnd: wireTime(24) };
  assert.deepEqual(normalizeUwClassMeetings({ isAsynchronous: false, classMeetings: [midnight], nestedClassMeetings: [midnight] }).meetings.map((meeting) => [meeting.startMinute, meeting.endMinute]), [[1380, 1440]]);
  for (const times of [[wireTime(0) - 1, wireTime(1)], [wireTime(23), wireTime(24) + 60_000], [wireTime(23), wireTime(1)]]) {
    const meeting = { ...classMeeting(), meetingTimeStart: times[0], meetingTimeEnd: times[1] };
    assert.equal(normalizeUwClassMeetings({ isAsynchronous: false, classMeetings: [meeting], nestedClassMeetings: [meeting] }).complete, false);
  }
});

test("shared meeting projection needs no course identity and rejects missing or unbounded evidence", () => {
  const row = wireRow();
  const expected = normalizeUwClassMeetings(row);
  assert.deepEqual(normalizeUwClassMeetings({ isAsynchronous: row.isAsynchronous, classMeetings: row.classMeetings, nestedClassMeetings: row.nestedClassMeetings }), expected);
  for (const input of [null, {}, { ...row, isAsynchronous: undefined }, { ...row, nestedClassMeetings: Array(101).fill(classMeeting()) }]) {
    const result = normalizeUwClassMeetings(input);
    assert.equal(result.complete, false);
    assert.deepEqual(result.meetings.map((meeting) => meeting.mode), ["unknown"]);
  }
});

test("dropped current rows retain dropped history without becoming enrolled or completed", () => {
  const row = wireRow(); row.studentEnrollmentStatus = "D"; row.sections[0].enrollmentStatus = "D";
  const [enrollment, history] = normalizeUwCurrentEnrollment([row], options);
  assert.equal(enrollment.records.length, 0); assert.equal(enrollment.status, "complete");
  assert.equal(history.records[0].kind === "course_history" && history.records[0].state, "dropped");
});

test("unknown or contradictory status cannot erase a previous enrolled package", () => {
  const store = createStore(":memory:");
  try {
    normalizeUwCurrentEnrollment([wireRow()], options).forEach((capture) => store.ingestPlanning(capture));
    for (const mutation of [
      (row: ReturnType<typeof wireRow>) => { row.studentEnrollmentStatus = "WAITLISTED"; },
      (row: ReturnType<typeof wireRow>) => { row.sections[0].enrollmentStatus = "D"; },
      (row: ReturnType<typeof wireRow>) => { row.termCode = "1274"; },
      (row: ReturnType<typeof wireRow>) => { row.sections[0].subjectCode = "999"; },
    ]) {
      const row = wireRow(); mutation(row);
      const capture = normalizeUwCurrentEnrollment([row], { ...options, observedAt: "2026-09-26T19:00:00Z" })[0];
      assert.equal(capture.status, "partial"); assert.equal(capture.records.length, 0);
      store.ingestPlanning(capture);
      assert.equal(store.planningRecords().filter((record) => !record.deleted && record.kind === "enrollment_package").length, 1);
    }
  } finally { store.close(); }
});

test("complete empty array clears only this term's enrollment, never full historical evidence", () => {
  const store = createStore(":memory:");
  try {
    const prior = normalizeUwCurrentEnrollment([wireRow()], options);
    prior.forEach((capture) => store.ingestPlanning(capture));
    const other = structuredClone(prior[0]); other.scope.key = "1274";
    other.records.forEach((record) => { record.provenance.scope.key = "1274"; if (record.kind === "enrollment_package") record.termCode = "1274"; });
    store.ingestPlanning(other);
    normalizeUwCurrentEnrollment([], { ...options, observedAt: "2026-09-26T19:00:00Z" }).forEach((capture) => store.ingestPlanning(capture));
    const remaining = store.planningRecords().filter((record) => !record.deleted);
    assert.deepEqual(remaining.filter((record) => record.kind === "enrollment_package").map((record) => record.termCode), ["1274"]);
    assert.equal(remaining.filter((record) => record.kind === "course_history").length, 1);
  } finally { store.close(); }
});

test("missing dates, inconsistent weekday representations and invalid times remain unknown", () => {
  const mutations = [
    (m: ReturnType<typeof classMeeting>) => { m.startDate = null; },
    (m: ReturnType<typeof classMeeting>) => { m.startDate = Date.parse("2026-09-02T00:00:00Z"); },
    (m: ReturnType<typeof classMeeting>) => { m.meetingDays = "TX"; },
    (m: ReturnType<typeof classMeeting>) => { m.thursday = false; },
    (m: ReturnType<typeof classMeeting>) => { m.meetingTimeStart += 1; },
    (m: ReturnType<typeof classMeeting>) => { m.meetingTimeEnd = m.meetingTimeStart; },
    (m: ReturnType<typeof classMeeting>) => { m.startDate = epoch("2026-12-20", "-06:00"); },
  ];
  for (const mutation of mutations) {
    const row = wireRow(); mutation(row.nestedClassMeetings[0]); syncMeetings(row);
    const pkg = packages([row])[0];
    assert.equal(pkg.meetingsComplete, false); assert.equal(pkg.meetings[0].mode, "unknown");
    assert.equal(checkPackageConflicts(pkg, []).status, "unknown");
  }
});

test("asynchronous classes keep scheduled exams; online-only does not establish asynchronous", () => {
  const row = wireRow(); row.isAsynchronous = true;
  row.nestedClassMeetings[0] = { ...classMeeting(), meetingDays: null, meetingDaysList: [], tuesday: false, thursday: false };
  syncMeetings(row);
  const pkg = packages([row])[0];
  assert.equal(pkg.meetings[0].mode, "asynchronous"); assert.equal(pkg.meetings[1].mode, "scheduled");
  assert.equal(pkg.meetingsComplete, true);
  const none = wireRow(); none.classMeetings = []; none.nestedClassMeetings = [];
  assert.equal(packages([{ ...none, onlineOnly: true }])[0].meetingsComplete, false);
  none.isAsynchronous = true;
  assert.equal(packages([none])[0].meetings[0].mode, "asynchronous");
});

test("meeting numbers may repeat across related sections and incomplete mirrored arrays stay unknown", () => {
  const row = wireRow();
  row.nestedClassMeetings.push({ ...classMeeting(), meetingTimeStart: wireTime(11), meetingTimeEnd: wireTime(12) }); syncMeetings(row);
  assert.equal(packages([row])[0].meetingsComplete, true);
  row.classMeetings.pop();
  const pkg = packages([row])[0]; assert.equal(pkg.meetingsComplete, false);
  assert.equal(checkPackageConflicts(pkg, []).status, "unknown");
});

test("malformed asynchronous dates and malformed meeting rows cannot abort the full capture", () => {
  const row = wireRow(); row.isAsynchronous = true;
  row.nestedClassMeetings[0] = { ...classMeeting(), meetingDays: null, meetingDaysList: [], tuesday: false, thursday: false,
    startDate: epoch("2026-12-20", "-06:00") };
  syncMeetings(row);
  assert.equal(packages([row])[0].meetingsComplete, false);
  const raw = { ...wireRow(), nestedClassMeetings: [null], classMeetings: [null] };
  const capture = normalizeUwCurrentEnrollment([raw, wireRow(10002)], options)[0];
  assert.equal(capture.records.length, 2); assert.equal(capture.status, "partial");
});

test("conflicting catalog identities are omitted and do not change enrollment identity", () => {
  const row = wireRow(); row.details.courseId = "different-synthetic-course-id";
  const [enrollment, , catalog] = normalizeUwCurrentEnrollment([row], options);
  assert.equal(enrollment.records.length, 1); assert.equal(catalog.records.length, 0);
  assert.equal(enrollment.status, "complete");
  assert.equal(enrollment.records[0].kind === "enrollment_package" && enrollment.records[0].courseKey, "uw:266:101");
  assert.ok(catalog.diagnostics.some((diagnostic) => diagnostic.code === "unavailable_catalog_details"));
});

test("duplicate packages and malformed rows are isolated, never promoted to complete", () => {
  const row = wireRow();
  const capture = normalizeUwCurrentEnrollment([row, structuredClone(row), wireRow(10002), { termCode: "1272" }], options)[0];
  assert.equal(capture.status, "partial"); assert.equal(capture.records.length, 1);
  for (const input of [null, { rows: [] }, "login", Array(501).fill(row)]) {
    const failed = normalizeUwCurrentEnrollment(input, options);
    assert.ok(failed.every((capture) => capture.status === "failed" && capture.records.length === 0));
  }
  assert.throws(() => normalizeUwCurrentEnrollment([], { ...options, accountScope: "public" }));
});

test("unobserved identity and free-form auxiliary fields are excluded from normalized records", () => {
  const row = { ...wireRow(), person: { netid: "synthetic-secret-marker" }, instructorProvidedClassDetails: { instructorDescription: "synthetic-secret-marker" } };
  const captures = normalizeUwCurrentEnrollment([row], options);
  assert.equal(JSON.stringify(captures).includes("synthetic-secret-marker"), false);
  assert.ok(captures.every((capture) => capture.sourceUrl === "https://enroll.wisc.edu/api/enroll/v1/current/1272"));
});

test("auditing or grade-bearing current rows cannot silently become qualifying in-progress history", () => {
  for (const auditing of [false, true]) {
    const row = wireRow(); row.sections[0].isAuditing = auditing; if (!auditing) row.sections[0].grade = "A";
    const captures = normalizeUwCurrentEnrollment([row], options);
    const history = captures[1].records[0];
    assert.equal(history.kind === "course_history" && history.state, "unknown");
    assert.equal(history.kind === "course_history" && history.grade, null);
    assert.equal(captures[0].status, "complete");
    assert.equal(captures[0].diagnostics.length, 0);
  }
});
