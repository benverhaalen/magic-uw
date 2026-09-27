import { createHash } from "node:crypto";
import { z } from "zod";
import { planningCaptureSchema, uwTermCodeSchema, type PlanningCapture, type PlanningRecord } from "@magic/contracts";
import { decodeUwTerm } from "../../domain/src/planning";

// Observed read responses, September 26, 2026 (one account). Deliberately project only
// these fields: unknown properties, personal attributes and session credentials never
// leave this module. A recognized subset is not a complete student record.
const urls = {
  student: "https://enroll.wisc.edu/api/enroll/v1/studentInfo",
  terms: "https://public.enroll.wisc.edu/api/search/v1/aggregate",
  subjects: "https://enroll.wisc.edu/api/search/v1/subjectsMap/0000",
} as const;
const boundedText = (max: number) => z.string().trim().min(1).max(max).refine((s) => !/[\u0000-\u001f\u007f]/.test(s));
const epoch = z.number().int().min(Date.UTC(2000, 0, 1)).max(Date.UTC(2100, 0, 1) - 1);
const primarySchema = z.object({ careerCode: boundedText(30), programName: boundedText(100), termCode: uwTermCodeSchema });
const programSchema = z.object({ description: boundedText(300), isPrimaryProgramInTerm: z.boolean(),
  expectedGraduationTerm: z.object({ code: uwTermCodeSchema, description: boundedText(100) }) });
const appointmentSchema = z.object({ careerCode: boundedText(30), termCode: uwTermCodeSchema, termDescription: boundedText(100), registrationDateTime: epoch });
const subjectCodeSchema = z.string().regex(/^\d{1,6}$/);
const subjectEntrySchema = z.object({ subjectCode: subjectCodeSchema, formalDescription: boundedText(300), termCode: z.union([z.literal("0000"), uwTermCodeSchema]) });
const termSchema = z.object({
  termCode: uwTermCodeSchema, longDescription: boundedText(100), shortDescription: boundedText(100),
  academicYear: boundedText(20), pastTerm: z.boolean(), beginDate: epoch, endDate: epoch,
  instructionBeginDate: epoch, instructionEndDate: epoch,
});
const metadataSchema = z.object({
  accountScope: boundedText(200).refine((s) => s !== "public"),
  observedAt: z.iso.datetime({ offset: true }),
}).strict();
export type UwPlanningProfileContext = z.infer<typeof metadataSchema>;
type Dictionary = Record<string, unknown>;
function object(value: unknown): Dictionary | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as Dictionary : null;
}
function list(value: unknown, max: number): unknown[] | null {
  return Array.isArray(value) && value.length <= max ? value : null;
}
function stamp(value: string): string {
  const result = z.iso.datetime({ offset: true }).safeParse(value);
  if (!result.success) throw new Error("Invalid planning observation time.");
  return result.data;
}
function capture(
  source: PlanningCapture["source"], accountScope: string, observedAt: string,
  kind: PlanningCapture["scope"]["kind"], key: string, sourceUrl: string,
  status: PlanningCapture["status"], completeness: PlanningCapture["completeness"],
  records: PlanningRecord[], code: string, message: string,
): PlanningCapture {
  return planningCaptureSchema.parse({ schemaVersion: 1, id: `${key}:${observedAt}`, source, accountScope,
    observedAt, scope: { kind, key }, sourceUrl, status, completeness, records, diagnostics: [{ code, message }] });
}
function provenance(sourceUrl: string, observedAt: string, kind: PlanningCapture["scope"]["kind"], key: string) {
  return { sourceUrl, observedAt, scope: { kind, key } };
}

/** Structural check only. It returns no identity/session strings and does not prove
 * that another UW service is authenticated or that its response can be parsed. */
export function verifyMyUwSession(input: unknown): boolean {
  const person = object(object(input)?.person);
  if (!person) return false;
  return z.object({
    firstName: z.string().max(300), lastName: z.string().max(300), displayName: z.string().max(300),
    userName: boundedText(128), sessionKey: boundedText(4096), serverName: boundedText(253), version: boundedText(100),
  }).safeParse(person).success;
}

/** Return only the validated primary term, never a student identifier. */
export function getUwPrimaryTerm(input: unknown): string | null {
  const parsed = primarySchema.safeParse(object(input)?.primaryCareer);
  return parsed.success ? parsed.data.termCode : null;
}

