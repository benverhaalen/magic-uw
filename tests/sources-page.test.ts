import test from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Snapshot, SourceHealth, SyncRun } from '@magic/contracts';
import { buildCourses, buildRuns, buildSourcesModel, freshnessPhrase, isStale } from '../apps/desktop/src/renderer/sources/model';

// Synthetic source health only; no real course or account data.
const NOW = new Date('2026-09-27T15:00:00Z');
const HOUR = 3600_000;
const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * HOUR).toISOString();
function source(scope: string, fields: Partial<SourceHealth> = {}): SourceHealth {
  const courseId = fields.courseId ?? 'c1';
  return {
    id: `canvas:acct:${courseId}:${scope}:${fields.kind ?? 'canvas'}`,
    label: `Example Course 101 Section 3 · ${scope}`,
    kind: 'canvas', accountScope: 'acct', courseId, scope, status: 'ok',
    lastAttemptAt: at(1), lastSuccessAt: at(1), complete: true, resourceCount: 4,
    ...fields,
  };
}
const outlookOff = { icsConnected: false };
const model = (sources: SourceHealth[], extra: Partial<Snapshot> = {}, outlook: Parameters<typeof buildSourcesModel>[1]['outlook'] = outlookOff) =>
  buildSourcesModel({ sources, syncRuns: extra.syncRuns, planning: extra.planning }, { now: NOW, outlook });

test('nothing connected is not reported as current or complete', () => {
  const m = model([]);
  assert.equal(m.connections[0].id, 'canvas');
  assert.equal(m.connections[0].state, 'not_connected');
  assert.match(m.summary, /Nothing is connected/);
  assert.equal(m.attention, null);
});

test('an ended Canvas session asks for sign-in and keeps saved coursework', () => {
  const m = model([source('course', { status: 'needs_sign_in', complete: false, lastSuccessAt: at(30) }), source('assignments', { status: 'needs_sign_in', complete: false })]);
  const canvas = m.connections[0];
  assert.equal(canvas.state, 'needs_sign_in');
  assert.match(canvas.headline, /Saved coursework is still here/);
  assert.equal(m.attention?.id, 'canvas');
  assert.match(m.summary, /needs sign-in/);
});

test('a partial section makes the course and connection partial, never complete', () => {
  const m = model([source('course'), source('assignments', { status: 'partial', complete: false }), source('course', { courseId: 'c2' })]);
  const canvas = m.connections[0];
  assert.equal(canvas.state, 'partial');
  assert.match(canvas.headline, /1 of 2 courses was not read completely|1 of 2 courses were not read completely/);
  assert.equal(canvas.courses.find((c) => c.courseId === 'c1')?.state, 'partial');
  // A partial latest read has no 'read in full' date, even when that read saved something.
  assert.equal(canvas.courses.find((c) => c.courseId === 'c1')?.oldestSuccessAt, null);
  assert.equal(canvas.oldestSuccessAt, null);
  assert.match(canvas.headline, /1 of 2 courses was not read completely/);
});

test('a hidden or unpublished section is limited coverage, not a partial course', () => {
  const m = model([source('course'), source('quizzes', { status: 'not_published', complete: false })]);
  assert.equal(m.connections[0].courses[0].state, 'limited');
  assert.equal(m.connections[0].state, 'connected');
  assert.match(m.connections[0].headline, /some sections unavailable/);
});

test('a restricted course home marks the course restricted', () => {
  const [course] = buildCourses([source('course', { status: 'inaccessible', complete: false }), source('files')]);
  assert.equal(course.state, 'restricted');
});

test('old successful reads are stale; a never-read section has no full-read time', () => {
  const m = model([source('course', { lastSuccessAt: at(72), lastAttemptAt: at(72) })]);
  assert.equal(m.connections[0].state, 'stale');
  assert.ok(isStale(null, NOW));
  const [course] = buildCourses([source('course'), source('files', { lastSuccessAt: null, status: 'error', complete: false })]);
  assert.equal(course.oldestSuccessAt, null);
  assert.equal(course.state, 'error');
});

test('course labels are concise while the raw source name is preserved', () => {
  const [course] = buildCourses([source('course')], [{ key: 'acct:c1', label: 'EX 101' }]);
  assert.equal(course.label, 'EX 101');
  assert.equal(course.rawName, 'Example Course 101 Section 3');
});

test('a course GitLab sign-in stays on its course and does not end the Canvas session', () => {
  const m = model([source('course'), source('gitlab:issues', { kind: 'gitlab', status: 'needs_sign_in', complete: false })]);
  const canvas = m.connections[0];
  assert.notEqual(canvas.state, 'needs_sign_in');
  assert.equal(canvas.courses[0].needsGitLab, true);
  assert.equal(canvas.state, 'partial');
});

test('Outlook: saved link without a read is not up to date; ended Microsoft sign-in asks to sign in', () => {
  const saved = model([], {}, { icsConnected: true });
  const outlook = saved.connections.find((c) => c.id === 'outlook')!;
  assert.equal(outlook.state, 'stale');
  assert.match(outlook.headline, /Not read yet/);
  const expired = model([], {}, { icsConnected: false, graph: { state: 'expired', lastSyncAt: at(40), messages: 3, events: 2 } });
  assert.equal(expired.connections.find((c) => c.id === 'outlook')!.state, 'needs_sign_in');
  const unknown = model([], {}, { icsConnected: null });
  assert.match(unknown.connections.find((c) => c.id === 'outlook')!.headline, /not available/);
});

