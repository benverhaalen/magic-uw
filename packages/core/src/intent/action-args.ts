/** The resolved-argument schemas every action narrows (IDs and dates from code, never the model). */
import { z } from "zod";
import type { ResolvedCourse } from "./types";

export const courseSchema = z
  .object({ ref: z.string(), accountScope: z.string(), courseId: z.string(), code: z.string().nullable(), name: z.string() })
  .strict();
export const rangeSchema = z.object({ from: z.iso.date(), to: z.iso.date(), label: z.string() }).strict();
export const timeSchema = z.object({ start: z.number().int().min(0).max(1439), end: z.number().int().min(1).max(1440) }).strict();
export const assignmentSchema = z.object({ resourceId: z.string(), title: z.string() }).strict();
export const baseArgs = z
  .object({
    text: z.string(),
    course: courseSchema.optional(),
    assignment: assignmentSchema.optional(),
    topicIds: z.array(z.string()).max(50).optional(),
    topicText: z.string().max(500).optional(),
    date: rangeSchema.optional(),
    time: timeSchema.optional(),
    query: z.string().max(500).optional(),
    kind: z.enum(["cards", "quiz"]).optional(),
    count: z.number().int().min(1).max(30).optional(),
    scope: z.enum(["course", "all"]).optional(),
  })
  .strict();
export const withCourse = baseArgs.extend({ course: courseSchema });
export type WithCourse = z.infer<typeof withCourse>;
export const withAssignment = baseArgs.extend({ assignment: assignmentSchema });
export type WithAssignment = z.infer<typeof withAssignment>;
export const courseLabel = (c?: ResolvedCourse) => (c ? (c.code ?? c.name) : "");
