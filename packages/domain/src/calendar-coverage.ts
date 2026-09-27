import type { ResourceView, SourceHealth } from '@magic/contracts';

export type CalendarCoverageState = 'missing' | 'partial' | 'stale' | 'current_capture';
export interface CalendarCoverageGroup {
  state: CalendarCoverageState;
  sourceIds: string[];
  /** Source identities retained by coursework whose health record is unavailable. */
  missingSourceIds: string[];
  /** Oldest usable check, never the newest source presented as freshness for all. */
  checkedThrough: string | null;
  latestAttemptAt: string | null;
  summary: string;
}
export interface CalendarCoverage {
  coursework: CalendarCoverageGroup;
  calendar: CalendarCoverageGroup;
  summary: string;
}
const DAY = 24 * 60 * 60 * 1000;
const valid = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? value : null;
const instantSort = (a: string, b: string) => Date.parse(a) - Date.parse(b);
const isCalendar = (source: SourceHealth) => source.kind === 'calendar' || source.scope === 'calendar';

function group(sources: SourceHealth[], missingSourceIds: string[], kind: 'coursework' | 'calendar', now: string): CalendarCoverageGroup {
  const nowMs = Date.parse(now);
  // Unpublished/inaccessible areas were checked, not failed logins. Their attempt is useful
  // coverage evidence, following the Course projection's settled-area policy.
  const checked = sources.map(source => source.status === 'not_published' || source.status === 'inaccessible'
    ? valid(source.lastAttemptAt) : valid(source.lastSuccessAt));
  const checkedThrough = checked.length && checked.every(Boolean)
    ? (checked as string[]).sort(instantSort)[0]! : null;
  const latestAttemptAt = sources.map(source => valid(source.lastAttemptAt)).filter((at): at is string => !!at).sort(instantSort).at(-1) ?? null;
  const stale = sources.some(source => source.status === 'needs_sign_in' || source.status === 'error') ||
    checked.some(at => at !== null && (!Number.isFinite(nowMs) || Date.parse(at) > nowMs || nowMs - Date.parse(at) > DAY));
  const partial = missingSourceIds.length > 0 || checked.some(at => at === null) || sources.some(source =>
    source.status !== 'not_published' && source.status !== 'inaccessible' && (source.status !== 'ok' || !source.complete));
  const state: CalendarCoverageState = !sources.length && !missingSourceIds.length ? 'missing'
    : stale ? 'stale' : partial ? 'partial' : 'current_capture';
  const noun = kind === 'coursework' ? 'Coursework' : 'Calendar';
  const summary = state === 'missing' ? kind === 'coursework' ? 'Coursework not checked' : 'No calendar feed'
    : state === 'stale' ? `${noun} may be out of date`
    : state === 'partial' ? `${noun} partly checked` : `${noun} checked`;
  return { state, sourceIds: sources.map(source => source.id), missingSourceIds, checkedThrough, latestAttemptAt, summary };
}

/** Coverage for the inputs that can supply Calendar's deadlines and events, independent of
 * the visible date. A failed capture with no current events still qualifies an empty calendar.
 * Canvas/fixture sources can supply deadline evidence even before an item is discovered;
 * other source kinds participate only when they actually own assignments or events.
 */
export function projectCalendarCoverage(
  sources: readonly SourceHealth[],
  resources: readonly Pick<ResourceView, 'sourceId' | 'kind' | 'deleted'>[],
  now: string,
): CalendarCoverage {
  const contributingIds = new Set(resources.filter(resource => !resource.deleted &&
    (resource.kind === 'assignment' || resource.kind === 'event')).map(resource => resource.sourceId));
  const knownIds = new Set(sources.map(source => source.id));
  const coursework = group(sources.filter(source => !isCalendar(source) &&
    (source.kind === 'canvas' || source.kind === 'fixture' || contributingIds.has(source.id))),
    [...contributingIds].filter(id => !knownIds.has(id)), 'coursework', now);
  const calendar = group(sources.filter(isCalendar), [], 'calendar', now);
  return { coursework, calendar, summary: `${coursework.summary} · ${calendar.summary}` };
}

/** Short supporting detail for the shared inline evidence disclosure. No recovery commands. */
export function calendarCoverageDetail(coverage: CalendarCoverage, timeZone: string): string {
  const format = (at: string) => new Intl.DateTimeFormat('en-US', {
    timeZone, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(at));
  return [coverage.coursework, coverage.calendar].map(group => {
    const checked = group.checkedThrough ? `Oldest saved check: ${format(group.checkedThrough)}.`
      : group.state === 'missing' ? '' : 'A successful check is not recorded for every source.';
    const attempt = group.latestAttemptAt && group.latestAttemptAt !== group.checkedThrough
      ? `Latest attempt: ${format(group.latestAttemptAt)}.` : '';
    return [group.summary + '.', checked, attempt].filter(Boolean).join(' ');
  }).join(' ') + ' Saved sources may not include every commitment. An empty day does not confirm free time.';
}
