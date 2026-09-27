import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAnchor, keepAnchored, makeAnchor, studyThisNext } from "../packages/learning/src/insights/anchors";
import { materialChanges, stateTransitions } from "../packages/learning/src/insights/changes";
import { coverageMap, statesByAssessment } from "../packages/learning/src/insights/coverage-map";
import { conceptState, toView } from "../packages/learning/src/knowledge/state";
import type { Concept, LearningAttempt } from "../packages/learning/src/store";

const lec = { id: "lec2", version: 1, title: "Lecture 2: Recurrences", text: "Lecture 2: Recurrences\n\nMerge sort\nMerge sort splits the array into two halves and merges them in linear time." };

test("anchors carry a label and validate against their stated version; 'study this next' returns the anchor and a quick session", () => {
  const start = lec.text.indexOf("Merge sort splits");
  const a = makeAnchor(lec, start, start + 40);
  assert.equal(a.label, "Lecture 2: Recurrences · Merge sort");
  assert.deepEqual(checkAnchor(a, a.quote, lec), { status: "valid" });
  const next = studyThisNext("c1", a);
  assert.equal(next.anchor, a);
  assert.deepEqual(next.quick, { op: "practice.quick", conceptId: "c1", minutes: 5 });
});

test("negative: an insight whose anchor fails validation isn't returned; a superseded version is 'passage changed', never fuzzy-matched", () => {
  const start = lec.text.indexOf("Merge sort splits");
  const a = makeAnchor(lec, start, start + 40);
  const v2 = { ...lec, version: 2, text: lec.text.replace("two halves", "two equal halves") };
  assert.deepEqual(checkAnchor(a, a.quote, v2), { status: "passage_changed", text: "This passage changed since you studied it." });
  assert.deepEqual(checkAnchor({ ...a, start: a.start + 1, end: a.end + 1 }, a.quote, lec), { status: "invalid" });
  const kept = keepAnchored(
    [
      { kind: "next", text: "Study merge sort next", anchors: [a], evidenceIds: [], quotes: [a.quote] },
      { kind: "next", text: "Broken", anchors: [{ ...a, end: a.end + 5 }], evidenceIds: [], quotes: [a.quote] },
    ],
    new Map([["lec2", lec]]),
  );
  assert.deepEqual(kept.map((i) => i.text), ["Study merge sort next"]);
  assert.equal(keepAnchored([{ kind: "next", text: "Old", anchors: [a], evidenceIds: [], quotes: [a.quote] }], new Map([["lec2", v2]])).length, 0);
});

const att = (id: string, itemId: string, over: Partial<LearningAttempt> = {}): LearningAttempt => ({
  id, courseRef: "r", itemId, itemVersion: 1, sourceResourceId: null, primaryConceptId: "c1", correct: true, assistance: "none", seenBefore: false,
  confidence: null, createdAt: "2026-09-20T10:00:00.000Z", format: "typed", mode: "learn", response: null, score: 1, gradingMethod: "exact",
  responseMs: 1, conceptTags: [{ conceptId: "c1", weight: 1, primary: true }], sessionId: "s", localDay: "2026-09-20", ...over,
});

test("the coverage map marks practiced, studied or untouched, lists uncaptured material apart, and reports counts and the tier", () => {
  const src = (resourceId: string) => [{ resourceId, contentHash: "h", textHash: "t", start: 0, end: 20, quote: "q".repeat(20), quoteValid: true }];
  const m = coverageMap({
    assessmentId: "exam1", tier: "T2",
    materials: [{ resourceId: "lec1", title: "L1", captured: true }, { resourceId: "lec2", title: "L2", captured: true }, { resourceId: "lec3", title: "L3", captured: true }, { resourceId: "lec4", title: "L4", captured: true }, { resourceId: "slides5", title: "Slides 5", captured: false }],
    attempts: [att("a1", "q1")],
    sourcesByItem: new Map([["q1", src("lec1")]]),
    views: [
      { id: "v1", resourceId: "lec2", version: 1, start: 0, end: 10, activeSeconds: 20, localDay: "d", createdAt: "" },
      { id: "v2", resourceId: "lec2", version: 1, start: 0, end: 10, activeSeconds: 15, localDay: "d", createdAt: "" },
      { id: "v3", resourceId: "lec3", version: 1, start: 0, end: 10, activeSeconds: 29, localDay: "d", createdAt: "" },
    ],
  });
  assert.deepEqual(m.rows.map((r) => r.status), ["practiced", "studied", "untouched", "untouched"]);
  assert.deepEqual(m.notCaptured.map((r) => r.resourceId), ["slides5"]);
  assert.equal(m.text, "1 of 4 materials practiced; 1 not captured");
  assert.equal(m.tier, "T2");
  assert.ok(!m.rows.some((r) => r.resourceId === "slides5"), "uncaptured is never 'untouched'");
  assert.doesNotMatch(JSON.stringify(m), /%|ready|readiness|predict|score/i);
});

