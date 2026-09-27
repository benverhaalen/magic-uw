import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { resolveDeadline } from '@magic/domain';
import { GoogleExportPanel, omittedSummary } from '../apps/desktop/src/renderer/calendar/GoogleExportPanel';
import { previewGoogleExport } from '../apps/desktop/src/renderer/calendar/google-export';
import type { CalendarResource } from '../apps/desktop/src/renderer/calendar/model';

const CANVAS = 'a'.repeat(64), now = '2026-09-27T15:00:00.000Z';
const due = (value: string) => resolveDeadline([{ kind: 'due' as const, value, quote: value, authority: 'structured' as const, scopeConfirmed: true, precision: 'minute' as const }]);
const item = (id: string, fields: Partial<CalendarResource> = {}): CalendarResource => ({ id, kind: 'assignment', accountScope: CANVAS, courseId: '101', courseName: 'CS 400', title: id, completed: false, submitted: null, kindLabel: null,
  sourceScope: 'assignments', externalId: id, url: `https://canvas.wisc.edu/courses/101/assignments/${id}`, submissionTypes: ['online_upload'], deadline: due('2026-10-02T04:59:00Z'), ...fields });
const resources = [
  item('hw'), item('conflict', { deadline: { ...due('2026-10-06T04:59:00Z'), conflict: true, dueAt: null } }),
  item('undated', { deadline: resolveDeadline([]) }), item('undated 2', { deadline: resolveDeadline([]) }), item('cancelled', { workflowState: 'CANCELLED' }),
  item('feed', { kind: 'event', sourceScope: 'calendar_feed', submissionTypes: undefined, externalId: undefined, url: 'https://canvas.wisc.edu/calendar', calendar: { uid: 'event-assignment-77', allDay: false, start: '2026-10-03T04:59:00Z' }, deadline: resolveDeadline([]) }),
];

test('left-out counts stay exact and date conflicts stay out of the file, but the visible line never names a disagreement', () => {
  const preview = previewGoogleExport(resources, undefined, { from: '2026-09-27', through: '2026-12-31', canvasScope: CANVAS, timeZone: 'America/Chicago', now, courseLabel: () => 'CS 400' });
  // Export safety is unchanged: the conflict is still counted and never becomes an event.
  assert.equal(preview.omitted.conflict, 1);
  assert.ok(!preview.rows.some(row => /conflict/.test(row.title)));
  assert.deepEqual(omittedSummary(preview.omitted), ['3 without one confirmed due date', '1 whose Canvas type wasn’t captured', '1 cancelled']);
  assert.deepEqual(omittedSummary({ dateReview: 0, conflict: 1, typeUnknown: 0, clockChange: 0, scheduleUnverified: 0, cancelled: 0 }), ['1 without one confirmed due date']);
  assert.deepEqual(omittedSummary({ dateReview: 39, conflict: 1, typeUnknown: 47, clockChange: 2, scheduleUnverified: 3, cancelled: 0 }),
    ['40 without one confirmed due date', '47 whose Canvas type wasn’t captured', '2 at a daylight-saving clock change', '3 from unconfirmed class schedules']);
  const html = renderToStaticMarkup(createElement(GoogleExportPanel, { resources, timeZone: 'America/Chicago', now, courseLabel: () => 'CS 400', onClose: () => {}, bridge: {} }));
  assert.match(html, /Left out: (<!-- -->)?3 without one confirmed due date, 1 whose Canvas type wasn’t captured, 1 cancelled(<!-- -->)?\. Review them in My Magic UW\./);
  assert.doesNotMatch(html, /disagree|conflict/i);
});
