import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "@magic/storage";
import type {
  PlanningAudit,
  PlanningCapture,
  PlanningSubject,
} from "@magic/contracts";
import {
  parseUwSavedAudit,
  pullUwSavedAudits,
} from "../packages/connectors/src/uw-planning-audit";
import type {
  UwPlanningReadRequest,
  UwPlanningReadResult,
} from "../packages/connectors/src/uw-planning-http";

const observedAt = "2026-09-26T18:00:00Z";
const subject: PlanningSubject = {
  kind: "subject",
  id: "266",
  code: "266",
  shortName: "COMP SCI",
  formalName: "Computer Sciences",
  aliases: [],
  provenance: {
    sourceUrl: "https://public.enroll.wisc.edu/api/search/v1/subjectsMap",
    observedAt,
    scope: { kind: "subjects", key: "all" },
  },
};
const context = {
  accountScope: "opaque-local-account",
  observedAt,
  currentTermCode: "1272",
  subjects: [subject],
};
const metadata = (extra: Record<string, unknown> = {}) => ({
  darsDegreeAuditReportId: 123,
  darsInstitutionCode: "UW",
  darsDegreeProgramCode: "TEST-MAJOR",
  darsHonorsOptionCode: "",
  darsAuditRunDate: "2026-09-26T12:00:00",
  darsCatalogYearTerm: "20251",
  studentName: "SENSITIVE STUDENT NAME",
  studentCampusId: "SENSITIVE CAMPUS ID",
  sisEmplId: "SENSITIVE EMPLOYEE ID",
  darsJobId: "SENSITIVE JOB ID",
  userSeqNo: "SENSITIVE USER ID",
  ...extra,
});
const lines = (contentType: string, ...lines: string[]) => ({
  contentType,
  lines,
});
const course = (extra: Record<string, unknown> = {}) => ({
  term: "SP26",
  course: "COMP SCI 300",
  credits: "3.00",
  grade: "AB",
  courseNote: null,
  courseTitle: "Synthetic course",
  ...extra,
});
const requirement = (contents: unknown[], status = "OK") => ({
  requirementName: "TEST",
  status: { status, description: "Source-reported status" },
  requirementContents: [
    lines(
      status === "NO" ? "noRequirementTitle" : "okRequirementTitle",
      "Synthetic requirement",
    ),
    ...contents,
  ],
});
const report = (
  requirements: unknown[],
  extra: Record<string, unknown> = {},
) => ({
  header: {
    studentName: "SENSITIVE STUDENT NAME",
    studentCampusId: "SENSITIVE CAMPUS ID",
    preparedDate: "SENSITIVE DATE",
    darsDegreeProgramCode: "TEST-MAJOR",
    darsCatalogYearTerm: "20251",
    degreeProgramTitle1: "Synthetic Major",
    degreeProgramTitle2: "Bachelor of Science",
  },
  topSection: {
    advisors: [{ email: "SENSITIVE ADVISOR" }],
    studentHighSchool: "SENSITIVE SCHOOL",
  },
  completeText: "Untrusted completion summary",
  requirements,
  requirementEndnote: "Untrusted generic footer",
  bottomSection: {
    memorandaSection: { memorandaLines: ["SENSITIVE MEMORANDA"] },
  },
  errorText: [],
  ...extra,
});
const ok = (data: unknown): UwPlanningReadResult => ({
  status: "ok",
  data,
  bytes: 10,
  elapsedMs: 1,
  schemaVerified: false,
});
const auditOf = (capture: PlanningCapture): PlanningAudit => {
  const record = capture.records.find(
    (row): row is PlanningAudit => row.kind === "audit",
  );
  assert.ok(record);
  return record;
};

