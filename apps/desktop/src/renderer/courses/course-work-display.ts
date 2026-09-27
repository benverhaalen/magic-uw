import type { CourseWorkRow, CourseWorkModel } from './course-work-model';
import { SHOW_DATE_CONFLICT_UI } from '../date-conflict-policy';

export type WorkSection = 'current' | 'overdue' | 'earlier' | 'later' | 'conflict' | 'undated' | 'done';
export type WorkListState = {
  expanded: Partial<Record<WorkSection, boolean>>;
  visible: Partial<Record<WorkSection, number>>;
  /** Rows acted on remain at their original position during this visit, including Back. */
  pins: Record<string, { section: WorkSection; date: string | null }>;
  /** Day disclosure choices for one admitted scope; any other scope starts with every day open. */
  days?: { scope: string; open: Record<string, boolean> };
};
export const initialWorkListState = (): WorkListState => ({ expanded: {}, visible: {}, pins: {} });
export type WorkGroup = { key: string; label: string; date: string | null; rows: CourseWorkRow[] };
/** A dated day's identity is its section and ISO date; Today is distinct, so a day becoming Today opens again. */
export function workDayKey(group: WorkGroup, today: string): string | null {
  if (!group.date || group.key.endsWith(':past-due')) return null;
  return group.date === today ? `${group.key}:today` : group.key;
}
export function workDayOpen(state: WorkListState, scope: string, day: string | null): boolean {
  return !day || state.days?.scope !== scope || (state.days.open[day] ?? true);
}
export function setWorkDayOpen(state: WorkListState, scope: string, day: string, open: boolean): WorkListState {
  const previous = state.days?.scope === scope ? state.days.open : {};
  return { ...state, days: { scope, open: { ...previous, [day]: open } } };
}
export type WorkPage = { groups: (WorkGroup & { open: boolean; total: number })[]; limit: number; hidden: number };
/** Collapsed days keep their heading in order and take no page budget; only open rows are paged.
 * A collapsed day carries exactly the rows it shows when open, so the view animates the same rows out and in. */
