import test from "node:test";
import assert from "node:assert/strict";
import {
  planningAuditSchema, planningCaptureSchema, planningCatalogCourseSchema, planningRecordSchema,
  prerequisiteSchema,
  type PlanningAudit, type PlanningCapture, type PlanningCatalogCourse, type PlanningCourseHistory,
  type PlanningCrosslist, type PlanningEnrollmentPackage, type PlanningGradeDistribution,
  type PlanningMeeting, type PlanningProvenance, type PlanningSubject, type Prerequisite,
} from "../packages/contracts/src/planning";
import {
  assessCreditLoad, buildCourseIdentityTable, calculateAttemptGpa, calculateGradeDistributionAverage,
  canonicalizeCourseKey, checkMeetingConflict, checkPackageConflicts, classifyHistoryState,
  decodeUwTerm, encodeUwTerm, evaluatePrerequisite, millisecondsToMinute, normalizeMeetingDays,
  parseAuditCatalogTerm, parseAuditCourseList, parseAuditCourseTerm, parseNormalizedAuditBlocks,
  parseUwTermLabel, potentialAuditCoverage, rankPlanningCandidates, resolveCourseIdentity,
  type NormalizedAuditBlock, type PlanningCandidate,
} from "../packages/domain/src/planning";

// Synthetic, NORMALIZED application fixtures. These deliberately do not pretend to be UW JSON.
const provenance = (kind: PlanningProvenance["scope"]["kind"] = "degree_plan", key = "synthetic"): PlanningProvenance => ({
  sourceUrl: "https://enroll.wisc.edu/", observedAt: "2026-09-26T12:00:00Z", scope: { kind, key },
});
const subjects: PlanningSubject[] = [
  { id: "cs", kind: "subject", code: "266", shortName: "COMP SCI", formalName: "Computer Sciences", aliases: ["COMPSCI"], provenance: provenance("subjects") },
  { id: "math", kind: "subject", code: "600", shortName: "MATH", formalName: "Mathematics", aliases: [], provenance: provenance("subjects") },
  { id: "ece", kind: "subject", code: "320", shortName: "E C E", formalName: "Electrical and Computer Engineering", aliases: ["ECE"], provenance: provenance("subjects") },
];
const crosslist: PlanningCrosslist = { id: "math-cs-240", kind: "crosslist", canonicalKey: "uw:266:240", courseKeys: ["uw:600:240", "uw:266:240"], provenance: provenance("subjects") };
const identities = buildCourseIdentityTable(subjects, [crosslist]);
const history = (overrides: Partial<PlanningCourseHistory> = {}): PlanningCourseHistory => ({
  id: "attempt-1", kind: "course_history", provenance: provenance(), courseKey: "uw:266:300", termCode: "1264", state: "completed", credits: 3, grade: "AB", gpaEligible: true, ...overrides,
});
const meeting = (overrides: Partial<PlanningMeeting> = {}): PlanningMeeting => ({
  kind: "class", mode: "scheduled", days: [1, 3, 5], startMinute: 540, endMinute: 590,
  startDate: "2026-09-02", endDate: "2026-12-10", timezone: "America/Chicago", location: null, ...overrides,
});
const packageRow = (overrides: Partial<PlanningEnrollmentPackage> = {}): PlanningEnrollmentPackage => ({
  id: "package-1", kind: "enrollment_package", provenance: provenance("catalog_term", "1272"), courseKey: "uw:266:400", termCode: "1272",
  sections: ["001", "301"], status: "open", enrollmentState: "available", meetings: [meeting()], meetingsComplete: true,
  seatsAvailable: 3, capacity: 40, waitlistCount: 0, instructorNames: [], ...overrides,
});
const catalog = (overrides: Partial<PlanningCatalogCourse> = {}): PlanningCatalogCourse => ({
  id: "catalog-1", kind: "catalog_course", provenance: provenance("catalog_term", "1272"), courseKey: "uw:266:400", termCode: "1272",
  title: "Synthetic course", description: "Synthetic normalized catalog record", creditMin: 3, creditMax: 3,
  designations: [], prerequisiteText: "COMP SCI 300", prerequisite: { kind: "course", courseKey: "uw:266:300", minimumGrade: null, concurrent: false },
  prerequisiteCheckedAt: "2026-09-26T12:00:00Z", offeringFrequency: null, ...overrides,
});
const distribution = (overrides: Partial<PlanningGradeDistribution> = {}): PlanningGradeDistribution => ({
  id: "grades-1", kind: "grade_distribution", provenance: { ...provenance("grade_course", "uw:266:400"), sourceUrl: "https://madgrades.com/" },
  courseKey: "uw:266:400", termCode: "1264", section: "001", instructorNames: [],
  counts: [{ grade: "A", count: 10 }, { grade: "AB", count: 4 }, { grade: "B", count: 2 }, { grade: "F", count: 4 }, { grade: "S", count: 3 }, { grade: "U", count: 1 }], coverage: "published", ...overrides,
});
const coursePrereq = (overrides: Partial<Extract<Prerequisite, { kind: "course" }>> = {}): Prerequisite => ({ kind: "course", courseKey: "uw:266:300", minimumGrade: null, concurrent: false, ...overrides });
const auditFrom = (blocks: NormalizedAuditBlock[], overrides: Partial<PlanningAudit> = {}): PlanningAudit => {
  const parsed = parseNormalizedAuditBlocks(blocks, identities, "1272");
  return { id: "audit-1", kind: "audit", provenance: provenance("audit_program", "program-1"), programKey: "program-1", generatedAt: "2026-09-26T12:00:00Z", catalogTerm: "20251", ...parsed, ...overrides };
};
const openBlocks: NormalizedAuditBlock[] = [
  { kind: "heading", blockId: "h1", nodeId: "major", parentId: null, title: "Synthetic engineering sequence", rawStatus: "NO", flags: [], quote: "NO Synthetic engineering sequence" },
  { kind: "needs", blockId: "n1", courses: 1, credits: 3, quote: "NEEDS 1 COURSE" },
  { kind: "select_from", blockId: "s1", text: "COMP SCI 400, 577", quote: "SELECT FROM COMP SCI 400, 577" },
];

