// owner: exam-prep. N15: the blueprint derived by code from course evidence, and the practice exam
// assembled from it: scope respected, graded work never used, sections and formats matched,
// the §5.7 allocation (largest remainder, lean ≤ 1.5 × κ, one per covered topic when it fits).
import test from "node:test";
import assert from "node:assert/strict";
import { allocate, buildPracticeExam, leanWeights } from "../packages/learning/src/exam/exam";
import { classifyDocs, deriveBlueprint, numberedScope } from "../packages/learning/src/exam/blueprint";
import { parseAnswers, parseExam } from "../packages/learning/src/exam/parse";
import { createExamEvidence } from "../packages/learning/src/exam/evidence";
import type { ExamBlueprint, SolveProblem } from "../packages/learning/src/exam/types";
import type { ConceptStateName } from "../packages/learning/src/types";
import { examFixture, NOW, TEXTS } from "./exam-fixture";

const topics = [
  { id: "t-speed", label: "Average speed", moduleId: "m1", moduleLabel: "Module 1: Kinematics" },
  { id: "t-disp", label: "Displacement", moduleId: "m1", moduleLabel: "Module 1: Kinematics" },
  { id: "t-power", label: "Power rule", moduleId: "m2", moduleLabel: "Module 2: Derivatives" },
  { id: "t-factor", label: "Factoring", moduleId: "m2", moduleLabel: "Module 2: Derivatives" },
  { id: "t-loops", label: "Loops", moduleId: "m3", moduleLabel: "Module 3: Loops" },
];
const modules = [
  { id: "m1", label: "Module 1: Kinematics" },
  { id: "m2", label: "Module 2: Derivatives" },
  { id: "m3", label: "Module 3: Loops" },
];

function blueprintOf(opts: Parameters<typeof examFixture>[0] = {}, mutate?: (e: NonNullable<ReturnType<ReturnType<typeof createExamEvidence>["evidence"]>>) => void): ExamBlueprint {
  const f = examFixture(opts);
  const evidence = createExamEvidence(f.owner).evidence("acct", "SYN220", "a-mid1")!;
  mutate?.(evidence);
  return deriveBlueprint({ evidence, topics, modules, coverage: [], now: NOW });
}

const allText = (b: ExamBlueprint) => JSON.stringify(b);

test("parse: sections, numbered questions, options, points, formats and levels are read with their offsets", () => {
  const p = parseExam(TEXTS.practice);
  assert.deepEqual(p.sections.map((s) => s.label), ["Part A: Multiple choice (10 points)", "Part B: Problems (20 points)"]);
  assert.deepEqual(p.sections.map((s) => s.format), ["multiple_choice", null]);
  assert.deepEqual(p.questions.map((q) => [q.number, q.format, q.points, q.sectionIndex]), [
    [1, "multiple_choice", 5, 0],
    [2, "multiple_choice", 5, 0],
    [3, "numeric", 10, 1],
    [4, "short_answer", 10, 1],
  ]);
  const q3 = p.questions[2]!;
  assert.equal(TEXTS.practice.slice(q3.formatSpan!.start, q3.formatSpan!.end), "Calculate");
  assert.equal(q3.level, "apply");
  assert.equal(p.questions[3]!.level, "understand");
  assert.equal(p.questions[0]!.level, null, "no level verb: no level is invented");
  assert.equal(p.questions[0]!.stem, "Which quantity is distance divided by time?", "the points marker stays in the quote, not the stem");
  assert.deepEqual(p.questions[0]!.options.map((o) => o.id), ["a", "b", "c", "d"]);
  assert.equal(p.minutes?.value, 75);
  assert.equal(p.totalPoints?.value, 30);
  const answers = parseAnswers(TEXTS.solutions);
  assert.deepEqual(answers.map((a) => a.choice), ["a", "b", null, null]);
  assert.deepEqual(answers[2]!.numeric, { value: 20, unit: "km/h", decimals: 0 });
});

test("documents: a practice exam, its solutions, a review sheet and a past-term exam are told apart; graded work and other exams' documents are not used", () => {
  const f = examFixture();
  const evidence = createExamEvidence(f.owner).evidence("acct", "SYN220", "a-mid1")!;
  const docs = classifyDocs(evidence, NOW);
  const kinds = Object.fromEntries(docs.map((d) => [d.material.title, [d.kind, d.relevance]]));
  assert.deepEqual(kinds["Midterm 1 Practice Exam"], ["practice_exam", 2]);
  assert.deepEqual(kinds["Midterm 1 Practice Exam Solutions"], ["solutions", 2]);
  assert.deepEqual(kinds["Midterm 1 Review Sheet"], ["review_sheet", 2]);
  assert.deepEqual(kinds["Fall 2024 Midterm 1"], ["past_exam", 2]);
  assert.equal(kinds["Practice Final Exam"], undefined, "a practice final is not Midterm 1's evidence");
  assert.equal(docs.some((d) => d.material.graded), false, "Homework 3, Quiz 2 and the midterm itself are graded work");
  assert.equal(evidence.materials.find((m) => m.title === "Midterm 1 Practice Exam")?.role, "exam", "the material pipeline's role fact is read");
});

