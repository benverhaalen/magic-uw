import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@magic/storage";
import { OUTLOOK_CALENDAR_COURSE_ID, type CaptureBatch } from "@magic/contracts";

const source = {
  id: "outlook-test",
  label: "Outlook calendar",
  kind: "calendar" as const,
  accountScope: "local",
  courseId: OUTLOOK_CALENDAR_COURSE_ID,
  scope: "outlook_calendar",
};
const meeting = (i: number) => ({
  externalId: `calendar:m${i}`,
  kind: "event" as const,
  courseId: OUTLOOK_CALENDAR_COURSE_ID,
  courseName: "Outlook calendar",
  title: `Private meeting ${i}`,
  url: "https://outlook.office.com/calendar/",
  text: "",
  deadlines: [],
  points: null,
  submitted: null,
  policy: { mode: "coaching" as const, evidence: "Personal calendar." },
  calendar: { uid: `m${i}@x`, start: `2026-09-2${i % 9}T15:00:00Z`, end: `2026-09-2${i % 9}T16:00:00Z`, allDay: false, timezone: "UTC" },
});
const batch = (count: number, observedAt: string): CaptureBatch => ({
  source,
  observedAt,
  complete: true,
  status: "ok",
  resources: Array.from({ length: count }, (_, i) => meeting(i)),
});

function withStore(fn: (store: ReturnType<typeof createStore>) => void) {
  const dir = mkdtempSync(join(tmpdir(), "magic-remove-source-"));
  const store = createStore(join(dir, "workspace.sqlite"));
  try {
    fn(store);
  } finally {
    store.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
}
const live = (store: ReturnType<typeof createStore>) =>
  store.resources().filter((r) => r.sourceId === source.id && !r.deleted);

test("an empty read is treated as a suspicious drop, so it cannot be used to disconnect", () => {
  withStore((store) => {
    store.ingest(batch(8, "2026-09-25T12:00:00Z"));
    store.ingest(batch(8, "2026-09-26T12:00:00Z"));
    store.ingest(batch(0, "2026-09-26T13:00:00Z"));
    assert.equal(live(store).length, 8, "the drift guard keeps the meetings");
  });
});

test("removing a disconnected source deletes its meetings, search entries, and health row", () => {
  withStore((store) => {
    store.ingest(batch(8, "2026-09-25T12:00:00Z"));
    store.ingest(batch(8, "2026-09-26T12:00:00Z"));
    assert.equal(store.resources("Private meeting").length, 8);
    assert.equal(store.removeSource(source.id), 8);
    assert.equal(store.resources().filter((r) => r.sourceId === source.id).length, 0);
    assert.equal(store.resources("Private meeting").length, 0, "no search hits remain");
    assert.equal(store.sources().some((s) => s.id === source.id), false);
    assert.equal(store.changes({ sourceId: source.id }).length, 0);
    // Reconnecting later starts from a clean baseline.
    store.ingest(batch(2, "2026-09-27T12:00:00Z"));
    assert.equal(live(store).length, 2);
  });
});

test("removing one source leaves every other source untouched, and an unknown id is a no-op", () => {
  withStore((store) => {
    store.ingest(batch(3, "2026-09-26T12:00:00Z"));
    store.ingest({ ...batch(2, "2026-09-26T12:00:00Z"), source: { ...source, id: "other-calendar" } });
    assert.equal(store.removeSource("missing"), 0);
    store.removeSource(source.id);
    assert.equal(store.resources().filter((r) => r.sourceId === "other-calendar" && !r.deleted).length, 2);
  });
});

test("removing the last source of a course also removes its course profile and plan entries for its items", () => {
  withStore((store) => {
    store.ingest(batch(3, "2026-09-26T12:00:00Z"));
    const outlookProfile = () =>
      store.courseIntelligence().filter((p) => p.accountScope === "local" && p.courseId === OUTLOOK_CALENDAR_COURSE_ID);
    assert.equal(outlookProfile().length, 1, "ingest compiles a profile for the calendar");
    const today = new Date().toISOString().slice(0, 10);
    const meetingId = live(store)[0]!.id;
    const block = { type: "prep" as const, resourceId: meetingId, title: "Prep", courseName: "Outlook calendar", startMin: 600, endMin: 630 };
    store.setDayPlanEntry({ key: "prep:m", date: today, status: "accepted", block });
    store.setDayPlanEntry({ key: "prep:other", date: today, status: "accepted", block: { ...block, resourceId: "unrelated" } });
    store.removeSource(source.id);
    assert.deepEqual(outlookProfile(), [], "no stale profile after disconnect");
    assert.deepEqual(store.dayPlan().map((e) => e.key), ["prep:other"]);
  });
});

test("when another source still covers the course, its profile is rebuilt instead of deleted", () => {
  withStore((store) => {
    store.ingest(batch(3, "2026-09-26T12:00:00Z"));
    store.ingest({ ...batch(2, "2026-09-26T12:00:00Z"), source: { ...source, id: "second-calendar" } });
    store.removeSource(source.id);
    const profiles = store.courseIntelligence().filter((p) => p.courseId === OUTLOOK_CALENDAR_COURSE_ID);
    assert.equal(profiles.length, 1);
    assert.equal(store.resources().filter((r) => !r.deleted && r.courseId === OUTLOOK_CALENDAR_COURSE_ID).length, 2);
  });
});
