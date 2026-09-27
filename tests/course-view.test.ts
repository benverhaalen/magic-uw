import test from "node:test";
import assert from "node:assert/strict";
import type { CourseIntelligenceView, ResourceView, SourceHealth } from "@magic/contracts";
import { buildCoursePage, courseKey } from "../packages/domain/src/course-page";
import {
  courseWork,
  freshnessText,
  groupSummary,
  nextUp,
  shownFacts,
  unknownFacts,
} from "../apps/desktop/src/renderer/courses/course-view";

const now = "2026-09-27T12:00:00.000Z";
const source = (over: Partial<SourceHealth> = {}): SourceHealth => ({
  id: "s1", label: "s1", kind: "canvas", accountScope: "acct", courseId: "101", scope: "assignments",
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

function course(intelligence?: CourseIntelligenceView[], sources = [source()]) {
  const resources = [
    r({ title: "Exams", kind: "material", externalId: "g1", assignmentGroup: { weight: 60, position: 1 } }),
    r({ title: "Problem sets", kind: "material", externalId: "g2", assignmentGroup: { weight: 40, position: 2 } }),
    r({ title: "Final", assignmentGroupId: "g1", ...due("2026-12-10T17:00:00.000Z") }),
    r({ title: "Midterm", assignmentGroupId: "g1", ...due("2026-10-01T17:00:00.000Z") }),
    r({ title: "PS 1", assignmentGroupId: "g2", ...due("2026-09-20T17:00:00.000Z"), submitted: true }),
    r({ title: "PS 2", assignmentGroupId: "g2", ...due("2026-09-29T17:00:00.000Z") }),
    r({ title: "Reflection", assignmentGroupId: "g2" }),
    r({ title: "Old reflection", assignmentGroupId: "g2", submitted: true }),
  ];
  return buildCoursePage({ resources, sources, courseIntelligence: intelligence, now }, courseKey("acct", "101"))!;
}

test("next up is dated unfinished work across groups, soonest first", () => {
  const page = course();
  assert.deepEqual(nextUp(page).map((x) => [x.entry.resource.title, x.group]), [
    ["PS 2", "Problem sets"], ["Midterm", "Exams"], ["Final", "Exams"],
  ]);
  assert.equal(nextUp(page, 1).length, 1);
});

test("missing facts collapse to one line; weights alone show grading; AI absence is never permission", () => {
  const page = course();
  assert.deepEqual(shownFacts(page), ["grading"]);
  const unknown = unknownFacts(page);
  assert.deepEqual(unknown.names, ["AI use policy", "exam details"]);
  assert.equal(unknown.aiMissing, true);
});

test("a found AI claim gets its own row and leaves the unknown line", () => {
  const page = course([{
    accountScope: "acct", courseId: "101", conflicts: [],
    claims: [{ kind: "ai_policy", scope: "course", value: "AI tools are not allowed on exams.", method: "rule", evidence: [{ resourceId: "r1", url: "https://canvas.test/1", quote: "No AI on exams." }] }],
  } as unknown as CourseIntelligenceView]);
  assert.deepEqual(shownFacts(page), ["ai_policy", "grading"]);
  assert.deepEqual(unknownFacts(page), { names: ["exam details"], aiMissing: false });
});

test("group summaries count open undated work separately from finished work", () => {
  const page = course();
  const sets = courseWork(page).groups.find((g) => g.name === "Problem sets")!;
  assert.equal(groupSummary(sets), "1 upcoming · 1 without a due date · 2 past or finished");
});

test("stale, partial and unknown freshness never read as current", () => {
  const fmt = () => "Sep 26";
  assert.deepEqual(freshnessText({ freshness: "current_capture", lastSuccessAt: now }, fmt), { text: "Checked Sep 26", attention: false });
  for (const freshness of ["stale", "partial", "unknown"] as const) {
    const result = freshnessText({ freshness, lastSuccessAt: now }, fmt);
    assert.equal(result.attention, true);
    assert.doesNotMatch(result.text, /^Checked/);
  }
  assert.equal(freshnessText({ freshness: "stale", lastSuccessAt: null }, fmt).text, "Not checked yet");
  const stale = course(undefined, [source({ status: "needs_sign_in" })]);
  assert.equal(stale.freshness, "stale");
});

// The real private copy showed each such cluster as one Canvas id and URL read by the assignments
// list and by account to-do/activity lists. Identity decides; title, time and points never do.
const todo = source({ id: "s2", label: "s2", courseId: "account", scope: "account-todo" });
function withAssignments(extra: ResourceView[]) {
  const resources = [
    r({ title: "Essays", kind: "material", externalId: "g9", assignmentGroup: { weight: 100, position: 1 } }),
    ...extra,
  ];
  return buildCoursePage({ resources, sources: [source(), todo], now }, courseKey("acct", "101"))!;
}

test("one Canvas assignment read from two lists is one entry that opens the direct record", () => {
  const at = due("2026-10-01T17:00:00.000Z");
  const direct = r({ title: "Essay draft", externalId: "555", url: "https://canvas.test/courses/101/assignments/555", assignmentGroupId: "g9", points: 2, submitted: true, ...at });
  const listed = r({ title: "Essay draft", externalId: "555", url: "https://canvas.test/courses/101/assignments/555", sourceId: "s2", assignmentGroupId: "g9", points: 2, submitted: null, ...at });
  const later = r({ title: "Essay final", externalId: "556", assignmentGroupId: "g9", ...due("2026-10-13T17:00:00.000Z") });
  const work = courseWork(withAssignments([direct, listed, later]));
  assert.equal(work.counts.total, 2);
  // The to-do copy lacks submission data; the direct record says submitted, so it is not next up.
  assert.deepEqual(work.next.map((x) => x.entry.resource.id), [later.id]);
  const essay = work.groups[0]!.past[0]!;
  assert.equal(essay.resource.id, direct.id);
  assert.deepEqual(essay.copies.map((c) => c.id).sort(), [direct.id, listed.id].sort());
  assert.equal(essay.sameTitleElsewhere, false);
});

test("same title, group, due time and points with different Canvas ids stay separate and distinguishable", () => {
  const same = { title: "Essay draft", assignmentGroupId: "g9", points: 2, ...due("2026-10-01T17:00:00.000Z") };
  const a = r({ ...same, externalId: "701" });
  const b = r({ ...same, externalId: "702" });
  const work = courseWork(withAssignments([a, b]));
  assert.equal(work.counts.total, 2);
  assert.deepEqual(work.next.map((x) => x.entry.resource.externalId).sort(), ["701", "702"]);
  assert.ok(work.next.every((x) => x.entry.sameTitleElsewhere && x.entry.copies.length === 1));
});

test("a copy with a different due time is kept on the entry and flagged, not silently chosen", () => {
  const direct = r({ title: "Memo", externalId: "800", assignmentGroupId: "g9", submitted: false, ...due("2026-10-02T17:00:00.000Z") });
  const listed = r({ title: "Memo", externalId: "800", sourceId: "s2", assignmentGroupId: "g9", ...due("2026-10-03T17:00:00.000Z") });
  const [only] = courseWork(withAssignments([direct, listed])).next;
  assert.equal(only!.entry.resource.id, direct.id);
  assert.equal(only!.entry.dueDiffers, true);
});

test("coursework below next up never repeats a next-up entry", () => {
  const page = course();
  const work = courseWork(page, 2);
  const shown = new Set(work.next.map((x) => x.entry.key));
  const listed = work.rest.flatMap((g) => [...g.upcoming, ...g.undated, ...g.past]);
  assert.ok(listed.every((e) => !shown.has(e.key)));
  assert.equal(listed.length + work.next.length, work.counts.total);
  assert.deepEqual(work.rest.flatMap((g) => g.upcoming).map((e) => e.resource.title), ["Final"]);
});