test("saved report projection retains exact audit evidence and no identity/raw payload", () => {
  const capture = parseUwSavedAudit(
    report([
      requirement([
        lines("okSubrequirementTLine", "+ 1) Core course"),
        lines("okSubrequirementEarnedLine", "EARNED: 3.00 CREDITS", "3.50 GPA"),
        {
          contentType: "okSubrequirementCourses",
          subRequirementCourses: [course()],
        },
      ]),
    ]),
    { ...context, metadata: metadata() },
  );
  const audit = auditOf(capture);
  assert.equal(capture.status, "partial"); // No invented timezone for the observed local timestamp.
  assert.equal(audit.generatedAt, null);
  assert.equal(audit.catalogTerm, "20251");
  assert.match(audit.programKey, /^[a-f0-9]{64}$/);
  assert.equal(audit.nodes[0].title, "Synthetic Major Bachelor of Science");
  const core = audit.nodes.find((node) => node.title.includes("Core course"))!;
  assert.equal(core.status, "completed");
  assert.equal(core.earnedCredits, 3);
  assert.equal(core.earnedGpa, 3.5);
  assert.deepEqual(core.appliedCourses, [
    {
      courseKey: "uw:266:300",
      rawCourse: "COMP SCI 300",
      termCode: "1264",
      credits: 3,
      grade: "AB",
      state: "completed",
    },
  ]);
  assert.ok(core.evidence.some((entry) => entry.quote.includes("3.50 GPA")));
  assert.equal(capture.records.length, 1);
  const serialized = JSON.stringify(capture);
  assert.doesNotMatch(
    serialized,
    /SENSITIVE|topSection|bottomSection|sisEmplId|completeText|courseTitle/,
  );
  assert.match(audit.provenance.sourceUrl, /\/api\/dars\/reports\/123$/);
  assert.equal(audit.provenance.observedAt, observedAt);
});

test("DARS INP/TI/PL and DR/W cannot become completed beneath OK source status", () => {
  const input = report([
    requirement([
      {
        contentType: "okSubrequirementCourses",
        subRequirementCourses: [
          course({
            catalogNumber: "301",
            course: "COMP SCI 301",
            grade: "INP",
            term: "FA26",
          }),
          course({ course: "COMP SCI 302", grade: "TI", term: "FA26" }),
          course({ course: "COMP SCI 303", grade: "PL", term: "SP27" }),
          course({ course: "COMP SCI 304", grade: "DR" }),
          course({ course: "COMP SCI 305", grade: "W" }),
          course({ course: "COMP SCI 306", grade: "P" }),
        ],
      },
    ]),
  ]);
  const audit = auditOf(
    parseUwSavedAudit(input, { ...context, metadata: metadata() }),
  );
  const requirementNode = audit.nodes.find(
    (node) => node.nodeId === "requirement-0",
  )!;
  assert.equal(requirementNode.rawStatus, "OK");
  assert.equal(requirementNode.status, "planned");
  assert.equal(requirementNode.coverage, "partial");
  assert.deepEqual(
    requirementNode.appliedCourses.map((row) => [row.grade, row.state]),
    [
      ["INP", "in_progress"],
      ["TI", "in_progress"],
      ["PL", "planned"],
      ["DR", "dropped"],
      ["W", "withdrawn"],
      ["P", "unknown"],
    ],
  );
  const dropped = auditOf(
    parseUwSavedAudit(
      report([
        requirement([
          lines("okSubrequirementTLine", "+ Core"),
          {
            contentType: "okSubrequirementCourses",
            subRequirementCourses: [course({ grade: "DR" })],
          },
        ]),
      ]),
      { ...context, metadata: metadata({ darsAuditRunDate: observedAt }) },
    ),
  );
  assert.ok(dropped.nodes.every((node) => node.status !== "completed"));
});

