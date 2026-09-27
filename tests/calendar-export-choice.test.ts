import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { resolveDeadline } from '@magic/domain';
import type { CalendarImportRequest, PlanningSnapshot } from '@magic/contracts';
import { GoogleExportPanel } from '../apps/desktop/src/renderer/calendar/GoogleExportPanel';
import type { CalendarResource } from '../apps/desktop/src/renderer/calendar/model';

const here = dirname(fileURLToPath(import.meta.url));
const CANVAS = 'a'.repeat(64);
const now = '2026-09-27T15:00:00.000Z';
const due = (value: string) => resolveDeadline([{ kind: 'due' as const, value, quote: value, authority: 'structured' as const, scopeConfirmed: true, precision: 'minute' as const }]);
const item = (id: string, fields: Partial<CalendarResource> = {}): CalendarResource => ({ id, kind: 'assignment', accountScope: CANVAS, courseId: '101', courseName: 'CS 400', title: id, completed: false, submitted: null, kindLabel: null,
  sourceScope: 'assignments', externalId: id, url: `https://canvas.wisc.edu/courses/101/assignments/${id}`, submissionTypes: ['online_upload'], deadline: due('2026-10-02T04:59:00Z'), ...fields });
const observedAt = '2026-09-26T12:00:00.000Z', scope = { kind: 'enrollment_term', key: '1272' }, provenance = { sourceUrl: 'https://enroll.wisc.edu/x', observedAt, scope };
const meeting = { kind: 'class', mode: 'scheduled', days: [1, 3, 5], startMinute: 600, endMinute: 650, startDate: '2026-09-28', endDate: '2026-10-02', timezone: 'America/Chicago', location: 'Room 1240' };
const planning = { records: [
  { kind: 'enrollment_package', id: 'p1', localId: 'private:1', sourceId: 'source:1', accountScope: 'student', contentHash: 'h', version: 1, deleted: false, provenance, courseKey: 'uw:266:400', termCode: '1272', sections: ['LEC 001'], status: 'open', enrollmentState: 'enrolled', meetings: [meeting], meetingsComplete: true, seatsAvailable: null, capacity: null, waitlistCount: null, instructorNames: [] },
  { kind: 'account_link', id: 'l1', localId: 'link:1', sourceId: 'source:1', accountScope: 'student', contentHash: 'h', version: 1, deleted: false, provenance, canvasAccountScope: CANVAS, method: 'matched_institutional_login' },
  { kind: 'subject', id: 's1', localId: 'subject:266', sourceId: 'source:1', accountScope: 'public', contentHash: 'h', version: 1, deleted: false, provenance, code: '266', shortName: 'COMP SCI' },
], sources: [{ id: 'source:1', source: 'uw_enroll', accountScope: 'student', scope, sourceUrl: provenance.sourceUrl, status: 'complete', completeness: 'complete', observedAt, lastSuccessAt: observedAt, diagnostics: [] }] } as unknown as PlanningSnapshot;
const resources = [item('Homework 2'), item('Quiz 1', { submissionTypes: ['online_quiz'] })];
const props = { resources, planning, timeZone: 'America/Chicago', now, courseLabel: () => 'CS 400', onClose: () => {} };

test('first entry: One combined calendar is already chosen and Open Google Calendar is ready', () => {
  const html = renderToStaticMarkup(createElement(GoogleExportPanel, { ...props, bridge: { calendarImport: async () => ({ capability: { browser: null, newWindow: false, accessibility: false }, session: null }) } }));
  const radios = [...html.matchAll(/<label><input type="radio" name="calendar-export-mode"([^>]*)\/>([^<]*(?:<!-- -->[^<]*)*)<\/label>/g)].map(m => [m[2]!.replace(/<!-- -->/g, '').replaceAll('&amp;', '&'), /checked=""/.test(m[1]!)]);
  assert.deepEqual(radios, [['One calendar: UW classes and coursework', true], ['Three calendars: Lectures, Assignments, Exams & quizzes', false]]);
  const open = html.match(/<button[^>]*>(?:(?!<\/button>).)*Open Google Calendar/)![0];
  assert.doesNotMatch(open, /\sdisabled=""|aria-disabled="true"/, 'the default choice leaves nothing to pick before opening');
});

