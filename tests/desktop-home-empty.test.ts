import test from "node:test";
import assert from "node:assert/strict";
import type { SourceHealth } from "@magic/contracts";
import { emptyScheduleMessage, calendarCoverageNeedsCheck } from "../apps/desktop/src/renderer/TodayRail";
const now = "2026-09-27T15:00:00Z";
const checked = { kind: "calendar", scope: "calendar", status: "ok", complete: true, lastSuccessAt: "2026-09-27T12:00:00Z" } as SourceHealth;
test("Home empty schedule distinguishes missing, partial, saved empty and all-day coverage", () => {
  assert.match(emptyScheduleMessage([], false, now), /not|No calendar source checked/);
  assert.match(emptyScheduleMessage([{ ...checked, complete: false }], false, now), /incomplete/);
  assert.match(emptyScheduleMessage([{ ...checked, status: "inaccessible" }], false, now), /incomplete/);
  assert.equal(emptyScheduleMessage([checked], false, now), "No events today in the saved calendar.");
  assert.equal(calendarCoverageNeedsCheck([checked], now), false);
  assert.match(emptyScheduleMessage([checked], false, "2026-09-29T12:00:00Z"), /out of date/);
  assert.equal(emptyScheduleMessage([checked], true, now), "No timed events in today’s saved schedule.");
});
