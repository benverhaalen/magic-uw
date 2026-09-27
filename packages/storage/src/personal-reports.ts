import type { StatementSync } from "node:sqlite";
import {
  personalReportChangeSchema,
  type PersonalReportChange,
  type PersonalReportEvent,
  type PersonalReportState,
} from "@magic/contracts";

type EvidenceResource = { contentHash: string; accountScope: string };
/** Existing preferences storage avoids racing unrelated schema-version migrations. */
export function personalReportRepository(
  prepare: (sql: string) => StatementSync,
  transaction: <T>(run: () => T) => T,
  evidenceResource: (id: string) => EvidenceResource | undefined,
  now: () => Date,
) {
  function read(): PersonalReportEvent[] {
    const row = prepare("SELECT value FROM preferences WHERE key='personalReports'").get();
    if (!row) return [];
    // Corruption must not silently reset revisions or destroy history on the next write.
    const value: unknown = JSON.parse(String(row.value));
    if (!Array.isArray(value)) throw new Error("Saved personal reports could not be read.");
    for (const entry of value) {
      const { revision, reportedAt, accountScope, ...change } = entry;
      personalReportChangeSchema.parse(change);
      if (!Number.isSafeInteger(revision) || revision < 1 || revision !== change.expectedRevision + 1 ||
          typeof reportedAt !== "string" || !Number.isFinite(Date.parse(reportedAt)) || typeof accountScope !== "string" || !accountScope)
        throw new Error("Saved personal reports could not be read.");
    }
    return value as PersonalReportEvent[];
  }
  function accessible(event: PersonalReportEvent) {
    return event.evidence.every(e => evidenceResource(e.resourceId)?.accountScope === event.accountScope);
  }
  function project(event: PersonalReportEvent): PersonalReportState {
    const { issueId, sourceVersion, handled, revision, reportedAt } = event;
    return { issueId, sourceVersion, handled, revision, reportedAt };
  }
  function fingerprint(change: PersonalReportChange) {
    return JSON.stringify({ ...change, evidence: [...change.evidence].sort((a, b) => a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0) });
  }
  return {
    personalReports(): PersonalReportState[] {
      const latest = new Map<string, PersonalReportEvent>();
      for (const event of read()) latest.set(JSON.stringify([event.accountScope, event.issueId]), event);
      return [...latest.values()].filter(accessible).map(project);
    },
    personalReportHistory(issueId: string, limit = 50): PersonalReportEvent[] {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("Invalid report history limit.");
      return read().filter(event => event.issueId === issueId && accessible(event)).slice(-limit);
    },
    setPersonalReport(input: PersonalReportChange): PersonalReportState {
      const change = personalReportChangeSchema.parse(input);
      return transaction(() => {
        const evidence = change.evidence.map(e => ({ wanted: e, current: evidenceResource(e.resourceId) }));
        if (evidence.some(e => !e.current)) throw new Error("This source is no longer available. Refresh the briefing before trying again.");
        const accountScope = evidence[0]!.current!.accountScope;
        if (!accountScope || evidence.some(e => e.current!.accountScope !== accountScope))
          throw new Error("A personal report cannot combine different accounts.");
        const history = read();
        const priorOperation = history.find(e => e.operationId === change.operationId);
        if (priorOperation) {
          const { revision: _revision, reportedAt: _at, accountScope: priorAccount, ...prior } = priorOperation;
          if (priorAccount !== accountScope || fingerprint(prior) !== fingerprint(change))
            throw new Error("This operation ID was already used for a different choice.");
          // Exact replay returns the original receipt; it never reapplies an old choice after Undo.
          return project(priorOperation);
        }
        if (evidence.some(e => e.current!.contentHash !== e.wanted.contentHash))
          throw new Error("The source changed. Review the updated briefing before saving your choice.");
        const latest = history.findLast(e => e.issueId === change.issueId && e.accountScope === accountScope);
        if ((latest?.revision ?? 0) !== change.expectedRevision)
          throw new Error("Your choice changed in another view. Refresh the briefing and try again.");
        if (!change.handled && (!latest?.handled || latest.sourceVersion !== change.sourceVersion))
          throw new Error("There is no current report to undo.");
        // Keep history intact; refuse excessive growth rather than silently losing provenance.
        if (history.length >= 10000 || (!latest && new Set(history.map(e => e.issueId)).size >= 1000))
          throw new Error("Personal report history is full. Your existing choices are still saved.");
        const event: PersonalReportEvent = { ...change, evidence: [...change.evidence].sort((a, b) => a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0), accountScope, reportedAt: now().toISOString(), revision: change.expectedRevision + 1 };
        prepare("INSERT INTO preferences VALUES ('personalReports',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
          .run(JSON.stringify([...history, event]));
        return project(event);
      });
    },
  };
}
