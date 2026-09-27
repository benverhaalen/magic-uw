/**
 * Text helpers shared by the gold crawler and the scorer. Written for the bench, independent of the
 * product's canvas-content.ts, so the gold does not inherit our parsing.
 */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Plain text of an HTML fragment: tags dropped, block ends become newlines, entities decoded. */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|table|ul|ol|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
      if (name[0] === "#") {
        const code = name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[name.toLowerCase()] ?? whole;
    })
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Every href in an HTML fragment, resolved against `base`. */
export function htmlLinks(html: string | null | undefined, base: string): string[] {
  if (!html) return [];
  const out: string[] = [];
  for (const match of html.matchAll(/\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const raw = (match[2] ?? match[3] ?? match[4] ?? "").replace(/&amp;/g, "&");
    try {
      out.push(new URL(raw, base).href);
    } catch {}
  }
  return out;
}

/** Lower-case word tokens (letters and digits, Unicode-aware). */
export function tokens(value: string | null | undefined): string[] {
  return (value ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Token-multiset F1 between a candidate text and the reference: 1 for the same words in any
 * layout, 0 for nothing in common. Robust to whitespace, line breaks and PDF layout differences.
 */
export function textF1(candidate: string | null | undefined, reference: string | null | undefined): number {
  const a = tokens(candidate), b = tokens(reference);
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const counts = new Map<string, number>();
  for (const t of b) counts.set(t, (counts.get(t) ?? 0) + 1);
  let overlap = 0;
  for (const t of a) {
    const left = counts.get(t) ?? 0;
    if (left > 0) {
      overlap++;
      counts.set(t, left - 1);
    }
  }
  if (!overlap) return 0;
  const precision = overlap / a.length, recall = overlap / b.length;
  return (2 * precision * recall) / (precision + recall);
}

/** Case- and whitespace-insensitive name comparison. */
export function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  const n = (v: string | null | undefined) => (v ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  return n(a) === n(b) && n(a) !== "";
}

/** The same instant, to the second, or both absent. Unparseable is never equal. */
export function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const x = Date.parse(a), y = Date.parse(b);
  return Number.isFinite(x) && Number.isFinite(y) && Math.floor(x / 1000) === Math.floor(y / 1000);
}

export function sameNumber(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  return Math.abs(a - b) < 1e-6;
}

/** A stable 32-bit hash for deterministic sampling. */
export function hash32(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A seeded PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
