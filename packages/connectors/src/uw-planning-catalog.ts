import { createHash } from "node:crypto";
import { z } from "zod";
import { planningCaptureSchema, uwTermCodeSchema, type PlanningCapture, type PlanningRecord } from "@magic/contracts";
import { normalizeUwClassMeetings } from "./uw-planning-enrollment";
import type { UwPlanningReadRequest } from "./uw-planning-http";

// Public search and package responses observed September 26, 2026. These are
// allowlisted projections, not general Elasticsearch or enrollment capabilities.
const origin = "https://public.enroll.wisc.edu";
const subjectCode = z.string().regex(/^\d{1,6}$/);
const courseId = z.string().regex(/^\d{1,12}(?:\.\d{1,6})?$/);
const catalogNumber = z.string().trim().regex(/^[A-Z0-9]{1,12}$/);
const count = z.number().int().min(0).max(10_000_000);
const credits = z.number().min(0).max(1000);
const text = (max: number) => z.string().trim().min(1).max(max).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const instant = z.iso.datetime({ offset: true });
const status = z.enum(["OPEN", "WAITLISTED", "CLOSED"]);
const referenceSchema = z.object({ termCode: uwTermCodeSchema, subjectCode, courseId, catalogNumber }).strict();
export type UwPublicCourseReference = z.infer<typeof referenceSchema>;
const searchOptionsSchema = z.object({
  termCode: uwTermCodeSchema, subjectCode, observedAt: instant,
  query: z.string().max(500).refine((value) => !/[\u0000-\u001f\u007f]/.test(value)).default(""),
  page: z.number().int().min(1).max(20).default(1),
  enrollmentStatus: z.array(status).max(3).default([]),
}).strict();
export type UwPublicCourseSearchOptions = z.input<typeof searchOptionsSchema>;
const packageOptionsSchema = z.object({ course: referenceSchema, observedAt: instant }).strict();
export type UwPublicEnrollmentPackageOptions = z.infer<typeof packageOptionsSchema>;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
function options<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new Error("Invalid public course capture options.");
  return parsed.data;
}
function capture(key: string, sourceUrl: string, observedAt: string): PlanningCapture {
  return { schemaVersion: 1, id: `${key}:${observedAt}`, accountScope: "public", source: "uw_public",
    scope: { kind: "catalog_term", key }, sourceUrl, observedAt, status: "partial", completeness: "partial",
    records: [], diagnostics: [] };
}
function problem(result: PlanningCapture, code: string, message: string) {
  if (!result.diagnostics.some((row) => row.code === code)) result.diagnostics.push({ code, message });
}
function fail(result: PlanningCapture, code: string): PlanningCapture {
  result.status = "failed"; result.completeness = "unknown";
  problem(result, code, "The public course response did not match its bounded scope; saved evidence must be retained.");
  return planningCaptureSchema.parse(result);
}
const provenance = (result: PlanningCapture) => ({ sourceUrl: result.sourceUrl, observedAt: result.observedAt, scope: result.scope });

/** Native HTTP reconstructs the wire body. This builder exposes only a selected
 * subject, text query, fixed 50-row page and the three observed seat filters. */
export function buildUwPublicCourseSearchRequest(input: UwPublicCourseSearchOptions): UwPlanningReadRequest {
  const o = options(searchOptionsSchema, input);
  return { kind: "public-search", term: o.termCode, query: o.query, page: o.page, pageSize: 50,
    sort: "CATALOG_NUMBER", filters: { subjectCode: o.subjectCode, enrollmentStatus: [...new Set(o.enrollmentStatus)] } };
}
export function buildUwPublicEnrollmentPackagesRequest(input: UwPublicCourseReference): UwPlanningReadRequest {
  const course = options(referenceSchema, input);
  return { kind: "enrollment-packages", term: course.termCode, subject: course.subjectCode, courseId: course.courseId };
}

const designation = z.object({ code: z.string().max(50), description: text(100) });
const courseSchema = z.object({
  termCode: uwTermCodeSchema, courseId, catalogNumber,
  subject: z.object({ termCode: uwTermCodeSchema, subjectCode }),
  title: text(500), description: z.string().max(12000), minimumCredits: credits.nullable(), maximumCredits: credits.nullable(),
  enrollmentPrerequisites: z.string().max(8000).nullable(), typicallyOffered: z.string().max(300).nullable(),
  coreGeneralEducation: designation.nullable(), generalEd: designation.nullable(), ethnicStudies: designation.nullable(),
  breadths: z.array(designation).max(30), levels: z.array(designation).max(30),
});
const searchEnvelope = z.object({ success: z.literal(true), found: count, hits: z.array(z.unknown()).max(50) });
export type UwPublicCourseSearchResult = {
  capture: PlanningCapture; courses: UwPublicCourseReference[]; found: number | null; nextPage: number | null;
};

