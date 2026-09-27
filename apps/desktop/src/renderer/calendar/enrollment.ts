import type { PlanningSnapshot, StoredPlanningRecord } from '@magic/contracts';
import { addDays, localMinuteInstant, localTime, type CalendarItem } from './model';

const chicago = 'America/Chicago';
const weekday = (date: string) => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7 + 1;
const code = (key: string, subjects: Map<string, string>) => {
  const [, subject, number] = key.split(':');
  return `${subjects.get(subject ?? '') ?? subject ?? 'Course'} ${number ?? ''}`.trim();
};

/** Only private, saved current-enrollment packages can create class meetings. Catalog offerings never do. */
export function enrollmentCalendarItems(planning: PlanningSnapshot | undefined, date: string, displayTimeZone = chicago): CalendarItem[] {
  const records = planning?.records ?? [];
  const privateScopes = new Set(records.filter(row => !row.deleted && row.kind === 'enrollment_package' && row.enrollmentState === 'enrolled' && row.accountScope !== 'public').map(row => row.accountScope));
  if (privateScopes.size !== 1) return [];
  const scope = [...privateScopes][0];
  const subjects = new Map(records.filter((row): row is Extract<StoredPlanningRecord, { kind: 'subject' }> => row.kind === 'subject' && !row.deleted).map(row => [row.code, row.shortName]));
  const titles = new Map(records.filter((row): row is Extract<StoredPlanningRecord, { kind: 'catalog_course' }> => row.kind === 'catalog_course' && !row.deleted).map(row => [row.courseKey, row.title]));
  const items: CalendarItem[] = [];
  for (const row of records) {
    if (row.deleted || row.kind !== 'enrollment_package' || row.accountScope !== scope || row.enrollmentState !== 'enrolled' || row.provenance.scope.kind !== 'enrollment_term' || row.provenance.scope.key !== row.termCode) continue;
    const source = planning?.sources.find(item => item.id === row.sourceId);
    if (!source || source.scope.kind !== 'enrollment_term' || source.scope.key !== row.termCode || source.accountScope !== scope) continue;
    const label = code(row.courseKey, subjects);
    for (const [index, meeting] of row.meetings.entries()) {
      if (meeting.mode !== 'scheduled' || meeting.startMinute === null || meeting.endMinute === null || meeting.timezone !== chicago || meeting.startDate === null || meeting.endDate === null) continue;
      for (const sourceDate of [addDays(date, -1), date, addDays(date, 1)]) {
        if (sourceDate < meeting.startDate || sourceDate > meeting.endDate || (meeting.days.length ? !meeting.days.includes(weekday(sourceDate)) : meeting.startDate !== meeting.endDate || sourceDate !== meeting.startDate)) continue;
        const start = localMinuteInstant(sourceDate, meeting.startMinute, chicago);
        const end = localMinuteInstant(meeting.endMinute === 1440 ? addDays(sourceDate, 1) : sourceDate, meeting.endMinute % 1440, chicago);
        if (!start || !end) continue;
        const shownStart = localTime(start, displayTimeZone), shownEnd = localTime(end, displayTimeZone);
        if (shownStart.date > date || shownEnd.date < date || (shownEnd.date === date && shownEnd.min === 0 && shownStart.date !== date)) continue;
        const kind = meeting.kind === 'exam' ? 'exam' : 'class';
        const location = meeting.location?.trim() || null;
        items.push({
          key: `enrollment:${row.localId}:${index}:${sourceDate}`, resourceId: row.localId, kind,
          title: `${label} ${meeting.kind === 'exam' ? 'exam' : 'class'}`, courseName: titles.get(row.courseKey) ?? label,
          startMin: shownStart.date < date ? 0 : shownStart.min, endMin: shownEnd.date > date ? 1440 : shownEnd.min, allDay: false,
          detail: `${location ? `${location} · ` : ''}${row.sections.join(', ')} · Course Search & Enroll`,
          sourceLabel: 'Course Search & Enroll', sourceUrl: row.provenance.sourceUrl,
          needsReview: source.status !== 'complete' || source.completeness !== 'complete' || Date.parse(row.provenance.observedAt) < Date.now() - 7 * 86400_000,
        });
      }
    }
  }
  return items.sort((a, b) => a.startMin - b.startMin || a.title.localeCompare(b.title));
}

export function enrollmentScheduleNote(planning: PlanningSnapshot | undefined): string | null {
  const records = planning?.records ?? [];
  const enrolled = records.filter((row): row is Extract<StoredPlanningRecord, { kind: 'enrollment_package' }> => !row.deleted && row.kind === 'enrollment_package' && row.enrollmentState === 'enrolled' && row.provenance.scope.kind === 'enrollment_term');
  if (!enrolled.length) return 'No current enrollment schedule has been captured from Course Search & Enroll.';
  if (new Set(enrolled.map(row => row.accountScope)).size > 1) return 'More than one school account is saved. Confirm the account in My UW before using the class schedule.';
  const notes: string[] = [];
  if (enrolled.some(row => row.meetings.some(meeting => meeting.mode === 'asynchronous'))) notes.push('Some enrolled classes are asynchronous and have no fixed meeting on the grid.');
  if (enrolled.some(row => !row.meetingsComplete || row.meetings.some(meeting => meeting.mode === 'unknown' || (meeting.mode === 'scheduled' && (meeting.startDate === null || meeting.endDate === null || meeting.startMinute === null || meeting.endMinute === null))))) notes.push('Some enrolled classes have incomplete meeting details. Check My UW for their source status.');
  return notes.join(' ') || null;
}
