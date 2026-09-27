import {
  auditNodeSchema,
  planningAuditSchema,
  planningCourseHistorySchema,
  planningGradeDistributionSchema,
  planningMeetingSchema,
  prerequisiteSchema,
  type AuditNode,
  type CourseHistoryState,
  type PlanningAudit,
  type PlanningCatalogCourse,
  type PlanningCourseHistory,
  type PlanningCrosslist,
  type PlanningEnrollmentPackage,
  type PlanningGradeDistribution,
  type PlanningMeeting,
  type PlanningSubject,
  type Prerequisite,
  type UwGpaGrade,
} from "../../contracts/src/planning";

export type UwSeason = "fall" | "spring" | "summer";
export type UwTerm = { code: string; season: UwSeason; year: number; label: string; academicYear: number };
const termSuffix = { fall: "2", spring: "4", summer: "6" } as const;
/** The supported 1YY code century is academic years 2000–2099. */
export function encodeUwTerm(year: number, season: UwSeason): string {
  if (!Number.isInteger(year) || !Object.hasOwn(termSuffix, season)) throw new Error("Invalid UW term.");
  const academicYear = year + (season === "fall" ? 1 : 0);
  if (academicYear < 2000 || academicYear > 2099) throw new Error("UW term outside supported century.");
  return `1${String(academicYear % 100).padStart(2, "0")}${termSuffix[season]}`;
}
export function decodeUwTerm(code: string): UwTerm {
  if (!/^1\d{2}[246]$/.test(code)) throw new Error("Invalid UW term code.");
  const academicYear = 2000 + Number(code.slice(1, 3));
  const season: UwSeason = code[3] === "2" ? "fall" : code[3] === "4" ? "spring" : "summer";
  const year = academicYear - (season === "fall" ? 1 : 0);
  return { code, season, year, academicYear, label: `${season[0].toUpperCase()}${season.slice(1)} ${year}` };
}
export function parseUwTermLabel(label: string): UwTerm | null {
  const match = /^(fall|spring|summer)\s+(\d{4})$/i.exec(label.trim());
  if (!match) return null;
  try { return decodeUwTerm(encodeUwTerm(Number(match[2]), match[1].toLowerCase() as UwSeason)); } catch { return null; }
}
/** DARS YYYY is the academic-year ending year. Official mapping: kb.wisc.edu/ac/162248. */
export function parseAuditCatalogTerm(value: string): UwTerm | null {
  const match = /^(\d{4})([123])$/.exec(value.trim());
  if (!match) return null;
  const season: UwSeason = match[2] === "1" ? "fall" : match[2] === "2" ? "spring" : "summer";
  try { return decodeUwTerm(encodeUwTerm(Number(match[1]) - (season === "fall" ? 1 : 0), season)); } catch { return null; }
}
/** Course-line labels use the calendar year, independently from catalog-year labels. */
export function parseAuditCourseTerm(value: string): UwTerm | null {
  const match = /^(FA|SP|SU)(\d{2})$/i.exec(value.trim());
  if (!match) return null;
  const season: UwSeason = match[1].toUpperCase() === "FA" ? "fall" : match[1].toUpperCase() === "SP" ? "spring" : "summer";
  try { return decodeUwTerm(encodeUwTerm(2000 + Number(match[2]), season)); } catch { return null; }
}

const compactSubject = (value: string) => value.trim().toUpperCase().replace(/\s+/g, "");
export type CourseIdentityTable = { aliases: ReadonlyMap<string, readonly string[]>; crosslists: ReadonlyMap<string, string> };
export type CourseResolution =
  | { status: "resolved"; courseKey: string; subjectCode: string; catalog: string }
  | { status: "unknown"; reason: string };
