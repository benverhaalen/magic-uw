import { OUTLOOK_CALENDAR_COURSE_ID, personalPlanningAt, type DeadlineEvidenceClaim, type Link, type ResourceView } from '@magic/contracts';
import { localTime, resolveDeadline, type RailResource } from '@magic/domain';

/** Renderer-only semantic view; a feed record keeps its original kind and navigation identity. */
export type ScheduleResource = RailResource & {
  url?: string; sourceId?: string; accountScope?: string; sourceScope?: string; contentHash?: string;
  observedAt?: string; workflowState?: string | null;
  moduleItem?: ResourceView['moduleItem'];
  personalDeadline?: ResourceView['personalDeadline'];
  deadlineContributors?: ResourceView['deadlineContributors'];
  scheduleDeadline?: { family: string; feedOnly: boolean; sourceOnly?: boolean; sourceLabel?: string; evidenceIds: string[]; choiceUnavailable?: string };
};
const unique = <T,>(values: T[]) => [...new Map(values.map(value => [JSON.stringify(value), value])).values()];
const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);
const valid = (value: string | undefined) => !!value && Number.isFinite(Date.parse(value));
/** Same provider identity used by graph agenda, with trusted source gating and tuple scope. */
export function scheduleAssignmentId(resource: ScheduleResource): string | null {
  if (!resource.accountScope || !resource.courseId || resource.courseId === OUTLOOK_CALENDAR_COURSE_ID) return null;
  if (resource.kind === 'assignment') {
    // Canvas account lists can prefix externalId; the exact scoped provider URL is retained.
    try { const path = new URL(resource.url ?? '').pathname; const match = /^\/courses\/([^/]+)\/assignments\/([^/]+)\/?$/.exec(path);
      if (match && decodeURIComponent(match[1]!) === resource.courseId) return decodeURIComponent(match[2]!);
    } catch { /* An absent/invalid URL cannot establish an alias. */ }
    return resource.externalId ? resource.sourceScope?.split(':')[0] === 'quizzes' ? `quiz:${resource.externalId}` : resource.externalId : null;
  }
  if (resource.sourceScope?.split(':')[0] === 'module-items' && resource.moduleItem?.contentId) {
    if (resource.moduleItem.type === 'Quiz') return `quiz:${resource.moduleItem.contentId}`;
    if (resource.moduleItem.type === 'Assignment') return resource.moduleItem.contentId;
  }
  if (resource.kind !== 'event' || resource.sourceScope !== 'calendar_feed' || !resource.calendar) return null;
  const explicit = resource.calendar.assignmentExternalId;
  const uid = /^event-assignment-(\d+)$/.exec(resource.calendar.uid)?.[1];
  // Contradictory provider identifiers do not authorize association.
  if (explicit && uid && explicit !== uid) return null;
  return explicit ?? uid ?? null;
}
function dayInstant(date: string): string {
  let lo = Date.parse(`${date}T12:00:00Z`) - 36 * 3600000, hi = lo + 72 * 3600000;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (localTime(new Date(mid).toISOString(), 'America/Chicago').date < date) lo = mid; else hi = mid;
  }
  return new Date(hi).toISOString();
}
function feedClaim(resource: ScheduleResource): DeadlineEvidenceClaim[] {
  const calendar = resource.calendar;
  if (resource.kind !== 'event' || !calendar || !scheduleAssignmentId(resource) || !valid(calendar.start)) return [];
  const day = calendar.allDay || isDate(calendar.start);
  return [{ kind: 'due', value: day ? dayInstant(calendar.start.slice(0, 10)) : calendar.start,
    precision: day ? 'day' : 'minute', authority: 'structured', origin: 'calendar', scopeConfirmed: true,
    quote: `Calendar DTSTART: ${calendar.start}`, note: `Saved calendar record ${resource.id}. Assignment association uses its provider identifier.` }];
}
/** No title matching, widening of access, write to claims, or assignment capability fabrication. */
export type ScheduleAlias = { resourceId: string; targetId: string };
export function projectScheduleResources<T extends ScheduleResource>(resources: T[], links: Link[] = [], aliases: ScheduleAlias[] = []): (T & ScheduleResource)[] {
  const live = resources.filter(r => !r.deleted && r.workflowState?.toUpperCase() !== 'CANCELLED');
  const byId = new Map(live.map(r => [r.id, r]));
  const blocked = new Set<string>();
  for (const link of links) if (link.type === 'same_as' && (link.status !== 'accepted' || byId.get(link.fromId)?.contentHash !== link.inputHash)) {
    blocked.add(link.fromId); blocked.add(link.toId);
  }
  const exactAliases = new Map<string, T>();
  for (const alias of aliases) {
    const resource = byId.get(alias.resourceId), target = byId.get(alias.targetId);
    if (!resource || !target || !resource.accountScope || resource.accountScope !== target.accountScope || resource.courseId !== target.courseId || blocked.has(resource.id) || blocked.has(target.id)) continue;
    const module = resource.moduleItem;
    if (!module || !['Assignment', 'Quiz'].includes(module.type) || module.contentId !== target.externalId || target.kind !== 'assignment') continue;
    if ((module.type === 'Quiz') !== (target.sourceScope?.split(':')[0] === 'quizzes')) continue;
    exactAliases.set(resource.id, target);
  }
  const groups = new Map<string, T[]>();
  for (const resource of live) {
    if (resource.scheduleDeadline) { groups.set(`projected:${resource.id}`, [resource]); continue; }
    const id = scheduleAssignmentId(exactAliases.get(resource.id) ?? resource);
    const family = id && !blocked.has(resource.id) ? JSON.stringify([resource.accountScope, resource.courseId, id]) : `resource:${resource.id}`;
    groups.set(family, [...(groups.get(family) ?? []), resource]);
  }
  return [...groups.entries()].map(([family, group]) => {
    if (group[0]!.scheduleDeadline) return group[0]!;
    const ordered = [...group].sort((a, b) => {
      const rank = (r: T) => r.kind === 'assignment' ? r.sourceScope === 'assignments' ? 2 : 1 : 0;
      return rank(b) - rank(a) || (b.observedAt ?? '').localeCompare(a.observedAt ?? '') || a.id.localeCompare(b.id);
    });
    const main = ordered[0]!;
    if (main.kind !== 'assignment' && !scheduleAssignmentId(main)) return main;
    const claims = unique(group.flatMap(r => [...r.deadline.claims, ...feedClaim(r)]));
    const unresolved = unique(group.flatMap(r => r.deadline.unresolved ?? []));
    const deadline = resolveDeadline(claims, unresolved);
    // A richer upstream resolution must not be weakened by display deduplication.
    deadline.conflict ||= group.some(r => r.deadline.conflict);
    const contributors = unique(group.flatMap(r => r.deadlineContributors ?? (r.contentHash ? [{ resourceId: r.id, contentHash: r.contentHash }] : [])));
    const known = new Set((main.deadlineContributors ?? (main.contentHash ? [{ resourceId: main.id, contentHash: main.contentHash }] : [])).map(c => JSON.stringify(c)));
    const additionalEvidence = contributors.some(c => !known.has(JSON.stringify(c)));
    const choice = main.personalDeadline;
    const selected = choice?.selected;
    const currentSelection = selected && !choice.needsReview && !additionalEvidence && choice.options.some(o => o.id === selected.optionId && o.value === selected.value && o.precision === selected.precision);
    const personalDeadline = choice && !currentSelection && selected ? { ...choice, selected: null, needsReview: true } : choice;
    return { ...main, deadline, deadlineContributors: contributors, personalDeadline,
      scheduleDeadline: { family, feedOnly: main.kind === 'event', sourceOnly: main.kind !== 'assignment',
        sourceLabel: main.kind === 'event' ? 'Calendar feed' : main.kind !== 'assignment' ? `Module ${main.moduleItem?.type.toLowerCase() ?? 'item'}` : undefined, evidenceIds: group.map(r => r.id),
        choiceUnavailable: additionalEvidence && choice ? "Saving a choice for these calendar dates is not available yet." : undefined } };
  });
}
export function schedulePlanning(resource: ScheduleResource, timeZone: string) {
  const selected = !resource.personalDeadline?.needsReview ? resource.personalDeadline?.selected : null;
  const at = personalPlanningAt({ deadline: resource.deadline, personalDeadline: selected ? resource.personalDeadline : undefined });
  if (!valid(at ?? undefined)) return null;
  const matching = resource.deadline.claims.filter(c => c.kind === 'due' && c.scopeConfirmed && Date.parse(c.value) === Date.parse(at!));
  const precision = selected?.precision ?? (matching.length && matching.every(c => c.precision === 'day') ? 'day' : 'minute');
  const when = localTime(at!, precision === 'day' ? 'America/Chicago' : timeZone);
  return { at: at!, date: when.date, minute: precision === 'day' ? null : when.min, precision, personal: !!selected,
    conflict: resource.deadline.conflict && !selected, needsReview: !!resource.personalDeadline?.needsReview };
}
/** Feed deadlines are not meetings or captured assignments eligible for generated work blocks. */
export function scheduleRailResources<T extends ScheduleResource>(resources: T[]): T[] {
  return resources.filter(r => !r.scheduleDeadline?.sourceOnly).map(r => {
    const planning = schedulePlanning(r, 'America/Chicago');
    return planning?.personal ? { ...r, deadline: { ...r.deadline, planningAt: planning.at } } : r;
  });
}
