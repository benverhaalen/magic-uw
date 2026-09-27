import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, stat, mkdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CalendarImportResult } from '@magic/contracts';
import { checkIcs, createCalendarImport, GOOGLE_IMPORT_URL } from '../apps/desktop/src/calendar-import/controller';
import { ImportSteps, fileStatus } from '../apps/desktop/src/renderer/calendar/GoogleExportPanel';

const ics = (events: number, name = 'Lectures') => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:${name}\r\n${'BEGIN:VEVENT\r\nUID:x\r\nEND:VEVENT\r\n'.repeat(events)}END:VCALENDAR\r\n`;
const split = [
  { family: 'lectures' as const, calendarName: 'Lectures', events: 3, ics: ics(3) },
  { family: 'assignments' as const, calendarName: 'Assignments', events: 2, ics: ics(2, 'Assignments') },
  { family: 'exams' as const, calendarName: 'Exams & quizzes', events: 1, ics: ics(1, 'Exams & quizzes') },
];
const combined = [{ family: 'combined' as const, calendarName: 'UW classes and coursework', events: 6, ics: ics(6, 'UW classes and coursework') }];
type Call = Record<string, unknown>;

/** A scripted native helper: records every request and answers like the observed browser would. */
function fakeHost(options: { accessibility?: boolean; newWindow?: boolean; headless?: boolean; attach?: (call: Call) => Call | Promise<Call>; page?: (call: Call) => Call | Promise<Call> } = {}) {
  const calls: Call[] = [];
  let clock = Date.parse('2026-09-27T15:00:00Z');
  const revealed: string[] = [];
  return {
    calls, revealed, advance: (ms: number) => { clock += ms; },
    async build(tempRoot?: string) {
      const root = tempRoot ?? await mkdtemp(join(tmpdir(), 'cal-import-test-'));
      const controller = createCalendarImport({
        headless: options.headless ?? false, tempRoot: root, now: () => new Date(clock), reveal: path => revealed.push(path),
        run: async request => {
          calls.push(request);
          switch (request.action) {
            case 'status': return { event: 'status', name: 'Google Chrome.app', newWindow: options.newWindow ?? true, accessibility: options.accessibility ?? true };
            case 'open': return { event: 'opened', pid: 42, bundleId: 'com.google.chrome', windowNumber: 777, accessibility: options.accessibility ?? true };
            case 'page': return options.page?.(request) ?? { event: 'page', importForm: true };
            case 'attach': return options.attach?.(request) ?? { event: 'attached', observedFileName: request.expectedName, chooserClosed: true, pageShowsFile: true, destination: 'Ben (primary)', chooser: 'sheet' };
            case 'press': return { event: 'pressed' };
            case 'cancel': return { event: 'no_chooser' };
            default: return { event: 'error', code: 'unsupported_action' };
          }
        },
      });
      return { controller, root };
    },
  };
}

test('combined: opens a NEW default-browser window on Google import and attaches the exact file itself; import is observed, never assumed', async () => {
  let imported = false;
  const h2 = fakeHost({ page: call => call.expectedName && imported ? { event: 'page', importForm: true, destination: 'School', imported: 6, total: 6 } : { event: 'page', importForm: true } });
  const { controller, root } = await h2.build();
  const prepared = await controller.handle({ action: 'prepare', mode: 'combined', files: combined });
  const file = prepared.session!.files[0]!;
  assert.match(file.fileName, /^Magic-UW-calendar-2026-09-27-[0-9a-f]{6}\.ics$/);
  const dir = (await readdir(root)).find(name => name.startsWith('magic-calendar-'))!;
  assert.equal((await stat(join(root, dir))).mode & 0o777, 0o700);
  assert.equal((await stat(join(root, dir, file.fileName))).mode & 0o777, 0o600);
  assert.equal(await readFile(join(root, dir, file.fileName), 'utf8'), combined[0]!.ics);

  const opened = await controller.handle({ action: 'open', sessionId: prepared.session!.id });
  const open = h2.calls.find(c => c.action === 'open')!;
  assert.equal(open.url, GOOGLE_IMPORT_URL);
  const attach = h2.calls.find(c => c.action === 'attach')!;
  // The helper acts only on the window it saw appear, with the exact private path and file name.
  assert.deepEqual([attach.pid, attach.bundleId, attach.windowNumber, attach.expectedName], [42, 'com.google.chrome', 777, file.fileName]);
  assert.equal(attach.path, join(root, dir, file.fileName));
  assert.equal(opened.session!.window, 'observed');
  assert.equal(opened.session!.files[0]!.state, 'preselected');
  assert.equal(opened.session!.files[0]!.destination, 'Ben (primary)');
  assert.equal(opened.manual, undefined);
  // The student hasn't clicked Import yet: still preselected.
  assert.equal((await controller.handle({ action: 'check', sessionId: prepared.session!.id, fileKey: file.key })).session!.files[0]!.state, 'preselected');
  imported = true;
  const done = await controller.handle({ action: 'check', sessionId: prepared.session!.id, fileKey: file.key });
  assert.deepEqual([done.session!.files[0]!.state, done.session!.files[0]!.imported, done.session!.files[0]!.destination], ['imported', 6, 'School']);
  assert.deepEqual(await readdir(root), [], 'every prepared file is removed once Google reported the import');
  assert.ok(!h2.calls.some(c => c.action === 'press' && /^import$|create calendar/i.test(String(c.label))), 'Magic never presses Import or Create calendar');
});

test('three calendars: each file attaches separately, calendar creation is only opened for the student, Stop prevents the next file', async () => {
  let phase = 0;
  const host = fakeHost({ page: call => call.expectedName && phase === 1 ? { event: 'page', importForm: true, destination: 'Lectures', imported: 3, total: 3 } : { event: 'page', importForm: phase !== 2, createForm: phase === 2 } });
  const { controller, root } = await host.build();
  const prepared = await controller.handle({ action: 'prepare', mode: 'split', files: split });
  assert.deepEqual(prepared.session!.files.map(f => [f.family, f.calendarName, f.state]), [['lectures', 'Lectures', 'waiting'], ['assignments', 'Assignments', 'waiting'], ['exams', 'Exams & quizzes', 'waiting']]);
  assert.equal(new Set(prepared.session!.files.map(f => f.fileName)).size, 3);
  const id = prepared.session!.id;
  const [lectures, assignments, exams] = prepared.session!.files;
  await controller.handle({ action: 'open', sessionId: id });
  phase = 1;
  const first = await controller.handle({ action: 'check', sessionId: id, fileKey: lectures!.key });
  assert.equal(first.session!.files[0]!.state, 'imported');
  // Creating "Assignments": Magic presses only Google's "Create new calendar" link; the student names and creates it.
  phase = 2;
  const create = await controller.handle({ action: 'create-calendar', sessionId: id, fileKey: assignments!.key });
  assert.equal(host.calls.at(-2)!.label, 'Create new calendar');
  assert.equal(create.session!.page, 'create');
  assert.match(create.notice!, /name the calendar “Assignments” and click Create calendar/);
  assert.equal(create.session!.files[1]!.state, 'waiting', 'no calendar is claimed as created');
  // Attach returns to Import & export in the same window before touching the chooser.
  phase = 3;
  const host2Page = host.calls.length;
  const attached = await controller.handle({ action: 'attach', sessionId: id, fileKey: assignments!.key });
  const since = host.calls.slice(host2Page).map(c => c.action);
  assert.deepEqual(since, ['page', 'attach']);
  assert.equal(attached.session!.files[1]!.state, 'preselected');
  const stopped = await controller.handle({ action: 'stop', sessionId: id });
  assert.deepEqual(stopped.session!.files.map(f => [f.state, f.stoppedFrom]), [['imported', undefined], ['stopped', 'preselected'], ['stopped', 'waiting']]);
  const attachCalls = host.calls.filter(c => c.action === 'attach').length;
  await assert.rejects(controller.handle({ action: 'attach', sessionId: id, fileKey: exams!.key }), /export has ended/);
  assert.equal(host.calls.filter(c => c.action === 'attach').length, attachCalls, 'nothing is attached after Stop');
  assert.deepEqual(await readdir(root), [], 'Stop removes every prepared file');
});

test('Stop during an in-flight attach or check keeps the stopped state and what was observed; late replies change nothing', async () => {
  let release: (reply: Call) => void = () => {};
  let deferAttach = true, deferPage = false;
  const hold = () => new Promise<Call>(resolve => { release = resolve; });
  const host = fakeHost({
    attach: call => deferAttach ? hold() : { event: 'attached', observedFileName: call.expectedName, chooserClosed: true, pageShowsFile: true },
    page: call => deferPage && call.expectedName ? hold() : { event: 'page', importForm: true },
  });
  const { controller, root } = await host.build();
  const prepared = await controller.handle({ action: 'prepare', mode: 'split', files: split });
  const id = prepared.session!.id;
  const opening = controller.handle({ action: 'open', sessionId: id });
  while (!host.calls.some(c => c.action === 'attach')) await new Promise(resolve => setImmediate(resolve));
  const stopped = await controller.handle({ action: 'stop', sessionId: id });
  assert.deepEqual(stopped.session!.files.map(f => f.stoppedFrom), ['attaching', 'waiting', 'waiting']);
  assert.match(fileStatus(stopped.session!.files[0]!), /Stopped while Magic was attaching/);
  assert.ok(host.calls.some(c => c.action === 'cancel'), 'the chooser in the owned window is cancelled');
  release({ event: 'attached', observedFileName: stopped.session!.files[0]!.fileName, chooserClosed: true, pageShowsFile: true });
  const late = await opening;
  assert.deepEqual(late.session!.files.map(f => f.state), ['stopped', 'stopped', 'stopped'], 'a late attach does not reactivate the file');
  assert.deepEqual(await readdir(root), []);

  // Stop while Magic reads Google's result: a late "imported" page cannot overwrite the stopped history.
  deferAttach = false;
  const { controller: c2 } = await host.build();
  const p2 = await c2.handle({ action: 'prepare', mode: 'split', files: split });
  const first = (await c2.handle({ action: 'open', sessionId: p2.session!.id })).session!.files[0]!;
  assert.equal(first.state, 'preselected');
  deferPage = true;
  const checking = c2.handle({ action: 'check', sessionId: p2.session!.id, fileKey: first.key });
  await new Promise(resolve => setImmediate(resolve));
  await c2.handle({ action: 'stop', sessionId: p2.session!.id });
  release({ event: 'page', importForm: true, imported: 3, total: 3 });
  const after = await checking;
  assert.deepEqual([after.session!.files[0]!.state, after.session!.files[0]!.stoppedFrom], ['stopped', 'preselected']);
  assert.equal(host.calls.filter(c => c.action === 'attach').length, 2, 'no next file is attached after Stop');
});

test('missing Accessibility: window may open, but only then is the short manual path and Finder offered', async () => {
  const host = fakeHost({ accessibility: false });
  const { controller } = await host.build();
  const prepared = await controller.handle({ action: 'prepare', mode: 'combined', files: combined });
  const key = prepared.session!.files[0]!.key;
  const before = await controller.handle({ action: 'reveal', sessionId: prepared.session!.id, fileKey: key });
  assert.equal(host.revealed.length, 0, 'Finder is not the normal path');
  assert.match(before.notice!, /only offered when that is blocked/);
  const opened = await controller.handle({ action: 'open', sessionId: prepared.session!.id });
  assert.equal(opened.manual, true);
  assert.equal(opened.session!.files[0]!.state, 'waiting');
  assert.ok(!host.calls.some(c => c.action === 'attach'));
  await controller.handle({ action: 'reveal', sessionId: prepared.session!.id, fileKey: key });
  assert.equal(host.revealed.length, 1);
  const html = renderToStaticMarkup(createElement(ImportSteps, { result: opened, pending: null, run: () => {} }));
  assert.match(html, /Accessibility permission/);
  assert.match(html, /Show file in Finder/);
  assert.match(html, /Settings → Import &amp; export/);
});

test('unsupported browser and headless runs do not pretend to open anything', async () => {
  const safari = fakeHost({ newWindow: false });
  const s = await safari.build();
  const p = await s.controller.handle({ action: 'prepare', mode: 'combined', files: combined });
  const r = await s.controller.handle({ action: 'open', sessionId: p.session!.id });
  assert.deepEqual([r.manual, r.session!.window], [true, 'none']);
  assert.ok(!safari.calls.some(c => c.action === 'open'));
  const headless = fakeHost({ headless: true });
  const h = await headless.build();
  const hp = await h.controller.handle({ action: 'prepare', mode: 'combined', files: combined });
  assert.match((await h.controller.handle({ action: 'open', sessionId: hp.session!.id })).notice!, /disabled in this test run/);
  assert.deepEqual(headless.calls, []);
});

test('observed filename mismatch, a gone or other window, and a stale window all refuse', async () => {
  const mismatch = fakeHost({ attach: () => ({ event: 'error', code: 'filename_mismatch', observedCount: 1, observedName: 'Resume.pdf' }) });
  const m = await mismatch.build();
  const mp = await m.controller.handle({ action: 'prepare', mode: 'combined', files: combined });
  const mr = await m.controller.handle({ action: 'open', sessionId: mp.session!.id });
  assert.equal(mr.session!.files[0]!.state, 'refused');
  assert.match(mr.notice!, /selected a different file, so Magic cancelled it/);

  const other = fakeHost({ page: () => ({ event: 'error', code: 'not_google_calendar' }) });
  const o = await other.build();
  const op = await o.controller.handle({ action: 'prepare', mode: 'combined', files: combined });
  const or = await o.controller.handle({ action: 'open', sessionId: op.session!.id });
  assert.match(or.notice!, /isn't on Google Calendar now/);
  assert.ok(!other.calls.some(c => c.action === 'attach'));

  const gone = fakeHost({ page: () => ({ event: 'error', code: 'window_gone' }) });
  const g = await gone.build();
  const gp = await g.controller.handle({ action: 'prepare', mode: 'combined', files: combined });
  await g.controller.handle({ action: 'open', sessionId: gp.session!.id });
  const again = await g.controller.handle({ action: 'attach', sessionId: gp.session!.id, fileKey: gp.session!.files[0]!.key });
  assert.equal(again.session!.window, 'dispatched', 'a gone window is forgotten, never re-targeted');
  assert.equal(gone.calls.filter(c => c.action === 'page').length, 1);

  const stale = fakeHost({ attach: () => ({ event: 'attached', observedFileName: 'x', chooserClosed: true, pageShowsFile: false }) });
  const st = await stale.build();
  const sp = await st.controller.handle({ action: 'prepare', mode: 'combined', files: combined });
  const sr = await st.controller.handle({ action: 'open', sessionId: sp.session!.id });
  assert.equal(sr.session!.files[0]!.state, 'unknown', 'an unconfirmed filename is not reported as preselected');
  stale.advance(61 * 60_000);
  const late = await st.controller.handle({ action: 'attach', sessionId: sp.session!.id, fileKey: sp.session!.files[0]!.key });
  assert.match(late.notice!, /over an hour old/);
  assert.equal(stale.calls.filter(c => c.action === 'attach').length, 1);
});

test('an earlier file’s Google result is not counted for the next file; count mismatches stay unknown', async () => {
  let message: Call | null = { imported: 3, total: 3 };
  const host = fakeHost({ page: () => ({ event: 'page', importForm: true, ...(message ?? {}) }) });
  const { controller } = await host.build();
  const p = await controller.handle({ action: 'prepare', mode: 'split', files: split });
  const [, assignments] = p.session!.files;
  await controller.handle({ action: 'open', sessionId: p.session!.id });
  await controller.handle({ action: 'attach', sessionId: p.session!.id, fileKey: assignments!.key });
  const held = await controller.handle({ action: 'check', sessionId: p.session!.id, fileKey: assignments!.key });
  assert.equal(held.session!.files[1]!.state, 'preselected');
  assert.match(held.notice!, /Close Google's earlier import message/);
  message = null;
  await controller.handle({ action: 'check', sessionId: p.session!.id, fileKey: assignments!.key });
  message = { imported: 1, total: 2 };
  const partial = await controller.handle({ action: 'check', sessionId: p.session!.id, fileKey: assignments!.key });
  assert.equal(partial.session!.files[1]!.state, 'unknown');
  assert.match(partial.session!.files[1]!.detail!, /Google reported 1 of 2 events/);
});

test('main re-checks every file: layout, calendar name, event count and no links', async () => {
  assert.equal(checkIcs(combined[0]!), null);
  assert.equal(checkIcs({ ...split[0]!, events: 2 }), 'event count');
  assert.equal(checkIcs({ ...split[0]!, calendarName: 'Other' }), 'calendar name');
  assert.equal(checkIcs({ ...split[0]!, ics: split[0]!.ics.replace('UID:x', 'URL:https://canvas.wisc.edu/x?verifier=1') }), 'link');
  assert.equal(checkIcs({ ...split[0]!, ics: split[0]!.ics.replace('UID:x', 'DESCRIPTION:https:/\r\n /x') }), 'link');
  const { controller } = await fakeHost().build();
  await assert.rejects(controller.handle({ action: 'prepare', mode: 'combined', files: split }), /don't match the chosen calendar layout/);
  await assert.rejects(controller.handle({ action: 'prepare', mode: 'split', files: [split[0]!, split[0]!] }), /don't match/);
  await assert.rejects(controller.handle({ action: 'attach', sessionId: 'x', fileKey: 'y', path: '/etc/passwd' }));
});

test('abandoned private folders older than a day are swept; recent ones stay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cal-import-sweep-'));
  await mkdir(join(root, 'magic-calendar-old')); await mkdir(join(root, 'magic-calendar-new')); await mkdir(join(root, 'unrelated'));
  const old = new Date(Date.parse('2026-09-25T00:00:00Z'));
  await utimes(join(root, 'magic-calendar-old'), old, old);
  await utimes(join(root, 'unrelated'), old, old);
  const host = fakeHost();
  const { controller } = await host.build(root);
  await controller.sweep();
  assert.deepEqual((await readdir(root)).sort(), ['magic-calendar-new', 'unrelated']);
});

test('student-facing status never says more than was observed', () => {
  const base = { key: 'k', family: 'lectures' as const, calendarName: 'Lectures', fileName: 'Magic-Lectures-2026-09-27-abc123.ics', events: 3 };
  assert.match(fileStatus({ ...base, state: 'preselected', destination: 'Ben' }), /Attached in Google: Magic-Lectures.*Google shows “Ben”.*click Import in Google/);
  assert.match(fileStatus({ ...base, state: 'imported', imported: 3, total: 3, destination: 'Lectures' }), /Google reported importing 3 of 3 events into “Lectures”/);
  assert.match(fileStatus({ ...base, state: 'unknown' }), /couldn’t see what happened/);
  const result: CalendarImportResult = { capability: { browser: 'Google Chrome', newWindow: true, accessibility: true }, session: { id: 's', mode: 'split', window: 'dispatched', stopped: false, files: [{ ...base, state: 'waiting' }] } };
  const html = renderToStaticMarkup(createElement(ImportSteps, { result, pending: null, run: () => {} }));
  assert.match(html, /didn’t see the window/);
  assert.doesNotMatch(html, /Show file in Finder/);
  assert.match(html, /Attach file in Google/);
});
