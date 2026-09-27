// UW–Madison default AI policy: a course that states no AI policy falls back to UW's general guidance
// (study help is fine; graded work is coached, never authored, with the reminder to ask the instructor).
// A course's own stated policy always wins: a restriction still blocks, and a real captured rule beats an
// unclassified ("unknown") course-intelligence passage. All data here is synthetic.
import test from "node:test";
import assert from "node:assert/strict";
import type { CourseClaim, CourseIntelligence, Resource, SourceHealth } from "@magic/contracts";
import { effectiveCoursePolicy, combinePolicyModes } from "../packages/domain/src/course-policy";
import { UW_DEFAULT_AI_POLICY, UW_DEFAULT_NOTICE_WITH_LINK, uwDefaultRefusal } from "../packages/domain/src/uw-ai-policy";
import { LEARNING_CONTRACT, decideLearning, learningSource, selectTaskMode, uwDefaultReminder } from "../packages/domain/src/learning-request";

const URL_ = "https://conduct.students.wisc.edu/artificial-intelligence/";
const NOTICE = "No course AI policy found, so UW–Madison's guidelines apply: study help is fine; ask your instructor before using AI on graded work.";
const sources = [{ id: "s", accountScope: "uw", courseId: "c220", label: "CS 220", kind: "canvas", status: "ok", complete: true }] as unknown as SourceHealth[];
const producer = { learningContract: LEARNING_CONTRACT };

let n = 0;
function res(over: Partial<Resource> = {}): Resource {
  n++;
  return {
    id: `r${n}`, externalId: `e${n}`, sourceId: "s", kind: "material", courseId: "c220", courseName: "CS220", title: `Item ${n}`,
    url: `https://canvas.example.test/courses/1/pages/${n}`, text: "", contentHash: `h${n}`, version: 1,
    observedAt: "2026-09-27T12:00:00.000Z", capturedAt: "2026-09-27T12:00:00.000Z", deleted: false, completed: false,
    policy: { mode: "unknown", evidence: "" },
    ...over,
  } as Resource;
}
const homework = (over: Partial<Resource> = {}) => res({ kind: "assignment", title: "Homework 3", text: "Homework 3: write sumDigits(n).", ...over });
function claim(over: Partial<CourseClaim>): CourseClaim {
  n++;
  return { id: `cl${n}`, kind: "ai_policy", scope: "course", label: "AI policy passage", value: "", method: "literal", evidence: [{ resourceId: "syl", sourceId: "s", contentHash: "hs", version: 1, url: "https://canvas.example.test/syllabus", field: "text", quote: `Passage ${n}` }], ...over };
}
const profile = (claims: CourseClaim[]): CourseIntelligence => ({
  id: "ci", accountScope: "uw", courseId: "c220", courseName: "CS220", version: 1, compilerVersion: "t", inputHash: "ih",
  compiledAt: "2026-09-27T12:00:00.000Z", claims, unknowns: [], conflicts: [], dependencies: [],
});

