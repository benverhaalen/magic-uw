/**
 * Step checking, all in code (owner: exam-prep): numbers with tolerance and units, symbolic
 * equivalence with an optional required form, choices, typed key ideas, Parsons block order,
 * and the student's own mark on an instructor problem. Feedback names the specific fault code
 * found (a unit of the wrong kind, a power-of-ten slip, a sign, an unfactored form, the blocks
 * out of place), never a model's opinion.
 */
import { gradeTyped } from "../grade";
import { convertTo, equivalent, isExpanded, isFactored, parseExpression } from "./symbolic";
import type { StepAnswer, StepFeedback } from "./types";

export type StepResponse =
  | { kind: "choice"; optionId: string }
  | { kind: "text"; text: string }
  | { kind: "number"; value: number; unit?: string }
  | { kind: "expression"; text: string }
  | { kind: "order"; blocks: { id: string; indent: number }[] }
  | { kind: "mark"; mark: "right" | "partly" | "wrong" };

export interface StepCheck extends StepFeedback {
  /** Credit for the step: 1, a partial key-idea share, or 0. Null while undecided. */
  score: number | null;
}

const ok = (message: string, checks: string[]): StepCheck => ({ outcome: "correct", message, checks, score: 1 });
const wrong = (message: string, checks: string[], extra: Partial<StepCheck> = {}): StepCheck => ({ outcome: "incorrect", message, checks, score: 0, ...extra });

/** Does the response's shape fit the step? */
export function responseFits(answer: StepAnswer, response: StepResponse): boolean {
  switch (answer.kind) {
    case "numeric":
      return response.kind === "number";
    case "symbolic":
      return response.kind === "expression";
    case "choice":
      return response.kind === "choice";
    case "text":
      return response.kind === "text" || response.kind === "mark";
    case "parsons":
      return response.kind === "order";
    case "self":
      return response.kind === "text" || response.kind === "mark";
  }
}

/** Tolerance-aware numeric comparison with the error-specific checks. */
export function checkNumeric(answer: Extract<StepAnswer, { kind: "numeric" }>, value: number, unit: string | undefined): StepCheck {
  const checks = ["Checked by code: value within tolerance, unit converted"];
  if (!Number.isFinite(value)) return wrong("Enter a number.", checks);
  const converted = convertTo(value, unit ?? null, answer.unit);
  if (!converted.ok) return wrong(converted.reason, checks, { outcome: converted.code === "unknown_unit" ? "undecided" : "incorrect", score: converted.code === "unknown_unit" ? null : 0 });
  const v = converted.value;
  const key = answer.value;
  const tol = Math.max(answer.absTol, answer.relTol * Math.abs(key));
  if (Math.abs(v - key) <= tol) return ok(unit && answer.unit && unit.trim() !== answer.unit ? `Right, and ${unit} converts correctly.` : "Right.", checks);
  if (key !== 0 && Math.abs(v + key) <= tol) return wrong("The size is right but the sign isn't.", checks);
  if (key !== 0 && v !== 0) {
    const ratio = Math.log10(Math.abs(v / key));
    const rounded = Math.round(ratio);
    if (rounded !== 0 && Math.abs(ratio - rounded) < 0.002) return wrong(`Off by a factor of 10^${rounded}: check a unit conversion or a power of ten.`, checks);
  }
  return wrong("Not within tolerance of the answer.", checks);
}

export function checkSymbolic(answer: Extract<StepAnswer, { kind: "symbolic" }>, text: string, seed: string): StepCheck {
  const checks = ["Checked by code: symbolic equivalence (mathjs simplify, then seeded sampling)"];
  const expected = parseExpression(answer.expr, answer.variables);
  if (!expected.ok) return { outcome: "undecided", message: "This step's key can't be read by code; it isn't scored.", checks, score: null };
  const given = parseExpression(text, answer.variables);
  if (!given.ok) return { outcome: "undecided", message: given.reason, checks, score: null };
  const same = equivalent(expected.node, given.node, answer.variables, seed);
  if (!same.equivalent) return wrong("Not equivalent to the expected expression.", checks);
  if (answer.form === "factored" && !isFactored(given.node)) return { outcome: "partial", message: "Equivalent, but not factored yet.", checks: [...checks, "Form checked: factored"], score: 0.5 };
  if (answer.form === "expanded" && !isExpanded(given.node)) return { outcome: "partial", message: "Equivalent, but not expanded yet.", checks: [...checks, "Form checked: expanded"], score: 0.5 };
  return ok(same.method === "simplify" ? "Right: equivalent after simplifying." : "Right: equivalent at every point checked.", checks);
}

/** The longest increasing subsequence of positions: the blocks already in the right relative order. */
function inOrder(positions: number[]): Set<number> {
  const n = positions.length;
  const len = new Array<number>(n).fill(1);
  const prev = new Array<number>(n).fill(-1);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < i; j++)
      if (positions[j]! < positions[i]! && len[j]! + 1 > len[i]!) {
        len[i] = len[j]! + 1;
        prev[i] = j;
      }
  let best = 0;
  for (let i = 1; i < n; i++) if (len[i]! > len[best]!) best = i;
  const keep = new Set<number>();
  for (let i = n ? best : -1; i >= 0; i = prev[i]!) keep.add(i);
  return keep;
}