/** One page only. No result, including an empty result, claims full term coverage.
 * Keywords are full-text search, never an exact catalog-number predicate.
 * Topic variants retain distinct source IDs and share the canonical course key. */
export function normalizeUwPublicCourseSearch(input: unknown, rawOptions: UwPublicCourseSearchOptions): UwPublicCourseSearchResult {
  const o = options(searchOptionsSchema, rawOptions);
  const key = `public-search:${o.termCode}:${o.subjectCode}:${hash([o.query.trim(), [...new Set(o.enrollmentStatus)].sort()])}`;
  const result = capture(key, `${origin}/api/search/v1`, o.observedAt);
  problem(result, "search_subset", "This capture is one bounded search page, not a complete term catalog. Prerequisite text has not been interpreted.");
  const envelope = searchEnvelope.safeParse(input);
  if (!envelope.success) return { capture: fail(result, "unsupported_search_shape"), courses: [], found: null, nextPage: null };
  const { hits, found } = envelope.data;
  const offset = (o.page - 1) * 50;
  if (hits.length > found || hits.length && offset + hits.length > found || hits.length === 0 && offset < found)
    return { capture: fail(result, "inconsistent_search_page"), courses: [], found: null, nextPage: null };
  const rows = hits.map((row) => courseSchema.safeParse(row));
  const idCounts = new Map<string, number>();
  for (const row of rows) if (row.success) idCounts.set(row.data.courseId, (idCounts.get(row.data.courseId) ?? 0) + 1);
  const courses: UwPublicCourseReference[] = [];
  for (const parsed of rows) {
    if (!parsed.success) { problem(result, "invalid_search_rows", "Some public course rows could not be validated."); continue; }
    const row = parsed.data;
    if (row.termCode !== o.termCode || row.subject.termCode !== o.termCode || row.subject.subjectCode !== o.subjectCode ||
      idCounts.get(row.courseId) !== 1 || row.minimumCredits !== null && row.maximumCredits !== null && row.minimumCredits > row.maximumCredits) {
      problem(result, "conflicting_search_rows", "Some public course rows did not match the selected term, subject, or unique identity."); continue;
    }
    const courseKey = `uw:${row.subject.subjectCode}:${row.catalogNumber}`;
    const designations = [...new Set([row.coreGeneralEducation, row.generalEd, row.ethnicStudies, ...row.breadths, ...row.levels]
      .flatMap((item) => item ? [item.description] : []))];
    if (designations.length > 30) { problem(result, "bounded_designations", "Some public course designations exceeded the record bound."); continue; }
    result.records.push({ kind: "catalog_course", id: `course:${row.termCode}:${o.subjectCode}:${row.courseId}`, courseKey,
      termCode: row.termCode, provenance: provenance(result), title: row.title, description: row.description,
      creditMin: row.minimumCredits, creditMax: row.maximumCredits, designations,
      prerequisiteText: row.enrollmentPrerequisites, prerequisite: null, prerequisiteCheckedAt: null, offeringFrequency: row.typicallyOffered });
    courses.push({ termCode: row.termCode, subjectCode: o.subjectCode, courseId: row.courseId, catalogNumber: row.catalogNumber });
  }
  const nextPage = hits.length === 50 && offset + hits.length < found && o.page < 20 ? o.page + 1 : null;
  if (offset + hits.length < found && nextPage === null) problem(result, "search_page_bound", "Additional source results were not collected within the page bound.");
  return { capture: planningCaptureSchema.parse(result), courses, found, nextPage };
}

const classId = z.object({ termCode: uwTermCodeSchema, classNumber: count });
const instructor = z.object({ name: z.object({ first: text(100).nullable(), middle: text(100).nullable(), last: text(100).nullable() }) });
const sectionSchema = z.object({
  classUniqueId: classId, subject: z.object({ termCode: uwTermCodeSchema, subjectCode }), courseId, catalogNumber,
  type: text(40), sectionNumber: text(40), published: z.boolean(), active: z.boolean(),
  topic: z.object({ id: z.number().int().min(0).max(999999) }).nullable(),
  instructors: z.array(instructor).max(30),
});
const packageSchema = z.object({
  id: z.string().regex(/^\d{1,10}$/), docId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  termCode: uwTermCodeSchema, subjectCode, courseId, catalogNumber, enrollmentClassNumber: count,
  published: z.boolean(), sections: z.array(sectionSchema).min(1).max(30),
  packageEnrollmentStatus: z.unknown(), enrollmentStatus: z.unknown(),
  isAsynchronous: z.boolean(), classMeetings: z.array(z.unknown()).max(100), nestedClassMeetings: z.array(z.unknown()).max(100),
});
const availabilitySchema = z.object({ availableSeats: count, waitlistTotal: count, status });
const capacitySchema = z.object({ classUniqueId: classId, capacity: count });
function sectionMatches(section: z.infer<typeof sectionSchema>, course: UwPublicCourseReference): boolean {
  if (section.classUniqueId.termCode !== course.termCode || section.subject.termCode !== course.termCode ||
    section.subject.subjectCode !== course.subjectCode || section.catalogNumber !== course.catalogNumber) return false;
  if (section.courseId === course.courseId) return true;
  // The observed topic response keeps the dotted ID on the package and the base
  // course ID plus explicit topic.id on each section. Never infer this from title.
  const [base, topic] = course.courseId.split(".");
  return topic !== undefined && section.courseId === base && section.topic?.id === Number(topic);
}

