import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDeadline } from '@magic/domain';
import type { DayPlanEntry } from '@magic/contracts';
import { addDays, calendarItems, requestedSuggestions, startOfDate, visibleDates, weekStart, type CalendarResource } from '../apps/desktop/src/renderer/calendar/model';
const TZ = 'America/Chicago';
function item(id: string, fields: Partial<CalendarResource> = {}): CalendarResource {
  return { id, kind: 'event', accountScope: 'account', courseId: 'course', courseName: 'Course', title: id, completed: false, submitted: null, kindLabel: null, deadline: resolveDeadline([]), ...fields };
}
test('Sunday-first weeks, leap month and year boundaries use calendar dates', () => {
  assert.equal(weekStart('2026-09-27'), '2026-09-27');
  assert.equal(weekStart('2026-10-03'), '2026-09-27');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.deepEqual(visibleDates('2026-01-01', 'week'), ['2025-12-28', '2025-12-29', '2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02', '2026-01-03']);
  const month = visibleDates('2026-03-10', 'month');
  assert.equal(month.length, 35); assert.equal(month[0], '2026-03-01'); assert.equal(month.at(-1), '2026-04-04');
});
test('local midnights obey spring and autumn DST, not fixed UTC offsets', () => {
  assert.equal(startOfDate('2026-03-08', TZ).toISOString(), '2026-03-08T06:00:00.000Z');
  assert.equal(startOfDate('2026-03-09', TZ).getTime() - startOfDate('2026-03-08', TZ).getTime(), 23 * 3600000);
  assert.equal(startOfDate('2026-11-02', TZ).getTime() - startOfDate('2026-11-01', TZ).getTime(), 25 * 3600000);
});
test('connector ICS all-day end is exclusive, missing end is exactly one day', () => {
  const events = [item('multi', { calendar: { uid: 'a', allDay: true, start: '2026-09-27', end: '2026-09-29' } }), item('single', { calendar: { uid: 'b', allDay: true, start: '2026-09-28' } })];
  assert.deepEqual(calendarItems(events, [], '2026-09-28', TZ).map(x => x.resourceId), ['multi', 'single']);
  assert.equal(calendarItems(events, [], '2026-09-29', TZ).length, 0);
});
test('overnight segments continue on next day; midnight end does not create phantom next-day event', () => {
  const overnight = item('night', { calendar: { uid: 'a', allDay: false, start: '2026-09-28T04:00:00Z', end: '2026-09-28T07:00:00Z' } });
  assert.deepEqual(calendarItems([overnight], [], '2026-09-27', TZ).map(x => [x.startMin, x.endMin]), [[1380, 1440]]);
  const next = calendarItems([overnight], [], '2026-09-28', TZ)[0];
  assert.deepEqual([next.startMin, next.endMin], [0, 120]); assert.match(next.detail, /continues/);
  overnight.calendar!.end = '2026-09-28T05:00:00Z';
  assert.equal(calendarItems([overnight], [], '2026-09-28', TZ).length, 0);
});
test('month commitments are not limited by proposal window, cancellation and exact assignment duplicate excluded', () => {
  const deadline = resolveDeadline([{ value: '2027-03-20T18:00:00Z', kind: 'due', quote: 'due', authority: 'structured', scopeConfirmed: true }]);
  const assignment = item('work', { kind: 'assignment', externalId: '55', deadline, submitted: true });
  const cancelled = item('cancelled', { workflowState: 'CANCELLED', calendar: { uid: 'cancel', allDay: true, start: '2027-03-20' } });
  const duplicate = item('icswork', { sourceScope: 'calendar_feed', calendar: { uid: 'a', allDay: false, start: '2027-03-20T18:00:00Z', assignmentExternalId: '55' } });
  const entries = calendarItems([assignment, cancelled, duplicate], [], '2027-03-20', TZ);
  assert.equal(entries.length, 1); assert.equal(entries[0].resourceId, 'work'); assert.equal(entries[0].submitted, true);
  assert.match(requestedSuggestions([assignment], [], '2027-03-20', '2026-09-27T12:00:00Z', TZ).unavailable!, /two weeks/);
});
test('accepted blocks retain snapshot identity; skipped/missing resources never appear as commitments', () => {
  const entry: DayPlanEntry = { key: 'plan', date: '2026-09-27', status: 'accepted', block: { resourceId: 'material', type: 'prep', title: 'Review assigned pages', courseName: 'Course', startMin: 600, endMin: 630 } };
  const entries = calendarItems([item('material', { kind: 'material' })], [entry, { ...entry, key: 'skipped', status: 'skipped' }], entry.date, TZ);
  assert.equal(entries.length, 1); assert.equal(entries[0].title, entry.block.title); assert.equal(entries[0].entry?.key, 'plan');
  assert.equal(calendarItems([], [entry], entry.date, TZ).length, 0);
});
test('exact Canvas quiz submission kind uses assessment filter while retaining its due evidence', () => {
  const deadline = resolveDeadline([{ value: '2026-09-28T18:00:00Z', kind: 'due', quote: 'due', authority: 'structured', scopeConfirmed: true }]);
  const quiz = item('quiz', { kind: 'assignment', submissionTypes: ['online_quiz'], deadline });
  const result = calendarItems([quiz], [], '2026-09-28', TZ);
  assert.equal(result[0].kind, 'exam'); assert.equal(result[0].precision, 'minute'); assert.match(result[0].detail, /Due/);
});
test('unknown end remains explicitly unknown; source timezone is converted to display timezone', () => {
  const event = item('meeting', { calendar: { uid: 'a', allDay: false, start: '2026-09-28T09:00:00-07:00', timezone: 'America/Los_Angeles' } });
  const entry = calendarItems([event], [], '2026-09-28', TZ)[0];
  assert.equal(entry.startMin, 660); assert.match(entry.detail, /end not provided/);
});
test('suggestion requests respect clock-change ambiguity in minute-only existing persistence', () => {
  assert.match(requestedSuggestions([], [], '2026-11-01', '2026-10-30T12:00:00Z', TZ).unavailable!, /clock change/);
});