test("UW term encoding roundtrips pinned terms and rejects unsupported codes", () => {
  for (const [code, year, season, label] of [
    ["1262", 2025, "fall", "Fall 2025"], ["1264", 2026, "spring", "Spring 2026"],
    ["1266", 2026, "summer", "Summer 2026"], ["1272", 2026, "fall", "Fall 2026"],
  ] as const) {
    assert.equal(encodeUwTerm(year, season), code);
    assert.equal(decodeUwTerm(code).label, label);
    assert.equal(parseUwTermLabel(label)?.code, code);
  }
  assert.deepEqual(["1272", "1266", "1262", "1264"].sort(), ["1262", "1264", "1266", "1272"]);
  assert.throws(() => decodeUwTerm("20251"));
  assert.throws(() => decodeUwTerm("1261"));
  assert.throws(() => encodeUwTerm(2099, "fall"));
  assert.equal(parseUwTermLabel("next fall"), null);
});

test("DARS catalog academic years and course calendar-year labels are distinct", () => {
  assert.equal(parseAuditCatalogTerm("20251")?.label, "Fall 2024");
  assert.equal(parseAuditCatalogTerm("20261")?.code, "1262");
  assert.equal(parseAuditCatalogTerm("20262")?.code, "1264");
  assert.equal(parseAuditCatalogTerm("20263")?.code, "1266");
  assert.equal(parseAuditCourseTerm("FA24")?.code, "1252");
  assert.equal(parseAuditCourseTerm("SP25")?.code, "1254");
  assert.equal(parseAuditCourseTerm("20251"), null);
  assert.equal(parseAuditCatalogTerm("FA24"), null);
});

