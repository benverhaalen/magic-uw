// owner: mastery (D57). The grade bank: listed weights, group drops, coverage → unknown, the FDB-001
// rules (account boundary, partial capture, dropped scores), trajectories and slipping detection
// against the student's own earlier level. Synthetic grade histories only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../packages/storage/src/index";
import {
  assignmentShare,
  courseGrade,
  courseGrades,
  gradeInputs,
  gradeTrajectory,
  resolveWeights,
  syllabusWeights,
  trend,
  type CourseGradeInput,
  type GradeGroup,
  type GradeItem,
} from "../packages/learning/src/grades";

const group = (id: string, title: string, weight: number | null, extra: Partial<GradeGroup> = {}): GradeGroup => ({ id, title, weight, position: 0, dropLowest: 0, dropHighest: 0, neverDrop: [], ...extra });
const item = (id: string, groupId: string | null, points: number | null, score: number | null, at: string | null, extra: Partial<GradeItem> = {}): GradeItem => ({
  id, externalId: id, title: id, groupId, points, score, excused: false, missing: false, late: false, submitted: score !== null, dueAt: at, submittedAt: at, at, examKind: null, ...extra,
});
const course = (groups: GradeGroup[], items: GradeItem[], extra: Partial<CourseGradeInput> = {}): CourseGradeInput => ({
  accountScope: "acct", courseId: "C1", courseName: "Course", groups, items, syllabusWeights: [], coverage: { status: "complete", reasons: [] }, ...extra,
});
const day = (d: number) => new Date(Date.UTC(2026, 8, d, 12)).toISOString();
const series = (percents: number[]) => percents.map((p, i) => ({ at: day(i + 1), itemId: `x${i}`, percent: p }));

test("trend: slipping is a run to the latest item below the student's own earlier level; a recovered dip isn't", () => {
  assert.deepEqual(trend(series([95, 92, 96, 90, 70, 72, 68])), { kind: "slipping", since: day(5), sinceItemId: "x4", earlier: 93.5, recent: 70, items: 3 });
  assert.deepEqual(trend(series([60, 65, 62, 80, 85, 82])), { kind: "rising", since: day(4), sinceItemId: "x3", earlier: 62, recent: 82, items: 3 });
  assert.equal(trend(series([95, 92, 96, 70, 72, 94])).kind, "steady", "the dip recovered at the latest item");
  assert.deepEqual(trend(series([88, 90, 85, 91, 89, 87])), { kind: "steady", level: 88.5, items: 6 });
  assert.deepEqual(trend(series([90, 60, 55])), { kind: "too_few", items: 3 });
  // The earliest start of a run that reaches the end: slipping "since week 5", not "since the last item".
  assert.equal((trend(series([90, 92, 91, 94, 70, 60, 65, 62])) as { since: string }).since, day(5));
});

test("trajectory: per group and for the course, running figures, and slipping labs beside steady quizzes", () => {
  const input = course(
    [group("q", "Quizzes", 40), group("l", "Labs", 60)],
    [
      ...[88, 90, 86, 91, 89, 90].map((p, i) => item(`q${i}`, "q", 10, p / 10, day(1 + i * 7))),
      ...[95, 96, 94, 70, 68, 72].map((p, i) => item(`l${i}`, "l", 20, (p * 20) / 100, day(3 + i * 7))),
      item("undated", "q", 10, 9, null),
    ],
  );
  const t = gradeTrajectory(input);
  const labs = t.groups.find((g) => g.title === "Labs")!;
  const quizzes = t.groups.find((g) => g.title === "Quizzes")!;
  assert.equal(labs.trend.kind, "slipping");
  assert.equal((labs.trend as { since: string }).since, day(3 + 3 * 7));
  assert.equal(quizzes.trend.kind, "steady");
  assert.equal(t.undated, 1, "an undated score isn't placed on the timeline");
  assert.equal(t.course.length, 12);
  // The course's running figure is the weighted grade over the groups seen so far.
  assert.equal(t.course[0]!.running, 88);
  // Quizzes 53.4 of 60 (89), labs 99 of 120 (82.5): 0.4·89 + 0.6·82.5.
  assert.equal(t.course.at(-1)!.running, 85.1);
});