const REF = "r";
const concept = (id: string, label: string): Concept => ({ id, courseRef: REF, parentId: null, label, kind: "concept", position: 0, origin: "code", status: "active", mergedInto: null, studentLabel: null, mapVersion: "m", sources: [] });
const MAP = [concept("c1", "Recurrences"), concept("c2", "Hashing")];

test("concept states grouped by assessment carry the KM-6 fields only", () => {
  const ev = { attempts: [att("a1", "q1")], reviews: [], selfRatings: [], disputes: [], items: new Map([["q1@1", { bPrior: 0.5, options: 0, status: "active" as const }]]), cards: new Map() };
  const views = conceptState(ev, MAP, undefined, new Date("2026-09-21T00:00:00Z")).map((m) => toView(m, MAP));
  const grouped = statesByAssessment(views, [{ id: "exam1", title: "Exam 1", conceptIds: ["c1", "c2"] }]);
  assert.equal(grouped[0]!.concepts.length, 2);
  const keys: string[] = [];
  JSON.parse(JSON.stringify(grouped), (k, v) => (keys.push(k), v));
  for (const k of keys) assert.doesNotMatch(k, /theta|p_?hat|p_?low|prob|percent/i, k);
});

test("what changed: state transitions with their rule and evidence, and materials new or changed since last week", () => {
  const attempts = [
    att("a1", "q4", { localDay: "2026-09-20", createdAt: "2026-09-20T10:00:00.000Z", sessionId: "s1" }),
    att("a2", "q4", { localDay: "2026-09-24", createdAt: "2026-09-24T10:00:00.000Z", sessionId: "s2", correct: false, score: 0 }),
  ];
  const ev = { attempts, reviews: [], selfRatings: [], disputes: [], items: new Map([["q4@1", { bPrior: 0.5, options: 0, status: "active" as const }]]), cards: new Map() };
  const t = stateTransitions(ev, MAP, "2026-09-19", "2026-09-26");
  assert.deepEqual(t.map((x) => [x.day, x.from, x.to]), [["2026-09-20", "not_seen", "getting_there"], ["2026-09-24", "getting_there", "iffy"]]);
  assert.equal(t[1]!.text, "Recurrences: Getting there → Iffy on 24 Sep. Missed a question on 24 Sep after getting it right on 20 Sep. (R3)");
  assert.deepEqual(t[1]!.eventIds, ["a2", "a1"]);
  const mats = materialChanges([
    { id: "r1", title: "Lecture 4", firstSeenAt: "2026-09-22T00:00:00Z", lastChangedAt: "2026-09-22T00:00:00Z", version: 1 },
    { id: "r2", title: "Syllabus", firstSeenAt: "2026-09-01T00:00:00Z", lastChangedAt: "2026-09-23T00:00:00Z", version: 3 },
    { id: "r3", title: "Lecture 1", firstSeenAt: "2026-09-01T00:00:00Z", lastChangedAt: "2026-09-01T00:00:00Z", version: 1 },
  ], "2026-09-19");
  assert.deepEqual(mats.map((m) => m.text), ["Changed: Syllabus", "New: Lecture 4"]);
  assert.doesNotMatch(JSON.stringify({ t, mats }), /%|ready|readiness|predict/i);
});
