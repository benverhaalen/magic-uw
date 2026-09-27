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
 * The richest `build(level, count)` whose JSON fits `budgetTokens`. `build` must be deterministic
 * in its inputs; it runs once per attempt (at most the level count plus a few item-count steps).
 */
export function fitToBudget<T>(
  budgetTokens: number,
  count: number,
  build: (level: DetailLevel, count: number) => T,
  /** The richest level to try first (search excerpts start narrower than a single item). */
  from = 0,
): Fitted<T> {
  const limit = budgetTokens * CHARS_PER_TOKEN;
  let value: T | undefined;
  let text = "";
  for (const [index, level] of DETAIL_LEVELS.entries()) {
    if (index < from) continue;
    value = build(level, count);
    text = JSON.stringify(value);
    if (text.length <= limit) return { value, text, count, trimmed: index > from };
  }
  const smallest = DETAIL_LEVELS[DETAIL_LEVELS.length - 1]!;
  let n = count;
  while (n > 0 && text.length > limit) {
    // Scale down by the overshoot, always by at least one item.
    n = Math.max(0, Math.min(n - 1, Math.floor((n * limit) / text.length)));
    value = build(smallest, n);
    text = JSON.stringify(value);
  }
  return { value: value!, text, count: n, trimmed: true };
}