test("weights: Canvas when they add up to 100; else the syllabus lines; else unknown, and then no course figure", () => {
  const items = [item("a", "hw", 10, 8, day(1)), item("b", "ex", 50, 40, day(2))];
  assert.equal(resolveWeights(course([group("hw", "Homework", 40), group("ex", "Exams", 60)], items)).status, "known");
  const noCanvas = course([group("hw", "Homework", null), group("ex", "Exams", null)], items, {
    syllabusWeights: syllabusWeights("Grading:\nHomework: 30%\n- Exams — 70 %\nOffice hours: Tuesdays", "syl"),
  });
  const w = resolveWeights(noCanvas);
  assert.equal(w.status, "known");
  if (w.status === "known") {
    assert.equal(w.source, "syllabus");
    assert.deepEqual([...w.byGroup], [["hw", 30], ["ex", 70]]);
  }
  const g = courseGrade(noCanvas).grade;
  assert.deepEqual(g, { status: "known", percent: 80, basis: "From your captured Canvas scores. Weights as listed in the syllabus. Ungraded work isn't counted yet." });
  const unsummed = course([group("hw", "Homework", 40), group("ex", "Exams", 40)], items);
  assert.deepEqual(courseGrade(unsummed).grade, { status: "unknown", reason: "The Canvas group weights don't add up to 100, so Canvas may not apply them." });
  assert.equal(courseGrade(course([group("hw", "Homework", null), group("ex", "Exams", null)], items)).grade.status, "unknown");
});

test("coverage → unknown: a partial capture never yields a course figure or an item's share", () => {
  const input = course([group("hw", "Homework", 100)], [item("a", "hw", 10, 8, day(1)), item("b", "hw", 90, null, day(9))], { coverage: { status: "partial", reasons: ["Assignments: incomplete"] } });
  const g = courseGrade(input).grade;
  assert.equal(g.status, "unknown");
  assert.match((g as { reason: string }).reason, /partial \(Assignments: incomplete\)/);
  // FDB-001: A's share must not be derived from whatever siblings happened to be captured.
  assert.deepEqual(assignmentShare(input, "a"), {
    status: "group_only", groupWeight: 100, source: "canvas", text: "Counts in Homework, which is 100% of the grade (as listed in Canvas).",
    reason: "Capture is partial, so this assignment's part of its group isn't known.",
  });
});

test("an item's share: known with complete capture and no drops; a dropping group states only its weight", () => {
  const complete = course([group("hw", "Homework", 40), group("ex", "Exams", 60)], [item("a", "hw", 10, null, day(1)), item("b", "hw", 90, null, day(2)), item("m", "ex", 100, null, day(3))]);
  assert.deepEqual(assignmentShare(complete, "a"), { status: "known", share: 4, groupWeight: 40, source: "canvas", text: "About 4% of the grade: 10 of the 100 points in Homework (40%, as listed in Canvas)." });
  const dropping = course([group("hw", "Homework", 40, { dropLowest: 1 }), group("ex", "Exams", 60)], complete.items);
  assert.equal(assignmentShare(dropping, "a").status, "group_only");
  assert.equal(assignmentShare(complete, "zzz").status, "unknown");
  assert.equal(assignmentShare(course([group("hw", "Homework", 40)], [item("a", "hw", 10, null, day(1))]), "a").status, "unknown", "weights that don't add up: unknown");
});

