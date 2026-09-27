import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "@magic/storage";
import { comparePlanning } from "../packages/core/src/planning";
import type {
  PlanningAudit, PlanningCapture, PlanningCatalogCourse, PlanningCourseHistory, PlanningEnrollmentPackage,
  PlanningGradeDistribution, PlanningProvenance, PlanningRecord, PlanningScope, Store,
} from "@magic/contracts";

// These are normalized application fixtures, not claimed response shapes from UW services.
const current = "2026-09-26T12:00:00Z", next = "2026-09-26T13:00:00Z", now = "2026-09-26T14:00:00Z", stale = "2026-09-20T12:00:00Z";
const provenance = (kind: PlanningScope["kind"], key: string, observedAt = current): PlanningProvenance => ({ sourceUrl: "https://enroll.wisc.edu/", observedAt, scope: { kind, key } });
const history = (observedAt = current): PlanningCourseHistory => ({ id: "taken-300", kind: "course_history", provenance: provenance("degree_plan", "primary", observedAt), courseKey: "uw:266:300", termCode: "1264", state: "completed", credits: 3, grade: "AB", gpaEligible: true });
const course = (number = "400", checkedAt: string | null = current): PlanningCatalogCourse => ({ id: `course-${number}`, kind: "catalog_course", provenance: provenance("catalog_term", "1272"), courseKey: `uw:266:${number}`, termCode: "1272", title: `Synthetic course ${number}`, description: "Normalized synthetic course", creditMin: 3, creditMax: 3, designations: [], prerequisiteText: "COMP SCI 300", prerequisite: { kind: "course", courseKey: "uw:266:300", minimumGrade: null, concurrent: false }, prerequisiteCheckedAt: checkedAt, offeringFrequency: null });
const packageRow = (number = "400", start = 540, end = 590): PlanningEnrollmentPackage => ({ id: `package-${number}`, kind: "enrollment_package", provenance: provenance("catalog_term", "1272"), courseKey: `uw:266:${number}`, termCode: "1272", sections: ["001"], status: "open", enrollmentState: "available", meetings: [{ kind: "class", mode: "scheduled", days: [1, 3, 5], startMinute: start, endMinute: end, startDate: "2026-09-02", endDate: "2026-12-10", timezone: "America/Chicago", location: null }], meetingsComplete: true, seatsAvailable: 4, capacity: 40, waitlistCount: 0, instructorNames: [] });
const audit = (): PlanningAudit => ({ id: "audit", kind: "audit", provenance: provenance("audit_program", "program"), programKey: "program", generatedAt: current, catalogTerm: "20251", coverage: "complete", nodes: [{ nodeId: "elective", parentId: null, index: 0, kind: "requirement", title: "An elective remains", requirementKind: "elective", rawStatus: "NO", status: "incomplete", flags: [], earnedCredits: 0, earnedGpa: null, needsCourses: 1, needsCredits: 3, acceptableCourseKeys: ["uw:266:400", "uw:266:577"], appliedCourses: [], coverage: "complete", evidence: [{ blockId: "select", quote: "SELECT FROM COMP SCI 400, 577" }] }] });
const grade = (number = "400", section: string | null = "001", termCode = "1264", letter = "A"): PlanningGradeDistribution => ({ id: `grades-${number}-${termCode}-${section}`, kind: "grade_distribution", provenance: { ...provenance("grade_course", `uw:266:${number}`), sourceUrl: "https://madgrades.com/" }, courseKey: `uw:266:${number}`, termCode, section, instructorNames: [], counts: [{ grade: letter, count: 20 }], coverage: "published" });
function ingest(store: Store, records: PlanningRecord[], scope: PlanningScope, accountScope = "student-hash", observedAt = current, extra: Partial<PlanningCapture> = {}) {
  return store.ingestPlanning({ schemaVersion: 1, id: `fixture-${scope.kind}-${scope.key}`, accountScope, source: "normalized_import", scope, sourceUrl: "https://enroll.wisc.edu/", observedAt, status: "complete", completeness: "complete", records, diagnostics: [], ...extra });
}
function seeded(options: { historyAt?: string; enrollmentTerm?: string | null; catalogRows?: PlanningRecord[]; audit?: PlanningAudit } = {}) {
  const store = createStore(":memory:");
  ingest(store, [{ id: "subject-cs", kind: "subject", provenance: provenance("subjects", "all"), code: "266", shortName: "COMP SCI", formalName: "Computer Sciences", aliases: ["COMPSCI"] }], { kind: "subjects", key: "all" }, "public");
  ingest(store, [history(options.historyAt)], { kind: "degree_plan", key: "primary" }, "student-hash", options.historyAt ?? current);
  ingest(store, [options.audit ?? audit()], { kind: "audit_program", key: "program" });
  ingest(store, options.catalogRows ?? [course(), course("577"), packageRow(), packageRow("577", 600, 650)], { kind: "catalog_term", key: "1272" }, "public");
  if (options.enrollmentTerm !== null) ingest(store, [], { kind: "enrollment_term", key: options.enrollmentTerm ?? "1272" });
  return store;
}
function using(options: Parameters<typeof seeded>[0], run: (store: Store) => void) { const store = seeded(options); try { run(store); } finally { store.close(); } }

