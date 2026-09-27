import { z } from "zod";
const instant = z.iso.datetime({ offset: true });
// Kept local to avoid a circular initialization through the contracts barrel.
const evidenceUrlSchema = z.url().max(4000).refine((value) => {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password &&
    ![...url.searchParams.keys(), ...new URLSearchParams(url.hash.slice(1)).keys()].some((key) =>
      /token|password|cookie|signature|credential|authorization|api.?key|access.?key|verifier/i.test(key));
}, "Evidence URL contains unsupported access data.");

/** Normalized application records, not a claim about any UW endpoint's JSON. */
const planningId = z.string().min(1).max(200);
const text = z.string().max(2000);
const count = z.number().int().min(0).max(10_000_000);
const credits = z.number().min(0).max(1000);
export const uwTermCodeSchema = z.string().regex(/^1\d{2}[246]$/);
export const canonicalCourseKeySchema = z.string().regex(/^uw:\d{1,6}:[A-Z0-9]{1,12}$/);
export const planningScopeSchema = z.object({
  kind: z.enum(["terms", "subjects", "student_record", "degree_plan", "audit_program", "catalog_term", "enrollment_term", "grade_course", "academic_calendar", "policy"]),
  key: planningId,
}).strict();
export const planningProvenanceSchema = z.object({
  sourceUrl: evidenceUrlSchema,
  observedAt: instant,
  scope: planningScopeSchema,
}).strict();
export type PlanningProvenance = z.infer<typeof planningProvenanceSchema>;
export type PlanningScope = z.infer<typeof planningScopeSchema>;
export const planningCoverageSchema = z.enum(["complete", "partial", "unknown"]);
export const courseHistoryStateSchema = z.enum(["completed", "in_progress", "planned", "dropped", "withdrawn", "unknown"]);
export type CourseHistoryState = z.infer<typeof courseHistoryStateSchema>;
export const uwGpaGradeSchema = z.enum(["A", "AB", "B", "BC", "C", "D", "F"]);
export type UwGpaGrade = z.infer<typeof uwGpaGradeSchema>;

export type Prerequisite =
  | { kind: "course"; courseKey: string; minimumGrade: UwGpaGrade | null; concurrent: boolean }
  | { kind: "and"; children: Prerequisite[] }
  | { kind: "or"; children: Prerequisite[] }
  | { kind: "unknown"; reason: string }
  | { kind: "none" };
const prerequisiteNode: z.ZodType<Prerequisite> = z.lazy(() => z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("course"), courseKey: canonicalCourseKeySchema, minimumGrade: uwGpaGradeSchema.nullable(), concurrent: z.boolean() }).strict(),
  z.object({ kind: z.literal("and"), children: z.array(prerequisiteNode).min(1).max(50) }).strict(),
  z.object({ kind: z.literal("or"), children: z.array(prerequisiteNode).min(1).max(50) }).strict(),
  z.object({ kind: z.literal("unknown"), reason: text }).strict(),
  z.object({ kind: z.literal("none") }).strict(),
]));
// Bound depth before recursive validation, including cyclic values passed by local callers.
export const prerequisiteSchema = z.unknown().superRefine((input, ctx) => {
  const pending: { value: unknown; depth: number }[] = [{ value: input, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++nodes > 500 || depth > 16 || (typeof value === "object" && value !== null && seen.has(value))) {
      ctx.addIssue({ code: "custom", message: "Prerequisite exceeds structural bounds." });
      return;
    }
    if (typeof value === "object" && value !== null) {
      seen.add(value);
      if ("children" in value && Array.isArray(value.children)) {
        if (value.children.length > 50) { ctx.addIssue({ code: "custom", message: "Prerequisite exceeds structural bounds." }); return; }
        pending.push(...value.children.map((child: unknown) => ({ value: child, depth: depth + 1 })));
      }
    }
  }
}).pipe(prerequisiteNode);

