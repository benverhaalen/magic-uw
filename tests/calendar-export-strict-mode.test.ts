import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Page } from 'playwright';
import { resolveDeadline } from '@magic/domain';
import type { CalendarImportRequest } from '@magic/contracts';
import type { CalendarResource } from '../apps/desktop/src/renderer/calendar/model';

// React's development build under <StrictMode> replays every mount effect (setup → cleanup → setup) on the same refs.
// Real DOM in Playwright's headless Chromium: temporary profile, every network request refused, no Electron.
const here = dirname(fileURLToPath(import.meta.url));
const CANVAS = 'a'.repeat(64);
const now = '2026-09-27T15:00:00.000Z';
const due = (value: string) => resolveDeadline([{ kind: 'due' as const, value, quote: value, authority: 'structured' as const, scopeConfirmed: true, precision: 'minute' as const }]);
const item = (id: string, fields: Partial<CalendarResource> = {}): CalendarResource => ({ id, kind: 'assignment', accountScope: CANVAS, courseId: '101', courseName: 'CS 400', title: id, completed: false, submitted: null, kindLabel: null,
  sourceScope: 'assignments', externalId: id, url: `https://canvas.wisc.edu/courses/101/assignments/${id}`, submissionTypes: ['online_upload'], deadline: due('2026-10-02T04:59:00Z'), ...fields });
const resources = [item('Homework 2'), item('Quiz 1', { submissionTypes: ['online_quiz'] })];

function chromiumPath() {
  if (existsSync(chromium.executablePath())) return undefined;
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  const shell = existsSync(cache) ? readdirSync(cache).filter(name => /^chromium_headless_shell-\d+$/.test(name)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))[0] : undefined;
  const path = shell && join(cache, shell, 'chrome-headless-shell-mac-arm64/chrome-headless-shell');
  return path && existsSync(path) ? path : null;
}
const executablePath = chromiumPath();

/** The panel mounted in StrictMode; `prepare` waits until the test releases it, every other call answers at once. */
const FIXTURE = `
  import { createElement, StrictMode } from 'react';
  import { createRoot } from 'react-dom/client';
  import { GoogleExportPanel } from '../apps/desktop/src/renderer/calendar/GoogleExportPanel';
  const capability = { browser: 'Google Chrome', newWindow: true, accessibility: true };
  const session = (request, state, stopped) => ({ id: 's1', mode: 'combined', window: state === 'waiting' ? 'none' : 'observed', stopped,
    files: [{ key: 'k0', family: 'combined', calendarName: 'UW classes and coursework', fileName: 'Magic-UW-calendar.ics', events: 5, state, stoppedFrom: stopped ? 'preselected' : undefined }] });
  window.__calls = [];
  let releasePrepare;
  window.__releasePrepare = () => releasePrepare();
  const bridge = { calendarImport: request => {
    window.__calls.push(request);
    if (request.action === 'prepare') return new Promise(resolve => { releasePrepare = () => resolve({ capability, session: session(request, 'waiting', false) }); });
    if (request.action === 'open') return Promise.resolve({ capability, session: session(request, 'preselected', false) });
    if (request.action === 'stop') return Promise.resolve({ capability, session: session(request, 'stopped', true) });
    return Promise.resolve({ capability });
  } };
  const root = createRoot(document.getElementById('root'));
  window.__unmount = () => root.unmount();
  root.render(createElement(StrictMode, null, createElement(GoogleExportPanel, { ...window.__fixture, courseLabel: () => 'CS 400', onClose: () => root.unmount(), bridge })));
`;

const actions = (page: Page) => page.evaluate(() => (window as unknown as { __calls: CalendarImportRequest[] }).__calls.map(c => c.action));
const until = (page: Page, action: string) => page.waitForFunction(name => (window as unknown as { __calls: CalendarImportRequest[] }).__calls.some(c => c.action === name), action, { timeout: 5000 });

test('StrictMode effect replay: first entry still prepares and opens Google, and leaving mid-prepare still stops it', { skip: executablePath === null && 'Playwright Chromium is not installed' }, async () => {
  const bundle = await build({
    stdin: { contents: FIXTURE, resolveDir: here, loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent',
  });
  const js = bundle.outputFiles[0]!.text;
  const browser = await chromium.launch({ headless: true, executablePath: executablePath ?? undefined });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', route => route.abort());
    const mount = async () => {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      const fixture = JSON.stringify({ resources, timeZone: 'America/Chicago', now }).replaceAll('<', '\\u003c');
      await page.setContent(`<!doctype html><body><div id="root"></div><script>window.__fixture=${fixture}</script><script>${js.replaceAll('</script', '<\\/script')}</script></body>`);
      await page.getByRole('radio', { name: 'One calendar: UW classes and coursework' }).waitFor();
      return { page, errors };
    };

    // First entry: the default One calendar is chosen; Open reaches prepare, then open, after StrictMode's replay.
    const first = await mount();
    assert.equal(await first.page.getByRole('radio', { name: 'One calendar: UW classes and coursework' }).isChecked(), true);
    await first.page.getByRole('button', { name: 'Open Google Calendar' }).click();
    await until(first.page, 'prepare');
    await first.page.evaluate(() => (window as unknown as { __releasePrepare: () => void }).__releasePrepare());
    await until(first.page, 'open');
    await first.page.getByText('Attached in Google: Magic-UW-calendar.ics.').waitFor({ timeout: 5000 });
    const opened = await actions(first.page);
    assert.deepEqual(opened.filter(a => a !== 'status'), ['prepare', 'open'], 'the replayed cleanup stopped nothing and the student still clicks Import in Google');
    // Real Stop still ends the export and leaves no active controls.
    await first.page.getByRole('button', { name: 'Stop', exact: true }).click();
    await until(first.page, 'stop');
    await first.page.getByText(/^Stopped after Magic attached Magic-UW-calendar\.ics in Google\./).waitFor({ timeout: 5000 });
    assert.equal(await first.page.getByRole('button', { name: 'Stop', exact: true }).count(), 0);
    assert.deepEqual(first.errors, []);
    await first.page.close();

    // Choosing Three calendars still works after the replay.
    const split = await mount();
    await split.page.getByRole('radio', { name: /^Three calendars/ }).check();
    await split.page.getByRole('button', { name: 'Open Google Calendar' }).click();
    await until(split.page, 'prepare');
    const prepare = await split.page.evaluate(() => (window as unknown as { __calls: CalendarImportRequest[] }).__calls.find(c => c.action === 'prepare'));
    assert.equal((prepare as Extract<CalendarImportRequest, { action: 'prepare' }>).mode, 'split');
    await split.page.close();

    // Leaving mid-prepare (Stop and close → real unmount): main's prepared session is stopped and Google never opens.
    const leave = await mount();
    await leave.page.getByRole('button', { name: 'Open Google Calendar' }).click();
    await until(leave.page, 'prepare');
    await leave.page.getByRole('button', { name: 'Stop and close' }).click();
    await leave.page.evaluate(() => (window as unknown as { __releasePrepare: () => void }).__releasePrepare());
    await until(leave.page, 'stop');
    await leave.page.waitForTimeout(100);
    assert.deepEqual((await actions(leave.page)).filter(a => a !== 'status'), ['prepare', 'stop']);
    assert.deepEqual(leave.errors, []);
    await leave.page.close();
  } finally { await browser.close(); }
});
