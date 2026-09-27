import { createHash } from "node:crypto";
import type { StatementSync } from "node:sqlite";
import type { Resource } from "@magic/contracts";
import {
  personalWorkChangeSchema, personalWorkIssue, personalWorkVersion,
  type PersonalWorkChange, type PersonalWorkDescriptor, type PersonalWorkEvent,
  type PersonalWorkObligation, type PersonalWorkState,
} from "../../contracts/src/personal-work";

export interface PersonalWorkResource { resource: Resource; accountScope: string; termKey: string; checkable: boolean }
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Do not replace with contentHash: that includes grades, submission, comments and capture metadata. */
export function personalWorkObligation(resource: Resource): PersonalWorkObligation {
  const requirement = resource.moduleItem?.completionRequirement;
  return {
    title: resource.title, instructionHash: hash(resource.text.replace(/\r\n?/g, "\n").trim()),
    dueAt: resource.dueAt ?? null, lockAt: resource.lockAt ?? null, unlockAt: resource.unlockAt ?? null,
    moduleDueAt: resource.moduleItem?.dueAt ?? null,
    deadlines: [...resource.deadlines].map(({value,kind,authority,scopeConfirmed}) => ({value,kind,authority,scopeConfirmed}))
      .sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    points: resource.points, submissionTypes: [...new Set(resource.submissionTypes ?? [])].sort(),
    // Rubric criteria define work; scores/comments are in submission and excluded. A module's completed flag is excluded.
    requirementsHash: hash({moduleType: resource.moduleItem?.type ?? null, moduleContentId: resource.moduleItem?.contentId ?? null, rubric: resource.rubric ?? null, requirement: requirement ? {type: requirement.type, minScore: requirement.minScore ?? null} : null,
      modulePoints: resource.moduleItem?.points ?? null, moduleLockAt: resource.moduleItem?.lockInfo?.lockAt ?? null,
      moduleUnlockAt: resource.moduleItem?.lockInfo?.unlockAt ?? null}),
  };
}
const prefix = "personalWork:";
/** Preferences journal with the same transaction/CAS/exact-replay contract as personal reports.
 * Partition by account + captured course term. Nothing expires; old term partitions remain local. */
