import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '@magic/storage';
import { createCore } from '@magic/core';
import { captureBatchSchema, type CourseIntelligence } from '@magic/contracts';
import fixture from '../fixtures/course.json';

test('background course extraction yields to interactive work and batches access lookup per profile', { timeout: 3000 }, async () => {
  const store = createStore(':memory:');
  store.ingest(captureBatchSchema.parse(fixture));
  const resources = store.resources();
  const profile = { id: 'test-profile', inputHash: 'test-hash', dependencies: resources.map(r => ({ resourceId: r.id, contentHash: r.contentHash })) } as CourseIntelligence;
  let scans = 0, yielded = false;
  let observation: { yielded: boolean; scans: number } | undefined;
  let extracted!: () => void;
  const finished = new Promise<void>(resolve => { extracted = resolve; });
  const counted = new Proxy(store, { get(target, key) {
    if (key === 'resources') return (...args: Parameters<typeof store.resources>) => { scans++; return target.resources(...args); };
    if (key === 'courseIntelligence') return () => [profile];
    return Reflect.get(target, key);
  } });
  const core = createCore(counted, { fixture: captureBatchSchema.parse(fixture), courseExtractor: { version: 'test', async extract() {
    observation = { yielded, scans };
    extracted(); return null;
  } } });
  try {
    setImmediate(() => { yielded = true; });
    core.wake(); await finished;
    assert.deepEqual(observation, { yielded: true, scans: 1 });
  } finally { await core.close(); store.close(); }
});