test("one evidenced course table handles padded subjects, numeric IDs, Canvas labels and crosslists", () => {
  for (const input of ["COMP SCI577", "COMP SCI 577", "COMPSCI 577 - Synthetic title", { subject: "266", catalog: "577" }])
    assert.equal(resolveCourseIdentity(input, identities).status === "resolved" && (resolveCourseIdentity(input, identities) as { courseKey: string }).courseKey, "uw:266:577");
  assert.equal((resolveCourseIdentity("E C E   252", identities) as { courseKey: string }).courseKey, "uw:320:252");
  assert.equal((resolveCourseIdentity("MATH    240", identities) as { courseKey: string }).courseKey, "uw:266:240");
  assert.equal((resolveCourseIdentity("COMP SCI/MATH 240", identities) as { courseKey: string }).courseKey, "uw:266:240");
  assert.equal(resolveCourseIdentity("COMP SCI/E C E 240", identities).status, "unknown");
  assert.equal(resolveCourseIdentity("Computer Science 577", identities).status, "unknown");
  assert.equal(canonicalizeCourseKey("uw:600:475", identities), "uw:600:475");
});

test("audit select lists inherit subjects without losing unknown prose or ranges", () => {
  assert.deepEqual(parseAuditCourseList("select from MATH 240, 475; E C E 252, 354", identities), {
    courseKeys: ["uw:266:240", "uw:600:475", "uw:320:252", "uw:320:354"], unresolved: [],
  });
  const result = parseAuditCourseList("MATH 240, 300-399, 475, MATH 240 or E C E 252", identities);
  assert.deepEqual(result.courseKeys, ["uw:266:240"]);
  assert.deepEqual(result.unresolved, ["300-399", "475", "MATH 240 or E C E 252"]);
  const ambiguous = buildCourseIdentityTable([...subjects, { ...subjects[2], aliases: ["MATH"] }]);
  assert.equal(resolveCourseIdentity("MATH 240", ambiguous).status, "unknown");
  assert.throws(() => buildCourseIdentityTable(subjects, [crosslist, { ...crosslist, canonicalKey: "uw:600:240" }]));
});

test("grades do not silently promote future, planned, IP, dropped or withdrawn courses", () => {
  const classify = (grade: string | null, termCode = "1264", explicitState?: PlanningCourseHistory["state"]) => classifyHistoryState({ grade, termCode, currentTermCode: "1272", explicitState });
  assert.equal(classify("A"), "completed");
  assert.equal(classify("IP"), "in_progress");
  assert.equal(classify("DR"), "dropped");
  assert.equal(classify("W"), "withdrawn");
  assert.equal(classify(null, "1274"), "planned");
  assert.equal(classify("A", "1274"), "planned");
  assert.equal(classify("A", "1264", "planned"), "planned");
  assert.equal(classify(null), "unknown");
  assert.equal(classify("I"), "unknown");
});

test("grade distribution average uses counts, seven UW GPA grades, and explicit exclusions", () => {
  const result = calculateGradeDistributionAverage(distribution());
  assert.equal(result.average, 3);
  assert.equal(result.includedCount, 20);
  assert.equal(result.excludedCount, 4);
  assert.equal(result.totalCount, 24);
  assert.equal(result.status, "known");
  assert.equal(calculateGradeDistributionAverage(distribution({ counts: [{ grade: "S", count: 3 }] })).average, null);
  assert.equal(calculateGradeDistributionAverage(distribution({ coverage: "suppressed" })).average, null);
  assert.equal(calculateGradeDistributionAverage(distribution({ counts: [{ grade: "A", count: -1 }] })).status, "unknown");
  assert.equal(calculateGradeDistributionAverage(distribution({ counts: [{ grade: "A", count: 10 }, { grade: "A", count: 10 }] })).status, "unknown");
});