test("unknown blocks retain sanitized local evidence and block false completion", () => {
  const capture = parseUwSavedAudit(
    report([
      requirement([
        lines("okSubrequirementTLine", "+ Core"),
        lines(
          "unrecognizedFutureBlock",
          "<script>SENSITIVE SCRIPT</script><b>Manual review required</b>",
        ),
        {
          contentType: "okSubrequirementCourses",
          subRequirementCourses: [
            course({ course: "UNKNOWN 123", term: "AP" }),
            { invalid: "SENSITIVE REJECTED VALUE" },
          ],
        },
      ]),
    ]),
    { ...context, metadata: metadata({ darsAuditRunDate: observedAt }) },
  );
  const audit = auditOf(capture);
  assert.equal(capture.status, "partial");
  const unknown = audit.nodes.find(
    (node) =>
      node.kind === "unknown" &&
      node.evidence.some((entry) => entry.quote === "Manual review required"),
  );
  assert.ok(unknown);
  assert.equal(unknown.coverage, "partial");
  assert.equal(unknown.status, "unknown");
  assert.ok(audit.nodes.every((node) => node.status !== "completed"));
  const applied = audit.nodes.flatMap((node) => node.appliedCourses);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].courseKey, null);
  assert.equal(applied[0].termCode, null);
  assert.doesNotMatch(JSON.stringify(capture), /SENSITIVE|<script>|<b>/);
  assert.doesNotMatch(
    JSON.stringify(capture.diagnostics),
    /UNKNOWN 123|Manual review/,
  );
});

test("needs, exact course alternatives, source legend, and contingent credits retain their meanings", () => {
  const capture = parseUwSavedAudit(
    report([
      requirement(
        [
          lines("noSubrequirementTLine", "- 1) Elective"),
          lines(
            "noSubrequirementNeedsSummaryLine",
            "NEEDS: 3.00 CREDITS",
            "NEEDS: 1 COURSE",
          ),
          lines(
            "noSubrequirementAcceptCourses",
            "SELECT FROM: COMP SCI 300, 400",
          ),
        ],
        "NO",
      ),
      requirement([
        lines("okSubrequirementTLine", "+ Core"),
        lines("okSubrequirementEarnedLine", "IN-P: 3.00 CREDITS"),
      ]),
      {
        ...requirement([lines("unknownLegend", "Symbols only")]),
        requirementName: "LEGEND",
      },
    ]),
    { ...context, metadata: metadata({ darsAuditRunDate: observedAt }) },
  );
  const audit = auditOf(capture);
  const elective = audit.nodes.find((node) => node.title.includes("Elective"))!;
  assert.equal(elective.needsCredits, 3);
  assert.equal(elective.needsCourses, 1);
  assert.equal(elective.status, "incomplete");
  assert.deepEqual(elective.acceptableCourseKeys, ["uw:266:300", "uw:266:400"]);
  const contingent = audit.nodes.find((node) => node.title === "+ Core")!;
  assert.equal(contingent.status, "in_progress");
  assert.equal(contingent.earnedCredits, null);
  assert.equal(audit.generatedAt, observedAt);
  assert.doesNotMatch(JSON.stringify(audit), /Symbols only/);
});

test("invalid report shapes, mismatched program metadata and public identity fail closed", () => {
  for (const input of [
    "<html>Login</html>",
    report([], { errorText: ["SENSITIVE ERROR"] }),
    report([], {
      header: {
        darsDegreeProgramCode: "WRONG",
        darsCatalogYearTerm: "20251",
        degreeProgramTitle1: "Wrong program",
      },
    }),
  ]) {
    const capture = parseUwSavedAudit(input, {
      ...context,
      metadata: metadata(),
    });
    assert.equal(capture.status, "failed");
    assert.equal(capture.records.length, 0);
    assert.doesNotMatch(
      JSON.stringify(capture),
      /SENSITIVE|WRONG|Wrong program|Login/,
    );
  }
  assert.throws(
    () =>
      parseUwSavedAudit(report([]), {
        ...context,
        accountScope: "public",
        metadata: metadata(),
      }),
    /Invalid saved-audit/,
  );
  const invalidId = parseUwSavedAudit(report([]), {
    ...context,
    metadata: metadata({ darsDegreeAuditReportId: 1e16 }),
  });
  assert.equal(invalidId.status, "failed");
});

