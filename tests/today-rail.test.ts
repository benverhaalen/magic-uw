import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTodayRail,
  effortBand,
  planEntry,
  resolveDeadline,
  validatePlanEdit,
  type PlanEntry,
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
  assert.equal(effortBand(item("f", { title: "Final exam" }))?.category, "exam");
  assert.equal(effortBand(item("fp", { title: "Final project milestone" }))?.category, "project");
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

test("overdue work Canvas still accepts comes first; past-lock and excused work is dropped", () => {
  const stillOpen = item("late-lab", {
    title: "Lab report 2",
    dueAt: "2026-09-28T04:59:00Z",
    lockAt: "2026-10-02T04:59:00Z",
    submission: { missing: true },
  });
  const locked = item("locked", {
    title: "Reading quiz 3",
    dueAt: "2026-09-27T04:59:00Z",
    lockAt: "2026-09-28T04:59:00Z",
    submission: { missing: true },
  });
  const excused = item("excused", {
    title: "Problem Set #9",
    dueAt: "2026-09-30T04:59:00Z",
    submission: { excused: true },
  });
  const s = buildTodayRail([stillOpen, locked, excused, problemSet], NOW, TZ)
    .suggestions.filter((x) => x.type !== "prep");
  assert.equal(s[0]?.resourceId, "late-lab");
  assert.match(s[0]!.reason, /overdue/i);
  assert.match(s[0]!.reason, /still accept/i);
  assert.equal(s.some((x) => x.resourceId === "locked" || x.resourceId === "excused"), false);
});

test("a tight deadline beats an exam that has room", () => {
  const project = item("project", {
    title: "Final project milestone",
    dueAt: "2026-10-01T01:00:00Z", // 30 h away, est. up to 8 h
  });
  const s = buildTodayRail([project, midterm], NOW, TZ).suggestions;
  assert.deepEqual(
    s.map((x) => x.resourceId).slice(0, 2),
    ["project", "midterm"],
  );
  assert.match(s.find((x) => x.resourceId === "project")!.reason, /tight/i);
});

const group = (id: string, courseId: string, title: string, weight: number) =>
  item(`group-${id}`, {
    kind: "material",
    externalId: id,
    title,
    courseId,
    assignmentGroup: { weight },
  });

test("grade share breaks ties only when the course's group weights add up to 100%", () => {
  const big = item("big", {
    title: "Problem Set #5",
    courseId: "econ",
    courseName: "ECON 102",
    dueAt: "2026-10-04T04:59:00Z",
    points: 20,
    assignmentGroupId: "g-hw",
  });
  const small = item("small", {
    title: "Problem Set #4",
    courseId: "stat",
    courseName: "STAT 240",
    dueAt: "2026-10-03T04:59:00Z",
    points: 20,
    assignmentGroupId: "g-q",
  });
  const weighted = [
    group("g-hw", "econ", "Homework", 40),
    group("g-ex", "econ", "Exams", 60),
    group("g-q", "stat", "Quizzes", 5),
    group("g-f", "stat", "Final", 95),
  ];
  const ranked = buildTodayRail([big, small, ...weighted], NOW, TZ).suggestions;
  assert.deepEqual(ranked.map((s) => s.resourceId), ["big", "small"].filter((id) => ranked.some((s) => s.resourceId === id)));
  assert.equal(ranked[0]?.resourceId, "big");
  assert.match(ranked[0]!.reason, /40% of the ECON 102 grade/);

  const unweighted = [
    group("g-hw", "econ", "Homework", 0),
    group("g-q", "stat", "Quizzes", 0),
  ];
  const byDate = buildTodayRail([big, small, ...unweighted], NOW, TZ).suggestions;
  assert.equal(byDate[0]?.resourceId, "small");
  assert.doesNotMatch(byDate[0]!.reason, /% of/);
});

