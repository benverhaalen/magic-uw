import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IDENTITY_HUES, calendarDayDistance, createAssignmentTypeHues, deadlineEmphasis, deadlineSurface } from '../packages/ui/src/deadline-emphasis';
import { localTime } from '../packages/domain/src/today-rail';

const bin = (today: string, due: string | null, completed?: boolean) => deadlineEmphasis({ today, due, completed }).bin;

test('bins by whole local calendar days, overdue distinct from today', () => {
  const today = '2026-09-27';
  assert.equal(bin(today, '2026-09-26'), 'overdue');
  assert.equal(bin(today, '2026-09-27'), 'today');
  assert.equal(bin(today, '2026-09-28'), 'tomorrow');
  assert.equal(bin(today, '2026-09-29'), 'week');
  assert.equal(bin(today, '2026-10-03'), 'week', 'six days away');
  assert.equal(bin(today, '2026-10-04'), 'later', 'seven days away');
  assert.equal(bin(today, '2026-10-27'), 'later');
  assert.deepEqual(deadlineEmphasis({ today, due: '2026-09-25' }), { bin: 'overdue', days: -2, label: 'Overdue' });
  assert.equal(calendarDayDistance('2026-12-31', '2027-01-01'), 1);
  assert.equal(calendarDayDistance('2028-02-28', '2028-03-01'), 2, 'leap day');
});

test('unknown is never distant and never completed; completion needs an explicit true', () => {
  for (const due of [null, '', 'soon', '2026-02-30', '2026-9-28', '2026-09-28T05:00:00Z'])
    assert.equal(bin('2026-09-27', due), 'unknown', String(due));
  assert.equal(deadlineEmphasis({ today: '2026-09-27', due: null }).label, 'Due date not found');
  assert.equal(bin('2026-09-27', null, undefined), 'unknown');
  assert.equal(bin('2026-09-27', null, false), 'unknown');
  assert.equal(bin('2026-09-27', '2026-09-27', 'yes' as unknown as boolean), 'today', 'truthy is not known completion');
  assert.equal(bin('2026-09-27', null, true), 'completed');
  assert.equal(bin('2026-09-27', '2026-09-20', true), 'completed', 'known completion outranks overdue');
  assert.equal(bin('not-a-date', '2026-09-27'), 'unknown', 'invalid today never guesses');
});

test('caller timezone governs through the existing localTime helper, across UTC and DST boundaries', () => {
  const day = (iso: string, zone: string) => localTime(iso, zone).date;
  const zone = 'America/Chicago';
  // 11:59 PM vs 12:01 AM local
  const now = '2026-09-27T15:00:00Z';
  assert.equal(bin(day(now, zone), day('2026-09-28T04:59:00Z', zone)), 'today', '11:59 PM CDT');
  assert.equal(bin(day(now, zone), day('2026-09-28T05:01:00Z', zone)), 'tomorrow', '12:01 AM CDT');
  // Same instants in UTC would bin differently; the recipe uses whatever zone the caller resolved.
  assert.equal(bin(day(now, 'UTC'), day('2026-09-28T04:59:00Z', 'UTC')), 'tomorrow');
  // Fall back (Nov 1 2026 has 25 hours in Chicago); spring forward (Mar 14 2027 has 23 hours).
  assert.equal(bin(day('2026-11-01T05:30:00Z', zone), day('2026-11-02T05:30:00Z', zone)), 'today', '00:30 CDT to 23:30 CST same day');
  assert.equal(bin(day('2026-10-31T17:00:00Z', zone), day('2026-11-01T23:00:00Z', zone)), 'tomorrow');
  assert.equal(bin(day('2027-03-13T18:00:00Z', zone), day('2027-03-15T04:30:00Z', zone)), 'tomorrow', '23:30 CDT after 23-hour day');
  assert.equal(calendarDayDistance(day('2027-03-13T18:00:00Z', zone), day('2027-03-20T05:00:00Z', zone)), 7);
});

type R = Parameters<typeof createAssignmentTypeHues>[0][number] & { id: string; kind: string };
const group = (sourceId: string, courseId: string, externalId: string, position: number | undefined, title: string): R =>
  ({ id: `g-${sourceId}-${courseId}-${externalId}`, kind: 'material', sourceId, courseId, externalId, title, assignmentGroup: { position } });
const work = (sourceId: string, courseId: string, assignmentGroupId: string | null, title: string): R =>
  ({ id: `a-${title}`, kind: 'assignment', sourceId, courseId, externalId: title, title, assignmentGroupId });

