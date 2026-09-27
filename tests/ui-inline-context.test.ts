import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InlineEntity, InlineTime, destinationAction, presentationLabel, presentationLabels, sourceDates } from '../packages/ui/src/inline-context';

// Synthetic titles. "P1 (MySQL)" mirrors the synthetic day-plan fixture, not a verified source title.
const shown = { shownPrefixes: ['COMPSCI 574', 'CS 574'] };

test('removes only a verified, already-shown course prefix and keeps number, topic and stage', () => {
  const p = presentationLabel('COMPSCI 574: P1 (MySQL)', shown);
  assert.equal(p.label, 'P1 (MySQL)');
  assert.equal(p.raw, 'COMPSCI 574: P1 (MySQL)');
  assert.ok(p.shortened);
  assert.deepEqual(p.removed, [{ kind: 'context-prefix', start: 0, end: 13, text: 'COMPSCI 574: ' }]);
  assert.equal(presentationLabel('CS 574 - Assigned readings', shown).label, 'Assigned readings');
  assert.equal(presentationLabel('COMPSCI 574: Project 2 Part B draft', shown).label, 'Project 2 Part B draft');
});

test('label is always a contiguous literal slice of the raw title', () => {
  const titles = ['COMPSCI 574: P1 (MySQL)', 'P1 (MySQL)', 'COMPSCI 574 · Week 5 quiz (FA26)', 'Quiz 3 (FA26)'];
  for (const raw of titles) {
    const p = presentationLabel(raw, { ...shown, shownSuffixes: [' (FA26)'] });
    assert.ok(raw.includes(p.label), raw);
    for (const r of p.removed) assert.equal(raw.slice(r.start, r.end), r.text);
    assert.ok(!p.label.includes('…') && !p.label.endsWith('...'));
  }
});

test('keeps the raw title when nothing verified is shown, casing differs or the rest would be empty', () => {
  assert.equal(presentationLabel('COMPSCI 574: P1 (MySQL)').label, 'COMPSCI 574: P1 (MySQL)');
  assert.equal(presentationLabel('compsci 574: P1 (MySQL)', shown).shortened, false, 'case-sensitive');
  assert.equal(presentationLabel('COMPSCI 5741: P1', shown).shortened, false, 'prefix must end at a separator');
  assert.equal(presentationLabel('COMPSCI 574: 1', shown).label, 'COMPSCI 574: 1', 'no letters left');
  assert.equal(presentationLabel('COMPSCI 574:  P1', shown).label, 'COMPSCI 574:  P1', 'unexpected whitespace stays');
  const longTitle = 'COMPSCI 574: Read chapters 4 through 7 of the textbook and complete the reflection worksheet before lecture';
  assert.equal(presentationLabel(longTitle, shown).label, longTitle.slice(13), 'long names stay whole');
});

test('keeps a numbered identity head and drops only a long instruction tail', () => {
  const raw = 'COMPSCI 574: T-shirt cart request - Step 1: Draft the checkout flow and upload three annotated screenshots';
  const p = presentationLabel(raw, shown);
  assert.equal(p.label, 'T-shirt cart request - Step 1');
  assert.deepEqual(p.removed.map(r => r.kind), ['context-prefix', 'description-tail']);
  assert.equal(presentationLabel('Quiz 3: Graphs and traversal', shown).label, 'Quiz 3: Graphs and traversal', 'short topic tail stays');
  assert.equal(presentationLabel('Reflection: write about what you learned this week in detail').shortened, false, 'no numbered stage, no cut');
  assert.equal(presentationLabel('Step 1: Draft the checkout flow and upload three annotated screenshots').shortened, false, 'stage alone is not a topic');
  assert.equal(presentationLabel('Build a 3D model: sketch the parts and write down every measurement you take').shortened, false, 'ordinary words are not stages');
});

test('reverts shortened labels that would make different items look identical', () => {
  const [a, b, c] = presentationLabels(['COMPSCI 574: Assigned readings', 'CS 574 - Assigned readings', 'COMPSCI 574: P1 (MySQL)'], shown);
  assert.equal(a!.label, 'COMPSCI 574: Assigned readings');
  assert.equal(b!.label, 'CS 574 - Assigned readings');
  assert.equal(c!.label, 'P1 (MySQL)');
});

