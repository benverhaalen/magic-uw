import test from "node:test";
import assert from "node:assert/strict";
import type { CourseIntelligenceView, ResourceView, SourceHealth } from "@magic/contracts";
import { buildCoursePage, courseKey } from "../packages/domain/src/course-page";
import {
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
  assert.deepEqual(nextUp(page).map((x) => [x.resource.title, x.group]), [
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
  const sets = page.groups.find((g) => g.name === "Problem sets")!;
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

test("exact repeats share one next-up row and still count toward what is covered", () => {
  const base = course();
  const sets = base.groups.find((g) => g.name === "Problem sets")!;
  const copy = { ...sets.upcoming[0]!, id: "copy" };
  const page = { groups: base.groups.map((g) => (g === sets ? { ...g, upcoming: [...g.upcoming, copy] } : g)) };
  const next = nextUp(page);
  assert.deepEqual(next.map((x) => [x.resource.title, x.copies]), [["PS 2", 2], ["Midterm", 1], ["Final", 1]]);
});
