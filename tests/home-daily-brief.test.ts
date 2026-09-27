import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CourseWorkSchedule, Link, PlanningSnapshot, ResourceView, Snapshot, SourceHealth } from '@magic/contracts';
import { resolveDeadline } from '@magic/domain';
import { briefExcerpt, currentEnrollmentBrief, actionStatus, BRIEF_LIMIT, briefCoverage, calendarLabel, coverageNote, fallbackText, linkedMaterials, projectDailyBrief, projectParts, statedRelation, type BriefInput } from '../apps/desktop/src/renderer/home/brief';
import type { HomePassage } from '../apps/desktop/src/renderer/home/projection';
import { canonicalHomeResources, selectHomeEvidence } from '../apps/desktop/src/renderer/home/projection';
import { calendarItemLabel, calendarItems, startOfDate } from '../apps/desktop/src/renderer/calendar/model';
import { SHOW_DATE_CONFLICT_UI } from '../apps/desktop/src/renderer/date-conflict-policy';

Object.assign(globalThis, { React });
registerHooks({ load: (url, context, next) => url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context) });
const { DailyBrief } = await import('../apps/desktop/src/renderer/home/DailyBrief');
const { Home } = await import('../apps/desktop/src/renderer/Home');

const now = '2026-09-27T18:00:00Z', tz = 'America/Chicago';
const ok = (id: string, patch: Partial<SourceHealth> = {}): SourceHealth => ({ id, label: id, kind: 'canvas', accountScope: 'a', courseId: 'c', scope: id, status: 'ok', lastAttemptAt: now, lastSuccessAt: now, complete: true, resourceCount: 1, ...patch });
const sources = [ok('canonical'), ok('other', { accountScope: 'b' })];
const due = (value: string) => resolveDeadline([{ kind: 'due', value, quote: 'due_at', authority: 'structured', scopeConfirmed: true }]);
function resource(id: string, patch: Partial<ResourceView> = {}): ResourceView {
  return { id, externalId: id, sourceId: 'canonical', kind: 'assignment', courseId: 'c', courseName: 'Course', title: `Task ${id}`, url: `https://canvas.example/courses/c/assignments/${id}`, text: '', contentHash: `hash-${id}`, version: 1, observedAt: now, capturedAt: now, deleted: false, completed: false, submitted: false, points: null, policy: { mode: 'unknown', evidence: '' }, deadlines: [], deadline: due('2026-09-28T18:00:00Z'), kindLabel: null, ...patch } as ResourceView;
}
const material = (id: string, patch: Partial<ResourceView> = {}) => resource(id, { kind: 'material', title: `Reading ${id}`, url: `https://canvas.example/courses/c/files/${id}`, text: 'Chapter text', deadline: resolveDeadline([]), ...patch });
const link = (from: ResourceView, to: ResourceView, patch: Partial<Link> = {}): Link => ({ id: `${from.id}->${to.id}`, fromId: from.id, toId: to.id, type: 'specifies', reason: 'linked in instructions', status: 'accepted', inputHash: from.contentHash, ...patch });
const passage = (r: ResourceView, reason: HomePassage['reason'], text = 'Bring your laptop to lab.'): HomePassage => ({ resource: r, reason, span: { resourceId: r.id, contentHash: r.contentHash, version: r.version, field: 'text', start: 0, end: text.length, text } });
function input(patch: Partial<BriefInput>): BriefInput {
  return { resources: [], sources, links: [], timeZone: tz, activeWork: [], earlier: [], passages: [], prerequisites: [], conflict: null, launchable: new Set(), canOpenSource: false, ...patch };
}
function enrolledClass(day: string, observedAt: string, classKind: 'lecture' | 'class' = 'class') {
  const weekday = (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7 + 1;
  const meeting = { kind: 'class' as const, mode: 'scheduled' as const, days: [weekday], startMinute: 600, endMinute: 660,
    startDate: day, endDate: day, timezone: 'America/Chicago' as const, location: null };
  const schedule: CourseWorkSchedule = { key: 'synthetic-class', accountScope: 'a', courseId: 'c', resourceId: 'course',
    planningRecordId: 'enrolled', planningSourceId: 'planning-source', classKind, meetings: [meeting], complete: true };
  const scope = { kind: 'enrollment_term', key: '1272' };
  const sourceUrl = 'https://example.edu/enrollment';
  const planning = { records: [{ kind: 'enrollment_package', id: 'enrolled', localId: 'enrolled', sourceId: 'planning-source', accountScope: 'school',
    contentHash: 'enrolled-hash', version: 1, courseKey: 'uw:1:400', termCode: '1272', sections: ['LEC 001'], status: 'open',
    enrollmentState: 'enrolled', deleted: false, provenance: { observedAt, scope, sourceUrl }, meetings: [meeting], meetingsComplete: true,
    seatsAvailable: null, capacity: null, waitlistCount: null, instructorNames: [] }],
    sources: [{ id: 'planning-source', source: 'uw_enroll', accountScope: 'school', status: 'complete', completeness: 'complete',
      observedAt, lastSuccessAt: observedAt, scope, sourceUrl, diagnostics: [] }] } as unknown as PlanningSnapshot;
  return { schedules: [schedule], planning };
}

test('the brief connects an assignment to materials only through what its instructions state, with one routed action', () => {
  const a = material('a'), b = material('b');
  const work = resource('w', { text: 'Read Reading a and Reading b before section.', links: [a.url, { url: b.url, text: 'Reading b' }] });
  const single = projectDailyBrief(input({ resources: [work, a], links: [link(a, work)], activeWork: [work] }));
  const item = single.items[0]!;
  assert.equal(item.kind, 'linked-materials');
  assert.equal(item.action!.kind, 'open-material');
  assert.equal(item.action!.targetId, 'a', 'one material opens that material directly');
  assert.deepEqual(item.kind === 'linked-materials' && { verb: item.relation.verb, modality: item.relation.modality }, { verb: 'read', modality: 'instruction' });
  assert.deepEqual([...single.surfacedMaterialIds], ['a']);
  assert.equal(single.fallback, null);
  const both = projectDailyBrief(input({ resources: [work, a, b], links: [link(a, work), link(b, work)], activeWork: [work] }));
  assert.equal(both.items[0]!.action!.kind, 'open-assignment');
  assert.equal(both.items[0]!.action!.targetId, 'w', 'several materials open the assignment, whose full context lists them');
  assert.equal(both.items[0]!.action!.focusKey, 'brief-materials-w');
});

test('only accepted, exact-version, same-scope links that the instructions actually contain qualify', () => {
  const work = resource('w', { links: ['https://canvas.example/courses/c/files/m'] });
  const m = material('m');
  const elsewhere = material('m', { sourceId: 'other' });
  const unlinked = material('u');
  const navigation = material('n', { title: 'Syllabus' });
  const cases: Array<[ResourceView, Link]> = [
    [m, link(m, work, { status: 'proposed' })],
    [m, link(m, work, { type: 'supports' })],
    [m, link(m, work, { inputHash: 'old-hash' })],
    [elsewhere, link(elsewhere, work)],
    [unlinked, link(unlinked, work)],
    [navigation, link(navigation, work)],
  ];
  for (const [candidate, l] of cases) assert.deepEqual(linkedMaterials(work, [work, candidate], [l], sources), [], `${l.status}/${l.type}/${l.inputHash}/${candidate.sourceId}/${candidate.title}`);
  assert.equal(linkedMaterials(work, [work, m], [link(m, work)], sources).length, 1);
});

test('same-source relationship: the stated verb and modality from the exact sentence, never a stronger claim', () => {
  const m = material('m', { title: 'Interactive Map' });
  const at = (text: string, pointer?: string) => statedRelation(resource('w', { text, links: [pointer ? { url: m.url, text: pointer } : m.url] }), m);
  const optional = at('Part 1 covers regions.\nYou can use this Interactive Map or an atlas for the questions. Submit by Friday.')!;
  assert.deepEqual({ verb: optional.verb, modality: optional.modality }, { verb: 'use', modality: 'optional' });
  assert.equal(optional.evidence.text, 'You can use this Interactive Map or an atlas for the questions.');
  assert.equal(optional.evidence.resourceId, 'w'); assert.equal(optional.evidence.contentHash, 'hash-w');
  assert.equal(at('Part 1 covers regions.\nYou can use this Interactive Map or an atlas for the questions.')!.evidence.start, 'Part 1 covers regions.\n'.length);
  assert.equal(at('You must read the Interactive Map legend first.')!.modality, 'required');
  assert.equal(at('Students should review the Interactive Map.')!.modality, 'expected');
  assert.equal(at('Please watch the lecture video before class.', 'lecture video')!.verb, 'watch', 'anchor text of the saved pointer locates the mention');
  // A bare listing, descriptive mention, negation or unrelated modal states no relationship.
  assert.equal(at('Resources: Interactive Map, atlas, notes.'), null);
  assert.equal(at('Last year students used the Interactive Map.'), null);
  assert.equal(at('Do not use the Interactive Map for Part 2.'), null);
  assert.equal(at('Students who may have missed class read the Interactive Map.'), null);
  assert.equal(at('Answer the questions below.'), null, 'no mention of the material');
  assert.equal(at(''), null);
});

test('a linked material the instructions only list defers to the ordinary passages', () => {
  const m = material('m', { title: 'Week 5 slides' });
  const work = resource('w', { text: 'Materials: Week 5 slides.', links: [m.url] });
  const brief = projectDailyBrief(input({ resources: [work, m], links: [link(m, work)], activeWork: [work], passages: [passage(work, 'instruction')] }));
  assert.deepEqual(brief.items.map(i => i.kind), ['passage']);
  assert.equal(brief.surfacedMaterialIds.size, 0, 'Study keeps offering it');
});

test('a link-only material and a failed source are stated, not hidden or overstated', () => {
  const bare = material('bare', { text: '' });
  const work = resource('w', { text: 'Read Reading bare first.', links: [bare.url] });
  const linkOnly = projectDailyBrief(input({ resources: [work, bare], links: [link(bare, work)], activeWork: [work] }));
  assert.deepEqual(linkOnly.items[0]!.action!.status, { state: 'link-only', note: 'Only the link was saved.' });
  const signedOut = [ok('canonical', { status: 'needs_sign_in', complete: false })];
  const stale = projectDailyBrief(input({ resources: [work, material('a')], sources: signedOut, links: [], activeWork: [work], passages: [passage(work, 'changed-date')] }));
  assert.deepEqual(stale.items[0]!.action?.status, { state: 'saved-copy', note: 'Saved copy. Sign in to refresh.' });
});

test('a missing source or target is unknown, never current', () => {
  assert.equal(actionStatus(resource('x', { sourceId: 'gone' }), sources).state, 'unknown');
  assert.equal(actionStatus(undefined, sources).state, 'unknown');
  assert.equal(actionStatus(resource('x'), []).state, 'unknown');
  assert.equal(actionStatus(resource('x'), sources).state, 'current');
  const orphan = resource('orphan', { sourceId: 'gone', kind: 'message' });
  const brief = projectDailyBrief(input({ resources: [orphan], passages: [passage(orphan, 'changed-date')] }));
  assert.equal(brief.items[0]!.action?.status.state, 'unknown');
});

test('mixed, empty and partial source states each produce a truthful brief', () => {
  const r = resource('msg', { kind: 'message' });
  const base = { resources: [r], passages: [passage(r, 'changed-date')] };
  const mixed = [ok('canonical'), ok('b', { status: 'needs_sign_in', complete: false }), ok('c', { status: 'partial', complete: false }), ok('fx', { kind: 'fixture', status: 'error' })];
  const withMixed = projectDailyBrief(input({ ...base, sources: mixed }));
  assert.deepEqual(withMixed.coverage, { state: 'partial', total: 3, unchecked: 2, needsSignIn: true }, 'fixtures never count');
  assert.equal(withMixed.items[0]!.action?.status.state, 'current', 'the target\'s own source was checked');
  assert.match(coverageNote(withMixed.coverage)!, /^2 of 3 saved sources were not fully checked.*Sign in from Saved sources to refresh\.$/);
  const empty = projectDailyBrief(input({ sources: [] }));
  assert.deepEqual([empty.items.length, empty.coverage.state, empty.fallback?.text], [0, 'none', 'No course sources have been checked yet, so there is nothing to brief from.']);
  assert.match(coverageNote(empty.coverage)!, /^No source checks are saved/);
  const unknownLate = projectDailyBrief(input({ resources: [r], sources: [], earlier: [resource('late', { deadline: due('2026-09-20T18:00:00Z') })] }));
  assert.equal(unknownLate.items.at(-1)!.action!.status.state, 'unknown', 'no source checks: submission status is unknown, not partial');
  const partialTarget = projectDailyBrief(input({ ...base, sources: [ok('canonical', { status: 'partial', complete: false })] }));
  assert.deepEqual(partialTarget.items[0]!.action?.status, { state: 'saved-copy', note: 'Saved copy. Last check was incomplete.' });
  assert.equal(projectDailyBrief(input(base)).coverage.state, 'complete');
});

test('a changed date outranks the relationship on the same assignment; a stated relationship replaces the instruction quote', () => {
  const m = material('m'); const work = resource('w', { text: 'Read Reading m before lab.', links: [m.url] });
  const base = { resources: [work, m], links: [link(m, work)], activeWork: [work] };
  const changed = projectDailyBrief(input({ ...base, passages: [passage(work, 'changed-date')] }));
  assert.deepEqual(changed.items.map(i => i.kind), ['passage']);
  assert.equal(changed.items[0]!.action?.kind, 'review-change');
  const quoted = projectDailyBrief(input({ ...base, passages: [passage(work, 'instruction')] }));
  assert.deepEqual(quoted.items.map(i => i.kind), ['linked-materials']);
});

test('instruction passages launch only work that Upcoming is not already launching', () => {
  const shown = resource('shown'), hidden = resource('hidden'), note = resource('note', { kind: 'message' });
  const brief = projectDailyBrief(input({ resources: [shown, hidden, note], activeWork: [shown, hidden], launchable: new Set(['shown']), passages: [passage(shown, 'instruction'), passage(hidden, 'instruction'), passage(note, 'information')] }));
  assert.deepEqual(brief.items.map(i => i.kind === 'passage' ? i.action?.kind ?? null : i.kind), [null, 'start-work', null]);
});

test('past-due work stays reachable in one line without taking brief slots, Today or Upcoming', () => {
  const late = ['1', '2', '3', '4'].map(id => resource(`late-${id}`, { deadline: due('2026-09-20T18:00:00Z') }));
  const messages = ['a', 'b', 'c', 'd'].map(id => resource(id, { kind: 'message' }));
  const brief = projectDailyBrief(input({ resources: [...late, ...messages], earlier: late, passages: messages.map(m => passage(m, 'information', `Note ${m.id} about lab.`)) }));
  assert.equal(brief.items.filter(i => i.kind !== 'past-due').length, BRIEF_LIMIT);
  const last = brief.items.at(-1)!;
  assert.equal(last.kind, 'past-due'); assert.equal(last.kind === 'past-due' && last.count, 4);
  assert.equal(last.action.focusKey, 'brief-past-due');
  const onlyLate = projectDailyBrief(input({ resources: late, earlier: late, sources: [ok('canonical', { complete: false, status: 'partial' })] }));
  assert.ok(onlyLate.fallback, 'a past-due count alone is not a brief; the coverage fallback still explains the rest');
  assert.deepEqual(onlyLate.items[0]!.action!.status, { state: 'saved-copy', note: 'Submission status may be incomplete because some sources were not fully checked.' });
});

test('empty copy distinguishes no sources, partial coverage and a complete saved check, and never claims a free day', () => {
  assert.equal(briefCoverage([]).state, 'none');
  assert.equal(briefCoverage([ok('x', { kind: 'fixture' })]).state, 'none');
  const partial = briefCoverage([ok('a'), ok('b', { status: 'needs_sign_in', complete: false })]);
  assert.deepEqual(partial, { state: 'partial', total: 2, unchecked: 1, needsSignIn: true });
  const texts = [fallbackText(briefCoverage([])), fallbackText(partial), fallbackText(briefCoverage([ok('a')]))];
  assert.match(texts[0]!, /No course sources have been checked/);
  assert.match(texts[1]!, /1 source was not fully checked\. Some coursework may be missing here\. Sign in to refresh\./);
  assert.match(texts[2]!, /Deadlines stay in Today and Upcoming/);
  for (const text of texts) { assert.doesNotMatch(text, /nothing (is )?due|free|all clear|caught up|—/i); }
});

test('action focus keys come from source identity, so reworded passages keep Back focus', () => {
  const r = resource('msg', { kind: 'message' });
  const first = projectDailyBrief(input({ resources: [r], passages: [passage(r, 'changed-date', 'Moved to Friday.')] }));
  const second = projectDailyBrief(input({ resources: [r], passages: [passage(r, 'changed-date', 'The due date moved to Friday at noon.')] }));
  assert.equal(first.items[0]!.action?.focusKey, second.items[0]!.action?.focusKey);
  assert.equal(first.items[0]!.action?.focusKey, 'briefing-msg');
});

const format = { course: () => 'CS 400', nameOf: (r: ResourceView) => ({ label: r.title, raw: r.title, removed: [], rule: 'none' }) as never, day: () => 'Mon, Sep 28', time: () => '1:00 PM', whenInline: () => 'tomorrow' };
function render(brief: ReturnType<typeof projectDailyBrief>, resources: ResourceView[], snapshotSources = sources, timeZone = tz) {
  const snapshot = { sources: snapshotSources, links: [], resources, personalReports: [] } as unknown as Snapshot;
  return renderToStaticMarkup(createElement(DailyBrief, { brief, conflict: null, onReviewDate() {}, snapshot, resources, timeZone, format, prepared: { refreshKey: 'k' } as never, onSelect() {}, onSources() {}, onPastDue() {} }));
}
const text = (html: string) => html.replace(/<span id="[^"]*" popover[^>]*>.*?<\/span><\/span>/g, '').replace(/<span id="[^"]*" class="briefing-visually-hidden">[^<]*<\/span>/g, '').replace(/<[^>]+>/g, '');

test('rendered brief: stated relationship with provenance on demand, stable action, status in the info control', () => {
  const bare = material('bare', { text: '', title: 'Week 5 slides' });
  const work = resource('w', { title: 'Project 2', text: 'For Part 2, you can use the Week 5 slides.', links: [bare.url] });
  const late = resource('late', { deadline: due('2026-09-20T18:00:00Z') });
  const brief = projectDailyBrief(input({ resources: [work, bare, late], links: [link(bare, work)], activeWork: [work], earlier: [late] }));
  const html = render(brief, [work, bare, late]);
  assert.match(html, /<h1 id="briefing-title" tabindex="-1">Daily Brief<\/h1>/);
  assert.match(html, /href="#resource\/w"[^>]*>Project 2<\/a>/);
  assert.match(text(html), /CS 400 Project 2 is due tomorrow · 1:00 PM\. Its instructions say you can use Week 5 slides\./);
  assert.match(html, /data-focus-key="brief-materials-w"[^>]*data-action-status="link-only"|data-action-status="link-only"[^>]*data-focus-key="brief-materials-w"/);
  const described = /aria-describedby="([^"]+)"[^>]*>Open linked material/.exec(html);
  assert.ok(described, 'limited status is attached to the control');
  assert.match(html, new RegExp(`<span id="${described![1]!}" class="briefing-visually-hidden">Only the link was saved.</span>`));
  // One info control per passage carries the source sentence (exact span of this version) and the status.
  assert.match(html, /aria-label="Where this comes from"[^>]*class="magic-info-panel">From the saved instructions: <q data-evidence-start="0" data-evidence-end="42" data-evidence-version="hash-w">For Part 2, you can use the Week 5 slides\.<\/q> Only the link was saved\.<\/span>/);
  assert.doesNotMatch(html, /briefing-action-note|Its instructions link/);
  assert.doesNotMatch(html, /aria-label="About past-due work"/, 'complete coverage adds no caveat');
  assert.match(html, /data-focus-key="brief-past-due"/);
  assert.doesNotMatch(text(html), /\b(you read|already read|mastered|ready for|completed|finished|required|recommended|helps?|will help)\b|—/i);
});