test("blueprint T1: scope, weight, length and format come from the course's own evidence, each with its quote", () => {
  const b = blueprintOf();
  assert.equal(b.tier, "T1");
  assert.equal(b.tierLabel, "From your instructor's practice exam");
  assert.match(b.basis, /Midterm 1 Practice Exam/);
  assert.equal(b.scope.basis, "stated");
  assert.deepEqual(b.scope.modules.map((m) => m.label), ["Module 1: Kinematics", "Module 2: Derivatives"]);
  assert.deepEqual(b.scope.concepts.map((c) => c.label), ["Average speed", "Displacement", "Power rule", "Factoring"]);
  assert.ok(b.scope.concepts.every((c) => Math.abs(c.weight - 0.25) < 1e-9));
  const stated = b.scope.statements.find((s) => s.kind === "scope_statement")!;
  assert.equal(stated.quote, "Midterm 1 covers Modules 1 and 2.");
  assert.equal(TEXTS.syllabus.slice(stated.start!, stated.end!), stated.quote, "the quote is the exact span of the syllabus");
  assert.ok(b.scope.statements.some((s) => s.kind === "review_sheet" && /covers Modules 1 and 2/.test(s.quote ?? "")));
  assert.equal(b.weight?.percent, 20);
  assert.equal(b.length?.minutes, 75);
  assert.equal(TEXTS.practice.slice(b.length!.evidence[0]!.start!, b.length!.evidence[0]!.end!), "75 minutes");
  assert.equal(b.totalPoints?.value, 30);
  assert.deepEqual(b.sections.map((s) => [s.label, s.items, s.points]), [["Part A: Multiple choice (10 points)", 2, 10], ["Part B: Problems (20 points)", 2, 20]]);
  assert.deepEqual(b.sections[1]!.formats.map((f) => [f.format, f.items, f.points]), [["numeric", 1, 10], ["short_answer", 1, 10]]);
  assert.deepEqual(b.levelMix.map((l) => [l.level, l.items]), [["understand", 1], ["apply", 1]]);
  for (const s of b.sections.flatMap((x) => x.formats.flatMap((f) => f.evidence)))
    if (s.basis === "text" && s.start !== null) assert.equal(TEXTS.practice.slice(s.start, s.end!), s.quote);
  assert.equal(b.thin, false);
  assert.equal(b.excludedResourceIds.length, 3);
  assert.doesNotMatch(allText(b), /will be on/i);
});

test("blueprint with no practice exam: the syllabus's stated format is used (T2); with nothing at all, it is thin and invents no format", () => {
  const t2 = blueprintOf({ practiceDocs: false }, (e) => {
    e.assessment.format = "75-minute in-class exam: multiple choice and short answer problems";
  });
  assert.equal(t2.tier, "T2");
  assert.equal(t2.sections.length, 1);
  assert.deepEqual(t2.formatMix.map((f) => [f.format, f.items]), [["multiple_choice", null], ["short_answer", null]], "the formats are named, the counts aren't invented");
  assert.equal(t2.length?.minutes, 75);
  const thin = blueprintOf({ practiceDocs: false }, (e) => {
    e.scopes = [];
    e.assessment.weight = null;
  });
  assert.equal(thin.thin, true);
  assert.deepEqual(thin.sections, []);
  assert.deepEqual(thin.formatMix, []);
  assert.equal(thin.tier, "T4");
  assert.equal(thin.scope.basis, "none");
  assert.equal(thin.warnings[0], "No coverage statement found. Practice spans the whole course.");
  assert.match(thin.warnings[1]!, /No exam format found/);
  assert.equal(thin.scope.concepts.length, 5, "no scope: the whole course, said first");
});

test("blueprint T3: only a past-term exam gives the format, and the warning says so", () => {
  const b = blueprintOf({}, (e) => {
    e.scopes = [];
    e.materials = e.materials.filter((m) => !/Practice Exam|Review Sheet/.test(m.title));
    e.assessment.weight = null;
  });
  assert.equal(b.tier, "T3");
  assert.match(b.tierLabel, /Partly from Fall 2024 Midterm 1/);
  assert.ok(b.warnings.some((w) => /past-term exams \(Fall 2024 Midterm 1\)/.test(w)));
  assert.deepEqual(b.formatMix.map((f) => f.format).sort(), ["numeric", "short_answer"]);
});

