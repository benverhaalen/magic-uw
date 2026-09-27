// owner: exam-prep. A synthetic course for the exam tests (not a test file itself). Every text is
// invented for the fixture: a syllabus with a stated scope and format, lectures, the instructor's
// practice exam with a solutions document, a review sheet, a past-term exam, a practice exam for a
// different assessment, an open homework, a closed real quiz, and the Canvas midterm itself.
import assert from "node:assert/strict";
import { textHash } from "@magic/retrieval";
import { createStore } from "../packages/storage/src/index";
import type { ResourceInput } from "@magic/contracts";
import { createLearningRouter, eligibleStudySource, type StudyContext } from "../packages/learning/src/router";
import { runPipeline, type CandidateItem } from "../packages/learning/src/items";
import type { Concept } from "../packages/learning/src/store";
import { createExamEvidence } from "../packages/learning/src/exam/evidence";
import { checkAuthored, putProblem, type AuthoredProblem } from "../packages/learning/src/exam/problems";

export const NOW = new Date("2026-09-27T15:00:00.000Z");

export const TEXTS = {
  syllabus: [
    "SYN 220 Synthetic Computational Physics: Syllabus",
    "Grading: Homework 30%, Midterm 1 20%, Final 50%.",
    "Midterm 1 is a 75-minute in-class exam with multiple choice and short answer problems.",
    "Midterm 1 covers Modules 1 and 2.",
  ].join("\n"),
  kinematics: [
    "Module 1: Kinematics",
    "Average speed is distance divided by time.",
    "A car travels 150 km in 2 h, so its average speed is 75 km/h.",
    "Displacement is the change in position; it can be zero even when the distance travelled is not.",
  ].join("\n"),
  derivatives: [
    "Module 2: Derivatives",
    "The power rule: the derivative of x^n is n*x^(n-1), so the derivative of x^3 is 3*x^2.",
    "Factoring a difference of squares: x^2 - 1 = (x - 1)*(x + 1).",
  ].join("\n"),
  loops: [
    "Module 3: Loops",
    "A loop adds up a list of values one at a time:",
    "def total(values):",
    "    s = 0",
    "    for v in values:",
    "        s = s + v",
    "    return s",
  ].join("\n"),
  practice: [
    "Midterm 1 Practice Exam",
    "Time: 75 minutes. Total: 30 points.",
    "",
    "Part A: Multiple choice (10 points)",
    "1. (5 points) Which quantity is distance divided by time?",
    "a) Average speed",
    "b) Acceleration",
    "c) Displacement",
    "d) Force",
    "2. (5 points) Which rule gives the derivative of x^3?",
    "a) The chain rule",
    "b) The power rule",
    "c) The product rule",
    "d) The quotient rule",
    "",
    "Part B: Problems (20 points)",
    "3. (10 points) Calculate the average speed of a cyclist who rides 30 km in 1.5 h.",
    "4. (10 points) Explain why displacement can be zero when distance is not.",
  ].join("\n"),
  solutions: [
    "Midterm 1 Practice Exam Solutions",
    "1. a) Average speed",
    "2. b) The power rule",
    "3. Average speed = 30 km / 1.5 h = 20 km/h",
    "4. Displacement measures the change in position; returning to the start gives zero displacement after any distance.",
  ].join("\n"),
  review: [
    "Midterm 1 Review Sheet",
    "Midterm 1 covers Modules 1 and 2: kinematics and derivatives.",
    "Know average speed, displacement, the power rule and factoring.",
  ].join("\n"),
  past: [
    "Fall 2024 Midterm 1",
    "1. Define displacement in one sentence.",
    "2. Compute the average speed of a runner covering 12 km in 1 h.",
  ].join("\n"),
  finalPractice: ["Practice Final Exam", "1. Explain how a for loop visits each value in a list.", "2. Write a function that sums a list."].join("\n"),
  homework: "Homework 3: Compute the average speed of a train covering 300 km in 4 h. Submit your work.",
  quiz: "Quiz 2: Which quantity is distance divided by time? Answer on Canvas.",
  midterm: "Midterm 1 is taken in class. Bring a calculator.",
} as const;

