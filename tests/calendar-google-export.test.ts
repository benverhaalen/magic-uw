import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolveDeadline } from '@magic/domain';
import type { PlanningSnapshot } from '@magic/contracts';
import { parseCalendar } from '@magic/connectors';
import { canvasFamily, exportFiles, previewGoogleExport, sha256, uniqueWallInstant, type GoogleExportChoice } from '../apps/desktop/src/renderer/calendar/google-export';
import type { CalendarResource } from '../apps/desktop/src/renderer/calendar/model';

const CANVAS = 'a'.repeat(64), OTHER = 'b'.repeat(64);
const now = '2026-09-27T15:00:00.000Z';
const choice: GoogleExportChoice = { from: '2026-09-27', through: '2026-12-31', canvasScope: CANVAS, timeZone: 'America/Chicago', now, courseLabel: () => 'CS 400' };
const due = (value: string, precision: 'day' | 'minute' = 'minute') => resolveDeadline([{ kind: 'due' as const, value, quote: value, authority: 'structured' as const, scopeConfirmed: true, precision }]);
function item(id: string, fields: Partial<CalendarResource> = {}): CalendarResource {
  return { id, kind: 'assignment', accountScope: CANVAS, courseId: '101', courseName: 'CS 400', title: id, completed: false, submitted: null, kindLabel: null,
    sourceScope: 'assignments', externalId: id, url: `https://canvas.wisc.edu/courses/101/assignments/${id}`, submissionTypes: ['online_upload'], deadline: due('2026-10-02T04:59:00Z'), ...fields };
}
const observedAt = '2026-09-26T12:00:00.000Z';
const scope = { kind: 'enrollment_term', key: '1272' };
const provenance = { sourceUrl: 'https://enroll.wisc.edu/x', observedAt, scope };
const meeting = { kind: 'class', mode: 'scheduled', days: [1, 3, 5], startMinute: 600, endMinute: 650, startDate: '2026-09-28', endDate: '2026-10-02', timezone: 'America/Chicago', location: 'Room 1240 https://maps.example/x' };
const exam = { ...meeting, kind: 'exam', days: [], startMinute: 1140, endMinute: 1260, startDate: '2026-10-21', endDate: '2026-10-21', location: null };
const pkg = { kind: 'enrollment_package', id: 'p1', localId: 'private:1', sourceId: 'source:1', accountScope: 'student', contentHash: 'h', version: 1, deleted: false, provenance, courseKey: 'uw:266:400', termCode: '1272', sections: ['LEC 001'], status: 'open', enrollmentState: 'enrolled', meetings: [meeting, exam], meetingsComplete: true, seatsAvailable: null, capacity: null, waitlistCount: null, instructorNames: [] };
const link = { kind: 'account_link', id: 'l1', localId: 'link:1', sourceId: 'source:1', accountScope: 'student', contentHash: 'h', version: 1, deleted: false, provenance, canvasAccountScope: CANVAS, method: 'matched_institutional_login' };
const subject = { kind: 'subject', id: 's1', localId: 'subject:266', sourceId: 'source:1', accountScope: 'public', contentHash: 'h', version: 1, deleted: false, provenance, code: '266', shortName: 'COMP SCI' };
const source = { id: 'source:1', source: 'uw_enroll', accountScope: 'student', scope, sourceUrl: provenance.sourceUrl, status: 'complete', completeness: 'complete', observedAt, lastSuccessAt: observedAt, diagnostics: [] };
const planning = (records: unknown[] = [pkg, link, subject], sources: unknown[] = [source]) => ({ records, sources } as unknown as PlanningSnapshot);

