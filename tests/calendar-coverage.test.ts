import test from 'node:test';
import assert from 'node:assert/strict';
import type { SourceHealth } from '@magic/contracts';
import { calendarCoverageDetail, projectCalendarCoverage } from '../packages/domain/src/calendar-coverage';
const now = '2026-09-27T15:00:00Z';
const source = (id: string, fields: Partial<SourceHealth> = {}): SourceHealth => ({
  id, label: id, kind: 'canvas', accountScope: 'account', courseId: 'course', scope: 'assignments',
  status: 'ok', lastAttemptAt: '2026-09-27T14:30:00Z', lastSuccessAt: '2026-09-27T14:30:00Z',
  complete: true, resourceCount: 0, ...fields,
});
const feed = () => source('ics', { kind: 'calendar', scope: 'calendar_feed' });
test('expired Canvas remains visible with healthy ICS and an empty week', () => {
  const result = projectCalendarCoverage([source('canvas', { status: 'needs_sign_in', lastSuccessAt: '2026-09-25T10:00:00Z' }), feed()], [], now);
  assert.equal(result.coursework.state, 'stale'); assert.equal(result.calendar.state, 'current_capture');
  assert.equal(result.summary, 'Coursework may be out of date · Calendar checked');
  const detail = calendarCoverageDetail(result, 'America/Chicago');
  assert.match(detail, /Sep 25, 2026/); assert.match(detail, /Latest attempt: Sep 27, 2026/);
});
test('healthy Canvas without ICS distinguishes missing calendar coverage', () => {
  const result = projectCalendarCoverage([source('canvas')], [], now);
  assert.equal(result.summary, 'Coursework checked · No calendar feed'); assert.equal(result.calendar.state, 'missing');
});
test('no sources does not mean a checked free day', () => {
  const result = projectCalendarCoverage([], [], now);
  assert.equal(result.summary, 'Coursework not checked · No calendar feed');
  assert.match(calendarCoverageDetail(result, 'America/Chicago'), /An empty day does not confirm free time/);
});
test('healthy sources indicate checked saved coverage with an honest limit', () => {
  const result = projectCalendarCoverage([source('canvas'), feed()], [], now);
  assert.equal(result.summary, 'Coursework checked · Calendar checked');
  assert.match(calendarCoverageDetail(result, 'UTC'), /Saved sources may not include every commitment/);
});
test('incomplete flag, partial and needs-attention statuses qualify coursework', () => {
  for (const fields of [{ complete: false }, { status: 'partial' as const }, { status: 'needs_attention' as const }])
    assert.equal(projectCalendarCoverage([source('canvas', fields), feed()], [], now).coursework.state, 'partial');
});
test('recent attempt and healthy newer source cannot hide an old capture', () => {
  const result = projectCalendarCoverage([source('old', { lastSuccessAt: '2026-09-25T10:00:00Z' }), source('new')], [], now);
  assert.equal(result.coursework.state, 'stale'); assert.equal(result.coursework.checkedThrough, '2026-09-25T10:00:00Z');
  assert.equal(result.coursework.latestAttemptAt, '2026-09-27T14:30:00Z');
});
test('incomplete, failed and old ICS captures remain distinct', () => {
  for (const [fields, expected] of [[{ complete: false }, 'partial'], [{ status: 'error' }, 'stale'],
    [{ lastSuccessAt: '2026-09-25T10:00:00Z' }, 'stale']] as [Partial<SourceHealth>, string][])
    assert.equal(projectCalendarCoverage([source('canvas'), { ...feed(), ...fields }], [], now).calendar.state, expected);
});
test('missing, malformed and future timestamps cannot establish healthy coverage', () => {
  for (const date of [null, 'invalid', '2026-09-28T15:00:00Z']) {
    const result = projectCalendarCoverage([source('canvas', { lastSuccessAt: date })], [], now);
    assert.notEqual(result.coursework.state, 'current_capture');
    assert.doesNotThrow(() => calendarCoverageDetail(result, 'UTC'));
  }
});
test('actual assignment/event source owners participate; unrelated failures do not', () => {
  const external = source('web', { kind: 'web', status: 'error' });
  const result = projectCalendarCoverage([source('canvas'), feed(), external, source('notes', { kind: 'notes', status: 'error' })],
    [{ sourceId: 'web', kind: 'assignment', deleted: false }], now);
  assert.deepEqual(result.coursework.sourceIds, ['canvas', 'web']); assert.equal(result.coursework.state, 'stale');
  assert.equal(projectCalendarCoverage([source('canvas'), feed(), external], [], now).coursework.state, 'current_capture');
});
test('retained assignment with missing health cannot appear checked', () => {
  const result = projectCalendarCoverage([feed()], [{ sourceId: 'orphan', kind: 'assignment', deleted: false }], now);
  assert.equal(result.coursework.state, 'partial'); assert.deepEqual(result.coursework.missingSourceIds, ['orphan']);
});
test('settled unavailable areas use the check time instead of permanent staleness', () => {
  for (const status of ['not_published', 'inaccessible'] as const)
    assert.equal(projectCalendarCoverage([source('area', { status, complete: false, lastSuccessAt: null })], [], now).coursework.state, 'current_capture');
});
test('same course ID across accounts retains independent health', () => {
  const result = projectCalendarCoverage([source('one'), source('two', { accountScope: 'other', status: 'error' })], [], now);
  assert.deepEqual(result.coursework.sourceIds, ['one', 'two']); assert.equal(result.coursework.state, 'stale');
});