function currentPrograms(input: unknown, termCode: string): { names: string[]; graduation: string | null } {
  const terms = list(object(input)?.academicObjectiveTerms, 100);
  if (!terms) return { names: [], graduation: null };
  const matches = terms.filter((entry) => object(object(entry)?.term)?.code === termCode);
  if (matches.length !== 1) return { names: [], graduation: null };
  const programs = list(object(matches[0])?.studentPrograms, 30);
  if (!programs) return { names: [], graduation: null };
  const names = new Set<string>();
  const graduations = new Set<string>();
  let allGraduationsKnown = programs.length > 0;
  for (const entry of programs) {
    const program = programSchema.safeParse(entry);
    if (!program.success) { allGraduationsKnown = false; continue; }
    names.add(program.data.description);
    graduations.add(program.data.expectedGraduationTerm.code);
  }
  return { names: [...names], graduation: allGraduationsKnown && graduations.size === 1 ? [...graduations][0] : null };
}

/** Four independent student_record scopes. Only explicit empty holds/advisors and
 * a wholly validated appointment enumeration can establish complete coverage. */
export function normalizeUwStudentInfo(input: unknown, context: UwPlanningProfileContext): PlanningCapture[] {
  const meta = metadataSchema.safeParse(context);
  if (!meta.success) throw new Error("Invalid private planning capture context.");
  const { accountScope, observedAt } = meta.data;
  const root = object(input), impacts = object(root?.enrollmentImpacts);
  const primary = primarySchema.safeParse(root?.primaryCareer);
  const make = (key: string, status: PlanningCapture["status"], completeness: PlanningCapture["completeness"], records: PlanningRecord[], code: string, message: string) =>
    capture("uw_enroll", accountScope, observedAt, "student_record", `student-info:${key}`, urls.student, status, completeness, records, code, message);
  const results: PlanningCapture[] = [];
  if (primary.success) {
    const programs = currentPrograms(root?.academicObjective, primary.data.termCode);
    results.push(make("summary", "partial", "partial", [{
      kind: "student_summary", id: "primary", provenance: provenance(urls.student, observedAt, "student_record", "student-info:summary"),
      career: primary.data.programName, programNames: programs.names, expectedGraduationTerm: programs.graduation,
      cumulativeGpa: null, earnedCredits: null, attemptedCredits: null,
    }], "student_summary_partial", "Primary career and programs from its matching term only. GPA, credits, and remaining student details are unverified; historical programs were not merged."));
  } else {
    results.push(make("summary", "failed", "unknown", [], "student_summary_invalid", "The primary career could not be validated. Saved student details were retained."));
  }
  for (const [key, value] of [["holds", impacts?.holds], ["advisors", root?.studentAdvisorRelationships]] as const) {
    const rows = list(value, 500);
    if (primary.success && rows?.length === 0) {
      results.push(make(key, "complete", "complete", [], `student_${key}_empty`, `The student response explicitly listed no ${key} in this scope.`));
    } else if (rows && rows.length > 0) {
      results.push(make(key, "partial", "unknown", [], `student_${key}_unparsed`, `This response contains ${key} whose row schema is not verified. Saved records were retained; absence is not established.`));
    } else {
      results.push(make(key, "failed", "unknown", [], `student_${key}_invalid`, `The ${key} list could not be validated. Saved records were retained; absence is not established.`));
    }
  }
  const rows = list(impacts?.registrationAppointments, 500);
  const appointments = new Map<string, PlanningRecord>();
  let invalid = !primary.success || rows === null;
  for (const row of rows ?? []) {
    const parsed = appointmentSchema.safeParse(row);
    if (!parsed.success) { invalid = true; continue; }
    const value = parsed.data;
    const id = createHash("sha256").update(JSON.stringify([value.careerCode, value.termCode, value.registrationDateTime])).digest("hex");
    appointments.set(id, { kind: "appointment", id,
      provenance: provenance(urls.student, observedAt, "student_record", "student-info:appointments"),
      termCode: value.termCode, startsAt: new Date(value.registrationDateTime).toISOString(), endsAt: null });
  }
  results.push(make("appointments", invalid ? appointments.size ? "partial" : "failed" : "complete", invalid ? appointments.size ? "partial" : "unknown" : "complete",
    [...appointments.values()], invalid ? "student_appointments_partial" : "student_appointments_verified",
    invalid ? "Some appointment rows could not be validated. Saved appointments were retained." : "Appointment start instants were read from the student response. End times were not supplied."));
  return results;
}

function corroboratesTerm(value: z.infer<typeof termSchema>): boolean {
  const term = decodeUwTerm(value.termCode);
  const long = /^(Fall|Spring|Summer) (\d{4})(?:-(\d{4}))?$/.exec(value.longDescription);
  const academic = /^(\d{4})-(\d{2}|\d{4})$/.exec(value.academicYear);
  return Boolean(long && long[1].toLowerCase() === term.season &&
    (long[3] ? Number(long[2]) === term.academicYear - 1 && Number(long[3]) === term.academicYear : Number(long[2]) === term.year) &&
    value.shortDescription === `${term.year} ${term.season[0].toUpperCase()}${term.season.slice(1)}` &&
    academic && Number(academic[1]) === term.academicYear - 1 && Number(academic[2]) === (academic[2].length === 2 ? term.academicYear % 100 : term.academicYear) &&
    value.beginDate <= value.instructionBeginDate && value.instructionBeginDate <= value.instructionEndDate && value.instructionEndDate <= value.endDate);
}