test('families come from source metadata only: submission types, quiz scope and meeting kind, never AI labels or titles', () => {
  assert.equal(canvasFamily(item('hw')), 'assignments');
  assert.equal(canvasFamily(item('q', { submissionTypes: ['online_quiz'] })), 'exams');
  assert.equal(canvasFamily(item('q2', { sourceScope: 'quizzes:all' })), 'exams');
  assert.equal(canvasFamily(item('mixed', { submissionTypes: ['online_quiz', 'online_upload'] })), 'assignments');
  // An AI kind label or an exam-looking title does not move an item between families.
  assert.equal(canvasFamily(item('Midterm exam', { kindLabel: 'exam' })), 'assignments');
  assert.equal(canvasFamily(item('feed', { kind: 'event', sourceScope: 'calendar_feed', submissionTypes: undefined, calendar: { uid: 'event-assignment-77', allDay: false, start: '2026-10-03T04:59:00Z' } })), null);
  const preview = previewGoogleExport([
    item('hw', { title: 'Homework 2 (see https://canvas.wisc.edu/files/1?verifier=secret)' }), item('quiz', { submissionTypes: ['online_quiz'], deadline: due('2026-10-05T05:00:00Z', 'day') }),
    item('ai-exam', { title: 'Midterm exam', kindLabel: 'exam' }),
    item('feed', { kind: 'event', sourceScope: 'calendar_feed', submissionTypes: undefined, externalId: undefined, url: 'https://canvas.wisc.edu/calendar', calendar: { uid: 'event-assignment-77', allDay: false, start: '2026-10-03T04:59:00Z' }, deadline: resolveDeadline([]) }),
    item('conflict', { deadline: { ...due('2026-10-06T04:59:00Z'), conflict: true, dueAt: null } }),
    item('undated', { deadline: resolveDeadline([]) }),
    item('cancelled', { workflowState: 'CANCELLED' }),
    item('elsewhere', { accountScope: OTHER }),
    item('talk', { kind: 'event', sourceScope: 'calendar_feed', calendar: { uid: 'talk', allDay: false, start: '2026-10-07T20:00:00Z', end: '2026-10-07T21:00:00Z' }, deadline: resolveDeadline([]) }),
    item('late', { deadline: due('2027-02-01T05:59:00Z') }),
  ], planning(), choice);
  assert.deepEqual(preview.counts, { lectures: 3, assignments: 2, exams: 2 });
  assert.deepEqual(preview.omitted, { dateReview: 1, conflict: 1, typeUnknown: 1, clockChange: 0, scheduleUnverified: 0, cancelled: 1 });
  assert.ok(preview.rows.some(row => row.family === 'assignments' && row.title === 'CS 400 · Midterm exam'));
  assert.ok(!preview.rows.some(row => /elsewhere|talk|late/.test(row.title)));
  const lecture = preview.rows.find(row => row.family === 'lectures')!;
  assert.equal(lecture.title, 'COMP SCI 400 lecture');
  assert.equal(lecture.start, '2026-09-28T15:00:00.000Z'); assert.equal(lecture.end, '2026-09-28T15:50:00.000Z');
  assert.equal(preview.rows.find(row => row.title === 'COMP SCI 400 exam')!.start, '2026-10-22T00:00:00.000Z');
});

test('combined and three-calendar files are deterministic, share stable UIDs and carry no links or account identifiers', async () => {
  const resources = [item('hw', { title: 'Homework 2 https://canvas.wisc.edu/files/1?verifier=secret' }), item('quiz', { submissionTypes: ['online_quiz'], deadline: due('2026-10-05T05:00:00Z', 'day') })];
  const preview = previewGoogleExport(resources, planning(), choice);
  const combined = exportFiles(preview, 'combined', '2026-09-27T12:00:00.000Z');
  const split = exportFiles(preview, 'split', '2026-09-27T12:00:00.000Z');
  assert.deepEqual(combined, exportFiles(previewGoogleExport(resources, planning(), choice), 'combined', '2026-09-27T12:00:00.000Z'));
  assert.deepEqual(combined.map(f => [f.family, f.calendarName, f.events]), [['combined', 'UW classes and coursework', 6]]);
  assert.deepEqual(split.map(f => [f.family, f.calendarName, f.events]), [['lectures', 'Lectures', 3], ['assignments', 'Assignments', 1], ['exams', 'Exams & quizzes', 2]]);
  const uids = (ics: string) => [...ics.matchAll(/^UID:(.+)$/gm)].map(m => m[1]).sort();
  assert.deepEqual(uids(combined[0]!.ics), split.flatMap(f => uids(f.ics)).sort());
  assert.match(split[1]!.ics, /X-WR-CALNAME:Assignments\r\n/);
  assert.match(split[2]!.ics, /X-WR-CALNAME:Exams & quizzes\r\n/);
  for (const file of [...combined, ...split]) {
    assert.doesNotMatch(file.ics.replace(/\r\n /g, ''), /:\/\/|verifier|a{64}|student|private:1/);
    assert.ok(file.ics.split('\r\n').every(line => new TextEncoder().encode(line).length <= 75));
  }
  const ics = combined[0]!.ics;
  // Day-precision deadline: all-day with exclusive end on the campus date. Timed deadline: an instant, no invented end.
  assert.match(ics, /DTSTART;VALUE=DATE:20261005\r\nDTEND;VALUE=DATE:20261006\r\n/);
  assert.match(ics, /DTSTART:20261002T045900Z\r\nSUMMARY:CS 400 · Homework 2 \(link omitted\)/);
  assert.match(ics, /DTSTART:20260928T150000Z\r\nDTEND:20260928T155000Z\r\nSUMMARY:COMP SCI 400 lecture/);
  const parsed = await parseCalendar(ics, { canvasOrigin: 'https://canvas.example.edu', accountScope: 'test', courseId: '101', courseName: 'CS 400', now: () => new Date(now) });
  assert.equal(parsed.resources.length, 6);
  assert.ok(parsed.resources.some(r => r.title === 'COMP SCI 400 lecture'));
});

