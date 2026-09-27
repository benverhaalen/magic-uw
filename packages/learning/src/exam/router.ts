/**
 * The exam ops (owner: exam-prep), dispatched from the learning router: `exam.blueprint`,
 * `exam.build`, `exam.solve`, `exam.session`, `exam.answer`, `exam.hint`, `exam.submit`.
 * No generator or provider is reachable from here: questions come from checked items, stored
 * problems (authored through the pack path and checked by code) and the instructor's own
 * problems; every step is checked in code. Sessions persist through the learning store's revision
 * CAS like the study ops; answers become evidence (attempts with confidence) for the knowledge
 * model and analytics.
 */
import { randomUUID } from "node:crypto";
import type { LearningRequest, LearningResult } from "@magic/contracts";
import type { ItemFormat } from "../config";
import type { LearningAttempt, LearningSession, LearningStore, StoredItem } from "../store";
import { canonical } from "../store";
import type { StudyContext } from "../router";
import type { ConceptStateName } from "../types";
import { deriveBlueprint, classifyDocs, type BlueprintTopic, type ClassifiedDoc } from "./blueprint";
import { answerText, checkStep, responseFits, type StepCheck, type StepResponse } from "./check";
import type { ExamEvidence, ExamEvidencePort, ExamMaterial } from "./evidence";
import { buildPracticeExam } from "./exam";
import { assistanceFor, fadeLevel, nextRung, revealsAnswer, rungText, shownWorked } from "./hints";
import { codeParsonsProblem, codeRuns, instructorProblems, itemProblem, pairsWith, storedProblems, tagByLabel } from "./problems";
import type {
  ExamBlueprint,
  ExamMode,
  ExamQuestionPlan,
  ExamReview,
  ExamSessionView,
  HintRung,
  QuestionView,
  SolveProblem,
  StepView,
} from "./types";

type ExamOp = Extract<LearningRequest["op"], `exam.${string}`>;
type ExamRequest = Extract<LearningRequest, { op: ExamOp }>;

export const EXAM_OPS: readonly ExamOp[] = ["exam.blueprint", "exam.build", "exam.solve", "exam.session", "exam.answer", "exam.hint", "exam.submit"];
export const isExamRequest = (r: LearningRequest): r is ExamRequest => (EXAM_OPS as readonly string[]).includes(r.op);

/** What the learning router lends the exam ops (its trusted resolver, pool and map). */
export interface ExamHost {
  store: LearningStore;
  evidence?: () => ExamEvidencePort;
  time(): Date;
  practiceScope(courseId: string, anchorIds: string[]): { c: StudyContext; ref: string; anchors: string[] } | string;
  courseContext(anchorIds: string[]): StudyContext | null;
  currentPool(c: StudyContext, ref: string): StoredItem[];
  map(ref: string): { topics: BlueprintTopic[]; modules: { id: string; label: string }[] };
  states(ref: string): Map<string, ConceptStateName>;
  refreshAnalytics(ref: string, conceptIds: string[]): void;
}

// ---------- Session state (stored in learning_sessions.plan; never sent as is) ----------

interface StepState {
  id: string;
  response: StepResponse | null;
  tries: number;
  first: StepCheck | null;
  last: StepCheck | null;
  rungs: HintRung[];
  revealed: boolean;
  explanation: { text: string; check: StepCheck } | null;
}

interface QuestionState {
  plan: ExamQuestionPlan;
  problem: SolveProblem;
  /** Steps the student solves, counted from the end (backward fading); the rest are shown worked. */
  fade: number;
  steps: StepState[];
  confidence: number | null;
  responseMs: number;
  attemptId: string | null;
}

interface ExamSessionState {
  schema: "exam-session-1";
  anchorIds: string[];
  accountScope: string;
  courseId: string;
  contextHash: string;
  revision: number;
  updatedAt: string;
  operations: Record<string, string>;
  mode: ExamMode;
  examConditions: boolean;
  title: string;
  assessmentId: string | null;
  tier: ExamSessionView["tier"];
  tierLabel: string | null;
  provenance: string;
  warnings: string[];
  timer: { minutes: number; startedAt: string; endsAt: string } | null;
  sections: { id: string; label: string; questionIds: string[] }[];
  questions: QuestionState[];
  submittedAt: string | null;
  startStates: Record<string, ConceptStateName>;
}

function examState(s: LearningSession): ExamSessionState | null {
  const p = s.plan as Partial<ExamSessionState> | null;
  return p?.schema === "exam-session-1" && Array.isArray(p.questions) && Array.isArray(p.anchorIds) ? (p as ExamSessionState) : null;
}

/** Tries before a practice step settles and shows its answer. */
const MAX_TRIES: Record<string, number> = { choice: 1, text: 1, self: 1, numeric: 3, symbolic: 3, parsons: 3 };

