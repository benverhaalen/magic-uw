// Voice/learning/media lane: learning requests carry task mode, exact scope and every course's policy
// (never the first one found); course videos come only from course evidence; voice errors stay retryable.
import test from "node:test";
import assert from "node:assert/strict";
import type { Resource, SourceHealth } from "@magic/contracts";
import { LEARNING_CONTRACT, POLICY_EVIDENCE_LIMIT, decideLearning, helpBoundary, learningSource, selectTaskMode } from "../packages/domain/src/learning-request";
import { courseVideosFor, videoLink, asksForVideo } from "../apps/desktop/src/renderer/media/course-video";
import { launcherVoice, voiceAnnouncement } from "../apps/desktop/src/renderer/voice/launcher-voice";

const sources = [
  { id: "s-a", accountScope: "uw", courseId: "c220", label: "CS 220", kind: "canvas", status: "ok", complete: true },
  { id: "s-b", accountScope: "uw", courseId: "b101", label: "BIO 101", kind: "canvas", status: "ok", complete: true },
  { id: "s-x", accountScope: "other", courseId: "c220", label: "CS 220 (other account)", kind: "canvas", status: "ok", complete: true },
] as unknown as SourceHealth[];

const concept = selectTaskMode(["Explain what a hash table is."]);
let n = 0;
function res(over: Partial<Resource> & { sourceId: string; courseId: string }): Resource {
  n++;
  return {
    id: `r${n}`, externalId: `e${n}`, kind: "material", courseName: over.courseId.toUpperCase(), title: `Item ${n}`,
    url: `https://canvas.wisc.edu/courses/1/pages/${n}`, text: "", contentHash: `h${n}`, version: 1,
    observedAt: "2026-09-26T12:00:00.000Z", capturedAt: "2026-09-26T12:00:00.000Z", deleted: false, completed: false,
    policy: { mode: "unknown", evidence: "" },
    ...over,
  } as Resource;
}

test("mixed-course request resolves every course and withholds instead of using the first policy", () => {
  const allowed = res({ sourceId: "s-a", courseId: "c220", policy: { mode: "allowed", evidence: "You may use AI to study." } });
  const restricted = res({ sourceId: "s-b", courseId: "b101", policy: { mode: "restricted", evidence: "No AI tools on any coursework." } });
  const selected = [allowed, restricted].map((r) => learningSource(r, sources, undefined)!);
  const decision = decideLearning(concept, selected, { learningContract: LEARNING_CONTRACT });
  assert.equal(decision.status, "withheld");
  assert.match(decision.status === "withheld" ? decision.reason : "", /B101.*restricts AI help/);
  assert.equal(decision.status === "withheld" && decision.courses.length, 2, "each course keeps its own decision");
});

