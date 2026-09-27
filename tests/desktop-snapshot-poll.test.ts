import test from 'node:test';
import assert from 'node:assert/strict';
import { startSnapshotPolling } from '../apps/desktop/src/renderer/snapshot-poll';
import { SnapshotGate } from '../apps/desktop/src/renderer/snapshot-gate';

test('slow reads leave a full scheduled interval after completion and stop when hidden', async () => {
  let hidden = false, calls = 0, visibility = () => {};
  let resolve!: () => void;
  const timers = new Map<number, () => void>();
  let next = 0;
  const stop = startSnapshotPolling(() => {
    calls++;
    return new Promise<void>(done => { resolve = done; });
  }, {
    hidden: () => hidden,
    schedule: callback => { timers.set(++next, callback); return next; },
    cancel: id => { timers.delete(id); },
    onVisibility: callback => { visibility = callback; return () => { visibility = () => {}; }; },
  });
  assert.equal(calls, 1);
  assert.equal(timers.size, 0, 'no timer can queue another read during slow work');
  visibility(); visibility();
  assert.equal(calls, 1, 'visibility changes do not duplicate the pending read');
  resolve(); await Promise.resolve();
  assert.equal(timers.size, 1);
  hidden = true; visibility();
  assert.equal(timers.size, 0);
  hidden = false; visibility();
  assert.equal(calls, 2, 'returning to the window refreshes once');
  stop(); resolve(); await Promise.resolve();
  assert.equal(timers.size, 0, 'unmount cannot restart polling');
});

test('background polls do not request follow-up reads but explicit requests and mutations do', () => {
  const gate = new SnapshotGate();
  gate.beginRead();
  assert.equal(gate.beginRead(false), null);
  gate.endRead();
  assert.equal(gate.takeQueued(), false);
  gate.beginMutation();
  assert.equal(gate.beginRead(false), null);
  gate.endMutation(false);
  assert.equal(gate.takeQueued(), false);
  gate.beginRead(); gate.beginRead(); gate.endRead();
  assert.equal(gate.takeQueued(), true, 'explicit refresh is preserved');
  gate.beginMutation(); gate.endMutation(true);
  assert.equal(gate.takeQueued(), true, 'snapshot-less mutation still refreshes');
});
