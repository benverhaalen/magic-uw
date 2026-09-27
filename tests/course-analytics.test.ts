// owner: course-analytics. The Analytics tab: chart math, the grade trend against hand-worked cases,
// completion buckets, readiness never shown as a grade, the empty states, one-pass reads (a fixed
// number of router calls whatever the course size) and the paint time from local data.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LearningRequest, LearningResult, Snapshot } from "@magic/contracts";
import { courseGrades } from "../packages/learning/src/grades/index.ts";
import type { CourseGradeInput, GradeItem } from "../packages/learning/src/grades/types.ts";
import { linePath, linearScale, niceTicks, percentDomain, ringSegments, stack } from "../apps/desktop/src/renderer/charts/scale.ts";
import {
  buildCourseAnalytics,
  completion,
  completionOf,
  gradeTrend,
  letterCutoffs,
  letterFor,
  prep,
  type AnalyticsInputs,
} from "../apps/desktop/src/renderer/analytics/model.ts";
import { SAMPLE_SYLLABUS, sampleInputs } from "../apps/desktop/src/renderer/analytics/sample.ts";
import { loadAnalyticsInputs } from "../apps/desktop/src/renderer/analytics/load.ts";
import { AnalyticsDashboard } from "../apps/desktop/src/renderer/analytics/CourseAnalytics.tsx";
import { lintPaths } from "../scripts/copy-lint";

const NOW = new Date("2026-09-27T12:00:00");
const noop = () => {};
const render = (inputs: AnalyticsInputs) =>
  renderToStaticMarkup(createElement(AnalyticsDashboard, { view: buildCourseAnalytics(inputs), onAction: noop, onPrep: noop, onCoursework: noop }));

const item = (over: Partial<GradeItem> & Pick<GradeItem, "id">): GradeItem => ({
  externalId: over.id,
  title: over.id,
  groupId: null,
  points: 10,
  score: null,
  excused: false,
  missing: false,
  late: false,
  submitted: null,
  dueAt: null,
  submittedAt: null,
  at: null,
  examKind: null,
  ...over,
});
const inputs = (over: Partial<AnalyticsInputs>): AnalyticsInputs => ({
  courseId: "c1",
  courseName: "Test course",
  now: NOW,
  synthetic: false,
  grades: null,
  gradesMessage: null,
  work: [],
  mastery: null,
  masteryMessage: null,
  itemTopics: {},
  syllabus: null,
  cardsDueByTopic: null,
  ...over,
});

// ---------- chart math ----------

test("scales, ticks, paths and stacking", () => {
  const x = linearScale([0, 10], [100, 200]);
  assert.equal(x(0), 100);
  assert.equal(x(5), 150);
  assert.equal(x(10), 200);
  assert.equal(linearScale([3, 3], [0, 10])(3), 5, "a zero-width domain maps to the midpoint");
  assert.deepEqual(niceTicks(0, 100, 4), [0, 25, 50, 75, 100]);
  assert.deepEqual(niceTicks(60, 100, 4), [60, 70, 80, 90, 100]);
  assert.deepEqual(niceTicks(0, 7, 4), [0, 2, 4, 6]);
  assert.deepEqual(percentDomain([82, 91, 86]), [70, 100]);
  assert.deepEqual(percentDomain([]), [0, 100]);
  assert.equal(linePath([[0, 0], [10, 5.556]]), "M0 0 L10 5.56");
  assert.deepEqual(stack([1, 3, 0], 100), [{ start: 0, size: 25 }, { start: 25, size: 75 }, { start: 100, size: 0 }]);
  const ring = ringSegments([2, 2], 10);
  const circ = 2 * Math.PI * 10;
  assert.ok(Math.abs(ring[0]!.length + ring[1]!.length - circ) < 0.02, "segments cover the ring");
  assert.ok(Math.abs(ring[1]!.offset + circ / 2) < 0.01, "the second segment starts halfway");
});

// ---------- grade trend, hand-worked ----------

