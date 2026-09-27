// owner: exam-prep. Interactive solving, all in code: numbers with tolerance and units, symbolic
// equivalence and form, Parsons order, the hint ladder with its restraint check, backward fading,
// and the code checks on model-authored problems.
import test from "node:test";
import assert from "node:assert/strict";
import { checkNumeric, checkParsons, checkStep, checkSymbolic } from "../packages/learning/src/exam/check";
import { assistanceFor, fadeLevel, nextRung, nudgeGivesAway, rungText } from "../packages/learning/src/exam/hints";
import { asExpression, checkAuthored, codeRuns, parsonsAnswer, type AuthoredProblem } from "../packages/learning/src/exam/problems";
import { parseExpression } from "../packages/learning/src/exam/symbolic";
import type { SolveProblem, StepAnswer } from "../packages/learning/src/exam/types";
import type { LearningAttempt } from "../packages/learning/src/store";

const numeric = (value: number, unit: string | null, relTol = 0.005, absTol = 0): Extract<StepAnswer, { kind: "numeric" }> => ({ kind: "numeric", value, unit, relTol, absTol });
const symbolic = (expr: string, form: "any" | "expanded" | "factored" = "any", variables = ["x"]): Extract<StepAnswer, { kind: "symbolic" }> => ({ kind: "symbolic", expr, variables, form });

test("numeric: within tolerance is right; equivalent units convert; the wrong kind of unit, a missing unit and a stray unit are named", () => {
  const speed = numeric(20, "m/s");
  assert.equal(checkNumeric(speed, 20.05, "m/s").outcome, "correct");
  assert.equal(checkNumeric(speed, 72, "km/h").outcome, "correct", "72 km/h is 20 m/s");
  assert.match(checkNumeric(speed, 72, "km/h").message, /converts correctly/);
  assert.equal(checkNumeric(speed, 21, "m/s").outcome, "incorrect");
  const dim = checkNumeric(speed, 20, "kg");
  assert.equal(dim.outcome, "incorrect");
  assert.match(dim.message, /different quantity/);
  assert.match(checkNumeric(speed, 20, undefined).message, /Add the unit/);
  assert.match(checkNumeric(numeric(12, null), 12, "m").message, /takes no unit/);
  assert.equal(checkNumeric(numeric(12, null), 12, undefined).outcome, "correct");
  const unknown = checkNumeric(speed, 20, "furlongz");
  assert.equal(unknown.outcome, "undecided", "an unknown unit is reported, never guessed");
  assert.equal(unknown.score, null);
});

test("numeric: error-specific feedback for a sign slip and a power-of-ten slip; an absolute tolerance from the printed digits", () => {
  assert.match(checkNumeric(numeric(9.8, "m/s^2"), -9.8, "m/s^2").message, /sign/);
  assert.match(checkNumeric(numeric(1500, "m"), 150, "m").message, /factor of 10\^-1/);
  const printed = numeric(20.8, "m/s", 0, 0.05);
  assert.equal(checkNumeric(printed, 20.83, "m/s").outcome, "correct");
  assert.equal(checkNumeric(printed, 20.9, "m/s").outcome, "incorrect");
});

test("symbolic: equivalent forms are accepted, wrong forms rejected, and a required form is checked on the tree", () => {
  assert.equal(checkSymbolic(symbolic("2*(x+1)"), "2x + 2", "s").outcome, "correct");
  assert.equal(checkSymbolic(symbolic("2*(x+1)"), "x + x + 2", "s").outcome, "correct");
  assert.equal(checkSymbolic(symbolic("2*(x+1)"), "2x + 1", "s").outcome, "incorrect");
  assert.equal(checkSymbolic(symbolic("1"), "sin(x)^2 + cos(x)^2", "s").outcome, "correct", "an identity simplify alone may miss is settled by sampling");
  assert.equal(checkSymbolic(symbolic("sqrt(x^2)"), "abs(x)", "s").outcome, "correct");
  // log(x^2) = 2 ln|x|: 2 ln(x) is undefined for x < 0, so the forms are not the same function.
  const domain = checkSymbolic(symbolic("log(x^2)"), "2*ln(x)", "s");
  assert.equal(domain.outcome, "incorrect");
  assert.equal(checkSymbolic(symbolic("3*x^2"), "3x²", "s").outcome, "correct", "typed superscripts are read");
  assert.equal(checkSymbolic(symbolic("x^3"), "x^2", "s").outcome, "incorrect");
  const unfactored = checkSymbolic(symbolic("(x-1)*(x+1)", "factored"), "x^2 - 1", "s");
  assert.equal(unfactored.outcome, "partial");
  assert.match(unfactored.message, /not factored yet/);
  assert.equal(checkSymbolic(symbolic("(x-1)*(x+1)", "factored"), "(x+1)(x-1)", "s").outcome, "correct");
  assert.equal(checkSymbolic(symbolic("x^2 - 1", "expanded"), "(x-1)(x+1)", "s").outcome, "partial");
  assert.equal(checkSymbolic(symbolic("x^2 - 1", "expanded"), "x^2 + x - x - 1", "s").outcome, "correct");
  assert.equal(checkSymbolic(symbolic("x*y", "any", ["x", "y"]), "y*x", "s").outcome, "correct");
});

