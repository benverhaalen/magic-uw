import test from "node:test";
import assert from "node:assert/strict";
import type {
  CourseIntelligenceView,
  ResourceView,
  SourceHealth,
} from "@magic/contracts";
import {
  buildCourseCards,
  buildCoursePage,
  courseKey,
} from "../packages/domain/src/course-page";

const now = "2026-09-27T12:00:00.000Z";
const source = (id: string, account = "acct", course = "101", over: Partial<SourceHealth> = {}): SourceHealth => ({
  id, label: id, kind: "canvas", accountScope: account, courseId: course, scope: "assignments",
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

function econ() {
  const exams = r({ title: "Exams", kind: "material", externalId: "g1", assignmentGroup: { weight: 60, position: 1 } });
  const hw = r({ title: "Problem sets", kind: "material", externalId: "g2", assignmentGroup: { weight: 40, position: 2, rules: { dropLowest: 1 } } });
  const midterm = r({ title: "Midterm", assignmentGroupId: "g1", ...due("2026-09-30T17:00:00.000Z") });
  const ps1 = r({ title: "PS 1", assignmentGroupId: "g2", ...due("2026-09-20T17:00:00.000Z"), submitted: true });
  const ps2 = r({ title: "PS 2", assignmentGroupId: "g2", ...due("2026-10-10T17:00:00.000Z") });
  const mod = r({ title: "Week 1: Supply", kind: "material", externalId: "m1", module: { position: 1 } });
  const reading = r({ title: "Ch. 1 reading", kind: "material", moduleItem: { type: "File", position: 1, moduleId: "m1" } });
  const syllabusFile = r({ title: "ECON 101 Syllabus Fall 2026.pdf", kind: "material" });
  return { exams, hw, midterm, ps1, ps2, mod, reading, syllabusFile };
}

test("an Econ-style course groups work by listed weight and modules, and keeps missing facts missing", () => {
  const e = econ();
  const input = { resources: Object.values(e), sources: [source("s1")], now };
  const page = buildCoursePage(input, courseKey("acct", "101"))!;
  assert.deepEqual(page.weights.map((w) => [w.name, w.weight, w.dropLowest]), [["Exams", 60, undefined], ["Problem sets", 40, 1]]);
  assert.deepEqual(page.groups.map((g) => g.name), ["Exams", "Problem sets"]);
  assert.deepEqual(page.groups[1]!.upcoming.map((x) => x.title), ["PS 2"]);
  assert.deepEqual(page.groups[1]!.past.map((x) => x.title), ["PS 1"]);
  assert.equal(page.counts.dueThisWeek, 1);
  assert.deepEqual(page.modules?.map((m) => [m.name, m.items.map((i) => i.title)]), [["Week 1: Supply", ["Ch. 1 reading"]]]);
  // A syllabus file is detected and linked but not treated as read.
  assert.equal(page.syllabus.state, "file");
  // No intelligence: every fact is explicitly not found, never implied permission.
  assert.equal(page.facts.ai_policy.state, "not_found");
  assert.equal(page.facts.grading.state, "not_found");
  assert.equal(page.freshness, "current_capture");
});

test("claims surface with their evidence; conflicts and assignment exceptions stay visible", () => {
  const e = econ();
  const syllabus = r({ title: "Syllabus", kind: "material", externalId: "syllabus", text: "AI tools: generative AI is not permitted on exams. ".repeat(3) });
  const profile = {
    id: "p", accountScope: "acct", courseId: "101", courseName: "ECON 101", version: 1, compilerVersion: "1",
    inputHash: "x", compiledAt: now, unknowns: [], dependencies: [],
    claims: [
      { id: "c1", kind: "ai_policy", scope: "course", label: "AI policy passage", value: "Generative AI is not permitted on exams.", method: "literal", policyMode: "unknown",
        evidence: [{ resourceId: syllabus.id, sourceId: "s1", contentHash: "h", version: 1, url: syllabus.url, field: "text", quote: "Generative AI is not permitted on exams." }] },
      { id: "c2", kind: "ai_policy", scope: "assignment", assignmentId: e.ps2.id, label: "Captured policy assertion", value: "AI allowed for PS 2", method: "structured", policyMode: "allowed", evidence: [] },
      { id: "c3", kind: "grading", scope: "course", label: "g", value: 60, method: "structured", evidence: [] },
    ],
    conflicts: [{ kind: "ai_policy", claimIds: ["c1", "c2"], reason: "restricted vs allowed" }],
    coverage: [], freshness: "partial",
  } as unknown as CourseIntelligenceView;
  const page = buildCoursePage(
    { resources: [...Object.values(e), syllabus], sources: [source("s1"), source("s3", "acct", "101", { status: "partial", complete: false })], courseIntelligence: [profile], now },
    courseKey("acct", "101"),
  )!;
  assert.equal(page.syllabus.state, "canvas");
  assert.equal(page.facts.ai_policy.state, "conflict");
  assert.equal(page.facts.ai_policy.items[0]!.evidence[0]!.title, "Syllabus");
  assert.equal(page.facts.ai_policy.items[1]!.assignmentTitle, "PS 2");
  // Structured per-group grading claims are shown from exact records, not duplicated as prose.
  assert.equal(page.facts.grading.state, "not_found");
  assert.equal(page.freshness, "partial");
});

test("same-named courses in different accounts stay separate; stale sources are labeled", () => {
  const a = r({ title: "HW", sourceId: "s1", ...due("2026-09-28T00:00:00.000Z") });
  const b = r({ title: "HW other", sourceId: "s2" });
  const sources = [source("s1"), source("s2", "acct2", "101", { lastSuccessAt: "2026-09-20T00:00:00.000Z" })];
  const cards = buildCourseCards({ resources: [a, b], sources, now });
  assert.equal(cards.length, 2);
  const stale = buildCoursePage({ resources: [a, b], sources, now }, courseKey("acct2", "101"))!;
  assert.equal(stale.freshness, "stale");
  assert.deepEqual(stale.groups.flatMap((g) => g.undated.map((x) => x.title)), ["HW other"]);
  assert.equal(cards.find((c) => c.key === "acct:101")!.cue, "Next: HW");
});

test("items saved before module ids fall back to a flat materials list", () => {
  const mod = r({ title: "Week 1", kind: "material", module: { position: 1 } });
  const item = r({ title: "Slides", kind: "material", moduleItem: { type: "File", position: 1 } });
  const page = buildCoursePage({ resources: [mod, item], sources: [source("s1")], now }, "acct:101")!;
  assert.equal(page.modules, null);
  assert.deepEqual(page.materials.map((m) => m.title), ["Slides"]);
  assert.equal(page.syllabus.state, "missing");
});

test("a closed or unpublished course area is checked, not stale; sign-in failure is stale", () => {
  const a = r({ title: "HW", ...due("2026-09-28T00:00:00.000Z") });
  const closed = source("q", "acct", "101", { status: "inaccessible", lastSuccessAt: null, complete: false });
  const page = buildCoursePage({ resources: [a], sources: [source("s1"), closed], now }, "acct:101")!;
  assert.equal(page.freshness, "current_capture");
  const expired = buildCoursePage(
    { resources: [a], sources: [source("s1", "acct", "101", { status: "needs_sign_in" })], now },
    "acct:101",
  )!;
  assert.equal(expired.freshness, "stale");
  // Attempted but only partly read, never fully successful: partly checked, not "not checked".
  const partial = source("p", "acct", "101", { status: "partial", lastSuccessAt: null, complete: false });
  assert.equal(buildCoursePage({ resources: [a], sources: [source("s1"), partial], now }, "acct:101")!.freshness, "partial");
  assert.equal(expired.needsSignIn, true);
});
