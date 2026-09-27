import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTodayRail,
  projectWork,
  resolveDeadline,
  type RailResource,
} from "@magic/domain";
import type { DeadlineClaim } from "@magic/contracts";

const TZ = "America/Chicago";
const NOW = "2026-09-29T19:00:00.000Z"; // Tue Sep 29, 2:00 PM CDT
const due = (value: string): DeadlineClaim => ({
  value,
  kind: "due",
  quote: "due_at",
  authority: "structured",
  scopeConfirmed: true,
});
const work = (id: string, dueAt: string | null, over: Partial<RailResource> = {}): RailResource => ({
  id,
  kind: "assignment",
  title: id,
  courseId: "c",
  courseName: "Course",
  completed: false,
  submitted: null,
  deadline: resolveDeadline(dueAt ? [due(dueAt)] : []),
  kindLabel: null,
  ...over,
});

const items = [
  work("tonight", "2026-09-30T04:59:00Z"),
  work("earlier-today-missed", "2026-09-29T15:00:00Z", { lockAt: "2026-09-30T04:59:00Z" }),
  work("tomorrow", "2026-09-30T22:15:00Z"),
  work("friday-quiz", "2026-10-03T04:59:00Z", { title: "Module 3 Quiz" }),
  work("next-month", "2026-10-29T04:59:00Z"),
  work("submitted", "2026-10-01T04:59:00Z", { submitted: true }),
  work("excused", "2026-10-01T04:59:00Z", { submission: { excused: true } }),
  work("locked-out", "2026-09-27T04:59:00Z", { lockAt: "2026-09-28T04:59:00Z" }),
  work("no-date", null),
  { ...work("reading", "2026-10-01T04:59:00Z"), kind: "material" as const },
];
const view = projectWork(items, NOW, TZ);

test("open work splits once into overdue, due today, and upcoming; nothing appears twice", () => {
  assert.deepEqual(view.overdue.map((w) => w.id), ["earlier-today-missed"]);
  assert.deepEqual(view.dueToday.map((w) => w.id), ["tonight"]);
  assert.deepEqual(view.upcoming.map((w) => w.id), ["tomorrow", "friday-quiz", "next-month"]);
  const all = [...view.overdue, ...view.dueToday, ...view.upcoming].map((w) => w.id);
  assert.equal(new Set(all).size, all.length);
});

test("submitted, excused, past-lock, undated, and non-assignment items are not upcoming work", () => {
  const all = [...view.overdue, ...view.dueToday, ...view.upcoming].map((w) => w.id);
  for (const id of ["submitted", "excused", "locked-out", "no-date", "reading"])
    assert.equal(all.includes(id), false, id);
});

test("each item carries what Upcoming rows need: local due label, exam flag, and effort", () => {
  const quiz = view.upcoming.find((w) => w.id === "friday-quiz")!;
  assert.equal(quiz.dueDate, "2026-10-02");
  assert.equal(quiz.dueMin, 23 * 60 + 59);
  assert.equal(quiz.effort?.category, "quiz");
  assert.equal(view.upcoming.find((w) => w.id === "tomorrow")?.isExam, false);
});

test("the rail's due list and suggestions come from the same projection as Upcoming", () => {
  const rail = buildTodayRail(items, NOW, TZ);
  assert.deepEqual(rail.due.map((d) => d.id), view.dueToday.map((w) => w.id));
  const known = new Set([...view.overdue, ...view.dueToday, ...view.upcoming].map((w) => w.id));
  for (const s of rail.suggestions.filter((s) => s.type !== "prep"))
    assert.ok(known.has(s.resourceId), `${s.resourceId} is not in the shared projection`);
  assert.equal(rail.suggestions.some((s) => s.resourceId === "next-month"), false, "rail only plans the next 7 days");
});

test("the planned total counts only accepted blocks; suggestions are counted separately", () => {
  const rail = buildTodayRail(items, NOW, TZ);
  assert.equal(rail.plannedMin, 0);
  assert.ok(rail.suggestedMin > 0);
});
