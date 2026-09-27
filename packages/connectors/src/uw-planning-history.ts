import { createHash } from "node:crypto";
import { z } from "zod";
import {
  planningCaptureSchema,
  planningCourseHistorySchema,
  uwTermCodeSchema,
  type CourseHistoryState,
  type PlanningCapture,
  type PlanningCourseHistory,
} from "@magic/contracts";
import type { UwPlanningHttp, UwPlanningReadResult } from "./uw-planning-http";

const origin = "https://enroll.wisc.edu";
const listUrl = `${origin}/api/planner/v1/degreePlan`;
const scope = { kind: "degree_plan" as const, key: "primary" };
const contextSchema = z.object({
  accountScope: z
    .string()
    .min(1)
    .max(200)
    .refine((value) => value !== "public"),
  observedAt: z.iso.datetime({ offset: true }),
});
const planIdSchema = z.string().regex(/^[1-9]\d{0,14}$/);
const listRowSchema = z.object({
  roadmapId: z.number().int().positive().max(999_999_999_999_999),
  primary: z.boolean(),
});
const groupSchema = z.object({
  termCode: uwTermCodeSchema,
  courses: z.array(z.unknown()).max(1000),
});
const courseSchema = z.object({
  id: z.number().int().nonnegative().safe().nullable().optional(),
  courseId: z.string().min(1).max(100),
  subjectCode: z
    .string()
    .regex(/^\d{1,6}$/)
    .nullable(),
  catalogNumber: z.string().regex(/^[A-Z0-9]{1,12}$/),
  termCode: uwTermCodeSchema.nullable().optional(),
  topicId: z.number().int().nonnegative().safe().nullable().optional(),
  classNumber: z.string().max(100).nullable().optional(),
  credits: z.number().finite().min(0).max(1000).nullable().optional(),
  grade: z.string().max(20).nullable().optional(),
  studentEnrollmentStatus: z.string().max(100),
});
type Course = z.infer<typeof courseSchema>;
export interface UwDegreePlanHistoryContext {
  accountScope: string;
  observedAt: string;
}
export interface UwDegreePlanHistoryOptions extends UwDegreePlanHistoryContext {
  planId: string;
}

function checkedContext(
  input: UwDegreePlanHistoryContext,
): UwDegreePlanHistoryContext {
  const parsed = contextSchema.safeParse(input);
  if (!parsed.success) throw new Error("Invalid degree-plan capture context.");
  return parsed.data;
}
function capture(
  context: UwDegreePlanHistoryContext,
  sourceUrl: string,
  records: PlanningCourseHistory[],
  status: PlanningCapture["status"],
  diagnostics: PlanningCapture["diagnostics"],
): PlanningCapture {
  return planningCaptureSchema.parse({
    schemaVersion: 1,
    id: `degree-history-${context.observedAt}`,
    ...context,
    source: "uw_enroll",
    scope,
    sourceUrl,
    status,
    completeness:
      status === "complete"
        ? "complete"
        : status === "partial"
          ? "partial"
          : "unknown",
    records,
    diagnostics,
  });
}

/** An attempt's grade/status establishes state; elapsed time never establishes completion. */
function state(course: Course): CourseHistoryState {
  if (course.grade === "DR") return "dropped";
  if (course.grade === "W") return "withdrawn";
  if (course.grade === "IP") return "in_progress";
  if (course.studentEnrollmentStatus === "Dropped") return "dropped";
  if (course.studentEnrollmentStatus === "Withdrawn") return "withdrawn";
  if (["Enrolled", "Transfer"].includes(course.studentEnrollmentStatus)) {
    if (
      course.grade &&
      ["A", "AB", "B", "BC", "C", "D", "F", "S", "U", "CR", "P"].includes(
        course.grade,
      )
    )
      return "completed";
    if (course.studentEnrollmentStatus === "Transfer") return "completed";
    return course.grade ? "unknown" : "in_progress";
  }
  // The UW planner groups other records with a numeric planned-course ID as planned.
  if (typeof course.id === "number") return "planned";
  return "unknown";
}

/**
 * Current UW frontend getAllTermCourses uses /degreePlan/{roadmapId}/termcourses.
 * The response is a complete array of term groups, not /degreePlan/{id} metadata.
 * Source keys and grades are projected explicitly; names, identifiers, notes, and
 * nested enrollment results are neither retained nor placed in diagnostics.
 */
