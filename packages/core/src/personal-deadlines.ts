import { createHash } from "node:crypto";
import type { DeadlineResolution, PersonalDeadlineEvent, PersonalDeadlineProjection, PersonalDeadlineSource, Resource, Store } from "@magic/contracts";
import { evidenceFor } from "./evidence";
import { courseInclusion } from "./access";
import { localTime, resolveDeadline } from "@magic/domain";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Stable property ordering includes every evidence field, including spans and unresolved mentions. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export function personalDeadlineSource(resource: Resource, accountScope: string, deadline: DeadlineResolution, evidence: PersonalDeadlineSource["evidence"]): PersonalDeadlineSource {
  const groups = new Map<string, PersonalDeadlineSource["options"][number]>();
  for (const claim of deadline.claims) {
    if (claim.kind !== "due" || !claim.scopeConfirmed || claim.authority === "title" || !Number.isFinite(Date.parse(claim.value))) continue;
    const precision = claim.precision ?? "minute";
    // Day claims encode the start of a Chicago date. They never acquire a fabricated minute.
    const value = new Date(claim.value).toISOString();
    const id = `${precision}:${Date.parse(value)}`;
    const option = groups.get(id) ?? { id, value, precision, claims: [] };
    option.claims.push(claim);
    groups.set(id, option);
  }
  // A date-only feed corroborates the dated minute when it is the only exact
  // time on that Chicago date. Keep its claim, but do not ask the student to
  // choose twice between compatible versions of the same calendar day.
  for (const [id, day] of groups) {
    if (day.precision !== "day") continue;
    const date = localTime(day.value, "America/Chicago").date;
    const timed = [...groups.values()].filter(option => option.precision === "minute" && localTime(option.value, "America/Chicago").date === date);
    if (timed.length === 1) { timed[0]!.claims.push(...day.claims); groups.delete(id); }
  }
  const options = [...groups.values()].sort((a, b) => a.id.localeCompare(b.id));
  const sortedEvidence = [...evidence].sort((a, b) => a.resourceId.localeCompare(b.resourceId));
  return { resourceId: resource.id, accountScope, evidence: sortedEvidence, options,
    sourceVersion: hash(canonical({ resourceId: resource.id, accountScope, evidence: sortedEvidence,
      claims: deadline.claims.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      unresolved: (deadline.unresolved ?? []).map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) })) };
}
export function currentPersonalDeadlineSource(store: Store, resourceId: string): PersonalDeadlineSource {
  const resource = store.resource(resourceId);
  const sources = new Map(store.sources().map(source => [source.id, source]));
  const included = courseInclusion(store);
  const permitted = (row: Resource) => !row.deleted && included(row) && !!sources.get(row.sourceId) && sources.get(row.sourceId)?.status !== "inaccessible";
  if (!resource || !permitted(resource)) throw new Error("This source is no longer available. Refresh before choosing a date.");
  const evidence = evidenceFor(store, permitted);
  return personalDeadlineSource(resource, sources.get(resource.sourceId)!.accountScope,
    resolveDeadline(evidence.deadlines(resource), evidence.unresolvedDeadlines(resource)),
    evidence.contributors(resource).map(row => ({ resourceId: row.id, contentHash: row.contentHash })));
}
export function personalDeadlineProjection(source: PersonalDeadlineSource, events: readonly PersonalDeadlineEvent[]): PersonalDeadlineProjection {
  const latest = events.findLast(event => event.resourceId === source.resourceId && event.accountScope === source.accountScope);
  const selected = latest?.selected && latest.sourceVersion === source.sourceVersion && source.options.some(option => option.id === latest.optionId) ? latest.selected : null;
  return { sourceVersion: source.sourceVersion, revision: latest?.revision ?? 0, options: source.options,
    selected: selected ? { optionId: selected.id, value: selected.value, precision: selected.precision, reportedAt: latest!.reportedAt } : null,
    needsReview: !!latest?.selected && !selected };
}