test("saved student journey traces audit and course evidence, checks requirements, and compares options", () => using({}, (store) => {
  const comparison = comparePlanning(store, "1272", "balanced", now);
  assert.equal(comparison.candidates.length, 2);
  assert.ok(comparison.candidates.every((row) => row.prerequisite === "met" && row.schedule === "clear"));
  assert.deepEqual(comparison.candidates[0].requirements, ["An elective remains"]);
  assert.ok(comparison.candidates[0].evidence.some((item) => item.label === "Audit"));
  assert.ok(comparison.warnings.some((warning) => warning.includes("not a conflict-free combined schedule")));
  assert.equal(store.resources().length, 0);
}));

test("a second account stops comparison rather than mixing its history or audit", () => using({}, (store) => {
  ingest(store, [history()], { kind: "degree_plan", key: "primary" }, "other-student-hash");
  const comparison = comparePlanning(store, "1272", "balanced", now);
  assert.equal(comparison.candidates.length, 0);
  assert.ok(comparison.warnings.some((warning) => warning.includes("More than one student")));
}));

test("another term's fresh enrollment cannot confirm an empty requested-term calendar", () => using({ enrollmentTerm: "1274" }, (store) => {
  const comparison = comparePlanning(store, "1272", "balanced", now);
  assert.ok(comparison.candidates.length > 0);
  assert.ok(comparison.candidates.every((row) => row.schedule === "unknown"));
  assert.ok(comparison.warnings.some((warning) => warning.includes("Enrollment for this term")));
}));

test("stale completed history cannot satisfy prerequisites even when another degree-plan scope is fresh", () => using({ historyAt: stale }, (store) => {
  ingest(store, [], { kind: "degree_plan", key: "other-plan" });
  const comparison = comparePlanning(store, "1272", "balanced", now);
  assert.ok(comparison.candidates.every((row) => row.prerequisite === "unknown"));
  assert.ok(comparison.warnings.some((warning) => warning.includes("stale history cannot confirm")));
}));

test("failed history refresh preserves the taken-course guard but removes qualification authority", () => using({}, (store) => {
  ingest(store, [], { kind: "degree_plan", key: "primary" }, "student-hash", next, { status: "failed", completeness: "unknown" });
  const comparison = comparePlanning(store, "1272", "balanced", now);
  assert.ok(comparison.candidates.every((row) => row.prerequisite === "unknown"));
  assert.equal(store.planningRecords().filter((row) => row.kind === "course_history" && !row.deleted).length, 1);
}));

