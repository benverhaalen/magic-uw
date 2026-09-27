import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTodayRail,
  effortBand,
  resolveDeadline,
  type RailResource,
} from "@magic/domain";
import type { DeadlineClaim } from "@magic/contracts";

const TZ = "America/Chicago";
// Tuesday Sep 29, 2:00 PM CDT.
const NOW = "2026-09-29T19:00:00.000Z";

const due = (value: string): DeadlineClaim => ({
  value,
  kind: "due",
  quote: "due_at",
  authority: "structured",
  scopeConfirmed: true,
});
function item(
  id: string,
  partial: Partial<RailResource> & { dueAt?: string },
): RailResource {
  const { dueAt, ...rest } = partial;
  return {
    id,
    kind: "assignment",
    title: id,
    courseId: "c",
    courseName: "Course",
    completed: false,
    submitted: null,
    deadline: resolveDeadline(dueAt ? [due(dueAt)] : []),
    kindLabel: null,
    ...rest,
  };
}
const lecture = item("geo-lecture", {
  kind: "event",
  title: "GEOSCI 100 Lecture",
  courseId: "geo",
  courseName: "GEOSCI 100",
  calendar: {
    uid: "l",
    start: "2026-09-29T20:30:00Z",
    end: "2026-09-29T21:45:00Z",
    allDay: false,
  },
});
const officeHours = item("oh", {
  kind: "event",
  title: "ECON 102 Office hours",
  courseId: "econ",
  deadline: resolveDeadline([
    { ...due("2026-09-29T23:00:00Z"), kind: "event" },
  ]),
});
const tomorrowEvent = item("tomorrow", {
  kind: "event",
  calendar: {
    uid: "t",
    start: "2026-09-30T15:00:00Z",
    end: "2026-09-30T16:00:00Z",
    allDay: false,
  },
});
const addDrop = item("add-drop", {
  kind: "event",
  title: "Add/drop deadline",
  calendar: { uid: "a", start: "2026-09-29", end: null, allDay: true },
});
const slides7 = item("slides-7", {
  kind: "material",
  title: "Lecture 7 slides",
  courseId: "geo",
  updatedAt: "2026-09-28T12:00:00Z",
});
const slides6 = item("slides-6", {
  kind: "material",
  title: "Lecture 6 slides",
  courseId: "geo",
  updatedAt: "2026-09-20T12:00:00Z",
});
const problemSet = item("ps3", {
  title: "Problem Set #3",
  courseId: "econ",
  courseName: "ECON 102",
  dueAt: "2026-09-30T04:59:00Z", // 11:59 PM tonight
});
const submitted = item("hw-done", {
  title: "Homework 2",
  submitted: true,
  dueAt: "2026-09-30T04:00:00Z",
});
const midterm = item("midterm", {
  title: "Midterm 1",
  courseId: "stat",
  courseName: "STAT 240",
  dueAt: "2026-10-01T15:00:00Z",
});
const essay = item("essay", {
  title: "Comparative analysis essay",
  courseId: "wr",
  dueAt: "2026-10-03T04:59:00Z",
});
const all = [
  lecture,
  officeHours,
  tomorrowEvent,
  addDrop,
  slides7,
  slides6,
  problemSet,
  submitted,
  midterm,
  essay,
];
const rail = buildTodayRail(all, NOW, TZ);

test("places today's timed events in local time and flags start-only ones", () => {
  assert.equal(rail.date, "2026-09-29");
  assert.deepEqual(
    rail.events.map((e) => [e.id, e.startMin, e.endMin, e.startOnly]),
    [
      ["geo-lecture", 15 * 60 + 30, 16 * 60 + 45, false],
      ["oh", 18 * 60, null, true],
    ],
  );
  assert.deepEqual(
    rail.allDay.map((e) => e.id),
    ["add-drop"],
  );
});

test("due today lists open work only, in local time", () => {
  assert.deepEqual(
    rail.due.map((d) => [d.id, d.dueMin]),
    [["ps3", 23 * 60 + 59]],
  );
});

test("effort is a labeled range from item type, or unknown", () => {
  assert.deepEqual(
    [effortBand(problemSet)?.lowMin, effortBand(problemSet)?.highMin],
    [60, 180],
  );
  assert.equal(effortBand(midterm)?.category, "exam");
  assert.equal(effortBand(item("x", { title: "Assignment 4" })), null);
  assert.match(effortBand(problemSet)!.basis, /estimate/i);
});

test("suggests reviewing the latest course material right before class", () => {
  const prep = rail.suggestions.find((s) => s.type === "prep");
  assert.ok(prep);
  assert.equal(prep.resourceId, "slides-7");
  assert.equal(prep.endMin, 15 * 60 + 30);
  assert.ok(prep.endMin - prep.startMin >= 20);
  const noMaterials = buildTodayRail(
    [lecture, problemSet],
    NOW,
    TZ,
  ).suggestions;
  assert.equal(
    noMaterials.some((s) => s.type === "prep"),
    false,
  );
});

test("prep is only for class sessions and never repeats the same material", () => {
  const officeHoursTimed = item("oh-timed", {
    kind: "event",
    title: "GEOSCI 100 Office hours",
    courseId: "geo",
    calendar: {
      uid: "o",
      start: "2026-09-29T22:00:00Z",
      end: "2026-09-29T23:00:00Z",
      allDay: false,
    },
  });
  const secondLecture = item("geo-lab", {
    kind: "event",
    title: "GEOSCI 100 Lab",
    courseId: "geo",
    calendar: {
      uid: "lab",
      start: "2026-09-30T01:00:00Z",
      end: "2026-09-30T02:00:00Z",
      allDay: false,
    },
  });
  const prep = buildTodayRail(
    [lecture, officeHoursTimed, secondLecture, slides7],
    NOW,
    TZ,
  ).suggestions.filter((s) => s.type === "prep");
  assert.deepEqual(
    prep.map((s) => s.id),
    ["prep:geo-lecture"],
  );
});

test("work blocks follow priority and never overlap events, the past, or a due time", () => {
  const work = rail.suggestions.filter((s) => s.type !== "prep");
  assert.deepEqual(
    work.map((s) => s.resourceId),
    ["ps3", "midterm", "essay"],
  );
  assert.equal(work.find((s) => s.resourceId === "midterm")?.type, "exam");
  const busy = rail.events.map((e) => [e.startMin, e.endMin ?? e.startMin + 30]);
  for (const s of rail.suggestions) {
    assert.ok(s.startMin >= 14 * 60, `${s.resourceId} starts in the past`);
    for (const [a, b] of busy)
      assert.ok(s.endMin <= a! || s.startMin >= b!, `${s.resourceId} overlaps`);
  }
  for (let i = 0; i < rail.suggestions.length; i++)
    for (let j = i + 1; j < rail.suggestions.length; j++) {
      const [x, y] = [rail.suggestions[i]!, rail.suggestions[j]!];
      assert.ok(x.endMin <= y.startMin || y.endMin <= x.startMin);
    }
  const ps = work.find((s) => s.resourceId === "ps3")!;
  assert.ok(ps.endMin <= 23 * 60 + 59);
  assert.match(ps.reason, /due tonight/i);
});

test("an empty day reports no sources rather than a free day", () => {
  const empty = buildTodayRail([], NOW, TZ);
  assert.equal(empty.hasCalendarSource, false);
  assert.equal(rail.hasCalendarSource, true);
});