test("scope statements: numbered chapters and modules expand ranges and lists", () => {
  assert.deepEqual([...numberedScope("Chapters 3–5 and 7").get("chapter")!], [3, 4, 5, 7]);
  assert.deepEqual([...numberedScope("covers Modules 1 and 2").get("module")!], [1, 2]);
  assert.deepEqual([...numberedScope("weeks 1 through 4").get("week")!], [1, 2, 3, 4]);
});

// ---------- Allocation (spec §5.7) ----------

test("allocation: largest remainder sums to the total, respects caps, and gives every covered topic one when the length allows", () => {
  const w = new Map([["a", 0.5], ["b", 0.3], ["c", 0.2]]);
  assert.deepEqual(Object.fromEntries(allocate(w, 10, new Map())), { a: 5, b: 3, c: 2 });
  assert.deepEqual(Object.fromEntries(allocate(w, 7, new Map())), { a: 4, b: 2, c: 1 });
  assert.deepEqual(Object.fromEntries(allocate(w, 10, new Map([["a", 2]]))), { a: 2, b: 5, c: 3 }, "a capped topic's share goes to the others");
  const skewed = new Map([["a", 0.9], ["b", 0.05], ["c", 0.05]]);
  assert.deepEqual(Object.fromEntries(allocate(skewed, 3, new Map())), { a: 1, b: 1, c: 1 });
  assert.equal([...allocate(skewed, 2, new Map()).values()].reduce((x, y) => x + y, 0), 2);
});

test("lean toward iffy topics: property — no topic's leaned share exceeds 1.5 × its coverage weight, and λ = 0 is exam-faithful", () => {
  const states: ConceptStateName[] = ["solid", "getting_there", "iffy", "not_seen"];
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let trial = 0; trial < 300; trial++) {
    const n = 2 + Math.floor(rand() * 8);
    const raw = Array.from({ length: n }, () => 0.05 + rand());
    const sum = raw.reduce((a, b) => a + b, 0);
    const kappa = new Map(raw.map((v, i) => [`c${i}`, v / sum]));
    const st = new Map([...kappa.keys()].map((k) => [k, states[Math.floor(rand() * 4)]!]));
    const leaned = leanWeights(kappa, st, true);
    for (const [k, v] of leaned) assert.ok(v <= 1.5 * kappa.get(k)! + 1e-12, `trial ${trial}: ${k} ${v} > 1.5 × ${kappa.get(k)}`);
    assert.ok(Math.abs([...leaned.values()].reduce((a, b) => a + b, 0) - 1) < 1e-9);
    const faithful = leanWeights(kappa, st, false);
    for (const [k, v] of faithful) assert.ok(Math.abs(v - kappa.get(k)!) < 1e-12);
    const length = 5 + Math.floor(rand() * 40);
    const q = allocate(leaned, length, new Map());
    assert.equal([...q.values()].reduce((a, b) => a + b, 0), length);
    if (length >= n) assert.ok([...q.values()].every((x) => x >= 1), `trial ${trial}: a covered topic got nothing`);
    for (const [k, v] of q) assert.ok(v <= Math.ceil(leaned.get(k)! * length) + 1, `trial ${trial}: ${k} over its share`);
  }
});

// ---------- Assembly ----------

const problem = (id: string, conceptId: string | null, format: SolveProblem["format"], over: Partial<SolveProblem> = {}): SolveProblem => ({
  kind: "item",
  id,
  version: 1,
  courseRef: "acct:SYN220",
  stem: id,
  format,
  level: "apply",
  conceptIds: conceptId ? [conceptId] : [],
  steps: [{ id: "answer", prompt: id, answer: { kind: "choice", options: [{ id: "a", text: "A" }], key: "a" }, nudge: null, worked: null, explain: null }],
  workedExample: [],
  source: { resourceId: "r-lecture", contentHash: "h", start: 0, end: 1, quote: "x" },
  origin: "generated",
  tier: "T4",
  points: null,
  checks: [],
  generator: null,
  ...over,
});