test("symbolic: only arithmetic, powers, standard functions and the problem's variables are parsed; anything else is refused", () => {
  assert.equal(parseExpression("x + 1", ["x"]).ok, true);
  for (const bad of ["y + 1", "x = 3", "import({}, {})", "f(x) = x^2", "[1, 2]", "x ? 1 : 2", "evaluate(\"1+1\")", "a.b"]) {
    const r = parseExpression(bad, ["x"]);
    assert.equal(r.ok, false, bad);
  }
  const unreadable = checkSymbolic(symbolic("x + 1"), "x + (", "s");
  assert.equal(unreadable.outcome, "undecided");
  assert.equal(unreadable.score, null);
});

test("Parsons: the solution and an allowed alternative pass; distractors, order and indentation are named", () => {
  const lines = ["def total(values):", "    s = 0", "    for v in values:", "        s = s + v", "    return s"];
  const a = parsonsAnswer(lines, ["    s = s * v"], "seed");
  const [def, s0, loop, add, ret] = a.solution;
  const blocks = (ids: string[], indent?: number[]) => ids.map((id, i) => ({ id, indent: indent?.[i] ?? a.blocks.find((b) => b.id === id)!.indent }));
  assert.deepEqual(a.blocks.slice(0, 5).map((b) => b.indent), [0, 1, 1, 2, 1]);
  assert.equal(a.indented, true);
  assert.equal(checkParsons(a, blocks(a.solution)).outcome, "correct");
  const swapped = checkParsons(a, blocks([def!, loop!, s0!, add!, ret!]));
  assert.equal(swapped.outcome, "incorrect");
  assert.equal(swapped.misplaced?.length, 1, "one block is out of the longest in-order run");
  const distractor = checkParsons(a, blocks([def!, s0!, loop!, a.distractors[0]!, ret!]));
  assert.match(distractor.message, /don't belong/);
  assert.deepEqual(distractor.misplaced, [a.distractors[0]]);
  const flat = checkParsons(a, blocks(a.solution, [0, 0, 0, 0, 0]));
  assert.equal(flat.outcome, "partial");
  assert.match(flat.message, /indentation/);
  assert.match(checkParsons(a, blocks([def!, s0!, loop!, ret!])).message, /1 line is missing/);
  // Two identical lines are interchangeable.
  const twice = parsonsAnswer(["x = 0", "x = x + 1", "x = x + 1", "print(x)"], [], "dup");
  const [p0, p1, p2, p3] = twice.solution;
  assert.equal(checkParsons(twice, [p0!, p2!, p1!, p3!].map((id) => ({ id, indent: 0 }))).outcome, "correct");
});

test("Parsons: any order of three or more identical lines passes, and indentation is checked per position", () => {
  const braces = parsonsAnswer(["x = 1;", "}", "}", "}"], [], "braces");
  const [x, c1, c2, c3] = braces.solution;
  for (const order of [[x, c1, c2, c3], [x, c3, c1, c2], [x, c2, c3, c1], [x, c3, c2, c1]])
    assert.equal(checkParsons(braces, order.map((id) => ({ id: id!, indent: 0 }))).outcome, "correct", order.join(","));
  assert.equal(checkParsons(braces, [c1, x, c2, c3].map((id) => ({ id: id!, indent: 0 }))).outcome, "incorrect");
  // Nested closing braces trim to the same text; the level each position needs is what's checked.
  const nested = parsonsAnswer(["if (a) {", "  if (b) {", "    go();", "  }", "}"], [], "nested");
  const [i0, i1, g, inner, outer] = nested.solution;
  const swapped = [i0, i1, g, outer, inner];
  assert.equal(checkParsons(nested, swapped.map((id, i) => ({ id: id!, indent: [0, 1, 2, 1, 0][i]! }))).outcome, "correct");
  const wrongIndent = checkParsons(nested, swapped.map((id, i) => ({ id: id!, indent: [0, 1, 2, 0, 1][i]! })));
  assert.equal(wrongIndent.outcome, "partial");
});

test("choice, text and the student's own mark: code grades what it can and leaves the rest undecided, never wrong", () => {
  const choice: StepAnswer = { kind: "choice", options: [{ id: "a", text: "Average speed" }, { id: "b", text: "Force" }], key: "a" };
  assert.equal(checkStep(choice, { kind: "choice", optionId: "a" }, "s").outcome, "correct");
  assert.equal(checkStep(choice, { kind: "choice", optionId: "b" }, "s").outcome, "incorrect");
  assert.equal(checkStep(choice, { kind: "choice", optionId: "z" }, "s").outcome, "undecided");
  assert.equal(checkStep(choice, { kind: "text", text: "a" }, "s").outcome, "undecided", "a response of the wrong shape isn't graded");
  const text: StepAnswer = { kind: "text", key: "change in position", keyIdeas: [{ idea: "change in position", synonyms: [], required: true }] };
  assert.equal(checkStep(text, { kind: "text", text: "It is the change in position." }, "s").outcome, "correct");
  assert.equal(checkStep(text, { kind: "text", text: "How far you went overall" }, "s").outcome, "undecided");
  const self: StepAnswer = { kind: "self", solution: null };
  assert.equal(checkStep(self, { kind: "text", text: "my working" }, "s").outcome, "undecided");
  assert.equal(checkStep(self, { kind: "mark", mark: "partly" }, "s").score, 0.5);
  assert.deepEqual(checkStep(self, { kind: "mark", mark: "right" }, "s").checks, ["Marked by you"]);
});

const problem = (over: Partial<SolveProblem> = {}): SolveProblem => ({
  kind: "problem",
  id: "p1",
  version: 1,
  courseRef: "acct:C",
  stem: "Find the speed.",
  format: "numeric",
  level: "apply",
  conceptIds: ["t"],
  steps: [
    { id: "s1", prompt: "Speed in km/h", answer: numeric(75, "km/h"), nudge: "Divide distance by time.", worked: "150 / 2 = 75 km/h", explain: null },
    { id: "s2", prompt: "Speed in m/s", answer: numeric(20.83, "m/s"), nudge: null, worked: "75 × 1000 / 3600", explain: null },
    { id: "s3", prompt: "Time for 300 km", answer: numeric(4, "h"), nudge: "Distance over speed.", worked: null, explain: null },
  ],
  workedExample: ["75 km/h", "20.83 m/s", "4 h"],
  source: { resourceId: "r", contentHash: "h", start: 0, end: 1, quote: "x" },
  origin: "generated",
  tier: "T4",
  points: null,
  checks: [],
  generator: null,
  ...over,
});

test("hint ladder: nudge, then the worked step, then the full worked example, skipping rungs with nothing prepared", () => {
  const p = problem();
  const [s1, s2, s3] = p.steps;
  assert.equal(nextRung(p, s1!, []), "nudge");
  assert.equal(nextRung(p, s1!, ["nudge"]), "step");
  assert.equal(nextRung(p, s1!, ["nudge", "step"]), "worked");
  assert.equal(nextRung(p, s1!, ["nudge", "step", "worked"]), null);
  assert.equal(nextRung(p, s2!, []), "step", "no nudge prepared: the ladder starts at the worked step");
  assert.equal(nextRung(p, s3!, ["nudge"]), "worked");
  assert.equal(nextRung({ ...p, workedExample: [] }, s3!, ["nudge"]), null);
  assert.equal(rungText(p, s1!, "worked"), "1. 75 km/h\n2. 20.83 m/s\n3. 4 h");
  assert.equal(assistanceFor([]), "none");
  assert.equal(assistanceFor(["nudge"]), "hint");
  assert.equal(assistanceFor(["nudge", "step", "worked"]), "explained");
});

test("restraint: a nudge that states the step's answer is caught by code", () => {
  assert.equal(nudgeGivesAway("Divide the distance by the time.", numeric(75, "km/h")), false);
  assert.equal(nudgeGivesAway("It comes to 75 km/h.", numeric(75, "km/h")), true);
  assert.equal(nudgeGivesAway("Think of 175 as a sum.", numeric(75, null)), false, "a longer number containing the digits is not the answer");
  assert.equal(nudgeGivesAway("Try (x - 1)*(x + 1).", symbolic("(x - 1)*(x + 1)")), true);
  assert.equal(nudgeGivesAway("It's a difference of squares.", symbolic("(x - 1)*(x + 1)")), false);
  assert.equal(nudgeGivesAway("The answer is the change in position.", { kind: "text", key: "change in position", keyIdeas: [] }), true);
});

test("backward fading: a new problem asks the last step; a clean attempt fades one more; a miss or the full example steps back", () => {
  const p = problem();
  const attempt = (fade: number, correct: boolean, assistance: LearningAttempt["assistance"], at: string): LearningAttempt => ({
    id: at, courseRef: "acct:C", itemId: "p1", itemVersion: 1, sourceResourceId: null, primaryConceptId: "t", correct, assistance,
    seenBefore: false, confidence: null, createdAt: at, format: "numeric", mode: "learn", response: { fade }, score: correct ? 1 : 0,
    gradingMethod: "code", responseMs: 0, conceptTags: [], sessionId: "s", localDay: at.slice(0, 10),
  });
  assert.equal(fadeLevel(p, []), 1);
  assert.equal(fadeLevel(p, [attempt(1, true, "none", "2026-09-01T00:00:00Z")]), 2);
  assert.equal(fadeLevel(p, [attempt(1, true, "none", "2026-09-01T00:00:00Z"), attempt(2, true, "none", "2026-09-02T00:00:00Z")]), 3);
  assert.equal(fadeLevel(p, [attempt(3, true, "none", "2026-09-03T00:00:00Z")]), 3, "never past the full problem");
  assert.equal(fadeLevel(p, [attempt(2, false, "none", "2026-09-04T00:00:00Z")]), 1);
  assert.equal(fadeLevel(p, [attempt(2, true, "explained", "2026-09-04T00:00:00Z")]), 1);
  assert.equal(fadeLevel(p, [attempt(2, true, "hint", "2026-09-04T00:00:00Z")]), 2, "a nudge holds the level");
  assert.equal(fadeLevel({ ...p, steps: p.steps.slice(0, 1) }, []), 1);
});

const SOURCE = "A car travels 150 km in 2 h, so its average speed is 75 km/h.\ndef total(values):\n    s = 0\n    for v in values:\n        s = s + v\n    return s";
const ctx = (over: Record<string, unknown> = {}) => ({
  id: "prob-1",
  courseRef: "acct:C",
  resource: { id: "r1", kind: "material", text: SOURCE, contentHash: "h1" },
  span: { start: 0, end: 62 },
  courseRestricted: false,
  openGraded: false,
  conceptIds: ["t-speed"],
  generator: null,
  ...over,
});
const authored = (over: Partial<AuthoredProblem> = {}): AuthoredProblem => ({
  stem: "Find the average speed.",
  format: "numeric",
  bloom: "apply",
  steps: [
    { prompt: "Speed in km/h", answerKind: "numeric", numeric: { value: 75, unit: "km/h", formula: "150 / 2" }, symbolic: null, text: null, nudge: "Divide distance by time.", workedStep: "150 / 2 = 75", explainPrompt: null },
  ],
  workedExample: ["150 km / 2 h = 75 km/h"],
  parsons: null,
  ...over,
});

test("authored problems: code recomputes formulas, parses expressions, checks units and restraint, and grounds Parsons lines", () => {
  const ok = checkAuthored(authored(), ctx());
  assert.ok(ok.problem, ok.reasons.join("; "));
  assert.deepEqual(ok.problem.source.quote, SOURCE.slice(0, 62));
  const wrongMath = checkAuthored(authored({ steps: [{ ...authored().steps[0]!, numeric: { value: 80, unit: "km/h", formula: "150 / 2" } }] }), ctx());
  assert.equal(wrongMath.problem, null);
  assert.match(wrongMath.reasons.join(), /recompute: step 1's formula gives 75, not 80/);
  const rounded = checkAuthored(authored({ steps: [{ ...authored().steps[0]!, numeric: { value: 20.83, unit: "m/s", formula: "75 * 1000 / 3600" } }] }), ctx());
  assert.ok(rounded.problem);
  assert.equal((rounded.problem.steps[0]!.answer as { value: number }).value, 75 * 1000 / 3600, "code keeps the recomputed value, not the rounded one");
  assert.match(checkAuthored(authored({ steps: [{ ...authored().steps[0]!, nudge: "It's 75 km/h." }] }), ctx()).reasons.join(), /restraint/);
  assert.match(checkAuthored(authored({ steps: [{ ...authored().steps[0]!, numeric: { value: 75, unit: "furlongz", formula: null } }] }), ctx()).reasons.join(), /units/);
  const badExpr = authored({ format: "symbolic", steps: [{ prompt: "Factor", answerKind: "symbolic", numeric: null, symbolic: { expr: "(x-1)*(y+1)", variables: ["x"], form: "factored" }, text: null, nudge: "", workedStep: "", explainPrompt: null }] });
  assert.match(checkAuthored(badExpr, ctx()).reasons.join(), /parse: step 1's expression: Unknown symbol "y"/);
  assert.match(checkAuthored(authored(), ctx({ span: null })).reasons.join(), /quote/);
  assert.match(checkAuthored(authored(), ctx({ openGraded: true })).reasons.join(), /open_graded/);
  assert.match(checkAuthored(authored(), ctx({ courseRestricted: true })).reasons.join(), /policy/);
  assert.match(checkAuthored(authored(), ctx({ conceptIds: [] })).reasons.join(), /tags/);
  const parsons = (code: string, distractors: string[] = []) =>
    checkAuthored(authored({ format: "parsons", parsons: { code, distractors }, steps: [{ ...authored().steps[0]!, answerKind: "text", numeric: null, nudge: "Start with the definition." }] }), ctx());
  const good = parsons("def total(values):\n    s = 0\n    for v in values:\n        s = s + v\n    return s", ["    s = s * v"]);
  assert.ok(good.problem, good.reasons.join("; "));
  assert.equal(good.problem.format, "code_writing");
  assert.match(parsons("def total(values):\n    s = 1\n    return s").reasons.join(), /verbatim: a Parsons line isn't in the cited source/);
  assert.match(parsons("def total(values):\n    s = 0\n    return s", ["    s = 0"]).reasons.join(), /distractor repeats/);
});

test("code runs: consecutive code lines in a text are found with their offsets", () => {
  const runs = codeRuns(SOURCE);
  assert.equal(runs.length, 1);
  assert.equal(SOURCE.slice(runs[0]!.start, runs[0]!.end).split("\n")[0], "def total(values):");
  assert.equal(runs[0]!.lines.length, 5);
  assert.deepEqual(codeRuns("v = d / t\nd = 150\nt = 2\nso v = 75"), [], "a derivation of = lines is not code");
});

test("a typed key that is an expression is graded for equivalence, with the form the stem asks for", () => {
  assert.deepEqual(asExpression("(x - 1)*(x + 1)", "Factor x^2 - 1."), { kind: "symbolic", expr: "(x - 1)*(x + 1)", variables: ["x"], form: "factored" });
  assert.equal(asExpression("x^2 + 2*x", "Expand x(x + 2).")?.form, "expanded");
  assert.deepEqual(asExpression("e^t + 1", "Write the solution.")?.variables, ["t"], "e is the constant, not a variable");
  assert.equal(asExpression("change in position", "What does displacement measure?"), null);
  assert.equal(asExpression("linked-list", "Name the structure."), null, "words with a hyphen aren't an expression");
});