test('campus daylight-saving: a repeated or skipped wall time is held, not guessed', () => {
  assert.equal(uniqueWallInstant('2026-11-01', 90, 'America/Chicago'), null);   // 1:30 AM happens twice
  assert.equal(uniqueWallInstant('2026-03-08', 150, 'America/Chicago'), null);  // 2:30 AM never happens
  assert.equal(uniqueWallInstant('2026-11-02', 90, 'America/Chicago'), '2026-11-02T07:30:00.000Z');
  const night = { ...meeting, days: [7], startMinute: 60, endMinute: 150, startDate: '2026-10-25', endDate: '2026-11-08' };
  const preview = previewGoogleExport([], planning([{ ...pkg, meetings: [night] }, link, subject]), choice);
  assert.equal(preview.omitted.clockChange, 1);
  assert.deepEqual(preview.rows.map(row => row.start), ['2026-10-25T06:00:00.000Z', '2026-11-08T07:00:00.000Z']);
});

test('class schedules must be current, complete and linked to the chosen Canvas account', () => {
  const stale = { ...provenance, observedAt: '2026-09-10T12:00:00.000Z' };
  assert.equal(previewGoogleExport([], planning([{ ...pkg, provenance: stale }, link, subject]), choice).omitted.scheduleUnverified, 1);
  assert.equal(previewGoogleExport([], planning([{ ...pkg, meetingsComplete: false }, link, subject]), choice).counts.lectures, 0);
  assert.equal(previewGoogleExport([], planning(), { ...choice }, ).counts.lectures, 3);
  assert.equal(previewGoogleExport([], planning(undefined, [{ ...source, status: 'partial' }]), choice).counts.lectures, 0);
  const unlinked = previewGoogleExport([item('hw')], planning([pkg, { ...link, canvasAccountScope: OTHER }, subject]), choice);
  assert.deepEqual([unlinked.counts.lectures, unlinked.counts.assignments, unlinked.omitted.scheduleUnverified], [0, 1, 1]);
  assert.match(unlinked.scheduleNote!, /not confirmed to belong to this Canvas account/);
  const twoAccounts = previewGoogleExport([], planning([pkg, { ...pkg, localId: 'private:2', accountScope: 'someone' }, link, subject]), choice);
  assert.equal(twoAccounts.counts.lectures, 0);
  assert.match(twoAccounts.scheduleNote!, /More than one school account/);
  assert.throws(() => previewGoogleExport([], planning(), { ...choice, through: '2028-01-01' }), /one year or less/);
  assert.throws(() => previewGoogleExport([], planning(), { ...choice, canvasScope: '' }), /school account/);
});

test('renderer SHA-256 matches FIPS output', () => {
  for (const text of ['', 'abc', 'é'.repeat(100), 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64)])
    assert.equal(sha256(text), createHash('sha256').update(text).digest('hex'));
});
