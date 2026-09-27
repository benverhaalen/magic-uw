import type {
  PlanningComparison, Store, PlanningRecord, PlanningCatalogCourse, PlanningEnrollmentPackage,
  StoredPlanningRecord, PlanningGradeDistribution,
} from "@magic/contracts";
import {
  buildCourseIdentityTable, canonicalizeCourseKey, potentialAuditCoverage, evaluatePrerequisite,
  checkPackageConflicts, rankPlanningCandidates, calculateGradeDistributionAverage, decodeUwTerm,
  type PlanningCandidate, type CourseIdentityTable,
} from "../../domain/src/planning";

const DAY = 24 * 60 * 60 * 1000;
// Storage metadata is local bookkeeping, not part of the strict evidence contract.
function evidenceRecord<T extends StoredPlanningRecord>(row: T): Omit<T, "localId" | "sourceId" | "accountScope" | "contentHash" | "version" | "deleted"> {
  const { localId, sourceId, accountScope, contentHash, version, deleted, ...record } = row;
  return record;
}
const publicKinds = new Set<PlanningRecord["kind"]>(["subject", "crosslist", "term", "catalog_course", "enrollment_package", "grade_distribution"]);

export function comparePlanning(store: Store, termCode: string, style: "balanced" | "mornings" | "compact" | "lighter", now: string): PlanningComparison {
  const result: PlanningComparison = { termCode, createdAt: now, warnings: [], candidates: [] };
  if (!/^1\d{2}[246]$/.test(termCode) || !Number.isFinite(Date.parse(now))) {
    result.warnings.push("The requested term or comparison time is invalid."); return result;
  }
  const fresh = (stamp: string | null, maximumAge = DAY) => {
    const age = stamp === null ? Number.NaN : Date.parse(now) - Date.parse(stamp);
    return Number.isFinite(age) && age >= 0 && age <= maximumAge;
  };
  const all = store.planningRecords().filter((record) => !record.deleted);
  const accounts = [...new Set(all.filter((record) => record.accountScope !== "public").map((record) => record.accountScope))];
  if (accounts.length !== 1) {
    result.warnings.push(accounts.length ? "More than one student record is present. Separate the accounts before comparing courses." : "Connect a student record and degree audit to compare courses against your requirements.");
    return result;
  }
  const account = accounts[0];
  const rows = all.filter((record) => record.accountScope === account || record.accountScope === "public" && publicKinds.has(record.kind));
  const ofKind = <K extends PlanningRecord["kind"]>(kind: K) => rows.filter((row): row is Extract<typeof row, { kind: K }> => row.kind === kind);
  const subjects = ofKind("subject"), crosslists = ofKind("crosslist"), history = ofKind("course_history"), audits = ofKind("audit");
  let table: CourseIdentityTable;
  try { table = buildCourseIdentityTable(subjects, crosslists); }
  catch {
    // Discarding one side could suggest an equivalent course already taken. Require corrected evidence.
    result.warnings.push("Saved cross-list mappings disagree. Course equivalence is unknown; refresh the subject and cross-list evidence before comparing.");
    return result;
  }
  const sources = store.planningSources();
  const sourceMap = new Map(sources.map((source) => [source.id, source]));
  const health = sources.filter((source) => source.accountScope === account);
  const completeSource = (source: typeof sources[number]) => source.status === "complete" && source.completeness === "complete" && fresh(source.observedAt);
  const freshRecord = (row: StoredPlanningRecord) => {
    const source = sourceMap.get(row.sourceId);
    return Boolean(source && completeSource(source) && fresh(row.provenance.observedAt));
  };
  // The current-enrollment feed contributes known current/dropped rows, but its
  // deliberately partial history scope does not describe a whole transcript.
  const isFullHistory = (scope: { kind: string; key: string }) => scope.kind === "degree_plan" && !scope.key.startsWith("current-enrollment:");
  const historyScopes = health.filter((source) => isFullHistory(source.scope));
  const freshHistory = history.filter((row) => {
    const source = sourceMap.get(row.sourceId);
    return Boolean(source && ["complete", "partial"].includes(source.status) && fresh(source.observedAt) && fresh(row.provenance.observedAt));
  });
  const authoritativeHistory = history.filter((row) => isFullHistory(row.provenance.scope));
  const historyComplete = historyScopes.length > 0 && historyScopes.every(completeSource) && authoritativeHistory.every(freshRecord);
  const enrollmentScopes = health.filter((source) => source.scope.kind === "enrollment_term" && source.scope.key === termCode);
  const enrollmentComplete = enrollmentScopes.length > 0 && enrollmentScopes.every(completeSource);
  if (!historyComplete) result.warnings.push("Course history is incomplete or needs refresh; stale history cannot confirm prerequisites.");
  if (!enrollmentComplete) result.warnings.push("Enrollment for this term is incomplete or needs refresh; schedule fit is not confirmed.");
  if (!audits.length) result.warnings.push("No parsed degree audit is available. Catalog courses alone cannot establish requirement progress.");
  if (audits.some((audit) => audit.coverage !== "complete" || !fresh(audit.generatedAt, 7 * DAY) || !freshRecord(audit))) result.warnings.push("Some audit evidence is incomplete or needs refresh. Requirement matches are provisional; check the latest official audit.");
  result.warnings.push("Each option is checked against saved enrollment individually. These options are not a conflict-free combined schedule; multiple requirement matches do not establish permission to double count.");
  const packages = ofKind("enrollment_package").filter((pkg) => pkg.termCode === termCode);
  const enrolled = packages.filter((pkg) => pkg.accountScope === account && pkg.enrollmentState === "enrolled" && pkg.provenance.scope.kind === "enrollment_term" && pkg.provenance.scope.key === termCode);
  const enrollmentKnown = enrollmentComplete && enrolled.every(freshRecord);
  const grades = ofKind("grade_distribution");
  // Topic variants share a catalog number but not necessarily a title, prerequisite,
  // requirement applicability, or section set. Keep them browsable; this comparator
  // cannot yet represent topic-specific audit eligibility.
  const topicKeys = new Set(ofKind("catalog_course")
    .filter(course => course.termCode === termCode && /^course:1\d{2}[246]:\d{1,6}:\d+\.\d+$/.test(course.id))
    .map(course => canonicalizeCourseKey(course.courseKey, table)));
  if (topicKeys.size) result.warnings.push("Topic-specific courses remain in the catalog but are excluded from automatic comparison until their requirement and section identities can be checked separately.");
  const courses = new Map<string, PlanningCatalogCourse>();
  for (const course of ofKind("catalog_course")) {
    if (course.termCode !== null && course.termCode !== termCode) continue;
    const key = canonicalizeCourseKey(course.courseKey, table), previous = courses.get(key);
    if (topicKeys.has(key)) continue;
    if (!previous || (course.termCode === termCode && previous.termCode === null) || (course.termCode === previous.termCode && course.provenance.observedAt > previous.provenance.observedAt)) courses.set(key, course);
  }
  const candidates: PlanningCandidate[] = [];
  const gradeEvidence = new Map<PlanningCandidate, PlanningGradeDistribution>();
  let stalePrerequisites = false, staleSections = false, ambiguousGrades = false;
  function penalty(pkg: PlanningEnrollmentPackage | null, course: PlanningCatalogCourse, scheduleKnown: boolean): number | null {
    if (style === "lighter") return course.creditMax;
    if (!pkg || !scheduleKnown) return null;
    const minutes = Array<number>(7).fill(0), spans = Array.from({ length: 7 }, () => [] as [number, number][]);
    for (const item of [...enrolled, pkg]) for (const meeting of item.meetings) {
      if (meeting.kind !== "class" || meeting.mode !== "scheduled" || meeting.startMinute === null || meeting.endMinute === null) continue;
      for (const day of meeting.days) { minutes[day - 1] += meeting.endMinute - meeting.startMinute; spans[day - 1].push([meeting.startMinute, meeting.endMinute]); }
    }
    if (style === "compact") return spans.reduce((sum, intervals) => {
      intervals.sort((a, b) => a[0] - b[0]); let end: number | null = null;
      for (const [start, finish] of intervals) { if (end !== null) sum += Math.max(0, start - end); end = Math.max(end ?? 0, finish); } return sum;
    }, 0);
    return Math.max(...minutes);
  }
  for (const course of courses.values()) {
    const coverage = potentialAuditCoverage(course.courseKey, audits.map(evidenceRecord), table);
    if (!coverage.matches.length) continue;
    const wireCourse = course.id.match(/^course:(1\d{2}[246]):(\d{1,6}):(\d{1,12})$/);
    const available = packages.filter((pkg) => canonicalizeCourseKey(pkg.courseKey, table) === canonicalizeCourseKey(course.courseKey, table) && pkg.enrollmentState !== "enrolled" &&
      (!wireCourse || pkg.provenance.scope.key === `public-packages:${wireCourse[1]}:${wireCourse[2]}:${wireCourse[3]}`));
    const historicalRows = grades.filter((grade) => canonicalizeCourseKey(grade.courseKey, table) === canonicalizeCourseKey(course.courseKey, table) && grade.termCode < termCode);
    const latestGradeTerm = historicalRows.map((grade) => grade.termCode).sort().at(-1);
    const latestGrades = historicalRows.filter((grade) => grade.termCode === latestGradeTerm);
    // Section IDs repeat across terms. Do not pick or combine an arbitrary row, including cross-list duplicates.
    // A source that saves one course-level row beside its section rows (Madgrades) supplies that row;
    // two course-level rows for the term remain ambiguous.
    const courseLevelGrades = latestGrades.filter((grade) => grade.section === null);
    const previousGrade = courseLevelGrades.length === 1 ? courseLevelGrades[0] : latestGrades.length === 1 ? latestGrades[0] : null;
    if (!previousGrade && latestGrades.length > 1) ambiguousGrades = true;
    const prerequisiteFresh = fresh(course.prerequisiteCheckedAt, 7 * DAY);
    if (course.prerequisite !== null && !prerequisiteFresh) stalePrerequisites = true;
    for (const pkg of available.length ? available : [null]) {
      if (style === "mornings" && pkg?.meetings.some((meeting) => meeting.kind === "class" && meeting.mode === "scheduled" && meeting.endMinute !== null && meeting.endMinute > 12 * 60)) continue;
      const schedule = pkg ? checkPackageConflicts(pkg, enrolled) : { status: "unknown" as const, conflicts: [], unknownPairs: 1 };
      const packageFresh = pkg !== null && freshRecord(pkg);
      if (pkg && !packageFresh) staleSections = true;
      if ((!enrollmentKnown || !packageFresh) && schedule.status === "clear") schedule.status = "unknown";
      const candidate: PlanningCandidate = { course, package: pkg, requirementMatches: coverage.matches,
        prerequisite: evaluatePrerequisite(prerequisiteFresh ? course.prerequisite : null, { history: freshHistory.map(evidenceRecord), historyComplete, targetTermCode: termCode, identityTable: table }),
        schedule, progress: {
          // No inferred unlock graph. A single complete, evidenced option is the only proven scarcity here.
          unlocksRequirements: 0,
          coreWithFewOptions: coverage.matches.filter((match) => {
            const node = audits.find((audit) => audit.id === match.auditId)?.nodes.find((node) => node.nodeId === match.nodeId);
            return match.requirementKind === "major_core" && node?.coverage === "complete" && (node.needsCourses ?? 0) > 0 && new Set(node.acceptableCourseKeys.map((key) => canonicalizeCourseKey(key, table))).size === 1;
          }).length,
          electives: coverage.matches.filter((match) => match.requirementKind === "elective").length,
          generalEducation: coverage.matches.filter((match) => ["breadth", "communication", "quantitative", "ethnic_studies"].includes(match.requirementKind)).length,
        }, schedulePenalty: penalty(pkg, course, schedule.status === "clear"),
        ...(previousGrade ? { gradeEvidence: calculateGradeDistributionAverage(evidenceRecord(previousGrade)) } : {}),
      };
      candidates.push(candidate);
      if (previousGrade) gradeEvidence.set(candidate, previousGrade);
    }
  }
  if (stalePrerequisites) result.warnings.push("Some prerequisite evidence is undated or needs refresh; it remains unknown.");
  if (staleSections) result.warnings.push("Some section evidence needs refresh. Saved meetings cannot confirm schedule fit and seat counts are not current.");
  if (ambiguousGrades) result.warnings.push("Several grade rows describe the latest historical term. No arbitrary section average or combined average is shown.");
  result.candidates = rankPlanningCandidates(candidates, history, table).slice(0, 50).map((row) => {
    const grade = gradeEvidence.get(row);
    const pkg = packages.find((pkg) => pkg === row.package);
    const packageFresh = pkg !== undefined && freshRecord(pkg);
    const hasAverage = row.gradeEvidence?.average !== null && row.gradeEvidence?.average !== undefined;
    return {
      courseKey: row.course.courseKey, title: row.course.title, packageId: row.package?.id ?? null,
      requirements: row.requirementMatches.map((match) => match.title), multipleRequirements: row.requirementMatches.length > 1,
      prerequisite: row.prerequisite.status, prerequisiteReasons: row.prerequisite.reasons,
      schedule: row.schedule.status, scheduleReasons: row.schedule.status === "clear" ? ["No overlap with saved enrolled meetings."] : ["Meeting times or enrollment for this term are incomplete or need refresh; confirm in Course Search & Enroll."],
      creditMin: row.course.creditMin, creditMax: row.course.creditMax, seatsAvailable: packageFresh ? row.package?.seatsAvailable ?? null : null,
      seatStatus: row.package ? packageFresh ? row.package.status : "Seats need refresh" : "Offering not verified", sourceUrl: row.course.provenance.sourceUrl,
      observedAt: row.package?.provenance.observedAt ?? row.course.provenance.observedAt,
      evidence: [{ label: "Course", url: row.course.provenance.sourceUrl, observedAt: row.course.provenance.observedAt },
        ...row.requirementMatches.map((match) => ({ label: "Audit", url: match.provenance.sourceUrl, observedAt: match.provenance.observedAt })),
        ...(row.package ? [{ label: "Sections", url: row.package.provenance.sourceUrl, observedAt: row.package.provenance.observedAt }] : []),
        ...(grade && hasAverage ? [{ label: `Grades · ${decodeUwTerm(grade.termCode).label}${grade.section ? ` · Section ${grade.section}` : " · Course data"}${grade.coverage === "partial" ? " · Partial" : ""}`, url: grade.provenance.sourceUrl, observedAt: grade.provenance.observedAt }] : [])],
      historicalAverage: row.gradeEvidence?.average ?? null, historicalCount: hasAverage ? row.gradeEvidence?.includedCount ?? null : null,
    };
  });
  return result;
}
