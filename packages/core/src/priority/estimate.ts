/**
 * Effort estimates (D49): code first, the student's AI refines each once per text hash, and the
 * student's own correction wins and teaches the course's calibration. Every figure is bounded to
 * 5 min–40 h and labelled "estimate". Stored in the `judgments` cache on the item's current text
 * hash, so a grade or submission change keeps them and an edited assignment re-estimates.
 */
import type { Judgment, Store } from "@magic/contracts";
import type { AgendaEstimate } from "@magic/contracts";
import type { GraphStore } from "../../../contracts/src/course-core";
import { AGENDA_CONFIG, type AgendaConfig } from "./config";
import type { AgendaFact, AgendaKind } from "./items";

export const ESTIMATE_QUESTIONS = {
  code: "agenda.estimate.code.v1",
  model: "agenda.estimate.model.v1",
  student: "agenda.estimate.student.v1",
} as const;
/** The judgment `model` column for each (the model's own name is in the result). */
const JUDGE = { code: "code", model: "student-ai", student: "student" } as const;

export interface EstimateFeatures {
  kind: AgendaKind;
  points: number | null;
  questionCount: number | null;
  rubricCriteria: number;
  instructionChars: number;
  /** Token estimate of the linked materials' passages; null when not measured yet. */
  materialTokens: number | null;
}
export interface CodeEstimate {
  minutes: number;
  /** The parts, for the model's input and the student's "why". */
  parts: string[];
}

export const clampMinutes = (minutes: number, config: AgendaConfig = AGENDA_CONFIG) =>
  Math.round(Math.min(config.estimate.maxMinutes, Math.max(config.estimate.minMinutes, minutes)));

/** The code rule: a base by kind, plus points, questions, rubric, instructions and materials, capped. */
export function codeEstimate(f: EstimateFeatures, config: AgendaConfig = AGENDA_CONFIG): CodeEstimate {
  const e = config.estimate;
  const parts: string[] = [];
  let minutes: number = e.baseMinutes[f.kind];
  if (f.kind === "quiz" && f.questionCount) {
    minutes = e.quizSetupMinutes + f.questionCount * e.minutesPerQuestion;
    parts.push(`${f.questionCount} questions`);
  } else parts.push(`${f.kind} base`);
  if (f.points && f.kind !== "exam") {
    minutes += Math.min(e.pointsCapMinutes, f.points * e.minutesPerPoint);
    parts.push(`${f.points} points`);
  }
  if (f.rubricCriteria > e.rubricFreeCriteria) {
    minutes += (f.rubricCriteria - e.rubricFreeCriteria) * e.minutesPerRubricCriterion;
    parts.push(`${f.rubricCriteria} rubric criteria`);
  }
  if (f.instructionChars > 0) minutes += Math.min(e.instructionCapMinutes, f.instructionChars / e.instructionCharsPerMinute);
  if (f.materialTokens) {
    minutes += Math.min(e.materialCapMinutes, f.materialTokens / e.readingTokensPerMinute);
    parts.push(`about ${Math.round(f.materialTokens / 1000)}k tokens of linked material`);
  }
  return { minutes: clampMinutes(minutes, config), parts };
}

export function featuresOf(fact: AgendaFact, materialTokens: number | null = null): EstimateFeatures {
  return { kind: fact.kind, points: fact.points, ...fact.features, materialTokens };
}