test("current enrollment supplements history without pretending to enumerate all attempts", () => using({}, (store) => {
  const scope: PlanningScope = { kind: "degree_plan", key: "current-enrollment:1272" };
  const row = { ...history(), id: "current-400", courseKey: "uw:266:400", termCode: "1272", state: "in_progress" as const, grade: null, provenance: provenance(scope.kind, scope.key) };
  ingest(store, [row], scope, "student-hash", current, { status: "partial", completeness: "partial" });
  const comparison = comparePlanning(store, "1272", "balanced", now);
  assert.equal(comparison.candidates.some((candidate) => candidate.courseKey === "uw:266:400"), false);
  assert.equal(comparison.warnings.some((warning) => warning.includes("Course history is incomplete")), false);
  assert.ok(comparison.candidates.every((candidate) => candidate.prerequisite === "met"));
}));

test("fresh validated rows can prove a known prerequisite while unparsed transfer history remains incomplete", () => using({}, (store) => {
  ingest(store, [{ ...history(), provenance: provenance("degree_plan", "primary", next) }], { kind: "degree_plan", key: "primary" }, "student-hash", next, { status: "partial", completeness: "partial" });
  const comparison = comparePlanning(store, "1272", "balanced", now);
  assert.ok(comparison.warnings.some((warning) => warning.includes("Course history is incomplete")));
  assert.ok(comparison.candidates.every((candidate) => candidate.prerequisite === "met"));
}));

test("unknown meetings, stale section evidence and future timestamps never become clear fit", () => {
  const unknown = packageRow(); unknown.meetings[0].startMinute = null;
  using({ catalogRows: [course(), unknown] }, (store) => assert.equal(comparePlanning(store, "1272", "balanced", now).candidates[0].schedule, "unknown"));
  const old = packageRow(); old.provenance.observedAt = stale;
  using({ catalogRows: [course(), old] }, (store) => {
    const option = comparePlanning(store, "1272", "balanced", now).candidates[0];
    assert.equal(option.schedule, "unknown"); assert.equal(option.seatsAvailable, null); assert.equal(option.seatStatus, "Seats need refresh");
  });
  using({}, (store) => {
    ingest(store, [], { kind: "enrollment_term", key: "1272" }, "student-hash", "2026-09-27T12:00:00Z");
    assert.equal(comparePlanning(store, "1272", "balanced", now).candidates[0].schedule, "unknown");
  });
});

test("undated prerequisite evidence remains unknown even when course history is complete", () => using({ catalogRows: [course("400", null), packageRow()] }, (store) => {
  const comparison = comparePlanning(store, "1272", "balanced", now);
  assert.equal(comparison.candidates[0].prerequisite, "unknown");
  assert.ok(comparison.warnings.some((warning) => warning.includes("prerequisite evidence is undated")));
}));

test("conflicting cross-list mappings produce a warning rather than a crash or chosen equivalence", () => using({}, (store) => {
  const records: PlanningRecord[] = [
    { id: "cs", kind: "subject", provenance: provenance("subjects", "all", next), code: "266", shortName: "COMP SCI", formalName: "Computer Sciences", aliases: [] },
    { id: "a", kind: "crosslist", provenance: provenance("subjects", "all", next), canonicalKey: "uw:266:400", courseKeys: ["uw:266:400", "uw:600:400"] },
    { id: "b", kind: "crosslist", provenance: provenance("subjects", "all", next), canonicalKey: "uw:600:400", courseKeys: ["uw:266:400", "uw:600:400"] },
  ];
  ingest(store, records, { kind: "subjects", key: "all" }, "public", next);
  const comparison = comparePlanning(store, "1272", "balanced", now);
  assert.equal(comparison.candidates.length, 0);
  assert.ok(comparison.warnings.some((warning) => warning.includes("equivalence is unknown")));
}));

test("historical grade evidence names its term and section and does not drive ranking", () => using({}, (store) => {
  ingest(store, [grade("400", "002", "1264", "C")], { kind: "grade_course", key: "uw:266:400" }, "public");
  ingest(store, [grade("577", "001", "1264", "A")], { kind: "grade_course", key: "uw:266:577" }, "public");
  const comparison = comparePlanning(store, "1272", "balanced", now);
  assert.equal(comparison.candidates[0].courseKey, "uw:266:400");
  assert.equal(comparison.candidates[0].historicalAverage, 2);
  assert.equal(comparison.candidates[0].historicalCount, 20);
  assert.ok(comparison.candidates[0].evidence.some((item) => item.label.includes("Spring 2026") && item.label.includes("Section 002") && item.url === "https://madgrades.com/"));
}));

