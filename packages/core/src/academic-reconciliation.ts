import type { AcademicClaim, AcademicReconciliation, Store } from "@magic/contracts";
import { buildCourseIdentityTable, canonicalizeCourseKey, parseAuditCourseTerm, parseUwTermLabel, resolveCourseIdentity, type CourseIdentityTable } from "../../domain/src/planning";

/** Compare claims about an exact course attempt. Never fill a missing grade from
 * another source, add duplicate credits, or turn an LMS result into mastery. */
export function reconcileAcademicRecords(store: Store, now: string): AcademicReconciliation {
  const result: AcademicReconciliation = { status: "available", warnings: [], unresolvedCanvasCourses: 0, attempts: [] };
  const records = store.planningRecords().filter(r => !r.deleted);
  const sources = new Map(store.planningSources().map(s => [s.id, s]));
  const accounts = [...new Set(records.filter(r => r.accountScope !== "public").map(r => r.accountScope))];
  if (accounts.length > 1) return { ...result, status: "multiple_accounts", warnings: ["Several student accounts are saved. Their academic claims cannot be combined."] };
  const recent = (stamp: string) => Date.parse(now) >= Date.parse(stamp) && Date.parse(now) - Date.parse(stamp) <= 86_400_000;
  const fresh = (r: typeof records[number]) => {
    const source = sources.get(r.sourceId);
    return Boolean(source && ["complete", "partial"].includes(source.status) && recent(source.observedAt) && recent(r.provenance.observedAt));
  };
  const links = records.filter(r => r.kind === "account_link").filter(r => fresh(r) && sources.get(r.sourceId)?.status === "complete" && sources.get(r.sourceId)?.completeness === "complete");
  const canvasAccounts = new Set(links.map(r => r.canvasAccountScope));
  if (accounts.length !== 1 || canvasAccounts.size !== 1) {
    return { ...result, status: "unlinked", warnings: ["Refresh planning to verify that Canvas and the student record belong to the same UW login before comparing them."] };
  }
  let table: CourseIdentityTable;
  try { table = buildCourseIdentityTable(records.filter(r => r.kind === "subject"), records.filter(r => r.kind === "crosslist")); }
  catch { return { ...result, status: "unlinked", warnings: ["Course equivalence mappings conflict. Source claims remain separate."] }; }
  const attempts = new Map<string, AcademicReconciliation["attempts"][number]>();
  function add(courseKey: string, termCode: string | null, claim: AcademicClaim) {
    if (!termCode) return; // No match across unknown terms or repeated attempts.
    const canonical = canonicalizeCourseKey(courseKey, table), key = `${canonical}:${termCode}`;
    const attempt = attempts.get(key) ?? { courseKey: canonical, termCode, claims: [], differences: [], coverage: "academic_only" };
    // A DARS course often appears in several requirement blocks; one appearance
    // per report/value is evidence, never another attempt or additional credit.
    if (!attempt.claims.some(c => c.source === claim.source && c.recordId === claim.recordId && c.grade === claim.grade && c.credits === claim.credits && c.state === claim.state && c.currentGrade === claim.currentGrade && c.score === claim.score && c.currentScore === claim.currentScore)) attempt.claims.push(claim);
    attempts.set(key, attempt);
  }
  for (const row of records) {
    const common = { sourceId: row.sourceId, recordId: row.id, url: row.provenance.sourceUrl, observedAt: row.provenance.observedAt, needsRefresh: !fresh(row) };
    if (row.kind === "course_history") add(row.courseKey, row.termCode, { ...common, source: "student_history", grade: row.grade, credits: row.credits, creditBasis: "attempt", state: row.state });
    if (row.kind === "audit") for (const node of row.nodes) for (const course of node.appliedCourses) {
      if (course.courseKey) add(course.courseKey, course.termCode, { ...common, source: "audit", program: row.programKey, grade: course.grade, credits: course.credits, creditBasis: "audit_application", state: course.state,
        needsRefresh: common.needsRefresh || row.generatedAt === null || Date.parse(now) - Date.parse(row.generatedAt) > 7 * 86_400_000 });
    }
  }
  const courseSources = new Map(store.sources().map(s => [s.id, s]));
  for (const course of store.resources().filter(r => !r.deleted && r.kind === "course" && courseSources.get(r.sourceId)?.scope === "course" && canvasAccounts.has(courseSources.get(r.sourceId)?.accountScope ?? ""))) {
    const courseCode = course.course?.courseCode || course.courseName;
    const prefix = /^(FA|SP|SU)(\d{2})(?=[\s:_-])/i.exec(courseCode);
    const prefixTerm = prefix ? parseAuditCourseTerm(`${prefix[1]}${prefix[2]}`) : null;
    const termLabel = course.course?.termName ?? "";
    const range = /^(fall|spring|summer)\s+(20\d{2})[-–](20\d{2})$/i.exec(termLabel.trim());
    let term = parseUwTermLabel(termLabel);
    // Canvas uses academic-year ranges: Fall is the first calendar year,
    // Spring/Summer the second. Require the course-code term to corroborate it.
    if (!term && range && prefixTerm && Number(range[3]) === Number(range[2]) + 1 &&
      prefixTerm.season === range[1]!.toLowerCase() && prefixTerm.year === Number(range[prefixTerm.season === "fall" ? 2 : 3])) term = prefixTerm;
    if (term && prefixTerm && term.code !== prefixTerm.code) term = null;
    const label = courseCode.replace(/^(?:FA|SP|SU)(?:20\d{2}|\d{2})[\s:_-]+/i, "");
    const identity = resolveCourseIdentity(label, table);
    if (!term || identity.status !== "resolved") { result.unresolvedCanvasCourses++; continue; }
    const source = courseSources.get(course.sourceId)!;
    for (const grade of course.course?.gradeEvidence?.length ? course.course.gradeEvidence : [{}]) add(identity.courseKey, term.code, {
      source: "canvas", sourceId: course.sourceId, recordId: course.id, url: course.url, observedAt: course.observedAt,
      grade: grade.finalGrade ?? null, currentGrade: grade.currentGrade ?? null,
      score: grade.finalScore ?? null, currentScore: grade.currentScore ?? null, credits: null, creditBasis: "not_reported",
      state: grade.enrollmentState ?? "unknown", needsRefresh: source.status !== "ok" || !recent(course.observedAt),
    });
  }
  const letter = (value: string | null) => value && /^[A-F][+-]?$|^AB$|^BC$/.test(value.trim().toUpperCase()) ? value.trim().toUpperCase() : null;
  for (const attempt of attempts.values()) {
    const hasCanvas = attempt.claims.some(c => c.source === "canvas"), hasAcademic = attempt.claims.some(c => c.source !== "canvas");
    attempt.coverage = hasCanvas && hasAcademic ? "matched" : hasCanvas ? "canvas_only" : "academic_only";
    if (new Set(attempt.claims.map(c => letter(c.grade)).filter(Boolean)).size > 1) attempt.differences.push("grade");
    if (new Set(attempt.claims.filter(c => c.creditBasis === "attempt").map(c => c.credits).filter(c => c !== null)).size > 1) attempt.differences.push("credits");
    if (attempt.claims.some(c => c.creditBasis === "audit_application") && new Set(attempt.claims.map(c => c.credits).filter(c => c !== null)).size > 1) attempt.differences.push("applied_credits");
    if (new Set(attempt.claims.filter(c => c.source !== "canvas").map(c => c.state).filter(s => s !== "unknown")).size > 1) attempt.differences.push("state");
    result.attempts.push(attempt);
  }
  result.attempts.sort((a, b) => b.termCode.localeCompare(a.termCode) || a.courseKey.localeCompare(b.courseKey));
  result.warnings.push("Canvas results describe its gradebook. Student history describes recorded attempts. DARS shows how a report applies courses to a program. These claims are preserved independently; this comparison is not an official transcript.",
    "A course missing from one source is a coverage gap, not proof it was not taken. DARS applied credits can vary by requirement and are not extra earned credits. Matching grades do not establish mastery or exam readiness. Percent scores are never converted to letter grades.");
  return result;
}