/** Parsons: the order of the solution (or an allowed alternative), indentation when it matters. */
export function checkParsons(answer: Extract<StepAnswer, { kind: "parsons" }>, blocks: { id: string; indent: number }[]): StepCheck {
  const checks = ["Checked by code: block order" + (answer.indented ? " and indentation" : "")];
  const known = new Set(answer.blocks.map((b) => b.id));
  if (blocks.some((b) => !known.has(b.id))) return { outcome: "undecided", message: "Some blocks aren't from this problem. Reload it.", checks, score: null };
  const distractors = blocks.filter((b) => answer.distractors.includes(b.id)).map((b) => b.id);
  if (distractors.length) return wrong("Some of these lines don't belong in the solution.", checks, { misplaced: distractors });
  const ids = blocks.map((b) => b.id);
  const solutions = [answer.solution, ...answer.alternatives];
  const indentOf = new Map(answer.blocks.map((b) => [b.id, b.indent]));
  for (const s of solutions)
    if (s.length === ids.length && s.every((id, i) => id === ids[i])) {
      const badIndent = answer.indented ? blocks.filter((b) => indentOf.get(b.id) !== b.indent).map((b) => b.id) : [];
      if (badIndent.length) return { outcome: "partial", message: "The order is right; check the indentation.", checks, score: 0.5, misplaced: badIndent };
      return ok("Right: the lines are in a working order.", checks);
    }
  const missing = answer.solution.filter((id) => !ids.includes(id));
  // Feedback against the closest solution: blocks outside its longest in-order run are out of place.
  let misplaced: string[] = [];
  let bestKept = -1;
  for (const s of solutions) {
    const pos = ids.map((id) => s.indexOf(id)).filter((p) => p >= 0);
    const present = ids.filter((id) => s.includes(id));
    const keep = inOrder(pos);
    if (keep.size > bestKept) {
      bestKept = keep.size;
      misplaced = present.filter((_, i) => !keep.has(i));
    }
  }
  return wrong(missing.length ? `${missing.length} line${missing.length === 1 ? " is" : "s are"} missing.` : "Some lines are out of order.", checks, { misplaced });
}

/** Check one step. `seed` makes symbolic sampling reproducible per question. */
export function checkStep(answer: StepAnswer, response: StepResponse, seed: string): StepCheck {
  if (!responseFits(answer, response)) return { outcome: "undecided", message: "That answer doesn't fit this step.", checks: [], score: null };
  switch (answer.kind) {
    case "numeric": {
      const r = response as Extract<StepResponse, { kind: "number" }>;
      return checkNumeric(answer, r.value, r.unit);
    }
    case "symbolic":
      return checkSymbolic(answer, (response as Extract<StepResponse, { kind: "expression" }>).text, seed);
    case "choice": {
      const id = (response as Extract<StepResponse, { kind: "choice" }>).optionId;
      if (!answer.options.some((o) => o.id === id)) return { outcome: "undecided", message: "That option isn't on this question.", checks: [], score: null };
      return id === answer.key ? ok("Right.", ["Graded by code"]) : wrong("Not the keyed answer.", ["Graded by code"]);
    }
    case "text": {
      if (response.kind === "mark") return markCheck(response.mark);
      const g = gradeTyped({ id: seed, key: answer.key, keyIdeas: answer.keyIdeas }, (response as Extract<StepResponse, { kind: "text" }>).text);
      const missing = g.keyIdeas.filter((i) => i.required && i.found !== true).map((i) => i.idea);
      return {
        outcome: g.outcome,
        message:
          g.outcome === "correct" ? "Right: every key idea is there." : g.outcome === "undecided" ? "Code couldn't settle every key idea; mark it against the key." : `Missing: ${missing.join("; ")}.`,
        checks: g.checks,
        score: g.score,
      };
    }
    case "parsons":
      return checkParsons(answer, (response as Extract<StepResponse, { kind: "order" }>).blocks);
    case "self":
      return response.kind === "mark"
        ? markCheck(response.mark)
        : { outcome: "undecided", message: "Compare your work with the instructor's solution, then mark it.", checks: [], score: null };
  }
}

function markCheck(mark: "right" | "partly" | "wrong"): StepCheck {
  const checks = ["Marked by you"];
  return mark === "right"
    ? { outcome: "correct", message: "Marked right by you.", checks, score: 1 }
    : mark === "partly"
      ? { outcome: "partial", message: "Marked partly right by you.", checks, score: 0.5 }
      : { outcome: "incorrect", message: "Marked wrong by you.", checks, score: 0 };
}

/** The key in display form, shown once the step is settled. */
export function answerText(answer: StepAnswer): string | null {
  switch (answer.kind) {
    case "numeric":
      return `${answer.value}${answer.unit ? ` ${answer.unit}` : ""}`;
    case "symbolic":
      return answer.expr;
    case "choice":
      return answer.options.find((o) => o.id === answer.key)?.text ?? answer.key;
    case "text":
      return answer.key;
    case "parsons":
      return answer.solution.map((id) => {
        const b = answer.blocks.find((x) => x.id === id)!;
        return `${"  ".repeat(b.indent)}${b.text}`;
      }).join("\n");
    case "self":
      return answer.solution?.quote ?? null;
  }
}
