/**
 * The hint ladder and worked-example fading (owner: exam-prep). Both are code: the ladder serves
 * prepared, checked text in a fixed order (nudge, then the worked step, then the full worked
 * example), and fading picks how many final steps the student solves from their own record
 * (backward fading, after Renkl and Atkinson). No model is called at study time.
 */
import { normaliseAnswer } from "../grade";
import { answerText } from "./check";
import type { HintRung, SolveProblem, SolveStep, StepAnswer } from "./types";
import type { LearningAttempt } from "../store";

export const RUNGS: HintRung[] = ["nudge", "step", "worked"];

/** The next rung this step offers after `used`, skipping rungs with no prepared text; null when none is left. */
export function nextRung(problem: SolveProblem, step: SolveStep, used: HintRung[]): HintRung | null {
  for (const rung of RUNGS) {
    if (used.includes(rung)) continue;
    if (rung === "nudge" && !step.nudge) continue;
    if (rung === "step" && !step.worked) continue;
    if (rung === "worked" && !problem.workedExample.length) continue;
    return rung;
  }
  return null;
}

export function rungText(problem: SolveProblem, step: SolveStep, rung: HintRung): string {
  if (rung === "nudge") return step.nudge ?? "";
  if (rung === "step") return step.worked ?? "";
  return problem.workedExample.map((line, i) => `${i + 1}. ${line}`).join("\n");
}

/** Assistance the knowledge model records: a nudge or worked step is a hint; the full example is an explanation. */
export function assistanceFor(rungs: HintRung[]): "none" | "hint" | "explained" {
  if (rungs.includes("worked")) return "explained";
  return rungs.length ? "hint" : "none";
}

/** A rung that shows the step's answer settles the step as revealed (no credit). */
export const revealsAnswer = (rung: HintRung) => rung !== "nudge";

/**
 * Restraint, checked by code: a nudge must not state the answer. For numbers, the key's digits;
 * for expressions, the key with spaces removed; for text, the key's normalised words.
 */
export function nudgeGivesAway(nudge: string, answer: StepAnswer): boolean {
  const text = nudge.toLowerCase();
  switch (answer.kind) {
    case "numeric": {
      const digits = String(answer.value);
      return digits.replace(/^-/, "").length >= 2 && new RegExp(`(?<![\\d.])${digits.replace(/[.\-]/g, "\\$&")}(?![\\d])`).test(nudge);
    }
    case "symbolic":
      return answer.expr.replace(/\s+/g, "").length >= 3 && text.replace(/\s+/g, "").includes(answer.expr.replace(/\s+/g, "").toLowerCase());
    case "text": {
      const key = normaliseAnswer(answer.key);
      return key.length >= 3 && ` ${normaliseAnswer(nudge)} `.includes(` ${key} `);
    }
    case "choice": {
      const key = answer.options.find((o) => o.id === answer.key)?.text;
      return !!key && normaliseAnswer(key).length >= 3 && normaliseAnswer(nudge).includes(normaliseAnswer(key));
    }
    default:
      return false;
  }
}

/** The fade level stored on an attempt's response (steps the student solved), when present. */
function fadeOf(a: LearningAttempt): number | null {
  const r = a.response as { fade?: unknown } | null;
  return r && typeof r.fade === "number" ? r.fade : null;
}

/**
 * Backward fading: how many final steps the student solves this time. A new problem starts with
 * the last step only; a correct, unassisted attempt fades one more step; a miss or a full worked
 * example steps back one. A one-step problem is always solved whole.
 */
export function fadeLevel(problem: SolveProblem, attempts: LearningAttempt[]): number {
  const n = problem.steps.length;
  if (n <= 1) return n;
  const mine = attempts
    .filter((a) => a.itemId === problem.id && fadeOf(a) !== null)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  const last = mine[mine.length - 1];
  if (!last) return 1;
  const k = fadeOf(last)!;
  if (last.correct && last.assistance === "none") return Math.min(n, k + 1);
  if (!last.correct || last.assistance === "explained") return Math.max(1, k - 1);
  return Math.max(1, Math.min(n, k));
}

/** The worked text shown for a step the fading schedule doesn't ask: its worked line, or its answer. */
export function shownWorked(problem: SolveProblem, index: number): string {
  const step = problem.steps[index]!;
  return step.worked ?? problem.workedExample[index] ?? `${step.prompt} ${answerText(step.answer) ?? ""}`.trim();
}