test("attempt GPA counts repeated attempts independently and reports incomplete evidence", () => {
  const result = calculateAttemptGpa([
    history({ grade: "F", credits: 3 }), history({ id: "repeat", grade: "A", credits: 3 }),
    history({ id: "transfer", grade: "A", credits: 4, gpaEligible: false }),
    history({ id: "pass", grade: "S", gpaEligible: false }),
    history({ id: "planned", state: "planned", grade: null }),
    history({ id: "missing", grade: null }),
  ]);
  assert.equal(result.gpa, 2);
  assert.equal(result.gpaCredits, 6);
  assert.equal(result.includedAttempts, 2);
  assert.equal(result.excludedAttempts, 3);
  assert.equal(result.unknownAttempts, 1);
  assert.equal(result.status, "partial");
  assert.equal(calculateAttemptGpa([]).gpa, null);
});

test("credit ranges need supplied applicable policy and retain unknowns", () => {
  const policy = { minimum: 12, maximum: 18, sourceUrl: "https://registrar.wisc.edu/credit-load-and-ranges/" };
  assert.equal(assessCreditLoad({ courses: [{ min: 12, max: 18 }], policy }).status, "within_range");
  assert.equal(assessCreditLoad({ courses: [{ min: 18, max: 20 }], policy }).status, "conditional");
  assert.equal(assessCreditLoad({ courses: [{ min: 19, max: 19 }], policy }).status, "above_maximum");
  assert.equal(assessCreditLoad({ courses: [{ min: 10, max: 11 }], policy }).status, "below_minimum");
  assert.equal(assessCreditLoad({ courses: [{ min: 3, max: null }], policy }).status, "unknown");
  assert.equal(assessCreditLoad({ courses: [{ min: 12, max: 12 }], policy: null }).status, "unknown");
});

test("AND/OR prerequisites preserve minimum grades, incomplete history, concurrent and planned states", () => {
  const base = { history: [history()], historyComplete: true, targetTermCode: "1272" };
  assert.equal(evaluatePrerequisite(coursePrereq({ minimumGrade: "B" }), base).status, "met");
  assert.equal(evaluatePrerequisite(coursePrereq({ minimumGrade: "A" }), base).status, "unmet");
  assert.equal(evaluatePrerequisite({ kind: "and", children: [coursePrereq(), coursePrereq({ courseKey: "uw:600:475" })] }, base).status, "unmet");
  assert.equal(evaluatePrerequisite({ kind: "or", children: [coursePrereq(), { kind: "unknown", reason: "Unparsed condition" }] }, base).status, "met");
  assert.equal(evaluatePrerequisite({ kind: "and", children: [coursePrereq(), { kind: "unknown", reason: "Unparsed condition" }] }, base).status, "unknown");
  assert.equal(evaluatePrerequisite(coursePrereq(), { ...base, history: [], historyComplete: false }).status, "unknown");
  assert.equal(evaluatePrerequisite(null, base).status, "unknown");
  assert.equal(evaluatePrerequisite({ kind: "none" }, base).status, "met");
  assert.equal(evaluatePrerequisite(coursePrereq(), { ...base, history: [history({ state: "planned", grade: null })] }).status, "unmet");
  assert.equal(evaluatePrerequisite(coursePrereq(), { ...base, history: [history({ state: "in_progress", grade: "IP" })] }).status, "conditional");
  assert.equal(evaluatePrerequisite(coursePrereq(), { ...base, history: [history({ state: "in_progress", termCode: "1272", grade: "IP" })] }).status, "unmet");
  assert.equal(evaluatePrerequisite(coursePrereq({ concurrent: true }), { ...base, history: [], proposedCourseKeys: ["uw:266:300"] }).status, "conditional");
  assert.equal(evaluatePrerequisite(coursePrereq(), { ...base, history: [], proposedCourseKeys: ["uw:266:300"] }).status, "unmet");
  assert.equal(evaluatePrerequisite(coursePrereq(), { ...base, history: [history({ termCode: "1274" })] }).status, "unmet");
});