/** Only source-provided aliases and explicitly evidenced course-level crosslists establish equality. */
export function buildCourseIdentityTable(subjects: PlanningSubject[], crosslists: PlanningCrosslist[] = []): CourseIdentityTable {
  const aliases = new Map<string, string[]>();
  for (const subject of subjects) {
    for (const alias of [subject.code, subject.shortName, subject.formalName, ...subject.aliases]) {
      const normalized = compactSubject(alias);
      aliases.set(normalized, [...new Set([...(aliases.get(normalized) ?? []), subject.code])]);
    }
  }
  const mappings = new Map<string, string>();
  for (const list of crosslists) {
    if (!list.courseKeys.includes(list.canonicalKey)) throw new Error("Crosslist canonical key must be in its course list.");
    for (const key of list.courseKeys) {
      if (mappings.has(key) && mappings.get(key) !== list.canonicalKey) throw new Error("Conflicting explicit crosslist mappings.");
      mappings.set(key, list.canonicalKey);
    }
  }
  return { aliases, crosslists: mappings };
}
export function canonicalizeCourseKey(key: string, table: CourseIdentityTable): string {
  return table.crosslists.get(key) ?? key;
}
export function resolveCourseIdentity(input: string | { subject: string; catalog: string }, table: CourseIdentityTable): CourseResolution {
  if (typeof input !== "string") {
    const codes = table.aliases.get(compactSubject(input.subject));
    const catalog = input.catalog.trim().toUpperCase();
    if (!codes || codes.length !== 1) return { status: "unknown", reason: "Subject alias is missing or ambiguous." };
    if (!/^\d{1,4}[A-Z]?$/.test(catalog)) return { status: "unknown", reason: "Catalog number is not recognized." };
    return { status: "resolved", courseKey: canonicalizeCourseKey(`uw:${codes[0]}:${catalog}`, table), subjectCode: codes[0], catalog };
  }
  const value = input.trim().toUpperCase();
  const shared = /^(.+?)\/(.+?)\s+(\d{1,4}[A-Z]?)$/.exec(value);
  if (shared) {
    const left = resolveCourseIdentity({ subject: shared[1], catalog: shared[3] }, table);
    const right = resolveCourseIdentity({ subject: shared[2], catalog: shared[3] }, table);
    return left.status === "resolved" && right.status === "resolved" && left.courseKey === right.courseKey
      ? left : { status: "unknown", reason: "Shared designation has no explicit crosslist mapping." };
  }
  const direct = /^uw:(\d{1,6}):([A-Z0-9]{1,12})$/i.exec(value);
  if (direct) return resolveCourseIdentity({ subject: direct[1], catalog: direct[2] }, table);
  // Match a known subject before parsing a course number. Titles may follow a space/dash/colon.
  const matches: CourseResolution[] = [];
  for (const alias of [...table.aliases.keys()].sort((a, b) => b.length - a.length)) {
    const pattern = alias.split("").map((char) => char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*");
    const match = new RegExp(`^${pattern}\\s*(\\d{1,4}[A-Z]?)(?=$|[\\s:–—-])`).exec(value);
    if (match) matches.push(resolveCourseIdentity({ subject: alias, catalog: match[1] }, table));
  }
  const resolved = matches.filter((match): match is Extract<CourseResolution, { status: "resolved" }> => match.status === "resolved");
  if (resolved.length && new Set(resolved.map((row) => row.courseKey)).size === 1 && matches.every((row) => row.status === "resolved")) return resolved[0];
  return { status: "unknown", reason: "Course designation is missing or ambiguous in the subject table." };
}
export function parseAuditCourseList(value: string, table: CourseIdentityTable): { courseKeys: string[]; unresolved: string[] } {
  const courseKeys: string[] = [], unresolved: string[] = [];
  let inheritedSubject: string | null = null;
  for (const raw of value.replace(/^\s*select\s+from\s*:?\s*/i, "").split(/[,;\n]/)) {
    const item = raw.trim();
    if (!item) continue;
    const inherited = /^\d{1,4}[A-Z]?$/i.test(item) && inheritedSubject !== null;
    // Ranges, inequalities and prose are intentionally retained as unresolved evidence.
    if (/\d\s*[-–]\s*\d|\bthrough\b|[<>]/i.test(item)) { unresolved.push(item); inheritedSubject = null; continue; }
    const exactDesignation = inherited || [...table.aliases.keys()].some((alias) => {
      const compact = compactSubject(item);
      return compact.startsWith(alias) && /^\d{1,4}[A-Z]?$/.test(compact.slice(alias.length));
    }) || /^[^/]+\/[^/]+\s+\d{1,4}[A-Z]?$/i.test(item);
    if (!exactDesignation) { unresolved.push(item); inheritedSubject = null; continue; }
    const resolved = resolveCourseIdentity(inherited ? { subject: inheritedSubject!, catalog: item } : item, table);
    if (resolved.status === "unknown") { unresolved.push(item); inheritedSubject = null; }
    else { courseKeys.push(resolved.courseKey); inheritedSubject = resolved.subjectCode; }
  }
  return { courseKeys: [...new Set(courseKeys)], unresolved };
}

export function classifyHistoryState(input: { grade: string | null; explicitState?: CourseHistoryState; termCode: string | null; currentTermCode: string }): CourseHistoryState {
  const grade = input.grade?.trim().toUpperCase();
  if (grade === "DR") return "dropped";
  if (grade === "W") return "withdrawn";
  if (grade === "IP") return "in_progress";
  if (input.explicitState === "dropped" || input.explicitState === "withdrawn" || input.explicitState === "planned" || input.explicitState === "in_progress") return input.explicitState;
  if (!/^1\d{2}[246]$/.test(input.currentTermCode) || input.termCode !== null && !/^1\d{2}[246]$/.test(input.termCode)) return "unknown";
  if (input.termCode && input.termCode > input.currentTermCode) return "planned";
  if (grade && (Object.hasOwn(UW_GRADE_POINTS, grade) || ["S", "U", "CR", "N"].includes(grade))) return "completed";
  return "unknown";
}
export const UW_GRADE_POINTS: Readonly<Record<UwGpaGrade, number>> = Object.freeze({ A: 4, AB: 3.5, B: 3, BC: 2.5, C: 2, D: 1, F: 0 });
const gradePoints = (grade: string | null): number | null => {
  const normalized = grade?.trim().toUpperCase();
  return normalized && Object.hasOwn(UW_GRADE_POINTS, normalized) ? UW_GRADE_POINTS[normalized as UwGpaGrade] : null;
};
export type GradeAverage = { average: number | null; includedCount: number; excludedCount: number; totalCount: number; qualityPoints: number; status: "known" | "partial" | "unknown" };
/** Weighted mean of published counts, never a median or predicted student grade. */
export function calculateGradeDistributionAverage(input: PlanningGradeDistribution): GradeAverage {
  const parsed = planningGradeDistributionSchema.safeParse(input);
  if (!parsed.success) return { average: null, includedCount: 0, excludedCount: 0, totalCount: 0, qualityPoints: 0, status: "unknown" };
  let includedCount = 0, excludedCount = 0, qualityPoints = 0;
  for (const row of parsed.data.counts) {
    const points = gradePoints(row.grade);
    if (points === null) excludedCount += row.count;
    else { includedCount += row.count; qualityPoints += points * row.count; }
  }
  const hidden = input.coverage === "suppressed" || input.coverage === "unknown";
  return { average: !hidden && includedCount ? qualityPoints / includedCount : null,
    includedCount, excludedCount, totalCount: includedCount + excludedCount, qualityPoints,
    status: hidden || !includedCount ? "unknown" : input.coverage === "partial" ? "partial" : "known" };
}
export function calculateAttemptGpa(attempts: PlanningCourseHistory[]): {
  gpa: number | null; qualityPoints: number; gpaCredits: number; includedAttempts: number;
  excludedAttempts: number; unknownAttempts: number; status: "known" | "partial" | "unknown";
} {
  let qualityPoints = 0, gpaCredits = 0, includedAttempts = 0, excludedAttempts = 0, unknownAttempts = 0;
  for (const input of attempts) {
    const result = planningCourseHistorySchema.safeParse(input);
    if (!result.success) { unknownAttempts++; continue; }
    const attempt = result.data;
    if (attempt.state === "unknown") { unknownAttempts++; continue; }
    if (attempt.state !== "completed" || attempt.gpaEligible === false) { excludedAttempts++; continue; }
    const points = gradePoints(attempt.grade);
    if (attempt.gpaEligible === null || attempt.credits === null || points === null) { unknownAttempts++; continue; }
    qualityPoints += points * attempt.credits; gpaCredits += attempt.credits; includedAttempts++;
  }
  return { gpa: gpaCredits > 0 ? qualityPoints / gpaCredits : null, qualityPoints, gpaCredits, includedAttempts, excludedAttempts, unknownAttempts, status: gpaCredits === 0 ? "unknown" : unknownAttempts ? "partial" : "known" };
}
export function assessCreditLoad(input: { courses: { min: number | null; max: number | null }[]; policy: { minimum: number; maximum: number; sourceUrl: string } | null }): {
  minimumCredits: number; maximumCredits: number; unknownCourses: number; status: "within_range" | "below_minimum" | "above_maximum" | "conditional" | "unknown";
} {
  let minimumCredits = 0, maximumCredits = 0, unknownCourses = 0;
  for (const row of input.courses) {
    if (row.min === null || row.max === null || !Number.isFinite(row.min) || !Number.isFinite(row.max) || row.min < 0 || row.min > row.max) unknownCourses++;
    else { minimumCredits += row.min; maximumCredits += row.max; }
  }
  const policy = input.policy;
  let validPolicySource = false;
  try { validPolicySource = Boolean(policy && new URL(policy.sourceUrl).protocol === "https:"); } catch { /* Unknown policy source. */ }
  const status = unknownCourses || !policy || !validPolicySource || policy.minimum < 0 || !Number.isFinite(policy.minimum) || !Number.isFinite(policy.maximum) || policy.minimum > policy.maximum ? "unknown"
    : minimumCredits > policy.maximum ? "above_maximum" : maximumCredits < policy.minimum ? "below_minimum"
    : minimumCredits >= policy.minimum && maximumCredits <= policy.maximum ? "within_range" : "conditional";
  return { minimumCredits, maximumCredits, unknownCourses, status };
}

export type PrerequisiteResult = { status: "met" | "conditional" | "unmet" | "unknown"; reasons: string[] };
export function evaluatePrerequisite(input: Prerequisite | null, context: {
  history: PlanningCourseHistory[]; historyComplete: boolean; targetTermCode: string;
  proposedCourseKeys?: string[]; identityTable?: CourseIdentityTable;
}): PrerequisiteResult {
  const parsed = prerequisiteSchema.safeParse(input);
  if (!parsed.success || !/^1\d{2}[246]$/.test(context.targetTermCode)) return { status: "unknown", reasons: ["Prerequisite evidence or target term is missing or invalid."] };
  const canonical = (key: string) => context.identityTable ? canonicalizeCourseKey(key, context.identityTable) : key;
  const validHistory = context.history.map((row) => planningCourseHistorySchema.safeParse(row));
  const historyComplete = context.historyComplete && validHistory.every((row) => row.success);
  const history = validHistory.flatMap((row) => row.success ? [row.data] : []);
  const evaluate = (node: Prerequisite): PrerequisiteResult => {
    if (node.kind === "none") return { status: "met", reasons: ["Source explicitly records no prerequisite."] };
    if (node.kind === "unknown") return { status: "unknown", reasons: [node.reason || "Prerequisite is unknown."] };
    if (node.kind === "and" || node.kind === "or") {
      const results = node.children.map(evaluate), statuses = results.map((row) => row.status);
      const status = node.kind === "and"
        ? statuses.includes("unmet") ? "unmet" : statuses.includes("unknown") ? "unknown" : statuses.includes("conditional") ? "conditional" : "met"
        : statuses.includes("met") ? "met" : statuses.includes("conditional") ? "conditional" : statuses.includes("unknown") ? "unknown" : "unmet";
      return { status, reasons: results.flatMap((row) => row.reasons) };
    }
    const key = canonical(node.courseKey);
    const attempts = history.filter((row) => canonical(row.courseKey) === key);
    let uncertain = !historyComplete, conditional = false;
    for (const row of attempts) {
      if (row.state === "dropped" || row.state === "withdrawn" || row.state === "planned") continue;
      if (row.termCode === null || row.state === "unknown") { uncertain = true; continue; }
      if (row.termCode > context.targetTermCode) continue;
      if (row.state === "in_progress") {
        if (row.termCode < context.targetTermCode || node.concurrent) conditional = true;
        continue;
      }
      // A course completed in the target term cannot prove a prerequisite satisfied before it.
      if (row.termCode === context.targetTermCode) { if (node.concurrent) conditional = true; continue; }
      const points = gradePoints(row.grade);
      if (points === null) {
        if (!node.minimumGrade && ["S", "CR"].includes(row.grade?.trim().toUpperCase() ?? "")) return { status: "met", reasons: [`${key}: credit-bearing completion is recorded.`] };
        uncertain = true; continue;
      }
      if (points >= (node.minimumGrade ? UW_GRADE_POINTS[node.minimumGrade] : 1)) return { status: "met", reasons: [`${key}: completed with a sufficient grade.`] };
    }
    if (node.concurrent && (context.proposedCourseKeys ?? []).some((course) => canonical(course) === key)) conditional = true;
    if (conditional) return { status: "conditional", reasons: [`${key}: depends on successful in-progress or concurrent enrollment; no completion is assumed.`] };
    return { status: uncertain ? "unknown" : "unmet", reasons: [uncertain ? `${key}: history or grade evidence is incomplete.` : `${key}: no qualifying completion is recorded.`] };
  };
  return evaluate(parsed.data);
}

export function normalizeMeetingDays(value: string): { days: number[]; unknown: boolean } {
  const map: Record<string, number> = { M: 1, T: 2, W: 3, R: 4, F: 5, S: 6, U: 7 };
  const letters = value.toUpperCase().replace(/[\s,]/g, "").split("");
  return { days: [...new Set(letters.flatMap((letter) => map[letter] ? [map[letter]] : []))].sort(), unknown: !letters.length || letters.some((letter) => !map[letter]) };
}
export function millisecondsToMinute(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 && value < 86400000 && value % 60000 === 0 ? value / 60000 : null;
}
export type MeetingConflict = { status: "conflict" | "clear" | "unknown"; sharedDays: number[]; reason: string };
export function checkMeetingConflict(left: PlanningMeeting, right: PlanningMeeting): MeetingConflict {
  const a = planningMeetingSchema.safeParse(left), b = planningMeetingSchema.safeParse(right);
  if (!a.success || !b.success) return { status: "unknown", sharedDays: [], reason: "Meeting evidence is invalid." };
  if (left.mode === "asynchronous" || right.mode === "asynchronous") return { status: "clear", sharedDays: [], reason: "An asynchronous meeting has no scheduled time." };
  if (left.endDate && right.startDate && left.endDate < right.startDate || right.endDate && left.startDate && right.endDate < left.startDate)
    return { status: "clear", sharedDays: [], reason: "Meeting date ranges do not overlap." };
  const sharedDays = left.days.filter((day) => right.days.includes(day));
  if (left.days.length && right.days.length && !sharedDays.length) return { status: "clear", sharedDays, reason: "Meetings are on different days." };
  if (left.startMinute !== null && left.endMinute !== null && right.startMinute !== null && right.endMinute !== null &&
    (left.startMinute >= right.endMinute || right.startMinute >= left.endMinute)) return { status: "clear", sharedDays, reason: "Meeting times do not overlap." };
  if (left.mode === "unknown" || right.mode === "unknown" || !left.days.length || !right.days.length || left.startMinute === null || left.endMinute === null || right.startMinute === null || right.endMinute === null || !left.startDate || !left.endDate || !right.startDate || !right.endDate)
    return { status: "unknown", sharedDays, reason: "Meeting days, times, or dates are incomplete." };
  const start = Math.max(Date.parse(left.startDate), Date.parse(right.startDate));
  const end = Math.min(Date.parse(left.endDate), Date.parse(right.endDate));
  // The shared date window must actually contain an occurrence of the common weekday.
  for (let day = start; day <= Math.min(end, start + 6 * 86400000); day += 86400000) {
    const weekday = new Date(day).getUTCDay() || 7;
    if (sharedDays.includes(weekday)) return { status: "conflict", sharedDays, reason: "Meetings overlap on a shared date, weekday, and time." };
  }
  return { status: "clear", sharedDays, reason: "The shared date window contains no shared meeting day." };
}
export function checkPackageConflicts(candidate: PlanningEnrollmentPackage, scheduled: PlanningEnrollmentPackage[]): {
  status: MeetingConflict["status"]; conflicts: { packageId: string; candidateMeeting: number; scheduledMeeting: number; kind: "class" | "exam" }[]; unknownPairs: number;
} {
  const conflicts: { packageId: string; candidateMeeting: number; scheduledMeeting: number; kind: "class" | "exam" }[] = [];
  const fullyKnown = (row: PlanningMeeting) => planningMeetingSchema.safeParse(row).success &&
    (row.mode === "asynchronous" || row.mode === "scheduled" && row.days.length > 0 && row.startMinute !== null && row.endMinute !== null && row.startDate !== null && row.endDate !== null);
  let unknownPairs = candidate.meetingsComplete && candidate.meetings.length && candidate.meetings.every(fullyKnown) ? 0 : 1;
  // Every package section is required; lecture/discussion/lab/exam clashes also matter internally.
  for (let i = 0; i < candidate.meetings.length; i++) for (let j = i + 1; j < candidate.meetings.length; j++) {
    const result = checkMeetingConflict(candidate.meetings[i], candidate.meetings[j]);
    if (result.status === "conflict") conflicts.push({ packageId: candidate.id, candidateMeeting: i, scheduledMeeting: j,
      kind: candidate.meetings[i].kind === "exam" || candidate.meetings[j].kind === "exam" ? "exam" : "class" });
    if (result.status === "unknown") unknownPairs++;
  }
  for (const other of scheduled) {
    if (!other.meetingsComplete || !other.meetings.length || !other.meetings.every(fullyKnown)) unknownPairs++;
    for (const [i, left] of candidate.meetings.entries()) for (const [j, right] of other.meetings.entries()) {
      const result = checkMeetingConflict(left, right);
      if (result.status === "conflict") conflicts.push({ packageId: other.id, candidateMeeting: i, scheduledMeeting: j, kind: left.kind === "exam" || right.kind === "exam" ? "exam" : "class" });
      if (result.status === "unknown") unknownPairs++;
    }
  }
  return { status: conflicts.length ? "conflict" : unknownPairs ? "unknown" : "clear", conflicts, unknownPairs };
}

/** This is a normalized block interface for adapters, not an invented DARS JSON format. */
export type NormalizedAuditBlock =
  | { kind: "heading"; blockId: string; nodeId: string; parentId: string | null; title: string; rawStatus: "OK" | "NO" | "NONE" | null; flags: string[]; quote: string }
  | { kind: "earned"; blockId: string; credits: number | null; gpa: number | null; quote: string }
  | { kind: "needs"; blockId: string; courses: number | null; credits: number | null; quote: string }
  | { kind: "select_from"; blockId: string; text: string; quote: string }
  | { kind: "applied"; blockId: string; course: string; term: string; credits: number | null; grade: string | null; flags: string[]; quote: string }
  | { kind: "unknown"; blockId: string; quote: string }
  | { kind: "layout"; blockId: string };
export function parseNormalizedAuditBlocks(blocks: NormalizedAuditBlock[], table: CourseIdentityTable, currentTermCode: string): { nodes: AuditNode[]; coverage: "complete" | "partial" } {
  const nodes: AuditNode[] = [];
  let current: AuditNode | undefined, partial = false;
  const makeNode = (blockId: string, title: string, kind: AuditNode["kind"]): AuditNode => ({
    nodeId: blockId, parentId: null, index: nodes.length, kind, title, requirementKind: "unknown", rawStatus: null,
    status: "unknown", flags: [], earnedCredits: null, earnedGpa: null, needsCourses: null, needsCredits: null,
    acceptableCourseKeys: [], appliedCourses: [], coverage: "complete", evidence: [],
  });
  for (const block of blocks.slice(0, 10000)) {
    if (nodes.length >= 2999) { partial = true; break; }
    if (block.kind === "layout") continue;
    if (block.kind === "heading") {
      current = makeNode(block.nodeId, block.title, block.parentId === null ? "requirement" : "subrequirement");
      current.parentId = block.parentId; current.flags = [...block.flags]; current.rawStatus = block.rawStatus;
      nodes.push(current);
    }
    if (!current || block.kind === "unknown") {
      const unknown = makeNode(`unknown:${block.blockId}`, "Unrecognized audit content", "unknown");
      unknown.parentId = current?.nodeId ?? null; unknown.coverage = "partial";
      unknown.evidence.push({ blockId: block.blockId, quote: block.quote }); nodes.push(unknown); partial = true;
      if (current) current.coverage = "partial";
      // Unattached content remains evidence, with no invented requirement assignment.
      if (!current || block.kind === "unknown") continue;
    }
    current.evidence.push({ blockId: block.blockId, quote: block.quote });
    if (block.kind === "earned") { current.earnedCredits = block.credits; current.earnedGpa = block.gpa; }
    if (block.kind === "needs") { current.needsCourses = block.courses; current.needsCredits = block.credits; }
    if (block.kind === "select_from") {
      const list = parseAuditCourseList(block.text, table);
      current.acceptableCourseKeys = [...new Set([...current.acceptableCourseKeys, ...list.courseKeys])];
      if (list.unresolved.length) { current.coverage = "partial"; partial = true; }
    }
    if (block.kind === "applied") {
      const course = resolveCourseIdentity(block.course, table), term = parseAuditCourseTerm(block.term);
      const explicitState = block.flags.includes("PL") ? "planned" : block.flags.includes("IP") ? "in_progress" : undefined;
      current.appliedCourses.push({ courseKey: course.status === "resolved" ? course.courseKey : null, rawCourse: block.course,
        termCode: term?.code ?? null, credits: block.credits, grade: block.grade,
        state: classifyHistoryState({ grade: block.grade, explicitState, termCode: term?.code ?? null, currentTermCode }) });
      if (course.status === "unknown" || !term) { current.coverage = "partial"; partial = true; }
    }
  }
  if (blocks.length > 10000) partial = true;
  // Propagate contingent or unknown evidence up the tree before accepting a completion flag.
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const depth = (node: AuditNode) => { let result = 0, parent = node.parentId; const seen = new Set<string>(); while (parent && byId.has(parent) && !seen.has(parent) && result < 32) { seen.add(parent); parent = byId.get(parent)!.parentId; result++; } return result; };
  for (const node of [...nodes].sort((a, b) => depth(b) - depth(a))) {
    const children = nodes.filter((child) => child.parentId === node.nodeId);
    const states = [...node.appliedCourses.map((course) => course.state), ...children.map((child) => child.status)];
    if (node.flags.includes("PL") || states.includes("planned")) node.status = "planned";
    else if (node.flags.includes("IP") || states.includes("in_progress")) node.status = "in_progress";
    else if (node.coverage !== "complete" || states.includes("unknown") || node.kind === "unknown") node.status = "unknown";
    else if (node.rawStatus === "NO" || node.flags.includes("-") || (node.needsCourses ?? 0) > 0 || (node.needsCredits ?? 0) > 0 || children.some((child) => child.status === "incomplete")) node.status = "incomplete";
    else if (node.rawStatus === "OK" || node.flags.includes("+")) node.status = "completed";
    else node.status = "unknown";
  }
  // Invalid normalized adapter input is not promoted to a plausible audit tree.
  const valid = nodes.map((node) => auditNodeSchema.safeParse(node));
  if (valid.some((node) => !node.success)) return { nodes: valid.flatMap((node) => node.success ? [{ ...node.data, coverage: "partial" as const, status: "unknown" as const }] : []), coverage: "partial" };
  return { nodes, coverage: partial ? "partial" : "complete" };
}
export function potentialAuditCoverage(courseKey: string, audits: PlanningAudit[], table?: CourseIdentityTable): {
  matches: { auditId: string; nodeId: string; title: string; requirementKind: AuditNode["requirementKind"]; evidence: AuditNode["evidence"]; provenance: PlanningAudit["provenance"] }[];
  multipleRequirements: boolean; doubleCounting: "not_established"; coverage: "complete" | "partial" | "unknown";
} {
  const canonical = (key: string) => table ? canonicalizeCourseKey(key, table) : key;
  const matches: ReturnType<typeof potentialAuditCoverage>["matches"] = [];
  let partial = false, validCount = 0;
  for (const input of audits) {
    const parsed = planningAuditSchema.safeParse(input);
    if (!parsed.success) { partial = true; continue; }
    validCount++;
    const audit = parsed.data;
    if (audit.coverage !== "complete") partial = true;
    for (const node of audit.nodes) {
      if (node.coverage !== "complete") partial = true;
      // Contingently fulfilled nodes must stay visible, but are not new open requirements.
      if (node.status !== "incomplete" || node.kind === "unknown" || !node.evidence.length) continue;
      if (node.acceptableCourseKeys.some((key) => canonical(key) === canonical(courseKey))) matches.push({ auditId: audit.id, nodeId: node.nodeId, title: node.title, requirementKind: node.requirementKind, evidence: node.evidence, provenance: audit.provenance });
    }
  }
  return { matches, multipleRequirements: matches.length > 1, doubleCounting: "not_established", coverage: !validCount ? "unknown" : partial ? "partial" : "complete" };
}

export type PlanningCandidate = {
  course: PlanningCatalogCourse; package: PlanningEnrollmentPackage | null;
  requirementMatches: ReturnType<typeof potentialAuditCoverage>["matches"];
  prerequisite: PrerequisiteResult; schedule: ReturnType<typeof checkPackageConflicts>;
  progress: { unlocksRequirements: number; coreWithFewOptions: number; electives: number; generalEducation: number };
  schedulePenalty: number | null;
  gradeEvidence?: GradeAverage; ratingEvidence?: { score: number; count: number; sourceUrl: string; observedAt: string };
};
/** Lexicographic progress, then schedule. Historical grades/ratings are display evidence only. */
export function rankPlanningCandidates(candidates: PlanningCandidate[], history: PlanningCourseHistory[], table?: CourseIdentityTable): PlanningCandidate[] {
  const canonical = (key: string) => table ? canonicalizeCourseKey(key, table) : key;
  // Conservative duplicate protection: a completed attempt is not recommended again automatically, including an F.
  const taken = new Set(history.filter((row) => row.state === "completed" || row.state === "in_progress").map((row) => canonical(row.courseKey)));
  const rank = (candidate: PlanningCandidate) => [
    candidate.progress.unlocksRequirements, candidate.progress.coreWithFewOptions,
    candidate.progress.electives, candidate.progress.generalEducation,
  ];
  return candidates.filter((row) => !taken.has(canonical(row.course.courseKey)) && row.requirementMatches.length > 0 && row.prerequisite.status !== "unmet" && row.schedule.status !== "conflict" && row.package?.status !== "cancelled" && row.package?.status !== "closed")
    .sort((a, b) => {
      const aRank = rank(a), bRank = rank(b);
      for (let i = 0; i < aRank.length; i++) { const delta = bRank[i] - aRank[i]; if (delta) return delta; }
      const scheduleState = { clear: 0, unknown: 1, conflict: 2 };
      const stateDelta = scheduleState[a.schedule.status] - scheduleState[b.schedule.status];
      if (stateDelta) return stateDelta;
      const penaltyDelta = (a.schedulePenalty ?? Number.POSITIVE_INFINITY) - (b.schedulePenalty ?? Number.POSITIVE_INFINITY);
      if (penaltyDelta && Number.isFinite(penaltyDelta)) return penaltyDelta;
      if (a.schedulePenalty === null && b.schedulePenalty !== null) return 1;
      if (a.schedulePenalty !== null && b.schedulePenalty === null) return -1;
      return a.course.courseKey.localeCompare(b.course.courseKey);
    });
}
