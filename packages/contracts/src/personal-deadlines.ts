import { z } from "zod";
import type { DeadlineEvidenceClaim, ResourceView } from "./index";
import type { PersonalReportEvidence } from "./personal-reports";

export const personalDeadlineChangeSchema = z.object({
  operationId: z.string().min(1).max(128),
  resourceId: z.string().min(1).max(256),
  sourceVersion: z.string().min(1).max(128),
  optionId: z.string().min(1).max(128).nullable(),
  expectedRevision: z.number().int().nonnegative(),
}).strict();
export type PersonalDeadlineChange = z.infer<typeof personalDeadlineChangeSchema>;
export interface PersonalDeadlineOption {
  id: string;
  value: string;
  precision: "minute" | "day";
  claims: DeadlineEvidenceClaim[];
}
/** Produced only by core from current permitted evidence, never accepted from renderer input. */
export interface PersonalDeadlineSource {
  resourceId: string;
  accountScope: string;
  sourceVersion: string;
  evidence: PersonalReportEvidence[];
  options: PersonalDeadlineOption[];
}
export interface PersonalDeadlineEvent extends PersonalDeadlineChange {
  accountScope: string;
  evidence: PersonalReportEvidence[];
  selected: Omit<PersonalDeadlineOption, "claims"> | null;
  revision: number;
  reportedAt: string;
}
export interface PersonalDeadlineProjection {
  sourceVersion: string;
  revision: number;
  options: PersonalDeadlineOption[];
  selected: { optionId: string; value: string; precision: "minute" | "day"; reportedAt: string } | null;
  needsReview: boolean;
}
/** Personal planning only. Callers must retain the source deadline/conflict and label personal choices. */
export function personalPlanningAt(resource: Pick<ResourceView, "deadline" | "personalDeadline">): string | null {
  return resource.personalDeadline?.selected?.value ?? resource.deadline.planningAt;
}
