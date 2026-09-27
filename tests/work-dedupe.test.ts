import test from "node:test";
import assert from "node:assert/strict";
import { buildTodayRail, projectWork, resolveDeadline, type RailResource } from "@magic/domain";

const TZ = "America/Chicago";
// Sunday Sep 27, 2026, 10:00 AM Chicago.
const NOW = "2026-09-27T15:00:00.000Z";
// Due tonight, 11:59 PM Chicago.
const TONIGHT = "2026-09-28T04:59:00Z";
const due = (value: string) =>
  resolveDeadline([{ value, kind: "due", quote: "due_at", authority: "structured", scopeConfirmed: true }]);

// How Canvas copies one assignment into several saved sources for the same student.
const sources = [
  { id: "s-assign", accountScope: "acct", scope: "assignments" },
  { id: "s-todo", accountScope: "acct", scope: "account-todo" },
  { id: "s-upcoming", accountScope: "acct", scope: "account-upcoming-events" },
  { id: "s-activity", accountScope: "acct", scope: "account-activity" },
  { id: "s-quiz", accountScope: "acct", scope: "quizzes" },
  { id: "s-other", accountScope: "other-acct", scope: "assignments" },
];
function copy(id: string, sourceId: string, extra: Partial<RailResource> = {}): RailResource {
  return {
    id,
    sourceId,
    kind: "assignment",
    title: "Brooks ch. 3",
    courseId: "530226",
    courseName: "COURSE 101",
    externalId: "900001",
    completed: false,
    submitted: null,
    deadline: due(TONIGHT),
    kindLabel: null,
    ...extra,
  } as RailResource;
}
const dueToday = (resources: RailResource[], withSources = true) =>
  projectWork(resources, NOW, TZ, withSources ? sources : undefined).dueToday;

test("one Canvas assignment saved from several places is listed once, as the assignments copy", () => {
  const items = dueToday([
    copy("todo", "s-todo"),
    copy("upcoming", "s-upcoming"),
    copy("main", "s-assign", { points: 10 }),
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.id, "main", "the assignments list is the trusted copy");
  assert.equal(items[0]!.points, 10);
});

test("an assignment submitted in any copy is done, even when other copies know nothing", () => {
  assert.deepEqual(dueToday([copy("main", "s-assign", { submitted: true }), copy("upcoming", "s-upcoming")]), []);
  assert.deepEqual(
    dueToday([copy("activity", "s-activity", { submission: { submittedAt: "2026-09-26T20:00:00Z" } as RailResource["submission"] }), copy("upcoming", "s-upcoming")]),
    [],
  );
  assert.deepEqual(dueToday([copy("main", "s-assign", { completed: true }), copy("todo", "s-todo")]), []);
});

test("graded work with no submission time counts as done", () => {
  for (const workflowState of ["graded", "complete", "pending_review", "submitted"])
    assert.deepEqual(
      dueToday([copy("main", "s-assign", { submission: { workflowState } as RailResource["submission"] }), copy("todo", "s-todo")]),
      [],
      workflowState,
    );
  // Unsubmitted stays open.
  assert.equal(dueToday([copy("main", "s-assign", { submission: { workflowState: "unsubmitted" } as RailResource["submission"] })]).length, 1);
});

test("copies are never merged across accounts, and quiz ids never collide with assignment ids", () => {
  assert.equal(dueToday([copy("a", "s-assign"), copy("b", "s-other")]).length, 2, "different accounts");
  assert.equal(dueToday([copy("a", "s-assign"), copy("q", "s-quiz", { title: "Quiz #3" })]).length, 2, "same number, quiz vs assignment");
});

test("without source details, assignment identity remains source-specific", () => {
  assert.equal(dueToday([copy("todo", "s-todo"), copy("main", "s-assign")], false).length, 2);
});

test("the Today rail shows each due assignment once", () => {
  const rail = buildTodayRail(
    [copy("todo", "s-todo"), copy("upcoming", "s-upcoming"), copy("main", "s-assign"),
     copy("q-act", "s-activity", { externalId: "3160042", title: "Quiz #3" }),
     copy("q-main", "s-assign", { externalId: "3160042", title: "Quiz #3", submitted: true })],
    NOW,
    TZ,
    [],
    sources,
  );
  assert.deepEqual(rail.due.map((d) => d.title), ["Brooks ch. 3"]);
});


test("verified copies retain differing due evidence rather than trusting one date", () => {
  const resources = [copy("main", "s-assign"), copy("todo", "s-todo", {deadline: due("2026-09-29T04:59:00Z")})];
  const item = projectWork(resources, NOW, TZ, sources).dueToday[0]!;
  assert.equal(item.conflict, true);
  assert.equal(item.resource.deadline.dueAt, null);
  assert.equal(item.resource.deadline.claims.length, 2);
  assert.equal(Date.parse(item.dueAt), Date.parse(TONIGHT));
});

test("already projected family retains its personal planning date and conflict evidence", () => {
  const selected = {...copy("main", "s-assign"), scheduleDeadline: {family:"trusted"}, deadline: {...due(TONIGHT), planningAt:"2026-09-29T04:59:00Z", conflict:true}};
  const item = projectWork([selected], NOW, TZ, sources).upcoming[0]!;
  assert.equal(item.dueAt, selected.deadline.planningAt);
  assert.equal(item.conflict, true);
});

test("unrecognized source scopes and absent accounts do not merge", () => {
  const inputs=[copy("a","s-assign"),copy("b","s-todo")];
  for (const fields of [{accountScope:""},{scope:"unverified"}]) {
    assert.equal(projectWork(inputs,NOW,TZ,sources.map(s=>({...s,...fields}))).dueToday.length,2);
  }
});