test('assignment calendar deduplication cannot cross accounts', () => {
  const assignment = item('a', { kind: 'assignment', externalId: '55', accountScope: 'one' });
  const event = item('event', { accountScope: 'two', calendar: { uid: 'a', allDay: true, start: '2026-09-27', assignmentExternalId: '55' } });
  assert.equal(calendarItems([assignment, event], [], '2026-09-27', TZ).length, 1);
});

test('duplicate source records navigate to direct assignment and retain conflicting claims', () => {
  const due = (value: string) => resolveDeadline([{ value, kind: 'due', quote: value, authority: 'structured', scopeConfirmed: true }]);
  const direct = item('direct', { kind: 'assignment', externalId: '55', sourceScope: 'assignments', deadline: due('2026-09-27T18:00:00Z') });
  const todo = item('todo', { ...direct, id: 'todo', sourceScope: 'todo', deadline: due('2026-09-27T19:00:00Z') });
  const entries = calendarItems([todo, direct], [], '2026-09-27', TZ);
  assert.equal(entries.length, 1); assert.equal(entries[0].resourceId, 'direct'); assert.equal(entries[0].conflict, true);
  const feed = item('feed', { sourceScope: 'calendar_feed', calendar: { uid: 'event-assignment-55', allDay: false, start: '2026-09-27T18:00:00Z' } });
  assert.equal(calendarItems([direct, feed], [], '2026-09-27', TZ).length, 1);
  feed.calendar!.start = '2026-09-28T18:00:00Z';
  assert.equal(calendarItems([direct, feed], [], '2026-09-28', TZ).length, 0);
  assert.equal(calendarItems([direct, feed], [], '2026-09-27', TZ)[0].conflict, true);
});
test('fall-back repeated clock hour retains positive actual duration with explicit clock-change detail', () => {
  const event = item('fold', { calendar: { uid: 'fold', allDay: false, start: '2026-11-01T06:30:00Z', end: '2026-11-01T07:15:00Z' } });
  const entry = calendarItems([event], [], '2026-11-01', TZ)[0];
  assert.equal(entry.endMin - entry.startMin, 45); assert.match(entry.detail, /clock change/);
});
