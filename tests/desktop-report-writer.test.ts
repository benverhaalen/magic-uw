import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Command, CommandResult, PersonalReportChange } from '@magic/contracts';
import { personalReportIssue, personalReportVersion } from '@magic/contracts';
import { ReportWriter, type ReportFeedback } from '../apps/desktop/src/renderer/report-writer';

const evidence = [{ resourceId: 'assignment', contentHash: 'a' }];
const context = { issueId: personalReportIssue('deadline-review', ['assignment']), sourceVersion: personalReportVersion(evidence), evidence, expectedRevision: 0 };
const result = (handled: boolean, revision: number, sourceVersion = context.sourceVersion) => ({ snapshot: { personalReports: [{ issueId: context.issueId, sourceVersion, handled, revision, reportedAt: '2026-09-27T12:00:00Z' }] } } as CommandResult);
const setup = () => { const states: ReportFeedback[] = []; return { states, writer: new ReportWriter(context, value => states.push(value)) }; };
const deferred = () => { let resolve!: (value: CommandResult | undefined) => void; const promise = new Promise<CommandResult | undefined>(r => { resolve = r; }); return { promise, resolve }; };

test('save waits for persistence; repeated activation produces one command', async () => {
  const { states, writer } = setup(); const saved = deferred(); const commands: Command[] = [];
  const run = async (command: Command) => { commands.push(command); return saved.promise; };
  const first = writer.change(true, run); await writer.change(true, run);
  assert.deepEqual(states, [{ pending: true, error: '' }]); assert.equal(commands.length, 1);
  saved.resolve(result(true, 1)); await first;
  assert.deepEqual(states.at(-1), { pending: false, error: '' });
});

test('throwing transport is recovered by readback, no unhandled rejection', async () => {
  const { states, writer } = setup(); const commands: Command[] = [];
  await writer.change(true, async command => { commands.push(command); if (command.type === 'personal-report') throw Error('lost reply'); return result(true, 1); });
  assert.deepEqual(commands.map(c => c.type), ['personal-report', 'snapshot']);
  assert.deepEqual(states.at(-1), { pending: false, error: '' });
});

test('uncertain retry replays exactly the same request then Undo gets a fresh operation', async () => {
  const { states, writer } = setup(); const writes: PersonalReportChange[] = [];
  await writer.change(true, async command => { if (command.type === 'personal-report') writes.push(command.value); return undefined; });
  assert.equal(states.at(-1)?.error, 'Not confirmed. Try again.');
  await writer.change(true, async command => { if (command.type === 'personal-report') writes.push(command.value); return result(true, 1); });
  assert.deepEqual(writes[1], writes[0]);
  writer.update({ ...context, expectedRevision: 1 });
  await writer.change(false, async command => { if (command.type === 'personal-report') writes.push(command.value); return result(false, 2); });
  assert.notEqual(writes[2].operationId, writes[0].operationId); assert.equal(writes[2].expectedRevision, 1); assert.equal(writes[2].handled, false);
});

test('failed save and failed Undo retain saved truth and give recoverable feedback', async () => {
  const { states, writer } = setup();
  await writer.change(true, async command => command.type === 'personal-report' ? undefined : result(false, 0));
  assert.equal(states.at(-1)?.error, 'Not confirmed. Try again.');
  writer.update({ ...context, expectedRevision: 1 });
  await writer.change(false, async command => command.type === 'personal-report' ? undefined : result(true, 1));
  assert.equal(states.at(-1)?.error, 'Not confirmed. Try again.');
});

test('new evidence and unmount suppress old async feedback', async () => {
  const { states, writer } = setup(); const old = deferred();
  const save = writer.change(true, async () => old.promise);
  writer.update({ ...context, sourceVersion: 'new', evidence: [{ resourceId: 'assignment', contentHash: 'b' }] });
  old.resolve(result(true, 1)); await save; assert.equal(states.length, 1);
  const next = deferred(); const undo = writer.change(false, async () => next.promise);
  writer.invalidate(); next.resolve(undefined); await undo; assert.equal(states.length, 2);
});

test('a delayed old response cannot override newer saved intent', async () => {
  const { states, writer } = setup(); const old = deferred();
  const save = writer.change(true, async () => old.promise);
  writer.update({ ...context, expectedRevision: 2 });
  old.resolve(result(false, 0)); await save;
  assert.deepEqual(states.at(-1), { pending: false, error: '' });
});
