// N06 stages 2, 4 and 5: schema checks, cue-flaw rules and near-duplicates.
// Pure code rules cover cue flaws only (spec §6.3); whether the key is right is
// stage 7's job.
import type { ItemKind, ItemOption } from "./store";

export function normaliseText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const words = (s: string) => normaliseText(s).split(" ").filter(Boolean);

export interface SchemaInput {
  kind: ItemKind;
  stem: string;
  options: ItemOption[] | null;
  key: string | number;
}

/** Stage 2. Returns a reason, or null when the structure holds. */
export function schemaProblem(i: SchemaInput): string | null {
  if (!i.stem?.trim()) return "missing stem";
  if (i.kind === "mc" || i.kind === "tf") {
    const opts = i.options ?? [];
    const [lo, hi] = i.kind === "mc" ? [3, 5] : [2, 2];
    if (opts.length < lo || opts.length > hi) return `${i.kind === "mc" ? "a multiple-choice item needs 3–5" : "a true/false item needs 2"} options, not ${opts.length}`;
    if (new Set(opts.map((o) => o.id)).size !== opts.length) return "duplicate option IDs";
    if (opts.some((o) => !normaliseText(o.text))) return "an empty option";
    if (new Set(opts.map((o) => normaliseText(o.text))).size !== opts.length) return "duplicate options";
    if (typeof i.key !== "string" || opts.filter((o) => o.id === i.key).length !== 1) return "exactly one key is needed";
    return null;
  }
  if (i.kind === "numeric") return typeof i.key === "number" && Number.isFinite(i.key) ? null : "a numeric item needs a numeric key";
  return typeof i.key === "string" && i.key.trim() ? null : "missing key";
}

const ABOVE = /\b(?:all|none|both|neither)\s+of\s+(?:the\s+)?(?:above|these|the options)\b/i;
const NEGATION = /\b(not|except|never|least|incorrect)\b/gi;

/** Stage 4 (cue flaws). Returns every rule that fires. */
export function flawProblems(i: SchemaInput, runLength = 4): string[] {
  const problems: string[] = [];
  // Negation stems without emphasis: "NOT", "*not*", "**not**" or "_not_" count as emphasis.
  for (const m of i.stem.matchAll(NEGATION)) {
    const word = m[1]!;
    const before = i.stem.slice(Math.max(0, m.index! - 2), m.index!);
    const emphasised = word === word.toUpperCase() || /[*_]$/.test(before);
    if (!emphasised) {
      problems.push(`negation stem without emphasis ("${word}")`);
      break;
    }
  }
  if (i.kind !== "mc" || !i.options) return problems;
  const opts = i.options;
  if (opts.some((o) => ABOVE.test(o.text))) problems.push('"all/none of the above" option');
  if (new Set(opts.map((o) => normaliseText(o.text))).size !== opts.length) problems.push("duplicate options");
  const key = opts.find((o) => o.id === i.key);
  if (!key) return problems;
  const distractors = opts.filter((o) => o.id !== key.id);
  const longest = Math.max(...distractors.map((o) => o.text.trim().length));
  if (distractors.length && key.text.trim().length > longest * 1.3) problems.push("the key is longer than every distractor by more than 30%");
  // A key that repeats a run of the stem's words verbatim, when no distractor does.
  const stemRuns = runs(words(i.stem), runLength);
  const hasRun = (text: string) => [...runs(words(text), runLength)].some((r) => stemRuns.has(r));
  if (stemRuns.size && [...runs(words(key.text), runLength)].some((r) => stemRuns.has(r)) && !distractors.some((d) => hasRun(d.text))) {
    problems.push("the key repeats the stem's words verbatim");
  }
  return problems;
}

function runs(ws: string[], n: number): Set<string> {
  const out = new Set<string>();
  for (let k = 0; k + n <= ws.length; k++) out.add(ws.slice(k, k + n).join(" "));
  return out;
}

/** Jaccard similarity of normalised token trigrams (stage 5). */
export function trigramJaccard(a: string, b: string): number {
  const grams = (s: string) => {
    const ws = words(s);
    return ws.length < 3 ? new Set([ws.join(" ")]) : runs(ws, 3);
  };
  const A = grams(a);
  const B = grams(b);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 1 : inter / union;
}

export const NEAR_DUPLICATE = 0.8;

export function nearDuplicateOf(stem: string, seen: string[]): string | null {
  return seen.find((s) => trigramJaccard(stem, s) >= NEAR_DUPLICATE) ?? null;
}