interface StoredCode { minutes: number; parts: string[] }
interface StoredModel { minutes: number; model: string; basis: string | null }
interface StoredStudent { minutes: number; replaced: number; replacedMethod: "code" | "model" }
export interface StoredEstimates {
  code?: StoredCode;
  model?: StoredModel;
  student?: StoredStudent;
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
/** The agenda's stored estimates by resource, read once from the (hash-current) judgments. */
export function storedEstimates(judgments: Judgment[]): Map<string, StoredEstimates> {
  const out = new Map<string, StoredEstimates>();
  for (const j of judgments) {
    const r = j.result as Record<string, unknown> | null;
    if (!r || !num(r.minutes)) continue;
    const row = out.get(j.resourceId) ?? {};
    if (j.questionVersion === ESTIMATE_QUESTIONS.code) row.code = { minutes: r.minutes, parts: Array.isArray(r.parts) ? (r.parts as string[]) : [] };
    else if (j.questionVersion === ESTIMATE_QUESTIONS.model)
      row.model = { minutes: r.minutes, model: String(r.model ?? ""), basis: typeof r.basis === "string" ? r.basis : null };
    else if (j.questionVersion === ESTIMATE_QUESTIONS.student && num(r.replaced))
      row.student = { minutes: r.minutes, replaced: r.replaced, replacedMethod: r.replacedMethod === "model" ? "model" : "code" };
    else continue;
    out.set(j.resourceId, row);
  }
  return out;
}

/**
 * The course's calibration: the median of corrected ÷ replaced over the student's corrections in
 * that course, clamped. 1 with no corrections.
 */
export function calibrations(
  facts: AgendaFact[],
  stored: Map<string, StoredEstimates>,
  config: AgendaConfig = AGENDA_CONFIG,
): Map<string, number> {
  const ratios = new Map<string, number[]>();
  for (const f of facts) {
    const s = f.resourceId ? stored.get(f.resourceId)?.student : undefined;
    if (!s) continue;
    const key = `${f.accountScope}\n${f.courseId}`;
    ratios.set(key, [...(ratios.get(key) ?? []), s.minutes / s.replaced]);
  }
  const out = new Map<string, number>();
  for (const [key, rs] of ratios) {
    const sorted = rs.sort((a, b) => a - b);
    const mid = sorted.length / 2;
    const median = sorted.length % 2 ? sorted[Math.floor(mid)]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
    out.set(key, Math.min(config.estimate.calibrationMax, Math.max(config.estimate.calibrationMin, median)));
  }
  return out;
}

/** The estimate shown: the student's correction, else the model's, else code's; calibrated unless the student set it. */
export function resolveEstimate(
  fact: AgendaFact,
  stored: StoredEstimates | undefined,
  calibration: number,
  config: AgendaConfig = AGENDA_CONFIG,
): AgendaEstimate {
  if (stored?.student) return { minutes: clampMinutes(stored.student.minutes, config), method: "student", label: "estimate", calibrated: false };
  const base = baselineEstimate(fact, stored, config);
  const calibrated = calibration !== 1;
  return { minutes: clampMinutes(base.minutes * calibration, config), method: base.method, label: "estimate", calibrated };
}

/** The model's estimate, else code's (stored with material sizes, or computed without), uncalibrated. */
export function baselineEstimate(
  fact: AgendaFact,
  stored: StoredEstimates | undefined,
  config: AgendaConfig = AGENDA_CONFIG,
): { minutes: number; method: "code" | "model" } {
  return stored?.model
    ? { minutes: stored.model.minutes, method: "model" }
    : { minutes: stored?.code?.minutes ?? codeEstimate(featuresOf(fact), config).minutes, method: "code" };
}

type EstimateStore = Store & Pick<GraphStore, "resourceTextHash">;
const judgmentKey = (question: string, resourceId: string, inputHash: string) => `${question}:${resourceId}:${inputHash}`;

/** Writes one estimate on the item's current text hash; false when the item is gone or changed. */
export function putEstimate(
  store: EstimateStore,
  which: keyof typeof ESTIMATE_QUESTIONS,
  resourceId: string,
  result: Record<string, unknown>,
  at: string,
): boolean {
  const inputHash = store.resourceTextHash(resourceId);
  if (!inputHash) return false;
  return store.putJudgment({
    key: judgmentKey(ESTIMATE_QUESTIONS[which], resourceId, inputHash),
    resourceId,
    inputHash,
    model: JUDGE[which],
    questionVersion: ESTIMATE_QUESTIONS[which],
    result,
    createdAt: at,
  });
}

/**
 * The student's correction (the `correct` command's `estimate` subject). It records the estimate
 * it replaced, so the course's calibration learns the ratio. Returns the message for the student.
 */
export function correctEstimate(
  store: EstimateStore,
  value: { resourceId: string; minutes: number },
  fact: AgendaFact,
  at: string,
  config: AgendaConfig = AGENDA_CONFIG,
): string {
  const minutes = clampMinutes(value.minutes, config);
  const stored = storedEstimates(store.judgments().filter((j) => j.resourceId === value.resourceId)).get(value.resourceId);
  // The ratio is against the app's uncalibrated figure; a second correction keeps the first's baseline.
  const baseline = stored?.student
    ? { minutes: stored.student.replaced, method: stored.student.replacedMethod }
    : baselineEstimate(fact, stored, config);
  const ok = putEstimate(store, "student", value.resourceId, { minutes, replaced: baseline.minutes, replacedMethod: baseline.method }, at);
  return ok ? `Saved: about ${formatMinutes(minutes)} for this item. Other estimates in the course adjust to it.` : "This item changed or is no longer available; nothing was saved.";
}

export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.round((minutes / 60) * 2) / 2;
  return `${h} h`;
}
