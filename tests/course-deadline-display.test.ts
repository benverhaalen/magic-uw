import test from 'node:test';
import assert from 'node:assert/strict';
import type { ResourceView, SourceHealth } from '@magic/contracts';
import { resolveDeadline } from '@magic/domain';
import { buildCourseCards, buildCoursePage, courseDeadlineDisplay, whenDue } from '../packages/domain/src/course-page';
import { courseWork } from '../apps/desktop/src/renderer/courses/course-view';
import { canonicalHomeResources } from '../apps/desktop/src/renderer/home/projection';
import { calendarItems } from '../apps/desktop/src/renderer/calendar/model';

const now = '2026-09-27T12:00:00Z';
const first = '2026-10-01T17:00:00.000Z';
const second = '2026-10-02T17:00:00.000Z';
const sources = [
  { id: 'direct', accountScope: 'a', courseId: 'c', scope: 'assignments' },
  { id: 'copy', accountScope: 'a', courseId: 'c', scope: 'account-todo' },
  { id: 'other', accountScope: 'b', courseId: 'c', scope: 'assignments' },
].map(s => ({ kind: 'canvas', label: s.id, status: 'ok', complete: true, lastSuccessAt: now, lastAttemptAt: now, resourceCount: 1, ...s })) as SourceHealth[];
const deadline = (...values: string[]) => resolveDeadline(values.map(value => ({ kind: 'due', value, quote: 'due_at', authority: 'structured', scopeConfirmed: true })));
function resource(id: string, patch: Partial<ResourceView> = {}): ResourceView {
  return { id, externalId: id, sourceId: 'direct', kind: 'assignment', courseId: 'c', courseName: 'Course', title: `Task ${id}`, url: `https://canvas.example/courses/c/assignments/${id}`, text: '', contentHash: `hash-${id}`, version: 1, observedAt: now, capturedAt: now, deleted: false, completed: false, submitted: false, points: null, policy: { mode: 'unknown', evidence: '' }, deadlines: [], deadline: deadline(first), kindLabel: null, ...patch };
}

test('one disputed object stays disputed in course summary, Next up, Home and Calendar without losing evidence or ordering', () => {
  const disputed = resource('1', { deadline: deadline(first, second) });
  const later = resource('2', { deadline: deadline('2026-10-03T17:00:00.000Z') });
  const input = { resources: [later, disputed], sources, now };
  const before = JSON.stringify(disputed);
  const card = buildCourseCards(input)[0]!;
  const entry = courseWork(buildCoursePage(input, 'a:c')!).next[0]!.entry;
  assert.equal(card.next!.id, disputed.id);
  assert.equal(entry.resource.id, disputed.id);
  assert.deepEqual(card.nextDeadline, courseDeadlineDisplay(entry.resource, entry.copies));
  assert.equal(card.nextDeadline!.cue, 'Dates disagree');
  assert.equal(card.nextDeadline!.displayAt, null);
  assert.equal(card.nextDeadline!.sortAt, whenDue(disputed));
  const home = canonicalHomeResources([disputed], sources)[0]!;
  assert.equal(home.deadline.conflict, true);
  const calendar = calendarItems([{ ...disputed, accountScope: 'a', sourceScope: 'assignments' }], [], first.slice(0, 10), 'UTC')[0]!;
  assert.equal(calendar.resourceId, disputed.id);
  assert.equal(calendar.conflict, true);
  assert.match(calendar.detail, /^Dates disagree/);
  assert.equal(JSON.stringify(disputed), before);
  assert.equal(disputed.deadline.claims.length, 2);
});

test('a conflict carried only by another same-object copy survives the primary selection and course card', () => {
  const main = resource('1');
  const copy = resource('alias', { sourceId: 'copy', externalId: '1', url: main.url, submitted: null, deadline: deadline(first, second) });
  const input = { resources: [main, copy], sources, now };
  const entry = courseWork(buildCoursePage(input, 'a:c')!).next[0]!.entry;
  assert.equal(entry.resource.id, main.id);
  assert.equal(entry.copies.length, 2);
  assert.equal(courseDeadlineDisplay(entry.resource, entry.copies).cue, 'Dates disagree');
  assert.equal(buildCourseCards(input)[0]!.nextDeadline!.cue, 'Dates disagree');
});

test('same IDs in another account or different IDs with the same title do not transfer conflict', () => {
  const main = resource('1');
  const other = resource('other-1', { sourceId: 'other', externalId: '1', title: main.title, deadline: deadline(first, second) });
  const similar = resource('2', { title: main.title, deadline: deadline(second, '2026-10-03T17:00:00.000Z') });
  const input = { resources: [main, other, similar], sources, now };
  const cards = buildCourseCards(input);
  assert.equal(cards.find(c => c.key === 'a:c')!.nextDeadline!.conflict, false);
  assert.equal(cards.find(c => c.key === 'b:c')!.nextDeadline!.conflict, true);
  assert.equal(courseWork(buildCoursePage(input, 'a:c')!).next[0]!.entry.copies.length, 1);
});

test('confirmed dates retain display, equivalent instants and missing copies do not invent disagreement', () => {
  const main = resource('1');
  const alias = resource('alias', { deadline: { ...deadline(first), dueAt: '2026-10-01T12:00:00-05:00' } });
  assert.equal(courseDeadlineDisplay(main, [alias]).displayAt, first);
  const missing = resource('missing', { deadline: deadline() });
  assert.equal(courseDeadlineDisplay(main, [missing]).conflict, false);
  assert.equal(courseDeadlineDisplay(missing).displayAt, null);
});