test("assembly: graded work and out-of-scope topics are dropped; sections and formats follow the blueprint; provenance is on every question", () => {
  const b = blueprintOf();
  const pool = [
    problem("mc-speed", "t-speed", "multiple_choice"),
    problem("mc-power", "t-power", "multiple_choice"),
    problem("num-speed", "t-speed", "numeric"),
    problem("sa-disp", "t-disp", "short_answer"),
    problem("sa-factor", "t-factor", "short_answer"),
    problem("mc-loops", "t-loops", "multiple_choice"),
    problem("mc-quiz", "t-speed", "multiple_choice", { source: { resourceId: b.excludedResourceIds[0]!, contentHash: "h", start: 0, end: 1, quote: "x" } }),
    problem("instr-3", "t-speed", "numeric", { kind: "problem", origin: "instructor", tier: "T1", points: 10, source: { resourceId: "r-practice", contentHash: "h", start: 0, end: 1, quote: "x" } }),
  ];
  const built = buildPracticeExam({ blueprint: b, candidates: pool, length: 4, lean: false, states: new Map(), labels: new Map(topics.map((t) => [t.id, t.label])), sourceTitles: new Map([["r-practice", "Midterm 1 Practice Exam"]]) });
  const ids = built.plan.questions.map((q) => (q.source.kind === "item" ? q.source.itemId : q.source.problemId));
  assert.ok(!ids.includes("mc-quiz"), "a real quiz is never a source");
  assert.ok(!ids.includes("mc-loops"), "Module 3 is outside the stated scope");
  assert.deepEqual(built.plan.dropped.map((d) => d.reason).sort(), ["From graded work (a real quiz, exam or assignment): never used as practice.", "Outside this exam's stated scope."]);
  assert.deepEqual(built.plan.sections.map((s) => s.label), ["Part A: Multiple choice (10 points)", "Part B: Problems (20 points)"]);
  const bySection = Object.fromEntries(built.plan.sections.map((s) => [s.label, s.questionIds.map((id) => built.plan.questions.find((q) => q.id === id)!.format)]));
  assert.ok(bySection["Part A: Multiple choice (10 points)"]!.includes("multiple_choice"));
  assert.deepEqual(bySection["Part B: Problems (20 points)"], ["numeric", "short_answer"], "Part B keeps the practice exam's own order: the numeric problem, then the explanation");
  // Four topics, four slots, and numeric practice only on one topic: the floor (one per topic) costs one
  // format match, and that question says so instead of passing as the exam's format.
  const subs = built.plan.questions.filter((q) => q.substitute);
  assert.equal(subs.length, 1);
  assert.match(subs[0]!.substitute!, /asks for multiple choice; no remaining checked question in that format fits this exam's topic shares, so this one takes a short answer/);
  const instr = built.plan.questions.find((q) => q.source.kind === "problem");
  assert.equal(instr?.provenance, "From your instructor's practice exam: Midterm 1 Practice Exam");
  assert.ok(built.plan.questions.every((q) => q.provenance.length > 0));
  assert.equal(new Set(built.plan.questions.map((q) => q.conceptIds[0])).size, 4, "one question per covered topic at this length");
  assert.equal(built.plan.minutes, 75, "the stated length scales to the practice exam's size (4 of 4 questions)");
  assert.match(built.plan.provenance, /isn't the real exam and isn't a grade prediction/);
  assert.doesNotMatch(JSON.stringify(built.plan), /will be on/i);
});

test("assembly: a thin blueprint builds a plain labelled set; a short pool says so; lean moves questions toward iffy topics", () => {
  const thin = blueprintOf({ practiceDocs: false }, (e) => {
    e.scopes = [];
  });
  const pool = [problem("a1", "t-speed", "multiple_choice"), problem("a2", "t-speed", "short_answer"), problem("b1", "t-power", "multiple_choice"), problem("b2", "t-power", "numeric")];
  const plain = buildPracticeExam({ blueprint: thin, candidates: pool, length: 6, lean: false, states: new Map(), labels: new Map(), sourceTitles: new Map() });
  assert.deepEqual(plain.plan.sections.map((s) => s.label), ["Practice questions (no exam format found)"]);
  assert.equal(plain.plan.questions.length, 4);
  assert.ok(plain.plan.warnings.some((w) => /Only 4 checked questions fit/.test(w)));
  assert.ok(plain.plan.questions.every((q) => q.substitute === null), "with no format to match, nothing is called a substitute");

  const b = blueprintOf();
  const many = ["t-speed", "t-disp", "t-power", "t-factor"].flatMap((t) => Array.from({ length: 6 }, (_, i) => problem(`${t}-${i}`, t, i % 2 ? "multiple_choice" : "short_answer")));
  const states = new Map<string, ConceptStateName>([["t-speed", "iffy"], ["t-disp", "solid"], ["t-power", "solid"], ["t-factor", "solid"]]);
  const count = (lean: boolean) =>
    buildPracticeExam({ blueprint: b, candidates: many, length: 12, lean, states, labels: new Map(), sourceTitles: new Map() }).plan.allocation.find((a) => a.conceptId === "t-speed")!;
  assert.equal(count(false).questions, 3, "exam-faithful: an equal share");
  assert.ok(count(true).questions > 3, "leaning adds questions on the iffy topic");
  assert.ok(count(true).leaned <= 1.5 * count(true).weight + 1e-12);
});