test('rendered brief uses the supplied time zone and the resolved calendar date for date-only deadlines', () => {
  const dayDue = resolveDeadline([{ kind: 'due', value: '2026-10-03T05:00:00Z', precision: 'day', quote: 'due Oct 3', authority: 'structured', scopeConfirmed: true }]);
  const m = material('m');
  const work = resource('w', { text: 'Read Reading m.', links: [m.url], deadline: dayDue });
  for (const zone of ['Asia/Tokyo', 'Pacific/Honolulu', 'UTC']) {
    const brief = projectDailyBrief(input({ resources: [work, m], links: [link(m, work)], activeWork: [work], timeZone: zone }));
    assert.match(text(render(brief, [work, m], sources, zone)), new RegExp(`is due ${calendarLabel('2026-10-03')} · time not provided\\.`), zone);
  }
  assert.equal(calendarLabel('2026-10-03'), new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date('2026-10-03T12:00:00Z')));
});

test('rendered fallback and partial coverage: one sentence when empty, one info control when there are passages', () => {
  const partialSources = [ok('canonical', { status: 'error', complete: false }), ok('b')];
  const empty = render(projectDailyBrief(input({ sources: partialSources })), [], partialSources);
  assert.match(empty, /data-brief-fallback="partial"/);
  assert.match(empty, /Saved sources/);
  assert.doesNotMatch(empty, /magic-info/, 'the fallback sentence already states coverage');
  const r = resource('msg', { kind: 'message' });
  const withItem = render(projectDailyBrief(input({ resources: [r], sources: partialSources, passages: [passage(r, 'information')] })), [r], partialSources);
  assert.match(withItem, /<div class="briefing-heading" data-brief-coverage="partial"><h1[^>]*>Daily Brief<\/h1><span class="magic-info"><button type="button" class="magic-info-trigger" aria-label="About Daily Brief coverage"/);
  assert.match(withItem, /1 of 2 saved sources was not fully checked on the last run, so this brief may be missing coursework and actions from those sources open saved copies\./);
  assert.doesNotMatch(withItem, /data-brief-fallback|briefing-coverage|home-provenance/, 'no persistent caveat paragraph');
  const complete = render(projectDailyBrief(input({ resources: [r], passages: [passage(r, 'information')] })), [r]);
  assert.doesNotMatch(complete, /magic-info/);
});

