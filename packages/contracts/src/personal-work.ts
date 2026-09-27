import { z } from "zod";

const id = z.string().min(1).max(256);
export const personalWorkScopeSchema = z.object({
  accountScope: id, courseId: id, canonicalResourceId: id, termKey: z.string().min(1).max(600),
}).strict();
export type PersonalWorkScope = z.infer<typeof personalWorkScopeSchema>;
const date = z.string().max(100).nullable();
/** A server-built summary of the obligation, never the source's submission or grade state. */
export const personalWorkObligationSchema = z.object({
  title: z.string().max(500), instructionHash: z.string().regex(/^[a-f0-9]{64}$/),
  dueAt: date, lockAt: date, unlockAt: date, moduleDueAt: date,
  deadlines: z.array(z.object({value: z.string().max(100), kind: z.enum(["due", "lock", "event"]), authority: z.string().max(100), scopeConfirmed: z.boolean()}).strict()).max(30),
  points: z.number().nullable(), submissionTypes: z.array(z.string().max(100)).max(100),
  requirementsHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type PersonalWorkObligation = z.infer<typeof personalWorkObligationSchema>;
export const personalWorkEvidenceSchema = z.object({ resourceId: id, obligation: personalWorkObligationSchema }).strict();
export type PersonalWorkEvidence = z.infer<typeof personalWorkEvidenceSchema>;
const evidence = z.array(personalWorkEvidenceSchema).min(1).max(40).refine(items => new Set(items.map(e => e.resourceId)).size === items.length, "Duplicate work evidence.");
export function personalWorkIssue(scope: PersonalWorkScope): string {
  const s = personalWorkScopeSchema.parse(scope);
  return `personal-work:${JSON.stringify([s.accountScope, s.courseId, s.canonicalResourceId])}`;
}
export function personalWorkVersion(items: readonly PersonalWorkEvidence[]): string {
  return `obligation-v1:${JSON.stringify(evidence.parse(items).sort((a,b) => a.resourceId.localeCompare(b.resourceId)))}`;
}
export const personalWorkDescriptorSchema = z.object({
  scope: personalWorkScopeSchema, issueId: z.string().min(1).max(1600), evidence,
  sourceVersion: z.string().min(1).max(200000),
}).strict();
export type PersonalWorkDescriptor = z.infer<typeof personalWorkDescriptorSchema>;
export const personalWorkChangeSchema = personalWorkDescriptorSchema.extend({
  operationId: z.string().min(1).max(128), checked: z.boolean(), expectedRevision: z.number().int().nonnegative(),
}).strict().superRefine((change, ctx) => {
  if (change.issueId !== personalWorkIssue(change.scope) || !change.evidence.some(e => e.resourceId === change.scope.canonicalResourceId))
    ctx.addIssue({code: "custom", message: "Work identity does not match its scope and evidence."});
  if (change.sourceVersion !== personalWorkVersion(change.evidence))
    ctx.addIssue({code: "custom", message: "Work version does not match its obligation."});
});
export type PersonalWorkChange = z.infer<typeof personalWorkChangeSchema>;
export interface PersonalWorkState extends PersonalWorkDescriptor { unavailableEvidence?: boolean; checked: boolean; revision: number; reportedAt: string }
export interface PersonalWorkEvent extends PersonalWorkChange { revision: number; reportedAt: string }
export interface PersonalWorkDifference { resourceId: string; field: keyof PersonalWorkObligation | "evidence"; before: string | null; after: string | null }
export function personalWorkState(states: readonly PersonalWorkState[] | undefined, descriptor: PersonalWorkDescriptor) {
  const previous = states?.find(s => s.issueId === descriptor.issueId) ?? null;
  const obligationChanged = !!previous?.checked && previous.sourceVersion !== descriptor.sourceVersion;
  const changes: PersonalWorkDifference[] = [];
  if (obligationChanged) {
    if (previous?.unavailableEvidence) changes.push({resourceId: descriptor.scope.canonicalResourceId, field: "evidence", before: "Some earlier source evidence is unavailable", after: null});
    for (const resourceId of new Set([...previous!.evidence, ...descriptor.evidence].map(e => e.resourceId))) {
      const before = previous!.evidence.find(e => e.resourceId === resourceId)?.obligation;
      const after = descriptor.evidence.find(e => e.resourceId === resourceId)?.obligation;
      if (!before || !after) { changes.push({resourceId, field: "evidence", before: before?.title ?? null, after: after?.title ?? null}); continue; }
      for (const field of Object.keys(after) as (keyof PersonalWorkObligation)[])
        if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) changes.push({resourceId, field,
          before: typeof before[field] === "string" ? before[field] as string : JSON.stringify(before[field]),
          after: typeof after[field] === "string" ? after[field] as string : JSON.stringify(after[field])});
    }
  }
  const scheduleFields = new Set(["dueAt", "lockAt", "unlockAt", "moduleDueAt", "deadlines"]);
  const scheduleChanged = changes.some(change => scheduleFields.has(change.field));
  const needsReview = changes.some(change => !scheduleFields.has(change.field));
  const checked = !!previous?.checked;
  return {scheduleChanged, revision: previous?.revision ?? 0, checked, needsReview, changes, record: checked ? previous : null, previous};
}
