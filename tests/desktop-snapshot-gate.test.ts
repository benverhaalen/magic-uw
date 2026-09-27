import test from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotGate } from '../apps/desktop/src/renderer/snapshot-gate';

test('slow reads coalesce without discarding the current result', () => {
  const gate = new SnapshotGate(), first = gate.beginRead()!;
  assert.equal(gate.beginRead(), null);
  assert.equal(gate.accepts(first), true);
  gate.endRead(); assert.equal(gate.takeQueued(), true);
  const next = gate.beginRead()!;
  assert.equal(gate.accepts(first), false);
  assert.equal(gate.accepts(next), true);
});
test('deferred poll cannot overwrite a void mutation; one fresh read drains after it', async () => {
  const gate = new SnapshotGate();
  let resolve!: () => void;
  const deferred = new Promise<void>(done => { resolve = done; });
  const old = gate.beginRead()!;
  const pending = deferred.then(() => { const apply = gate.accepts(old); gate.endRead(); return apply; });
  gate.beginMutation();
  assert.equal(gate.beginRead(), null, 'poll during mutation queues');
  resolve(); assert.equal(await pending, false, 'old deferred snapshot is ignored');
  assert.equal(gate.takeQueued(), false, 'no read starts while mutation runs');
  gate.endMutation(true); // sign-out resolves without a snapshot
  assert.equal(gate.takeQueued(), true);
  assert.equal(gate.takeQueued(), false);
  const fresh = gate.beginRead()!;
  assert.equal(gate.accepts(fresh), true);
  assert.equal(gate.accepts(old), false);
});
