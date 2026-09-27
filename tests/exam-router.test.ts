// owner: exam-prep. The exam ops end to end over the SQL learning store and the synthetic course:
// blueprint, a timed practice exam under exam conditions (feedback deferred, hints off, graded
// work never used), the code-graded review and its evidence, auto-submit on time-out, and
// interactive solving with step checks, the hint ladder, backward fading and Parsons problems.
import test from "node:test";
import assert from "node:assert/strict";
import type { LearningRequest, LearningResult } from "@magic/contracts";
import type { BlueprintData, ExamReviewData, ExamSessionData, ExamSessionView, QuestionView } from "../packages/learning/src/exam/types";
import { examFixture, NOW } from "./exam-fixture";

const signal = () => new AbortController().signal;
function setup(opts: Parameters<typeof examFixture>[0] = {}) {
  const f = examFixture(opts);
  const call = (r: Record<string, unknown>): Promise<LearningResult> => f.router.handle(r as LearningRequest, signal());
  const anchors = [f.ids.midterm1!];
  return { ...f, call, anchors };
}
const exam = (r: LearningResult): ExamSessionView => {
  assert.equal(r.status, "ok", r.message);
  return (r.data as ExamSessionData).exam;
};
let op = 0;
const nextOp = () => `op-${++op}`;

function answerFor(q: QuestionView, stepId: string, right: boolean): Record<string, unknown> {
  const step = q.steps.find((s) => s.id === stepId)!;
  if (step.kind === "choice") {
    const byStem: Record<string, string> = {
      "Which quantity is distance divided by time?": "a",
      "Which rule gives the derivative of x^3?": "b",
      "What is average speed?": "a",
      "What is the derivative of x^3?": "a",
    };
    const key = byStem[q.stem] ?? "a";
    return { kind: "choice", optionId: right ? key : step.options!.find((o) => o.id !== key)!.id };
  }
  if (step.kind === "numeric") return q.stem.startsWith("Calculate") ? { kind: "number", value: right ? 20 : 25, unit: "km/h" } : { kind: "number", value: right ? 75 : 70, unit: "km/h" };
  if (step.kind === "symbolic") return { kind: "expression", text: !right ? "x^2 + 1" : stepId === "s2" ? "x^2 - 1" : "(x+1)*(x-1)" };
  if (step.kind === "self") return { kind: "text", text: "Displacement is the change in position, so a round trip gives zero." };
  return { kind: "text", text: right ? "It is the change in position." : "the total distance" };
}

test("exam.blueprint: code-derived and quoted; unknown exams, other courses and an unconnected port answer honestly", async () => {
  const s = setup();
  const r = await s.call({ op: "exam.blueprint", courseId: "SYN220", anchorIds: s.anchors, assessmentId: "a-mid1" });
  assert.equal(r.status, "ok", r.message);
  const b = (r.data as BlueprintData).blueprint;
  assert.equal(b.tier, "T1");
  assert.equal(b.scope.concepts.length, 4);
  // The Canvas resource ID names the same exam.
  const byResource = await s.call({ op: "exam.blueprint", courseId: "SYN220", anchorIds: s.anchors, assessmentId: s.ids.midterm1 });
  assert.equal((byResource.data as BlueprintData).blueprint.assessmentId, "a-mid1");
  assert.equal((await s.call({ op: "exam.blueprint", courseId: "SYN220", anchorIds: s.anchors, assessmentId: "nope" })).status, "unavailable");
  assert.equal((await s.call({ op: "exam.blueprint", courseId: "OTHER", anchorIds: s.anchors, assessmentId: "a-mid1" })).message, "Course context does not match.");
  const unwired = setup({ evidence: false });
  const nb = await unwired.call({ op: "exam.blueprint", courseId: "SYN220", anchorIds: unwired.anchors, assessmentId: "a-mid1" });
  assert.equal(nb.status, "not_built");
});