export function pageWorkGroups(groups: WorkGroup[], isOpen: (group: WorkGroup) => boolean, requested = 20): WorkPage {
  const open = groups.filter(isOpen);
  const limit = workPageSize(open, requested), total = open.reduce((n, group) => n + group.rows.length, 0);
  let remaining = limit, before = 0;
  const shown: WorkPage['groups'] = [];
  for (const group of groups) {
    // An empty day has nothing to disclose; the view already omits it.
    if (!group.rows.length) continue;
    if (!isOpen(group)) {
      const budget = workPageSize(groups.filter(candidate => candidate === group || isOpen(candidate)), requested) - before;
      shown.push({ ...group, rows: group.rows.slice(0, Math.max(budget, 0)), open: false, total: group.rows.length }); continue;
    }
    if (remaining <= 0) break;
    const rows = group.rows.slice(0, remaining); remaining -= rows.length; before += rows.length;
    shown.push({ ...group, rows, open: true, total: group.rows.length });
  }
  return { groups: shown, limit, hidden: Math.max(total - limit, 0) };
}
/** Opening a collapsed day shown after a full page extends the page like Show more, so the day never disappears behind it. */
export function openWorkDayState(state: WorkListState, scope: string, section: WorkSection, groups: WorkGroup[], today: string, day: string, open: boolean): WorkListState {
  const next = setWorkDayOpen(state, scope, day, open);
  if (!open) return next;
  const page = pageWorkGroups(groups, group => workDayOpen(next, scope, workDayKey(group, today)), next.visible[section] ?? 20);
  if (page.groups.some(group => workDayKey(group, today) === day && group.rows.length)) return next;
  return { ...next, visible: { ...next.visible, [section]: page.limit + 20 } };
}
export type WorkBucket = { section: WorkSection; label: string; groups: WorkGroup[]; count: number };
export const workRowAnchor = (key: string) => `course-work-${key}`;
export const workRowFocus = (key: string, control: 'open' | 'action' | 'check') => `${workRowAnchor(key)}-${control}`;
const completedSource = (row: CourseWorkRow) => ['submitted', 'excused', 'requirement-complete'].includes(row.sourceState);
const dateAfter = (date: string, count: number) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + count); return d.toISOString().slice(0, 10); };
export function workToday(model: CourseWorkModel, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(model.generatedAt));
}
export function workPlacement(row: CourseWorkRow, today: string, rows: CourseWorkRow[] = []): { section: WorkSection; date: string | null } {
  const date = row.time.state === 'dated' ? row.time.date : null;
  if (row.time.state === 'conflict') return { section: SHOW_DATE_CONFLICT_UI ? 'conflict' : 'undated', date: null };
  if (!row.report?.needsReview && (completedSource(row) || (row.kind === 'prep' && row.report?.checked))) return { section: 'done', date };
  if (!date) {
    const meeting = row.relation && rows.find(candidate => candidate.key === row.relation!.occurrenceKey && candidate.accountScope === row.accountScope && candidate.courseId === row.courseId && candidate.mode === 'commitment' && candidate.time.state === 'dated');
    if (meeting) return workPlacement(meeting, today);
    return { section: 'undated', date: null };
  }
  if (date < today) return { section: row.mode === 'commitment' && row.time.state === 'dated' && row.time.role === 'starts' ? 'earlier' : 'overdue', date };
  if (date >= dateAfter(today, 7)) return { section: 'later', date };
  return { section: 'current', date };
}
export function workDateLabel(date: string, today: string): string {
  if (date === today) return 'Today';
  if (date === dateAfter(today, 1)) return 'Tomorrow';
  return new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
}
export function groupCourseWork(rows: CourseWorkRow[], today: string, state: WorkListState): WorkBucket[] {
  const names: Record<WorkSection, string> = { current: 'Upcoming work', overdue: 'Past due', earlier: 'Earlier classes', later: 'Later', conflict: 'Dates to confirm', undated: 'No date', done: 'Done' };
  // Today stays first, even empty; overdue work has an independent reachable budget.
  const buckets = new Map<WorkSection, Map<string, WorkGroup>>([['current', new Map([[today, { key: `current:${today}`, label: 'Today', date: today, rows: [] }]])]]);
  for (const row of rows) {
    const placement = row.time.state === 'conflict' ? workPlacement(row, today, rows) : state.pins[row.key] ?? workPlacement(row, today, rows);
    const section = placement.section, date = placement.date;
    const groupKey = section === 'overdue' ? 'past-due' : date ?? section;
    const groups = buckets.get(section) ?? new Map<string, WorkGroup>();
    const group = groups.get(groupKey) ?? { key: `${section}:${groupKey}`, date: groupKey === 'past-due' ? null : date,
      label: groupKey === 'past-due' ? 'Past due' : date ? workDateLabel(date, today) : names[section], rows: [] };
    group.rows.push(row); groups.set(groupKey, group); buckets.set(section, groups);
  }
  return (['current', 'overdue', 'later', 'conflict', 'undated', 'done', 'earlier'] as WorkSection[]).flatMap(section => {
    const bucket = buckets.get(section); if (!bucket) return [];
    const groups = [...bucket.values()].sort((a, b) => a.key.endsWith(':past-due') ? -1 : b.key.endsWith(':past-due') ? 1 : (a.date ?? '').localeCompare(b.date ?? ''));
    for (const group of groups) group.rows.sort((a, b) => {
      // Explicit prep inherits only ordering/placement, never a fabricated deadline.
      const sort = (row: CourseWorkRow) => {
        const meeting = row.relation && rows.find(candidate => candidate.key === row.relation!.occurrenceKey && candidate.accountScope === row.accountScope && candidate.courseId === row.courseId);
        const reference = row.time.state === 'undated' && meeting ? meeting : row;
        const time = reference.time.state === 'dated' ? `${reference.time.date}:${String(reference.time.minute ?? 1440).padStart(4, '0')}` : '';
        return [time, reference.key, reference === row ? '1' : '0', row.key].join(':');
      };
      return sort(a).localeCompare(sort(b));
    });
    return [{ section, label: names[section], groups, count: groups.reduce((n, group) => n + group.rows.length, 0) }];
  });
}
/** About twenty rows, finishing the boundary only if it stays within thirty. */
export function workPageSize(groups: WorkGroup[], requested = 20): number {
  let count = 0;
  for (const group of groups) {
    count += group.rows.length;
    if (count >= requested) return count <= requested + 10 ? count : requested;
  }
  return count;
}
export function workTimeLabel(row: CourseWorkRow, today: string, showDate = false): string {
  const time = row.time;
  if (time.state === 'conflict') return SHOW_DATE_CONFLICT_UI ? time.needsReview ? 'Your date needs review' : 'Dates disagree' : 'Date in saved sources';
  if (time.state === 'undated') return row.relation?.label ?? 'No date saved';
  const clock = time.minute === null ? null : new Intl.DateTimeFormat(undefined, { timeZone: time.timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(time.at));
  const date = showDate || time.date < today ? workDateLabel(time.date, today) : null;
  const suffix = [date, clock].filter(Boolean).join(' · ');
  const prefix = time.personal ? 'Your plan' : time.role === 'starts' ? 'Starts' : time.role === 'planning' ? 'Planned' : 'Due';
  return `${prefix}${suffix ? ` ${suffix}` : ' that day'}${SHOW_DATE_CONFLICT_UI && time.sourceConflict ? ' · source dates disagree' : ''}`;
}
export function workSourceLabel(row: CourseWorkRow): string | null {
  if (row.sourceLabel) return row.sourceLabel;
  return ({ submitted: 'Submitted in Canvas', excused: 'Excused', 'requirement-complete': 'Requirement completed',
    unsubmitted: 'Canvas shows not submitted', missing: 'Canvas marks this missing', unknown: row.mode === 'task' && row.kind !== 'prep' ? 'Submission unknown' : null,
    'not-applicable': null })[row.sourceState];
}
