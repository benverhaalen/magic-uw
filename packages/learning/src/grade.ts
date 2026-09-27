// N08: grading at study time, all in code (0 model tokens). Choice and
// numeric answers are exact (numeric within a tolerance). Typed answers are
// matched against the key and a key-idea checklist with listed synonyms, after
// normalising case, whitespace, punctuation, articles and plurals. When code
// can't decide an idea, it's left `undecided` and the attempt isn't scored.
//
// How `undecided` gets settled awaits the operator's T02 sign-off, so both
// hooks exist and neither is chosen here:
//   - resolveByStudent(grade, decisions): the student marks each open idea
//   - pendingJudgeRequests(grade) + applyJudgeVerdicts(grade, verdicts): a
//     background Jev re-check, run outside the study session
import { sameQuantity } from "./arith";
import type { Grade, KeyIdeaMethod } from "./types";
import type { KeyIdea } from "./store";

const ARTICLES = new Set(["a", "an", "the"]);
const NEGATORS = new Set(["not", "no", "never", "isn't", "isnt", "doesn't", "doesnt", "don't", "dont", "without", "neither", "nor"]);
const NON_ANSWERS = new Set(["", "idk", "i don't know", "i dont know", "dont know", "don't know", "no idea", "pass", "?"]);

function stem(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && /(?:ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/** Tokens after normalising case, diacritics, punctuation, articles and simple plurals. */
export function normaliseTokens(s: string): string[] {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .split(" ")
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter((w) => w && !ARTICLES.has(w))
    .map(stem);
}

export const normaliseAnswer = (s: string) => normaliseTokens(s).join(" ");

/** Where `phrase` occurs in `tokens` as a whole-word run, not negated just before it. */
function phraseMatch(tokens: string[], phrase: string[]): "found" | "negated" | "absent" {
  if (!phrase.length) return "absent";
  let negated = false;
  for (let i = 0; i + phrase.length <= tokens.length; i++) {
    if (phrase.every((w, k) => tokens[i + k] === w)) {
      const before = tokens.slice(Math.max(0, i - 3), i);
      if (before.some((w) => NEGATORS.has(w))) negated = true;
      else return "found";
    }
  }
  return negated ? "negated" : "absent";
}

export interface GradedIdea {
  idea: string;
  found: boolean | null;
  method: KeyIdeaMethod;
  required: boolean;
}

export interface TypedGrade extends Grade {
  keyIdeas: GradedIdea[];
  /** found / required, or null while any required idea is undecided (the attempt isn't scored). */
  score: number | null;
}

function finish(itemId: string, ideas: GradedIdea[], deferred: boolean, whole: boolean): TypedGrade {
  const required = ideas.filter((i) => i.required);
  const pool = required.length ? required : ideas;
  const open = pool.some((i) => i.found === null);
  const found = pool.filter((i) => i.found === true).length;
  const score = whole ? 1 : open ? null : pool.length ? found / pool.length : 0;
  const outcome: Grade["outcome"] = score === null ? "undecided" : score >= 1 ? "correct" : score > 0 ? "partial" : "incorrect";
  const checks = ["Graded by code against the key ideas"];
  if (open) checks.push("Some key ideas not checked yet");
  if (ideas.some((i) => i.method === "student")) checks.push("Marked by you");
  if (ideas.some((i) => i.method === "judge")) checks.push("Key ideas judged by Jev");
  return { itemId, outcome, keyIdeas: ideas, deferred, checks, score };
}

/**
 * Grade a typed answer. The whole answer is first compared with the key (and
 * the key's listed synonyms); otherwise each key idea is looked for by phrase.
 * Code decides "found"; it decides "not found" only for a blank or non-answer.
 */
export function gradeTyped(
  item: { id: string; key: string; keySynonyms?: string[]; keyIdeas: KeyIdea[] },
  answer: string,
  opts: { deferred?: boolean } = {},
): TypedGrade {
  const tokens = normaliseTokens(answer);
  const norm = tokens.join(" ");
  const ideas: KeyIdea[] = item.keyIdeas.length ? item.keyIdeas : [{ idea: item.key, synonyms: item.keySynonyms ?? [], required: true }];
  const deferred = opts.deferred ?? false;

  const keyForms = [item.key, ...(item.keySynonyms ?? [])].map(normaliseAnswer).filter(Boolean);
  const exact = answer.trim() === item.key.trim();
  if (norm && (exact || keyForms.includes(norm))) {
    const method: KeyIdeaMethod = exact ? "exact" : keyForms[0] === norm ? "normalised" : "synonym";
    return finish(item.id, ideas.map((i) => ({ idea: i.idea, found: true, method, required: i.required })), deferred, true);
  }

  if (NON_ANSWERS.has(answer.trim().toLowerCase()) || !norm) {
    return finish(item.id, ideas.map((i) => ({ idea: i.idea, found: false, method: "normalised", required: i.required })), deferred, false);
  }

  const graded = ideas.map((i): GradedIdea => {
    const forms: [string, KeyIdeaMethod][] = [[i.idea, "normalised"], ...i.synonyms.map((s): [string, KeyIdeaMethod] => [s, "synonym"])];
    for (const [form, method] of forms) {
      if (phraseMatch(tokens, normaliseTokens(form)) === "found") return { idea: i.idea, found: true, method, required: i.required };
    }
    return { idea: i.idea, found: null, method: "undecided", required: i.required };
  });
  return finish(item.id, graded, deferred, false);
}

/** Hook A: the student marks each undecided idea. Ideas code already decided don't change. */
export function resolveByStudent(grade: TypedGrade, decisions: Record<string, boolean>): TypedGrade {
  const ideas = grade.keyIdeas.map((i) =>
    i.found === null && i.idea in decisions ? { ...i, found: decisions[i.idea]!, method: "student" as const } : i,
  );
  return finish(grade.itemId, ideas, grade.deferred, false);
}

/** Hook B: what a background re-check would ask ("Does the answer state ⟨idea⟩?"), one per undecided idea. */
export function pendingJudgeRequests(grade: TypedGrade, answer: string): { itemId: string; idea: string; answer: string }[] {
  return grade.keyIdeas.filter((i) => i.found === null).map((i) => ({ itemId: grade.itemId, idea: i.idea, answer }));
}

/** Hook B, second half: apply the re-check's verdicts; an abstention leaves the idea undecided. */
export function applyJudgeVerdicts(grade: TypedGrade, verdicts: Record<string, boolean | "abstain">): TypedGrade {
  const ideas = grade.keyIdeas.map((i) => {
    const v = verdicts[i.idea];
    return i.found === null && (v === true || v === false) ? { ...i, found: v, method: "judge" as const } : i;
  });
  return finish(grade.itemId, ideas, grade.deferred, false);
}

/** Multiple choice and true/false: exact option ID. */
export function gradeChoice(item: { id: string; key: string | number }, optionId: string, opts: { deferred?: boolean } = {}): Grade {
  const right = optionId === String(item.key);
  return { itemId: item.id, outcome: right ? "correct" : "incorrect", deferred: opts.deferred ?? false, checks: ["Graded by code"] };
}

/** Numeric: within a relative tolerance; a stated unit must match the item's. */
export function gradeNumeric(
  item: { id: string; key: string | number; unit?: string },
  value: number,
  unit?: string,
  opts: { relTol?: number; deferred?: boolean } = {},
): Grade {
  const want = { value: Number(item.key), unit: item.unit ?? null };
  const got = { value, unit: unit ?? item.unit ?? null };
  const right = Number.isFinite(value) && sameQuantity(got, want, opts.relTol ?? 0.005);
  return { itemId: item.id, outcome: right ? "correct" : "incorrect", deferred: opts.deferred ?? false, checks: ["Graded by code"] };
}