test("prerequisite crosslisting requires evidenced identity and invalid history stays unknown", () => {
  const base = { history: [history({ courseKey: "uw:600:240" })], historyComplete: true, targetTermCode: "1272" };
  assert.equal(evaluatePrerequisite(coursePrereq({ courseKey: "uw:266:240" }), base).status, "unmet");
  assert.equal(evaluatePrerequisite(coursePrereq({ courseKey: "uw:266:240" }), { ...base, identityTable: identities }).status, "met");
  assert.equal(evaluatePrerequisite(coursePrereq(), { ...base, history: [history({ credits: -1 })] }).status, "unknown");
  assert.equal(evaluatePrerequisite(coursePrereq(), { ...base, history: [history({ grade: null })] }).status, "unknown");
});

test("prerequisite schemas reject empty Boolean nodes, excessive depth, extra fields and cycles", () => {
  assert.equal(prerequisiteSchema.safeParse({ kind: "and", children: [] }).success, false);
  assert.equal(prerequisiteSchema.safeParse({ kind: "none", studentId: "private" }).success, false);
  let nested: Prerequisite = { kind: "none" };
  for (let i = 0; i < 20; i++) nested = { kind: "and", children: [nested] };
  assert.equal(prerequisiteSchema.safeParse(nested).success, false);
  const cycle: { kind: string; children: unknown[] } = { kind: "and", children: [] }; cycle.children.push(cycle);
  assert.equal(prerequisiteSchema.safeParse(cycle).success, false);
});

test("meeting normalization preserves Thursday, rejects partial minutes and unknown days", () => {
  assert.deepEqual(normalizeMeetingDays("M W R"), { days: [1, 3, 4], unknown: false });
  assert.equal(normalizeMeetingDays("TBA").unknown, true);
  assert.equal(millisecondsToMinute(34200000), 570);
  assert.equal(millisecondsToMinute(34200001), null);
  assert.equal(millisecondsToMinute(86400000), null);
});

test("meeting conflicts require overlapping times and an actual common date and weekday", () => {
  assert.equal(checkMeetingConflict(meeting(), meeting({ startMinute: 580, endMinute: 630 })).status, "conflict");
  assert.equal(checkMeetingConflict(meeting(), meeting({ startMinute: 590, endMinute: 630 })).status, "clear");
  assert.equal(checkMeetingConflict(meeting(), meeting({ days: [2, 4] })).status, "clear");
  assert.equal(checkMeetingConflict(meeting(), meeting({ startDate: "2027-01-10", endDate: "2027-05-10" })).status, "clear");
  assert.equal(checkMeetingConflict(meeting({ days: [1], startDate: "2026-09-01", endDate: "2026-09-02" }), meeting({ days: [1], startDate: "2026-09-01", endDate: "2026-09-02" })).status, "clear");
  assert.equal(checkMeetingConflict(meeting(), meeting({ startDate: null })).status, "unknown");
  assert.equal(checkMeetingConflict(meeting(), meeting({ startMinute: null })).status, "unknown");
  assert.equal(checkMeetingConflict(meeting(), meeting({ endMinute: 100 })).status, "unknown");
  assert.equal(checkMeetingConflict(meeting(), meeting({ mode: "asynchronous", days: [], startMinute: null, endMinute: null })).status, "clear");
});

