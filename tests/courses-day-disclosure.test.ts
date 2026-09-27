import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CourseWorkModel, CourseWorkRow } from '../apps/desktop/src/renderer/courses/course-work-model';
import { groupCourseWork, initialWorkListState, openWorkDayState, pageWorkGroups, setWorkDayOpen, workDayKey, workDayOpen, type WorkGroup, type WorkListState } from '../apps/desktop/src/renderer/courses/course-work-display';

Object.assign(globalThis, { React });
registerHooks({ load: (url, context, next) => url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context) });
const { CoursesWorkList } = await import('../apps/desktop/src/renderer/courses/CoursesWorkView');

// Synthetic rows only; no student course data.
const today = '2026-09-27', tomorrow = '2026-09-28', scope = 'scope-a';
const TODAY = 'current:2026-09-27:today', TOMORROW = 'current:2026-09-28', WEDNESDAY = 'current:2026-09-30';
function row(key: string, date: string | null = today, changes: Partial<CourseWorkRow> = {}): CourseWorkRow {
  return { key, accountScope: 'a', courseId: 'c', resourceId: key, evidenceIds: [key], sourceIds: ['s'], kind: 'assignment', mode: 'task', title: `Task ${key}`, courseLabel: 'SYN 101',
    time: date ? { state: 'dated', date, minute: 1439, at: `${date}T23:59:00Z`, timeZone: 'UTC', role: 'due', personal: false, sourceConflict: false } : { state: 'undated' },
    sourceState: 'unknown', report: null, action: null, ...changes };
}
const rows = (prefix: string, count: number, date: string) => Array.from({ length: count }, (_, i) => row(`${prefix}${i}`, date));
const current = (items: CourseWorkRow[], state: WorkListState, on = today) => groupCourseWork(items, on, state).find(bucket => bucket.section === 'current')!.groups;
const opener = (state: WorkListState, on = today, key = scope) => (group: WorkGroup) => workDayOpen(state, key, workDayKey(group, on));
const collapse = (...days: string[]) => days.reduce((state, day) => setWorkDayOpen(state, scope, day, false), initialWorkListState());
function model(items: CourseWorkRow[], key = scope): CourseWorkModel {
  return { scope: { key, selectedTerm: null, term: { label: 'Fall 2026', state: 'verified' }, courses: [] }, rows: items, coverage: [], generatedAt: `${today}T15:00:00Z` };
}
function render(items: CourseWorkRow[], state: WorkListState, key = scope, now = `${today}T15:00:00Z`) {
  return renderToStaticMarkup(createElement(CoursesWorkList, { model: model(items, key), state, onStateChange: () => {}, timeZone: 'UTC', now,
    onOpen: () => {}, onAction: () => {}, onReport: async () => ({ status: 'unavailable', reason: 'storage' }) as const, onSources: () => {} }));
}
/** Each rendered day: its heading toggle, the animated rows container, and the row keys mounted inside it. */
function days(html: string) {
  return [...html.matchAll(/<section class="cw-day">([\s\S]*?)<\/section>/g)].map(([, body]) => {
    const toggle = body!.match(/<h2><button type="button" class="cw-day-toggle magic-fb-pill" aria-expanded="(true|false)" aria-controls="([^"]+)" data-focus-key="([^"]+)">(.*?)<\/button><\/h2>/);
    const rowsBox = body!.match(/<div id="([^"]+)" class="magic-motion-rows cw-day-rows" data-open="(true|false)"( inert="")?><div><ul class="cw-rows">/);
    return {
      toggle: toggle && { expanded: toggle[1] === 'true', controls: toggle[2]!, focus: toggle[3]!, text: toggle[4]!.replace(/<[^>]+>/g, '') },
      box: rowsBox && { id: rowsBox[1]!, open: rowsBox[2] === 'true', inert: !!rowsBox[3] },
      rows: [...body!.matchAll(/data-place-anchor="course-work-([^"]+)"/g)].map(match => match[1]!),
      body: body!,
    };
  });
}
const toggles = (html: string) => days(html).flatMap(day => day.toggle ? [day.toggle] : []);
/** Rows a reader can see and reach: mounted rows of closed days are inert and transition to hidden. */
const visibleRows = (html: string) => days(html).flatMap(day => !day.box || day.box.open ? day.rows : []);

