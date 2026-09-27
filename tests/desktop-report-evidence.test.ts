import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '@magic/storage';
import { captureBatchSchema, personalReportVersion, type Snapshot } from '@magic/contracts';
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
    assert.equal(deadlineReportEvidence({ ...resource, deadline: { ...resource.deadline, claims: [...resource.deadline.claims, resource.deadline.claims[0]!] } }, saved), null);
    batch.observedAt = '2026-09-28T12:00:00Z';
    batch.resources.find(r => r.externalId === 'calendar-copy')!.text += ' Changed calendar source.';
    store.ingest(batch); linkExactEvidence(store);
    saved = snapshot(); resource = saved.resources.find(r => r.externalId === 'essay-1')!;
    assert.equal(resource.contentHash, hash);
    assert.notEqual(personalReportVersion(deadlineReportEvidence(resource, saved)!), version);
  } finally { store.close(); }
});
