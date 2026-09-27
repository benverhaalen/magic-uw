import { z } from "zod";

const resourceId = z.string().min(1).max(256);
export const personalReportEvidenceSchema = z.object({
  resourceId,
  contentHash: z.string().min(1).max(256),
}).strict();
export type PersonalReportEvidence = z.infer<typeof personalReportEvidenceSchema>;
export type PersonalReportPurpose = "reading-review" | "deadline-review";
const evidenceSchema = z.array(personalReportEvidenceSchema).min(1).max(12)
  .refine(items => new Set(items.map(item => item.resourceId)).size === items.length, "Duplicate report evidence.");

/** Identity is semantic purpose + exact objects, never generated wording or display title. */
export function personalReportIssue(purpose: PersonalReportPurpose, resourceIds: readonly string[]): string {
  if (purpose !== "reading-review" && purpose !== "deadline-review") throw new Error("Unsupported report purpose.");
  const ids = z.array(resourceId).min(1).max(12).parse(resourceIds);
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate report evidence.");
  return `${purpose}:${JSON.stringify([...ids].sort())}`;
}
/** Canonical evidence fingerprint, deliberately readable and independent of model wording. */
export function personalReportVersion(evidence: readonly PersonalReportEvidence[]): string {
  return `v1:${JSON.stringify(evidenceSchema.parse(evidence).sort((a, b) => a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0).map(e => [e.resourceId, e.contentHash]))}`;
}
export const personalReportChangeSchema = z.object({
  operationId: z.string().min(1).max(128),
  issueId: z.string().min(1).max(4000),
  evidence: evidenceSchema,
  sourceVersion: z.string().min(1).max(7000),
  handled: z.boolean(),
  expectedRevision: z.number().int().nonnegative(),
}).strict().superRefine((value, ctx) => {
  const ids = value.evidence.map(e => e.resourceId);
  if (!["reading-review", "deadline-review"].some(purpose => personalReportIssue(purpose as PersonalReportPurpose, ids) === value.issueId))
    ctx.addIssue({ code: "custom", message: "Report issue does not match its purpose and evidence." });
  if (personalReportVersion(value.evidence) !== value.sourceVersion)
    ctx.addIssue({ code: "custom", message: "Report version does not match its evidence." });
});
export type PersonalReportChange = z.infer<typeof personalReportChangeSchema>;
/** Small renderer projection. This is a personal report, never source completion or learning evidence. */
export interface PersonalReportState {
  issueId: string;
  sourceVersion: string;
  handled: boolean;
  revision: number;
  reportedAt: string;
}
/** Journal stays local; it is not included in snapshots or any AI/MCP payload. */
export interface PersonalReportEvent extends PersonalReportChange {
  revision: number;
  reportedAt: string;
  accountScope: string;
}
export function personalReportState(states: readonly PersonalReportState[] | undefined, issueId: string, sourceVersion: string) {
  const latest = states?.find(state => state.issueId === issueId);
  return {
    revision: latest?.revision ?? 0,
    record: latest?.sourceVersion === sourceVersion && latest.handled
      ? { issueId, sourceVersion, reportedAt: latest.reportedAt }
      : null,
  };
}