test('day group key is section plus ISO date; Today is distinct and undated groups have none', () => {
  const groups = groupCourseWork([row('t'), row('m', tomorrow), row('late', '2026-10-20'), row('old', '2026-09-01'), row('u', null)], today, initialWorkListState());
  const keys = Object.fromEntries(groups.flatMap(bucket => bucket.groups).map(group => [group.label, workDayKey(group, today)]));
  assert.equal(keys.Today, TODAY);
  assert.equal(keys.Tomorrow, TOMORROW);
  assert.equal(keys['Tuesday, Oct 20'], 'later:2026-10-20');
  assert.equal(keys['Past due'], null);
  assert.equal(keys['No date'], null);
});

test('every day starts open; a new date, a new Today, or another account/term scope never inherits a collapsed day', () => {
  let state = initialWorkListState();
  assert.ok(current([row('t'), row('m', tomorrow)], state).every(opener(state)));
  const [todayGroup, tomorrowGroup] = current([row('t'), row('m', tomorrow)], state);
  state = setWorkDayOpen(state, scope, workDayKey(todayGroup!, today)!, false);
  state = setWorkDayOpen(state, scope, workDayKey(tomorrowGroup!, today)!, false);
  assert.equal(opener(state)(todayGroup!), false);
  // After midnight yesterday's Today is not Today, and the collapsed Tomorrow becomes an open Today.
  const next = current([row('m', tomorrow), row('n', '2026-09-29')], state, tomorrow);
  assert.equal(next[0]!.label, 'Today');
  assert.ok(next.every(opener(state, tomorrow)));
  // Same date in another admitted scope starts open, and toggling there discards the old scope's choices.
  assert.equal(opener(state, today, 'scope-b')(todayGroup!), true);
  const other = setWorkDayOpen(state, 'scope-b', 'current:2026-09-30', false);
  assert.deepEqual(other.days, { scope: 'scope-b', open: { 'current:2026-09-30': false } });
  // Existing list state is untouched by a day choice.
  const withSections: WorkListState = { expanded: { later: true }, visible: { current: 40 }, pins: { t: { section: 'current', date: today } } };
  const toggled = setWorkDayOpen(withSections, scope, TOMORROW, false);
  assert.deepEqual([toggled.expanded, toggled.visible, toggled.pins], [withSections.expanded, withSections.visible, withSections.pins]);
});

test('collapsing Today hides its rows but keeps its heading, date and count; expanding restores them', () => {
  const items = [row('t1'), row('t2'), row('m1', tomorrow)];
  const open = render(items, initialWorkListState());
  assert.deepEqual(toggles(open).map(t => [t.text, t.expanded]), [['TodaySep 27', true], ['TomorrowSep 28', true]]);
  assert.deepEqual(visibleRows(open), ['t1', 't2', 'm1']);
  const closed = render(items, collapse(TODAY));
  assert.deepEqual(toggles(closed).map(t => [t.text, t.expanded]), [['TodaySep 27· 2', false], ['TomorrowSep 28', true]]);
  assert.deepEqual(visibleRows(closed), ['m1']);
  assert.match(closed, /data-place-anchor="course-day-current:2026-09-27:today"/);
  assert.equal(render(items, setWorkDayOpen(collapse(TODAY), scope, TODAY, true)), open);
});

test('motion: the same mounted rows container carries the change, so a CSS transition animates and reverses it', () => {
  const items = [row('t1'), row('t2'), row('m1', tomorrow)];
  const before = render(items, initialWorkListState());
  const after = render(items, collapse(TODAY));
  const [openToday] = days(before), [closedToday] = days(after);
  // Before: open rows container, not inert, contents mounted.
  assert.deepEqual(openToday!.box && { open: openToday!.box.open, inert: openToday!.box.inert }, { open: true, inert: false });
  // During and after the exit the rows are still mounted in that container (nothing unmounts that would cut the
  // height transition short); the container flips to data-open=false and becomes inert in the same commit.
  assert.deepEqual(closedToday!.box && { open: closedToday!.box.open, inert: closedToday!.box.inert }, { open: false, inert: true });
  assert.deepEqual(closedToday!.rows, openToday!.rows);
  // Only state attributes and the collapsed count differ, so React patches the same nodes instead of replacing them.
  const strip = (html: string) => html.replace(/ aria-expanded="(true|false)"| data-open="(true|false)"| inert=""|<span class="cw-day-count">[^<]*<\/span>/g, '');
  assert.equal(strip(after), strip(before));
  // Rapid reversal: close then open again within the transition returns to the identical markup, from which the
  // browser retargets the running grid-rows/opacity transition from its painted value.
  const reopened = openWorkDayState(collapse(TODAY), scope, 'current', current(items, collapse(TODAY)), today, TODAY, true);
  assert.equal(render(items, reopened), before);
  assert.equal(render(items, openWorkDayState(reopened, scope, 'current', current(items, reopened), today, TODAY, false)), after);
});

