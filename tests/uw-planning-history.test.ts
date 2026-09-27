import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "@magic/storage";
import {
  parseUwDegreePlanHistory,
  pullUwDegreePlanHistory,
} from "../packages/connectors/src/uw-planning-history";
import type {
  UwPlanningReadRequest,
  UwPlanningReadResult,
} from "../packages/connectors/src/uw-planning-http";

const context = {
  accountScope: "opaque-local-account",
  observedAt: "2026-09-26T12:00:00Z",
  planId: "123",
};
const row = (extra: Record<string, unknown> = {}) => ({
  id: null,
  courseId: "010101",
  termCode: null,
  topicId: 0,
  title: "Synthetic title",
  subjectCode: "266",
  catalogNumber: "300",
  credits: 3,
  creditMin: 3,
  creditMax: 3,
  grade: "AB",
  classNumber: "12345",
  courseOrder: 0,
  honors: null,
  waitlist: null,
  relatedClassNumber1: null,
  relatedClassNumber2: null,
  classPermissionNumber: null,
  sessionCode: null,
  lastModified: null,
  validationResults: [],
  enrollmentResults: [],
  pendingEnrollments: [],
  details: null,
  packageDetails: null,
  classMeetings: null,
  enrollmentOptions: null,
  packageEnrollmentStatus: null,
  creditRange: "3",
  studentEnrollmentStatus: "Enrolled",
  subjectDescription: "COMP SCI",
  ...extra,
});
const groups = (courses: unknown[], termCode = "1264") => [
  { termCode, courses, totalCredits: "3" },
];
const ok = (data: unknown): UwPlanningReadResult => ({
  status: "ok",
  data,
  bytes: 10,
  elapsedMs: 1,
  schemaVerified: false,
});

test("degree history preserves exact course keys, observed grades/credits, states, and bounded provenance", () => {
  const input = groups([
    row(),
    row({ catalogNumber: "301", grade: "IP" }),
    row({ catalogNumber: "302", grade: "DR" }),
    row({ catalogNumber: "303", grade: "W" }),
    row({ catalogNumber: "304", grade: null }),
    row({
      catalogNumber: "305",
      id: 7,
      grade: null,
      studentEnrollmentStatus: "NOTOFFERED",
      credits: null,
    }),
    row({
      catalogNumber: "306",
      grade: null,
      studentEnrollmentStatus: "Transfer",
      credits: 4,
    }),
    row({
      catalogNumber: "007",
      subjectCode: "0266",
      grade: "A",
      credits: 1.5,
    }),
  ]);
  const result = parseUwDegreePlanHistory(input, context);
  assert.equal(result.status, "complete");
  assert.equal(result.completeness, "complete");
  assert.deepEqual(
    result.records.map(
      (record) => record.kind === "course_history" && record.state,
    ),
    [
      "completed",
      "in_progress",
      "dropped",
      "withdrawn",
      "in_progress",
      "planned",
      "completed",
      "completed",
    ],
  );
  const records = result.records.filter(
    (record) => record.kind === "course_history",
  );
  assert.deepEqual(
    records.map((record) => record.grade),
    ["AB", "IP", "DR", "W", null, null, null, "A"],
  );
  assert.equal(records[5].credits, null);
  assert.equal(records[6].gpaEligible, false);
  assert.equal(records[0].gpaEligible, null);
  assert.equal(records[7].courseKey, "uw:0266:007");
  assert.equal(records[7].credits, 1.5);
  assert.equal(records[0].termCode, "1264");
  assert.equal(result.scope.key, "primary");
  assert.equal(
    records[0].provenance.sourceUrl,
    "https://enroll.wisc.edu/api/planner/v1/degreePlan/123/termcourses",
  );
});

test("private list identities and arbitrary nested fields never enter normalized records or diagnostics", async () => {
  const privateMarker = "PRIVATE_IDENTITY";
  const requests: UwPlanningReadRequest[] = [];
  const result = await pullUwDegreePlanHistory(
    {
      async read(request) {
        requests.push(request);
        return request.kind === "degree-plans"
          ? ok([
              {
                roadmapId: 123,
                primary: true,
                pvi: privateMarker,
                emplid: privateMarker,
                name: privateMarker,
                lastModified: 0,
              },
            ])
          : ok(
              groups([
                row({
                  title: privateMarker,
                  enrollmentResults: [{ studentName: privateMarker }],
                  classPermissionNumber: privateMarker,
                }),
              ]),
            );
      },
    },
    context,
  );
  assert.deepEqual(requests, [
    { kind: "degree-plans" },
    { kind: "degree-plan-detail", planId: "123" },
  ]);
  assert.equal(result.status, "complete");
  assert.equal(JSON.stringify(result).includes(privateMarker), false);
  assert.equal(result.accountScope, context.accountScope);
});