test("pull reads latest saved GET report per program and cannot generate audits", async () => {
  const requests: UwPlanningReadRequest[] = [];
  const result = await pullUwSavedAudits(
    {
      read: async (request) => {
        requests.push(request);
        return request.kind === "audit-metadata"
          ? ok([
              metadata({
                darsDegreeAuditReportId: 100,
                darsAuditRunDate: "2026-09-25T12:00:00",
              }),
              metadata(),
              metadata({ darsDegreeAuditReportId: null }),
              metadata({
                darsDegreeAuditReportId: 200,
                darsDegreeProgramCode: "TEST-MINOR",
              }),
            ])
          : ok(
              report(
                [requirement([])],
                request.kind === "audit-report" && request.reportId === "200"
                  ? {
                      header: {
                        darsDegreeProgramCode: "TEST-MINOR",
                        darsCatalogYearTerm: "20251",
                        degreeProgramTitle1: "Synthetic Minor",
                      },
                    }
                  : {},
              ),
            );
      },
    },
    context,
  );
  assert.deepEqual(requests, [
    { kind: "audit-metadata" },
    { kind: "audit-report", reportId: "123" },
    { kind: "audit-report", reportId: "200" },
  ]);
  assert.equal(result.flatMap((capture) => capture.records).length, 2);
  const programScopes = result
    .filter((capture) => capture.records.length)
    .map((capture) => capture.scope.key);
  assert.equal(new Set(programScopes).size, 2);
  assert.ok(
    result.some((capture) =>
      capture.diagnostics.some(
        (diagnostic) => diagnostic.code === "saved_audit_inventory_partial",
      ),
    ),
  );
  const newer = parseUwSavedAudit(report([requirement([])]), {
    ...context,
    metadata: metadata({ darsDegreeAuditReportId: 500 }),
  });
  assert.equal(
    auditOf(newer).id,
    auditOf(result.find((capture) => capture.scope.key === newer.scope.key)!)
      .id,
  );
});

test("missing, ambiguous, blocked and failed saved audits retain previous stored evidence", async () => {
  const requests: UwPlanningReadRequest[] = [];
  const ambiguous = await pullUwSavedAudits(
    {
      read: async (request) => {
        requests.push(request);
        return ok([metadata(), metadata({ darsDegreeAuditReportId: 124 })]);
      },
    },
    context,
  );
  assert.equal(requests.length, 1);
  assert.equal(ambiguous[0].status, "partial");
  assert.equal(ambiguous[0].records.length, 0);
  const empty = await pullUwSavedAudits({ read: async () => ok([]) }, context);
  assert.equal(empty[0].status, "partial");
  const original = parseUwSavedAudit(
    report([
      requirement([
        {
          contentType: "okSubrequirementCourses",
          subRequirementCourses: [course()],
        },
      ]),
    ]),
    { ...context, metadata: metadata() },
  );
  const blocked = await pullUwSavedAudits(
    {
      read: async (request) =>
        request.kind === "audit-metadata"
          ? ok([metadata()])
          : {
              status: "needs_sign_in",
              code: "auth_expired",
              elapsedMs: 1,
              bytes: 0,
              schemaVerified: false,
            },
    },
    { ...context, observedAt: "2026-09-26T19:00:00Z" },
  );
  assert.equal(blocked[0].status, "blocked");
  assert.equal(blocked[0].scope.key, original.scope.key);
  const failed = await pullUwSavedAudits(
    {
      read: async () => {
        throw new Error("SENSITIVE NETWORK ERROR");
      },
    },
    context,
  );
  assert.equal(failed[0].status, "failed");
  assert.doesNotMatch(JSON.stringify(failed), /SENSITIVE/);
  const store = createStore(":memory:");
  try {
    store.ingestPlanning(original);
    store.ingestPlanning(blocked[0]);
    const saved = store
      .planningRecords()
      .filter((row) => row.accountScope === context.accountScope);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].kind, "audit");
  } finally {
    store.close();
  }
});

test("cancelled pull stops before any further request", async () => {
  const controller = new AbortController();
  const requests: UwPlanningReadRequest[] = [];
  await assert.rejects(
    pullUwSavedAudits(
      {
        read: async (request) => {
          requests.push(request);
          controller.abort();
          return ok([metadata()]);
        },
      },
      { ...context, signal: controller.signal },
    ),
  );
  assert.equal(requests.length, 1);
});