test("exam review is spread into sessions before the exam", () => {
  const s = rail.suggestions.find((x) => x.type === "exam")!;
  assert.match(s.title, /session 1 of 2/);
});

test("suggestions leave breathing room: a daily cap and breaks between blocks", () => {
  const many = Array.from({ length: 8 }, (_, i) =>
    item(`ps-${i}`, { title: `Problem Set #${i + 10}`, dueAt: "2026-10-02T04:59:00Z" }),
  );
  for (const r of [rail, buildTodayRail(many, NOW, TZ)]) {
    const work = r.suggestions.filter((s) => s.type !== "prep");
    assert.ok(work.reduce((n, s) => n + s.endMin - s.startMin, 0) <= 180);
    // Proposed and accepted minutes stay distinct (Ben's platform review).
    assert.equal(r.plannedMin + r.suggestedMin, r.suggestions.reduce((n, s) => n + s.endMin - s.startMin, 0));
    const blocks = [...r.suggestions].sort((a, b) => a.startMin - b.startMin);
    for (let i = 1; i < blocks.length; i++)
      if (blocks[i - 1]!.type !== "prep" && blocks[i]!.type !== "prep")
        assert.ok(blocks[i]!.startMin - blocks[i - 1]!.endMin >= 15, "needs a break");
  }
});

test("prep never mistakes a grade category for course material", () => {
  const hwGroup = { ...group("g1", "geo", "Homework", 30), updatedAt: "2026-09-29T12:00:00Z" };
  const prep = buildTodayRail([lecture, slides7, hwGroup], NOW, TZ).suggestions.find((s) => s.type === "prep");
  assert.equal(prep?.resourceId, "slides-7");
});

// ---- The student's plan: accept, skip, edit, and completion ----

test("an accepted block stays on the plan and crosses out once Canvas reports the submission", () => {
  const block = rail.suggestions.find((s) => s.resourceId === "ps3")!;
  const plan = [planEntry(block, rail.date, "accepted")];
  const planned = buildTodayRail(all, NOW, TZ, plan).suggestions.find((s) => s.id === block.id)!;
  assert.equal(planned.state, "planned");
  assert.equal(planned.doneBy, null);

  const afterRefresh = all.map((r) => (r.id === "ps3" ? { ...r, submitted: true } : r));
  const done = buildTodayRail(afterRefresh, NOW, TZ, plan).suggestions.find((s) => s.id === block.id)!;
  assert.equal(done.state, "done");
  assert.equal(done.doneBy, "canvas");
  assert.equal(done.startMin, block.startMin);
});

test("a skipped suggestion does not come back after refresh", () => {
  const block = rail.suggestions.find((s) => s.resourceId === "midterm")!;
  const next = buildTodayRail(all, NOW, TZ, [planEntry(block, rail.date, "skipped")]);
  assert.equal(next.suggestions.some((s) => s.id === block.id), false);
});

test("study blocks are marked done by the student; assignment blocks only by Canvas", () => {
  const prep = rail.suggestions.find((s) => s.type === "prep")!;
  const exam = rail.suggestions.find((s) => s.type === "exam")!;
  const work = rail.suggestions.find((s) => s.resourceId === "ps3")!;
  const at = "2026-09-29T19:30:00.000Z";
  const plan: PlanEntry[] = [prep, exam, work].map((s) => ({ ...planEntry(s, rail.date, "accepted"), doneAt: at }));
  const byId = new Map(buildTodayRail(all, NOW, TZ, plan).suggestions.map((s) => [s.id, s]));
  assert.equal(byId.get(prep.id)?.doneBy, "student");
  assert.equal(byId.get(exam.id)?.doneBy, "student");
  // A self-report cannot stand in for a Canvas submission.
  assert.equal(byId.get(work.id)?.state, "planned");
});