// A real DOM in Playwright's bundled headless Chromium: temporary profile, every network request refused, no Electron.
// When the pinned build isn't downloaded, an already-installed Playwright headless shell is used; nothing is installed.
function chromiumPath() {
  if (existsSync(chromium.executablePath())) return undefined;
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  const shell = existsSync(cache) ? readdirSync(cache).filter(name => /^chromium_headless_shell-\d+$/.test(name)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))[0] : undefined;
  const path = shell && join(cache, shell, 'chrome-headless-shell-mac-arm64/chrome-headless-shell');
  return path && existsSync(path) ? path : null;
}
const executablePath = chromiumPath();
const browserReady = executablePath !== null;
test('choosing Three calendars prepares separate Lectures / Assignments / Exams & quizzes files; the default prepares one', { skip: !browserReady && 'Playwright Chromium is not installed' }, async () => {
  const bundle = await build({
    stdin: { contents: `
      import { createElement } from 'react';
      import { createRoot } from 'react-dom/client';
      import { GoogleExportPanel } from '../apps/desktop/src/renderer/calendar/GoogleExportPanel';
      import '../packages/ui/src/styles.css';
      import '../apps/desktop/src/renderer/calendar/calendar.css';
      const fixture = window.__fixture;
      window.__calls = [];
      const bridge = { calendarImport: async request => {
        window.__calls.push(request);
        const capability = { browser: 'Google Chrome', newWindow: true, accessibility: true };
        if (request.action !== 'prepare') return { capability };
        return { capability, session: { id: 's1', mode: request.mode, window: 'none', stopped: false, files: request.files.map((f, i) => ({ key: 'k' + i, family: f.family, calendarName: f.calendarName, fileName: 'Magic-' + i + '.ics', events: f.events, state: 'waiting' })) } };
      } };
      createRoot(document.getElementById('root')).render(createElement(GoogleExportPanel, { ...fixture, courseLabel: () => 'CS 400', onClose: () => {}, bridge }));
    `, resolveDir: here, loader: 'tsx' },
    bundle: true, write: false, format: 'iife', outdir: join(here, '.out'), jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.woff': 'empty', '.woff2': 'empty', '.ttf': 'empty', '.svg': 'empty', '.png': 'empty' }, logLevel: 'silent',
  });
  const js = bundle.outputFiles.find(f => f.path.endsWith('.js'))!.text, css = bundle.outputFiles.find(f => f.path.endsWith('.css'))?.text ?? '';
  const browser = await chromium.launch({ headless: true, executablePath: executablePath ?? undefined });
  try {
    const context = await browser.newContext({ viewport: { width: 1100, height: 720 }, serviceWorkers: 'block' });
    await context.route('**/*', route => route.abort());
    const journey = async (chooseSplit: boolean) => {
      const page = await context.newPage();
      const fixture = JSON.stringify({ resources, planning, timeZone: 'America/Chicago', now }).replaceAll('<', '\\u003c');
      await page.setContent(`<!doctype html><style>${css}</style><body><div id="root"></div><script>window.__fixture=${fixture}</script><script>${js.replaceAll('</script', '<\\/script')}</script></body>`);
      const one = page.getByRole('radio', { name: 'One calendar: UW classes and coursework' });
      const three = page.getByRole('radio', { name: /^Three calendars/ });
      assert.equal(await one.isChecked(), true);
      assert.equal(await three.isChecked(), false);
      if (!chooseSplit && process.env.CALENDAR_EXPORT_SCREENSHOT) await page.locator('#calendar-export-panel').screenshot({ path: process.env.CALENDAR_EXPORT_SCREENSHOT });
      if (chooseSplit) { await three.check(); assert.equal(await one.isChecked(), false); }
      await page.getByRole('button', { name: 'Open Google Calendar' }).click();
      await page.waitForFunction(() => (window as unknown as { __calls: CalendarImportRequest[] }).__calls.some(c => c.action === 'open'));
      const calls = await page.evaluate(() => (window as unknown as { __calls: CalendarImportRequest[] }).__calls);
      await page.close();
      return calls;
    };
    const combined = (await journey(false)).find(c => c.action === 'prepare') as Extract<CalendarImportRequest, { action: 'prepare' }>;
    assert.equal(combined.mode, 'combined');
    assert.deepEqual(combined.files.map(f => [f.family, f.calendarName, f.events]), [['combined', 'UW classes and coursework', 5]]);
    const calls = await journey(true);
    const split = calls.find(c => c.action === 'prepare') as Extract<CalendarImportRequest, { action: 'prepare' }>;
    assert.equal(split.mode, 'split');
    assert.deepEqual(split.files.map(f => [f.family, f.calendarName, f.events]), [['lectures', 'Lectures', 3], ['assignments', 'Assignments', 1], ['exams', 'Exams & quizzes', 1]]);
    // Opening Google is still only a request to main; the destination and the Import click stay with the student in Google.
    assert.deepEqual(calls.map(c => c.action), ['status', 'prepare', 'open']);
  } finally { await browser.close(); }
});
