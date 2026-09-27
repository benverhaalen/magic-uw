import type {
  PlanningComparison, Store, PlanningRecord, PlanningCatalogCourse, PlanningEnrollmentPackage,
  StoredPlanningRecord, PlanningGradeDistribution, PlanningCapture, PlanningSourceHealth, PlanningSubject,
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
// owner: planning-perf. Semester-scale freshness and cadence. UW planning data changes per term,
// except enrollment during add/drop. An unknown add/drop window counts as add/drop (the
// conservative, fresher side): no Registrar dates are stored yet.
export const PLANNING_ADD_DROP_MS = 7 * DAY;
export const PLANNING_TERM_MS = 120 * DAY;
export type PlanningEvidenceKind = "enrollment" | "history" | "audit" | "catalog" | "public";
export interface PlanningAddDropWindow { start: string; end: string }
export function inAddDrop(now: string, window: PlanningAddDropWindow | null | undefined): boolean {
  if (!window) return true;
  const at = Date.parse(now), start = Date.parse(window.start), end = Date.parse(window.end);
  if (![at, start, end].every(Number.isFinite) || start > end) return true;
  return at >= start && at <= end;
}
/** How long evidence of one kind stays fresh. */
export function planningHorizon(kind: PlanningEvidenceKind, now: string, addDrop?: PlanningAddDropWindow | null): number {
  return kind === "enrollment" && inAddDrop(now, addDrop) ? PLANNING_ADD_DROP_MS : PLANNING_TERM_MS;
}
export function planningEvidenceKind(scopeKind: PlanningCapture["scope"]["kind"]): PlanningEvidenceKind {
  return scopeKind === "enrollment_term" ? "enrollment" : scopeKind === "degree_plan" ? "history"
    : scopeKind === "audit_program" ? "audit" : scopeKind === "catalog_term" ? "catalog" : "public";
}
/** The horizons comparePlanning applies. `legacy` is the previous one-day (audit seven-day) rule. */
export type PlanningHorizons = (kind: PlanningEvidenceKind | "prerequisite") => number;
export const legacyPlanningHorizons: PlanningHorizons = (kind) => kind === "audit" || kind === "prerequisite" ? 7 * DAY : DAY;
export const semesterPlanningHorizons = (now: string, addDrop?: PlanningAddDropWindow | null): PlanningHorizons =>
  (kind) => planningHorizon(kind === "prerequisite" ? "catalog" : kind, now, addDrop);

const age = (now: string, stamp: string | null | undefined) => {
  const value = stamp ? Date.parse(now) - Date.parse(stamp) : Number.NaN;
  return Number.isFinite(value) && value >= 0 ? value : Number.POSITIVE_INFINITY;
};
/** A public source (terms, subjects) read successfully within one term needs no re-read. */
export function publicSourceTermFresh(source: PlanningSourceHealth | undefined, now: string): boolean {
  return Boolean(source && (source.status === "complete" || source.status === "partial") && age(now, source.observedAt) < PLANNING_TERM_MS);
}
/** The verified private sync (identity checked before and after), newest first. */
function verifiedSyncs(store: Pick<Store, "planningSources">) {
  return store.planningSources()
    .filter((source) => source.source === "uw_enroll" && source.accountScope !== "public" && source.scope.kind === "student_record" && source.scope.key === "connection:student-info")
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt));
}
/**
 * A scheduled refresh is due weekly during add/drop and once per term otherwise, only after the
 * student has connected once, and at most once a day after an attempt.
 */
