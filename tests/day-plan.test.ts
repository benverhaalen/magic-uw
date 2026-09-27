import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import {
  captureBatchSchema,
  dayPlanEntrySchema,
  type DayPlanEntry,
} from "@magic/contracts";
import fixture from "../fixtures/course.json";

const entry = (over: Partial<DayPlanEntry> = {}, block = {}): DayPlanEntry => ({
  key: "work:r1",
  date: "2026-09-30",
  status: "accepted",
  block: {
    type: "work",
    resourceId: "r1",
    title: "Start P1 (MySQL)",
    courseName: "COMPSCI 574",
    startMin: 725,
    endMin: 815,
    ...block,
  },
  ...over,
});

// Pinned so retention checks don't depend on when the tests run.
const CLOCK = { now: () => new Date("2026-09-30T12:00:00Z") };

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "day-plan-"));
  return { path: join(dir, "w.sqlite"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the day plan starts empty, upserts by suggestion and day, and removes entries", () => {
  const store = createStore(":memory:", CLOCK);
  assert.deepEqual(store.dayPlan(), []);
  store.setDayPlanEntry(entry());
  store.setDayPlanEntry(entry({ date: "2026-10-01" }));
  store.setDayPlanEntry(entry({}, { title: "Outline P1", startMin: 740 }));
  const today = store.dayPlan().filter((e) => e.date === "2026-09-30");
  assert.equal(today.length, 1);
  assert.equal(today[0]!.block.title, "Outline P1");
  store.removeDayPlanEntry("work:r1", "2026-09-30");
  assert.deepEqual(
    store.dayPlan().map((e) => e.date),
    ["2026-10-01"],
  );
  store.close();
});

test("the day plan survives restarting the app", () => {
  const db = tempDb();
  try {
    const first = createStore(db.path, CLOCK);
    first.setDayPlanEntry(entry({ status: "skipped" }));
    first.close();
    const second = createStore(db.path, CLOCK);
    assert.equal(second.dayPlan()[0]?.status, "skipped");
    second.close();
  } finally {
    db.done();
  }
});

test("a malformed saved entry is dropped without losing the valid ones", () => {
  const db = tempDb();
  try {
    createStore(db.path, CLOCK).close();
    const raw = new DatabaseSync(db.path);
    raw
      .prepare("INSERT INTO preferences VALUES ('dayPlan', ?)")
      .run(JSON.stringify([entry(), { key: "x", date: "not a date" }]));
    raw.close();
    const store = createStore(db.path, CLOCK);
    assert.deepEqual(
      store.dayPlan().map((e) => e.key),
      ["work:r1"],
    );
    store.close();
  } finally {
    db.done();
  }
});

test("old days are pruned so the plan does not grow forever", () => {
  const db = tempDb();
  try {
    // Saved in early September...
    const early = createStore(db.path, { now: () => new Date("2026-09-05T12:00:00Z") });
    early.setDayPlanEntry(entry({ date: "2026-09-01" }));
    early.setDayPlanEntry(entry({ date: "2026-09-18" }));
    early.close();
    // ...then the next write at the end of the month drops what is more than 14 days old.
    const later = createStore(db.path, CLOCK);
    later.setDayPlanEntry(entry({ date: "2026-09-30" }));
    assert.deepEqual(later.dayPlan().map((e) => e.date).sort(), ["2026-09-18", "2026-09-30"]);
    later.close();
  } finally {
    db.done();
  }
});

test("deleting local data clears the day plan", () => {
  const store = createStore(":memory:", CLOCK);
  store.setDayPlanEntry(entry());
  store.purge();
  assert.deepEqual(store.dayPlan(), []);
  store.close();
});

test("entries are validated: a real block of at least 10 minutes within the day", () => {
  assert.equal(dayPlanEntrySchema.safeParse(entry()).success, true);
  assert.equal(dayPlanEntrySchema.safeParse(entry({}, { endMin: 730 })).success, false);
  assert.equal(dayPlanEntrySchema.safeParse(entry({}, { endMin: 1500 })).success, false);
  assert.equal(dayPlanEntrySchema.safeParse(entry({ date: "Sep 30" })).success, false);
});

test("core saves plan decisions and returns them in the snapshot", async () => {
  const store = createStore(":memory:", CLOCK);
  const core = createCore(store, { fixture: captureBatchSchema.parse(fixture) });
  const saved = await core.execute({ type: "day-plan", entry: entry() });
  assert.equal(saved.snapshot.dayPlan?.[0]?.key, "work:r1");
  const removed = await core.execute({
    type: "day-plan-remove",
    key: "work:r1",
    date: "2026-09-30",
  });
  assert.deepEqual(removed.snapshot.dayPlan, []);
  await core.close();
});

test("only study blocks can be self-reported done; assignment blocks wait for Canvas", async () => {
  const store = createStore(":memory:", CLOCK);
  const core = createCore(store, { fixture: captureBatchSchema.parse(fixture) });
  await assert.rejects(
    core.execute({
      type: "day-plan",
      entry: entry({ doneAt: "2026-09-30T18:00:00.000Z" }),
    }),
    /Canvas/,
  );
  const prep = entry(
    { key: "prep:lec", doneAt: "2026-09-30T15:00:00.000Z" },
    { type: "prep", title: "Skim Lecture 9 notes", startMin: 635, endMin: 660 },
  );
  const result = await core.execute({ type: "day-plan", entry: prep });
  assert.equal(result.snapshot.dayPlan?.[0]?.doneAt, "2026-09-30T15:00:00.000Z");
  await core.close();
});

test("one far-off date is refused and cannot wipe the real plan", () => {
  const store = createStore(":memory:", CLOCK);
  store.setDayPlanEntry(entry({ date: "2026-09-20" }));
  store.setDayPlanEntry(entry({ date: "2026-09-30" }));
  assert.throws(() => store.setDayPlanEntry(entry({ date: "9999-12-31" })), /within 14 days/);
  assert.throws(() => store.setDayPlanEntry(entry({ date: "2020-01-01" })), /within 14 days/);
  assert.deepEqual(store.dayPlan().map((e) => e.date).sort(), ["2026-09-20", "2026-09-30"]);
  store.close();
});

test("retention counts back from today, not from the newest saved day", () => {
  const db = tempDb();
  try {
    createStore(db.path, CLOCK).close();
    // A far-future entry already on disk (e.g. from an older build) must not decide what is old.
    const raw = new DatabaseSync(db.path);
    raw.prepare("INSERT INTO preferences VALUES ('dayPlan', ?)").run(
      JSON.stringify([entry({ date: "2026-09-25" }), entry({ date: "9999-12-31" })]),
    );
    raw.close();
    const store = createStore(db.path, CLOCK);
    store.setDayPlanEntry(entry({ key: "work:r2", date: "2026-09-30" }));
    assert.deepEqual(store.dayPlan().map((e) => e.date).sort(), ["2026-09-25", "2026-09-30"]);
    store.close();
  } finally {
    db.done();
  }
});

test("the plan keeps at most 500 entries, newest days first", () => {
  const store = createStore(":memory:", CLOCK);
  for (let i = 0; i < 520; i++)
    store.setDayPlanEntry(entry({ key: `work:r${i}`, date: i < 20 ? "2026-09-17" : "2026-09-30" }));
  const plan = store.dayPlan();
  assert.equal(plan.length, 500);
  assert.equal(plan.every((e) => e.date === "2026-09-30"), true);
  store.close();
});
