import { z } from "zod";
import {
  planningCaptureSchema, uwTermCodeSchema,
  type PlanningCapture, type PlanningRecord, type PlanningMeeting,
} from "@magic/contracts";
import { millisecondsToMinute, normalizeMeetingDays } from "../../domain/src/planning";

const code = z.string().regex(/^\d{1,6}$/);
// PeopleSoft section rows pad this designation even when the package value is unpadded.
const catalog = z.string().trim().regex(/^[A-Z0-9]{1,12}$/);
const count = z.number().int().min(0).max(10_000_000);
const credits = z.number().min(0).max(1000);
const optionsSchema = z.object({
  accountScope: z.string().min(1).max(200).refine((value) => value !== "public", "A private account scope is required."),
  observedAt: z.iso.datetime({ offset: true }), termCode: uwTermCodeSchema,
}).strict();
export type UwCurrentEnrollmentOptions = z.infer<typeof optionsSchema>;

// These are allowlisted projections of the observed current-enrollment wire shape.
// Unknown fields are stripped, never copied into planning records or diagnostics.
const sectionSchema = z.object({
  subjectCode: code, courseCatalogNumber: catalog, courseId: z.string().min(1).max(100),
  classNumber: z.string().regex(/^\d{1,10}$/), classSection: z.string().min(1).max(40),
  classSSRComponent: z.string().min(1).max(40), enrollmentStatus: z.string().max(30),
  numCreditsTaken: credits.nullable(), isAuditing: z.boolean(), grade: z.string().max(20).nullable(),
});
const classMeetingsInputSchema = z.object({
  isAsynchronous: z.boolean(),
  classMeetings: z.array(z.unknown()).max(100), nestedClassMeetings: z.array(z.unknown()).max(100),
});
const rowSchema = z.object({
  termCode: uwTermCodeSchema, subjectCode: code, catalogNumber: catalog,
  courseId: z.string().min(1).max(100), enrollmentClassNumber: count,
  studentEnrollmentStatus: z.string().max(30), credits: credits.nullable(),
  ...classMeetingsInputSchema.shape, sections: z.array(sectionSchema).min(1).max(30),
  packageEnrollmentStatus: z.unknown().optional(), enrollmentStatus: z.unknown().optional(),
  details: z.unknown().optional(),
});
const meetingSchema = z.object({
  meetingOrExamNumber: z.string().max(100), meetingType: z.string().max(30),
  meetingTimeStart: z.number().int().nullable(), meetingTimeEnd: z.number().int().nullable(),
  meetingDays: z.string().max(100).nullable(), meetingDaysList: z.array(z.string().max(30)).max(7),
  examDate: z.number().int().nullable(),
  building: z.object({ buildingName: z.string().max(250) }).nullable(), room: z.string().max(50).nullable(),
});
const weekdayNames = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
const nestedMeetingSchema = meetingSchema.extend({
  monday: z.boolean(), tuesday: z.boolean(), wednesday: z.boolean(), thursday: z.boolean(),
  friday: z.boolean(), saturday: z.boolean(), sunday: z.boolean(),
  startDate: z.number().int().nullable(), endDate: z.number().int().nullable(),
});
const availabilitySchema = z.object({ availableSeats: count, waitlistTotal: count, status: z.string().max(30) });
const capacitySchema = z.object({
  classUniqueId: z.object({ termCode: uwTermCodeSchema, classNumber: count }), capacity: count,
});
const designationSchema = z.object({ code: z.string().max(50), description: z.string().max(100) });
const detailsSchema = z.object({
  termCode: uwTermCodeSchema, courseId: z.string().min(1).max(100), catalogNumber: catalog,
  subject: z.object({ termCode: uwTermCodeSchema, subjectCode: code }),
  title: z.string().min(1).max(500), description: z.string().max(12000),
  minimumCredits: credits.nullable(), maximumCredits: credits.nullable(),
  enrollmentPrerequisites: z.string().max(8000).nullable(), typicallyOffered: z.string().max(300).nullable(),
  coreGeneralEducation: designationSchema.nullable(), generalEd: designationSchema.nullable(),
  ethnicStudies: designationSchema.nullable(), breadths: z.array(designationSchema).max(30),
  levels: z.array(designationSchema).max(30),
});

const dateFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
/** Observed date fields are epoch milliseconds at Chicago midnight, including DST changes. */
function localDate(value: number | null): string | null {
  if (value === null || value < Date.UTC(1999, 0, 1) || value >= Date.UTC(2100, 0, 1) || value % 1000) return null;
  const parts = Object.fromEntries(dateFormat.formatToParts(value).map((part) => [part.type, part.value]));
  if (parts.hour !== "00" || parts.minute !== "00" || parts.second !== "00") return null;
  return `${parts.year}-${parts.month}-${parts.day}`;
}
const unknownMeeting = (kind: PlanningMeeting["kind"] = "class"): PlanningMeeting => ({
  kind, mode: "unknown", days: [], startMinute: null, endMinute: null,
  startDate: null, endDate: null, timezone: "America/Chicago", location: null,
});
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function meetingSignature(m: z.infer<typeof meetingSchema>): string {
  return JSON.stringify([m.meetingOrExamNumber, m.meetingType, m.meetingTimeStart, m.meetingTimeEnd,
    m.meetingDays, [...m.meetingDaysList].sort(), m.examDate]);
}
/**
 * UW encodes clock values with a fixed six-hour offset, independently of meeting dates.
 * Verified against public.enroll.wisc.edu/chunk-EME7AD4Y.js (2026-09-26): the class
 * schedule subtracts 21600 seconds and displays with UTC-6. Exam clocks use Chicago
 * at the Unix epoch, which has the same offset. Do not apply the term's DST offset.
 */
function uwClockMinute(value: number | null, end = false): number | null {
  if (value === null) return null;
  const localMilliseconds = value - 21_600_000;
  return end && localMilliseconds === 86_400_000 ? 1440 : millisecondsToMinute(localMilliseconds);
}

/** Shared only by UW endpoints whose observed meeting projection matches this shape. */
export function normalizeUwClassMeetings(input: unknown): { meetings: PlanningMeeting[]; complete: boolean } {
  const inputResult = classMeetingsInputSchema.safeParse(input);
  if (!inputResult.success) return { meetings: [unknownMeeting()], complete: false };
  const row = inputResult.data;
  const flat = row.classMeetings.map((value) => meetingSchema.safeParse(value));
  const nested = row.nestedClassMeetings.map((value) => nestedMeetingSchema.safeParse(value));
  let complete = flat.every((value) => value.success) && nested.every((value) => value.success);
  // Both arrays describe the same meeting multiset. Do not join on meeting number alone:
  // related sections reuse those numbers in the observed response.
  if (!same(flat.flatMap((m) => m.success ? [meetingSignature(m.data)] : []).sort(),
    nested.flatMap((m) => m.success ? [meetingSignature(m.data)] : []).sort())) complete = false;
  const meetings: PlanningMeeting[] = nested.map((parsed) => {
    if (!parsed.success) { complete = false; return unknownMeeting(); }
    const m = parsed.data;
    if (m.meetingType !== "CLASS" && m.meetingType !== "EXAM") { complete = false; return unknownMeeting(); }
    const result = unknownMeeting(m.meetingType === "EXAM" ? "exam" : "class");
    const location = [m.building?.buildingName, m.room].filter(Boolean).join(" · ");
    result.location = location.length <= 300 && location ? location : null;
    let days: number[] = [];
    let daysKnown = true;
    if (result.kind === "exam") {
      const exam = localDate(m.examDate);
      result.startDate = exam; result.endDate = exam;
      if (exam) days = [((new Date(`${exam}T00:00:00Z`).getUTCDay() + 6) % 7) + 1];
      else daysKnown = false;
    } else {
      result.startDate = localDate(m.startDate); result.endDate = localDate(m.endDate);
      if (result.startDate && result.endDate && result.startDate > result.endDate) {
        result.startDate = null; result.endDate = null; complete = false;
      }
      const letters = m.meetingDays === null ? { days: [], unknown: false } : normalizeMeetingDays(m.meetingDays);
      const list = m.meetingDaysList.map((day) => weekdayNames.indexOf(day.toLowerCase() as typeof weekdayNames[number]) + 1);
      const flags = weekdayNames.flatMap((day, index) => m[day] ? [index + 1] : []);
      const listed = [...new Set(list)].sort();
      daysKnown = !letters.unknown && !list.includes(0) && same(letters.days, listed) && same(listed, flags);
      days = flags;
      if (row.isAsynchronous && daysKnown && !days.length && m.examDate === null) {
        result.mode = "asynchronous";
        return result;
      }
      if (m.examDate !== null) daysKnown = false;
    }
    result.days = daysKnown ? days : [];
    result.startMinute = uwClockMinute(m.meetingTimeStart);
    result.endMinute = uwClockMinute(m.meetingTimeEnd, true);
    if (result.startMinute !== null && result.endMinute !== null && result.startMinute >= result.endMinute) {
      result.startMinute = null; result.endMinute = null;
    }
    if (daysKnown && days.length && result.startMinute !== null && result.endMinute !== null && result.startDate && result.endDate) result.mode = "scheduled";
    else complete = false;
    return result;
  });
  if (!meetings.length) {
    // Explicit asynchronous status supports a class without a time; absence alone does not.
    meetings.push({ ...unknownMeeting(), mode: row.isAsynchronous && complete ? "asynchronous" : "unknown" });
    if (!row.isAsynchronous) complete = false;
  }
  if (!complete && !meetings.some((meeting) => meeting.mode === "unknown") && meetings.length < 100) meetings.push(unknownMeeting());
  return { meetings, complete };
}

