import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "@magic/storage";
import { reconcileAcademicRecords } from "../packages/core/src/academic-reconciliation";
import { createCore } from "@magic/core";
import { captureBatchSchema, type AuditNode, type PlanningCapture, type PlanningRecord } from "@magic/contracts";
import fixture from "../fixtures/course.json";

const stamp = "2026-09-26T12:00:00Z", now = "2026-09-26T13:00:00Z", canvasScope = "a".repeat(64);
const provenance = (kind: PlanningCapture["scope"]["kind"], key: string) => ({ scope: { kind, key }, sourceUrl: "https://enroll.wisc.edu/", observedAt: stamp });
function setup(link = true) {
  const store = createStore(":memory:");
  function save(accountScope: string, rows: PlanningRecord[], source: PlanningCapture["source"] = "uw_enroll") {
    const p = rows[0]!.provenance;
    store.ingestPlanning({ schemaVersion: 1, id: p.scope.key, accountScope, source, scope: p.scope, sourceUrl: p.sourceUrl, observedAt: stamp, status: "complete", completeness: "complete", records: rows, diagnostics: [] });
  }
  save("public", [{ kind: "subject", id: "266", code: "266", shortName: "COMP SCI", formalName: "Computer Sciences", aliases: ["COMPSCI"], provenance: provenance("subjects", "subjects") }], "uw_public");
  save("academic", [{ kind: "course_history", id: "attempt", courseKey: "uw:266:101", termCode: "1264", grade: "AB", credits: 3, state: "completed", gpaEligible: null, provenance: provenance("degree_plan", "primary") }]);
  if (link) save("academic", [{ kind: "account_link", id: "canvas-account", canvasAccountScope: canvasScope, method: "matched_institutional_login", provenance: provenance("student_record", "connection:canvas-account") }]);
  store.ingest({ source: { id: "canvas-source", kind: "canvas", label: "Synthetic course", accountScope: canvasScope, courseId: "99", scope: "course" }, observedAt: stamp, status: "ok", complete: true,
    resources: [{ kind: "course", externalId: "99", courseId: "99", courseName: "Synthetic course", title: "Synthetic course", text: "", url: "https://canvas.wisc.edu/courses/99", course: { courseCode: "SP26 COMPSCI 101 001", termName: "Spring 2026", gradeEvidence: [{ finalGrade: "A", finalScore: 89, currentScore: 94, enrollmentState: "completed" }] } }] });
  return { store, save };
}
test("core snapshot compares exact attempts without replacing grades, counting credits, or inferring mastery", async () => {
  const { store } = setup();
  const core = createCore(store, { fixture: captureBatchSchema.parse(fixture), now: () => new Date(now) });
  try {
    const result = (await core.execute({ type: "snapshot" })).snapshot.planning!.reconciliation!;
    assert.equal(result.status, "available"); assert.equal(result.attempts.length, 1);
    const attempt = result.attempts[0]!;
    assert.equal(attempt.coverage, "matched"); assert.deepEqual(attempt.differences, ["grade"]);
    assert.deepEqual(attempt.claims.map(c => c.grade).sort(), ["A", "AB"]);
    assert.equal(attempt.claims.find(c => c.source === "canvas")!.currentScore, 94);
    assert.equal("mastery" in attempt, false); assert.equal("totalCredits" in result, false);
  } finally { await core.close(); }
});
test("an unverified or stale account link blocks cross-source reconciliation", () => {
  for (const link of [false, true]) {
    const { store } = setup(link);
    try { assert.equal(reconcileAcademicRecords(store, link ? "2026-09-29T13:00:00Z" : now).status, "unlinked"); }
    finally { store.close(); }
  }
});
test("repeated courses in different terms remain separate and percent-only results do not become grade conflicts", () => {
  const { store, save } = setup();
  try {
    save("academic", [{ kind: "course_history", id: "other-term", courseKey: "uw:266:101", termCode: "1262", grade: "B", credits: 3, state: "completed", gpaEligible: null, provenance: provenance("degree_plan", "previous") }]);
    const source = store.resources().find(r => r.kind === "course")!;
    store.ingest({ source: { id: "canvas-source", kind: "canvas", label: "Synthetic course", accountScope: canvasScope, courseId: "99", scope: "course" }, observedAt: "2026-09-26T12:30:00Z", status: "ok", complete: true, resources: [{ externalId: "99", kind: "course", courseId: "99", courseName: source.courseName, title: source.title, text: "", url: source.url, course: { ...source.course, gradeEvidence: [{ finalGrade: null, finalScore: 99 }] } }] });
    const result = reconcileAcademicRecords(store, now);
    assert.equal(result.attempts.length, 2);
    assert.equal(result.attempts.filter(r => r.coverage === "academic_only").length, 1);
    assert.equal(result.attempts.some(r => r.differences.length), false);
  } finally { store.close(); }
});


test("Canvas academic-year term labels need a corroborating course-code term", () => {
  for (const [termName, code, expected] of [
    ["Spring 2025-2026", "SP26 COMPSCI 101 001", 1],
    ["Spring 2025-2026", "SP25 COMPSCI 101 001", 0],
    ["Spring 2026", "FA26 COMPSCI 101 001", 0],
    ["Spring 2025-2026", "COMPSCI 101 001", 0],
  ] as const) {
    const { store } = setup();
    try {
      store.ingest({ source: { id: "canvas-source", kind: "canvas", label: "Synthetic course", accountScope: canvasScope, courseId: "99", scope: "course" }, observedAt: "2026-09-26T12:30:00Z", status: "ok", complete: true,
        resources: [{ externalId: "99", kind: "course", courseId: "99", courseName: "Synthetic course", title: "Synthetic course", text: "", url: "https://canvas.wisc.edu/courses/99", course: { courseCode: code, termName } }] });
      assert.equal(reconcileAcademicRecords(store, now).attempts.filter(a => a.coverage === "matched").length, expected);
    } finally { store.close(); }
  }
});

test("DARS appearances retain applied-credit variation without duplicating attempts or claiming attempt-credit errors", () => {
  const { store, save } = setup();
  try {
    const applied = { courseKey: "uw:266:101", rawCourse: "COMP SCI 101", termCode: "1264", grade: "AB", credits: 3, state: "completed" as const };
    const base: AuditNode = { nodeId: "one", parentId: null, index: 0, kind: "requirement", title: "Synthetic requirement", requirementKind: "unknown", rawStatus: "OK", status: "completed", flags: [], earnedCredits: 3, earnedGpa: null, needsCourses: null, needsCredits: null, acceptableCourseKeys: [], appliedCourses: [applied], coverage: "partial", evidence: [] };
    save("academic", [{ kind: "audit", id: "report", programKey: "program", generatedAt: stamp, catalogTerm: "20251", coverage: "partial", provenance: provenance("audit_program", "program"), nodes: [base, { ...base, nodeId: "two", index: 1 }, { ...base, nodeId: "three", index: 2, appliedCourses: [{ ...applied, credits: 2 }] }] }], "uw_dars");
    const result = reconcileAcademicRecords(store, now), attempt = result.attempts[0]!;
    assert.equal(result.attempts.length, 1);
    assert.equal(attempt.claims.filter(c => c.source === "audit").length, 2);
    assert.equal(attempt.claims.filter(c => c.creditBasis === "attempt").length, 1);
    assert.ok(attempt.differences.includes("applied_credits"));
    assert.ok(!attempt.differences.includes("credits"));
  } finally { store.close(); }
});
