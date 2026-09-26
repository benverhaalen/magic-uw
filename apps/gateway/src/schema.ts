import { z } from "zod";

export const KINDS = [
  "essay",
  "problem_set",
  "quiz",
  "exam",
  "discussion",
  "project",
  "reading",
  "other",
] as const;
export type Kind = (typeof KINDS)[number];

export const assignmentStateSchema = z
  .object({
    course: z.string().min(1).max(200),
    title: z.string().min(1).max(500),
    text: z.string().max(12000),
    policy: z.string().max(4000),
  })
  .strict();
export type AssignmentState = z.infer<typeof assignmentStateSchema>;

export const judgmentRequestSchema = z
  .object({
    state: assignmentStateSchema,
  })
  .strict();
export type JudgmentRequest = z.infer<typeof judgmentRequestSchema>;