test("drops: the lowest is chosen to leave the best group score (Canvas's goal), never a never-drop item", () => {
  // 1/2 (50%) and 30/100 (30%): dropping the 100-point item leaves more than dropping the lowest ratio... compare both.
  const g = group("q", "Quizzes", 100, { dropLowest: 1 });
  const items = [item("a", "q", 2, 1, day(1)), item("b", "q", 100, 30, day(2)), item("c", "q", 100, 90, day(3))];
  const r = courseGrade(course([g], items));
  assert.deepEqual(r.groups[0]!.dropped, ["b"]);
  assert.equal(r.groups[0]!.percent, 89.2);
  const kept = courseGrade(course([group("q", "Quizzes", 100, { dropLowest: 1, neverDrop: ["b"] })], items));
  assert.deepEqual(kept.groups[0]!.dropped, ["a"]);
});

test("inputs: one account's course only (FDB-001), duplicate captures merged, and a partial read marks coverage", () => {
  const store = createStore(":memory:");
  try {
    const assignment = (externalId: string, extra: Record<string, unknown> = {}) => ({
      externalId, kind: "assignment" as const, courseId: "C1", courseName: "Course", title: `Quiz ${externalId}`, url: `https://canvas.example.test/courses/C1/assignments/${externalId}`,
      text: "", deadlines: [], points: 10, assignmentGroupId: "g1", dueAt: "2026-09-10T12:00:00.000Z", policy: { mode: "unknown" as const, evidence: "" }, ...extra,
    });
    const groupRes = (weight: number) => ({ externalId: "g1", kind: "material" as const, courseId: "C1", courseName: "Course", title: "Quizzes", url: "https://canvas.example.test/courses/C1/assignments", text: "", deadlines: [], policy: { mode: "unknown" as const, evidence: "" }, assignmentGroup: { weight, position: 1 } });
    const ingest = (id: string, account: string, scope: string, resources: unknown[], complete = true) =>
      store.ingest({ source: { id, kind: "canvas", accountScope: account, courseId: "C1", scope, label: id }, observedAt: complete ? "2026-09-20T12:00:00.000Z" : "2026-09-21T12:00:00.000Z", complete, status: complete ? "ok" : "partial", resources });
    ingest("a-assign", "acct-a", "assignments", [groupRes(100), assignment("1"), assignment("2")]);
    ingest("a-subs", "acct-a", "submissions", [assignment("1", { submission: { workflowState: "graded", score: 7, submittedAt: "2026-09-09T12:00:00.000Z" } })]);
    ingest("b-assign", "acct-b", "assignments", [groupRes(100), assignment("1", { points: 50, submission: { score: 1 } })]);
    const a = gradeInputs(store, { accountScope: "acct-a", courseId: "C1" });
    assert.deepEqual(a.items.map((x) => [x.externalId, x.points, x.score, x.at]), [
      ["1", 10, 7, "2026-09-09T12:00:00.000Z"],
      ["2", 10, null, "2026-09-10T12:00:00.000Z"],
    ]);
    assert.deepEqual(a.groups.map((g) => [g.id, g.weight]), [["g1", 100]]);
    assert.equal(a.coverage.status, "complete");
    const b = gradeInputs(store, { accountScope: "acct-b", courseId: "C1" });
    assert.deepEqual(b.items.map((x) => [x.externalId, x.points, x.score]), [["1", 50, 1]], "the other account's same-ID course stays apart");
    assert.deepEqual(courseGrades(a, new Date("2026-09-20T12:00:00.000Z")).grade, { status: "known", percent: 70, basis: "From your captured Canvas scores. Group weights as listed in Canvas. Ungraded work isn't counted yet." });
    ingest("a-subs", "acct-a", "submissions", [assignment("1", { submission: { workflowState: "graded", score: 7, submittedAt: "2026-09-09T12:00:00.000Z" } })], false);
    const partial = gradeInputs(store, { accountScope: "acct-a", courseId: "C1" });
    assert.equal(partial.coverage.status, "partial");
    assert.equal(courseGrades(partial, new Date()).grade.status, "unknown");
  } finally {
    store.close();
  }
});