test("practice exam under exam conditions: sectioned and timed, no keys or feedback before submit, hints off, graded work never used", async () => {
  const s = setup();
  const operationId = nextOp();
  const req = { op: "exam.build", courseId: "SYN220", anchorIds: s.anchors, assessmentId: "a-mid1", length: 6, lean: false, timed: true, examConditions: true, operationId };
  const v = exam(await s.call(req));
  assert.equal(v.mode, "exam");
  assert.equal(v.tier, "T1");
  assert.equal(v.status, "active");
  assert.deepEqual(v.sections.map((x) => x.label), ["Part A: Multiple choice (10 points)", "Part B: Problems (20 points)"]);
  assert.ok(v.timer && v.timer.minutes > 0 && !v.timer.expired);
  const graded = new Set([s.ids.hw3, s.ids.quiz2, s.ids.midterm1]);
  for (const q of v.questions) {
    assert.ok(q.citations.every((c) => !graded.has(c.resourceId)), `${q.stem} cites graded work`);
    assert.ok(!q.topics.some((t) => t.label === "Loops"), "Module 3 is outside Midterm 1's stated scope");
    assert.ok(q.provenance.length > 0);
    for (const step of q.steps) {
      assert.equal(step.answer, null, "no key before submit");
      assert.equal(step.feedback, null);
      assert.equal(step.nextHint, null, "exam conditions hide hints");
    }
  }
  assert.ok(v.questions.some((q) => q.provenance.startsWith("From your instructor's practice exam")));
  // The same operation replays; a different request under its ID fails.
  assert.equal(exam(await s.call(req)).id, v.id);
  assert.equal((await s.call({ ...req, length: 5 })).status, "failed");

  const q0 = v.questions[0]!;
  const hint = await s.call({ op: "exam.hint", sessionId: v.id, revision: v.revision, operationId: nextOp(), questionId: q0.id, stepId: q0.steps[0]!.id });
  assert.equal(hint.message, "Hints are off under exam conditions.");

  let cur = v;
  const confidence = [1, 1, 0.67, 0.33, 0, null];
  for (const [n, q] of v.questions.entries()) {
    const step = q.steps[q.steps.length - 1]!;
    for (const st of q.steps) {
      cur = exam(
        await s.call({
          op: "exam.answer", sessionId: v.id, revision: cur.revision, operationId: nextOp(), questionId: q.id, stepId: st.id,
          response: answerFor(q, st.id, n !== 0), confidence: confidence[n] ?? null, responseMs: 30_000,
        }),
      );
    }
    const after = cur.questions.find((x) => x.id === q.id)!;
    assert.ok(after.steps.every((x) => x.status === "answered" && x.feedback === null && x.answer === null), "answers are saved, not graded, before submit");
    void step;
  }
  assert.equal(s.owner.learning.evidence(s.ref).attempts.length, 0, "no evidence before submit");

  const sub = await s.call({ op: "exam.submit", sessionId: v.id, revision: cur.revision, operationId: nextOp() });
  assert.equal(sub.status, "ok", sub.message);
  const { exam: done, review } = sub.data as ExamReviewData;
  assert.equal(done.status, "submitted");
  const selfMarked = done.questions.filter((q) => q.steps.some((st) => st.kind === "self"));
  assert.equal(review.needsMark, selfMarked.length);
  assert.equal(review.answered + review.needsMark, 6);
  assert.equal(review.correct, 5 - selfMarked.length, "every question but the first was answered right");
  assert.deepEqual(review.confidentMisses.map((m) => m.questionId), [v.questions[0]!.id], "Sure and wrong: flagged for review first");
  assert.match(review.note, /Not a grade prediction/);
  const attempts = s.owner.learning.evidence(s.ref).attempts;
  assert.equal(attempts.length, review.attemptsRecorded);
  assert.equal(attempts.length, 6 - selfMarked.length);
  assert.ok(attempts.every((a) => a.mode === "exam" && a.gradingMethod === "code" && a.assistance === "none"));
  assert.equal(attempts.find((a) => a.response && (a.response as { questionId: string }).questionId === v.questions[0]!.id)?.confidence, 1);
  for (const q of done.questions) for (const st of q.steps) if (st.kind !== "self") assert.notEqual(st.answer, null, "keys shown after submit");

  // The instructor's explanation problem: the solution is shown now, and the student's mark becomes evidence.
  for (const q of selfMarked) {
    const st = q.steps[0]!;
    assert.equal(st.status, "needs_mark");
    assert.match(st.solution?.quote ?? "", /change in position/);
    const marked = exam(await s.call({ op: "exam.answer", sessionId: v.id, revision: (await currentRevision(s, v.id)), operationId: nextOp(), questionId: q.id, stepId: st.id, response: { kind: "mark", mark: "right" }, confidence: 0.67, responseMs: 1000 }));
    assert.equal(marked.questions.find((x) => x.id === q.id)!.steps[0]!.status, "correct");
  }
  const all = s.owner.learning.evidence(s.ref).attempts;
  assert.equal(all.length, 6);
  assert.equal(all.filter((a) => a.gradingMethod === "student").length, selfMarked.length);
  const again = await s.call({ op: "exam.answer", sessionId: v.id, revision: await currentRevision(s, v.id), operationId: nextOp(), questionId: v.questions[1]!.id, stepId: v.questions[1]!.steps[0]!.id, response: answerFor(v.questions[1]!, v.questions[1]!.steps[0]!.id, true), confidence: null, responseMs: 0 });
  assert.equal(again.message, "This practice exam is submitted.");
});