test('sample data alone is labeled as synthetic and not as a connection', () => {
  const m = model([source('course', { kind: 'fixture', id: 'fixture:1', courseId: 'f1', label: 'Sample' })]);
  const sample = m.connections.find((c) => c.state === 'sample');
  assert.ok(sample);
  assert.match(sample!.account, /Synthetic/);
  assert.match(m.summary, /Only sample data/);
});

test('recent checks are newest first with honest results', () => {
  const runs: SyncRun[] = [
    { id: 'a', startedAt: at(5), finishedAt: at(5), status: 'ok', action: 'background', sourceCount: 12, stats: { durationMs: 4200 } },
    { id: 'b', startedAt: at(1), finishedAt: at(1), status: 'partial', action: 'manual', sourceCount: 1 },
  ];
  const lines = buildRuns(runs, NOW);
  assert.deepEqual(lines.map((l) => l.id), ['b', 'a']);
  assert.equal(lines[0].result, 'Partly read');
  assert.equal(lines[0].tone, 'attention');
  assert.equal(lines[1].detail, '12 sections, 4s');
});

test('rendered page: row fixes in place, disconnect versus delete, no authored em dash', async () => {
  // tsx compiles these TSX files with the classic runtime outside the Vite build.
  (globalThis as { React?: typeof React }).React = React;
  const { SourcesPage } = await import('../apps/desktop/src/renderer/sources/SourcesPage');
  const snapshot = {
    sources: [source('course', { status: 'needs_sign_in', complete: false }), source('files', { status: 'needs_sign_in', complete: false })],
    syncRuns: [], jobs: [], resources: [], links: [], receipts: [], attempts: [], fixtureMode: false, gatewayConfigured: false, generatedAt: NOW.toISOString(),
  } as unknown as Snapshot;
  const noop = () => undefined;
  const html = renderToStaticMarkup(React.createElement(SourcesPage, {
    snapshot, busy: false, run: async () => undefined, onSignIn: noop, onSync: async () => undefined, onSignOut: noop, onImport: noop, onSample: noop,
    onOpenMyUw: noop, onOpenPrivacy: noop, uwConsented: true, now: () => NOW,
    bridge: { signInUW: async () => ({}) as never, syncCanvas: async () => ({}) as never, signOutUW: async () => {}, setOutlookCalendar: async () => ({ connected: false }), outlookCalendarStatus: async () => ({ connected: false }) },
  }));
  assert.match(html, /Sign in again/);
  assert.match(html, /data-connection="canvas"[^]*?<details[^>]*data-place-disclosure="sources:canvas"[^>]*open=""/); // the connection needing attention opens on a fresh visit
  assert.match(html, /data-focus-key="sources-canvas-signin"/); // Back returns focus to the row action
  assert.match(html, /Sign out of UW/);
  assert.match(html, /Delete saved coursework/);
  assert.match(html, /never submits work/);
  assert.doesNotMatch(html, /—/);
  assert.doesNotMatch(html, /Up to date/);
});

test('Outlook coverage follows the connection actually available', () => {
  const ics = model([], {}, { icsConnected: true }).connections.find((c) => c.id === 'outlook')!;
  assert.doesNotMatch(ics.covers, /mail/i); // a published calendar link carries no mail
  const notSetUp = model([], {}, { icsConnected: false, graph: { state: 'not_set_up', lastSyncAt: null, messages: 0, events: 0 } }).connections.find((c) => c.id === 'outlook')!;
  assert.doesNotMatch(notSetUp.covers, /mail/i);
  const graph = model([], {}, { icsConnected: false, graph: { state: 'connected', lastSyncAt: at(1), messages: 3, events: 2 } }).connections.find((c) => c.id === 'outlook')!;
  assert.match(graph.covers, /mail previews/);
  assert.equal(graph.freshness.startsWith('Checked'), true);
});

test('freshness names the last full read when the newest attempt failed', () => {
  assert.equal(freshnessPhrase(null, null, NOW), 'Never checked');
  assert.match(freshnessPhrase(at(1), at(30), NOW), /^Last full read/);
  assert.match(freshnessPhrase(at(1), null, NOW), /never read in full/);
});

test('rendered page: Microsoft sign-in is not offered when the build has not set it up', async () => {
  (globalThis as { React?: typeof React }).React = React;
  const { SourcesPage } = await import('../apps/desktop/src/renderer/sources/SourcesPage');
  const snapshot = { sources: [source('course')], syncRuns: [], jobs: [], planning: undefined } as unknown as Snapshot;
  const noop = () => undefined;
  const html = renderToStaticMarkup(React.createElement(SourcesPage, {
    snapshot, busy: false, run: async () => undefined, onSignIn: noop, onSync: async () => undefined, onSignOut: noop, onImport: noop, onSample: noop,
    onOpenMyUw: noop, onOpenPrivacy: noop, uwConsented: true, now: () => NOW,
    bridge: { setOutlookCalendar: async () => ({ connected: false }), outlookCalendarStatus: async () => ({ connected: false }), outlookConnect: async () => { throw new Error('must not be called'); }, outlookStatus: async () => ({ outlook: 'not_set_up' as const, lastSyncAt: null, counts: { messages: 0, events: 0 }, icsConnected: false }) },
  }));
  assert.match(html, /data-focus-key="sources-outlook-setup"/);
  assert.doesNotMatch(html, /Connect with Microsoft/);
  assert.doesNotMatch(html, /Notes/); // no notes connection without a renderer notes API
  assert.doesNotMatch(html, /—/);
});