/**
 * Normalize a successful JSON body from /api/enroll/v1/current/{termCode}.
 * Live shape evidence currently covers term 1272 only. This does not fetch or authenticate.
 * History is always partial: a current-term response cannot enumerate past degree history.
 */
export function normalizeUwCurrentEnrollment(input: unknown, rawOptions: UwCurrentEnrollmentOptions): PlanningCapture[] {
  const options = optionsSchema.parse(rawOptions);
  const sourceUrl = `https://enroll.wisc.edu/api/enroll/v1/current/${options.termCode}`;
  const scopes = [
    { kind: "enrollment_term" as const, key: options.termCode },
    { kind: "degree_plan" as const, key: `current-enrollment:${options.termCode}` },
    { kind: "catalog_term" as const, key: `current-enrollment:${options.termCode}` },
  ];
  const captures = scopes.map((scope): PlanningCapture => ({
    schemaVersion: 1, id: `${scope.kind}:current:${options.termCode}:${options.observedAt}`,
    accountScope: options.accountScope, source: "uw_enroll", scope, sourceUrl, observedAt: options.observedAt,
    status: scope.kind === "enrollment_term" ? "complete" : "partial",
    completeness: scope.kind === "enrollment_term" ? "complete" : "partial", records: [], diagnostics: [],
  }));
  const [enrollment, history, catalogCapture] = captures;
  history.diagnostics.push({ code: "current_term_only", message: "Current enrollment is not a complete degree history." });
  catalogCapture.diagnostics.push({ code: "enrolled_catalog_subset", message: "Catalog details cover only courses in this current-term response." });
  const provenance = (capture: PlanningCapture) => ({ sourceUrl, observedAt: options.observedAt, scope: capture.scope });
  const problems = new Map(captures.map((capture) => [capture, new Map<string, number>()]));
  const problem = (key: string, affected = captures) => {
    for (const capture of affected) {
      const counts = problems.get(capture)!;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  };
  if (!Array.isArray(input) || input.length > 500) {
    for (const capture of captures) {
      capture.status = "failed"; capture.completeness = "unknown";
      capture.diagnostics.push({ code: "unsupported_enrollment_shape", message: "Current enrollment was not a bounded array; saved evidence must be retained." });
    }
    return captures.map((capture) => planningCaptureSchema.parse(capture));
  }
  const parsed = input.map((row) => rowSchema.safeParse(row));
  const packageCounts = new Map<number, number>();
  for (const row of parsed) if (row.success) packageCounts.set(row.data.enrollmentClassNumber, (packageCounts.get(row.data.enrollmentClassNumber) ?? 0) + 1);
  const catalogRows = new Map<string, PlanningRecord>();
  const catalogConflicts = new Set<string>();
  for (const value of parsed) {
    if (!value.success) { problem("invalid_enrollment_rows"); continue; }
    const row = value.data;
    if (row.termCode !== options.termCode || packageCounts.get(row.enrollmentClassNumber) !== 1 ||
      !["E", "D"].includes(row.studentEnrollmentStatus) ||
      row.sections.some((section) => section.subjectCode !== row.subjectCode || section.courseCatalogNumber !== row.catalogNumber ||
        section.courseId !== row.courseId || section.enrollmentStatus !== row.studentEnrollmentStatus) ||
      !row.sections.some((section) => Number(section.classNumber) === row.enrollmentClassNumber)) {
      problem("conflicting_enrollment_rows"); continue;
    }
    const courseKey = `uw:${row.subjectCode}:${row.catalogNumber}`;
    const packageId = `current:${options.termCode}:${row.enrollmentClassNumber}`;
    const gradePresent = row.sections.some((section) => section.grade !== null && section.grade.trim() !== "");
    const auditing = row.sections.some((section) => section.isAuditing);
    history.records.push({ kind: "course_history", id: packageId, provenance: provenance(history), courseKey,
      termCode: row.termCode, state: row.studentEnrollmentStatus === "D" ? "dropped" : gradePresent || auditing ? "unknown" : "in_progress",
      credits: row.credits, grade: null, gpaEligible: auditing ? false : null });
    if (gradePresent || auditing) problem("history_state_unknown", [history]);
    if (row.studentEnrollmentStatus === "E") {
      const schedule = normalizeUwClassMeetings(row);
      if (!schedule.complete) problem("incomplete_meetings", [enrollment]);
      const availability = availabilitySchema.safeParse(row.packageEnrollmentStatus);
      const capacity = capacitySchema.safeParse(row.enrollmentStatus);
      const status = availability.success ? ({ OPEN: "open", WAITLISTED: "waitlisted", CLOSED: "closed" } as const)[availability.data.status as "OPEN" | "WAITLISTED" | "CLOSED"] ?? "unknown" : "unknown";
      if (!availability.success || status === "unknown") problem("unknown_seat_status", [enrollment]);
      const validCapacity = capacity.success && capacity.data.classUniqueId.termCode === row.termCode && capacity.data.classUniqueId.classNumber === row.enrollmentClassNumber;
      enrollment.records.push({ kind: "enrollment_package", id: packageId, provenance: provenance(enrollment),
        courseKey, termCode: row.termCode, sections: [...new Set(row.sections.map((section) => `${section.classSSRComponent} ${section.classSection}`))],
        enrollmentState: "enrolled", status, meetings: schedule.meetings, meetingsComplete: schedule.complete,
        seatsAvailable: availability.success ? availability.data.availableSeats : null,
        waitlistCount: availability.success ? availability.data.waitlistTotal : null,
        capacity: validCapacity ? capacity.data.capacity : null, instructorNames: [] });
    }
    const details = detailsSchema.safeParse(row.details);
    if (!details.success || details.data.termCode !== row.termCode || details.data.subject.termCode !== row.termCode ||
      details.data.courseId !== row.courseId || details.data.subject.subjectCode !== row.subjectCode || details.data.catalogNumber !== row.catalogNumber ||
      details.data.minimumCredits !== null && details.data.maximumCredits !== null && details.data.minimumCredits > details.data.maximumCredits) {
      problem("unavailable_catalog_details", [catalogCapture]); continue;
    }
    const d = details.data;
    const record: PlanningRecord = { kind: "catalog_course", id: courseKey, courseKey, termCode: row.termCode,
      provenance: provenance(catalogCapture), title: d.title, description: d.description,
      creditMin: d.minimumCredits, creditMax: d.maximumCredits,
      designations: [...new Set([d.coreGeneralEducation, d.generalEd, d.ethnicStudies, ...d.breadths, ...d.levels].flatMap((designation) => designation ? [designation.description] : []))].slice(0, 30),
      prerequisiteText: d.enrollmentPrerequisites, prerequisite: null, prerequisiteCheckedAt: null, offeringFrequency: d.typicallyOffered };
    const previous = catalogRows.get(courseKey);
    if (previous && !same(previous, record)) { catalogConflicts.add(courseKey); problem("conflicting_catalog_details", [catalogCapture]); }
    else catalogRows.set(courseKey, record);
  }
  catalogCapture.records = [...catalogRows].flatMap(([key, record]) => catalogConflicts.has(key) ? [] : [record]);
  for (const [capture, counts] of problems) if (counts.size) {
    capture.status = "partial"; capture.completeness = "partial";
    for (const [code, count] of counts) capture.diagnostics.push({ code, message: `${count} current-enrollment rows require verification; saved evidence must be retained.` });
  }
  return captures.map((capture) => planningCaptureSchema.parse(capture));
}