const common = { id: planningId, provenance: planningProvenanceSchema };
export const planningTermSchema = z.object({
  ...common, kind: z.literal("term"), code: uwTermCodeSchema,
  season: z.enum(["fall", "spring", "summer"]), year: z.number().int().min(1999).max(2099),
  label: z.string().max(100), past: z.boolean().nullable(),
}).strict().refine((row) => {
  const suffix = { fall: "2", spring: "4", summer: "6" }[row.season];
  const endYear = row.year + (row.season === "fall" ? 1 : 0);
  return endYear >= 2000 && endYear <= 2099 && row.code === `1${String(endYear % 100).padStart(2, "0")}${suffix}`;
}, "Term code and calendar year/season disagree.");
export const planningSubjectSchema = z.object({
  ...common, kind: z.literal("subject"), code: z.string().regex(/^\d{1,6}$/),
  shortName: z.string().min(1).max(100), formalName: z.string().min(1).max(300),
  aliases: z.array(z.string().min(1).max(100)).max(50),
}).strict();
export type PlanningSubject = z.infer<typeof planningSubjectSchema>;
export const planningCrosslistSchema = z.object({
  ...common, kind: z.literal("crosslist"), canonicalKey: canonicalCourseKeySchema,
  courseKeys: z.array(canonicalCourseKeySchema).min(2).max(50),
}).strict().refine((row) => row.courseKeys.includes(row.canonicalKey), "Crosslist must include its canonical key.");
export type PlanningCrosslist = z.infer<typeof planningCrosslistSchema>;
export const planningCourseHistorySchema = z.object({
  ...common, kind: z.literal("course_history"), courseKey: canonicalCourseKeySchema,
  termCode: uwTermCodeSchema.nullable(), state: courseHistoryStateSchema,
  credits: credits.nullable(), grade: z.string().max(20).nullable(),
  // Excludes transfer, pass/fail, and other attempts only when supported by source evidence.
  gpaEligible: z.boolean().nullable(),
}).strict();
export type PlanningCourseHistory = z.infer<typeof planningCourseHistorySchema>;
const auditAppliedCourseSchema = z.object({
  courseKey: canonicalCourseKeySchema.nullable(), rawCourse: z.string().max(300),
  termCode: uwTermCodeSchema.nullable(), credits: credits.nullable(),
  grade: z.string().max(20).nullable(), state: courseHistoryStateSchema,
}).strict();
export const auditNodeSchema = z.object({
  nodeId: planningId, parentId: planningId.nullable(), index: z.number().int().min(0).max(10000),
  kind: z.enum(["requirement", "subrequirement", "unknown"]),
  title: z.string().max(500),
  requirementKind: z.enum(["breadth", "communication", "quantitative", "ethnic_studies", "major_core", "elective", "residency", "unknown"]),
  rawStatus: z.enum(["OK", "NO", "NONE"]).nullable(),
  status: z.enum(["completed", "incomplete", "in_progress", "planned", "unknown"]),
  flags: z.array(z.string().max(30)).max(30),
  earnedCredits: credits.nullable(), earnedGpa: z.number().min(0).max(4).nullable(),
  needsCourses: count.nullable(), needsCredits: credits.nullable(),
  acceptableCourseKeys: z.array(canonicalCourseKeySchema).max(3000),
  appliedCourses: z.array(auditAppliedCourseSchema).max(1000),
  coverage: planningCoverageSchema,
  evidence: z.array(z.object({ blockId: planningId, quote: text }).strict()).max(100),
}).strict();
export type AuditNode = z.infer<typeof auditNodeSchema>;
export const planningAuditSchema = z.object({
  ...common, kind: z.literal("audit"), programKey: planningId,
  generatedAt: instant.nullable(), catalogTerm: z.string().regex(/^\d{4}[123]$/).nullable(),
  coverage: planningCoverageSchema, nodes: z.array(auditNodeSchema).max(3000),
}).strict().superRefine((audit, ctx) => {
  const map = new Map(audit.nodes.map((node) => [node.nodeId, node]));
  if (map.size !== audit.nodes.length) ctx.addIssue({ code: "custom", message: "Audit node IDs must be unique." });
  for (const node of audit.nodes) {
    const seen = new Set([node.nodeId]);
    let parent = node.parentId;
    while (parent !== null) {
      if (!map.has(parent) || seen.has(parent) || seen.size > 32) {
        ctx.addIssue({ code: "custom", message: "Audit tree has a missing parent, cycle, or excessive depth." }); break;
      }
      seen.add(parent); parent = map.get(parent)!.parentId;
    }
  }
});
export type PlanningAudit = z.infer<typeof planningAuditSchema>;
export const planningCatalogCourseSchema = z.object({
  ...common, kind: z.literal("catalog_course"), courseKey: canonicalCourseKeySchema,
  termCode: uwTermCodeSchema.nullable(), title: z.string().max(500), description: z.string().max(12000),
  creditMin: credits.nullable(), creditMax: credits.nullable(),
  designations: z.array(z.string().max(100)).max(30),
  prerequisiteText: z.string().max(8000).nullable(), prerequisite: prerequisiteSchema.nullable(),
  prerequisiteCheckedAt: instant.nullable(), offeringFrequency: z.string().max(300).nullable(),
}).strict().refine((row) => row.creditMin === null || row.creditMax === null || row.creditMin <= row.creditMax, "Invalid credit range.");
export type PlanningCatalogCourse = z.infer<typeof planningCatalogCourseSchema>;
export const planningMeetingSchema = z.object({
  kind: z.enum(["class", "exam"]), mode: z.enum(["scheduled", "asynchronous", "unknown"]),
  days: z.array(z.number().int().min(1).max(7)).max(7),
  startMinute: z.number().int().min(0).max(1439).nullable(),
  endMinute: z.number().int().min(1).max(1440).nullable(),
  startDate: z.iso.date().nullable(), endDate: z.iso.date().nullable(),
  timezone: z.literal("America/Chicago"), location: z.string().max(300).nullable(),
}).strict().superRefine((meeting, ctx) => {
  if (meeting.startMinute !== null && meeting.endMinute !== null && meeting.startMinute >= meeting.endMinute)
    ctx.addIssue({ code: "custom", message: "Meeting ends before it starts." });
  if (meeting.startDate !== null && meeting.endDate !== null && meeting.startDate > meeting.endDate)
    ctx.addIssue({ code: "custom", message: "Meeting date range is reversed." });
});
export type PlanningMeeting = z.infer<typeof planningMeetingSchema>;
export const planningEnrollmentPackageSchema = z.object({
  ...common, kind: z.literal("enrollment_package"), courseKey: canonicalCourseKeySchema, termCode: uwTermCodeSchema,
  sections: z.array(z.string().max(100)).min(1).max(30),
  status: z.enum(["open", "waitlisted", "closed", "cancelled", "unknown"]),
  enrollmentState: z.enum(["enrolled", "proposed", "available", "unknown"]),
  meetings: z.array(planningMeetingSchema).max(100), meetingsComplete: z.boolean(),
  seatsAvailable: count.nullable(), capacity: count.nullable(), waitlistCount: count.nullable(),
  instructorNames: z.array(z.string().max(200)).max(30),
}).strict();
export type PlanningEnrollmentPackage = z.infer<typeof planningEnrollmentPackageSchema>;
export const planningHoldSchema = z.object({
  ...common, kind: z.literal("hold"), title: z.string().max(300), description: text,
  blocksEnrollment: z.boolean().nullable(), resolutionUrl: evidenceUrlSchema.nullable(),
}).strict();
export const planningAppointmentSchema = z.object({
  ...common, kind: z.literal("appointment"), termCode: uwTermCodeSchema,
  startsAt: instant.nullable(), endsAt: instant.nullable(),
}).strict().refine((row) => row.startsAt === null || row.endsAt === null || Date.parse(row.startsAt) <= Date.parse(row.endsAt), "Appointment window is reversed.");
export const planningAdvisorSchema = z.object({
  ...common, kind: z.literal("advisor"), displayName: z.string().max(300), role: z.string().max(200),
  assigned: z.literal(true), contactUrl: evidenceUrlSchema.nullable(),
}).strict();
export const planningStudentSummarySchema = z.object({
  ...common, kind: z.literal("student_summary"), career: z.string().max(100).nullable(),
  programNames: z.array(z.string().max(300)).max(30), expectedGraduationTerm: uwTermCodeSchema.nullable(),
  cumulativeGpa: z.number().min(0).max(4).nullable(), earnedCredits: credits.nullable(), attemptedCredits: credits.nullable(),
}).strict();
export const planningGradeDistributionSchema = z.object({
  ...common, kind: z.literal("grade_distribution"), courseKey: canonicalCourseKeySchema,
  termCode: uwTermCodeSchema, section: z.string().max(50).nullable(),
  instructorNames: z.array(z.string().max(200)).max(30),
  // Source-scoped instructor identifiers (for example Madgrades numeric IDs). Names never group instructors.
  instructorIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)).max(30).optional(),
  counts: z.array(z.object({ grade: z.string().min(1).max(20), count }).strict()).max(50),
  coverage: z.enum(["published", "partial", "suppressed", "unknown"]),
}).strict().refine((row) => new Set(row.counts.map((item) => item.grade.trim().toUpperCase())).size === row.counts.length, "Grade counts must be unique.");
export type PlanningGradeDistribution = z.infer<typeof planningGradeDistributionSchema>;
/** Same-person evidence verified in the native process; no email or student ID persists. */
export const planningAccountLinkSchema = z.object({
  ...common, kind: z.literal("account_link"),
  canvasAccountScope: z.string().regex(/^[a-f0-9]{64}$/),
  method: z.literal("matched_institutional_login"),
}).strict();
export const planningRecordSchema = z.discriminatedUnion("kind", [
  planningTermSchema, planningSubjectSchema, planningCrosslistSchema, planningCourseHistorySchema,
  planningAuditSchema, planningCatalogCourseSchema, planningEnrollmentPackageSchema,
  planningHoldSchema, planningAppointmentSchema, planningAdvisorSchema, planningStudentSummarySchema, planningGradeDistributionSchema, planningAccountLinkSchema,
]);
export type PlanningRecord = z.infer<typeof planningRecordSchema>;
export const planningCaptureSchema = z.object({
  schemaVersion: z.literal(1), id: planningId,
  // Public sources use "public"; private sources use an opaque locally hashed account scope.
  accountScope: planningId,
  source: z.enum(["uw_public", "uw_enroll", "uw_myuw", "uw_dars", "madgrades", "normalized_import"]),
  scope: planningScopeSchema, sourceUrl: evidenceUrlSchema, observedAt: instant,
  status: z.enum(["complete", "partial", "blocked", "unsupported", "failed"]),
  completeness: planningCoverageSchema,
  records: z.array(planningRecordSchema).max(10000),
  diagnostics: z.array(z.object({ code: z.string().regex(/^[a-z0-9_.-]{1,100}$/), message: z.string().max(500) }).strict()).max(100),
}).strict().superRefine((capture, ctx) => {
  if (capture.status !== "complete" && capture.completeness === "complete")
    ctx.addIssue({ code: "custom", message: "Only a successful complete capture establishes complete coverage." });
  const keys = new Set<string>();
  for (const record of capture.records) {
    if (record.provenance.scope.kind !== capture.scope.kind || record.provenance.scope.key !== capture.scope.key)
      ctx.addIssue({ code: "custom", message: "Record belongs to a different capture scope." });
    const key = `${record.kind}:${record.id}`;
    if (keys.has(key)) ctx.addIssue({ code: "custom", message: "Capture contains duplicate record IDs." });
    keys.add(key);
  }
});
export type PlanningCapture = z.infer<typeof planningCaptureSchema>;

export interface AcademicClaim {
  source: "canvas" | "student_history" | "audit";
  sourceId: string; recordId: string; url: string; observedAt: string;
  grade: string | null; currentGrade?: string | null;
  score?: number | null; currentScore?: number | null;
  credits: number | null; creditBasis: "attempt" | "audit_application" | "not_reported"; state: string; needsRefresh: boolean;
  program?: string;
}
export interface AcademicReconciliation {
  status: "available" | "unlinked" | "multiple_accounts";
  warnings: string[];
  unresolvedCanvasCourses: number;
  attempts: Array<{
    courseKey: string; termCode: string; claims: AcademicClaim[];
    differences: Array<"grade" | "credits" | "applied_credits" | "state">;
    coverage: "matched" | "canvas_only" | "academic_only";
  }>;
}