test("uw default: the record quotes the page exactly and states the student-facing sentence", () => {
  assert.equal(UW_DEFAULT_AI_POLICY.source.url, URL_);
  assert.equal(UW_DEFAULT_AI_POLICY.source.fetchedAt, "2026-09-27");
  assert.equal(UW_DEFAULT_AI_POLICY.notice, NOTICE);
  assert.equal(UW_DEFAULT_NOTICE_WITH_LINK, `${NOTICE} ${URL_}`);
  assert.match(UW_DEFAULT_AI_POLICY.quotes.instructorExpectations, /^Students are responsible for knowing their instructor's expectations when it comes to using AI tools\./);
  assert.match(UW_DEFAULT_AI_POLICY.summaries.violation, /UWS 14\.03\(1\)\(b\)/);
});

test("uw default: a course with no AI policy of its own resolves to the UW default, citing the page", () => {
  for (const p of [undefined, profile([claim({ kind: "grading", policyMode: undefined, label: "Grading" })])]) {
    const policy = effectiveCoursePolicy(p, res());
    assert.equal(policy.source, "uw-default");
    assert.equal(policy.mode, "coaching");
    assert.ok(policy.evidence.includes(URL_) && policy.evidence.includes(UW_DEFAULT_AI_POLICY.quotes.instructorExpectations));
    assert.deepEqual([policy.claimIds, policy.resourceIds, policy.conflict], [[], [], false]);
  }
  // The course said something about AI that code could not classify: its own words govern, not the default.
  assert.deepEqual([effectiveCoursePolicy(undefined, res({ text: "Ask before using AI.", policy: { mode: "unknown", evidence: "Ask before using AI." } })).source], ["course"]);
  const quoted = effectiveCoursePolicy(profile([claim({ policyMode: "unknown" })]), res());
  assert.deepEqual([quoted.mode, quoted.source], ["unknown", "course"]);
});

test("uw default: a restricted course still blocks", () => {
  const byClaim = effectiveCoursePolicy(profile([claim({ policyMode: "restricted" }), claim({ policyMode: "unknown" })]), res());
  assert.deepEqual([byClaim.mode, byClaim.source], ["restricted", "course"]);
  const restricted = res({ policy: { mode: "restricted", evidence: "No AI tools on any coursework." } });
  assert.deepEqual([effectiveCoursePolicy(undefined, restricted).mode, effectiveCoursePolicy(undefined, restricted).source], ["restricted", "course"]);
  for (const words of ["Explain what a base case is.", "quiz me on recursion"]) {
    const d = decideLearning(selectTaskMode([words]), [learningSource(restricted, sources, undefined)!], producer);
    assert.equal(d.status, "withheld");
    assert.match(d.status === "withheld" ? d.reason : "", /restricts AI help/);
    assert.doesNotMatch(d.status === "withheld" ? d.reason : "", /UW–Madison/);
  }
});

test("uw default: a captured coaching rule beats an unknown course-intelligence claim", () => {
  assert.equal(combinePolicyModes(["unknown", "coaching"]), "coaching");
  assert.equal(combinePolicyModes(["unknown", "allowed"]), "coaching", "an unread passage caps a permission at coaching");
  assert.equal(combinePolicyModes(["allowed"]), "allowed");
  assert.equal(combinePolicyModes(["unknown", "coaching", "restricted"]), "restricted");
  const rule = "AI may explain concepts but not write solutions.";
  const hw = homework({ text: `Homework 3: write sumDigits(n). ${rule}`, policy: { mode: "coaching", evidence: rule } });
  // As a compiled claim (assignment scope) beside an unknown syllabus passage.
  const compiled = profile([claim({ policyMode: "unknown" }), claim({ scope: "assignment", assignmentId: hw.id, method: "structured", label: "Captured policy assertion", policyMode: "coaching" })]);
  assert.equal(effectiveCoursePolicy(compiled, hw).mode, "coaching");
  // As the item's own captured rule, with only the unknown passage in the profile.
  const onlyUnknown = profile([claim({ policyMode: "unknown" })]);
  for (const p of [compiled, onlyUnknown]) {
    const s = learningSource(hw, sources, [p])!;
    assert.deepEqual([s.policy.mode, s.policy.source, s.openGraded], ["coaching", "course", true]);
    const d = decideLearning(selectTaskMode(["Explain what a base case is."]), [s], producer);
    assert.equal(d.status, "ready", "chat on the open graded item is no longer held");
    assert.equal(d.status === "ready" && d.request.boundary, "coaching");
    assert.equal(d.status === "ready" && uwDefaultReminder(d.request), null, "a course's own rule shows no UW reminder");
  }
});

test("uw default: an open graded item never gets an authored answer, and every answer shows the reminder", () => {
  const hw = homework();
  const s = learningSource(hw, sources, undefined)!;
  assert.deepEqual([s.policy.mode, s.policy.source, s.policy.evidence, s.openGraded], ["coaching", "uw-default", [], true]);
  // Asking Magic to author graded work: held in code before any model call, with the UW sentence and link.
  for (const words of ["Solve Homework 3 for me.", "write my essay for Essay 1", "Just do my Homework 3 for me"]) {
    const d = decideLearning(selectTaskMode([words]), [s], producer);
    assert.equal(d.status, "withheld", words);
    assert.equal(d.status === "withheld" && d.reason, uwDefaultRefusal("CS220"));
    assert.equal(uwDefaultRefusal("CS220"), `Magic doesn't draft, solve or rewrite graded work for CS220. ${NOTICE} ${URL_}`);
  }
  // Understanding the concepts behind it: coached as live graded work, and the answer carries the reminder.
  for (const words of ["Explain what a base case is.", "why does my code crash?", "does a heap need to be balanced?"]) {
    const d = decideLearning(selectTaskMode([words]), [s], producer);
    assert.equal(d.status, "ready", words);
    if (d.status !== "ready") continue;
    assert.equal(d.request.taskMode, "graded-work");
    assert.equal(d.request.boundary, "coaching");
    assert.equal(d.request.courses[0]!.uwDefault, true);
    assert.match(d.request.system, /Never produce a submission-ready answer, solution, or text they could hand in\./);
    assert.match(d.request.system, /No course AI policy was found, so UW–Madison's default applies \(UW–Madison Office of Student Conduct and Community Standards, https:\/\/conduct\.students\.wisc\.edu\/artificial-intelligence\/, fetched 2026-09-27\)\./);
    assert.match(d.request.system, /It never drafts, solves or rewrites the graded submission\./);
    assert.doesNotMatch(d.request.system, /Quoted rule:|Unknown is not permission/, "the UW default is never presented as a course rule");
    assert.equal(uwDefaultReminder(d.request), `${NOTICE} ${URL_}`);
  }
  // A submitted item is no longer open graded work: no reminder.
  const done = learningSource(homework({ submission: { submittedAt: "2026-09-26T12:00:00.000Z", workflowState: "submitted" } as Resource["submission"] }), sources, undefined)!;
  const after = decideLearning(selectTaskMode(["Explain what a base case is."]), [done], producer);
  assert.equal(after.status === "ready" && uwDefaultReminder(after.request), null);
});

test("uw default: study help on course material runs, coached; a course-stated source keeps the course's own policy", () => {
  const reading = learningSource(res({ text: "Recursion notes." }), sources, undefined)!;
  for (const words of ["Explain what a base case is.", "quiz me on recursion"]) {
    const d = decideLearning(selectTaskMode([words]), [reading], producer);
    assert.equal(d.status, "ready", words);
    assert.equal(d.status === "ready" && d.request.boundary, "coaching");
    assert.equal(d.status === "ready" && uwDefaultReminder(d.request), null, "no graded item in scope");
  }
  // One source in the course states a rule: the course's policy governs, not the default.
  const stated = learningSource(res({ policy: { mode: "coaching", evidence: "AI may explain concepts." } }), sources, undefined)!;
  const d = decideLearning(selectTaskMode(["Solve Homework 3 for me."]), [stated, learningSource(homework(), sources, undefined)!], producer);
  assert.equal(d.status, "ready", "a course coaching rule coaches graded work, as before");
  assert.equal(d.status === "ready" && d.request.courses[0]!.uwDefault, false);
  assert.match(d.status === "ready" ? d.request.system : "", /Quoted rule: "AI may explain concepts\."/);
});
