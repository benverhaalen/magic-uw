/**
 * Passage splitter (T11a). Pure: text in, character offsets out. The stored passage row keeps
 * offsets only; its body is always `text.slice(start, end)` of the named resource version.
 *
 * Size (proposal §3.1, MF1): target ~1,000 characters (~250 tokens), never across a page,
 * slide or section part. A paragraph longer than the cap is cut at sentence ends, then at
 * whitespace, and only as a last resort mid-word.
 */
export const SPLITTER_VERSION = "split.v1";
export const PASSAGE_TARGET_CHARS = 1000;
export const PASSAGE_MAX_CHARS = 1600;
/** A trailing passage shorter than this is merged into the previous one when the cap allows. */
export const PASSAGE_MIN_CHARS = 200;

export interface SplitPart {
  text: string;
  page?: number;
  slide?: number;
  section?: string;
  start?: number;
  end?: number;
}

export interface SplitPassage {
  ord: number;
  start: number;
  end: number;
  page?: number;
  slide?: number;
  heading?: string;
  tokEst: number;
}

export interface SplitOptions {
  targetChars?: number;
  maxChars?: number;
}

interface Region {
  start: number;
  end: number;
  page?: number;
  slide?: number;
  section?: string;
}

const WHITESPACE = /\s/u;

/** ~4 characters per token for English prose; an estimate for budgets, never a bill. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/** Locate each part verbatim in the text, in order. Unlocatable parts end part-following. */
function regions(text: string, parts: readonly SplitPart[] | undefined): Region[] {
  if (!parts?.length) return [{ start: 0, end: text.length }];
  const out: Region[] = [];
  let cursor = 0;
  const plain = (start: number, end: number) => {
    if (end > start && /\S/u.test(text.slice(start, end)))
      out.push({ start, end });
  };
  for (const part of parts) {
    if (!part.text) continue;
    let at = -1;
    if (
      part.start !== undefined &&
      part.end !== undefined &&
      part.start >= cursor &&
      text.slice(part.start, part.end) === part.text
    )
      at = part.start;
    else at = text.indexOf(part.text, cursor);
    if (at < 0) break; // the text was bounded or differs: the rest is split as plain text
    plain(cursor, at);
    out.push({
      start: at,
      end: at + part.text.length,
      ...(part.page !== undefined ? { page: part.page } : {}),
      ...(part.slide !== undefined ? { slide: part.slide } : {}),
      ...(part.section !== undefined ? { section: part.section } : {}),
    });
    cursor = at + part.text.length;
  }
  plain(cursor, text.length);
  return out;
}

/** Offsets of paragraph blocks inside [start, end): runs separated by a blank line. */
function paragraphs(text: string, start: number, end: number): [number, number][] {
  const out: [number, number][] = [];
  const pattern = /\n[^\S\n]*\n\s*/gu;
  pattern.lastIndex = start;
  let from = start;
  for (;;) {
    const match = pattern.exec(text);
    if (!match || match.index >= end) break;
    out.push([from, match.index]);
    from = Math.min(end, match.index + match[0].length);
  }
  out.push([from, end]);
  return out.filter(([s, e]) => e > s);
}

/** Split an over-long block at sentence ends, then whitespace, then hard, each piece ≤ max. */
function cut(text: string, start: number, end: number, target: number, max: number): [number, number][] {
  const out: [number, number][] = [];
  let from = start;
  while (end - from > max) {
    const window = text.slice(from, from + max);
    let at = -1;
    const sentence = /[.!?;:]["')\]]?\s+/gu;
    for (let m = sentence.exec(window); m; m = sentence.exec(window))
      if (m.index + m[0].length >= Math.min(target, max) / 2)
        at = m.index + m[0].length;
    if (at <= 0) {
      for (let i = window.length - 1; i > window.length / 2; i--)
        if (WHITESPACE.test(window[i]!)) {
          at = i + 1;
          break;
        }
    }
    if (at <= 0) {
      at = max;
      const code = text.charCodeAt(from + at - 1);
      if (code >= 0xd800 && code <= 0xdbff) at--; // never split a surrogate pair
    }
    out.push([from, from + at]);
    from += at;
  }
  if (end > from) out.push([from, end]);
  return out;
}

function trim(text: string, start: number, end: number): [number, number] {
  while (start < end && WHITESPACE.test(text[start]!)) start++;
  while (end > start && WHITESPACE.test(text[end - 1]!)) end--;
  return [start, end];
}

const HEADING = /^(?:#{1,6}\s+(.{1,120})|([\p{Lu}\p{N}][^\n.,;!?]{0,79}))$/u;
/** A standalone short line without end punctuation, or a Markdown heading. */
function headingOf(text: string, start: number, end: number): string | undefined {
  if (end - start > 122) return undefined;
  const line = text.slice(start, end).trim();
  if (line.includes("\n")) return undefined;
  const match = HEADING.exec(line);
  return match ? (match[1] ?? match[2])!.trim() : undefined;
}

/**
 * Split `text` into passages with exact offsets. Every non-whitespace character of `text` lies in
 * exactly one passage; passages are ordered, disjoint and trimmed of surrounding whitespace.
 */
export function splitPassages(
  text: string,
  parts?: readonly SplitPart[],
  options: SplitOptions = {},
): SplitPassage[] {
  const max = Math.max(50, options.maxChars ?? PASSAGE_MAX_CHARS);
  const target = Math.min(max, Math.max(25, options.targetChars ?? PASSAGE_TARGET_CHARS));
  const min = Math.min(PASSAGE_MIN_CHARS, Math.floor(target / 4));
  const passages: SplitPassage[] = [];
  for (const region of regions(text, parts)) {
    let heading = region.section;
    const spans: { start: number; end: number; heading?: string }[] = [];
    let current: { start: number; end: number; heading?: string } | undefined;
    for (const [ps, pe] of paragraphs(text, region.start, region.end)) {
      const [s, e] = trim(text, ps, pe);
      if (e <= s) continue;
      const found = region.section ? undefined : headingOf(text, s, e);
      if (found) {
        // A heading starts a new passage and labels the ones that follow it.
        if (current) spans.push(current);
        current = undefined;
        heading = found;
      }
      for (const [cs, ce] of e - s > max ? cut(text, s, e, target, max) : [[s, e] as [number, number]]) {
        const [ts, te] = trim(text, cs, ce);
        if (te <= ts) continue;
        if (current && te - current.start <= target) current.end = te;
        else {
          if (current) spans.push(current);
          current = { start: ts, end: te, ...(heading ? { heading } : {}) };
        }
      }
    }
    if (current) spans.push(current);
    // Merge a short tail into its predecessor when the cap allows (never across regions).
    if (spans.length > 1) {
      const last = spans[spans.length - 1]!;
      const prev = spans[spans.length - 2]!;
      if (last.end - last.start < min && last.end - prev.start <= max) {
        prev.end = last.end;
        spans.pop();
      }
    }
    for (const span of spans)
      passages.push({
        ord: passages.length,
        start: span.start,
        end: span.end,
        ...(region.page !== undefined ? { page: region.page } : {}),
        ...(region.slide !== undefined ? { slide: region.slide } : {}),
        ...(span.heading ? { heading: span.heading } : {}),
        tokEst: estimateTokens(span.end - span.start),
      });
  }
  return passages;
}