test("an edited block keeps the student's time and title, and new suggestions avoid it", () => {
  const block = rail.suggestions.find((s) => s.resourceId === "essay")!;
  const edited: PlanEntry = {
    ...planEntry(block, rail.date, "accepted"),
    block: { ...planEntry(block, rail.date, "accepted").block, title: "Outline the essay", startMin: 14 * 60 + 30, endMin: 15 * 60 + 15 },
  };
  const next = buildTodayRail(all, NOW, TZ, [edited]);
  const kept = next.suggestions.find((s) => s.id === block.id)!;
  assert.deepEqual([kept.title, kept.startMin, kept.endMin, kept.state], ["Outline the essay", 870, 915, "planned"]);
  for (const s of next.suggestions.filter((s) => s.id !== block.id))
    assert.ok(s.endMin + 15 <= 870 || s.startMin >= 915 + 15, `${s.id} crowds the edited block`);
});

test("plan entries from another day are ignored", () => {
  const block = rail.suggestions.find((s) => s.resourceId === "midterm")!;
  const next = buildTodayRail(all, NOW, TZ, [planEntry(block, "2026-09-28", "skipped")]);
  assert.equal(next.suggestions.some((s) => s.id === block.id && s.state === "suggested"), true);
});

test("edits are validated: a real time range, and a warning when it overlaps class", () => {
  assert.equal(validatePlanEdit({ startMin: 900, endMin: 900 }, rail.events).ok, false);
  assert.equal(validatePlanEdit({ startMin: 23 * 60, endMin: 24 * 60 + 30 }, rail.events).ok, false);
  const overlap = validatePlanEdit({ startMin: 16 * 60, endMin: 17 * 60 }, rail.events);
  assert.equal(overlap.ok, true);
  assert.deepEqual(overlap.overlaps, ["GEOSCI 100 Lecture"]);
});

test("tight counts only free time: classes and meetings before the deadline are subtracted", () => {
  // Due in 36 h, estimated up to 8 h: roomy on raw hours (36 - 8 = 28 h spare).
  const project = item("proj", { title: "Final project milestone", dueAt: "2026-10-01T07:00:00Z" });
  const roomy = buildTodayRail([project], NOW, TZ).suggestions.find((s) => s.resourceId === "proj")!;
  assert.doesNotMatch(roomy.reason, /tight/i);
  // Six hours of meetings tomorrow leave 30 h free, so only 22 h spare: tight.
  const meetings = [0, 1, 2].map((i) =>
    item(`mtg-${i}`, {
      kind: "event",
      title: `Meeting ${i}`,
      calendar: {
        uid: `m${i}`,
        start: `2026-09-30T${14 + i * 2}:00:00Z`,
        end: `2026-09-30T${16 + i * 2}:00:00Z`,
        allDay: false,
      },
    }),
  );
  const tight = buildTodayRail([project, ...meetings], NOW, TZ).suggestions.find((s) => s.resourceId === "proj")!;
  assert.match(tight.reason, /tight/i);
  assert.match(tight.reason, /6 h of classes and meetings/);
});

test("an accepted block keeps its reasons; only a done block swaps them for its completion", () => {
  const block = rail.suggestions.find((s) => s.resourceId === "ps3")!;
  const plan = [planEntry(block, rail.date, "accepted")];
  const planned = buildTodayRail(all, NOW, TZ, plan).suggestions.find((s) => s.id === block.id)!;
  assert.deepEqual(planned.factors, block.factors);
  assert.equal(planned.reason, block.reason);
  const prep = rail.suggestions.find((s) => s.type === "prep")!;
  const plannedPrep = buildTodayRail(all, NOW, TZ, [planEntry(prep, rail.date, "accepted")]).suggestions.find((s) => s.id === prep.id)!;
  assert.deepEqual(plannedPrep.factors, prep.factors);
  const submitted = all.map((r) => (r.id === "ps3" ? { ...r, submitted: true } : r));
  const done = buildTodayRail(submitted, NOW, TZ, plan).suggestions.find((s) => s.id === block.id)!;
  assert.equal(done.reason, "Submitted on Canvas.");
});