test('verified assignment groups get distinct hues within a course, stable across surfaces and order', () => {
  const groups = Array.from({ length: IDENTITY_HUES.length }, (_, i) => group('canvas', '310', `g${i}`, i + 1, `Group ${i}`));
  const items = groups.map(g => work('canvas', '310', g.externalId, `Item in ${g.externalId}`));
  const all = [...groups, ...items];
  const home = createAssignmentTypeHues(all), calendar = createAssignmentTypeHues([...all].reverse());
  const hues = items.map(a => home(a)!.hue);
  assert.equal(new Set(hues).size, IDENTITY_HUES.length, 'no collisions up to the palette size');
  assert.deepEqual(items.map(a => calendar(a)), items.map(a => home(a)), 'input order does not matter');
  assert.deepEqual(home(items[2]), { hue: hues[2], groupId: 'g2', groupName: 'Group 2' });
  const wheel = (h: string) => IDENTITY_HUES.indexOf(h as never);
  const step = Math.abs(wheel(hues[1]) - wheel(hues[0])), gap = Math.min(step, IDENTITY_HUES.length - step);
  assert.ok(gap >= 3, `neighbouring groups sit far apart on the wheel (${gap})`);
  // Position governs rank; externalId breaks ties; missing position ranks last.
  const tie = createAssignmentTypeHues([group('s', 'c', 'b', 1, 'B'), group('s', 'c', 'a', 1, 'A'), group('s', 'c', 'z', undefined, 'Z')]);
  const order = ['a', 'b', 'z'].map(id => tie({ sourceId: 's', courseId: 'c', assignmentGroupId: id })!.hue);
  const offset = IDENTITY_HUES.indexOf(order[0]);
  assert.deepEqual(order.map(h => (IDENTITY_HUES.indexOf(h) - offset + IDENTITY_HUES.length) % IDENTITY_HUES.length), [0, 5, 10]);
});

test('palette capacity: 13 verified groups (observed COMPSCI 639) never collide; up to five keep a hue between them', () => {
  assert.ok(IDENTITY_HUES.length >= 13);
  for (let k = 2; k <= 5; k++) {
    const gs = Array.from({ length: k }, (_, i) => group('canvas', `c${k}`, `g${i}`, i + 1, `G${i}`));
    const typed = createAssignmentTypeHues(gs);
    const at = gs.map(g => IDENTITY_HUES.indexOf(typed(work('canvas', `c${k}`, g.externalId, 'x'))!.hue)).sort((a, b) => a - b);
    const gaps = at.map((v, i) => ((at[(i + 1) % k] - v) + IDENTITY_HUES.length) % IDENTITY_HUES.length || IDENTITY_HUES.length);
    assert.ok(Math.min(...gaps) >= 2, `${k} groups: wheel gaps ${gaps}`);
  }
});

test('unverified or untyped work is neutral; titles never type anything', () => {
  const typed = createAssignmentTypeHues([group('canvas', '310', '11', 1, 'Quizzes'), { ...group('canvas', '310', '12', 2, 'Labs'), assignmentGroup: undefined }]);
  assert.ok(typed(work('canvas', '310', '11', 'Quiz 3')));
  assert.equal(typed(work('canvas', '310', null, 'Quiz 4')), null, 'no group id');
  assert.equal(typed(work('canvas', '310', '99', 'Quiz 5')), null, 'group resource not captured');
  assert.equal(typed(work('canvas', '220', '11', 'Quiz 6')), null, 'same group id in another course');
  assert.equal(typed(work('other-account', '310', '11', 'Quiz 7')), null, 'same course id in another account');
  assert.equal(typed(work('canvas', '310', '12', 'Lab 1')), null, 'no structured assignmentGroup field');
  assert.deepEqual(deadlineSurface('today', null), { 'data-magic-deadline': 'today', 'data-magic-hue': 'neutral' });
});