const course = { courseId: "SYN220", courseName: "Synthetic Computational Physics" };
const material = (externalId: string, title: string, text: string, extra: Partial<ResourceInput> = {}): ResourceInput => ({
  externalId,
  kind: "material",
  ...course,
  title,
  url: `https://canvas.example.test/courses/220/files/${externalId}`,
  text,
  deadlines: [],
  points: null,
  submitted: null,
  policy: { mode: "coaching", evidence: "Synthetic: AI help is allowed for practice." },
  ...extra,
});
const assignment = (externalId: string, title: string, text: string, dueAt: string, extra: Partial<ResourceInput> = {}): ResourceInput =>
  material(externalId, title, text, {
    kind: "assignment",
    url: `https://canvas.example.test/courses/220/assignments/${externalId}`,
    dueAt,
    deadlines: [{ kind: "due", value: dueAt, quote: `Due ${dueAt}`, authority: "structured", scopeConfirmed: true }],
    points: 10,
    ...extra,
  });

export const LABELS = {
  m1: "Module 1: Kinematics",
  m2: "Module 2: Derivatives",
  m3: "Module 3: Loops",
  speed: "Average speed",
  displacement: "Displacement",
  power: "Power rule",
  factoring: "Factoring",
  loops: "Loops",
};

function concept(id: string, label: string, kind: Concept["kind"], parentId: string | null, position: number, ref: string): Concept {
  return { id, courseRef: ref, parentId, label, kind, position, origin: "code", status: "active", mergedInto: null, studentLabel: null, mapVersion: "exam-fixture", sources: [] };
}

export interface ExamFixture {
  owner: ReturnType<typeof createStore>;
  ref: string;
  ids: Record<string, string>;
  context(anchor: string): StudyContext | null;
  router: ReturnType<typeof createLearningRouter>;
  setNow(d: Date): void;
}

