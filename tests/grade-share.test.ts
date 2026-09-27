// FDB-001: gradeShare is keyed by account and course and says how complete it is (listed,
// computed or unknown). Synthetic inputs only.
import test from "node:test";
import assert from "node:assert/strict";
import { gradeShare, gradeShareDetail, type GradeShareResource } from "@magic/domain";

const group = (id: string, weight: number, over: Partial<GradeShareResource> = {}): GradeShareResource => ({
  id: `g-${id}-${over.accountScope ?? ""}`,
  kind: "material",
  externalId: id,
  title: id === "hw" ? "Homework" : id === "ex" ? "Exams" : id,
  courseId: "c1",
  courseName: "Course One",
  assignmentGroup: { weight },
  ...over,
});
const assignment = (id: string, points: number | null, over: Partial<GradeShareResource> = {}): GradeShareResource => ({
  id: `a-${id}-${over.accountScope ?? ""}`,
  kind: "assignment",
  externalId: id,
  title: `Assignment ${id}`,
  courseId: "c1",
  courseName: "Course One",
  points,
  assignmentGroupId: "hw",
  ...over,
});
const all = () => true;

test("grade share: without confirmed coverage only the listed group weight is said, and it doesn't move as more is captured", () => {
  const a = assignment("A", 10);
  const one = gradeShareDetail([group("hw", 40), group("ex", 60), a])(a);
  assert.equal(one.basis, "listed");
  assert.equal(one.percent, 40);
  assert.equal(one.reason, "partial_capture");
  const b = assignment("B", 90);
  const two = gradeShareDetail([group("hw", 40), group("ex", 60), a, b])(a);
  assert.deepEqual(two, one, "capturing a sibling changes nothing while coverage is unconfirmed");
  // The Today rail's consumer keeps its shape and still gets a percent and text.
  const share = gradeShare([group("hw", 40), group("ex", 60), a, b])(a)!;
  assert.equal(share.percent, 40);
  assert.equal(share.basis, "listed");
  assert.match(share.text, /40% of the Course One grade/);
});

test("grade share: computed only with complete coverage, split by points, siblings counted once", () => {
  const a = assignment("A", 10);
  const b = assignment("B", 90);
  const bTodo = { ...assignment("B", 90), id: "b-todo-copy" };
  const d = gradeShareDetail([group("hw", 40), group("ex", 60), a, b, bTodo], { complete: all })(a);
  assert.equal(d.basis, "computed");
  assert.equal(d.percent, 4, "40% × 10 / 100 points; the to-do copy of B doesn't double its points");
  assert.equal(d.reason, null);
});

test("grade share: accounts never mix, even with the same course ID", () => {
  const a = assignment("A", 10, { accountScope: "acct-1" });
  const rows = [
    group("hw", 40, { accountScope: "acct-1" }),
    group("ex", 60, { accountScope: "acct-1" }),
    a,
    // Another account's course with the same ID: its groups and assignments stay out.
    group("hw", 100, { accountScope: "acct-2" }),
    assignment("Z", 990, { accountScope: "acct-2" }),
  ];
  const d = gradeShareDetail(rows, { complete: (account) => account === "acct-1" })(a);
  assert.equal(d.basis, "computed");
  assert.equal(d.percent, 40, "only acct-1's 10-point sibling set");
  assert.equal(d.accountScope, "acct-1");
  const other = gradeShareDetail(rows, { complete: all })(assignment("Z", 990, { accountScope: "acct-2" }));
  assert.equal(other.basis, "computed");
  assert.equal(other.percent, 100);
  // A partial read of acct-2 keeps acct-1 computed and acct-2 listed.
  const partial = gradeShareDetail(rows, { complete: (account) => account === "acct-1" })(assignment("Z", 990, { accountScope: "acct-2" }));
  assert.equal(partial.basis, "listed");
  assert.equal(partial.reason, "partial_capture");
});

test("grade share: dropped scores and excused work stay at the listed weight", () => {
  const a = assignment("A", 10);
  const dropped = gradeShareDetail([group("hw", 40, { assignmentGroup: { weight: 40, rules: { dropLowest: 1 } } }), group("ex", 60), a, assignment("B", 10)], { complete: all })(a);
  assert.equal(dropped.basis, "listed");
  assert.equal(dropped.reason, "drop_rules");
  const excused = gradeShareDetail([group("hw", 40), group("ex", 60), a, assignment("B", 10, { submission: { excused: true } as GradeShareResource["submission"] })], { complete: all })(a);
  assert.equal(excused.basis, "listed");
  assert.equal(excused.reason, "excused");
  const noPoints = gradeShareDetail([group("hw", 40), group("ex", 60), a, assignment("B", null)], { complete: all })(a);
  assert.equal(noPoints.reason, "no_points");
});

test("grade share: unweighted, mis-totalled, duplicate and missing groups are unknown with a reason", () => {
  const a = assignment("A", 10);
  const cases: [GradeShareResource[], string][] = [
    [[group("hw", 0), group("ex", 0), a], "unweighted"],
    [[group("hw", 40), group("ex", 40), a], "weights_do_not_total_100"],
    [[group("hw", 40), { ...group("hw", 50), id: "dup" }, group("ex", 60), a], "duplicate_group"],
    [[group("ex", 60), a], "group_not_captured"],
    [[group("hw", 0), group("ex", 100), a], "zero_weight_group"],
    [[group("hw", 40), group("ex", 60), assignment("A", 10, { assignmentGroupId: null })], "no_group"],
  ];
  for (const [rows, reason] of cases) {
    const target = rows.find((r) => r.kind === "assignment")!;
    const d = gradeShareDetail(rows, { complete: all })(target);
    assert.equal(d.basis, "unknown", reason);
    assert.equal(d.percent, null, reason);
    assert.equal(d.reason, reason);
    assert.equal(gradeShare(rows, { complete: all })(target), null, `${reason}: the rail gets null`);
  }
  // An identical duplicate (the same group read twice) is one group, not a conflict.
  const same = gradeShareDetail([group("hw", 40), { ...group("hw", 40), id: "same" }, group("ex", 60), a], { complete: all })(a);
  assert.equal(same.basis, "computed");
});