/** Complete only for this selected course's package enumeration. Missing or
 * malformed meetings cannot establish a conflict-free schedule. The source
 * contains public instructor names; emails, identifiers and unknown text vanish. */
export function normalizeUwPublicEnrollmentPackages(input: unknown, rawOptions: UwPublicEnrollmentPackageOptions): PlanningCapture {
  const { course, observedAt } = options(packageOptionsSchema, rawOptions);
  const key = `public-packages:${course.termCode}:${course.subjectCode}:${course.courseId}`;
  const result = capture(key, `${origin}/api/search/v1/enrollmentPackages/${course.termCode}/${course.subjectCode}/${course.courseId}`, observedAt);
  if (!Array.isArray(input) || input.length > 500) return fail(result, "unsupported_package_shape");
  const rows = input.map((row) => packageSchema.safeParse(row));
  const counts = new Map<string, number>();
  for (const row of rows) if (row.success) counts.set(row.data.docId, (counts.get(row.data.docId) ?? 0) + 1);
  for (const parsed of rows) {
    if (!parsed.success) { problem(result, "invalid_package_rows", "Some public package rows could not be validated."); continue; }
    const row = parsed.data;
    if (row.termCode !== course.termCode || row.subjectCode !== course.subjectCode || row.courseId !== course.courseId ||
      row.catalogNumber !== course.catalogNumber || row.id !== String(row.enrollmentClassNumber) || counts.get(row.docId) !== 1 ||
      !row.published || row.sections.some((section) => !sectionMatches(section, course) || !section.published || !section.active) ||
      !row.sections.some((section) => section.classUniqueId.classNumber === row.enrollmentClassNumber) ||
      new Set(row.sections.map((section) => section.classUniqueId.classNumber)).size !== row.sections.length) {
      problem(result, "conflicting_package_rows", "Some package rows did not match the selected course or section identities."); continue;
    }
    const schedule = normalizeUwClassMeetings(row);
    if (!schedule.complete) problem(result, "incomplete_package_meetings", "Some public package meetings require verification; no conflict-free schedule is established.");
    const availability = availabilitySchema.safeParse(row.packageEnrollmentStatus);
    if (!availability.success) problem(result, "unknown_package_availability", "Some public package seat availability could not be validated.");
    const capacity = capacitySchema.safeParse(row.enrollmentStatus);
    const validCapacity = capacity.success && capacity.data.classUniqueId.termCode === course.termCode && capacity.data.classUniqueId.classNumber === row.enrollmentClassNumber;
    if (!validCapacity) problem(result, "unknown_package_capacity", "Some public package capacities could not be corroborated.");
    const names = [...new Set(row.sections.flatMap((section) => section.instructors.map((person) =>
      [person.name.first, person.name.middle, person.name.last].filter(Boolean).join(" ")).filter(Boolean)))];
    const safeNames = names.filter((name) => name.length <= 200).slice(0, 30);
    if (safeNames.length !== names.length) problem(result, "bounded_instructor_names", "Some public instructor names exceeded the record bound.");
    const record: PlanningRecord = { kind: "enrollment_package", id: `package:${hash([course, row.docId])}`,
      provenance: provenance(result), courseKey: `uw:${course.subjectCode}:${course.catalogNumber}`, termCode: course.termCode,
      sections: row.sections.map((section) => `${section.type} ${section.sectionNumber}`), enrollmentState: "available",
      status: availability.success ? ({ OPEN: "open", WAITLISTED: "waitlisted", CLOSED: "closed" } as const)[availability.data.status] : "unknown",
      meetings: schedule.meetings, meetingsComplete: schedule.complete,
      seatsAvailable: availability.success ? availability.data.availableSeats : null,
      waitlistCount: availability.success ? availability.data.waitlistTotal : null,
      capacity: validCapacity ? capacity.data.capacity : null, instructorNames: safeNames };
    result.records.push(record);
  }
  if (!result.diagnostics.length) { result.status = "complete"; result.completeness = "complete"; }
  return planningCaptureSchema.parse(result);
}
