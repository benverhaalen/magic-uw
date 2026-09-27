// N12: guide artifact schemas and validation (NB-8). Per course-backend §L,
// this task is schemas and validation only; band emphasis is applied at render
// time (T43). Every entry needs a quote-valid citation or it's dropped and
// counted; a timeline entry's date must parse and occur in its quote.
import { z } from "zod";
import type { Citation } from "./types";
import { locateQuote, type ValidateQuote } from "./quote-port";

const text = z.string().trim().min(1).max(4000);
const citationRef = z.object({ resourceId: z.string().min(1), quote: z.string().min(1).max(1000) }).strict();
const cites = z.array(citationRef).max(8);

export const artifactSchemas = {
  study_guide: z
    .object({
      title: text,
      sections: z
        .array(
          z
            .object({
              heading: text,
              conceptIds: z.array(z.string()).max(20).optional(),
              points: z.array(z.object({ text, citations: cites }).strict()).max(40),
            })
            .strict(),
        )
        .max(40),
    })
    .strict(),
  briefing: z.object({ items: z.array(z.object({ text, citations: cites }).strict()).max(20) }).strict(),
  faq: z.object({ items: z.array(z.object({ question: text, answer: text, citations: cites }).strict()).max(40) }).strict(),
  glossary: z.object({ terms: z.array(z.object({ term: text, definition: text, citations: cites }).strict()).max(200) }).strict(),
  timeline: z.object({ entries: z.array(z.object({ date: z.string().min(1).max(60), label: text, citations: cites }).strict()).max(100) }).strict(),
} as const;

export type GuideKind = keyof typeof artifactSchemas;
export type GuideBody<K extends GuideKind> = z.infer<(typeof artifactSchemas)[K]>;

export interface ArtifactResource {
  id: string;
  version: number;
  contentHash: string;
  text: string;
}

export interface AcceptedArtifact<K extends GuideKind> {
  kind: K;
  body: GuideBody<K>;
  citations: Citation[];
  removed: number;
  /** Why each removed entry was dropped. */
  reasons: string[];
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** Parse an explicit date string: ISO (2026-10-08), "October 8[, 2026]", "Oct 8", or "10/8[/2026]". No guessing beyond that. */
export function parseDate(s: string): { year: number | null; month: number; day: number } | null {
  const t = s.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) return check(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/.exec(t);
  if (m) {
    const mi = MONTHS.findIndex((name) => name.startsWith(m![1]!.toLowerCase()) && m![1]!.length >= 3);
    if (mi < 0) return null;
    return check(m[3] ? Number(m[3]) : null, mi + 1, Number(m[2]));
  }
  m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/.exec(t);
  if (m) return check(m[3] ? Number(m[3]) : null, Number(m[1]), Number(m[2]));
  return null;
}

function check(year: number | null, month: number, day: number) {
  if (month < 1 || month > 12 || day < 1) return null;
  const max = new Date(Date.UTC(year ?? 2024, month, 0)).getUTCDate(); // 2024: leap year when no year is given
  return day > max ? null : { year, month, day };
}

/**
 * Validate a generated guide artifact: the schema first (a malformed body
 * throws), then each entry's citations through the quote validator. Entries with
 * no valid citation are dropped and counted (NB-8).
 */
export function acceptArtifact<K extends GuideKind>(
  kind: K,
  raw: unknown,
  ctx: { resources: ArtifactResource[]; validate: ValidateQuote },
): AcceptedArtifact<K> {
  const body = artifactSchemas[kind].parse(raw) as GuideBody<K>;
  const byId = new Map(ctx.resources.map((r) => [r.id, r]));
  const citations: Citation[] = [];
  const reasons: string[] = [];
  let removed = 0;

  /** The valid citations of an entry (none means the entry goes). */
  const validCites = (refs: { resourceId: string; quote: string }[]) =>
    refs.flatMap((ref) => {
      const r = byId.get(ref.resourceId);
      const at = r ? locateQuote(ctx.validate, r.text, ref.quote) : null;
      return r && at ? [{ ref, r, at }] : [];
    });

  const keep = <E extends { citations: { resourceId: string; quote: string }[] }>(
    entries: E[],
    label: (e: E) => string,
    extra?: (e: E, valid: { resourceId: string; quote: string }[]) => string | null,
  ): E[] =>
    entries.flatMap((e) => {
      const ok = validCites(e.citations);
      const problem = ok.length ? (extra?.(e, ok.map((x) => x.ref)) ?? null) : "no quote found in source";
      if (problem) {
        removed++;
        reasons.push(`${label(e)}: ${problem}`);
        return [];
      }
      for (const { ref, r, at } of ok) {
        citations.push({
          id: `cit-${citations.length + 1}`,
          resourceId: r.id,
          version: r.version,
          contentHash: r.contentHash,
          start: at.start,
          end: at.end,
          quote: ref.quote,
          quoteValid: true,
          support: "not_checked",
        });
      }
      return [{ ...e, citations: ok.map((x) => x.ref) }];
    });

  const b = body as Record<string, unknown>;
  switch (kind) {
    case "study_guide": {
      const g = body as GuideBody<"study_guide">;
      b.sections = g.sections
        .map((s) => ({ ...s, points: keep(s.points, (p) => p.text.slice(0, 60)) }))
        .filter((s) => s.points.length > 0);
      break;
    }
    case "briefing":
      b.items = keep((body as GuideBody<"briefing">).items, (e) => e.text.slice(0, 60));
      break;
    case "faq":
      b.items = keep((body as GuideBody<"faq">).items, (e) => e.question.slice(0, 60));
      break;
    case "glossary":
      b.terms = keep((body as GuideBody<"glossary">).terms, (e) => e.term);
      break;
    case "timeline":
      b.entries = keep(
        (body as GuideBody<"timeline">).entries,
        (e) => e.date,
        (e, valid) => {
          if (!parseDate(e.date)) return "the date doesn't parse";
          if (!valid.some((c) => c.quote.includes(e.date))) return "the date isn't in its quote";
          return null;
        },
      );
      break;
  }
  return { kind, body, citations, removed, reasons };
}
