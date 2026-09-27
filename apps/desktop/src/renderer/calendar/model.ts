import type { DayPlanEntry } from '@magic/contracts';
import { buildTodayRail, resolveDeadline, type RailResource, type RailSuggestion } from '@magic/domain';


// Reuse the formatter across month cells; constructing it per event/day makes dense months stall.
const formatters = new Map<string, Intl.DateTimeFormat>();
function localTime(iso: string, timeZone: string): { date: string; min: number } {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    if (formatters.size >= 4) formatters.clear();
    formatters.set(timeZone, formatter);
  }
  const p = Object.fromEntries(formatter.formatToParts(new Date(iso)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute) };
}

export type CalendarView = 'week' | 'month';
export interface CalendarState { view: CalendarView; date: string; scrollTop: number; detailDate?: string; selectedPlanKey?: string }
export type CalendarResource = RailResource & { workflowState?: string | null; accountScope?: string; sourceScope?: string; capturedAt?: string };
export interface CalendarItem {
  key: string; resourceId: string; title: string; courseName: string;
  kind: 'event' | 'deadline' | 'study'; startMin: number; endMin: number;
  allDay: boolean; detail: string; conflict?: boolean; submitted?: boolean;
  entry?: DayPlanEntry;
}
export function addDays(date: string, amount: number): string {
  const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}