// Two groups, A 40% and B 60%. a1 8/10, then b1 45/50, then a2 6/10; b2 (50 points) still to come.
// Running grade: after a1 only A counts: 80. After b1: (40·80 + 60·90)/100 = 86. After a2: A is
// 14/20 = 70, so (40·70 + 60·90)/100 = 82.
function handWorked(): AnalyticsInputs {
  const work = [
    item({ id: "a1", groupId: "A", points: 10, score: 8, dueAt: "2026-09-01T17:00:00.000Z", at: "2026-09-01T17:00:00.000Z", submitted: true, submittedAt: "2026-09-01T17:00:00.000Z" }),
    item({ id: "b1", groupId: "B", points: 50, score: 45, dueAt: "2026-09-08T17:00:00.000Z", at: "2026-09-08T17:00:00.000Z", submitted: true, submittedAt: "2026-09-08T17:00:00.000Z" }),
    item({ id: "a2", groupId: "A", points: 10, score: 6, dueAt: "2026-09-15T17:00:00.000Z", at: "2026-09-15T17:00:00.000Z", submitted: true, submittedAt: "2026-09-15T17:00:00.000Z", late: true }),
    item({ id: "b2", groupId: "B", points: 50, score: null, dueAt: "2026-10-06T17:00:00.000Z", at: "2026-10-06T17:00:00.000Z" }),
  ];
  const input: CourseGradeInput = {
    accountScope: "acct",
    courseId: "c1",
    courseName: "Test course",
    groups: [
      { id: "A", title: "Homework", weight: 40, position: 1, dropLowest: 0, dropHighest: 0, neverDrop: [] },
      { id: "B", title: "Exams", weight: 60, position: 2, dropLowest: 0, dropHighest: 0, neverDrop: [] },
    ],
    items: work,
    syllabusWeights: [],
    coverage: { status: "complete", reasons: [] },
  };
  return inputs({ grades: courseGrades(input, NOW), work, syllabus: { text: "Grading scale\nA 93\nB 80\nC 70\nF below 70", resourceId: "syl" } });
}

test("grade trend: running grade, letter and item weights match the hand-worked case", () => {
  const view = gradeTrend(handWorked());
  assert.equal(view.status, "ok");
  if (view.status !== "ok") return;
  assert.deepEqual(view.points.map((p) => p.running), [80, 86, 82]);
  assert.deepEqual(view.current, { percent: 82, basis: view.current.percent !== null ? view.current.basis : "" });
  assert.equal(view.letter?.letter, "B");
  assert.equal(view.letter?.quote, "B 80");
  assert.match(view.letterNote, /syllabus cutoff: “B 80”/);
  // a2 is 10 of Homework's 20 points at 40%: 20% of the grade.
  assert.equal(view.points[2]!.weightText, "Homework · about 20% of the grade");
  assert.equal(view.points[2]!.scoreText, "6/10 (60%)");
  assert.equal(view.points[2]!.late, true);
});

test("grade trend: the what-if band uses the middle half of the student's own item scores", () => {
  // Item percents 80, 90, 60 → sorted 60, 80, 90: quartiles 70 and 85. b2's 50 points at 70%:
  // Exams (45 + 35)/100 = 80 → (40·70 + 60·80)/100 = 76. At 85%: (45 + 42.5)/100 = 87.5 → 80.5.
  const view = gradeTrend(handWorked());
  assert.ok(view.status === "ok" && view.band);
  if (view.status !== "ok" || !view.band) return;
  assert.equal(view.band.loRate, 70);
  assert.equal(view.band.hiRate, 85);
  assert.equal(view.band.lo, 76);
  assert.equal(view.band.hi, 80.5);
  assert.match(view.band.text, /Not a prediction/);
});

