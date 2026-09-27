import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '@magic/storage';
import { createCore } from '@magic/core';
import { captureBatchSchema, personalCalendarEventSchema, type PersonalCalendarEvent } from '@magic/contracts';
import { localMinuteInstant, localTime } from '../apps/desktop/src/renderer/calendar/model';
import { personalCalendarItems } from '../apps/desktop/src/renderer/calendar/personal';
import fixture from '../fixtures/course.json';

const event: PersonalCalendarEvent = { id: '7706f1c8-caa7-4cd9-ac57-21d755966d00', title: 'Meet advisor', date: '2026-11-01', allDay: false, startsAt: '2026-11-01T16:00:00.000Z', endsAt: '2026-11-01T17:00:00.000Z', timeZone: 'America/Chicago', location: 'Office', notes: 'Bring plan' };

test('personal event command persists create, edit and delete across reopen; invalid instants reject', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'magic-personal-calendar-'));
  const path = join(directory, 'workspace.sqlite');
  try {
    let core = createCore(createStore(path), { fixture: captureBatchSchema.parse(fixture) });
    let result = await core.execute({ type: 'personal-calendar-save', event });
    assert.equal(result.snapshot.personalCalendarEvents?.[0]?.title, 'Meet advisor');
    await core.close();
    core = createCore(createStore(path), { fixture: captureBatchSchema.parse(fixture) });
    assert.equal((await core.execute({ type: 'snapshot' })).snapshot.personalCalendarEvents?.length, 1);
    result = await core.execute({ type: 'personal-calendar-save', event: { ...event, title: 'Office hours' } });
    assert.equal(result.snapshot.personalCalendarEvents?.[0]?.title, 'Office hours');
    await assert.rejects(core.execute({ type: 'personal-calendar-save', event: { ...event, endsAt: event.startsAt } }), /timed event/);
    result = await core.execute({ type: 'personal-calendar-remove', id: event.id });
    assert.deepEqual(result.snapshot.personalCalendarEvents, []);
    await core.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('personal dates and timed instants preserve timezone and daylight-saving meaning', () => {
  assert.equal(localMinuteInstant('2026-03-08', 150, 'America/Chicago'), null);
  const start = localMinuteInstant('2026-11-01', 600, 'America/Chicago');
  assert.equal(start, event.startsAt);
  assert.deepEqual(localTime(start!, 'America/Los_Angeles'), { date: '2026-11-01', min: 480 });
  assert.deepEqual(personalCalendarItems([event], '2026-11-01', 'America/Los_Angeles').map(item => [item.startMin, item.endMin]), [[480, 540]]);
  assert.equal(personalCalendarEventSchema.safeParse({ ...event, allDay: true, startsAt: null, endsAt: null }).success, true);
});
