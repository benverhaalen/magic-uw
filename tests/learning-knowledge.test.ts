import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG, type ItemFormat } from "../packages/learning/src/config";
import { conceptState, toView, type KnowledgeEvidence } from "../packages/learning/src/knowledge/state";
import { r1 } from "../packages/learning/src/knowledge/rules";
import { params } from "../packages/learning/src/config";
import type { Concept, Dispute, LearningAttempt, LearningReview } from "../packages/learning/src/store";
import { smoke } from "./learning-fixtures";

const REF = "synthetic:SYN101";
const concept = (id: string): Concept => ({ id, courseRef: REF, parentId: null, label: id, kind: "concept", position: 0, origin: "code", status: "active", mergedInto: null, studentLabel: null, mapVersion: "m", sources: [] });
const MAP = [concept("c1"), concept("c2")];
const B = CONFIG.bFormat.value;

let seq = 0;
interface A { item?: string; format?: ItemFormat; options?: number; y: number; day?: string; session?: string; assistance?: LearningAttempt["assistance"]; confidence?: number | null; concept?: string; bloom?: "remember" | "understand" }
function attempts(list: A[]): { attempts: LearningAttempt[]; items: KnowledgeEvidence["items"] } {
  const items: KnowledgeEvidence["items"] = new Map();
  const out = list.map((a, i) => {
    seq++;
    const format = a.format ?? "typed";
    const itemId = a.item ?? `item-${seq}`;
    const b = B[format] + (a.bloom === "remember" ? -0.25 : 0);
    items.set(`${itemId}@1`, { bPrior: b, options: a.options ?? (format === "mc" ? 4 : format === "tf" ? 2 : 0), status: "active" });
    const day = a.day ?? "2026-09-20";
    return {
      id: `att-${seq}`, courseRef: REF, itemId, itemVersion: 1, sourceResourceId: null, primaryConceptId: a.concept ?? "c1",
      correct: a.y >= 1, assistance: a.assistance ?? "none", seenBefore: false, confidence: a.confidence ?? null,
      createdAt: `${day}T15:${String(10 + Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
      format, mode: "learn", response: null, score: a.y, gradingMethod: "exact", responseMs: 3000,
      conceptTags: [{ conceptId: a.concept ?? "c1", weight: 1, primary: true }], sessionId: a.session ?? `sess-${day}`, localDay: day,
    } satisfies LearningAttempt;
  });
  return { attempts: out, items };
}

function evidence(list: A[], extra: Partial<KnowledgeEvidence> = {}): KnowledgeEvidence {
  const { attempts: at, items } = attempts(list);
  return { attempts: at, reviews: [], selfRatings: [], disputes: [], items, cards: new Map(), ...extra };
}

const state = (ev: KnowledgeEvidence, today = "2026-09-20", r?: Record<string, number | null>) =>
  conceptState(ev, MAP, CONFIG, new Date(`${today}T23:00:00.000Z`), r, { today }).find((m) => m.conceptId === "c1")!;
const rules = (m: { reasons: { rule: string }[] }) => m.reasons.map((r) => r.rule);

interface Row { id: string; label: string; format: ItemFormat; options: number; bloom: "remember" | "understand"; answers: number[]; expected: { acc: number; pHat: number; pLow: number; r1: boolean; band: string } }

test("replays every row of the spec §5.5 worked-check table (evals/cases/smoke/events.json)", () => {
  const rows = smoke<{ rows: Row[] }>("events.json").rows;
  assert.equal(rows.length, 11);
  for (const row of rows) {
    const m = state(evidence(row.answers.map((y) => ({ y, format: row.format, options: row.options, bloom: row.bloom }))));
    const near = (a: number, b: number) => Math.abs(a - b) <= 0.0015;
    assert.ok(near(m.acc!, row.expected.acc), `${row.label}: acc ${m.acc}`);
    assert.ok(near(m.pHat, row.expected.pHat), `${row.label}: p̂ ${m.pHat.toFixed(4)} vs ${row.expected.pHat}`);
    assert.ok(near(m.pLow, row.expected.pLow), `${row.label}: p_low ${m.pLow.toFixed(4)} vs ${row.expected.pLow}`);
    assert.equal(rules(m).includes("R1"), row.expected.r1, `${row.label}: R1`);
    assert.equal(m.band, row.expected.band, `${row.label}: band`);
  }
});

test("conceptState is pure: the same inputs give deep-equal output, whatever the input order (KM-4)", () => {
  const ev = evidence([{ y: 1 }, { y: 0 }, { y: 1, format: "mc" }, { y: 1 }]);
  const now = new Date("2026-09-21T00:00:00Z");
  const a = conceptState(ev, MAP, CONFIG, now);
  const b = conceptState({ ...ev, attempts: [...ev.attempts].reverse() }, MAP, CONFIG, now);
  assert.deepEqual(a, b);
  assert.equal(a[0]!.configVersion, "km-0.1");
});

test("negative: R1 never fires when every scored answer is correct, in any format", () => {
  for (const [format, n] of [["mc", 3], ["mc", 4], ["tf", 10], ["mc", 20], ["typed", 5]] as const) {
    const m = state(evidence(Array.from({ length: n }, () => ({ y: 1, format }))));
    assert.ok(!rules(m).includes("R1"), `${n}/${n} ${format}`);
  }
  // n < 3, and only assisted attempts wrong
  assert.ok(!rules(state(evidence([{ y: 0 }, { y: 0 }]))).includes("R1"));
  assert.ok(!rules(state(evidence([{ y: 1 }, { y: 1 }, { y: 1 }, { y: 0, assistance: "hint" }, { y: 0, assistance: "explained" }]))).includes("R1"));
});

test("hysteresis: R1 stays until p̂ ≥ 0.65 or acc ≥ 0.70; Solid drops to Getting there only below p_low 0.65", () => {
  const m = state(evidence([0, 0, 0, 1, 1, 1, 1].map((y) => ({ y }))));
  assert.equal(m.band, "iffy");
  // Without the prior R1 state, the same numbers wouldn't enter R1 (p̂ ≥ 0.60).
  const fresh = r1({ today: "2026-09-20", n: m.n, pHat: m.pHat, events: [], allEvents: [], reviews: [], r: null, prevR1: false, coveredBy: [] }, params());
  assert.equal(fresh.active, false);
  // 8/8 typed is Solid; one miss after it leaves p_low between 0.65 and 0.75, so it stays Solid.
  const solidThenMiss = state(evidence([1, 1, 1, 1, 1, 1, 1, 1, 0].map((y) => ({ y }))));
  assert.ok(solidThenMiss.pLow < 0.75 && solidThenMiss.pLow >= 0.65, String(solidThenMiss.pLow));
  assert.equal(solidThenMiss.band, "solid");
  const twoMisses = state(evidence([1, 1, 1, 1, 1, 1, 1, 1, 0, 0].map((y) => ({ y }))));
  assert.notEqual(twoMisses.band, "solid");
});

test("a recognition-only record never reaches Solid", () => {
  const m = state(evidence(Array.from({ length: 60 }, () => ({ y: 1, format: "mc" as const }))));
  assert.notEqual(m.band, "solid");
});

test("R2 fires on thin evidence before a covered assessment, and not otherwise", () => {
  const assessments = [{ id: "exam2", title: "Exam 2", at: "2026-09-26T14:00:00.000Z", conceptIds: ["c1"] }];
  const m = state(evidence([{ y: 1 }, { y: 1 }], { assessments }));
  const reason = m.reasons.find((r) => r.rule === "R2")!;
  assert.equal(reason.text, "Only 2 answers so far, and it's on Exam 2 in 6 days.");
  assert.equal(reason.eventIds.length, 2);
  assert.ok(!rules(state(evidence([{ y: 1 }, { y: 1 }], { assessments: [{ ...assessments[0]!, at: "2026-10-20T14:00:00.000Z" }] }))).includes("R2"));
  assert.equal(state(evidence([], { assessments })).band, "not_seen");
});

test("R3 fires on a recent lapse and not on a first-attempt miss, a hinted miss or an old lapse", () => {
  const lapse = evidence([
    { item: "q4", y: 1, day: "2026-09-22" },
    { item: "q4", y: 0, day: "2026-09-26" },
  ]);
  const m = state(lapse, "2026-09-27");
  const r = m.reasons.find((x) => x.rule === "R3")!;
  assert.equal(r.text, "Missed a question on 26 Sep after getting it right on 22 Sep.");
  assert.deepEqual(r.eventIds, [lapse.attempts[1]!.id, lapse.attempts[0]!.id]);
  assert.ok(r.clearsWhen.length > 0);
  assert.ok(!rules(state(evidence([{ item: "q5", y: 0, day: "2026-09-26" }]), "2026-09-27")).includes("R3"));
  assert.ok(!rules(state(evidence([{ item: "q6", y: 1, day: "2026-09-22" }, { item: "q6", y: 0, day: "2026-09-26", assistance: "hint" }]), "2026-09-27")).includes("R3"));
  assert.ok(!rules(state(lapse, "2026-10-05")).includes("R3"));
  const cleared = evidence([{ item: "q7", y: 1, day: "2026-09-22" }, { item: "q7", y: 0, day: "2026-09-26" }, { y: 1, day: "2026-09-26", session: "later" }]);
  assert.ok(!rules(state(cleared, "2026-09-27")).includes("R3"));
  // A card lapse: Again on a card in the Review state.
  const fsrs = { due: "", stability: 5, difficulty: 5, elapsed_days: 0, scheduled_days: 5, learning_steps: 0, reps: 3, lapses: 0, state: 2, last_review: null };
  const again: LearningReview = { id: "rv1", cardId: "k1", rating: 1, stateBefore: fsrs, stateAfter: { ...fsrs, state: 3 }, reviewMs: 900, localDay: "2026-09-26", undoesReviewId: null, createdAt: "2026-09-26T12:00:00.000Z" };
  const card = state(evidence([], { reviews: [again], cards: new Map([["k1", { conceptId: "c1", isConceptTrack: false }]]) }), "2026-09-27");
  assert.ok(rules(card).includes("R3"));
  assert.equal(card.band, "iffy");
});

test("R4 fires on a confident miss and not on low or missing confidence, a disputed item, or after a correct retry", () => {
  const m = state(evidence([{ item: "q1", y: 0, confidence: 0.67, day: "2026-09-26" }]), "2026-09-27");
  assert.equal(m.reasons.find((r) => r.rule === "R4")!.text, "You were fairly sure and got it wrong (26 Sep).");
  assert.ok(!rules(state(evidence([{ y: 0, confidence: null, day: "2026-09-26" }]), "2026-09-27")).includes("R4"));
  assert.ok(!rules(state(evidence([{ y: 0, confidence: 0.33, day: "2026-09-26" }]), "2026-09-27")).includes("R4"));
  const disputed: Dispute = { id: "d1", courseRef: REF, targetKind: "item", targetId: "q2", reason: "wrong_key", note: null, status: "open", createdAt: "2026-09-26T16:00:00Z", resolvedAt: null };
  assert.ok(!rules(state(evidence([{ item: "q2", y: 0, confidence: 1, day: "2026-09-26" }], { disputes: [disputed] }), "2026-09-27")).includes("R4"));
  assert.ok(!rules(state(evidence([{ item: "q3", y: 0, confidence: 1, day: "2026-09-25" }, { item: "q3", y: 1, day: "2026-09-26" }]), "2026-09-27")).includes("R4"));
});

test("R5 fires when retrievability is below 0.80, and never with no cards and no scored attempts", () => {
  const m = state(evidence([{ y: 1, day: "2026-09-01" }]), "2026-09-21", { c1: 0.7 });
  assert.equal(m.reasons.find((r) => r.rule === "R5")!.text, "Fading: last reviewed 20 days ago.");
  assert.ok(!rules(state(evidence([{ y: 1 }]), "2026-09-20", { c1: 0.85 })).includes("R5"));
  const none = state(evidence([]), "2026-09-21", { c1: 0.5 });
  assert.ok(!rules(none).includes("R5"));
  assert.equal(none.band, "not_seen");
});

test("R6 fires on a recognition–recall gap and not with thin groups or a gap the other way", () => {
  const gap: A[] = [1, 1, 1, 1].map((y): A => ({ y, format: "mc" })).concat([1, 0, 0].map((y) => ({ y, format: "typed" as const })));
  const m = state(evidence(gap));
  assert.equal(m.reasons.find((r) => r.rule === "R6")!.text, "Right on multiple choice (4 of 4) but on typed answers only 1 of 3.");
  assert.ok(!rules(state(evidence(gap.slice(0, 6)))).includes("R6"));
  const reverse: A[] = [1, 0, 0].map((y): A => ({ y, format: "mc" })).concat([1, 1, 1].map((y) => ({ y, format: "typed" as const })));
  assert.ok(!rules(state(evidence(reverse))).includes("R6"));
});

test("negative: hinted, explained, disputed, quarantined and same-session repeat attempts leave θ and n unchanged", () => {
  const base = [{ item: "b1", y: 1 }, { item: "b2", y: 0 }, { item: "b3", y: 1 }];
  const before = state(evidence(base));
  const cases: [string, A[], Partial<KnowledgeEvidence>?][] = [
    ["hint", [{ item: "x1", y: 0, assistance: "hint" }]],
    ["explained", [{ item: "x2", y: 1, assistance: "explained" }]],
    ["repeat", [{ item: "b1", y: 0 }]],
  ];
  for (const [name, extra] of cases) {
    const after = state(evidence([...base, ...extra]));
    assert.equal(after.theta, before.theta, name);
    assert.equal(after.n, before.n, name);
  }
  const withX = evidence([...base, { item: "x3", y: 0 }]);
  const disputed: Dispute = { id: "d", courseRef: REF, targetKind: "item", targetId: "x3", reason: "wrong_key", note: null, status: "open", createdAt: "2026-09-20T16:00:00Z", resolvedAt: null };
  assert.equal(state({ ...withX, disputes: [disputed] }).theta, before.theta);
  const grade: Dispute = { ...disputed, targetKind: "grade", targetId: withX.attempts[3]!.id };
  assert.equal(state({ ...withX, disputes: [grade] }).theta, before.theta);
  const items = new Map(withX.items);
  items.set("x3@1", { ...items.get("x3@1")!, status: "quarantined" });
  assert.equal(state({ ...withX, items }).n, before.n);
  // Withdrawing the dispute restores the attempt.
  assert.notEqual(state({ ...withX, disputes: [{ ...disputed, status: "undone" }] }).theta, before.theta);
});

test("negative: ConceptView and its JSON carry no theta, p_hat, probability or percent fields (KM-6)", () => {
  const m = state(evidence([{ y: 1 }, { y: 0 }, { y: 0 }, { y: 0 }]));
  const view = toView(m, MAP);
  const json = JSON.stringify(view);
  const keys: string[] = [];
  JSON.parse(json, (k, v) => (keys.push(k), v));
  for (const k of keys) assert.doesNotMatch(k, /theta|p_?hat|p_?low|p_?high|prob|percent|^n$|^s$|^r$|^acc$/i, k);
  assert.doesNotMatch(json, /%/);
  assert.equal(view.state, "iffy");
});

test("negative: a self-rating alone never moves a concept out of Not seen yet (KM-9, KM-11)", () => {
  const m = state(evidence([], { selfRatings: [{ id: "sr", conceptId: "c1", rating: "know_it", delayed: true, localDay: "2026-09-20", createdAt: "2026-09-20T10:00:00Z" }] }));
  assert.equal(m.band, "not_seen");
  assert.equal(m.counts.selfRatings, 1);
});