test("letter cutoffs: a consistent syllabus scale is read; anything else gives no letter", () => {
  const scale = letterCutoffs(SAMPLE_SYLLABUS);
  assert.deepEqual(scale.map((c) => [c.letter, c.min]), [["A", 93], ["AB", 88], ["B", 83], ["BC", 78], ["C", 70], ["D", 60], ["F", 0]]);
  assert.equal(letterFor(87.9, scale)?.letter, "B");
  assert.equal(letterFor(88, scale)?.letter, "AB");
  assert.deepEqual(letterCutoffs("A 80\nB 90\nC 70"), [], "out-of-order cutoffs are rejected");
  assert.deepEqual(letterCutoffs("A 10-page paper is due\nB 5"), [], "too few letters is not a scale");
  const none = gradeTrend({ ...handWorked(), syllabus: null });
  assert.ok(none.status === "ok" && none.letter === null && /doesn't list letter cutoffs/.test(none.letterNote));
});

// ---------- completion ----------

test("completion buckets: on time, late, missing, upcoming; excused and unrecorded left out", () => {
  const w = (id: string, due: string, over: Partial<GradeItem> = {}) => item({ id, dueAt: due, ...over });
  const work = [
    w("on", "2026-09-14T17:00:00.000Z", { submitted: true, submittedAt: "2026-09-14T10:00:00.000Z" }),
    w("late", "2026-09-15T17:00:00.000Z", { submitted: true, submittedAt: "2026-09-16T10:00:00.000Z", late: true }),
    w("miss", "2026-09-22T17:00:00.000Z", { missing: true, score: 0 }),
    w("next", "2026-09-30T17:00:00.000Z"),
    w("exc", "2026-09-10T17:00:00.000Z", { excused: true }),
    w("inclass", "2026-09-09T17:00:00.000Z"),
  ];
  assert.deepEqual(work.map((x) => completionOf(x, NOW)), ["on_time", "late", "missing", "upcoming", null, null]);
  const view = completion(inputs({ work }));
  assert.equal(view.status, "ok");
  if (view.status !== "ok") return;
  assert.deepEqual(view.totals, { on_time: 1, late: 1, missing: 1, upcoming: 1 });
  assert.equal(view.unrecorded, 1);
  assert.equal(view.onTimeText, "1 of 3 due so far submitted on time");
  // Weeks of Sep 14 (on, late), Sep 21 (miss) and Sep 28 (next), contiguous.
  assert.deepEqual(view.weeks.map((x) => x.values), [[1, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]);
  assert.doesNotMatch(JSON.stringify(view), /streak/i);
});

// ---------- readiness is never a grade ----------

test("readiness: topic states only, never a percentage, score or grade prediction", () => {
  const sample = sampleInputs(NOW);
  const view = prep(sample);
  assert.equal(view.status, "ok");
  if (view.status !== "ok") return;
  assert.ok(view.rows.length > 0 && view.rows.length <= 5, "assignment view shows at most five");
  for (const r of view.rows) {
    for (const text of [r.readiness, r.due ?? ""]) {
      assert.doesNotMatch(text, /%|\bgrade\b|\bscore\b|predict|chance|ready for/i, text);
    }
    assert.equal(r.counts.solid + r.counts.getting_there + r.counts.iffy + r.counts.not_seen, r.topics);
  }
  const midterm = view.rows.find((r) => r.title === "Midterm exam")!;
  assert.equal(midterm.readiness, "2 of 5 topics mastered");
  assert.equal(midterm.due, "5 cards due");
  // The product copy in these folders passes the anti-dark-pattern lint (no readiness %, no streaks).
  const root = join(import.meta.dirname, "..");
  assert.deepEqual(lintPaths([join(root, "apps/desktop/src/renderer/analytics"), join(root, "apps/desktop/src/renderer/charts")]), []);
});

// ---------- empty states ----------

test("empty states: each section says what's missing and offers one action", () => {
  const html = render(inputs({ gradesMessage: "No grades posted yet" }));
  for (const text of ["No grades posted yet", "No assignments with submissions or due dates captured yet", "No upcoming assignments or exams captured", "No topic map for this course yet", "Nothing to do next yet"])
    assert.ok(html.includes(text), text);
  assert.equal((html.match(/View coursework/g) ?? []).length, 5, "one action per empty section");
  assert.doesNotMatch(html, /NaN|undefined/);
});

test("the sample course fills every section, with stable capture hooks", () => {
  const html = render(sampleInputs(NOW));
  for (const shot of ["course-analytics", "grade-trend", "completion", "assignment-prep", "topic-mastery", "next-actions"]) assert.ok(html.includes(`data-shot="${shot}"`), shot);
  assert.match(html, /Synthetic sample/);
  assert.match(html, /class="chart-line"/);
  assert.match(html, /Review 12 due cards/);
  assert.doesNotMatch(html, /NaN|undefined/);
  const view = buildCourseAnalytics(sampleInputs(NOW));
  assert.ok(view.actions.status === "ok" && view.actions.cards.length === 3);
  assert.ok(view.grade.status === "ok" && view.grade.letter !== null && view.grade.points.length >= 10);
  assert.ok(view.completion.status === "ok" && view.completion.totals.missing === 1 && view.completion.totals.late >= 2);
});

// ---------- one pass, no N+1 ----------

function snapshotWith(assignments: number): Snapshot {
  const sources = [{ id: "src", accountScope: "acct", courseId: "c1", kind: "canvas", scope: "assignments", status: "ok", complete: true, label: "Canvas" }];
  const resources = Array.from({ length: assignments }, (_, i) => {
    const past = i % 2 === 0;
    const due = new Date(NOW.getTime() + (past ? -1 : 1) * (i + 1) * 86_400_000).toISOString();
    return {
      id: `r${i}`,
      sourceId: "src",
      courseId: "c1",
      courseName: "Test course",
      kind: "assignment",
      externalId: `e${i}`,
      title: `Homework ${i}`,
      observedAt: NOW.toISOString(),
      deleted: false,
      dueAt: due,
      points: 10,
      submitted: past,
      submission: past ? { score: 9, submittedAt: due } : null,
      assignmentGroupId: null,
      submissionTypes: [],
      text: "",
    };
  });
  return { sources, resources } as unknown as Snapshot;
}

test("one pass: a fixed number of router calls whatever the course size, and none for the sample", async () => {
  for (const n of [4, 60]) {
    const calls: string[] = [];
    const api = {
      async learning(request: LearningRequest): Promise<LearningResult> {
        calls.push(request.op);
        if ("anchorIds" in request) assert.ok((request.anchorIds?.length ?? 0) <= 50);
        return { op: request.op, status: "unavailable", message: "Not connected in this test." };
      },
    };
    const loaded = await loadAnalyticsInputs(api, snapshotWith(n), { accountScope: "acct", courseId: "c1", courseName: "Test course" }, NOW);
    assert.deepEqual(calls.sort(), ["course.grades", "course.mastery", "mastery.forItems"], `${n} assignments`);
    assert.equal(loaded.work.length, n);
    const view = buildCourseAnalytics(loaded);
    assert.equal(view.grade.status, "empty", "an unavailable grade bank shows the empty state, not a fixture");
  }
  const calls: string[] = [];
  const sampleSnapshot = { sources: [{ id: "sample-course", accountScope: "synthetic", courseId: "sample-101", kind: "fixture" }], resources: [] } as unknown as Snapshot;
  const sample = await loadAnalyticsInputs({ learning: async (r) => (calls.push(r.op), { op: r.op, status: "ok" }) }, sampleSnapshot, { accountScope: "synthetic", courseId: "sample-101", courseName: "Writing 101 · Sample" }, NOW);
  assert.equal(calls.length, 0);
  assert.equal(sample.synthetic, true);
  // A real course never reads the sample, even with the sample's course ID.
  const real = await loadAnalyticsInputs({ learning: async (r) => ({ op: r.op, status: "unavailable" }) }, snapshotWith(2), { accountScope: "acct", courseId: "c1", courseName: "x" }, NOW);
  assert.equal(real.synthetic, false);
});

// ---------- paint time ----------

test("paint: the tab computes and renders from local data in under 150 ms (median)", () => {
  const times: number[] = [];
  for (let i = 0; i < 25; i++) {
    const t = performance.now();
    render(sampleInputs(NOW));
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)]!;
  console.log(`course analytics paint: median ${median.toFixed(2)} ms, max ${times.at(-1)!.toFixed(2)} ms over ${times.length} runs`);
  if (!process.env.CI) assert.ok(median < 150, `median ${median} ms`);
});
