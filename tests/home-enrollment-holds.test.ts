import test from 'node:test';
import assert from 'node:assert/strict';
import type { PlanningSourceHealth, Snapshot, StoredPlanningRecord } from '@magic/contracts';
import { homeEnrollmentHolds } from '../apps/desktop/src/renderer/home/enrollment-holds';

const now = Date.parse('2026-09-27T15:00:00Z');
const recent = '2026-09-27T14:00:00Z';
const old = '2026-09-17T14:00:00Z';
const accountScope = 'uw-account:synthetic';
function source(id: string, observedAt = recent, scope: PlanningSourceHealth['scope'] = { kind: 'student_record', key: 'connection:student-info' }): PlanningSourceHealth {
  return { id, source: 'uw_enroll', accountScope, scope, sourceUrl: 'https://enroll.wisc.edu/', status: 'complete', completeness: 'complete', observedAt, lastSuccessAt: observedAt, diagnostics: [] };
}
function record(value: object, sourceId: string, observedAt = recent): StoredPlanningRecord {
  return { ...value, localId: `${sourceId}:synthetic`, sourceId, accountScope, contentHash: 'x', version: 1, deleted: false,
    provenance: { sourceUrl: 'https://enroll.wisc.edu/', observedAt, scope: { kind: sourceId === 'term' ? 'enrollment_term' : 'student_record', key: sourceId === 'term' ? '1272' : 'connection:student-info' } } } as StoredPlanningRecord;
}
const snapshot = (records: StoredPlanningRecord[], sources: PlanningSourceHealth[]) => ({ planning: { records, sources } }) as Snapshot;

test('Home distinguishes missing, checked empty, and stale hold evidence', () => {
  assert.match(homeEnrollmentHolds(snapshot([], []), now).holds, /not confirmed/);
  assert.match(homeEnrollmentHolds(snapshot([], [source('login')]), now).holds, /No holds reported/);
  assert.match(homeEnrollmentHolds(snapshot([], [source('login', old)]), now).holds, /not confirmed/);
  const staleHold = record({ id: 'hold', kind: 'hold', title: 'Synthetic hold', description: '', blocksEnrollment: true, resolutionUrl: null }, 'login', old);
  const summary = homeEnrollmentHolds(snapshot([staleHold], [source('login', old)]), now);
  assert.match(summary.holds, /refresh to confirm/);
  assert.equal(summary.holdTitle, 'Synthetic hold');
});

test('Home only calls enrollment current when term evidence is complete and fresh', () => {
  const course = record({ id: 'course', kind: 'enrollment_package', courseKey: 'uw:266:300', termCode: '1272', sections: ['001'], status: 'open', enrollmentState: 'enrolled', meetings: [], meetingsComplete: true, seatsAvailable: null, capacity: null, waitlistCount: null, instructorNames: [] }, 'term');
  const sources = [source('login'), source('term', recent, { kind: 'enrollment_term', key: '1272' })];
  assert.match(homeEnrollmentHolds(snapshot([course], sources), now).enrollment, /1 course enrolled/);
  assert.match(homeEnrollmentHolds(snapshot([course], [sources[0], source('term', old, { kind: 'enrollment_term', key: '1272' })]), now).enrollment, /refresh to confirm/);
});