export function parseUwDegreePlanHistory(
  input: unknown,
  options: UwDegreePlanHistoryOptions,
): PlanningCapture {
  const context = checkedContext(options);
  if (!planIdSchema.safeParse(options.planId).success)
    throw new Error("Invalid degree-plan reference.");
  const sourceUrl = `${listUrl}/${options.planId}/termcourses`;
  if (!Array.isArray(input) || input.length > 300) {
    return capture(context, sourceUrl, [], "failed", [
      {
        code: "degree_history_shape",
        message:
          "The degree-plan history response could not be recognized; saved history was retained.",
      },
    ]);
  }
  const records: PlanningCourseHistory[] = [];
  const seenTerms = new Set<string>();
  const seenRecords = new Set<string>();
  let rejected = 0,
    unidentified = 0,
    unknownStates = 0,
    duplicates = 0;
  for (const rawGroup of input) {
    const parsedGroup = groupSchema.safeParse(rawGroup);
    if (!parsedGroup.success) {
      rejected++;
      continue;
    }
    const group = parsedGroup.data;
    if (seenTerms.has(group.termCode)) {
      duplicates++;
      continue;
    }
    seenTerms.add(group.termCode);
    for (const rawCourse of group.courses) {
      if (records.length >= 10_000) {
        rejected++;
        continue;
      }
      const parsed = courseSchema.safeParse(rawCourse);
      if (!parsed.success) {
        rejected++;
        continue;
      }
      const course = parsed.data;
      if (course.subjectCode === null) {
        unidentified++;
        continue;
      }
      if (course.termCode && course.termCode !== group.termCode) {
        rejected++;
        continue;
      }
      const courseKey = `uw:${course.subjectCode}:${course.catalogNumber}`;
      const identity = [
        group.termCode,
        courseKey,
        course.courseId,
        course.id ?? null,
        course.classNumber ?? null,
        course.topicId ?? null,
      ];
      const id = `attempt-${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
      if (seenRecords.has(id)) {
        duplicates++;
        continue;
      }
      seenRecords.add(id);
      const historyState = state(course);
      if (historyState === "unknown") unknownStates++;
      records.push(
        planningCourseHistorySchema.parse({
          id,
          kind: "course_history",
          provenance: { sourceUrl, observedAt: context.observedAt, scope },
          courseKey,
          termCode: group.termCode,
          state: historyState,
          credits: course.credits ?? null,
          grade: course.grade ?? null,
          // This endpoint does not establish GPA inclusion for UW attempts.
          gpaEligible:
            course.studentEnrollmentStatus === "Transfer" ? false : null,
        }),
      );
    }
  }
  const diagnostics: PlanningCapture["diagnostics"] = [];
  if (rejected)
    diagnostics.push({
      code: "degree_history_unverified_rows",
      message: `${rejected} term groups or course rows could not be validated.`,
    });
  if (unidentified)
    diagnostics.push({
      code: "degree_history_unidentified_courses",
      message: `${unidentified} course rows lacked an exact subject code and could not be matched to a UW course.`,
    });
  if (unknownStates)
    diagnostics.push({
      code: "degree_history_unknown_states",
      message: `${unknownStates} course attempts have an unrecognized grade or enrollment state; their original grade was retained.`,
    });
  if (duplicates)
    diagnostics.push({
      code: "degree_history_duplicate_identity",
      message: `${duplicates} duplicate term groups or attempt identities were omitted.`,
    });
  return capture(
    context,
    sourceUrl,
    records,
    diagnostics.length ? "partial" : "complete",
    diagnostics,
  );
}

function failure(
  context: UwDegreePlanHistoryContext,
  sourceUrl: string,
  result: Exclude<UwPlanningReadResult, { status: "ok" }>,
): PlanningCapture {
  const status =
    result.status === "needs_sign_in" || result.status === "forbidden"
      ? "blocked"
      : result.status === "unsupported"
        ? "unsupported"
        : "failed";
  return capture(context, sourceUrl, [], status, [
    {
      code: "degree_history_read_unavailable",
      message:
        "Degree-plan history could not be read; saved history was retained. Reconnect UW if access has expired.",
    },
  ]);
}

/** Reads the explicitly primary plan (or the sole plan); never merges alternative plans. */
export async function pullUwDegreePlanHistory(
  client: Pick<UwPlanningHttp, "read">,
  options: UwDegreePlanHistoryContext & { signal?: AbortSignal },
): Promise<PlanningCapture> {
  const context = checkedContext(options);
  options.signal?.throwIfAborted();
  let sourceUrl = listUrl;
  try {
    const list = await client.read({ kind: "degree-plans" }, options.signal);
    options.signal?.throwIfAborted();
    if (list.status !== "ok") return failure(context, sourceUrl, list);
    const parsed = z.array(listRowSchema).max(100).safeParse(list.data);
    if (
      !parsed.success ||
      new Set(parsed.data.map((plan) => plan.roadmapId)).size !==
        parsed.data.length
    ) {
      return capture(context, sourceUrl, [], "failed", [
        {
          code: "degree_plan_list_shape",
          message:
            "The degree-plan list could not be recognized; saved history was retained.",
        },
      ]);
    }
    const primary = parsed.data.filter((plan) => plan.primary);
    const plan =
      primary.length === 1
        ? primary[0]
        : primary.length === 0 && parsed.data.length === 1
          ? parsed.data[0]
          : undefined;
    if (!plan) {
      return capture(context, sourceUrl, [], "partial", [
        {
          code: parsed.data.length
            ? "degree_plan_selection_ambiguous"
            : "degree_plan_unavailable",
          message: parsed.data.length
            ? "A unique primary degree plan was not identified; alternative plans were not combined."
            : "UW returned no degree plan. This does not establish an empty academic history.",
        },
      ]);
    }
    const planId = String(plan.roadmapId);
    sourceUrl = `${listUrl}/${planId}/termcourses`;
    const detail = await client.read(
      { kind: "degree-plan-detail", planId },
      options.signal,
    );
    options.signal?.throwIfAborted();
    if (detail.status !== "ok") return failure(context, sourceUrl, detail);
    return parseUwDegreePlanHistory(detail.data, { ...context, planId });
  } catch {
    options.signal?.throwIfAborted();
    return capture(context, sourceUrl, [], "failed", [
      {
        code: "degree_history_read_failed",
        message:
          "Degree-plan history could not be read; saved history was retained.",
      },
    ]);
  }
}