export function planningRefreshDue(store: Pick<Store, "planningSources">, now: string, addDrop?: PlanningAddDropWindow | null): boolean {
  const syncs = verifiedSyncs(store);
  const lastSuccess = syncs.map((source) => source.lastSuccessAt).filter((stamp): stamp is string => Boolean(stamp)).sort().at(-1);
  if (!lastSuccess) return false;
  if (age(now, syncs[0]?.observedAt) < DAY) return false;
  return age(now, lastSuccess) >= (inAddDrop(now, addDrop) ? PLANNING_ADD_DROP_MS : PLANNING_TERM_MS);
}
export interface StoredAuditReport { accountScope: string; reportId: string }
const reportIdOf = (url: string) => url.match(/\/api\/dars\/reports\/(\d{1,30})$/)?.[1] ?? null;
/** Saved DARS reports stored with complete coverage; a saved report ID names one immutable run. */
export function storedAuditReports(store: Pick<Store, "planningSources" | "planningRecords">): StoredAuditReport[] {
  const audits = store.planningRecords().filter((row) => row.kind === "audit" && !row.deleted);
  return store.planningSources().flatMap((source) => {
    const reportId = reportIdOf(source.sourceUrl);
    if (source.source !== "uw_dars" || source.scope.kind !== "audit_program" || source.accountScope === "public" || !reportId ||
      source.status !== "complete" || source.completeness !== "complete") return [];
    const rows = audits.filter((row) => row.sourceId === source.id);
    return rows.length && rows.every((row) => row.kind === "audit" && row.coverage === "complete" && row.nodes.every((node) => node.coverage === "complete"))
      ? [{ accountScope: source.accountScope, reportId }] : [];
  }).slice(0, 1000);
}
/** A stored report the sync skipped, re-observed now: same records, a new observation, no download. */
export function reconfirmedAuditCaptures(
  store: Pick<Store, "planningSources" | "planningRecords">,
  reconfirmed: ReadonlyArray<{ accountScope: string; scopeKey: string; reportId: string }>,
  observedAt: string,
): PlanningCapture[] {
  if (!reconfirmed.length) return [];
  const sources = store.planningSources(), records = store.planningRecords();
  return reconfirmed.flatMap((item) => {
    const source = sources.find((entry) => entry.source === "uw_dars" && entry.accountScope === item.accountScope &&
      entry.scope.kind === "audit_program" && entry.scope.key === item.scopeKey && reportIdOf(entry.sourceUrl) === item.reportId &&
      entry.status === "complete" && entry.completeness === "complete");
    if (!source || Date.parse(observedAt) <= Date.parse(source.observedAt)) return [];
    const rows = records.filter((row) => row.sourceId === source.id && !row.deleted);
    if (!rows.length) return [];
    return [{
      schemaVersion: 1 as const, id: `saved-audit-reconfirmed-${item.scopeKey}-${observedAt}`, source: "uw_dars" as const,
      accountScope: source.accountScope, scope: source.scope, sourceUrl: source.sourceUrl, observedAt,
      status: "complete" as const, completeness: "complete" as const,
      records: rows.map((row) => ({ ...evidenceRecord(row), provenance: { ...row.provenance, observedAt } }) as PlanningRecord),
      diagnostics: [{ code: "saved_audit_reconfirmed", message: "The saved report listed by DARS is already stored with complete coverage; it was not downloaded again." }],
    }];
  });
}
/** Stored search subjects while both public search reads are term-fresh, else null (read them). */
export function termFreshSearchSubjects(store: Pick<Store, "planningSources" | "planningRecords">, now: string): PlanningSubject[] | null {
  const sources = store.planningSources().filter((source) => source.source === "uw_public" && source.accountScope === "public");
  const terms = sources.find((source) => source.scope.kind === "terms" && source.scope.key === "public-search-terms");
  const subjects = sources.find((source) => source.scope.kind === "subjects" && source.scope.key === "search-subjects-map:0000");
  if (!subjects || subjects.status !== "complete" || !publicSourceTermFresh(terms, now) || !publicSourceTermFresh(subjects, now)) return null;
  const rows = store.planningRecords().flatMap((row) => row.sourceId === subjects.id && !row.deleted && row.kind === "subject" ? [evidenceRecord(row) as PlanningSubject] : []);
  return rows.length ? rows : null;
}
// end owner: planning-perf

const publicKinds = new Set<PlanningRecord["kind"]>(["subject", "crosslist", "term", "catalog_course", "enrollment_package", "grade_distribution"]);

export function comparePlanning(store: Store, termCode: string, style: "balanced" | "mornings" | "compact" | "lighter", now: string,
  // Default stays the legacy rule until planning-core tests 56/87 (6-day "stale" fixtures) move past a term.
  horizons: PlanningHorizons = legacyPlanningHorizons): PlanningComparison {
  const result: PlanningComparison = { termCode, createdAt: now, warnings: [], candidates: [] };
  if (!/^1\d{2}[246]$/.test(termCode) || !Number.isFinite(Date.parse(now))) {
    result.warnings.push("The requested term or comparison time is invalid."); return result;
  }
  const fresh = (stamp: string | null, maximumAge: number) => {
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
  const horizonOf = (source: typeof sources[number]) => horizons(planningEvidenceKind(source.scope.kind));
  const completeSource = (source: typeof sources[number]) => source.status === "complete" && source.completeness === "complete" && fresh(source.observedAt, horizonOf(source));
  const freshRecord = (row: StoredPlanningRecord) => {
    const source = sourceMap.get(row.sourceId);
    // Seat counts follow enrollment freshness whichever scope carried them.
    return Boolean(source && completeSource(source) && fresh(row.provenance.observedAt, row.kind === "enrollment_package" ? horizons("enrollment") : horizonOf(source)));
  };
  // The current-enrollment feed contributes known current/dropped rows, but its
  // deliberately partial history scope does not describe a whole transcript.
  const isFullHistory = (scope: { kind: string; key: string }) => scope.kind === "degree_plan" && !scope.key.startsWith("current-enrollment:");
  const historyScopes = health.filter((source) => isFullHistory(source.scope));
  const freshHistory = history.filter((row) => {
    const source = sourceMap.get(row.sourceId);
    return Boolean(source && ["complete", "partial"].includes(source.status) && fresh(source.observedAt, horizonOf(source)) && fresh(row.provenance.observedAt, horizonOf(source)));
  });
  const authoritativeHistory = history.filter((row) => isFullHistory(row.provenance.scope));
  const historyComplete = historyScopes.length > 0 && historyScopes.every(completeSource) && authoritativeHistory.every(freshRecord);
  const enrollmentScopes = health.filter((source) => source.scope.kind === "enrollment_term" && source.scope.key === termCode);
  const enrollmentComplete = enrollmentScopes.length > 0 && enrollmentScopes.every(completeSource);
  if (!historyComplete) result.warnings.push("Course history is incomplete or needs refresh; stale history cannot confirm prerequisites.");
  if (!enrollmentComplete) result.warnings.push("Enrollment for this term is incomplete or needs refresh; schedule fit is not confirmed.");
  if (!audits.length) result.warnings.push("No parsed degree audit is available. Catalog courses alone cannot establish requirement progress.");
  if (audits.some((audit) => audit.coverage !== "complete" || !fresh(audit.generatedAt, horizons("audit")) || !freshRecord(audit))) result.warnings.push("Some audit evidence is incomplete or needs refresh. Requirement matches are provisional; check the latest official audit.");
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
    const prerequisiteFresh = fresh(course.prerequisiteCheckedAt, horizons("prerequisite"));
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