/** Enumerates only terms explicitly published by aggregate; source pastTerm wins
 * over the local clock. Term/session dates are not part of this normalized model. */
export function normalizeUwPublicTerms(input: unknown, observedAt: string): PlanningCapture {
  stamp(observedAt);
  const key = "public-search-terms", rows = list(object(input)?.terms, 100);
  const terms = new Map<string, PlanningRecord>();
  const conflicts = new Set<string>();
  let invalid = !rows?.length;
  for (const row of rows ?? []) {
    const parsed = termSchema.safeParse(row);
    if (!parsed.success || !corroboratesTerm(parsed.data)) {
      invalid = true;
      const code = uwTermCodeSchema.safeParse(object(row)?.termCode);
      if (code.success) conflicts.add(code.data);
      continue;
    }
    const term = decodeUwTerm(parsed.data.termCode), previous = terms.get(term.code);
    if (previous?.kind === "term" && previous.past !== parsed.data.pastTerm) { invalid = true; conflicts.add(term.code); }
    terms.set(term.code, { kind: "term", id: term.code, code: term.code, season: term.season, year: term.year,
      label: term.label, past: parsed.data.pastTerm, provenance: provenance(urls.terms, observedAt, "terms", key) });
  }
  for (const code of conflicts) terms.delete(code);
  return capture("uw_public", "public", observedAt, "terms", key, urls.terms,
    invalid ? terms.size ? "partial" : "failed" : "complete", invalid ? terms.size ? "partial" : "unknown" : "complete",
    [...terms.values()], invalid ? "public_terms_partial" : "public_terms_verified",
    invalid ? "Some published term rows could not be corroborated. Saved terms were retained." : "Published search terms and their explicit past-term flags were validated. Session details were not imported.");
}

/** Join the fixed subjectsMap/0000 enumeration to aggregate's matching 0000
 * subject bucket. Names never establish term availability or enrollment access. */
export function normalizeUwSubjectsMap(input: unknown, aggregate: unknown, observedAt: string): PlanningCapture {
  stamp(observedAt);
  const key = "search-subjects-map:0000", map = object(input);
  const entries: [string, unknown][] = [];
  // Stop enumerating before a locally supplied map can exceed the transport's bounds.
  if (map) for (const code in map) {
    if (Object.hasOwn(map, code)) entries.push([code, map[code]]);
    if (entries.length > 2000) break;
  }
  const rows = list(object(object(aggregate)?.subjects)?.["0000"], 2000);
  const names = new Map<string, string>(), conflicts = new Set<string>();
  let invalid = !map || !entries.length || entries.length > 2000 || !rows?.length;
  for (const row of rows ?? []) {
    const parsed = subjectEntrySchema.safeParse(row);
    if (!parsed.success || parsed.data.termCode !== "0000") {
      invalid = true;
      const code = subjectCodeSchema.safeParse(object(row)?.subjectCode);
      if (code.success) conflicts.add(code.data);
      continue;
    }
    const { subjectCode, formalDescription } = parsed.data;
    if (names.has(subjectCode) && names.get(subjectCode) !== formalDescription) { invalid = true; conflicts.add(subjectCode); }
    names.set(subjectCode, formalDescription);
  }
  const records: PlanningRecord[] = [];
  for (const [code, value] of entries.length <= 2000 ? entries : []) {
    const short = boundedText(100).safeParse(value);
    if (!subjectCodeSchema.safeParse(code).success || !short.success || !names.has(code) || conflicts.has(code)) { invalid = true; continue; }
    records.push({ kind: "subject", id: code, code, shortName: short.data, formalName: names.get(code)!, aliases: [],
      provenance: provenance(urls.subjects, observedAt, "subjects", key) });
  }
  return capture("uw_public", "public", observedAt, "subjects", key, urls.subjects,
    invalid ? records.length ? "partial" : "failed" : "complete", invalid ? records.length ? "partial" : "unknown" : "complete", records,
    invalid ? "public_subjects_partial" : "public_subjects_verified",
    invalid ? "Some subject codes or names could not be joined to the aggregate subject list. Saved subjects were retained." : "Subject abbreviations were joined to formal names from the public aggregate 0000 subject list. This does not establish term availability.");
}
