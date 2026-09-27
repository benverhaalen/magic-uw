import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "@magic/storage";
import { createCore, rebaseFixture } from "@magic/core";
import { captureBatchSchema } from "@magic/contracts";
import fixture from "../fixtures/course.json";

const batch = captureBatchSchema.parse(fixture);
const TZ = "America/Chicago";
const byId = (b: typeof batch, id: string) =>
  b.resources.find((r) => r.externalId === id)!;

test("the sample course moves forward so its first day is today, at the same local times", () => {
  // Monday Oct 5, 10:00 AM Central; the sample's first day is Sat Sep 26.
  const moved = rebaseFixture(batch, new Date("2026-10-05T15:00:00Z"), TZ);
  const workshop = byId(moved, "workshop-sat");
  assert.equal(workshop.calendar?.start, "2026-10-05T20:30:00.000Z");
  assert.equal(workshop.calendar?.end, "2026-10-05T21:45:00.000Z");
  assert.equal(byId(moved, "grammar-quiz").deadlines[0]!.value, "2026-10-06T04:59:00.000Z");
  assert.equal(byId(moved, "midterm").deadlines[0]!.value, "2026-10-08T15:00:00.000Z");
});

test("all-day dates and quoted source times move with the data", () => {
  const moved = rebaseFixture(batch, new Date("2026-10-05T15:00:00Z"), TZ);
  const window = byId(moved, "buildfest-window").calendar!;
  assert.deepEqual([window.start, window.end], ["2026-10-05", "2026-10-06"]);
  for (const r of moved.resources)
    for (const d of r.deadlines)
      assert.ok(d.quote.includes(d.value.slice(0, 16)), `${r.externalId} quote matches its date`);
});

test("late evening counts as the student's local day, not the UTC day", () => {
  // Oct 5, 10:00 PM Central is already Oct 6 in UTC.
  const moved = rebaseFixture(batch, new Date("2026-10-06T03:00:00Z"), TZ);
  assert.equal(byId(moved, "workshop-sat").calendar?.start, "2026-10-05T20:30:00.000Z");
});

test("on the sample's own day nothing moves", () => {
  const moved = rebaseFixture(batch, new Date("2026-09-26T19:00:00Z"), TZ);
  assert.equal(byId(moved, "workshop-sat").calendar?.start, byId(batch, "workshop-sat").calendar?.start);
});

test("loading the sample through core applies the move and keeps it labeled synthetic", async () => {
  const store = createStore(":memory:");
  const core = createCore(store, {
    fixture: batch,
    now: () => new Date("2026-10-05T15:00:00Z"),
    timeZone: TZ,
  });
  const { snapshot } = await core.execute({ type: "fixture" });
  assert.equal(snapshot.fixtureMode, true);
  const quiz = snapshot.resources.find((r) => r.externalId === "grammar-quiz")!;
  assert.equal(quiz.deadline.dueAt, "2026-10-06T04:59:00.000Z");
  await core.close();
});
