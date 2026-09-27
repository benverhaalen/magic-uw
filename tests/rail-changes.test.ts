import test from "node:test";
import assert from "node:assert/strict";
import { changeNotes, type RailChange } from "@magic/domain";

// Saturday Sep 26, 2026, 9:00 PM in Chicago.
const NOW = "2026-09-27T02:00:00Z";
const TZ = "America/Chicago";
const claim = (value: string) => ({ value, kind: "due" as const, quote: `due ${value}`, authority: "structured" as const, scopeConfirmed: true });
const change = (type: string, oldValues: Record<string, unknown>, newValues: Record<string, unknown>, observedAt = "2026-09-26T20:00:00Z", resourceId = "quiz"): RailChange => ({
  resourceId, type, observedAt, oldValues, newValues,
});
const notes = (changes: RailChange[]) => Object.fromEntries(changeNotes(changes, NOW, TZ));

test("a moved due date says when it used to be due", () => {
  // Was Tuesday 11:59 PM Central, now today.
  assert.deepEqual(
    notes([change("date_changed", { deadlines: [claim("2026-09-30T04:59:00Z")] }, { deadlines: [claim("2026-09-27T04:59:00Z")] })]),
    { quiz: ["Was due Tue 11:59 PM"] },
  );
  // Plain dueAt fields work too, and a same-day move leaves out the weekday.
  assert.deepEqual(
    notes([change("date_changed", { dueAt: "2026-09-26T22:00:00Z" }, { dueAt: "2026-09-27T04:59:00Z" })]),
    { quiz: ["Was due 5:00 PM"] },
  );
});

test("changed instructions are flagged once, however many times they changed", () => {
  assert.deepEqual(
    notes([
      change("requirements_changed", { text: "a" }, { text: "b" }),
      change("requirements_changed", { text: "b" }, { text: "c" }, "2026-09-26T21:00:00Z"),
    ]),
    { quiz: ["Instructions updated"] },
  );
});

test("a date moved and then moved back is not reported", () => {
  assert.deepEqual(
    notes([
      change("date_changed", { dueAt: "2026-09-27T04:59:00Z" }, { dueAt: "2026-09-30T04:59:00Z" }, "2026-09-26T15:00:00Z"),
      change("date_changed", { dueAt: "2026-09-30T04:59:00Z" }, { dueAt: "2026-09-27T04:59:00Z" }, "2026-09-26T20:00:00Z"),
    ]),
    {},
  );
});

test("the earliest old date in the window is the one reported after several moves", () => {
  assert.deepEqual(
    notes([
      change("date_changed", { dueAt: "2026-09-29T04:59:00Z" }, { dueAt: "2026-09-28T04:59:00Z" }, "2026-09-26T20:00:00Z"),
      change("date_changed", { dueAt: "2026-09-30T04:59:00Z" }, { dueAt: "2026-09-29T04:59:00Z" }, "2026-09-25T20:00:00Z"),
      change("date_changed", { dueAt: "2026-09-28T04:59:00Z" }, { dueAt: "2026-09-27T04:59:00Z" }, "2026-09-26T21:00:00Z"),
    ]),
    { quiz: ["Was due Tue 11:59 PM"] },
  );
});

test("a new due date and a changed late cutoff get their own wording", () => {
  assert.deepEqual(notes([change("date_changed", {}, { dueAt: "2026-09-27T04:59:00Z" })]), { quiz: ["Due date added"] });
  assert.deepEqual(
    notes([change("date_changed", { lockAt: "2026-09-28T04:59:00Z" }, { lockAt: "2026-09-29T04:59:00Z" })]),
    { quiz: ["Late cutoff changed"] },
  );
});

test("old changes, first-import 'new' records, and plain edits are ignored", () => {
  assert.deepEqual(
    notes([
      change("date_changed", { dueAt: "2026-09-10T04:59:00Z" }, { dueAt: "2026-09-27T04:59:00Z" }, "2026-09-18T20:00:00Z"),
      change("new", {}, { title: "Quiz" }),
      change("updated", { contentHash: "a" }, { contentHash: "b" }),
    ]),
    {},
  );
});

test("notes are kept per item, date first", () => {
  assert.deepEqual(
    notes([
      change("requirements_changed", { text: "a" }, { text: "b" }),
      change("date_changed", { dueAt: "2026-09-30T04:59:00Z" }, { dueAt: "2026-09-27T04:59:00Z" }),
      change("requirements_changed", { rubric: [] }, { rubric: [1] }, "2026-09-26T20:00:00Z", "essay"),
    ]),
    { quiz: ["Was due Tue 11:59 PM", "Instructions updated"], essay: ["Instructions updated"] },
  );
});
