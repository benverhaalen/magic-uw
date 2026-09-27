/**
 * @magic/retrieval: pure passage and quote code. Public signatures (other lanes code against these):
 *
 *   splitPassages(text: string, parts?: readonly SplitPart[], options?: SplitOptions): SplitPassage[]
 *     SplitPart    = { text; page?; slide?; section?; start?; end? }   (Resource.parts)
 *     SplitPassage = { ord; start; end; page?; slide?; heading?; tokEst }
 *     text.slice(start, end) is the passage body. Target ~1,000 chars, cap 1,600, never across a part.
 *   SPLITTER_VERSION, PASSAGE_TARGET_CHARS, PASSAGE_MAX_CHARS, estimateTokens(chars): number
 *
 *   validateQuote(source: {version, text}, claim: {version, quote, start?, end?}): QuoteCheck
 *     QuoteCheck = {ok: true, start, end, repaired, occurrences}
 *                | {ok: false, reason: "empty" | "missing" | "ambiguous" | "version_mismatch", occurrences}
 *   findQuote(text, quote): {status: "unique", start, end} | {status: "ambiguous", occurrences: Span[]} | {status: "missing"}
 *   findQuoteOccurrences(text, quote, limit?): Span[]
 *   spanMatches(text, {start, end}, quote): boolean
 *   normalizeQuote(quote): string   (whitespace runs → one space, trimmed; nothing else changes)
 *
 *   textHash(title: string, text: string): string   (sha256 hex; judgments keyed to text survive
 *     submission and grade changes)
 *   excerpt(text, start, end, max = 240): string   (≤ max chars cut from a passage by offsets)
 *
 *   Search helpers (T11b): queryTerms(query): {terms, content}; matchExpression(terms, mode): string;
 *     coverage(queryContent, matchedTerms): number; NOT_FOUND_COVERAGE; porterStem(word): string.
 */
import { createHash } from "node:crypto";

export * from "./split";
export * from "./quotes";
export * from "./search";
export * from "./porter";

/** sha256 over the title and text only, so a submission or score flip keeps the same hash. */
export function textHash(title: string, text: string): string {
  return createHash("sha256").update(title).update("\u0000").update(text).digest("hex");
}

/** A display excerpt of at most `max` characters, cut from the passage span on a word boundary. */
export function excerpt(text: string, start: number, end: number, max = 240): string {
  const body = text.slice(start, end).replace(/\s+/gu, " ").trim();
  if (body.length <= max) return body;
  const cut = body.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return (space > max / 2 ? cut.slice(0, space) : cut) + "…";
}
