import test from 'node:test';
import assert from 'node:assert/strict';
import type { PlanningSnapshot } from '@magic/contracts';
import { enrollmentCalendarItems, enrollmentScheduleNote } from '../apps/desktop/src/renderer/calendar/enrollment';

const observedAt = new Date().toISOString();
const scope = { kind: 'enrollment_term', key: '1272' };
const provenance = { sourceUrl: 'https://example.edu/enrollment', observedAt, scope };
const meeting = { kind: 'class', mode: 'scheduled', days: [1, 3, 5], startMinute: 600, endMinute: 650, startDate: '2026-09-02', endDate: '2026-12-11', timezone: 'America/Chicago', location: 'Room 100' };
const enrolled = { kind: 'enrollment_package', id: 'enrolled', localId: 'private:1', sourceId: 'source:1', accountScope: 'student', contentHash: 'hash', version: 1, deleted: false, provenance, courseKey: 'uw:266:400', termCode: '1272', sections: ['001'], status: 'open', enrollmentState: 'enrolled', meetings: [meeting], meetingsComplete: true, seatsAvailable: null, capacity: null, waitlistCount: null, instructorNames: [] };
const source = { id: 'source:1', source: 'uw_enroll', accountScope: 'student', scope, sourceUrl: provenance.sourceUrl, status: 'complete', completeness: 'complete', observedAt, lastSuccessAt: observedAt, diagnostics: [] };
const snapshot = (records: unknown[]): PlanningSnapshot => ({ records, sources: [source] } as PlanningSnapshot);

test('only saved enrolled sections with confirmed date, weekday and time appear', () => {
  const records = [enrolled, { ...enrolled, id: 'available', localId: 'private:2', enrollmentState: 'available', meetings: [{ ...meeting, days: [2] }] }, { ...enrolled, id: 'proposed', localId: 'private:3', enrollmentState: 'proposed' }];
  assert.deepEqual(enrollmentCalendarItems(snapshot(records), '2026-09-28').map(item => [item.title, item.startMin, item.endMin, item.kind]), [['266 400 class', 600, 650, 'class']]);
  assert.equal(enrollmentCalendarItems(snapshot(records), '2026-09-29').length, 0);
  assert.equal(enrollmentCalendarItems(snapshot(records), '2027-09-27').length, 0);
});

test('unknown meetings and multiple private account scopes do not become invented commitments', () => {
  assert.equal(enrollmentCalendarItems(snapshot([{ ...enrolled, meetings: [{ ...meeting, mode: 'unknown', startMinute: null }] }]), '2026-09-28').length, 0);
  assert.match(enrollmentScheduleNote(snapshot([{ ...enrolled, meetings: [{ ...meeting, mode: 'unknown', startMinute: null }] }]))!, /incomplete meeting details/);
  const mixedNote = enrollmentScheduleNote(snapshot([{ ...enrolled, meetings: [{ ...meeting, mode: 'asynchronous', startMinute: null, endMinute: null }, { ...meeting, mode: 'unknown', startMinute: null }] }]))!;
  assert.match(mixedNote, /asynchronous/);
  assert.match(mixedNote, /incomplete meeting details/);
  assert.equal(enrollmentCalendarItems(snapshot([enrolled, { ...enrolled, localId: 'other', accountScope: 'other' }]), '2026-09-28').length, 0);
  assert.equal(enrollmentCalendarItems({ ...snapshot([enrolled]), sources: [{ ...source, scope: { kind: 'enrollment_term', key: '1274' } }] } as PlanningSnapshot, '2026-09-28').length, 0);
});

test('a Chicago class converts to the display zone and crosses the correct day boundary', () => {
  const late = { ...meeting, days: [1], startMinute: 1320, endMinute: 1380 };
  const data = snapshot([{ ...enrolled, meetings: [late] }]);
  assert.deepEqual(enrollmentCalendarItems(data, '2026-09-29', 'Asia/Tokyo').map(item => [item.startMin, item.endMin]), [[720, 780]]);
  assert.equal(enrollmentCalendarItems(data, '2026-09-28', 'Asia/Tokyo').length, 0);
});