test("section packages compare all required meetings, flag exam conflicts and incomplete schedules", () => {
  const candidate = packageRow({ meetings: [meeting({ days: [2] }), meeting({ kind: "exam", days: [4], startMinute: 1140, endMinute: 1200 })] });
  const enrolled = packageRow({ id: "enrolled", enrollmentState: "enrolled", meetings: [meeting({ days: [4], startMinute: 1140, endMinute: 1170 })] });
  const result = checkPackageConflicts(candidate, [enrolled]);
  assert.equal(result.status, "conflict");
  assert.equal(result.conflicts[0].kind, "exam");
  assert.equal(checkPackageConflicts(packageRow({ meetings: [], meetingsComplete: false }), []).status, "unknown");
  assert.equal(checkPackageConflicts(packageRow(), [packageRow({ meetings: [], meetingsComplete: false })]).status, "unknown");
  assert.equal(checkPackageConflicts(packageRow({ meetings: [meeting({ mode: "unknown" })] }), []).status, "unknown");
  assert.equal(checkPackageConflicts(packageRow({ meetings: [meeting({ startDate: null })] }), []).status, "unknown");
  assert.equal(checkPackageConflicts(packageRow({ meetings: [meeting({ startMinute: null })] }), []).status, "unknown");
  assert.equal(checkPackageConflicts(packageRow({ meetings: [meeting(), meeting({ startMinute: 580, endMinute: 620 })] }), []).status, "conflict");
});

test("normalized audit tree supports different names, nested flags, unknown blocks and select lists", () => {
  const audit = auditFrom([
    { kind: "heading", blockId: "h0", nodeId: "root", parentId: null, title: "Synthetic L&S degree", rawStatus: "OK", flags: [], quote: "OK Synthetic L&S degree" },
    { kind: "heading", blockId: "h1", nodeId: "sub", parentId: "root", title: "Scientific breadth", rawStatus: "OK", flags: ["+"], quote: "+ Scientific breadth" },
    { kind: "select_from", blockId: "s1", text: "MATH    240, 475", quote: "SELECT FROM MATH    240, 475" },
    { kind: "applied", blockId: "a1", course: "MATH    240", term: "FA26", credits: 3, grade: "IP", flags: ["IP"], quote: "FA26 MATH    240 3 IP" },
    { kind: "unknown", blockId: "u1", quote: "Unrecognized exception code" },
  ]);
  assert.equal(planningAuditSchema.safeParse(audit).success, true);
  assert.equal(audit.nodes[1].parentId, "root");
  assert.deepEqual(audit.nodes[1].acceptableCourseKeys, ["uw:266:240", "uw:600:475"]);
  assert.equal(audit.nodes[1].status, "in_progress");
  assert.equal(audit.nodes[0].status, "in_progress");
  assert.equal(audit.nodes[2].kind, "unknown");
  assert.equal(audit.coverage, "partial");
  const planned = auditFrom([
    { kind: "heading", blockId: "h", nodeId: "node", parentId: null, title: "Future requirement", rawStatus: "OK", flags: [], quote: "OK" },
    { kind: "applied", blockId: "a", course: "COMP SCI 577", term: "SP27", credits: 3, grade: null, flags: ["PL"], quote: "SP27 COMP SCI 577 PL" },
  ]);
  assert.equal(planned.nodes[0].status, "planned");
});

test("potential coverage traces source evidence and never promises double counting", () => {
  const engineering = auditFrom(openBlocks);
  const letters = auditFrom(openBlocks.map((block) => block.kind === "heading" ? { ...block, title: "Synthetic L&S elective" } : block), { id: "audit-2" });
  const result = potentialAuditCoverage("uw:266:400", [engineering, letters]);
  assert.equal(result.matches.length, 2);
  assert.equal(result.multipleRequirements, true);
  assert.equal(result.doubleCounting, "not_established");
  assert.equal(result.matches[0].provenance.sourceUrl, "https://enroll.wisc.edu/");
  assert.equal(potentialAuditCoverage("uw:266:300", [engineering]).matches.length, 0);
  assert.equal(potentialAuditCoverage("uw:266:400", []).coverage, "unknown");
  const noEvidence = structuredClone(engineering); noEvidence.nodes[0].evidence = [];
  assert.equal(potentialAuditCoverage("uw:266:400", [noEvidence]).matches.length, 0);
});