export function weekStart(date: string): string {
  return addDays(date, -(new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7);
}
export function visibleDates(date: string, view: CalendarView): string[] {
  const first = view === 'week' ? weekStart(date) : weekStart(date.slice(0, 8) + '01');
  const monthEnd = new Date(`${date.slice(0, 8)}01T12:00:00Z`);
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1, 0);
  const last = addDays(weekStart(monthEnd.toISOString().slice(0, 10)), 6);
  const days: string[] = [];
  for (let day = first; view === 'week' ? days.length < 7 : day <= last; day = addDays(day, 1)) days.push(day);
  return days;
}
export function shiftPeriod(date: string, view: CalendarView, direction: number): string {
  if (view === 'week') return addDays(date, direction * 7);
  const value = new Date(`${date.slice(0, 8)}01T12:00:00Z`); value.setUTCMonth(value.getUTCMonth() + direction);
  return value.toISOString().slice(0, 10);
}
/** Search for the first instant of the local calendar date, including DST. Never add 24h to a local midnight. */
export function startOfDate(date: string, timeZone: string): Date {
  const center = Date.parse(`${date}T12:00:00Z`);
  let lo = center - 36 * 3600000, hi = center + 36 * 3600000;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (localTime(new Date(mid).toISOString(), timeZone).date < date) lo = mid; else hi = mid;
  }
  return new Date(hi);
}
export function clock(min: number): string {
  if (min === 1440) return 'midnight';
  const hour = Math.floor(min / 60), minute = min % 60;
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}
export function dayLabel(date: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
}
/** Same source object may be captured through todo and assignments. Preserve evidence, prefer the direct record for navigation. */
export function canonicalCalendarResources(resources: CalendarResource[]): CalendarResource[] {
  const groups = new Map<string, CalendarResource[]>(), others: CalendarResource[] = [];
  for (const r of resources) {
    if (r.kind !== 'assignment' || !r.accountScope || !r.externalId || r.deleted) { others.push(r); continue; }
    const key = JSON.stringify([r.accountScope, r.courseId, r.externalId]);
    const group = groups.get(key) ?? []; group.push(r); groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => Number(b.sourceScope === 'assignments') - Number(a.sourceScope === 'assignments') || (b.capturedAt ?? '').localeCompare(a.capturedAt ?? ''));
    const primary = group[0];
    others.push({ ...primary, deadline: resolveDeadline(group.flatMap(r => r.deadline.claims)) });
  }
  return others;
}
export function calendarItems(resources: CalendarResource[], plan: DayPlanEntry[], date: string, timeZone: string): CalendarItem[] {
  const result: CalendarItem[] = [];
  const canonical = canonicalCalendarResources(resources);
  const assignments = new Map(canonical.filter(r => r.kind === 'assignment' && !r.deleted && r.accountScope).map(r => [`${r.accountScope}:${r.courseId}:${r.externalId}`, r]));
  for (const r of canonical) {
    if (r.deleted || r.workflowState === 'CANCELLED') continue;
    const base = { resourceId: r.id, title: r.title, courseName: r.courseName };
    if (r.kind === 'assignment' && r.deadline.planningAt) {
      const due = localTime(r.deadline.planningAt, timeZone);
      if (due.date === date) result.push({ ...base, key: `deadline:${r.id}`, kind: 'deadline', allDay: true, startMin: due.min, endMin: due.min, detail: `Due ${clock(due.min)}${r.deadline.conflict ? ' · dates disagree' : ''}${r.submitted === true ? ' · submitted' : ''}`, conflict: r.deadline.conflict, submitted: r.submitted === true });
    }
    if (r.kind !== 'event') continue;
    const c = r.calendar;
    const assignmentId = c?.assignmentExternalId ?? (r.sourceScope === 'calendar_feed' ? /^event-assignment-(\d+)$/.exec(c?.uid ?? '')?.[1] : undefined);
    const linkedAssignment = r.accountScope && assignmentId ? assignments.get(`${r.accountScope}:${r.courseId}:${assignmentId}`) : undefined;
    if (linkedAssignment?.deadline.planningAt && c) {
      const due = localTime(linkedAssignment.deadline.planningAt, timeZone);
      const sameDate = c.allDay ? c.start.slice(0, 10) === due.date : Date.parse(c.start) === Date.parse(linkedAssignment.deadline.planningAt);
      if (sameDate) continue; // Keep conflicting dates visible as separate source evidence.
    }
    const start = c?.start ?? r.deadline.claims.find(x => x.kind === 'event')?.value;
    if (!start) continue;
    if (c?.allDay) {
      // Connector retains the original ICS DATE DTSTART/DTEND. DTEND is exclusive.
      const end = c.end?.slice(0, 10) ?? addDays(start.slice(0, 10), 1);
      if (date >= start.slice(0, 10) && date < end) result.push({ ...base, key: `event:${r.id}`, kind: 'event', allDay: true, startMin: 0, endMin: 1440, detail: c.location || 'All day' });
      continue;
    }
    const a = localTime(start, timeZone), b = c?.end ? localTime(c.end, timeZone) : null;
    if (a.date > date || (b ? b.date < date || (b.date === date && b.min === 0 && a.date !== date) : a.date !== date)) continue;
    const startMin = a.date < date ? 0 : a.min;
    let endMin = b ? b.date > date ? 1440 : b.min : Math.min(1440, startMin + 20);
    const shifted = Boolean(b && endMin <= startMin && Date.parse(c!.end!) > Date.parse(start));
    if (shifted) endMin = Math.min(1440, startMin + (Date.parse(c!.end!) - Date.parse(start)) / 60000);
    if (endMin < startMin) continue;
    result.push({ ...base, key: `event:${r.id}`, kind: 'event', allDay: false, startMin, endMin: Math.max(startMin + 1, endMin), detail: `${clock(startMin)}${b ? `–${clock(b.date > date ? 1440 : b.min)}` : ' · end not provided'}${a.date < date ? ' · continues' : ''}${shifted ? ' · clock change' : ''}${c?.location ? ` · ${c.location}` : ''}` });
  }
  const ids = new Set(resources.filter(r => !r.deleted).map(r => r.id));
  for (const entry of plan) if (entry.date === date && entry.status === 'accepted' && ids.has(entry.block.resourceId)) {
    result.push({ key: `plan:${entry.key}`, resourceId: entry.block.resourceId, title: entry.block.title, courseName: entry.block.courseName, kind: 'study', allDay: false, startMin: entry.block.startMin, endMin: entry.block.endMin, detail: `${clock(entry.block.startMin)}–${clock(entry.block.endMin)} · planned by you${entry.doneAt ? ' · marked done' : ''}`, entry });
  }
  return result.sort((a, b) => a.startMin - b.startMin || a.title.localeCompare(b.title));
}
export function requestedSuggestions(resources: CalendarResource[], plan: DayPlanEntry[], date: string, now: string, timeZone: string): { suggestions: RailSuggestion[]; unavailable?: string } {
  const today = localTime(now, timeZone).date;
  if (date < today || date > addDays(today, 14)) return { suggestions: [], unavailable: 'Choose today or a day in the next two weeks to find study time.' };
  const start = startOfDate(date, timeZone), end = startOfDate(addDays(date, 1), timeZone);
  if (end.getTime() - start.getTime() !== 86400000) return { suggestions: [], unavailable: 'This day includes a clock change. Choose another day for a study suggestion.' };
  const at = date === today ? now : start.toISOString();
  const occupied = calendarItems(resources, plan, date, timeZone).filter(x => !x.allDay);
  const suggestions = buildTodayRail(canonicalCalendarResources(resources), at, timeZone, plan).suggestions.filter(s => s.state === 'suggested' && !occupied.some(x => s.startMin < x.endMin && s.endMin > x.startMin));
  return { suggestions };
}