/** The synthetic course in a SQL workspace store, with a checked pool, stored problems and the map. */
export function examFixture(opts: { evidence?: boolean; practiceDocs?: boolean } = {}): ExamFixture {
  const owner = createStore(":memory:");
  const docs = opts.practiceDocs === false ? [] : [
    material("practice", "Midterm 1 Practice Exam", TEXTS.practice),
    material("solutions", "Midterm 1 Practice Exam Solutions", TEXTS.solutions),
    material("review", "Midterm 1 Review Sheet", TEXTS.review),
    material("past", "Fall 2024 Midterm 1", TEXTS.past),
    material("final-practice", "Practice Final Exam", TEXTS.finalPractice),
  ];
  owner.ingest({
    source: { id: "syn-materials", kind: "canvas", accountScope: "acct", courseId: "SYN220", scope: "materials", label: "Synthetic" },
    observedAt: NOW.toISOString(),
    complete: true,
    status: "ok",
    resources: [
      material("syllabus", "Syllabus", TEXTS.syllabus),
      material("kinematics", "Lecture 1: Kinematics", TEXTS.kinematics),
      material("derivatives", "Lecture 2: Derivatives", TEXTS.derivatives),
      material("loops", "Lecture 3: Loops", TEXTS.loops),
      ...docs,
    ],
  });
  owner.ingest({
    source: { id: "syn-assignments", kind: "canvas", accountScope: "acct", courseId: "SYN220", scope: "assignments", label: "Synthetic" },
    observedAt: NOW.toISOString(),
    complete: true,
    status: "ok",
    resources: [
      assignment("hw3", "Homework 3", TEXTS.homework, "2026-10-01T05:00:00.000Z"),
      assignment("quiz2", "Quiz 2", TEXTS.quiz, "2026-09-20T05:00:00.000Z", { submissionTypes: ["online_quiz"] }),
      assignment("midterm1", "Midterm 1", TEXTS.midterm, "2026-10-15T19:00:00.000Z"),
    ],
  });
  const byExt = (e: string) => owner.resources().find((r) => r.externalId === e)!;
  const ids: Record<string, string> = {};
  for (const r of owner.resources()) ids[r.externalId] = r.id;

  // The course map (code layer): the midterm, its stated scope quoted from the syllabus, and a role fact.
  const syllabus = byExt("syllabus");
  owner.putAssessment(
    { id: "a-mid1", sourceId: "syn-materials", resourceId: ids.midterm1!, kind: "midterm", title: "Midterm 1", date: "2026-10-15", weight: 20, format: null, origin: "syllabus" },
    NOW.toISOString(),
  );
  const scopeQuote = "Midterm 1 covers Modules 1 and 2.";
  const scope = owner.putAssessmentScope(
    { id: "scope-mid1", assessmentId: "a-mid1", stated: scopeQuote, evidence: { resourceId: syllabus.id, version: syllabus.version, quote: scopeQuote }, windowStart: null, windowEnd: null, status: "settled", rung: "code" },
    NOW.toISOString(),
  );
  assert.equal(scope.ok, true, JSON.stringify(scope));
  if (docs.length) {
    const practice = byExt("practice");
    const at = practice.title.indexOf("Practice Exam");
    const facts = owner.putMaterialFacts({
      resourceId: practice.id,
      textHash: textHash(practice.title, practice.text),
      analyzerVersion: "graph.classify.v1",
      facts: [{ kind: "role", value: "exam", basis: "title", start: at, end: at + "Practice Exam".length }],
    });
    assert.equal(facts.ok, true, JSON.stringify(facts));
  }

  // The learning side: concepts and a checked pool.
  const learning = owner.learning;
  const ref = learning.course("acct", "SYN220", course.courseName).id;
  learning.putConceptMap(ref, [
    concept("m1", LABELS.m1, "unit", null, 0, ref),
    concept("m2", LABELS.m2, "unit", null, 1, ref),
    concept("m3", LABELS.m3, "unit", null, 2, ref),
    concept("t-speed", LABELS.speed, "concept", "m1", 0, ref),
    concept("t-disp", LABELS.displacement, "concept", "m1", 1, ref),
    concept("t-power", LABELS.power, "concept", "m2", 0, ref),
    concept("t-factor", LABELS.factoring, "concept", "m2", 1, ref),
    concept("t-loops", LABELS.loops, "concept", "m3", 0, ref),
  ], "exam-fixture");
  const resources = owner.resources().map((r) => ({ id: r.id, kind: r.kind, text: r.text, contentHash: r.contentHash, dueAt: r.dueAt ?? null }));
  const base = (id: string, conceptId: string, resource: string, quote: string) => ({
    id, version: 1, courseRef: ref, familyId: id, keyIdeas: [], explanation: null, tempting: {},
    bloom: "understand" as const, tier: "T4" as const, sourceTerm: null, origin: "generated" as const, generator: null,
    sources: [{ resourceId: ids[resource]!, quote }], tags: [{ conceptId, primary: true }],
  });
  const mc = (id: string, conceptId: string, resource: string, quote: string, stem: string, options: string[]): CandidateItem => ({
    ...base(id, conceptId, resource, quote), kind: "mc", stem, options: options.map((text, i) => ({ id: "abcd"[i]!, text })), key: "a",
  });
  const candidates: CandidateItem[] = [
    mc("i-speed-mc", "t-speed", "kinematics", "Average speed is distance divided by time.", "What is average speed?", ["Distance divided by time", "Time divided by distance", "Distance times time"]),
    { ...base("i-speed-num", "t-speed", "kinematics", "A car travels 150 km in 2 h, so its average speed is 75 km/h."), kind: "numeric", bloom: "apply", stem: "A car travels 150 km in 2 h. What is its average speed?", options: null, key: 75, unit: "km/h", formula: "150 km / 2 h" },
    { ...base("i-disp-typed", "t-disp", "kinematics", "Displacement is the change in position"), kind: "typed", stem: "What does displacement measure?", options: null, key: "change in position", keyIdeas: [{ idea: "change in position", synonyms: [], required: true }] },
    mc("i-power-mc", "t-power", "derivatives", "the derivative of x^3 is 3*x^2", "What is the derivative of x^3?", ["3*x^2", "x^2", "3*x^3"]),
    { ...base("i-factor-typed", "t-factor", "derivatives", "x^2 - 1 = (x - 1)*(x + 1)"), kind: "typed", stem: "Factor x^2 - 1.", options: null, key: "(x - 1)*(x + 1)", keyIdeas: [{ idea: "(x - 1)*(x + 1)", synonyms: [], required: true }] },
    mc("i-loops-mc", "t-loops", "loops", "A loop adds up a list of values one at a time", "What does the loop in the lecture do?", ["Adds up the values", "Sorts the values", "Deletes the values"]),
    // Sourced from a closed real quiz: a checked item, but graded work is never used on a practice exam.
    mc("i-quiz-mc", "t-speed", "quiz2", "Which quantity is distance divided by time?", "Which quantity is distance per unit time?", ["Average speed", "Momentum", "Kinetic energy"]),
  ];
  const seen: string[] = [];
  for (const c of candidates) {
    const checked = runPipeline(c, {
      courseRestricted: false,
      resources,
      validate: (text, quote) => {
        const start = text.indexOf(quote);
        return start < 0 ? { status: "missing" } : text.indexOf(quote, start + 1) >= 0 ? { status: "ambiguous" } : { status: "unique", start, end: start + quote.length };
      },
      map: learning.concepts(ref),
      seenStems: seen,
      now: NOW,
    });
    assert.equal(checked.accepted, true, `${c.id}: ${checked.dropped?.reason}`);
    learning.putItem(checked.item!, checked.sources, checked.tags, checked.checks);
    seen.push(c.stem);
  }

  // Two authored problems, as the problems pack would store them after code checks.
  const derivatives = byExt("derivatives");
  const kinematics = byExt("kinematics");
  const authored: [string, AuthoredProblem, typeof derivatives, string, string][] = [
    [
      "prob-factor",
      {
        stem: "Factor x^2 - 1 and check it.",
        format: "symbolic",
        bloom: "apply",
        steps: [
          { prompt: "Write x^2 - 1 as a product of two factors.", answerKind: "symbolic", numeric: null, symbolic: { expr: "(x - 1)*(x + 1)", variables: ["x"], form: "factored" }, text: null, nudge: "It is a difference of two squares.", workedStep: "x^2 - 1 = (x - 1)(x + 1).", explainPrompt: null },
          { prompt: "Expand your factors back out.", answerKind: "symbolic", numeric: null, symbolic: { expr: "x^2 - 1", variables: ["x"], form: "expanded" }, text: null, nudge: "Multiply each term of the first factor by the second.", workedStep: "(x - 1)(x + 1) = x^2 + x - x - 1 = x^2 - 1.", explainPrompt: null },
        ],
        workedExample: ["x^2 - 1 is a difference of squares, so it factors as (x - 1)(x + 1).", "Expanding gives x^2 + x - x - 1 = x^2 - 1, which checks the factoring."],
        parsons: null,
      },
      derivatives,
      "x^2 - 1 = (x - 1)*(x + 1)",
      "t-factor",
    ],
    [
      "prob-speed",
      {
        stem: "A car travels 150 km in 2 h. Find its average speed, then convert it to m/s.",
        format: "numeric",
        bloom: "apply",
        steps: [
          { prompt: "Average speed in km/h.", answerKind: "numeric", numeric: { value: 75, unit: "km/h", formula: "150 / 2" }, symbolic: null, text: null, nudge: "Divide the distance by the time.", workedStep: "150 km / 2 h = 75 km/h.", explainPrompt: "Why do you divide distance by time?" },
          { prompt: "The same speed in m/s.", answerKind: "numeric", numeric: { value: 20.8333, unit: "m/s", formula: "75 * 1000 / 3600" }, symbolic: null, text: null, nudge: "A kilometre is 1000 m and an hour is 3600 s.", workedStep: "75 km/h × 1000 / 3600 = 20.83 m/s.", explainPrompt: null },
        ],
        workedExample: ["Average speed = 150 km / 2 h = 75 km/h.", "75 km/h = 75 × 1000 m / 3600 s ≈ 20.83 m/s."],
        parsons: null,
      },
      kinematics,
      "A car travels 150 km in 2 h, so its average speed is 75 km/h.",
      "t-speed",
    ],
  ];
  for (const [id, a, r, quote, conceptId] of authored) {
    const start = r.text.indexOf(quote);
    const checked = checkAuthored(a, {
      id,
      courseRef: ref,
      resource: { id: r.id, kind: r.kind, text: r.text, contentHash: r.contentHash },
      span: start >= 0 ? { start, end: start + quote.length } : null,
      courseRestricted: false,
      openGraded: false,
      conceptIds: [conceptId],
      generator: { client: "fake", model: "fake", promptVersion: "problems@v1" },
    });
    assert.ok(checked.problem, `${id}: ${checked.reasons.join("; ")}`);
    putProblem(learning, checked.problem, NOW.toISOString());
  }

  let now = NOW;
  const context = (anchor: string): StudyContext | null => {
    if (anchor !== ids.midterm1 && anchor !== ids.hw3) return null;
    const records = owner.resources().filter((r) => !r.deleted && r.courseId === "SYN220" && eligibleStudySource(r, now.getTime()));
    return {
      resourceId: anchor,
      accountScope: "acct",
      courseId: "SYN220",
      inputHash: "input",
      contextHash: records.map((r) => r.contentHash).join(","),
      label: course.courseName,
      availability: "current",
      reason: "Ready",
      resources: records.map((r) => ({ id: r.id, contentHash: r.contentHash, text: r.text, title: r.title, url: r.url, observedAt: r.observedAt, eligible: true })),
    };
  };
  const router = createLearningRouter({
    store: learning,
    resolveContext: context,
    now: () => now,
    ...(opts.evidence === false ? {} : { examEvidence: () => createExamEvidence(owner) }),
  });
  return { owner, ref, ids, context, router, setNow: (d) => (now = d) };
}
