import test from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppNotification, NotificationFeed } from '@magic/contracts';
import { notificationDestination, type DestinationContext, type NotificationDestination } from '../apps/desktop/src/renderer/notifications/destination';

import { NotificationsMenu } from '../apps/desktop/src/renderer/notifications/NotificationsMenu';

const item = (over: Partial<AppNotification>): AppNotification => ({
  id: 'n', level: 'important', reason: 'graded', title: 'Lab 2: 9/10', observedAt: new Date().toISOString(),
  changeIds: [], read: false, ...over,
});
const context = (resources: Record<string, { url?: string }>, courses: string[] = []): DestinationContext => ({
  resource: id => resources[id],
  courseKey: (sourceId, courseId) => courses.includes(`${sourceId}:${courseId}`) ? `${sourceId}:${courseId}` : null,
});

test('sign-in and stale sources route to Connected sources', () => {
  assert.deepEqual(notificationDestination(item({ reason: 'sign_in', level: 'urgent' }), context({})), { kind: 'sources' });
  assert.deepEqual(notificationDestination(item({ reason: 'source_stale', sourceId: 's' }), context({})), { kind: 'sources' });
});

test('coursework opens its saved item; a removed or grouped item opens its course page', () => {
  const ctx = context({ r1: { url: 'https://canvas.example.edu/a/1' } }, ['s:220']);
  assert.deepEqual(notificationDestination(item({ resourceId: 'r1', sourceId: 's', courseId: '220' }), ctx), { kind: 'resource', id: 'r1' });
  assert.deepEqual(notificationDestination(item({ reason: 'removed', resourceId: 'gone', sourceId: 's', courseId: '220' }), ctx), { kind: 'course', key: 's:220' });
  assert.deepEqual(notificationDestination(item({ reason: 'new_assignments', count: 6, sourceId: 's', courseId: '220' }), ctx), { kind: 'course', key: 's:220' });
  // No course page for it (excluded or unknown): the row stays readable but leads nowhere.
  assert.equal(notificationDestination(item({ reason: 'removed', resourceId: 'gone', sourceId: 's', courseId: '999' }), ctx), null);
});

test('email opens its Outlook message over https and otherwise falls back to the saved copy', () => {
  const outlook = 'https://outlook.office.com/mail/id/AAMk';
  assert.deepEqual(notificationDestination(item({ reason: 'email', resourceId: 'm1' }), context({ m1: { url: outlook } })), { kind: 'outlook', url: outlook });
  assert.deepEqual(notificationDestination(item({ reason: 'email', resourceId: 'm1' }), context({ m1: { url: 'javascript:alert(1)' } })), { kind: 'resource', id: 'm1' });
  assert.deepEqual(notificationDestination(item({ reason: 'email', resourceId: 'm1' }), context({ m1: {} })), { kind: 'resource', id: 'm1' });
});

const render = (feed: NotificationFeed | undefined) => renderToStaticMarkup(React.createElement(NotificationsMenu, {
  feed, busy: false, run: async () => undefined, onOpen: () => undefined, onOpenSources: () => undefined, onOpenPrivacy: () => undefined,
  destinationOf: (n: AppNotification): NotificationDestination | null => n.reason === 'email' ? { kind: 'outlook', url: 'https://outlook.office.com/mail/x' } : null,
}));
const feed = (over: Partial<NotificationFeed> = {}): NotificationFeed => ({
  items: [], unread: 0, checkedAt: new Date().toISOString(), degraded: false, triage: { status: 'on', reason: '' }, ...over,
});

test('the bell names its count and the panel says Urgent in words, with the Outlook destination named', () => {
  const html = render(feed({
    unread: 2,
    items: [
      item({ id: 'u', level: 'urgent', reason: 'due_earlier', title: 'Interface exercise', detail: 'Due date moved earlier' }),
      item({ id: 'e', level: 'important', reason: 'email', title: 'Advising hold', from: 'Advisor', courseName: 'Outlook mail' }),
      item({ id: 'i', level: 'info', reason: 'new_material', title: 'Slides', read: true }),
    ],
  }));
  assert.match(html, /aria-label="Notifications, 2 need attention"/);
  assert.match(html, /class="notif-badge"[^>]*>2</);
  assert.match(html, /popover="auto"/);
  assert.match(html, />Urgent</);
  assert.match(html, /Opens in Outlook/);
  assert.match(html, /Other updates/);
  assert.doesNotMatch(html, /—/, 'no em dashes in app-authored copy');
});

test('unavailable, degraded and Jev-off states stay honest', () => {
  const unavailable = render(undefined);
  assert.match(unavailable, /aria-label="Notifications, not available yet"/);
  assert.match(unavailable, /aren’t available yet/);
  assert.doesNotMatch(unavailable, /notif-badge/);

  const degraded = render(feed({ degraded: true, triage: { status: 'off', reason: '' } }));
  assert.match(degraded, /Can’t confirm you’re up to date/);
  assert.match(degraded, /updates may be missing/);
  assert.match(degraded, /sorting by Jev is off\. Code rules still sort everything\./);
  assert.doesNotMatch(degraded, /—/);
});