export function personalWorkRepository(
  prepare: (sql: string) => StatementSync,
  transaction: <T>(run: () => T) => T,
  evidenceResource: (id: string) => PersonalWorkResource | undefined,
  now: () => Date,
  snapshotEvidenceResource?: (resources?: readonly Resource[]) => (id: string) => PersonalWorkResource | undefined,
) {
  function read(): PersonalWorkEvent[] {
    const rows = prepare("SELECT value FROM preferences WHERE key LIKE 'personalWork:%' ORDER BY key").all();
    return rows.flatMap(row => {
      const value: unknown = JSON.parse(String(row.value));
      if (!Array.isArray(value)) throw new Error("Saved work reports could not be read.");
      for (const entry of value) {
        const {revision, reportedAt, ...change} = entry;
        personalWorkChangeSchema.parse(change);
        if (!Number.isSafeInteger(revision) || revision < 1 || revision !== change.expectedRevision + 1 || typeof reportedAt !== "string" || !Number.isFinite(Date.parse(reportedAt)))
          throw new Error("Saved work reports could not be read.");
      }
      return value as PersonalWorkEvent[];
    });
  }
  function accessible(event: PersonalWorkDescriptor, resolve = evidenceResource) {
    return event.evidence.every(e => {
      const current = resolve(e.resourceId);
      return current?.accountScope === event.scope.accountScope && current.resource.courseId === event.scope.courseId;
    });
  }
  function project(event: PersonalWorkEvent): PersonalWorkState {
    const {operationId: _operation, expectedRevision: _expected, ...state} = event;
    return state;
  }
  function fingerprint(input: PersonalWorkChange) {
    return JSON.stringify({...input, evidence: [...input.evidence].sort((a,b) => a.resourceId.localeCompare(b.resourceId))});
  }
  const partition = (e: PersonalWorkDescriptor) => prefix + JSON.stringify([e.scope.accountScope, e.scope.termKey]);
  function describePersonalWork(canonicalResourceId: string, contributorIds: readonly string[] = [], resolve = evidenceResource): PersonalWorkDescriptor | undefined {
    const primary = resolve(canonicalResourceId);
    if (!primary?.checkable) return undefined;
    const ids = [...new Set([canonicalResourceId, ...contributorIds])].sort();
    const resources = ids.map(id => resolve(id));
    if (resources.some(r => !r || r.accountScope !== primary.accountScope || r.resource.courseId !== primary.resource.courseId)) return undefined;
    const scope = {accountScope: primary.accountScope, courseId: primary.resource.courseId, canonicalResourceId, termKey: primary.termKey};
    const evidence = resources.map(r => ({resourceId: r!.resource.id, obligation: personalWorkObligation(r!.resource)}));
    return {scope, issueId: personalWorkIssue(scope), evidence, sourceVersion: personalWorkVersion(evidence)};
  }
  function reports(resolve = evidenceResource): PersonalWorkState[] {
      const latest = new Map<string, PersonalWorkEvent>();
      for (const event of read()) if ((latest.get(event.issueId)?.revision ?? 0) < event.revision) latest.set(event.issueId, event);
      return [...latest.values()].filter(event => {
        const primary = resolve(event.scope.canonicalResourceId);
        return primary?.accountScope === event.scope.accountScope && primary.resource.courseId === event.scope.courseId;
      }).map(event => {
        if (accessible(event, resolve)) return project(event);
        // Keep revision and the student's choice recoverable when a secondary source disappears.
        // Do not expose inaccessible evidence (also embedded in the readable saved version).
        return {...project(event), unavailableEvidence: true, sourceVersion: `unavailable-obligation:${event.revision}`,
          evidence: event.evidence.filter(e => {
            const current = resolve(e.resourceId);
            return current?.accountScope === event.scope.accountScope && current.resource.courseId === event.scope.courseId;
          })};
      });
   }
  return {
    describePersonalWork,
    personalWorkReports(): PersonalWorkState[] {
      return reports(snapshotEvidenceResource?.() ?? evidenceResource);
    },
    personalWorkSnapshot(requests: readonly {canonicalResourceId: string; contributorIds?: readonly string[]}[], resources?: readonly Resource[]) {
      const resolve = snapshotEvidenceResource?.(resources) ?? evidenceResource;
      const descriptors = requests.flatMap(request => {
        const descriptor = describePersonalWork(request.canonicalResourceId, request.contributorIds, resolve);
        return descriptor ? [descriptor] : [];
      });
      return {descriptors, reports: reports(resolve)};
    },
    personalWorkHistory(issueId: string, limit = 50): PersonalWorkEvent[] {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("Invalid work history limit.");
      return read().filter(e => e.issueId === issueId && accessible(e)).sort((a,b) => a.revision - b.revision).slice(-limit);
    },
    setPersonalWork(input: PersonalWorkChange): PersonalWorkState {
      const change = personalWorkChangeSchema.parse(input);
      return transaction(() => {
        if (!accessible(change)) throw new Error("This source is no longer available. Refresh your courses before trying again.");
        const history = read();
        const priorOperation = history.find(e => e.operationId === change.operationId);
        if (priorOperation) {
          const {revision: _revision, reportedAt: _at, ...prior} = priorOperation;
          if (fingerprint(prior) !== fingerprint(change)) throw new Error("This operation ID was already used for a different choice.");
          return project(priorOperation); // receipt only: never reapply a checked state after Undo
        }
        const current = describePersonalWork(change.scope.canonicalResourceId, change.evidence.map(e => e.resourceId));
        if (!current || current.issueId !== change.issueId || current.scope.termKey !== change.scope.termKey)
          throw new Error("This work is no longer available to check. Refresh your courses.");
        if (current.sourceVersion !== change.sourceVersion) throw new Error("The work requirements changed. Review the updated work before saving your choice.");
        const latest = history.filter(e => e.issueId === change.issueId).sort((a,b) => b.revision - a.revision)[0];
        if ((latest?.revision ?? 0) !== change.expectedRevision) throw new Error("Your choice changed in another view. Refresh your courses and try again.");
        // Undo always remains available for a saved check, even if its old obligation now needs review.
        if (!change.checked && !latest?.checked) throw new Error("There is no saved work report to undo.");
        const key = partition(change);
        const entries = history.filter(e => partition(e) === key);
        if (change.checked && (entries.length >= 20000 || (!entries.some(e => e.issueId === change.issueId) && new Set(entries.map(e => e.issueId)).size >= 2000)))
          throw new Error("Work history for this term is full. Existing choices and Undo are still available.");
        const event: PersonalWorkEvent = {...change, revision: change.expectedRevision + 1, reportedAt: now().toISOString()};
        prepare("INSERT INTO preferences VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify([...entries, event]));
        return project(event);
      });
    },
  };
}