test('rendered status: one visible cue per fact, and every limit announced on its action', () => {
  const partialSources = [ok('canonical', { status: 'needs_sign_in', complete: false }), ok('b')];
  const changed = resource('msg', { kind: 'message' }), orphan = resource('orphan', { kind: 'message', sourceId: 'gone' });
  const late = resource('late', { deadline: due('2026-09-20T18:00:00Z') });
  const brief = projectDailyBrief(input({ resources: [changed, orphan, late], sources: partialSources, earlier: [late],
    passages: [passage(changed, 'changed-date', 'Moved to Friday.'), passage(orphan, 'changed-date', 'Lab moved to room 2.')] }));
  const html = render(brief, [changed, orphan, late], partialSources);
  // The heading states partial coverage once; saved-copy and past-due limits are not repeated per passage.
  assert.deepEqual([...html.matchAll(/magic-info-trigger" aria-label="([^"]+)"/g)].map(m => m[1]), ['About Daily Brief coverage', 'About this action']);
  assert.match(html, /aria-label="About this action"[^>]*class="magic-info-panel">No check of this source is saved, so it may be out of date\.<\/span>/);
  for (const [key, state] of [['briefing-msg', 'saved-copy'], ['briefing-orphan', 'unknown'], ['brief-past-due', 'saved-copy']]) {
    const control = new RegExp(`data-focus-key="${key}"[^>]*data-action-status="${state}"[^>]*aria-describedby="([^"]+)"`).exec(html);
    assert.ok(control, key);
    assert.match(html, new RegExp(`<span id="${control![1]}" class="briefing-visually-hidden">[^<]+</span>`));
  }
  assert.doesNotMatch(html, /<p[^>]*class="[^"]*(briefing-action-note|home-empty)/, 'no persistent caveat paragraphs');
});

test('default producing path selects sourced project parts, tomorrow lecture reading and no-action news beside Upcoming', () => {
  const project = resource('project', { title: 'Research Project', text: 'Submit a proposal, report, and presentation.', deadline: due('2026-09-30T18:00:00Z') });
  const reading = material('reading', { title: 'Chapter 4' });
  const lecture = resource('lecture', { kind: 'event', title: 'Class meeting', text: 'Read Chapter 4 before class.', deadline: resolveDeadline([]),
    calendar: { start: '2026-09-28T15:00:00Z', end: '2026-09-28T16:00:00Z' }, links: [reading.url] } as Partial<ResourceView>);
  const announcement = resource('news', { kind: 'message', title: 'Office hours update', text: 'Office hours moved to the library this week.', deadline: resolveDeadline([]) });
  const raw = [project, reading, lecture, announcement];
  const graph = [link(reading, lecture)];
  const canonical = canonicalHomeResources(raw, sources, graph);
  const selected = selectHomeEvidence(canonical, { sources, links: graph }, now, tz);
  const activeWork = [...selected.work.today, ...selected.work.upcoming.flatMap(g => g.items)];
  const brief = projectDailyBrief(input({ resources: canonical, links: graph, now, ...enrolledClass('2026-09-28', now), activeWork, earlier: selected.work.earlier,
    passages: selected.passages, prerequisites: selected.prerequisites }));
  assert.deepEqual(brief.items.map(i => i.kind), ['project', 'lecture-prep', 'passage']);
  assert.equal(brief.items[0]!.action?.targetId, project.id);
  assert.equal(brief.items[1]!.action?.targetId, reading.id);
  assert.equal(brief.items[2]!.action, null);
  assert.equal(selected.work.upcoming.flatMap(g => g.items).filter(r => r.id === project.id).length, 1);
  const html = render(brief, canonical);
  assert.match(html, /data-brief-item="project"/);
  assert.match(html, /data-brief-item="lecture-prep"/);
  assert.match(html, /data-evidence-version="hash-lecture"/);
  assert.doesNotMatch(html, /data-focus-key="briefing-news"/);
  assert.doesNotMatch(text(html), /already read|mastered|hours to finish|difficult|Dates disagree|Review dates/);
});

test('unsupported project effort, lecture relation, wrong account and stale source do not become confident advice', () => {
  const project = resource('project', { title: 'Research Project', text: 'Complete this project.', deadline: due('2026-09-30T18:00:00Z') });
  const reading = material('reading', { title: 'Chapter 4' });
  const lecture = resource('lecture', { kind: 'event', title: 'Class meeting', text: 'Materials: Chapter 4.', deadline: resolveDeadline([]),
    calendar: { start: '2026-09-28T15:00:00Z', end: '2026-09-28T16:00:00Z' }, links: [reading.url] } as Partial<ResourceView>);
  const base = { resources: [project, reading, lecture], activeWork: [project], links: [link(reading, lecture)], now, ...enrolledClass('2026-09-28', now) };
  assert.deepEqual(projectDailyBrief(input(base)).items.map(i => i.kind), []);
  const stated = { ...lecture, text: 'Read Chapter 4 before class.' };
  const cross = { ...reading, sourceId: 'other' };
  assert.deepEqual(projectDailyBrief(input({ ...base, resources: [project, cross, stated], links: [link(cross, stated)] })).items.map(i => i.kind), []);
  const stale = projectDailyBrief(input({ ...base, resources: [project, reading, stated], links: [link(reading, stated)],
    sources: [ok('canonical', { status: 'error', complete: false })] }));
  assert.equal(stale.items[0]?.kind, 'lecture-prep');
  assert.equal(stale.items[0]?.action?.status.state, 'saved-copy');
  assert.equal(projectParts(resource('p', { title: 'Project', text: 'The optional proposal may be replaced. Do not submit a report.' })), null);
  assert.equal(projectParts(resource('p', { title: 'Project', text: 'This project has a proposal and a report.' })), null);
  assert.deepEqual(projectDailyBrief(input({ ...base, resources: [project, reading, stated], links: [link(reading, stated)], schedules: [] })).items.map(i => i.kind), []);
  const wrongSchedule = enrolledClass('2026-09-28', now); wrongSchedule.schedules[0]!.accountScope = 'b';
  assert.deepEqual(projectDailyBrief(input({ ...base, resources: [project, reading, stated], links: [link(reading, stated)], ...wrongSchedule })).items.map(i => i.kind), []);
  const oldSchedule = enrolledClass('2026-09-28', '2026-09-20T18:00:00Z');
  assert.deepEqual(projectDailyBrief(input({ ...base, resources: [project, reading, stated], links: [link(reading, stated)], ...oldSchedule })).items.map(i => i.kind), []);
});

test('task-heavy and information-only students get different source-grounded briefs, regardless of snapshot order', () => {
  const reading = material('chapter', { title: 'Chapter 8' });
  const teaching = resource('teaching', { title: 'Field Study', text: 'Read Chapter 8 before preparing the analysis.', links: [reading.url], deadline: due('2026-10-01T18:00:00Z') });
  const generic = Array.from({ length: 7 }, (_, i) => resource(`task-${i}`, { text: 'Please check the assignment instructions for this week.', deadline: due('2026-09-28T18:00:00Z') }));
  const chatter = Array.from({ length: 7 }, (_, i) => resource(`chatter-${i}`, { kind: 'message', text: 'Please check the course page for updates.', deadline: resolveDeadline([]), createdAt: `2026-09-27T1${i}:00:00Z` }));
  const news = resource('news-only', { kind: 'message', text: 'Office hours moved to the library this week.', deadline: resolveDeadline([]), createdAt: '2026-09-27T01:00:00Z' });
  const graph = [link(reading, teaching)];
  const all = [...generic, ...chatter, news, reading, teaching];
  const selected = selectHomeEvidence(canonicalHomeResources(all, sources, graph), { sources, links: graph }, now, tz);
  assert.ok(selected.passages.some(p => p.resource.id === teaching.id), 'cited teaching context survives the selection window');
  assert.ok(selected.passages.some(p => p.resource.id === news.id), 'older meaningful news survives recent chatter');
  const activeWork = [...selected.work.today, ...selected.work.upcoming.flatMap(group => group.items)];
  const brief = projectDailyBrief(input({ resources: all, links: graph, activeWork, passages: selected.passages, prerequisites: selected.prerequisites, now }));
  assert.equal(brief.items[0]?.kind, 'linked-materials');
  assert.equal(brief.items[0]?.action?.targetId, reading.id);
  const infoOnly = projectDailyBrief(input({ resources: [news], passages: [selected.passages.find(p => p.resource.id === news.id)!], activeWork: [] }));
  assert.deepEqual(infoOnly.items.map(item => item.kind), ['passage']);
  assert.equal(infoOnly.items[0]?.action, null);
});

test('date disagreement is hidden on Brief and Calendar while raw conflict and chosen-date planning survive', () => {
  assert.equal(SHOW_DATE_CONFLICT_UI, false);
  const conflicting = resource('conflict', { deadline: { ...due('2026-09-28T18:00:00Z'), conflict: true } });
  const brief = projectDailyBrief(input({ resources: [conflicting], activeWork: [conflicting], conflict: conflicting }));
  assert.doesNotMatch(render(brief, [conflicting]), /Dates disagree|Review dates|saved sources disagree/);
  assert.equal(conflicting.deadline.conflict, true);
  const calendar = calendarItems([conflicting], [], '2026-09-28', tz)[0];
  if (calendar) {
    assert.doesNotMatch(calendar.detail, /Dates disagree|review date again/i);
    assert.doesNotMatch(calendarItemLabel(calendar, true), /Dates disagree|Review date/i);
    assert.equal(calendar.conflict, true);
  }
});

test('normal Home entry renders the separate Brief and Upcoming journey with actionable source routes', () => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const add = (days: number) => new Date(Date.parse(`${today}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  const lectureStart = new Date(startOfDate(add(1), zone).getTime() + 12 * 3_600_000).toISOString();
  const projectDue = new Date(startOfDate(add(3), zone).getTime() + 12 * 3_600_000).toISOString();
  const project = resource('project', { title: 'Research Project', text: 'Submit a proposal, report, and presentation.', deadline: due(projectDue) });
  const reading = material('reading', { title: 'Chapter 4' });
  const lecture = resource('lecture', { kind: 'event', title: 'Class meeting', text: 'Read Chapter 4 before class.', deadline: resolveDeadline([]),
    calendar: { start: lectureStart, end: new Date(Date.parse(lectureStart) + 3_600_000).toISOString() }, links: [reading.url] } as Partial<ResourceView>);
  const announcement = resource('news', { kind: 'message', title: 'Office hours update', text: 'Office hours moved to the library this week.', deadline: resolveDeadline([]) });
  const course = resource('course', { kind: 'material', courseName: 'COMP SCI 400', course: { courseCode: 'FA26 COMP SCI 400 001', selection: { included: true } } } as Partial<ResourceView>);
  const raw = [course, project, reading, lecture, announcement];
  const schedule = enrolledClass(add(1), new Date().toISOString());
  Object.assign(schedule.planning.records[0]!, { courseKey: 'uw:266:400' });
  schedule.planning.records.push(...([{ kind: 'account_link', accountScope: 'school', canvasAccountScope: 'a' }, { kind: 'subject', accountScope: 'public', code: '266', shortName: 'COMP SCI', formalName: 'Computer Sciences', aliases: [] }] as unknown as PlanningSnapshot['records']));
  const snapshot = { resources: raw, sources, links: [link(reading, lecture)], dayPlan: [], changes: [], personalReports: [], courseOverrides: [], planning: schedule.planning,
    courseWorkAdmission: { schedules: schedule.schedules, aliases: [] } } as unknown as Snapshot;
  const html = renderToStaticMarkup(createElement(Home, { snapshot, resources: raw, onSelect() {}, onCourses() {}, onSources() {}, onMyUw() {}, onPlan: async () => {} }));
  const brief = html.slice(html.indexOf('class="home-briefing"'), html.indexOf('class="home-upcoming"'));
  const upcoming = html.slice(html.indexOf('class="home-upcoming"'), html.indexOf('class="home-study"'));
  assert.match(brief, /data-brief-item="project"/);
  assert.match(brief, /data-brief-item="lecture-prep"/);
  assert.match(brief, /data-brief-item="passage"/);
  assert.match(brief, /href="#resource\/project"/);
  assert.match(brief, /href="#resource\/reading"/);
  assert.equal((upcoming.match(/data-focus-key="inspect-work-project"/g) ?? []).length, 1);
  assert.doesNotMatch(upcoming, /Chapter 4|Office hours update/);
  assert.doesNotMatch(brief, /Dates disagree|Review dates|already read|mastered|hours to finish/);
});


test('Home brief admits only verified current account/course, and stale enrollment yields a truthful empty default', () => {
  const course = resource('course', { course: { courseCode: 'FA26 COMP SCI 400 001', selection: { included: true } } } as Partial<ResourceView>);
  const current = resource('current', { kind: 'message', text: 'Office hours moved to Friday in the library this week.' });
  const former = resource('former', { courseId: 'former', kind: 'message' });
  const otherAccount = resource('other-account', { sourceId: 'other', kind: 'message' });
  const planning = { records: [
    { kind: 'account_link', accountScope: 'school', canvasAccountScope: 'a' },
    { kind: 'subject', accountScope: 'public', code: '266', shortName: 'COMP SCI', formalName: 'Computer Sciences', aliases: [] },
    { kind: 'enrollment_package', accountScope: 'school', courseKey: 'uw:266:400', termCode: '1272', sections: ['001'], enrollmentState: 'enrolled' }
  ], sources: [{ accountScope: 'school', source: 'uw_enroll', scope: { kind: 'enrollment_term', key: '1272' }, status: 'complete', completeness: 'complete', lastSuccessAt: now }] } as unknown as PlanningSnapshot;
  const data = input({ now, planning, resources: [course, current, former, otherAccount], passages: [current, former, otherAccount].map(r => passage(r, 'information', 'Office hours moved to Friday.')) });
  const result = currentEnrollmentBrief(data);
  assert.deepEqual(result.items.map(i => i.kind === 'passage' && i.passage.resource.id), ['current']);
  planning.sources[0]!.lastSuccessAt = '2026-09-20T18:00:00Z';
  assert.equal(currentEnrollmentBrief(data).items.length, 0);
  assert.match(currentEnrollmentBrief(data).fallback!.text, /enrollment is not confirmed/);
});

test('compact passage extracts an intact relevant sentence and project copy adds no management narration', () => {
  const text = 'Welcome to another week. ' + 'General course information is available in the saved syllabus. '.repeat(4) + 'In-person quizzes use the examples discussed in class.';
  assert.equal(briefExcerpt(text), 'In-person quizzes use the examples discussed in class.');
  const p = resource('project', { title: 'Project', text: 'Submit a proposal and a working prototype.', deadline: due('2026-10-02T18:00:00Z') });
  const projected = projectDailyBrief(input({ now, resources: [p], activeWork: [p], launchable: new Set([p.id]) }));
  const html = render(projected, [p]);
  assert.match(html, /The instructions require a proposal and a working prototype/);
  assert.match(html, /Get ahead/);
  assert.doesNotMatch(html, /check both|deliverables to prepare/);
});