async function currentRevision(s: ReturnType<typeof setup>, id: string): Promise<number> {
  return exam(await s.call({ op: "exam.session", sessionId: id })).revision;
}

test("time runs out under exam conditions: the saved answers are submitted and graded", async () => {
  const s = setup();
  const v = exam(await s.call({ op: "exam.build", courseId: "SYN220", anchorIds: s.anchors, assessmentId: "a-mid1", length: 4, lean: false, timed: true, minutes: 10, examConditions: true, operationId: nextOp() }));
  assert.equal(v.timer?.minutes, 10);
  const q = v.questions.find((x) => x.steps[0]!.kind === "choice")!;
  const saved = exam(await s.call({ op: "exam.answer", sessionId: v.id, revision: v.revision, operationId: nextOp(), questionId: q.id, stepId: q.steps[0]!.id, response: answerFor(q, q.steps[0]!.id, true), confidence: 1, responseMs: 5000 }));
  s.setNow(new Date(NOW.getTime() + 11 * 60_000));
  const late = await s.call({ op: "exam.answer", sessionId: v.id, revision: saved.revision, operationId: nextOp(), questionId: q.id, stepId: q.steps[0]!.id, response: answerFor(q, q.steps[0]!.id, false), confidence: 1, responseMs: 5000 });
  assert.equal(late.message, "Time is up. Your answers were saved and submitted.");
  const r = await s.call({ op: "exam.session", sessionId: v.id });
  const data = r.data as ExamReviewData;
  assert.equal(data.exam.status, "submitted");
  assert.equal(data.review.correct, 1, "the saved answer counts, the late change doesn't");
  assert.equal(data.review.unanswered, v.questions.length - 1);
});

test("without exam conditions a timed practice exam isn't cut off, and hints are allowed (marked as assistance)", async () => {
  const s = setup();
  const v = exam(await s.call({ op: "exam.build", courseId: "SYN220", anchorIds: s.anchors, assessmentId: "a-mid1", length: 6, lean: true, timed: true, minutes: 5, examConditions: false, operationId: nextOp() }));
  s.setNow(new Date(NOW.getTime() + 6 * 60_000));
  const cur = exam(await s.call({ op: "exam.session", sessionId: v.id }));
  assert.equal(cur.status, "active");
  assert.equal(cur.timer?.expired, true);
  const q = cur.questions.find((x) => x.steps.some((st) => st.nextHint !== null));
  assert.ok(q, "some question has a prepared hint");
  const st = q.steps.find((x) => x.nextHint !== null)!;
  const hinted = exam(await s.call({ op: "exam.hint", sessionId: v.id, revision: cur.revision, operationId: nextOp(), questionId: q.id, stepId: st.id }));
  assert.equal(hinted.questions.find((x) => x.id === q.id)!.steps.find((x) => x.id === st.id)!.hints.length, 1);
});

