/**
 * owner: study-prep. Code checks for generated problems (practice problems and practice exams):
 * every problem is grounded in a passage; its answer is verified where code can (a multiple-choice
 * key among its options, a numeric value recomputed from its formula, an expression proved
 * equivalent to the solution's form by the exam engine's symbolic check); and it is never a near
 * copy of a past exam problem or of the assigned work.
 */
import { evaluate } from "../../../learning/src/arith";
import { equivalent, parseExpression } from "../../../learning/src/exam/symbolic";

export interface ProblemAnswer {
  kind: "choice" | "numeric" | "expression" | "none";
  value: number | null;
  unit: string | null;
  formula: string | null;
  expr: string | null;
  derivation: string | null;
  variables: string[];
}
export type Verified = "recomputed" | "symbolic" | "key" | "self_marked";

/** Lowercased words and numbers, TeX commands and punctuation removed. */
export function problemWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\\[a-z]+/g, " ")
    .replace(/[^a-z0-9.]+/g, " ")
    .split(" ")
    .filter((w) => w && w !== ".");
}
const shingles = (words: string[], n: number) => {
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(" "));
  return out;
};
const numbers = (text: string) => new Set((text.match(/-?\d+(?:\.\d+)?/g) ?? []).filter((n) => n.replace("-", "").length > 0));

/** Share of the candidate's 4-word runs found in the reference: 1 is a verbatim copy. */
export function containment(candidate: string, reference: string): number {
  const a = shingles(problemWords(candidate), 4);
  if (!a.size) return 0;
  const b = shingles(problemWords(reference), 4);
  let hit = 0;
  for (const s of a) if (b.has(s)) hit++;
  return hit / a.size;
}
/** Word-run overlap at or above this is a near copy. */
export const NEAR_COPY = 0.5;
/** The same numbers with this much wording overlap is the same problem with new wording. */
export const SAME_NUMBERS_OVERLAP = 0.25;

/** The reference problem a candidate nearly copies, if any (each reference is one problem or one document). */
export function nearCopyOf(candidate: string, references: { label: string; text: string }[]): string | null {
  const nums = numbers(candidate);
  for (const ref of references) {
    for (const chunk of problemChunks(ref.text)) {
      const c = containment(candidate, chunk);
      if (c >= NEAR_COPY) return ref.label;
      const theirs = numbers(chunk);
      const shared = [...nums].filter((n) => theirs.has(n) && !/^[0-9]$/.test(n));
      if (shared.length >= 2 && shared.length >= Math.min(nums.size, theirs.size) && c >= SAME_NUMBERS_OVERLAP) return ref.label;
    }
  }
  return null;
}

/** A document split into problem-sized chunks: numbered items ("1.", "2)", "Problem 3") else paragraphs. */
export function problemChunks(text: string): string[] {
  const parts = text.split(/\n(?=\s*(?:\(?\d{1,2}[.)]|problem\s+\d|question\s+\d|q\d))/i).map((p) => p.trim()).filter((p) => p.length >= 12);
  return parts.length > 1 ? parts : text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length >= 12);
}

/** Verify a problem's answer by code; a reason when it fails. */
export function verifyAnswer(a: ProblemAnswer, options: { text: string; correct: boolean }[] | null): { verified: Verified } | { reason: string } {
  if (a.kind === "choice") {
    const keys = (options ?? []).filter((o) => o.correct);
    if (!options || options.length < 2) return { reason: "a multiple-choice problem needs its options" };
    if (keys.length !== 1) return { reason: `${keys.length} options are marked correct; exactly one is needed` };
    return { verified: "key" };
  }
  if (a.kind === "numeric") {
    if (a.value === null || !Number.isFinite(a.value)) return { reason: "a numeric answer needs its value" };
    if (!a.formula) return { verified: "self_marked" };
    try {
      const got = evaluate(a.formula);
      // Relative to the values themselves: sampling periods and the like are far below 1, where a scale floored at 1 would accept anything.
      const close = Math.abs(got.value - a.value) <= Math.max(1e-12, 5e-3 * Math.max(Math.abs(got.value), Math.abs(a.value)));
      if (!close) return { reason: `the formula gives ${Number(got.value.toPrecision(8))}, not ${a.value}` };
      return { verified: "recomputed" };
    } catch (e) {
      return { reason: `the formula doesn't evaluate: ${(e as Error).message}` };
    }
  }
  if (a.kind === "expression") {
    if (!a.expr) return { reason: "an expression answer needs its expression" };
    const vars = a.variables.slice(0, 6);
    const key = parseExpression(a.expr, vars);
    if (!key.ok) return { reason: `the answer doesn't parse: ${key.reason}` };
    if (!a.derivation) return { verified: "self_marked" };
    const form = parseExpression(a.derivation, vars);
    if (!form.ok) return { reason: `the worked form doesn't parse: ${form.reason}` };
    const eq = equivalent(key.node, form.node, vars, `prep:${a.expr}`);
    return eq.equivalent ? { verified: "symbolic" } : { reason: `the answer and the worked solution disagree (${eq.reason})` };
  }
  return { verified: "self_marked" };
}
