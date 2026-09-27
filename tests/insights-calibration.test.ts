import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "../packages/learning/src/config";
import { calibration } from "../packages/learning/src/insights/calibration";
import { sessionHistory } from "../packages/learning/src/insights/history";
import { conceptState } from "../packages/learning/src/knowledge/state";
import type { LearningAttempt } from "../packages/learning/src/store";

let n = 0;
function att(concept: string, score: number, confidence: number | null, over: Partial<LearningAttempt> = {}): LearningAttempt {
  n++;
  return {
    id: `a${n}`, courseRef: "r", itemId: `i${n}`, itemVersion: 1, sourceResourceId: null, primaryConceptId: concept, correct: score >= 1,
    assistance: "none", seenBefore: false, confidence, createdAt: `2026-09-20T10:${String(n % 60).padStart(2, "0")}:00.000Z`, format: "mc",
    mode: "learn", response: null, score, gradingMethod: "exact", responseMs: 4000 + n, conceptTags: [{ conceptId: concept, weight: 1, primary: true }],
    sessionId: "s1", localDay: "2026-09-20", ...over,
  };
}

test("negative: nothing is shown with fewer than 10 rated answers", () => {
  const c = calibration([...Array.from({ length: 9 }, () => att("c1", 1, 1)), att("c1", 0, null), att("c1", 0, 1, { assistance: "hint" })]);
  assert.equal(c.status, "not_enough");
  assert.equal(c.rated, 9);
});

test("counts per confidence level, and overconfident topics linked to their R4 reasons", () => {
  const list = [
    ...Array.from({ length: 6 }, () => att("c1", 1, 1)),
    ...Array.from({ length: 5 }, () => att("c2", 0, 0.67)),
    att("c2", 1, 1),
    att("c3", 0, 1),
    ...Array.from({ length: 3 }, () => att("c3", 1, 0.33)),
    att("c3", 0, 0),
  ];
  const reasons = new Map([["c2", [{ rule: "R4" as const, text: "You were fairly sure and got it wrong (20 Sep).", eventIds: ["x"], clearsWhen: "y" }, { rule: "R1" as const, text: "", eventIds: [], clearsWhen: "" }]]]);
  const c = calibration(list, { reasonsByConcept: reasons, selfRatings: [{ id: "sr", conceptId: "c2", rating: "know_it", delayed: true, localDay: "2026-09-20", createdAt: "2026-09-20T09:00:00Z" }] });
  assert.equal(c.status, "ready");
  if (c.status !== "ready") return;
  assert.deepEqual(c.levels.map((l) => l.text), ["Guess: 0 of 1 right", "Unsure: 3 of 3 right", "Fairly sure: 0 of 5 right", "Sure: 7 of 8 right"]);
  assert.deepEqual(c.overconfident.map((o) => o.conceptId), ["c2"]);
  assert.deepEqual(c.overconfident[0]!.reasons.map((r) => r.rule), ["R4"]);
  assert.equal(c.overconfident[0]!.selfRatings.length, 1);
  // Everything is counts: no percentage or score anywhere.
  assert.doesNotMatch(JSON.stringify(c), /%|score|percent/i);
});

test("session history: outcomes as counts, concepts and anchors; no time-on-task totals", () => {
  const a = [att("c1", 1, null, { sessionId: "s1", itemId: "q1" }), att("c2", 0, null, { sessionId: "s1", itemId: "q2" }), att("c1", 0.5, null, { sessionId: "s2", itemId: "q1", mode: "write" })];
  const sources = new Map([["q1", [{ resourceId: "r1", contentHash: "h", textHash: "t", start: 5, end: 30, quote: "a quote of 25 characters.", quoteValid: true }]]]);
  const disputes = [{ id: "d", courseRef: "r", targetKind: "grade" as const, targetId: a[1]!.id, reason: "grade_wrong", note: null, status: "open" as const, createdAt: "", resolvedAt: null }];
  const h = sessionHistory([{ id: "s1", courseRef: "r", kind: "learn", plan: {}, minutes: 10, difficulty: "normal", startedAt: "2026-09-19T10:00:00Z", endedAt: null }], a, { disputes, sourcesByItem: sources });
  const s1 = h.find((x) => x.sessionId === "s1")!;
  assert.deepEqual(s1.outcomes, { right: 1, partial: 0, wrong: 0, contested: 1, withHelp: 0 });
  assert.deepEqual(s1.concepts, ["c1", "c2"]);
  assert.equal(s1.anchors[0]!.resourceId, "r1");
  assert.equal(h.find((x) => x.sessionId === "s2")!.outcomes.partial, 1);
  const keys: string[] = [];
  JSON.parse(JSON.stringify(h), (k, v) => (keys.push(k), v));
  for (const k of keys) assert.doesNotMatch(k, /time|minute|second|duration|active|productiv|effort/i, k);
});

test("negative: time never feeds the knowledge model", () => {
  const map = [{ id: "c1", courseRef: "r", parentId: null, label: "c1", kind: "concept" as const, position: 0, origin: "code" as const, status: "active" as const, mergedInto: null, studentLabel: null, mapVersion: "m", sources: [] }];
  const base = [att("c1", 1, null), att("c1", 0, null), att("c1", 1, null)];
  const items = new Map(base.map((x) => [`${x.itemId}@1`, { bPrior: -0.5, options: 4, status: "active" as const }]));
  const ev = { reviews: [], selfRatings: [], disputes: [], items, cards: new Map() };
  const now = new Date("2026-09-21T00:00:00Z");
  const fast = conceptState({ ...ev, attempts: base.map((x) => ({ ...x, responseMs: 100 })) }, map, CONFIG, now);
  const slow = conceptState({ ...ev, attempts: base.map((x) => ({ ...x, responseMs: 900_000 })) }, map, CONFIG, now);
  assert.deepEqual(fast, slow);
});
