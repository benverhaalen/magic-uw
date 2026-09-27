import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ResourceView, Snapshot, SourceHealth } from '@magic/contracts';
import { resolveDeadline } from '@magic/domain';
import { projectDailyBrief, type BriefInput } from '../apps/desktop/src/renderer/home/brief';
import { courseIdentityHues } from '../apps/desktop/src/renderer/courses/course-index-view';

Object.assign(globalThis, { React });
registerHooks({ load: (url, context, next) => url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context) });
const { DailyBrief, arrowTail, briefCourseHues } = await import('../apps/desktop/src/renderer/home/DailyBrief');

const now = '2026-09-27T18:00:00Z', tz = 'America/Chicago';
const ok = (id: string, accountScope: string): SourceHealth => ({ id, label: id, kind: 'canvas', accountScope, courseId: 'c', scope: id, status: 'ok', lastAttemptAt: now, lastSuccessAt: now, complete: true, resourceCount: 1 });
const due = (value: string) => resolveDeadline([{ kind: 'due', value, quote: 'due_at', authority: 'structured', scopeConfirmed: true }]);
function resource(id: string, patch: Partial<ResourceView> = {}): ResourceView {
  return { id, externalId: id, sourceId: 's1', kind: 'assignment', courseId: 'c1', courseName: 'Course', title: `Task ${id}`, url: `https://canvas.example/courses/c/assignments/${id}`, text: '', contentHash: `hash-${id}`, version: 1, observedAt: now, capturedAt: now, deleted: false, completed: false, submitted: false, points: null, policy: { mode: 'unknown', evidence: '' }, deadlines: [], deadline: due('2026-09-28T18:00:00Z'), kindLabel: null, ...patch } as ResourceView;
}
const sources = [ok('s1', 'acct'), ok('s2', 'acct'), ok('s3', 'other')];
const admission = { selectedTerm: null, resourceIds: [], aliases: [], courses: [
  { accountScope: 'acct', courseId: 'c1', sourceIds: ['s1'], termId: null, termName: null, courseLabel: 'BIOCHEM 104' },
  { accountScope: 'acct', courseId: 'c2', sourceIds: ['s2'], termId: null, termName: null, courseLabel: 'COMPSCI 574' },
  { accountScope: 'other', courseId: 'c1', sourceIds: ['s3'], termId: null, termName: null, courseLabel: 'LIS 462' },
] };

test('arrow keeps the last word; a long final token keeps one character so the rest can wrap', () => {
  assert.deepEqual(arrowTail('Genetic geneaology and genetic testing '), ['Genetic geneaology and genetic ', 'testing']);
  assert.deepEqual(arrowTail('P1 (MySQL)'), ['P1 ', '(MySQL)']);
  assert.deepEqual(arrowTail('Syllabus'), ['', 'Syllabus']);
  assert.deepEqual(arrowTail('See https://kb.wisc.edu/registrar/18785'), ['See https://kb.wisc.edu/registrar/1878', '5']);
  assert.deepEqual(arrowTail('Notes 📘'), ['Notes ', '📘']);
  assert.deepEqual(arrowTail('x'.repeat(30) + '📘'), ['x'.repeat(30), '📘'], 'never splits a surrogate pair');
  assert.deepEqual(arrowTail(''), ['', '']);
});

test('course hue is the Courses work list hue: same admitted key set, stable key, neutral outside it', () => {
  const snapshot = { courseWorkAdmission: admission, sources } as unknown as Snapshot;
  const hueOf = briefCourseHues(snapshot, []);
  // CoursesWorkView: courseIdentityHues(scope.courses.map(c => `${accountScope}:${courseId}`)), looked up by the row's source account.
  const courses = courseIdentityHues(admission.courses.map(c => `${c.accountScope}:${c.courseId}`));
  assert.equal(hueOf({ sourceId: 's1', courseId: 'c1' }), courses.get('acct:c1'));
  assert.equal(hueOf({ sourceId: 's2', courseId: 'c2' }), courses.get('acct:c2'));
  assert.equal(hueOf({ sourceId: 's3', courseId: 'c1' }), courses.get('other:c1'), 'same course id in another account is its own course');
  assert.notEqual(hueOf({ sourceId: 's3', courseId: 'c1' }), hueOf({ sourceId: 's1', courseId: 'c1' }));
  assert.equal(new Set(admission.courses.map(c => courses.get(`${c.accountScope}:${c.courseId}`))).size, 3, 'distinct hues per course');
  assert.equal(hueOf({ sourceId: 's1', courseId: 'not-admitted' }), 'neutral');
  // Renaming a course or reordering the admission never moves its hue.
  const renamed = { courseWorkAdmission: { ...admission, courses: [...admission.courses].reverse().map(c => ({ ...c, courseLabel: `${c.courseLabel} renamed` })) }, sources } as unknown as Snapshot;
  assert.equal(briefCourseHues(renamed, [])({ sourceId: 's2', courseId: 'c2' }), hueOf({ sourceId: 's2', courseId: 'c2' }));
  // Without an admission, every captured course (the Courses index key set) is hashed.
  const fallback = briefCourseHues({ sources } as unknown as Snapshot, [resource('a'), resource('b', { sourceId: 's2', courseId: 'c2' })]);
  assert.equal(fallback({ sourceId: 's1', courseId: 'c1' }), courseIdentityHues(['acct:c1', 'acct:c2']).get('acct:c1'));
});

