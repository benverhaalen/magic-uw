/**
 * Token budgets for agent-facing results. A result over its budget is trimmed, never refused:
 * first the excerpt windows narrow (around the match), then whole items drop from the tail.
 * Tokens are estimated at 4 characters each (JSON text), a conservative count for English prose.
 */
export const CHARS_PER_TOKEN = 4;

export interface DetailLevel {
  /** Characters of the item's text returned around the match. */
  window: number;
  parts: number;
  partChars: number;
  comments: number;
  commentChars: number;
}
/** From the full view (the old 8,000-character excerpt) down to a citation-sized snippet. */
export const DETAIL_LEVELS: readonly DetailLevel[] = [
  { window: 8000, parts: 40, partChars: 2000, comments: 50, commentChars: 4000 },
  { window: 4000, parts: 20, partChars: 1000, comments: 20, commentChars: 1500 },
  { window: 2000, parts: 10, partChars: 500, comments: 10, commentChars: 600 },
  { window: 1000, parts: 5, partChars: 300, comments: 5, commentChars: 300 },
  { window: 400, parts: 2, partChars: 200, comments: 2, commentChars: 200 },
];

export interface Fitted<T> {
  value: T;
  /** The JSON text of `value`, the exact characters that leave the machine. */
  text: string;
  /** The items kept (≤ the items offered). */
  count: number;
  trimmed: boolean;
}

/**
 * The richest `build(level, count)` whose JSON fits `budgetTokens`. Sizing builds run with
 * `final = false` (they may skip side effects such as registering citation projections, but must
 * produce the same length); the chosen level and count are built once more with `final = true`.
 */
export function fitToBudget<T>(
  budgetTokens: number,
  count: number,
  build: (level: DetailLevel, count: number, final: boolean) => T,
  /** The richest level to try first (search excerpts start narrower than a single item). */
  from = 0,
): Fitted<T> {
  const limit = budgetTokens * CHARS_PER_TOKEN;
  const finish = (level: DetailLevel, n: number, trimmed: boolean): Fitted<T> => {
    const value = build(level, n, true);
    return { value, text: JSON.stringify(value), count: n, trimmed };
  };
  let length = Infinity;
  for (const [index, level] of DETAIL_LEVELS.entries()) {
    if (index < from) continue;
    length = JSON.stringify(build(level, count, false)).length;
    if (length <= limit) return finish(level, count, index > from);
  }
  const smallest = DETAIL_LEVELS[DETAIL_LEVELS.length - 1]!;
  let n = count;
  while (n > 0 && length > limit) {
    // Scale down by the overshoot, always by at least one item.
    n = Math.max(0, Math.min(n - 1, Math.floor((n * limit) / length)));
    length = JSON.stringify(build(smallest, n, false)).length;
  }
  return finish(smallest, n, true);
}
