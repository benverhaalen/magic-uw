// The quote validator's interface (T11a, exported from @magic/retrieval).
// The learning engines take it as an injected function, so they don't depend on
// the retrieval package's internals and the caller wires the real one in.

export interface QuoteCheck {
  status: "unique" | "ambiguous" | "missing";
  start?: number;
  end?: number;
}

/** validateQuote(text, quote): an exact, unique match, or not (no fuzzy repair). */
export type ValidateQuote = (text: string, quote: string) => QuoteCheck;

export const QUOTE_MIN = 12;
export const QUOTE_MAX = 400;

/** A quote is usable when it's 12–400 characters and occurs exactly once. */
export function locateQuote(
  validate: ValidateQuote,
  text: string,
  quote: string | null | undefined,
): { start: number; end: number } | null {
  if (!quote || quote.length < QUOTE_MIN || quote.length > QUOTE_MAX) return null;
  const r = validate(text, quote);
  if (r.status !== "unique" || r.start === undefined || r.end === undefined) return null;
  return { start: r.start, end: r.end };
}

