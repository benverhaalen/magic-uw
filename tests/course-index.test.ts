import test from "node:test";
import assert from "node:assert/strict";
import type { ResourceView, SourceHealth } from "@magic/contracts";
import { buildCourseCards, type CourseCard } from "../packages/domain/src/course-page";
import { IDENTITY_HUES } from "../packages/ui/src/deadline-emphasis";
import {
  courseIdentityHues,
  coverageGroups,
  emptyNextText,
  sharedTerm,
} from "../apps/desktop/src/renderer/courses/course-index-view";

// Synthetic records only.
const now = "2026-09-27T12:00:00.000Z";
const source = (id: string, course: string, over: Partial<SourceHealth> = {}): SourceHealth => ({
  id, label: id, kind: "canvas", accountScope: "acct", courseId: course, scope: "assignments",
  status: "ok", lastAttemptAt: now, lastSuccessAt: now, complete: true, resourceCount: 1, ...over,
});
let n = 0;
function r(over: Partial<ResourceView> & { title: string }): ResourceView {
  n++;
  return {
    id: `r${n}`, sourceId: "s1", externalId: `e${n}`, kind: "assignment", courseId: "101",
    courseName: "ECON 101", url: `https://canvas.test/${n}`, text: "", links: [], deadlines: [],
    points: null, submitted: null, policy: { mode: "unknown", evidence: "" }, contentHash: `h${n}`,
    version: 1, observedAt: now, capturedAt: now, deleted: false, completed: false,
    deadline: { dueAt: null, planningAt: null, conflict: false, claims: [], reason: "" },
    kindLabel: null, ...over,
  } as ResourceView;
}
const due = (iso: string) => ({ deadline: { dueAt: iso, planningAt: iso, conflict: false, claims: [], reason: "" } }) as Partial<ResourceView>;
const card = (over: Partial<CourseCard>): CourseCard => ({
  key: "acct:1", courseId: "1", courseName: "Course", rawCourseName: "Course", code: null, cue: "",
  next: null, nextDeadline: null, freshness: "current_capture", syllabusMissing: true, term: null, lastSuccessAt: now,
  assignments: 1, undated: 0, ...over,
});

test("course cards carry term, checked time, assignment and undated counts from the course page", () => {
  const course = r({ title: "ECON 101", kind: "course", course: { termName: "Fall 2026" } });
  const dated = r({ title: "PS 2", ...due("2026-10-10T17:00:00.000Z") });
  const undated = r({ title: "Reflection" });
  const doneUndated = r({ title: "Survey", completed: true });
  const [c] = buildCourseCards({ resources: [course, dated, undated, doneUndated], sources: [source("s1", "101")], now });
  assert.equal(c!.term, "Fall 2026");
  assert.equal(c!.lastSuccessAt, now);
  assert.equal(c!.assignments, 3);
  assert.equal(c!.undated, 1, "an undated item known to be done is not counted");
  assert.equal(c!.next?.title, "PS 2");
});

test("course hues are distinct, keyed by identity not name, and independent of input order", () => {
  const n = IDENTITY_HUES.length;
  const keys = Array.from({ length: n }, (_, i) => `acct:${1000 + i}`);
  const hues = courseIdentityHues(keys);
  assert.equal(new Set(hues.values()).size, n, "every hue used once before any repeats");
  assert.deepEqual([...courseIdentityHues([...keys].reverse())], [...hues]);
  // Same course id under two accounts stays two identities.
  const split = courseIdentityHues(["a:101", "b:101"]);
  assert.notEqual(split.get("a:101"), split.get("b:101"));
});

test("a typical course load never puts wheel neighbours on two courses", () => {
  // Each placed course blocks at most three slots, so ceil(n / 3) courses always fit apart.
  const n = IDENTITY_HUES.length, max = Math.ceil(n / 3);
  for (let seed = 0; seed < 40; seed++) {
    const keys = Array.from({ length: max }, (_, i) => `acct:${seed * 97 + i * 13}`);
    const slots = [...courseIdentityHues(keys).values()].map((h) => IDENTITY_HUES.indexOf(h)).sort((a, b) => a - b);
    for (const s of slots) assert.ok(!slots.includes((s + 1) % n), `neighbours ${s} and ${(s + 1) % n}`);
  }
});

test("the heading names a term only when every course shares it", () => {
  assert.equal(sharedTerm([card({ term: "Fall 2026" }), card({ term: "Fall 2026" })]), "Fall 2026");
  assert.equal(sharedTerm([card({ term: "Fall 2026" }), card({ term: null })]), null);
  assert.equal(sharedTerm([card({ term: "Fall 2026" }), card({ term: "Spring 2027" })]), null);
  assert.equal(sharedTerm([]), null);
});

test("coverage notes list only courses that are not current, with their oldest checked time", () => {
  assert.deepEqual(coverageGroups([card({})]), []);
  const groups = coverageGroups([
    card({ key: "a", freshness: "stale", lastSuccessAt: "2026-09-25T10:00:00.000Z" }),
    card({ key: "b", freshness: "stale", lastSuccessAt: "2026-09-26T10:00:00.000Z" }),
    card({ key: "c", freshness: "partial" }),
    card({ key: "d", freshness: "unknown", lastSuccessAt: null }),
  ]);
  assert.deepEqual(groups.map((g) => [g.freshness, g.cards.map((c) => c.key), g.checkedAt]), [
    ["stale", ["a", "b"], "2026-09-25T10:00:00.000Z"],
    ["partial", ["c"], now],
    ["unknown", ["d"], null],
  ]);
});

test("no upcoming work is an all-clear only for a complete current capture", () => {
  assert.equal(emptyNextText({ freshness: "current_capture", assignments: 4 }), "No upcoming dated work");
  for (const freshness of ["partial", "stale", "unknown"] as const)
    assert.match(emptyNextText({ freshness, assignments: 4 }), /in the saved copy$/);
  assert.equal(emptyNextText({ freshness: "current_capture", assignments: 0 }), "No assignments found");
});


test("course next-work projection suppresses a disputed saved date", () => {
  const assignment = r({ title: "Problem set 2", ...due("2026-10-10T17:00:00.000Z") });
  assignment.deadline!.conflict = true;
  const [c] = buildCourseCards({ resources: [assignment], sources: [source("s1", "101")], now });
  assert.equal(c!.nextDeadline?.displayAt, null);
  assert.equal(c!.nextDeadline?.cue, "Dates disagree");
  assert.equal(c!.nextDeadline?.sortAt, "2026-10-10T17:00:00.000Z");
});
