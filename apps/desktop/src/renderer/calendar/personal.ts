import type { PersonalCalendarEvent } from '@magic/contracts';
import { clock, localTime, type CalendarItem } from './model';

/** Personal timed events are stored as instants and rendered in the Calendar display timezone. */
export function personalCalendarItems(events: PersonalCalendarEvent[], date: string, timeZone: string): CalendarItem[] {
  const result: CalendarItem[] = [];
  for (const event of events) {
    const base = { key: `personal:${event.id}`, resourceId: event.id, title: event.title, courseName: 'Personal', kind: 'personal' as const, personal: true, personalEvent: event };
    if (event.allDay) {
      if (event.date === date) result.push({ ...base, allDay: true, startMin: 0, endMin: 1440, detail: event.location || 'All day' });
      continue;
    }
    if (!event.startsAt || !event.endsAt) continue;
    const start = localTime(event.startsAt, timeZone), end = localTime(event.endsAt, timeZone);
    if (start.date > date || end.date < date || (end.date === date && end.min === 0 && start.date !== date)) continue;
    const startMin = start.date < date ? 0 : start.min, endMin = end.date > date ? 1440 : end.min;
    result.push({ ...base, allDay: false, startMin, endMin, detail: `${clock(startMin)}–${clock(endMin)}${event.location ? ` · ${event.location}` : ''}` });
  }
  return result.sort((a, b) => a.startMin - b.startMin || a.title.localeCompare(b.title));
}