test('source aliases of one account share hues; accounts and unknown sources stay isolated', () => {
  const sources = [{ id: 'canvas-a', accountScope: 'uw:student-1' }, { id: 'canvas-a2', accountScope: 'uw:student-1' },
    { id: 'canvas-b', accountScope: 'uw:student-2' }, { id: 'canvas-x', accountScope: null }];
  // Account 1: groups captured under two aliases; alias 2 is partial, duplicates one group, reports a stale position.
  const resources = [
    group('canvas-a', '310', '11', 1, 'Labs'), group('canvas-a', '310', '12', 2, 'Quizzes'), group('canvas-a', '310', '13', 3, 'Exams'),
    group('canvas-a2', '310', '13', 3, 'Exams'), group('canvas-a2', '310', '12', 5, 'Quizzes'),
    // Account 2 has the same course and group ids but different groups.
    group('canvas-b', '310', '12', 1, 'Problem sets'), group('canvas-b', '310', '99', 2, 'Projects'),
  ];
  const home = createAssignmentTypeHues(resources, sources);
  const calendar = createAssignmentTypeHues([...resources].reverse(), (id: string) => sources.find(s => s.id === id)?.accountScope);
  const viaA = home(work('canvas-a', '310', '12', 'Quiz 3')), viaA2 = calendar(work('canvas-a2', '310', '12', 'Quiz 3'));
  assert.ok(viaA);
  assert.deepEqual(viaA2, viaA, 'same assignment through an alias capture, list or resolver: same hue');
  assert.deepEqual(home(work('canvas-a2', '310', '11', 'Lab 4')), home(work('canvas-a', '310', '11', 'Lab 4')), 'group only captured by the other alias still resolves');
  // Duplicates and their stale positions do not shift rank relative to a single clean capture.
  const clean = createAssignmentTypeHues(resources.filter(r => r.sourceId === 'canvas-a'), sources);
  for (const g of ['11', '12', '13']) assert.deepEqual(home(work('canvas-a', '310', g, 'x')), clean(work('canvas-a', '310', g, 'x')));
  // Account 2 is ranked on its own groups only.
  const b = home(work('canvas-b', '310', '12', 'PS 1'))!;
  assert.equal(b.groupName, 'Problem sets');
  assert.deepEqual(b, createAssignmentTypeHues(resources.filter(r => r.sourceId === 'canvas-b'), sources)(work('canvas-b', '310', '12', 'PS 1')));
  assert.equal(home(work('canvas-b', '310', '11', 'Lab 4')), null, 'account 2 cannot reach account 1 groups');
  // Unknown account (null or absent from the list) is keyed by its own source and cannot join.
  assert.equal(home(work('canvas-x', '310', '12', 'Quiz 3')), null);
  assert.equal(home(work('canvas-new', '310', '12', 'Quiz 3')), null);
  const unknownOwn = createAssignmentTypeHues([...resources, group('canvas-x', '310', '12', 1, 'Quizzes')], sources);
  assert.ok(unknownOwn(work('canvas-x', '310', '12', 'Quiz 3')), 'its own verified group still works');
  assert.equal(unknownOwn(work('canvas-a', '310', '12', 'Quiz 3'))?.groupName, 'Quizzes');
  assert.deepEqual(unknownOwn(work('canvas-a', '310', '12', 'Quiz 3')), viaA, 'unknown source groups never change a known account');
  // Without any account data, v2 behaviour: each source is its own scope.
  assert.equal(createAssignmentTypeHues(resources)(work('canvas-a2', '310', '11', 'Lab 4')), null);
});

test('different courses start at different hues', () => {
  const first = ['101', '120', '205', '210', '220', '310'].map(c => createAssignmentTypeHues([group('canvas', c, 'g', 1, 'G')])({ sourceId: 'canvas', courseId: c, assignmentGroupId: 'g' })!.hue);
  assert.ok(new Set(first).size >= 4, first.join());
});

// Contrast from the shipped values: ink never fades, so the strongest fill is the worst case.
const tokens = readFileSync(new URL('../docs/design/tokens.css', import.meta.url), 'utf8');
const recipe = readFileSync(new URL('../packages/ui/src/deadline-emphasis.css', import.meta.url), 'utf8');
const token = (name: string) => new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(tokens)![1];
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('every hue, including neutral, keeps its paired ink at least 4.5:1 on its strongest fill', () => {
  for (const hue of [...IDENTITY_HUES, 'neutral']) {
    const rule = new RegExp(`\\[data-magic-hue=${hue}\\] \\{ --magic-deadline-strong: var\\(--magic-hue-${hue}-strong, (#[0-9a-f]{6})\\); --magic-deadline-pale: var\\(--magic-hue-${hue}-pale, (#[0-9a-f]{6})\\); --magic-deadline-ink: var\\(--magic-hue-${hue}-ink, (#[0-9a-f]{6})\\); \\}`).exec(recipe);
    assert.ok(rule, `${hue} reads the palette role seam`);
    const [, strong, pale, ink] = rule!;
    for (const fill of [strong, pale, token('magic-surface-quiet')]) {
      const ratio = contrast(ink, fill);
      assert.ok(ratio >= 4.5, `${hue} ink ${ink} on ${fill}: ${ratio.toFixed(2)}`);
    }
  }
  assert.doesNotMatch(recipe, /opacity/, 'emphasis never fades text');
});