test("unidentified transfers, changed shapes and unknown attempt states cannot establish complete coverage", () => {
  const result = parseUwDegreePlanHistory(
    [
      ...groups([
        row(),
        row({
          subjectCode: null,
          grade: null,
          studentEnrollmentStatus: "Transfer",
        }),
        row({ catalogNumber: "301", grade: "I" }),
        row({
          catalogNumber: "302",
          grade: null,
          studentEnrollmentStatus: "Waitlisted",
        }),
        row({ catalogNumber: "303", credits: "PRIVATE_REJECTED_VALUE" }),
        row({ catalogNumber: "304", termCode: "1272" }),
      ]),
      { termCode: "not-a-term", courses: [row()] },
    ],
    context,
  );
  assert.equal(result.status, "partial");
  assert.equal(result.records.length, 3);
  assert.deepEqual(
    result.records.map(
      (record) => record.kind === "course_history" && record.state,
    ),
    ["completed", "unknown", "unknown"],
  );
  assert.equal(
    JSON.stringify(result).includes("PRIVATE_REJECTED_VALUE"),
    false,
  );
  assert.deepEqual(
    new Set(result.diagnostics.map((item) => item.code)),
    new Set([
      "degree_history_unverified_rows",
      "degree_history_unidentified_courses",
      "degree_history_unknown_states",
    ]),
  );
  assert.equal(
    parseUwDegreePlanHistory({ courses: [] }, context).status,
    "failed",
  );
  assert.equal(parseUwDegreePlanHistory([], context).status, "complete");
  assert.throws(
    () =>
      parseUwDegreePlanHistory([], { ...context, planId: "123?write=true" }),
    /^Error: Invalid degree-plan reference\.$/,
  );
  assert.throws(
    () =>
      parseUwDegreePlanHistory([], { ...context, planId: "1234567890123456" }),
    /^Error: Invalid degree-plan reference\.$/,
  );
  assert.throws(
    () => parseUwDegreePlanHistory([], { ...context, accountScope: "public" }),
    /^Error: Invalid degree-plan capture context\.$/,
  );
});

test("attempt identities survive row reordering and grade changes without merging repeated enrollments", () => {
  const a = row(),
    b = row({ classNumber: "54321" });
  const first = parseUwDegreePlanHistory(groups([a, b]), context);
  const later = parseUwDegreePlanHistory(
    groups([{ ...b, grade: "B" }, a]),
    context,
  );
  assert.equal(first.records.length, 2);
  assert.equal(first.records[0].id, later.records[1].id);
  assert.equal(first.records[1].id, later.records[0].id);
  const repeated = parseUwDegreePlanHistory(groups([a, a]), context);
  assert.equal(repeated.records.length, 1);
  assert.equal(repeated.status, "partial");
  const terms = parseUwDegreePlanHistory(
    [...groups([a]), ...groups([b])],
    context,
  );
  assert.equal(terms.status, "partial");
});

test("pull selects only a unique primary or sole plan and never creates an audit or plan", async () => {
  for (const plans of [
    [],
    [
      { roadmapId: 1, primary: false },
      { roadmapId: 2, primary: false },
    ],
    [
      { roadmapId: 1, primary: true },
      { roadmapId: 2, primary: true },
    ],
  ]) {
    let requests = 0;
    const result = await pullUwDegreePlanHistory(
      {
        async read() {
          requests++;
          return ok(plans);
        },
      },
      context,
    );
    assert.equal(requests, 1);
    assert.equal(result.status, "partial");
  }
  for (const plans of [
    [{ roadmapId: 5, primary: false }],
    [
      { roadmapId: 4, primary: false },
      { roadmapId: 5, primary: true },
    ],
  ]) {
    const requests: UwPlanningReadRequest[] = [];
    const result = await pullUwDegreePlanHistory(
      {
        async read(request) {
          requests.push(request);
          return ok(request.kind === "degree-plans" ? plans : []);
        },
      },
      context,
    );
    assert.equal(result.status, "complete");
    assert.deepEqual(requests[1], { kind: "degree-plan-detail", planId: "5" });
  }
  const invalid = await pullUwDegreePlanHistory(
    {
      async read() {
        return ok([{ roadmapId: "PRIVATE_INVALID", primary: true }]);
      },
    },
    context,
  );
  assert.equal(invalid.status, "failed");
  assert.equal(JSON.stringify(invalid).includes("PRIVATE_INVALID"), false);
});

test("blocked or partial refresh preserves prior stored history and cancellation stops further reads", async () => {
  const store = createStore(":memory:");
  try {
    const original = parseUwDegreePlanHistory(
      groups([row(), row({ catalogNumber: "301" })]),
      context,
    );
    store.ingestPlanning(original);
    const blocked = await pullUwDegreePlanHistory(
      {
        async read() {
          return {
            status: "needs_sign_in",
            code: "PRIVATE_ERROR",
            bytes: 0,
            elapsedMs: 1,
            schemaVerified: false,
          };
        },
      },
      { ...context, observedAt: "2026-09-27T12:00:00Z" },
    );
    assert.equal(blocked.status, "blocked");
    assert.equal(JSON.stringify(blocked).includes("PRIVATE_ERROR"), false);
    store.ingestPlanning(blocked);
    assert.equal(
      store.planningRecords().filter((record) => !record.deleted).length,
      2,
    );
    const partial = parseUwDegreePlanHistory(
      groups([row({ grade: "A" }), row({ subjectCode: null })]),
      { ...context, observedAt: "2026-09-28T12:00:00Z" },
    );
    store.ingestPlanning(partial);
    assert.equal(
      store.planningRecords().filter((record) => !record.deleted).length,
      2,
    );
    assert.equal(store.planningSources()[0].status, "partial");
    assert.equal(
      store.planningSources()[0].lastSuccessAt,
      "2026-09-26T12:00:00.000Z",
    );
  } finally {
    store.close();
  }
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    pullUwDegreePlanHistory(
      {
        async read() {
          calls++;
          controller.abort();
          return ok([{ roadmapId: 1, primary: true }]);
        },
      },
      { ...context, signal: controller.signal },
    ),
  );
  assert.equal(calls, 1);
});
