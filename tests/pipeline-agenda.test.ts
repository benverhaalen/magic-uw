import test from "node:test";
import assert from "node:assert/strict";
import { agenda, compileCourse, dayStart } from "../packages/core/src/graph/index";
import { course, idOf, NOW, seededStore, TODAY, TZ } from "./pipeline-fixture";

test("agenda: one entry per item across lists, the most authoritative date, grouped and sorted", async () => {
  const store = seededStore();
  await compileCourse(store, course, NOW);
  const result = agenda(store, { date: TODAY, tz: TZ, days: 14, now: NOW });
  const keys = result.entries.map((e) => e.key);
  assert.equal(new Set(keys).size, keys.length, "no duplicate entries");

  // Homework 1: assignments list, to-do list, module item and calendar feed become one entry,
  // dated by the assignments list (the to-do and calendar copies say a minute later).
  const hw1 = result.entries.filter((e) => e.title === "Homework 1");
  assert.equal(hw1.length, 1);
  assert.equal(hw1[0]!.at, "2026-10-02T04:59:00.000Z");
  assert.equal(hw1[0]!.authority, "assignments");
  assert.ok(hw1[0]!.resourceIds.includes(idOf(store, "account-todo", "1001")));
  assert.ok(hw1[0]!.resourceIds.length >= 4);
  assert.equal(hw1[0]!.group, "today", "due before local midnight tonight");
  assert.ok(hw1[0]!.references.some((r) => r.title === "Matrix notes"), "entries carry their references");

  // Overdue needs Canvas's missing flag; the quiz from a module item and the all-day event appear.
  assert.deepEqual(result.groups.overdue.map((e) => e.title), ["Homework 0"]);
  assert.ok(result.entries.some((e) => e.kind === "quiz" && e.title === "Quiz 1"));
  const review = result.entries.find((e) => e.title === "Review session")!;
  assert.equal(review.allDay, true);
  assert.equal(review.at, new Date(dayStart("2026-10-05", TZ)).toISOString());
  assert.equal(result.entries.find((e) => e.title === "Midterm Exam")?.kind, "exam");
  // A quoted exam date from the syllabus is a lower-priority entry, kept when nothing canonical covers that day.
  assert.ok(result.entries.some((e) => e.authority === "material_facts" && e.at === new Date(dayStart("2026-10-12", TZ)).toISOString()));

  // Sorted by time; groups partition the entries.
  const times = result.entries.map((e) => e.at);
  assert.deepEqual(times, [...times].sort());
  assert.equal(Object.values(result.groups).flat().length, result.entries.length);
  assert.ok(result.groups.week.every((e) => Date.parse(e.at) >= dayStart("2026-10-02", TZ) && Date.parse(e.at) < dayStart("2026-10-08", TZ)));
  store.close();
});

test("agenda: a quoted exam date is dropped when a canonical entry covers the same course and day", async () => {
  const store = seededStore();
  store.ingest({
    source: { id: "src-syllabus", label: "Example Canvas", kind: "canvas", accountScope: course.accountScope, courseId: course.courseId, scope: "syllabus" },
    observedAt: "2026-09-30T13:00:00.000Z",
    complete: true,
    status: "ok",
    resources: [
      {
        externalId: "syllabus", kind: "material", courseId: course.courseId, courseName: "Linear Algebra Example", title: "Syllabus",
        url: "https://canvas.wisc.edu/courses/101/assignments/syllabus", text: "Midterm exam on October 6.\n",
        deadlines: [], points: null, submitted: null, policy: { mode: "unknown", evidence: "" },
      },
    ],
  });
  await compileCourse(store, course, NOW);
  const result = agenda(store, { date: TODAY, tz: TZ, days: 14, now: NOW });
  const oct6 = result.entries.filter((e) => e.at.startsWith("2026-10-06") || e.at.startsWith("2026-10-07"));
  assert.deepEqual(oct6.map((e) => e.authority), ["assignments"]);
  store.close();
});