test("interactive solving: steps are checked as they're answered, units convert, and the finished problem is evidence", async () => {
  const s = setup();
  const v = exam(await s.call({ op: "exam.solve", courseId: "SYN220", anchorIds: s.anchors, problemIds: ["prob-speed"], count: 1, fade: false, operationId: nextOp() }));
  assert.equal(v.mode, "practice");
  const q = v.questions[0]!;
  assert.deepEqual(q.steps.map((x) => [x.kind, x.unit]), [["numeric", "km/h"], ["numeric", "m/s"]]);
  assert.equal(q.steps[0]!.nextHint, "nudge");
  let cur = exam(await s.call({ op: "exam.answer", sessionId: v.id, revision: v.revision, operationId: nextOp(), questionId: q.id, stepId: "s1", response: { kind: "number", value: 7.5, unit: "km/h" }, confidence: 0.67, responseMs: 4000 }));
  let st = cur.questions[0]!.steps[0]!;
  assert.equal(st.feedback?.outcome, "incorrect");
  assert.match(st.feedback!.message, /factor of 10\^-1/);
  assert.equal(st.answer, null, "a retry is still open, so the key stays hidden");
  cur = exam(await s.call({ op: "exam.answer", sessionId: v.id, revision: cur.revision, operationId: nextOp(), questionId: q.id, stepId: "s1", response: { kind: "number", value: 75, unit: "km/h" }, confidence: 0.67, responseMs: 4000 }));
  st = cur.questions[0]!.steps[0]!;
  assert.equal(st.status, "correct", "the retry is right; the first try still sets the credit");
  cur = exam(await s.call({ op: "exam.answer", sessionId: v.id, revision: cur.revision, operationId: nextOp(), questionId: q.id, stepId: "s2", response: { kind: "number", value: 75, unit: "km/h" }, confidence: 1, responseMs: 4000 }));
  assert.equal(cur.questions[0]!.steps[1]!.status, "correct", "75 km/h is the same speed as 20.83 m/s");
  assert.equal(cur.questions[0]!.status, "done");
  assert.ok(cur.questions[0]!.workedExample?.length);
  const [a] = s.owner.learning.evidence(s.ref).attempts;
  assert.ok(a);
  assert.equal(a.itemId, "prob-speed");
  assert.equal(a.correct, false, "the first try on step 1 was wrong");
  assert.equal(a.score, 0.5);
  assert.equal(a.confidence, 1);
  assert.equal(a.mode, "learn");
  assert.equal(a.primaryConceptId, "t-speed");
});

test("the hint ladder and a required form: a revealed step earns no credit and the attempt is marked assisted", async () => {
  const s = setup();
  const v = exam(await s.call({ op: "exam.solve", courseId: "SYN220", anchorIds: s.anchors, problemIds: ["prob-factor"], count: 1, fade: false, operationId: nextOp() }));
  const q = v.questions[0]!;
  let cur = exam(await s.call({ op: "exam.hint", sessionId: v.id, revision: v.revision, operationId: nextOp(), questionId: q.id, stepId: "s1" }));
  let st = cur.questions[0]!.steps[0]!;
  assert.deepEqual(st.hints.map((h) => h.rung), ["nudge"]);
  assert.equal(st.hints[0]!.text, "It is a difference of two squares.");
  assert.equal(st.status, "open", "a nudge doesn't reveal the step");
  assert.equal(st.nextHint, "step");
  cur = exam(await s.call({ op: "exam.hint", sessionId: v.id, revision: cur.revision, operationId: nextOp(), questionId: q.id, stepId: "s1" }));
  st = cur.questions[0]!.steps[0]!;
  assert.equal(st.status, "revealed");
  assert.equal(st.answer, "(x - 1)*(x + 1)");
  const settled = await s.call({ op: "exam.answer", sessionId: v.id, revision: cur.revision, operationId: nextOp(), questionId: q.id, stepId: "s1", response: { kind: "expression", text: "(x-1)(x+1)" }, confidence: null, responseMs: 0 });
  assert.equal(settled.message, "This step is already settled.");
  cur = exam(await s.call({ op: "exam.answer", sessionId: v.id, revision: cur.revision, operationId: nextOp(), questionId: q.id, stepId: "s2", response: { kind: "expression", text: "(x+1)*(x-1)" }, confidence: 0.33, responseMs: 0 }));
  st = cur.questions[0]!.steps[1]!;
  assert.equal(st.status, "partial");
  assert.equal(st.feedback?.message, "Equivalent, but not expanded yet.");
  cur = exam(await s.call({ op: "exam.answer", sessionId: v.id, revision: cur.revision, operationId: nextOp(), questionId: q.id, stepId: "s2", response: { kind: "expression", text: "x^2 - 1" }, confidence: 0.33, responseMs: 0 }));
  assert.equal(cur.questions[0]!.steps[1]!.status, "correct");
  const a = s.owner.learning.evidence(s.ref).attempts.find((x) => x.itemId === "prob-factor")!;
  assert.equal(a.assistance, "hint");
  assert.equal(a.correct, false);
  assert.equal(a.score, 0.25, "step 1 revealed (0), step 2's first try equivalent but unexpanded (0.5)");

  // Backward fading on the next session: after an assisted miss, only the last step is asked.
  const faded = exam(await s.call({ op: "exam.solve", courseId: "SYN220", anchorIds: s.anchors, problemIds: ["prob-factor"], count: 1, fade: true, operationId: nextOp() }));
  const fq = faded.questions[0]!;
  assert.deepEqual(fq.fade, { level: 1, of: 2 });
  assert.equal(fq.steps[0]!.status, "revealed");
  assert.match(fq.steps[0]!.shownWorked ?? "", /\(x - 1\)\(x \+ 1\)/);
  const worked = await s.call({ op: "exam.answer", sessionId: faded.id, revision: faded.revision, operationId: nextOp(), questionId: fq.id, stepId: "s1", response: { kind: "expression", text: "(x-1)(x+1)" }, confidence: null, responseMs: 0 });
  assert.equal(worked.message, "That step is shown worked; continue with the next one.");
});

