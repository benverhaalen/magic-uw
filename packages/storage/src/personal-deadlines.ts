import type { StatementSync } from "node:sqlite";
import { personalDeadlineChangeSchema, type PersonalDeadlineChange, type PersonalDeadlineEvent, type PersonalDeadlineSource } from "@magic/contracts";

type EvidenceResource = { contentHash: string; accountScope: string };
export function personalDeadlineRepository(
  prepare: (sql: string) => StatementSync,
  transaction: <T>(run: () => T) => T,
  evidenceResource: (id: string) => EvidenceResource | undefined,
  now: () => Date,
) {
  function read(): PersonalDeadlineEvent[] {
    const row = prepare("SELECT value FROM preferences WHERE key='personalDeadlineChoices'").get();
    if (!row) return [];
    const value: unknown = JSON.parse(String(row.value));
    if (!Array.isArray(value)) throw new Error("Saved personal dates could not be read.");
    for (const event of value) {
      if (!event || typeof event !== "object") throw new Error("Saved personal dates could not be read.");
      const { revision, reportedAt, accountScope, evidence, selected, ...change } = event;
      personalDeadlineChangeSchema.parse(change);
      if (!Number.isSafeInteger(revision) || revision !== change.expectedRevision + 1 ||
          typeof reportedAt !== "string" || !Number.isFinite(Date.parse(reportedAt)) || typeof accountScope !== "string" || !accountScope ||
          !Array.isArray(evidence) || !evidence.length || evidence.some(e => !e || typeof e.resourceId !== "string" || typeof e.contentHash !== "string") ||
          (selected === null ? change.optionId !== null : !selected || selected.id !== change.optionId || !["minute", "day"].includes(selected.precision) || !Number.isFinite(Date.parse(selected.value))))
        throw new Error("Saved personal dates could not be read.");
    }
    return value as PersonalDeadlineEvent[];
  }
  // Keep the revision when an old contributor disappears; only the current target/account may see it.
  const accessible = (event: PersonalDeadlineEvent) => evidenceResource(event.resourceId)?.accountScope === event.accountScope;
  const sameChange = (a: PersonalDeadlineChange, b: PersonalDeadlineChange) => a.operationId === b.operationId && a.resourceId === b.resourceId && a.sourceVersion === b.sourceVersion && a.optionId === b.optionId && a.expectedRevision === b.expectedRevision;
  return {
    personalDeadlineChoices(): PersonalDeadlineEvent[] {
      const latest = new Map<string, PersonalDeadlineEvent>();
      for (const event of read()) latest.set(JSON.stringify([event.accountScope, event.resourceId]), event);
      return [...latest.values()].filter(accessible);
    },
    setPersonalDeadlineChoice(input: PersonalDeadlineChange, currentSource: () => PersonalDeadlineSource): PersonalDeadlineEvent {
      const change = personalDeadlineChangeSchema.parse(input);
      return transaction(() => {
        // Core recomputes from permitted canonical claims under the same SQLite write transaction.
        const current = currentSource();
        if (current.resourceId !== change.resourceId || !current.accountScope || !current.evidence.some(e => e.resourceId === current.resourceId))
          throw new Error("The date evidence does not match this item.");
        if (current.evidence.some(e => { const row = evidenceResource(e.resourceId); return !row || row.accountScope !== current.accountScope || row.contentHash !== e.contentHash; }))
          throw new Error("This source is no longer available. Refresh before choosing a date.");
        const history = read();
        const previous = history.find(event => event.operationId === change.operationId);
        if (previous) {
          if (previous.accountScope !== current.accountScope || !sameChange(previous, change)) throw new Error("This operation ID was already used for a different choice.");
          return previous; // A receipt replay cannot reapply a selection after Undo/change.
        }
        if (current.sourceVersion !== change.sourceVersion) throw new Error("The source changed. Review the updated dates before saving your choice.");
        const latest = history.findLast(event => event.resourceId === change.resourceId && event.accountScope === current.accountScope);
        if ((latest?.revision ?? 0) !== change.expectedRevision) throw new Error("Your choice changed in another view. Refresh and try again.");
        const option = current.options.find(candidate => candidate.id === change.optionId);
        if (change.optionId !== null && (!option || current.options.length < 2)) throw new Error("Choose one of the current sourced dates.");
        if (change.optionId === null && !latest?.selected) throw new Error("There is no personal date to undo.");
        if (history.length >= 10000 || (!latest && new Set(history.map(event => JSON.stringify([event.accountScope, event.resourceId]))).size >= 1000)) throw new Error("Personal date history is full. Your existing choices are still saved.");
        const event: PersonalDeadlineEvent = { ...change, accountScope: current.accountScope, evidence: current.evidence,
          selected: option ? { id: option.id, value: option.value, precision: option.precision } : null,
          revision: change.expectedRevision + 1, reportedAt: now().toISOString() };
        prepare("INSERT INTO preferences VALUES ('personalDeadlineChoices',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify([...history, event]));
        return event;
      });
    },
  };
}