const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function shuffle<T>(xs: T[], seed: string): T[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
    const j = h % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const firstStudentStep = (q: QuestionState) => q.problem.steps.length - q.fade;
const studentSteps = (q: QuestionState) => q.steps.slice(firstStudentStep(q));

function stepSettled(q: QuestionState, s: StepState): boolean {
  if (s.revealed) return true;
  const kind = q.problem.steps.find((x) => x.id === s.id)!.answer.kind;
  const last = s.last;
  if (!last) return false;
  if (last.outcome === "correct") return true;
  if (last.outcome === "undecided") return false;
  return s.tries >= (MAX_TRIES[kind] ?? 1);
}

const questionSettled = (q: QuestionState) => studentSteps(q).every((s) => stepSettled(q, s));

/** Credit and the attempt's facts for a finished question. */
function grade(q: QuestionState): { score: number; correct: boolean; assistance: "none" | "hint" | "explained"; undecided: boolean; student: boolean } {
  const steps = studentSteps(q);
  let sum = 0;
  let undecided = false;
  let student = false;
  for (const s of steps) {
    const check = s.first ?? s.last;
    if (s.revealed && !check) continue;
    if (!check || check.score === null) {
      undecided = true;
      continue;
    }
    if (check.checks.includes("Marked by you")) student = true;
    sum += check.score;
  }
  const score = steps.length ? sum / steps.length : 0;
  const rungs = steps.flatMap((s) => s.rungs);
  const revealed = steps.some((s) => s.revealed);
  return { score, correct: score >= 1 && !revealed, assistance: revealed && !rungs.length ? "explained" : assistanceFor(rungs), undecided, student };
}

function attemptFormat(p: SolveProblem): ItemFormat {
  if (p.format === "multiple_choice") return "mc";
  if (p.format === "true_false") return "tf";
  if (p.format === "numeric" && p.steps.every((s) => s.answer.kind === "numeric")) return "numeric";
  return "typed";
}

export function createExamOps(host: ExamHost) {
  const { store } = host;
  const fail = (op: ExamOp, message: string, status: LearningResult["status"] = "unavailable"): LearningResult => ({ op, status, message });

  /** A problem's quote still matches the current, eligible version of its source. */
  function sourceValid(p: SolveProblem, c: StudyContext): boolean {
    const r = c.resources.find((x) => x.id === p.source.resourceId);
    return !!r && r.eligible && r.contentHash === p.source.contentHash && r.text.slice(p.source.start, p.source.end) === p.source.quote;
  }

  function candidates(c: StudyContext, ref: string, docs: ClassifiedDoc[], topics: BlueprintTopic[]): { problems: SolveProblem[]; titles: Map<string, string> } {
    const order = topics.map((t) => t.id);
    const out: SolveProblem[] = [];
    for (const x of host.currentPool(c, ref)) {
      const p = itemProblem(x, order);
      if (p) out.push(p);
    }
    out.push(...storedProblems(store, ref));
    const titles = new Map<string, string>();
    const tagTopics = topics.map((t) => ({ id: t.id, label: t.label }));
    const solutions = docs.filter((d) => d.kind === "solutions");
    for (const d of docs) {
      if (d.kind === "solutions" || d.kind === "exam_info") continue;
      const tier = d.kind === "practice_exam" ? "T1" : d.kind === "review_sheet" ? "T2" : "T3";
      const pair = solutions.find((s) => pairsWith(d.material.title, s.material.title));
      const doc = { id: d.material.id, title: d.material.title, text: d.material.text, contentHash: d.material.contentHash };
      const sol = pair ? { id: pair.material.id, title: pair.material.title, text: pair.material.text, contentHash: pair.material.contentHash } : null;
      // The solutions document must itself be a current study source, or its answers aren't used.
      const solOk = sol && c.resources.some((r) => r.id === sol.id && r.eligible && r.contentHash === sol.contentHash) ? sol : null;
      for (const p of instructorProblems(doc, solOk, { courseRef: ref, tier, topics: tagTopics })) out.push(p);
      titles.set(d.material.id, d.material.title);
    }
    // Code-only Parsons problems from verbatim code in the course's study sources.
    for (const r of c.resources) {
      if (!r.eligible || docs.some((d) => d.material.id === r.id)) continue;
      for (const run of codeRuns(r.text).slice(0, 3)) {
        const conceptIds = tagByLabel(r.text.slice(Math.max(0, run.start - 400), run.end), tagTopics);
        if (conceptIds.length) out.push(codeParsonsProblem({ id: r.id, title: r.title, text: r.text, contentHash: r.contentHash }, run, { courseRef: ref, conceptIds }));
      }
    }
    return { problems: out.filter((p) => sourceValid(p, c)), titles };
  }

  function blueprintFor(ref: string, c: StudyContext, evidence: ExamEvidence): { blueprint: ExamBlueprint; docs: ClassifiedDoc[] } {
    const { topics, modules } = host.map(ref);
    const now = host.time();
    const docs = classifyDocs(evidence, now).filter((d) => c.resources.some((r) => r.id === d.material.id && r.eligible && r.contentHash === d.material.contentHash));
    const blueprint = deriveBlueprint({ evidence, topics, modules, coverage: store.coverage(evidence.assessment.id), now });
    return { blueprint, docs };
  }

  // ---------- Views ----------

  function stepView(q: QuestionState, s: StepState, index: number, st: ExamSessionState): StepView {
    const step = q.problem.steps[index]!;
    const a = step.answer;
    const worked = index < firstStudentStep(q);
    const reveal = st.mode === "practice" || st.submittedAt !== null;
    const settled = worked || stepSettled(q, s);
    const needsMark = !!s.response && (s.last?.outcome === "undecided" || (a.kind === "self" && !s.last?.checks.includes("Marked by you")));
    let status: StepView["status"];
    if (worked || s.revealed) status = "revealed";
    else if (!s.response) status = "open";
    else if (!reveal) status = "answered";
    else if (needsMark) status = "needs_mark";
    else status = s.last?.outcome === "correct" ? "correct" : s.last?.outcome === "partial" ? "partial" : s.last?.outcome === "incorrect" ? "incorrect" : "answered";
    const hintsHidden = st.examConditions || st.submittedAt !== null || settled;
    const view: StepView = {
      id: step.id,
      prompt: step.prompt,
      kind: a.kind,
      shownWorked: worked ? shownWorked(q.problem, index) : null,
      status,
      feedback: reveal && s.last ? { outcome: s.last.outcome, message: s.last.message, checks: s.last.checks, ...(s.last.misplaced ? { misplaced: s.last.misplaced } : {}) } : null,
      hints: s.rungs.map((rung) => ({ rung, text: rungText(q.problem, step, rung) })),
      nextHint: hintsHidden ? null : nextRung(q.problem, step, s.rungs),
      answer: (reveal && settled) || worked ? answerText(a) : null,
      solution: a.kind === "self" && s.response && reveal ? a.solution : null,
      explain: step.explain && !worked ? step.explain.prompt : null,
    };
    if (a.kind === "choice") view.options = a.options;
    if (a.kind === "parsons") {
      view.blocks = shuffle(a.blocks.map((b) => ({ id: b.id, text: b.text })), `${q.plan.id}:${q.problem.id}`);
      view.indented = a.indented;
    }
    if (a.kind === "numeric") view.unit = a.unit;
    if (a.kind === "symbolic") view.variables = a.variables;
    return view;
  }

  function view(session: LearningSession, st: ExamSessionState): ExamSessionView {
    const c = host.courseContext(st.anchorIds);
    const now = host.time();
    const changed = !c || (c.contextHash ?? c.inputHash) !== st.contextHash || st.questions.some((q) => !sourceValid(q.problem, c));
    const availability = !c ? "blocked" : c.availability !== "current" ? c.availability : changed && !st.submittedAt ? "stale" : "current";
    const { topics } = host.map(session.courseRef!);
    const label = new Map(topics.map((t) => [t.id, t.label]));
    const questions: QuestionView[] = st.questions.map((q, n) => {
      const done = questionSettled(q) || !!q.attemptId;
      const touched = q.steps.some((s) => s.response || s.rungs.length);
      return {
        id: q.plan.id,
        sectionId: q.plan.sectionId,
        number: n + 1,
        stem: q.problem.stem,
        format: q.plan.format,
        level: q.plan.level,
        points: q.plan.points,
        topics: q.problem.conceptIds.flatMap((id, i) => (label.has(id) ? [{ conceptId: id, label: label.get(id)!, primary: i === 0 }] : [])),
        tier: q.plan.tier,
        provenance: q.plan.provenance,
        substitute: q.plan.substitute,
        mayNotApply: q.plan.mayNotApply,
        citations: [q.problem.source],
        steps: q.steps.map((s, i) => stepView(q, s, i, st)),
        fade: q.problem.steps.length > 1 && q.fade < q.problem.steps.length ? { level: q.fade, of: q.problem.steps.length } : null,
        confidence: q.confidence,
        status: st.submittedAt || done ? "done" : touched ? "in_progress" : "open",
        workedExample: (st.mode === "practice" && done) || st.submittedAt ? q.problem.workedExample : null,
      };
    });
    const timer = st.timer
      ? (() => {
          const remaining = Math.max(0, Math.round((Date.parse(st.timer.endsAt) - now.getTime()) / 1000));
          return { ...st.timer, remainingSeconds: remaining, expired: remaining === 0 };
        })()
      : null;
    return {
      id: session.id,
      courseId: st.courseId,
      assessmentId: st.assessmentId,
      title: st.title,
      mode: st.mode,
      examConditions: st.examConditions,
      revision: st.revision,
      availability,
      reason: !c
        ? "Course context is unavailable."
        : c.availability !== "current"
          ? c.reason
          : availability === "stale"
            ? "Course sources changed since this started. Your answers are saved; start a new one for current material."
            : st.mode === "exam"
              ? "Practice exam from your course materials; answers are checked by code when you submit. Not a grade prediction."
              : "Each step is checked by code as you go.",
      tier: st.tier,
      tierLabel: st.tierLabel,
      provenance: st.provenance,
      timer,
      status: st.submittedAt ? "submitted" : "active",
      sections: st.sections,
      questions,
      warnings: st.warnings,
    };
  }

  function review(session: LearningSession, st: ExamSessionState, recorded: number): ExamReview {
    const ref = session.courseRef!;
    const states = host.states(ref);
    const { topics } = host.map(ref);
    const label = new Map(topics.map((t) => [t.id, t.label]));
    let answered = 0, correct = 0, partial = 0, selfMarked = 0, needsMark = 0, unanswered = 0;
    const bySection = new Map<string, { answered: number; correct: number }>();
    const perTopic = new Map<string, { answered: number; correct: number }>();
    const confidentMisses: ExamReview["confidentMisses"] = [];
    for (const q of st.questions) {
      const steps = studentSteps(q);
      if (!steps.some((s) => s.response)) {
        unanswered++;
        continue;
      }
      const g = grade(q);
      const sec = bySection.get(q.plan.sectionId) ?? { answered: 0, correct: 0 };
      if (g.undecided) {
        needsMark++;
        continue;
      }
      answered++;
      sec.answered++;
      if (g.student) selfMarked++;
      if (g.correct) {
        correct++;
        sec.correct++;
      } else if (g.score > 0) partial++;
      bySection.set(q.plan.sectionId, sec);
      const t = q.problem.conceptIds[0];
      if (t) {
        const row = perTopic.get(t) ?? { answered: 0, correct: 0 };
        row.answered++;
        if (g.correct) row.correct++;
        perTopic.set(t, row);
      }
      if (!g.correct && (q.confidence ?? 0) >= 0.67) confidentMisses.push({ questionId: q.plan.id, conceptIds: q.problem.conceptIds, confidence: q.confidence! });
    }
    return {
      sessionId: session.id,
      answered,
      correct,
      partial,
      selfMarked,
      needsMark,
      unanswered,
      bySection: st.sections.map((s) => ({ sectionId: s.id, label: s.label, answered: bySection.get(s.id)?.answered ?? 0, correct: bySection.get(s.id)?.correct ?? 0 })),
      topics: [...perTopic].map(([conceptId, r]) => ({
        conceptId,
        label: label.get(conceptId) ?? conceptId,
        answered: r.answered,
        correct: r.correct,
        before: st.startStates[conceptId] ?? null,
        after: states.get(conceptId) ?? "not_seen",
      })),
      confidentMisses,
      attemptsRecorded: recorded,
      note: "Observed counts from this practice only. Not a grade prediction.",
    };
  }

  // ---------- Evidence ----------

  function attemptFor(session: LearningSession, st: ExamSessionState, q: QuestionState, at: string): LearningAttempt | null {
    const g = grade(q);
    if (g.undecided) return null;
    const ref = session.courseRef!;
    const prior = store.evidence(ref).attempts.some((a) => a.itemId === q.problem.id);
    const choice = studentSteps(q).find((s) => s.response?.kind === "choice")?.response;
    return {
      id: randomUUID(),
      courseRef: ref,
      itemId: q.problem.id,
      itemVersion: q.problem.version,
      sourceResourceId: q.problem.source.resourceId,
      primaryConceptId: q.problem.conceptIds[0] ?? "",
      correct: g.correct,
      assistance: g.assistance,
      seenBefore: prior,
      confidence: q.confidence,
      createdAt: at,
      format: attemptFormat(q.problem),
      mode: st.mode === "practice" ? "learn" : st.examConditions ? "exam" : "test",
      response: { steps: q.steps.map((s) => ({ id: s.id, response: s.response, revealed: s.revealed, rungs: s.rungs })), fade: q.fade, questionId: q.plan.id },
      score: g.score,
      gradingMethod: g.student ? "student" : "code",
      responseMs: Math.min(86_400_000, q.responseMs),
      conceptTags: q.problem.conceptIds.map((conceptId, i) => ({ conceptId, weight: i === 0 ? 1 : 0.5, primary: i === 0 })),
      sessionId: session.id,
      localDay: localDay(new Date(at)),
      ...(choice?.kind === "choice" ? { optionId: choice.optionId } : {}),
    };
  }

  /** Write one attempt per finished, unrecorded question, one CAS commit each, so an interrupted submit resumes. */
  function recordAll(session: LearningSession, st: ExamSessionState, at: string): { session: LearningSession; st: ExamSessionState; recorded: number } | null {
    let cur = session;
    let state = st;
    let recorded = 0;
    for (let i = 0; i < state.questions.length; i++) {
      const q = state.questions[i]!;
      if (q.attemptId || !studentSteps(q).some((s) => s.response)) continue;
      const attempt = attemptFor(cur, state, q, at);
      if (!attempt) continue;
      const next = structuredClone(state);
      next.questions[i]!.attemptId = attempt.id;
      next.revision = state.revision + 1;
      next.updatedAt = at;
      const updated = { ...cur, plan: next };
      if (!store.commitSession(updated, state.revision, attempt)) return null;
      cur = updated;
      state = next;
      recorded++;
      host.refreshAnalytics(cur.courseRef!, attempt.conceptTags.map((t) => t.conceptId));
    }
    return { session: cur, st: state, recorded };
  }

  function submit(session: LearningSession, st: ExamSessionState, at: string, opId?: string, fingerprint?: string) {
    const next = structuredClone(st);
    // Exam mode: every saved response is checked now (feedback was deferred until submit).
    if (next.mode === "exam")
      for (const q of next.questions)
        for (const s of studentSteps(q)) {
          if (!s.response || s.revealed) continue;
          const step = q.problem.steps.find((x) => x.id === s.id)!;
          const check = checkStep(step.answer, s.response, `${session.id}:${q.plan.id}:${s.id}`);
          s.first = check;
          s.last = check;
        }
    next.submittedAt = at;
    next.revision = st.revision + 1;
    next.updatedAt = at;
    if (opId && fingerprint) next.operations = { ...next.operations, [opId]: fingerprint };
    const updated = { ...session, plan: next, endedAt: at };
    if (!store.commitSession(updated, st.revision)) return null;
    return recordAll(updated, next, at);
  }

  /** Under exam conditions an expired timer submits (answers are saved first). */
  function autoSubmit(session: LearningSession, st: ExamSessionState) {
    if (!st.examConditions || st.submittedAt || !st.timer) return null;
    const now = host.time();
    if (now.getTime() < Date.parse(st.timer.endsAt)) return null;
    return submit(session, st, now.toISOString());
  }

  function newSession(
    op: ExamOp,
    ref: string,
    c: StudyContext,
    anchors: string[],
    init: Omit<ExamSessionState, "schema" | "anchorIds" | "accountScope" | "courseId" | "contextHash" | "revision" | "updatedAt" | "submittedAt" | "startStates">,
    signal: AbortSignal,
  ): LearningResult {
    const at = host.time().toISOString();
    const states = host.states(ref);
    const startStates: Record<string, ConceptStateName> = {};
    for (const q of init.questions) for (const t of q.problem.conceptIds) startStates[t] = states.get(t) ?? "not_seen";
    const st: ExamSessionState = {
      schema: "exam-session-1",
      anchorIds: anchors,
      accountScope: c.accountScope,
      courseId: c.courseId,
      contextHash: c.contextHash ?? c.inputHash,
      revision: 0,
      updatedAt: at,
      submittedAt: null,
      startStates,
      ...init,
    };
    const session: LearningSession = {
      id: randomUUID(),
      courseRef: ref,
      kind: st.mode === "exam" ? "practice_exam" : "solve",
      plan: st,
      minutes: st.timer?.minutes ?? Math.max(1, st.questions.length * 2),
      difficulty: "normal",
      startedAt: at,
      endedAt: null,
    };
    if (signal.aborted) return fail(op, "Study request cancelled.");
    if (!store.commitSession(session, null)) return fail(op, "Study session changed. Reload it.");
    return { op, status: "ok", data: { exam: view(session, st) } };
  }

  const questionState = (plan: ExamQuestionPlan, problem: SolveProblem, fade: number): QuestionState => ({
    plan,
    problem,
    fade,
    steps: problem.steps.map((s) => ({ id: s.id, response: null, tries: 0, first: null, last: null, rungs: [], revealed: false, explanation: null })),
    confidence: null,
    responseMs: 0,
    attemptId: null,
  });

  /** Replay a finished operation: the same request returns the saved state; a different one under the same ID fails. */
  function priorOperation(op: ExamOp, ref: string, operationId: string, fingerprint: string): LearningResult | null {
    for (const s of store.sessions(ref)) {
      const st = examState(s);
      if (!st || !Object.hasOwn(st.operations, operationId)) continue;
      return st.operations[operationId] === fingerprint
        ? { op, status: "ok", data: { exam: view(s, st) } }
        : fail(op, "Operation ID was already used for a different request.", "failed");
    }
    return null;
  }

  async function handle(request: ExamRequest, signal: AbortSignal): Promise<LearningResult> {
    const op = request.op;
    if (signal.aborted) return fail(op, "Study request cancelled.");

    if (op === "exam.blueprint" || op === "exam.build") {
      if (!host.evidence) return fail(op, "Course evidence for exams isn't connected yet.", "not_built");
      const scope = host.practiceScope(request.courseId, request.anchorIds);
      if (typeof scope === "string") return fail(op, scope);
      const { c, ref, anchors } = scope;
      const evidence = host.evidence().evidence(c.accountScope, c.courseId, request.assessmentId);
      if (!evidence) return fail(op, "That exam or quiz isn't in this course.");
      store.course(c.accountScope, c.courseId, c.label);
      const { blueprint, docs } = blueprintFor(ref, c, evidence);
      if (op === "exam.blueprint") return { op, status: "ok", data: { blueprint } };
      const fingerprint = canonical(request);
      const prior = priorOperation(op, ref, request.operationId, fingerprint);
      if (prior) return prior;
      if (c.availability !== "current") return fail(op, c.reason);
      const { topics } = host.map(ref);
      const pool = candidates(c, ref, docs, topics);
      // An untagged instructor problem is used only from a document named or linked for this exam.
      const named = new Set(docs.filter((d) => d.relevance >= 1).map((d) => d.material.id));
      pool.problems = pool.problems.filter((p) => p.origin !== "instructor" || p.conceptIds.length > 0 || named.has(p.source.resourceId));
      const built = buildPracticeExam({
        blueprint,
        candidates: pool.problems,
        length: request.length,
        lean: request.lean,
        states: host.states(ref),
        labels: new Map(topics.map((t) => [t.id, t.label])),
        sourceTitles: pool.titles,
        minutes: request.minutes ?? null,
      });
      if (!built.plan.questions.length)
        return fail(op, "No checked practice fits this exam's scope yet. Generate questions or problems from this course's materials.");
      const at = host.time();
      const minutes = request.timed ? (built.plan.minutes ?? request.minutes ?? null) : null;
      return newSession(
        op,
        ref,
        c,
        anchors,
        {
          operations: { [request.operationId]: fingerprint },
          mode: "exam",
          examConditions: request.examConditions,
          title: built.plan.title,
          assessmentId: blueprint.assessmentId,
          tier: built.plan.tier,
          tierLabel: built.plan.tierLabel,
          provenance: built.plan.provenance,
          warnings: [...built.plan.warnings, ...(request.timed && !minutes ? ["No exam length is stated; set minutes to time this practice exam."] : [])],
          timer: minutes ? { minutes, startedAt: at.toISOString(), endsAt: new Date(at.getTime() + minutes * 60_000).toISOString() } : null,
          sections: built.plan.sections.map(({ id, label, questionIds }) => ({ id, label, questionIds })),
          questions: built.plan.questions.map((plan) => {
            const p = built.problems.get(plan.id)!;
            return questionState(plan, p, p.steps.length);
          }),
        },
        signal,
      );
    }

    if (op === "exam.solve") {
      const scope = host.practiceScope(request.courseId, request.anchorIds);
      if (typeof scope === "string") return fail(op, scope);
      const { c, ref, anchors } = scope;
      const fingerprint = canonical(request);
      const prior = priorOperation(op, ref, request.operationId, fingerprint);
      if (prior) return prior;
      if (c.availability !== "current") return fail(op, c.reason);
      store.course(c.accountScope, c.courseId, c.label);
      const { topics } = host.map(ref);
      const known = new Set(topics.map((t) => t.id));
      if ((request.topicIds ?? []).some((t) => !known.has(t))) return fail(op, "Those topics aren't in this course's map.");
      let docs: ClassifiedDoc[] = [];
      if (host.evidence) {
        const materials: ExamMaterial[] = host.evidence().materials(c.accountScope, c.courseId);
        const pseudo: ExamEvidence = {
          courseId: c.courseId,
          termName: null,
          assessment: { id: "", title: "", kind: "exam", date: null, weight: null, format: null, resourceId: null, origin: "code" },
          assessments: [],
          scopes: [],
          brief: null,
          materials,
          links: [],
        };
        docs = classifyDocs(pseudo, host.time()).filter((d) => c.resources.some((r) => r.id === d.material.id && r.eligible && r.contentHash === d.material.contentHash));
      }
      const pool = candidates(c, ref, docs, topics).problems;
      const wanted = new Set(request.topicIds ?? []);
      let chosen: SolveProblem[];
      if (request.problemIds?.length) {
        chosen = request.problemIds.flatMap((id) => pool.filter((p) => p.id === id).slice(0, 1));
        if (chosen.length !== request.problemIds.length) return fail(op, "Some of those problems aren't available for this course's current sources.");
      } else {
        // Multi-step problems first (they carry hints and worked examples), then the instructor's, Parsons, and checked items.
        const rank = (p: SolveProblem) => (p.kind === "problem" && p.steps.length > 1 ? 0 : p.origin === "instructor" ? 1 : p.origin === "code" ? 2 : p.kind === "problem" ? 1 : 3);
        chosen = pool
          .filter((p) => !wanted.size || wanted.has(p.conceptIds[0] ?? ""))
          .sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : 1))
          .slice(0, request.count);
      }
      if (!chosen.length) return fail(op, "No checked problems cover those topics yet. Generate problems from this course's materials.");
      const attempts = store.evidence(ref).attempts;
      return newSession(
        op,
        ref,
        c,
        anchors,
        {
          operations: { [request.operationId]: fingerprint },
          mode: "practice",
          examConditions: false,
          title: "Practice problems",
          assessmentId: null,
          tier: null,
          tierLabel: null,
          provenance: "Problems from your course materials; each step is checked by code.",
          warnings: [],
          timer: null,
          sections: [{ id: "solve", label: "Problems", questionIds: chosen.map((_, i) => `q${i + 1}`) }],
          questions: chosen.map((p, i) =>
            questionState(
              {
                id: `q${i + 1}`,
                source: p.kind === "item" ? { kind: "item", itemId: p.id, itemVersion: p.version } : { kind: "problem", problemId: p.id, problemVersion: p.version },
                sectionId: "solve",
                format: p.format,
                level: p.level,
                points: p.points,
                conceptIds: p.conceptIds,
                tier: p.tier,
                provenance: p.origin === "instructor" ? "From your instructor's materials" : p.origin === "code" ? "From code in your course materials" : "From course materials",
                substitute: null,
                mayNotApply: p.tier === "T3" && !p.conceptIds.length,
              },
              p,
              request.fade ? fadeLevel(p, attempts) : p.steps.length,
            ),
          ),
        },
        signal,
      );
    }

    // ---------- Saved-session ops ----------
    const session = store.session(request.sessionId);
    const found = session && examState(session);
    if (!session || !found) return fail(op, "Practice session is unavailable.");
    const c = host.courseContext(found.anchorIds);
    if (!c || c.accountScope !== found.accountScope || c.courseId !== found.courseId || session.courseRef !== `${c.accountScope}:${c.courseId}`)
      return fail(op, "Practice session is unavailable for this course and account.");

    if (op === "exam.session") {
      const auto = autoSubmit(session, found);
      if (auto) return { op, status: "ok", data: { exam: view(auto.session, auto.st), review: review(auto.session, auto.st, auto.recorded) } };
      return found.submittedAt
        ? { op, status: "ok", data: { exam: view(session, found), review: review(session, found, found.questions.filter((q) => q.attemptId).length) } }
        : { op, status: "ok", data: { exam: view(session, found) } };
    }

    const fingerprint = canonical(request);
    if (Object.hasOwn(found.operations, request.operationId)) {
      if (found.operations[request.operationId] !== fingerprint) return fail(op, "Operation ID was already used for a different request.", "failed");
      return op === "exam.submit"
        ? { op, status: "ok", data: { exam: view(session, found), review: review(session, found, found.questions.filter((q) => q.attemptId).length) } }
        : { op, status: "ok", data: { exam: view(session, found) } };
    }
    if (request.revision !== found.revision) return fail(op, "Practice session changed. Reload it before continuing.");
    if (Object.keys(found.operations).length >= 5000) return fail(op, "This session is full. Start another.");
    const at = host.time().toISOString();

    if (op === "exam.submit") {
      if (found.submittedAt) return fail(op, "Already submitted.");
      const done = submit(session, found, at, request.operationId, fingerprint);
      if (!done) return fail(op, "Practice session changed. Reload it before continuing.");
      return { op, status: "ok", data: { exam: view(done.session, done.st), review: review(done.session, done.st, done.recorded) } };
    }

    // exam.answer and exam.hint
    const auto = autoSubmit(session, found);
    if (auto) return fail(op, "Time is up. Your answers were saved and submitted.");
    const current = view(session, found);
    const settledAfterSubmit = found.submittedAt !== null;
    if (!settledAfterSubmit && current.availability !== "current") return fail(op, current.reason);
    const st = structuredClone(found);
    const qi = st.questions.findIndex((q) => q.plan.id === request.questionId);
    const q = st.questions[qi];
    if (!q) return fail(op, "That question isn't in this session.");
    const si = q.steps.findIndex((s) => s.id === request.stepId);
    const s = q.steps[si];
    if (!s) return fail(op, "That step isn't in this question.");
    if (si < firstStudentStep(q)) return fail(op, "That step is shown worked; continue with the next one.");
    const step = q.problem.steps[si]!;
    const seed = `${session.id}:${q.plan.id}:${s.id}`;
    let attempt: LearningAttempt | undefined;

    if (op === "exam.hint") {
      if (settledAfterSubmit) return fail(op, "This practice exam is submitted.");
      if (st.examConditions) return fail(op, "Hints are off under exam conditions.");
      if (stepSettled(q, s)) return fail(op, "This step is already settled.");
      const rung = nextRung(q.problem, step, s.rungs);
      if (!rung) return fail(op, "No more hints are prepared for this step. No model was called.");
      s.rungs.push(rung);
      if (revealsAnswer(rung)) s.revealed = true;
      // The full worked example shows every remaining step's answer.
      if (rung === "worked") for (const other of studentSteps(q)) if (!stepSettled(q, other)) other.revealed = true;
    } else {
      const response = request.response as StepResponse;
      if (response.kind !== "mark" && !responseFits(step.answer, response)) return fail(op, "Answer format does not match this step.", "failed");
      if (response.kind === "choice" && step.answer.kind === "choice" && !step.answer.options.some((o) => o.id === response.optionId))
        return fail(op, "That option isn't on this question.", "failed");
      if (settledAfterSubmit) {
        // After submit only the student's own mark is taken, for steps code couldn't settle.
        if (response.kind !== "mark") return fail(op, "This practice exam is submitted.");
        if (!(step.answer.kind === "self" || s.last?.outcome === "undecided")) return fail(op, "This step was checked by code.");
        if (!s.response) return fail(op, "Nothing was answered here.");
        const check = checkStep(step.answer.kind === "self" ? step.answer : { kind: "self", solution: null }, response, seed);
        s.first = check;
        s.last = check;
      } else if (st.mode === "exam") {
        if (response.kind === "mark") return fail(op, "Mark your answers after you submit.");
        s.response = response; // saved; checked (and shown) when the exam is submitted
        s.tries = 1;
      } else {
        if (stepSettled(q, s)) return fail(op, "This step is already settled.");
        if (response.kind === "mark" && !(step.answer.kind === "self" || (step.answer.kind === "text" && s.last?.outcome === "undecided")))
          return fail(op, "This step is checked by code.");
        if (response.kind === "mark" && !s.response) return fail(op, "Write your answer before marking it.");
        const check = checkStep(step.answer, response, seed);
        // An unreadable expression, unit or block set is feedback, not a try.
        const unreadable = check.outcome === "undecided" && step.answer.kind !== "text" && step.answer.kind !== "self";
        if (response.kind === "mark") s.first = check;
        else {
          s.response = response;
          if (!unreadable) {
            s.tries++;
            s.first ??= check;
          }
        }
        s.last = check;
      }
      if (request.explanation && step.explain) {
        const g = checkStep({ kind: "text", key: step.explain.keyIdeas[0]?.idea ?? "", keyIdeas: step.explain.keyIdeas }, { kind: "text", text: request.explanation }, seed);
        s.explanation = { text: request.explanation, check: g };
      }
      q.confidence = request.confidence ?? q.confidence;
      q.responseMs += request.responseMs;
    }
    // Practice: a question whose steps are all settled becomes evidence now; after submit, a mark does the same.
    if ((st.mode === "practice" || settledAfterSubmit) && !q.attemptId && questionSettled(q)) {
      const a = attemptFor(session, st, q, at);
      if (a) {
        q.attemptId = a.id;
        attempt = a;
      }
    }
    st.revision = found.revision + 1;
    st.updatedAt = at;
    st.operations = { ...st.operations, [request.operationId]: fingerprint };
    const done = st.questions.every((x) => questionSettled(x) || !!x.attemptId);
    const updated: LearningSession = { ...session, plan: st, endedAt: st.mode === "practice" && done ? at : session.endedAt };
    if (signal.aborted) return fail(op, "Study request cancelled.");
    if (!store.commitSession(updated, found.revision, attempt)) return fail(op, "Practice session changed. Reload it before continuing.");
    if (attempt) host.refreshAnalytics(updated.courseRef!, attempt.conceptTags.map((t) => t.conceptId));
    return { op, status: "ok", data: { exam: view(updated, st) } };
  }

  return { handle };
}