test("Parsons problems come from verbatim code in the course, by topic; the order is checked by code", async () => {
  const s = setup();
  const v = exam(await s.call({ op: "exam.solve", courseId: "SYN220", anchorIds: s.anchors, topicIds: ["t-loops"], count: 3, fade: false, operationId: nextOp() }));
  const q = v.questions.find((x) => x.steps[0]!.kind === "parsons");
  assert.ok(q, "a Parsons problem from Lecture 3's code");
  assert.equal(q.citations[0]!.resourceId, s.ids.loops);
  assert.match(q.citations[0]!.quote, /^def total\(values\):/);
  const blocks = q.steps[0]!.blocks!;
  const lines = q.citations[0]!.quote.split("\n");
  const order = lines.map((line) => ({ id: blocks.find((b) => b.text === line.trim())!.id, indent: (line.length - line.trimStart().length) / 4 }));
  const wrong = exam(await s.call({ op: "exam.answer", sessionId: v.id, revision: v.revision, operationId: nextOp(), questionId: q.id, stepId: "answer", response: { kind: "order", blocks: [order[1], order[0], ...order.slice(2)] }, confidence: 0.33, responseMs: 1000 }));
  const st = wrong.questions.find((x) => x.id === q.id)!.steps[0]!;
  assert.equal(st.feedback?.outcome, "incorrect");
  assert.equal(st.feedback?.misplaced?.length, 1);
  const right = exam(await s.call({ op: "exam.answer", sessionId: v.id, revision: wrong.revision, operationId: nextOp(), questionId: q.id, stepId: "answer", response: { kind: "order", blocks: order }, confidence: 0.33, responseMs: 1000 }));
  assert.equal(right.questions.find((x) => x.id === q.id)!.steps[0]!.status, "correct");
  const unknown = await s.call({ op: "exam.solve", courseId: "SYN220", anchorIds: s.anchors, topicIds: ["nope"], count: 1, fade: false, operationId: nextOp() });
  assert.equal(unknown.message, "Those topics aren't in this course's map.");
});

test("a changed source makes the session stale: answers are refused, the saved work is kept", async () => {
  const s = setup();
  const v = exam(await s.call({ op: "exam.solve", courseId: "SYN220", anchorIds: s.anchors, problemIds: ["prob-speed"], count: 1, fade: false, operationId: nextOp() }));
  const r = s.owner.resources().find((x) => x.externalId === "kinematics")!;
  s.owner.ingest({
    source: { id: "syn-materials", kind: "canvas", accountScope: "acct", courseId: "SYN220", scope: "materials", label: "Synthetic" },
    observedAt: new Date(NOW.getTime() + 60_000).toISOString(),
    complete: false,
    status: "ok",
    resources: [{ externalId: "kinematics", kind: "material", courseId: "SYN220", courseName: "Synthetic Computational Physics", title: r.title, url: r.url, text: `${r.text}\nUpdated.`, deadlines: [], points: null, submitted: null, policy: { mode: "coaching", evidence: "Synthetic" } }],
  });
  const cur = exam(await s.call({ op: "exam.session", sessionId: v.id }));
  assert.equal(cur.availability, "stale");
  const q = cur.questions[0]!;
  const refused = await s.call({ op: "exam.answer", sessionId: v.id, revision: cur.revision, operationId: nextOp(), questionId: q.id, stepId: "s1", response: { kind: "number", value: 75, unit: "km/h" }, confidence: null, responseMs: 0 });
  assert.equal(refused.status, "unavailable");
  assert.match(refused.message ?? "", /sources changed/);
});