test('motion recipe: rows animate height and opacity with the disclosure token; reduced motion removes height travel', () => {
  const recipe = readFileSync(new URL('../packages/ui/src/motion/motion.css', import.meta.url), 'utf8');
  const local = readFileSync(new URL('../apps/desktop/src/renderer/courses/courses-work-view.css', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../apps/desktop/src/renderer/main.tsx', import.meta.url), 'utf8');
  assert.match(main, /packages\/ui\/src\/motion\/motion\.css/, 'the recipe is loaded globally in the desktop renderer');
  const [normal, reduced] = recipe.split('@media (prefers-reduced-motion: reduce)');
  const rule = (css: string, selector: string) => css.match(new RegExp(`${selector.replace(/[.[\]=*>]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
  assert.match(rule(normal!, '.magic-motion-rows'), /transition-property:\s*grid-template-rows,\s*opacity,\s*visibility/);
  assert.match(rule(normal!, '.magic-motion-rows'), /transition-duration:\s*var\(--magic-motion-disclosure\)/);
  assert.match(rule(normal!, '.magic-motion-rows'), /transition-behavior:\s*allow-discrete/);
  assert.match(rule(normal!, '.magic-motion-rows[data-open=false]'), /grid-template-rows:\s*0fr;\s*opacity:\s*0;\s*visibility:\s*hidden/);
  assert.match(rule(normal!, '.magic-motion-rows > *'), /min-height:\s*0;\s*overflow:\s*clip/);
  // Reduced motion: height changes in one step; only the opacity cue remains.
  assert.match(rule(reduced!, '.magic-motion-rows'), /transition-property:\s*opacity,\s*visibility;/);
  assert.doesNotMatch(rule(reduced!, '.magic-motion-rows'), /grid-template-rows/);
  // The local sheet does not override the recipe, and the chevron turns as part of the same event.
  assert.doesNotMatch(local.replace(/\/\*[\s\S]*?\*\//g, ''), /\.cw-day-rows|magic-motion-rows/);
  assert.match(local, /\.cw-day-toggle svg \{[^}]*transition: transform var\(--magic-motion-disclosure\) var\(--magic-motion-ease-out\)/);
  assert.match(local.split('@media (prefers-reduced-motion: reduce)')[1]!, /\.cw-day-toggle svg[^}]*transition: none/);
});

test('Back restores the per-day state it left with; a scope remount does not reuse it', () => {
  const items = [row('t1'), row('m1', tomorrow), row('w1', '2026-09-30')];
  const left = collapse(TOMORROW);
  // Navigation keeps the place's WorkListState verbatim; Back renders from that same value.
  const place = structuredClone({ view: 'courses', courseWorkState: left });
  assert.equal(render(items, place.courseWorkState), render(items, left));
  assert.deepEqual(toggles(render(items, place.courseWorkState)).map(t => t.expanded), [true, false, true]);
  assert.deepEqual(toggles(render(items, left, 'scope-b')).map(t => t.expanded), [true, true, true]);
});

test('keyboard and ARIA: a native button in the heading controls the rows container; closed rows are inert', () => {
  const items = [row('t1', today, { report: { issueId: 't1', obligationVersion: 'v', revision: 1, checked: false, needsReview: false } as CourseWorkRow['report'] })];
  const [closed] = days(render(items, collapse(TODAY)));
  assert.ok(closed?.toggle && !closed.toggle.expanded);
  assert.equal(closed.toggle.focus, 'course-day-current:2026-09-27:today');
  assert.equal(closed.toggle.controls, closed.box?.id, 'aria-controls names the animated container');
  // The checkbox stays mounted for the exit motion but sits inside an inert subtree: not focusable or clickable.
  assert.equal(closed.box?.inert, true);
  assert.match(closed.body, /type="checkbox"/);
  const [open] = days(render(items, initialWorkListState()));
  assert.ok(open?.toggle?.expanded);
  assert.equal(open.toggle.controls, open.box?.id);
  assert.equal(open.box?.inert, false);
});

test('empty Today stays omitted and undated/Past due groups keep plain headings without day toggles', () => {
  const html = render([row('old', '2026-09-01'), row('u', null)], { ...initialWorkListState(), expanded: { overdue: true } });
  assert.equal(toggles(html).length, 0);
  assert.doesNotMatch(html, />Today</);
  assert.doesNotMatch(html, /magic-motion-rows/);
  assert.match(html, /data-focus-key="course-work-section-overdue"/);
});

test('pagination: collapsed days take no page budget, keep their order, and carry the rows they show when open', () => {
  const items = [...rows('t', 25, today), ...rows('m', 5, tomorrow), ...rows('w', 12, '2026-09-30')];
  const all = current(items, initialWorkListState());
  // Default: Today finishes its boundary within thirty rows.
  const initial = pageWorkGroups(all, opener(initialWorkListState()));
  assert.deepEqual([initial.limit, initial.hidden, initial.groups.map(g => g.rows.length)], [25, 17, [25]]);
  // Collapsing Today frees the page for the following days; its 25 open rows stay mounted for the exit.
  const state = collapse(TODAY);
  const collapsed = pageWorkGroups(all, opener(state));
  assert.deepEqual(collapsed.groups.map(g => [g.label, g.open, g.rows.length, g.total]), [['Today', false, 25, 25], ['Tomorrow', true, 5, 5], ['Wednesday, Sep 30', true, 12, 12]]);
  assert.equal(collapsed.hidden, 0);
  // A collapsed day past the first page cut appears in order once paging reaches it.
  const late = collapse(WEDNESDAY);
  const first = pageWorkGroups(all, opener(late));
  assert.deepEqual(first.groups.map(g => g.label), ['Today']);
  assert.equal(first.hidden, 5);
  const second = pageWorkGroups(all, opener(late), first.limit + 20);
  assert.deepEqual(second.groups.map(g => [g.label, g.open, g.rows.length]), [['Today', true, 25], ['Tomorrow', true, 5], ['Wednesday, Sep 30', false, 12]]);
  assert.equal(second.hidden, 0);
  // Show more counts only open rows, so it never offers rows a collapsed day hides.
  assert.doesNotMatch(render(items, state), /Show \d+ more/);
  assert.match(render(items, initialWorkListState()), /Show 17 more/);
});

test('opening a collapsed day shown after a full page extends the page instead of hiding the day', () => {
  // Today and Tomorrow fill exactly twenty rows; collapsed Wednesday still shows its heading after them.
  const items = [...rows('t', 8, today), ...rows('m', 12, tomorrow), ...rows('w', 6, '2026-09-30'), ...rows('f', 4, '2026-10-02')];
  const state = collapse(WEDNESDAY);
  const page = pageWorkGroups(current(items, state), opener(state));
  assert.deepEqual(page.groups.map(g => [g.label, g.open, g.rows.length]), [['Today', true, 8], ['Tomorrow', true, 12], ['Wednesday, Sep 30', false, 0]]);
  // Plain opening would put Wednesday behind Show more; the transition extends the page like Show more does.
  const opened = openWorkDayState(state, scope, 'current', current(items, state), today, WEDNESDAY, true);
  assert.equal(opened.visible.current, 40);
  const html = render(items, opened);
  assert.deepEqual(toggles(html).map(t => [t.text, t.expanded]).slice(2), [['Wednesday, Sep 30', true], ['Friday, Oct 2', true]]);
  assert.deepEqual(visibleRows(html).filter(key => key.startsWith('w')), ['w0', 'w1', 'w2', 'w3', 'w4', 'w5']);
  // Opening a day already on the page leaves the page size alone.
  const early = collapse(TOMORROW);
  assert.equal(openWorkDayState(early, scope, 'current', current(items, early), today, TOMORROW, true).visible.current, undefined);
});

test('rows arriving, leaving or changing date while a day is collapsed update its count without reopening it', () => {
  const state = collapse(TOMORROW);
  assert.equal(toggles(render([row('t1'), row('m1', tomorrow)], state))[1]!.text, 'TomorrowSep 28· 1');
  const grown = render([row('t1'), row('m1', tomorrow), row('m2', tomorrow)], state);
  assert.equal(toggles(grown)[1]!.text, 'TomorrowSep 28· 2');
  assert.deepEqual(visibleRows(grown), ['t1']);
  // A row moved to Today by a source change appears there; the collapsed day keeps its choice.
  const moved = render([row('t1'), row('m1', tomorrow), row('m2', today)], state);
  assert.deepEqual(visibleRows(moved).sort(), ['m2', 't1']);
  assert.deepEqual(toggles(moved).map(t => [t.text, t.expanded]), [['TodaySep 27', true], ['TomorrowSep 28· 1', false]]);
  // A pinned acted-on row stays in its original collapsed day for this visit.
  const pinned: WorkListState = { ...state, pins: { m1: { section: 'current', date: tomorrow } } };
  assert.equal(toggles(render([row('t1'), row('m1', today)], pinned))[1]!.text, 'TomorrowSep 28· 1');
});