const format = { course: (r: ResourceView) => r.courseId === 'c1' ? 'BIOCHEM 104' : 'COMPSCI 574', nameOf: (r: ResourceView) => ({ label: r.title, raw: r.title, removed: [], rule: 'none' }) as never, day: () => 'Mon, Sep 28', time: () => '1:00 PM', whenInline: () => 'tomorrow' };
function input(patch: Partial<BriefInput>): BriefInput {
  return { resources: [], sources, links: [], timeZone: tz, activeWork: [], earlier: [], passages: [], prerequisites: [], conflict: null, launchable: new Set(), canOpenSource: false, ...patch };
}

test('rendered brief: hued course pill with unchanged text, source link named by its title with an aria-hidden arrow', () => {
  const title = 'pre-Class 6 Assignment: Genetic geneaology and genetic testing ';
  const reading = resource('m', { kind: 'material', title: 'Week 5 slides', text: 'Slides', deadline: resolveDeadline([]) });
  const work = resource('w', { title, text: 'For Part 2, you can use the Week 5 slides.', links: [reading.url] });
  const snapshot = { courseWorkAdmission: admission, sources, links: [], resources: [work, reading], personalReports: [] } as unknown as Snapshot;
  const brief = projectDailyBrief(input({ resources: [work, reading], links: [{ id: 'l', fromId: reading.id, toId: work.id, type: 'specifies', reason: 'linked', status: 'accepted', inputHash: reading.contentHash }], activeWork: [work] }));
  const html = renderToStaticMarkup(createElement(DailyBrief, { brief, conflict: null, onReviewDate() {}, snapshot, resources: [work, reading], timeZone: tz, format, prepared: { refreshKey: 'k' } as never, onSelect() {}, onSources() {}, onPastDue() {} }));
  const hue = courseIdentityHues(admission.courses.map(c => `${c.accountScope}:${c.courseId}`)).get('acct:c1');
  assert.match(html, new RegExp(`<p><span class="briefing-course briefing-course--lead" data-magic-hue="${hue}">BIOCHEM 104</span> `), 'paragraph-leading pill');
  // Route, version and resource id are the shared EvidenceLink's; the only text is the title.
  const anchor = /<a class="magic-ui-link" href="#resource\/w" data-resource-id="w" data-source-version="hash-w">([\s\S]*?)<\/a>/.exec(html);
  assert.ok(anchor, 'shared evidence link kept');
  assert.equal(anchor![1]!.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ''), title.trimEnd());
  assert.match(anchor![1]!, /<span class="briefing-link-tail">testing<svg[^>]*class="briefing-link-arrow"[^>]*aria-hidden="true"[^>]*focusable="false"/);
  const slides = /href="#resource\/m"[^>]*>([\s\S]*?)<\/a>/.exec(html);
  assert.match(slides![1]!, /^Week 5 <span class="briefing-link-tail">slides<svg/);
  assert.equal((html.match(/briefing-link-arrow/g) ?? []).length, 2, 'one arrow per source link; time tags and actions get none');
  assert.doesNotMatch(html, /magic-inline-time[^"]*"[^>]*>[^<]*<svg[^>]*briefing-link-arrow/);
});

const css = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const brief = css('../apps/desktop/src/renderer/home/brief.css');
const home = css('../apps/desktop/src/renderer/home/Home.css');

test('brief link and pill styles: no underline in any state, visible focus, no-orphan tail, prose line not enlarged', () => {
  assert.match(brief, /\.home-briefing a\.magic-ui-link \{ text-decoration: none;/);
  assert.doesNotMatch(brief, /text-decoration(-line)?:\s*underline/);
  assert.match(brief, /\.home-briefing a\.magic-ui-link:focus-visible \{ outline: 2px solid var\(--magic-focus\);/);
  assert.match(brief, /\.home-briefing \.briefing-link-tail \{ white-space: nowrap; \}/);
  const pill = /\.home-briefing \.briefing-course \{([\s\S]*?)\}/.exec(brief)![1]!;
  assert.match(pill, /font: inherit;/, 'pill keeps prose type');
  assert.match(pill, /line-height: 1\.3;[\s\S]*padding: 0\.14em/, '1.3em + 0.28em stays under the 1.72 prose leading');
  assert.match(pill, /var\(--magic-deadline-ink\)[\s\S]*var\(--magic-deadline-strong\)[\s\S]*var\(--magic-deadline-pale\)/, 'shared hue roles, no literal colors');
  assert.doesNotMatch(pill, /#[0-9a-f]{3,6}/i);
});

test('section rhythm centers every gray rule; Today rail rules are unchanged from base', () => {
  const v = (name: string) => Number(new RegExp(`--${name}:(\\d+)px`).exec(home)![1]);
  const rule = v('home-rule-space'), row = v('brief-row-gap');
  assert.ok(rule > 17 && row > 24, 'more air than the 53ecbe3 15-17px rules and 24px rows');
  assert.match(home, /\.home-reading \.home-upcoming \{ margin-top:calc\(2 \* var\(--home-rule-space\) - var\(--brief-row-gap\)\); \}/);
  assert.match(home, /:is\(\.home-upcoming,\.home-study,\.home-enrollment-holds\)::before \{ top:calc\(-1 \* var\(--home-rule-space\)\); \}/);
  // Above the Brief/Upcoming rule: last row gap + Upcoming margin - rule offset; below it: the rule offset.
  assert.equal(row + (2 * rule - row) - rule, rule);
  // Today keeps its full-height column with the schedule anchored to the bottom (53ecbe3 rules).
  assert.ok(home.includes('.home-today { display:flex; flex-direction:column; height:calc(100vh - 125px); }'));
  assert.ok(home.includes('.home-today .rail-heading--schedule { margin-top:auto; }'));
  assert.doesNotMatch(home.split('Section rhythm')[1]!.split('@media')[0]!, /home-today \./, 'the rhythm block does not touch Today');
});
