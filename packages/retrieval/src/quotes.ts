/**
 * Exact-quote validator (T11a). Code decides whether a model's quote is in the source.
 *
 * Matching rule (the only normalization): every run of whitespace, in the source and in the
 * quote, compares equal to one space, and the quote's leading and trailing whitespace is
 * ignored. Case, punctuation, quotation marks, dashes, digits and diacritics must match
 * exactly, so a paraphrase or a "cleaned up" quote is rejected. Offsets are UTF-16 indexes
 * into the original, unnormalized text (the same unit as `String.prototype.slice`).
 *
 * Anchoring (docs/course-intelligence.md): proposed offsets that land exactly on an occurrence
 * are kept; otherwise offsets are repaired only when the quote occurs once. A repeated quote
 * without correct offsets is ambiguous and rejected, never resolved to the first occurrence.
 */

export interface Span {
  start: number;
  end: number;
}

export type QuoteMatch =
  | { status: "unique"; start: number; end: number }
  | { status: "ambiguous"; occurrences: Span[] }
  | { status: "missing" };

export type QuoteCheck =
  | { ok: true; start: number; end: number; repaired: boolean; occurrences: number }
  | {
      ok: false;
      reason: "empty" | "missing" | "ambiguous" | "version_mismatch";
      occurrences: number;
    };

/** A source text named by version; a quote validates only against the version it names. */
export interface QuoteSource {
  version: number;
  text: string;
}

export interface QuoteClaim {
  version: number;
  quote: string;
  start?: number;
  end?: number;
}

const WS = /\s/u;
const MAX_OCCURRENCES = 50;

interface Normalized {
  text: string;
  /** Original index of each normalized code unit. */
  starts: Int32Array;
}

function normalize(text: string): Normalized {
  const starts = new Int32Array(text.length);
  let out = "";
  let n = 0;
  let inSpace = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (WS.test(ch)) {
      if (!inSpace) {
        out += " ";
        starts[n++] = i;
        inSpace = true;
      }
    } else {
      out += ch;
      starts[n++] = i;
      inSpace = false;
    }
  }
  return { text: out, starts: starts.subarray(0, n) };
}

/** The quote in normalized form: whitespace runs collapsed, ends trimmed. */
export function normalizeQuote(quote: string): string {
  return quote.replace(/\s+/gu, " ").trim();
}

/** Every occurrence of `quote` in `text` under the whitespace rule, up to a cap. */
export function findQuoteOccurrences(text: string, quote: string, limit = MAX_OCCURRENCES): Span[] {
  const needle = normalizeQuote(quote);
  if (!needle) return [];
  const hay = normalize(text);
  const out: Span[] = [];
  for (let at = hay.text.indexOf(needle); at >= 0 && out.length < limit; at = hay.text.indexOf(needle, at + 1)) {
    const last = at + needle.length - 1;
    // The needle never ends in whitespace, so its last unit maps to one original code unit.
    out.push({ start: hay.starts[at]!, end: hay.starts[last]! + 1 });
  }
  return out;
}

/** Locate a quote: unique, ambiguous (≥2 occurrences) or missing. */
export function findQuote(text: string, quote: string): QuoteMatch {
  const found = findQuoteOccurrences(text, quote);
  if (!found.length) return { status: "missing" };
  if (found.length > 1) return { status: "ambiguous", occurrences: found };
  return { status: "unique", start: found[0]!.start, end: found[0]!.end };
}

/**
 * Validate a claimed quote against the named version of a source text. Returns the offsets in
 * that version's text. Fails on a different version, a quote not present verbatim, or a repeated
 * quote whose proposed offsets don't select one occurrence exactly.
 */
export function validateQuote(source: QuoteSource, claim: QuoteClaim): QuoteCheck {
  if (!normalizeQuote(claim.quote)) return { ok: false, reason: "empty", occurrences: 0 };
  if (claim.version !== source.version)
    return { ok: false, reason: "version_mismatch", occurrences: 0 };
  const found = findQuoteOccurrences(source.text, claim.quote);
  if (!found.length) return { ok: false, reason: "missing", occurrences: 0 };
  const exact =
    claim.start !== undefined && claim.end !== undefined
      ? found.find((s) => s.start === claim.start && s.end === claim.end)
      : undefined;
  if (exact)
    return { ok: true, start: exact.start, end: exact.end, repaired: false, occurrences: found.length };
  if (found.length > 1) return { ok: false, reason: "ambiguous", occurrences: found.length };
  return {
    ok: true,
    start: found[0]!.start,
    end: found[0]!.end,
    repaired: claim.start !== undefined || claim.end !== undefined,
    occurrences: 1,
  };
}

/** True when `text.slice(start, end)` equals the quote under the whitespace rule. */
export function spanMatches(text: string, span: Span, quote: string): boolean {
  if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end)) return false;
  if (span.start < 0 || span.end > text.length || span.end <= span.start) return false;
  const needle = normalizeQuote(quote);
  return !!needle && normalizeQuote(text.slice(span.start, span.end)) === needle;
}
