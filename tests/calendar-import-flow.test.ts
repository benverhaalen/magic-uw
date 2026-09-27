import test from 'node:test';
import assert from 'node:assert/strict';
import type { CalendarImportFile, CalendarImportRequest, CalendarImportResult } from '@magic/contracts';
import { ImportFlow, type ImportFlowState } from '../apps/desktop/src/renderer/calendar/import-flow';
import { fileStatus } from '../apps/desktop/src/renderer/calendar/GoogleExportPanel';

/** A bridge whose every call waits until the test resolves it, in any order. */
function deferredBridge() {
  const calls: { request: CalendarImportRequest; resolve: (value: CalendarImportResult) => void; reject: (error: Error) => void }[] = [];
  const bridge = { calendarImport: (request: CalendarImportRequest) => new Promise<CalendarImportResult>((resolve, reject) => { calls.push({ request, resolve, reject }); }) };
  const next = (action: string) => {
    const call = calls.find(c => c.request.action === action && !(c as { taken?: boolean }).taken);
    assert.ok(call, `expected a pending ${action}`);
    (call as { taken?: boolean }).taken = true;
    return call!;
  };
  return { bridge, calls, next, actions: () => calls.map(c => c.request.action) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const capability = { browser: 'Google Chrome', newWindow: true, accessibility: true };
const file = (key: string, state: CalendarImportFile['state'], extra: Partial<CalendarImportFile> = {}): CalendarImportFile =>
  ({ key, family: 'lectures', calendarName: key, fileName: `Magic-${key}-2026-09-27-abc123.ics`, events: 2, state, ...extra });
const result = (files: CalendarImportFile[], stopped = false): CalendarImportResult => ({ capability, session: { id: 's1', mode: 'split', window: 'observed', stopped, files } });
const files = [{ family: 'combined' as const, calendarName: 'UW classes and coursework', events: 1, ics: 'x' }];
function flow() {
  const d = deferredBridge();
  const seen: ImportFlowState[] = [];
  const f = new ImportFlow(d.bridge, state => seen.push(state));
  return { d, f, seen };
}

test('closing mid-prepare stops the session main just prepared and never opens Google', async () => {
  const { d, f, seen } = flow();
  const started = f.start('combined', files);
  f.close();
  d.next('prepare').resolve(result([file('a', 'waiting')]));
  await started; await tick();
  assert.deepEqual(d.actions(), ['prepare', 'stop']);
  assert.equal((d.calls[1]!.request as { sessionId: string }).sessionId, 's1');
  assert.ok(!seen.some(state => state.result?.session), 'a closed panel is never updated');
});

test('Stop mid-prepare also disposes the prepared session and never opens', async () => {
  const { d, f } = flow();
  const started = f.start('combined', files);
  const stopping = f.stop();
  d.next('prepare').resolve(result([file('a', 'waiting')]));
  await started; await stopping; await tick();
  assert.deepEqual(d.actions(), ['prepare', 'stop']);
  assert.equal(f.stopped, true);
  await f.start('combined', files);
  assert.deepEqual(d.actions(), ['prepare', 'stop'], 'a stopped flow cannot start again');
});

test('the live session is known as soon as prepare returns, so closing during open stops it', async () => {
  const { d, f } = flow();
  const started = f.start('combined', files);
  d.next('prepare').resolve(result([file('a', 'waiting')]));
  await tick();
  assert.equal(f.liveSession, 's1');
  assert.deepEqual(d.actions(), ['prepare', 'open']);
  f.close();
  assert.deepEqual(d.actions(), ['prepare', 'open', 'stop']);
  d.next('open').resolve(result([file('a', 'preselected')]));
  await started;
});

test('Stop mid-check: a late imported result cannot re-activate the UI or auto-attach the next file', async () => {
  const { d, f } = flow();
  const started = f.start('split', files);
  d.next('prepare').resolve(result([file('a', 'waiting'), file('b', 'waiting')]));
  await tick();
  d.next('open').resolve(result([file('a', 'preselected'), file('b', 'waiting')]));
  await started;
  const checking = f.run({ action: 'check', sessionId: 's1', fileKey: 'a' });
  const stopping = f.stop();
  d.next('stop').resolve(result([file('a', 'stopped', { stoppedFrom: 'preselected' }), file('b', 'stopped', { stoppedFrom: 'waiting' })], true));
  await stopping;
  d.next('check').resolve(result([file('a', 'imported', { imported: 2, total: 2 }), file('b', 'waiting')]));
  await checking; await tick();
  assert.deepEqual(d.actions(), ['prepare', 'open', 'check', 'stop']);
  assert.equal(f.state.result!.session!.stopped, true);
  assert.deepEqual(f.state.result!.session!.files.map(x => x.state), ['stopped', 'stopped']);
  assert.equal(f.state.pending, null);
  await f.run({ action: 'attach', sessionId: 's1', fileKey: 'b' });
  assert.deepEqual(d.actions(), ['prepare', 'open', 'check', 'stop'], 'nothing is sent after Stop');
});

test('split mode: an observed import attaches the next file, but Stop during that attach drops its late result', async () => {
  const { d, f } = flow();
  const started = f.start('split', files);
  d.next('prepare').resolve(result([file('a', 'waiting'), file('b', 'waiting')]));
  await tick();
  d.next('open').resolve(result([file('a', 'preselected'), file('b', 'waiting')]));
  await started;
  const checking = f.run({ action: 'check', sessionId: 's1', fileKey: 'a' });
  d.next('check').resolve(result([file('a', 'imported', { imported: 2, total: 2 }), file('b', 'waiting')]));
  await tick();
  assert.deepEqual(d.actions(), ['prepare', 'open', 'check', 'attach']);
  assert.equal((d.calls[3]!.request as { fileKey: string }).fileKey, 'b');
  void f.stop();
  d.next('stop').resolve(result([file('a', 'imported', { imported: 2, total: 2 }), file('b', 'stopped', { stoppedFrom: 'attaching' })], true));
  await tick();
  d.next('attach').resolve(result([file('a', 'imported', { imported: 2, total: 2 }), file('b', 'preselected')]));
  await checking; await tick();
  assert.deepEqual(f.state.result!.session!.files.map(x => [x.state, x.stoppedFrom]), [['imported', undefined], ['stopped', 'attaching']]);
});

test('a result for a stale session id or a late failure after Stop never reaches the UI', async () => {
  const { d, f } = flow();
  const started = f.start('combined', files);
  d.next('prepare').resolve(result([file('a', 'waiting')]));
  await tick();
  await f.run({ action: 'check', sessionId: 'other', fileKey: 'a' });
  assert.deepEqual(d.actions(), ['prepare', 'open']);
  void f.stop();
  d.next('open').reject(new Error('Magic’s Google Calendar helper stopped unexpectedly.'));
  await started;
  assert.equal(f.state.error, '');
});

test('status wording keeps what was observed before Stop', () => {
  assert.match(fileStatus(file('a', 'stopped', { stoppedFrom: 'preselected' })), /^Stopped after Magic attached Magic-a-2026-09-27-abc123\.ics in Google\. .*clicking Import now may fail/);
  assert.match(fileStatus(file('a', 'stopped', { stoppedFrom: 'attaching' })), /Stopped while Magic was attaching/);
  assert.match(fileStatus(file('a', 'stopped', { stoppedFrom: 'unknown' })), /couldn’t confirm whether this file reached Google/);
  assert.equal(fileStatus(file('a', 'stopped', { stoppedFrom: 'waiting' })), 'Stopped before this file was attached.');
  for (const from of ['preselected', 'attaching', 'unknown'] as const) assert.doesNotMatch(fileStatus(file('a', 'stopped', { stoppedFrom: from })), /wasn’t attached|before this file was attached/);
});
