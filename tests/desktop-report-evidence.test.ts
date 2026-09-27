import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '@magic/storage';
import { captureBatchSchema, personalReportVersion, personalReportIssue, personalReportState, type Snapshot } from '@magic/contracts';
import { resourceViews } from '../packages/core/src/queries';
import { linkExactEvidence } from '../packages/core/src/evidence';
import { deadlineReportEvidence } from '../apps/desktop/src/renderer/PersonalReport';
import fixture from '../fixtures/course.json';

test('desktop report includes actual independent deadline contributors and fails closed on unresolved claims', () => {
  const store = createStore(':memory:');
  try {
    const batch = captureBatchSchema.parse(fixture);
    const assignment = batch.resources.find(r => r.externalId === 'essay-1')!;
    batch.resources.push({ ...assignment, externalId: 'calendar-copy', kind: 'event',
      calendar: { uid: 'copy@example.org', start: '2026-09-30T04:59:00Z', allDay: false, assignmentExternalId: 'essay-1' },
      deadlines: [{ value: '2026-09-30T04:59:00Z', kind: 'due', quote: 'Independent calendar deadline', authority: 'structured', scopeConfirmed: true }] });
    store.ingest(batch); linkExactEvidence(store);
    const snapshot = () => ({ resources: resourceViews(store, store.resources()), links: store.links() }) as Snapshot;
    let saved = snapshot(), resource = saved.resources.find(r => r.externalId === 'essay-1')!;
    const version = personalReportVersion(deadlineReportEvidence(resource, saved)!);
    assert.equal(deadlineReportEvidence(resource, saved)!.length, 2);
    const hash = resource.contentHash;
    assert.equal(deadlineReportEvidence(resource, { ...saved, resources: [resource] }), null);
    assert.equal(deadlineReportEvidence({ ...resource, deadlineContributors: undefined }, saved), null);
    batch.observedAt = '2026-09-28T12:00:00Z';
    batch.resources.find(r => r.externalId === 'calendar-copy')!.text += ' Changed calendar source.';
    store.ingest(batch); linkExactEvidence(store);
    saved = snapshot(); resource = saved.resources.find(r => r.externalId === 'essay-1')!;
    assert.equal(resource.contentHash, hash);
    assert.notEqual(personalReportVersion(deadlineReportEvidence(resource, saved)!), version);
  } finally { store.close(); }
});


test('prose contributor version reopens report; excluded and inaccessible evidence is removed before projection', () => {
  const store = createStore(':memory:');
  try {
    const batch = captureBatchSchema.parse(fixture);
    const assignment = batch.resources.find(r => r.externalId === 'essay-1')!;
    const prose = captureBatchSchema.parse({ ...batch, source: { ...batch.source, id: 'notice-source', scope: 'announcements' }, resources: [{
      externalId: 'notice', kind: 'message', courseId: assignment.courseId, courseName: assignment.courseName,
      title: assignment.title, url: assignment.url + '/notice', text: `${assignment.title} is due September 30, 2026 at 11:59pm.`, createdAt: '2026-09-27T12:00:00Z',
    }] });
    store.ingest(batch); store.ingest(prose);
    const snapshot = () => ({ resources: resourceViews(store, store.resources()), personalReports: store.personalReports() }) as Snapshot;
    let saved = snapshot(), resource = saved.resources.find(r => r.externalId === 'essay-1')!;
    const evidence = deadlineReportEvidence(resource, saved)!;
    assert.equal(evidence.length, 2);
    const issueId = personalReportIssue('deadline-review', evidence.map(e => e.resourceId));
    const sourceVersion = personalReportVersion(evidence), hash = resource.contentHash;
    store.setPersonalReport({ operationId: 'prose-report', issueId, sourceVersion, evidence, handled: true, expectedRevision: 0 });
    prose.observedAt = '2026-09-28T12:00:00Z'; prose.resources[0]!.text += ' Updated instructions.'; store.ingest(prose);
    saved = snapshot(); resource = saved.resources.find(r => r.externalId === 'essay-1')!;
    assert.equal(resource.contentHash, hash);
    assert.equal(personalReportState(saved.personalReports, issueId, personalReportVersion(deadlineReportEvidence(resource, saved)!)).record, null);
    const notice = saved.resources.find(r => r.externalId === 'notice')!;
    store.ingest({ ...prose, observedAt: '2026-09-29T12:00:00Z', status: 'inaccessible', complete: false, resources: [] });
    saved = snapshot(); resource = saved.resources.find(r => r.externalId === 'essay-1')!;
    assert.equal(resource.deadlineContributors!.some(e => e.resourceId === notice.id), false);
    assert.equal(resource.deadline.claims.some(c => c.span?.resourceId === notice.id), false);
    store.setCourseOverride({ accountScope: batch.source.accountScope, courseId: assignment.courseId, included: false });
    saved = snapshot(); resource = saved.resources.find(r => r.externalId === 'essay-1')!;
    assert.deepEqual(resource.deadlineContributors, []); assert.deepEqual(resource.deadline.claims, []);
    assert.equal(deadlineReportEvidence(resource, saved), null);
    assert.throws(() => store.setPersonalReport({ operationId: 'excluded-report', issueId, sourceVersion, evidence, handled: true, expectedRevision: 1 }));
  } finally { store.close(); }
});