test("strict normalized captures reject identity extras, mixed scope and unsafe evidence URLs", () => {
  const row = history();
  const capture: PlanningCapture = { schemaVersion: 1, id: "capture-1", accountScope: "synthetic-account-hash", source: "normalized_import", scope: row.provenance.scope,
    sourceUrl: row.provenance.sourceUrl, observedAt: row.provenance.observedAt, status: "complete", completeness: "complete", records: [row], diagnostics: [] };
  assert.equal(planningCaptureSchema.safeParse(capture).success, true);
  assert.equal(planningCaptureSchema.safeParse({ ...capture, studentName: "Private" }).success, false);
  assert.equal(planningRecordSchema.safeParse({ ...row, netId: "Private" }).success, false);
  assert.equal(planningCaptureSchema.safeParse({ ...capture, records: [catalog()] }).success, false);
  assert.equal(planningCaptureSchema.safeParse({ ...capture, records: [row, row] }).success, false);
  assert.equal(planningCaptureSchema.safeParse({ ...capture, status: "failed" }).success, false);
  assert.equal(planningCaptureSchema.safeParse({ ...capture, sourceUrl: "https://enroll.wisc.edu/?token=secret" }).success, false);
  assert.equal(planningCaptureSchema.safeParse({ ...capture, sourceUrl: "bad" }).success, false);
  assert.equal(planningCatalogCourseSchema.safeParse(catalog({ termCode: null })).success, true);
  const cycle = auditFrom(openBlocks); cycle.nodes[0].parentId = cycle.nodes[0].nodeId;
  assert.equal(planningAuditSchema.safeParse(cycle).success, false);
});

test("normal planning journey ranks real open coverage by progress then schedule, grades remain evidence", () => {
  const audit = auditFrom(openBlocks);
  const candidate = (key: string, progress: number, penalty: number): PlanningCandidate => ({
    course: catalog({ courseKey: key }), package: packageRow({ courseKey: key }), requirementMatches: potentialAuditCoverage(key, [audit]).matches,
    prerequisite: evaluatePrerequisite(coursePrereq(), { history: [history()], historyComplete: true, targetTermCode: "1272" }),
    schedule: checkPackageConflicts(packageRow({ meetings: [meeting({ days: [2] })] }), [packageRow({ enrollmentState: "enrolled" })]),
    progress: { unlocksRequirements: progress, coreWithFewOptions: 0, electives: 0, generalEducation: 0 }, schedulePenalty: penalty,
  });
  const a = candidate("uw:266:400", 2, 10), b = candidate("uw:266:577", 1, 0);
  a.gradeEvidence = calculateGradeDistributionAverage(distribution({ counts: [{ grade: "C", count: 100 }] }));
  b.gradeEvidence = calculateGradeDistributionAverage(distribution({ counts: [{ grade: "A", count: 100 }] }));
  assert.equal(rankPlanningCandidates([b, a], [history()])[0].course.courseKey, a.course.courseKey);
  b.progress.unlocksRequirements = 2;
  assert.equal(rankPlanningCandidates([a, b], [history()])[0].course.courseKey, b.course.courseKey);
  assert.equal(rankPlanningCandidates([a, b], [history({ courseKey: "uw:266:577" })]).length, 1);
  assert.equal(rankPlanningCandidates([a], [history({ courseKey: "uw:266:400", state: "planned", grade: null })]).length, 1);
  assert.equal(rankPlanningCandidates([{ ...a, prerequisite: { status: "unmet", reasons: [] } }], []).length, 0);
  assert.equal(rankPlanningCandidates([{ ...a, schedule: { status: "conflict", conflicts: [], unknownPairs: 0 } }], []).length, 0);
  assert.equal(rankPlanningCandidates([{ ...a, requirementMatches: [] }], []).length, 0);
});