test('action names the actual destination; Start work only for several verified destinations', () => {
  const page = { role: 'instructions', target: { kind: 'web' } } as const;
  const file = { role: 'material', target: { kind: 'file' } } as const;
  assert.deepEqual(destinationAction([]), { label: null, multiple: false });
  assert.deepEqual(destinationAction([page]), { label: 'Open assignment', multiple: false });
  assert.equal(destinationAction([file]).label, 'Open document');
  assert.equal(destinationAction([{ role: 'material', target: { kind: 'web' } }]).label, 'Open course page');
  assert.deepEqual(destinationAction([file, page]), { label: 'Start work', multiple: true });
});

test('a plain time is not interactive; a routed time is a named native link', () => {
  const plain = renderToStaticMarkup(h(InlineTime, { dateTime: '2026-09-28T13:00', parts: ['tomorrow', '1 PM'] }));
  assert.match(plain, /^<time class="magic-inline-time" datetime="2026-09-28T13:00">/i);
  assert.doesNotMatch(plain, /<a |tabindex|role=/);
  assert.equal((plain.match(/magic-inline-time__part/g) ?? []).length, 2);
  const routed = renderToStaticMarkup(h(InlineTime, { dateTime: '2026-09-28T13:00', parts: ['tomorrow', '1 PM'], destination: { href: '#calendar/2026-09-28', name: 'open in Calendar' } }));
  assert.match(routed, /^<a class="magic-inline-time magic-inline-time--link" href="#calendar\/2026-09-28">/);
  assert.match(routed, /magic-inline-sr">, open in Calendar</);
  const grouped = renderToStaticMarkup(h(InlineTime, { dateTime: 'x', parts: ['tomorrow', '1 PM'], after: '.' }));
  assert.match(grouped, /^<span class="magic-inline-time-group"><time [^>]+>.*<\/time>\.<\/span>$/);
  const colored = renderToStaticMarkup(h(InlineTime, { dateTime: 'x', parts: ['Fri'], colors: { fill: 'var(--role-fill)', ink: 'var(--role-ink)' } }));
  assert.match(colored, /--magic-inline-time-fill:var\(--role-fill\)/);
});

test('entity exposes the raw title only when the label was shortened', () => {
  const link = (label: string) => h('a', { href: '#resource/r1' }, label);
  const short = presentationLabel('COMPSCI 574: P1 (MySQL)', shown);
  assert.match(renderToStaticMarkup(h(InlineEntity, { name: short }, link(short.label))), /title="COMPSCI 574: P1 \(MySQL\)"[^>]*><a href="#resource\/r1">P1 \(MySQL\)<\/a>/);
  const whole = presentationLabel('Assigned readings');
  assert.doesNotMatch(renderToStaticMarkup(h(InlineEntity, { name: whole }, link(whole.label))), /title=/);
});

test('disagreement tags only show due dates a source states, never title-derived or out-of-scope ones', () => {
  const c = (value: string, origin: any, extra: object = {}) => ({ value, kind: 'due' as const, authority: 'structured' as const, scopeConfirmed: true, origin, ...extra });
  const dates = sourceDates([
    c('2026-10-01T23:59:00-05:00', 'canvas'),
    c('2026-10-02T04:59:00Z', 'syllabus'),
    c('2026-10-03T05:00:00Z', 'syllabus', { precision: 'day' }),
    c('2026-10-05T23:59:00-05:00', 'title', { authority: 'title' }),
    c('2026-10-06T23:59:00-05:00', 'page', { scopeConfirmed: false }),
    { ...c('2026-10-07T23:59:00-05:00', 'announcement'), kind: 'lock' as const },
    c('2026-10-04T23:59:00-05:00', 'announcement', { authority: 'explicit_change' }),
  ]);
  assert.deepEqual(dates, [
    { value: '2026-10-01T23:59:00-05:00', precision: 'minute', sources: ['Canvas', 'the syllabus'] },
    { value: '2026-10-03T05:00:00Z', precision: 'day', sources: ['the syllabus'] },
    { value: '2026-10-04T23:59:00-05:00', precision: 'minute', sources: ['an announced change'] },
  ]);
  assert.deepEqual(sourceDates([{ value: '2026-10-01T23:59:00-05:00', kind: 'due', authority: 'structured', scopeConfirmed: true }]),
    [{ value: '2026-10-01T23:59:00-05:00', precision: 'minute', sources: [] }], 'unknown origin is not given a made-up name');
});