test("multiple sections or duplicate aggregates in a historical term are not an invented course average", () => using({}, (store) => {
  ingest(store, [grade("400", "001"), grade("400", "002")], { kind: "grade_course", key: "uw:266:400" }, "public");
  let comparison = comparePlanning(store, "1272", "balanced", now);
  assert.equal(comparison.candidates.find((row) => row.courseKey === "uw:266:400")?.historicalAverage, null);
  assert.ok(comparison.warnings.some((warning) => warning.includes("No arbitrary section average")));
  const a = grade("400", null), b = { ...grade("400", null), id: "second-aggregate" };
  a.provenance.observedAt = next; b.provenance.observedAt = next;
  ingest(store, [a, b], { kind: "grade_course", key: "uw:266:400" }, "public", next);
  comparison = comparePlanning(store, "1272", "balanced", now);
  assert.equal(comparison.candidates.find((row) => row.courseKey === "uw:266:400")?.historicalCount, null);
}));

test("major-core classification alone cannot invent scarce options or an unlock advantage", () => {
  const record = audit();
  record.nodes[0].requirementKind = "major_core";
  record.nodes[0].acceptableCourseKeys = ["uw:266:400", "uw:266:300"];
  record.nodes.push({ ...record.nodes[0], nodeId: "other", index: 1, title: "Unclassified requirement", requirementKind: "unknown", acceptableCourseKeys: ["uw:266:577"] });
  using({ audit: record, catalogRows: [course(), course("577"), packageRow("400", 540, 660), packageRow("577", 540, 570)] }, (store) => {
    assert.equal(comparePlanning(store, "1272", "balanced", now).candidates[0].courseKey, "uw:266:577");
  });
});

test("progress precedes schedule and multiple potential matches remain explicitly conditional", () => {
  const record = audit(); record.nodes[0].acceptableCourseKeys = ["uw:266:400"];
  record.nodes.push({ ...record.nodes[0], nodeId: "breadth", index: 1, title: "Scientific breadth", requirementKind: "breadth", acceptableCourseKeys: ["uw:266:400", "uw:266:577"] });
  using({ audit: record, catalogRows: [course(), course("577"), packageRow("400", 540, 660), packageRow("577", 540, 570)] }, (store) => {
    const comparison = comparePlanning(store, "1272", "balanced", now);
    assert.equal(comparison.candidates[0].courseKey, "uw:266:400");
    assert.equal(comparison.candidates[0].multipleRequirements, true);
    assert.ok(comparison.warnings.some((warning) => warning.includes("do not establish permission to double count")));
  });
});

test("mornings filter rejects known afternoon classes while keeping unknown schedules labelled", () => using({ catalogRows: [course(), course("577"), packageRow("400", 720, 780), { ...packageRow("577"), meetings: [], meetingsComplete: false }] }, (store) => {
  const comparison = comparePlanning(store, "1272", "mornings", now);
  assert.deepEqual(comparison.candidates.map((row) => row.courseKey), ["uw:266:577"]);
  assert.equal(comparison.candidates[0].schedule, "unknown");
}));


test("topic variants never borrow another topic's sections or requirement eligibility", () => {
  const variant = { ...course("400"), id: "course:1272:266:004001.2", title: "Synthetic topic" };
  using({ catalogRows: [course(), variant, packageRow(), course("577"), packageRow("577")] }, store => {
    const comparison = comparePlanning(store, "1272", "balanced", now);
    assert.deepEqual(comparison.candidates.map(c => c.courseKey), ["uw:266:577"]);
    assert.ok(comparison.warnings.some(w => w.includes("Topic-specific")));
    assert.equal(store.planningRecords().filter(r => r.kind === "catalog_course").length, 3);
  });
});