test("every ready request puts task mode, exact scope and each course's quoted policy in system text", () => {
  const a = res({ sourceId: "s-a", courseId: "c220", policy: { mode: "coaching", evidence: "AI may explain concepts but not write solutions." } });
  const b = res({ sourceId: "s-b", courseId: "b101", policy: { mode: "unknown", evidence: "" } });
  const decision = decideLearning(concept, [a, b].map((r) => learningSource(r, sources, undefined)!), { learningContract: LEARNING_CONTRACT });
  assert.equal(decision.status, "ready");
  if (decision.status !== "ready") return;
  const { request } = decision;
  assert.equal(request.taskMode, "concept");
  assert.equal(request.boundary, "coaching", "the UW default in one course keeps the whole request conservative");
  assert.deepEqual(request.scope.map((s) => [s.accountScope, s.courseId, s.resourceId, s.contentHash]), [["uw", "c220", a.id, a.contentHash], ["uw", "b101", b.id, b.contentHash]]);
  assert.match(request.system, /Task mode: concept/);
  assert.match(request.system, /C220 \[uw\/c220\]: coaching/);
  assert.match(request.system, /AI may explain concepts but not write solutions/);
  // No AI policy of its own: UW–Madison's default applies (operator decision, 2026-09-27).
  assert.match(request.system, /B101 \[uw\/b101\]: coaching/);
  assert.match(request.system, /No course AI policy was found, so UW–Madison's default applies/);
});

test("without a producer that enforces the contract, the request is built but not sent", () => {
  const a = res({ sourceId: "s-a", courseId: "c220", policy: { mode: "allowed", evidence: "AI allowed." } });
  const decision = decideLearning(concept, [learningSource(a, sources, undefined)!], null);
  assert.equal(decision.status, "producer-pending");
  assert.match(decision.status === "producer-pending" ? decision.request.system : "", /allowed/);
});

test("help approach depends on use case; unknown or conflicting permission is not permission", () => {
  assert.equal(helpBoundary("administrative", "restricted", false, true), "facts-only", "rules and dates still read back");
  assert.equal(helpBoundary("concept", "allowed", false, false), "direct-cited");
  assert.equal(helpBoundary("concept", "coaching", false, false), "coaching", "direct help needs explicit permission");
  assert.equal(helpBoundary("concept", "unknown", false, false), "coaching");
  assert.equal(helpBoundary("unclear", "allowed", false, false), "coaching", "an unclear use case is never direct help");
  assert.equal(helpBoundary("concept", "allowed", false, true), "coaching", "an open graded item is graded work even when the words ask for a concept");
  assert.equal(helpBoundary("unclear", "unknown", false, true), "withhold", "unclear mode on an open graded item under unknown policy");
  assert.equal(helpBoundary("graded-work", "unknown", false, false), "withhold");
  assert.equal(helpBoundary("graded-work", "allowed", true, true), "withhold", "conflict");
  assert.equal(helpBoundary("graded-work", "coaching", false, true), "coaching");
  assert.equal(helpBoundary("debugging", "unknown", false, true), "withhold", "debugging an open graded assignment is graded work");
  assert.equal(helpBoundary("formative-practice", "restricted", false, false), "withhold");
  // A quoted course rule code couldn't classify stays unknown (the UW default applies only when the course states nothing).
  const open = res({ sourceId: "s-a", courseId: "c220", kind: "assignment", policy: { mode: "unknown", evidence: "Ask me before using AI." } });
  assert.equal(learningSource(open, sources, undefined)!.openGraded, true);
  assert.equal(decideLearning(selectTaskMode(["why does my code crash?"]), [learningSource(open, sources, undefined)!], { learningContract: LEARNING_CONTRACT }).status, "withheld");
});

test("task mode comes from the student's words, strictest signal first; nothing defaults to concept", () => {
  const mode = (t: string) => selectTaskMode([t]).mode;
  assert.equal(mode("Solve Homework 3 for me."), "graded-work");
  assert.equal(mode("What is the answer to question 2?"), "graded-work", "a question form doesn't hide a request for answers");
  assert.equal(mode("What is recursion? Also write my essay for Essay 1."), "graded-work", "graded signal wins over concept");
  assert.equal(mode("do problem 4 for me"), "graded-work");
  assert.equal(mode("Explain what a base case is in recursion."), "concept");
  assert.equal(mode("How do I solve recurrence problems?"), "concept", "a general study question is not a named graded deliverable");
  assert.equal(mode("my code throws a NullPointerException"), "debugging");
  assert.equal(mode("quiz me on hashing"), "formative-practice");
  assert.equal(mode("What is the late policy in CS 400?"), "administrative");
  assert.equal(mode("Explain the policy iteration algorithm"), "concept", "logistics matches logistics phrases only, since restriction doesn't withhold it");
  assert.equal(mode("does a heap need to be balanced?"), "unclear");
  assert.equal(selectTaskMode(["recursion", "Solve Homework 3 for me."]).mode, "graded-work", "the raw utterance counts, not only the router's extracted query");
  const open = res({ sourceId: "s-a", courseId: "c220", kind: "assignment", title: "Homework 3", policy: { mode: "allowed", evidence: "AI allowed." } });
  const d = decideLearning(selectTaskMode(["What is a base case?"]), [learningSource(open, sources, undefined)!], { learningContract: LEARNING_CONTRACT });
  assert.equal(d.status, "ready");
  assert.match(d.status === "ready" ? d.request.system : "", /Task mode: graded-work\. Help boundary: coaching\.\nTask mode basis: the student's words asks to explain a concept \(concept\); an open graded item is in scope\./);
});

test("rule text is quoted in full with its revision; an over-long rule holds the request instead of being cut", () => {
  const long = "Rule start. " + "Condition applies. ".repeat(50) + "Final condition: never on exams.";
  const a = res({ sourceId: "s-a", courseId: "c220", policy: { mode: "allowed", evidence: long } });
  const ready = decideLearning(concept, [learningSource(a, sources, undefined)!], { learningContract: LEARNING_CONTRACT });
  assert.equal(ready.status, "ready");
  assert.ok(ready.status === "ready" && ready.request.system.includes(JSON.stringify(long.trim())), "the whole rule, including its last condition");
  assert.match(ready.status === "ready" ? ready.request.system : "", /Policy revision: claims none; input h\d+\./);
  assert.match(ready.status === "ready" ? ready.request.system : "", new RegExp(`\\[uw/c220\\] "Item \\d+" ${a.id} content ${a.contentHash}`));
  const huge = res({ sourceId: "s-a", courseId: "c220", policy: { mode: "allowed", evidence: "x".repeat(POLICY_EVIDENCE_LIMIT + 1) } });
  const held = decideLearning(concept, [learningSource(huge, sources, undefined)!], { learningContract: LEARNING_CONTRACT });
  assert.equal(held.status, "withheld");
  assert.match(held.status === "withheld" ? held.reason : "", /longer than it can include in full/);
});

test("a resource's own captured rule still applies when course-intelligence claims exist", () => {
  const r = res({ sourceId: "s-a", courseId: "c220", policy: { mode: "restricted", evidence: "No AI on this assignment." } });
  const profile = { accountScope: "uw", courseId: "c220", inputHash: "ih1", claims: [{ id: "cl1", kind: "ai_policy", scope: "course", policyMode: "allowed", evidence: [{ resourceId: "syl", quote: "AI is allowed for study." }] }] } as never;
  const s = learningSource(r, sources, [profile])!;
  assert.equal(s.policy.mode, "restricted");
  assert.equal(s.policy.conflict, true);
  assert.deepEqual(s.policy.evidence, ["AI is allowed for study.", "No AI on this assignment."]);
  assert.equal(decideLearning(concept, [s], { learningContract: LEARNING_CONTRACT }).status, "withheld");
});

test("an explicit source restriction applies even without a captured quote; default unknown does not override verified course permission", () => {
  const profile = { accountScope: "uw", courseId: "c220", inputHash: "ih2", claims: [{ id: "cl2", kind: "ai_policy", scope: "course", policyMode: "allowed", evidence: [{ resourceId: "syl", quote: "AI is allowed for concept study." }] }] } as never;
  const restricted = res({ sourceId: "s-a", courseId: "c220", text: "A reading on SQL joins.", policy: { mode: "restricted", evidence: "" } });
  const held = learningSource(restricted, sources, [profile])!;
  assert.equal(held.policy.mode, "restricted");
  assert.equal(decideLearning(concept, [held], { learningContract: LEARNING_CONTRACT }).status, "withheld");
  const ordinary = res({ sourceId: "s-a", courseId: "c220", text: "A reading on SQL joins.", policy: { mode: "unknown", evidence: "" } });
  assert.equal(learningSource(ordinary, sources, [profile])!.policy.mode, "allowed");
});

test("course videos come from citations, links in cited sources and module placement only", () => {
  const video = res({ sourceId: "s-a", courseId: "c220", title: "Hash tables walkthrough", url: "https://canvas.wisc.edu/courses/1/modules/items/9",
    moduleItem: { type: "ExternalUrl", externalUrl: "https://www.youtube.com/watch?v=abc123&t=90", moduleId: "m1" } as Resource["moduleItem"] });
  const reading = res({ sourceId: "s-a", courseId: "c220", title: "Week 3 reading", moduleItem: { type: "Page", moduleId: "m1" } as Resource["moduleItem"],
    links: [{ url: "https://youtu.be/abc123", text: "Same video" }, { url: "https://mediaspace.wisc.edu/media/Lecture+3/1_x", text: "Lecture 3 recording" }, { url: "https://example.com/watch?v=zzz", text: "Not a known video host" }] });
  const unrelated = res({ sourceId: "s-a", courseId: "c220", moduleItem: { type: "ExternalUrl", externalUrl: "https://www.youtube.com/watch?v=other", moduleId: "m2" } as Resource["moduleItem"] });
  const result = courseVideosFor([reading.id], [video, reading, unrelated], sources, [{ accountScope: "uw", courseId: "c220" }]);
  assert.equal(result.status, "found");
  if (result.status !== "found") return;
  assert.deepEqual(result.videos.map((v) => [v.key, v.relation.kind]), [["youtube:abc123", "linked"], ["mediaspace.wisc.edu/media/Lecture+3/1_x", "linked"]],
    "youtu.be and the module's youtube.com link are one video; unknown hosts and other modules are never included");
  assert.equal(result.videos[1]!.needsUwSignIn, true);
  assert.equal(result.videos[0]!.course.accountScope, "uw");
  const cited = courseVideosFor([video.id], [video, reading], sources, [{ accountScope: "uw", courseId: "c220" }]);
  assert.equal(cited.status === "found" && cited.videos[0]!.relation.kind, "cited");
  assert.equal(cited.status === "found" && cited.videos[0]!.startSeconds, 90);
});

test("excluded courses, other accounts and missing data give honest empty states", () => {
  const reading = res({ sourceId: "s-x", courseId: "c220", links: ["https://youtu.be/abc123"] });
  assert.equal(courseVideosFor([reading.id], [reading], sources, [{ accountScope: "uw", courseId: "c220" }]).status, "none", "same course id, other account");
  assert.equal(courseVideosFor([reading.id], [], sources, []).status, "unavailable");
  const plain = res({ sourceId: "s-a", courseId: "c220" });
  const none = courseVideosFor([plain.id], [plain], sources, [{ accountScope: "uw", courseId: "c220" }]);
  assert.equal(none.status, "none");
  assert.match(none.status === "none" ? none.reason : "", /doesn't search YouTube/);
  assert.equal(videoLink("http://www.youtube.com/watch?v=abc"), null, "https only");
  assert.equal(videoLink("https://www.youtube.com/"), null, "a channel page is not a video");
  assert.equal(asksForVideo("is there a video on this?"), true);
  assert.equal(asksForVideo("explain hashing"), false);
});

test("voice: a failed session is retryable error, missing capability is unavailable", () => {
  const controls = { onStart() {}, onStop() {} };
  assert.equal(launcherVoice(false, { phase: "idle", levels: [] }, controls).state, "unavailable");
  const denied = launcherVoice(true, { phase: "unavailable", reason: "permission-denied", levels: [] }, controls);
  assert.equal(denied.state, "error");
  assert.match(denied.reason!, /System Settings/);
  assert.equal(launcherVoice(true, { phase: "idle", levels: [] }, controls).state, "ready");
  assert.deepEqual(launcherVoice(true, { phase: "listening", levels: [0.2, 0.4] }, controls).levels, [0.2, 0.4]);
  assert.equal(launcherVoice(true, { phase: "transcribing", levels: [0.2] }, controls).levels, undefined, "levels only while listening");
  assert.equal(voiceAnnouncement("ready", "listening"), "Listening. Press Escape or Stop voice to stop.");
  assert.equal(voiceAnnouncement("working", "ready"), "Voice stopped");
  assert.equal(voiceAnnouncement("listening", "error"), null, "errors are announced by their alert");
});
