/**
 * Code decides what the model wrote is kept. Every block's quote must appear verbatim in the
 * passage it cites; a worked example is recomputed; a timeline date must parse and match a
 * canonical or quoted date; a concept-map edge needs a quote or a reason code derives. Dropped
 * blocks are reported with their reason. Deterministic over (output, input, passages), so the
 * view re-runs it on the cached artifact at 0 tokens.
 */
import type { CheckContext, PackCheck, Passage } from "../../core/src/index";
import { evaluate, sameQuantity } from "../../../learning/src/arith";
import { normaliseLabel } from "../../../learning/src/concepts";
import {
  BLOCKS_FOR,
  type ConceptMapOutput,
  type EdgeKind,
  type GuideBlockOutput,
  type GuideInput,
  type GuideKind,
  type GuideOutput,
} from "./schema";

export type DropCode = "quote" | "kind" | "shape" | "arithmetic" | "date" | "edge" | "node";
export interface GuideDrop {
  at: string;
  code: DropCode;
  reason: string;
}
/** A quote grounded in a passage and, when code can place it, the exact span in its resource. */
export interface Grounded {
  sourceId: string;
  quote: string;
  resourceId: string | null;
  start: number | null;
  end: number | null;
}
export type Resolve = (sourceId: string, quote: string) => { resourceId: string; start: number; end: number; quote: string } | null;

export interface GuideBlock extends Omit<GuideBlockOutput, "sourceId" | "quote"> {
  id: string;
  source: Grounded;
  /** example: the value code computed from the expression. */
  computed: string | null;
}
export interface GuideSection {
  id: string;
  title: string;
  topics: string[];
  columns: string[] | null;
  blocks: GuideBlock[];
}
export interface GuideDoc {
  kind: Exclude<GuideKind, "conceptmap">;
  title: string;
  sections: GuideSection[];
}
export interface MapNode {
  id: string;
  label: string;
  source: Grounded | null;
  reason: string | null;
}
export interface MapEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  source: Grounded | null;
  reason: string | null;
}
export interface ConceptMapDoc {
  kind: "conceptmap";
  title: string;
  nodes: MapNode[];
  edges: MapEdge[];
}
export interface ReviewStats {
  generated: number;
  accepted: number;
  quoteChecks: { passed: number; total: number };
  arithmetic: { checked: number; mismatches: number };
  dates: { checked: number; mismatches: number };
}
export interface Review<D> {
  doc: D;
  drops: GuideDrop[];
  stats: ReviewStats;
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();
export const MIN_QUOTE = 12;

function grounder(passages: Passage[], resolve?: Resolve) {
  const bySource = new Map(passages.map((p) => [p.sourceId, collapse(p.text)]));
  return (sourceId: string | null, quote: string | null): Grounded | string => {
    if (!sourceId) return "no source cited";
    const text = bySource.get(sourceId);
    if (text === undefined) return `quote cites ${sourceId}, which is not among the passages`;
    const q = collapse(quote ?? "");
    if (q.length < MIN_QUOTE) return `quote in ${sourceId} is shorter than ${MIN_QUOTE} characters`;
    if (!text.includes(q)) return `quote not found verbatim in ${sourceId}: "${q.slice(0, 80)}"`;
    const span = resolve?.(sourceId, quote ?? "");
    return span
      ? { sourceId, quote: span.quote, resourceId: span.resourceId, start: span.start, end: span.end }
      : { sourceId, quote: q, resourceId: null, start: null, end: null };
  };
}

// ---------- Worked examples ----------
const cleanNumber = (s: string) =>
  s
    .replace(/(\d),(?=\d{3}(?!\d))/g, "$1")
    .replace(/^[\s=≈~]+/, "")
    .trim();
/** Code recomputes a worked example; a mismatch or a non-arithmetic expression drops it. */
export function recompute(expression: string, result: string): { ok: true; computed: string } | { ok: false; reason: string } {
  let got, want;
  try {
    got = evaluate(cleanNumber(expression));
  } catch (e) {
    return { ok: false, reason: `the expression doesn't evaluate: ${(e as Error).message}` };
  }
  const computed = `${Number(got.value.toPrecision(12))}${got.unit ? ` ${got.unit}` : ""}`;
  try {
    want = evaluate(cleanNumber(result));
  } catch {
    return { ok: false, reason: `the result "${result.slice(0, 40)}" isn't a number` };
  }
  if (got.unit && want.unit && got.unit !== want.unit)
    return { ok: false, reason: `the expression gives ${computed}, not ${result.slice(0, 40)}` };
  const decimals = /\.(\d+)/.exec(cleanNumber(result))?.[1]?.length ?? 0;
  const close =
    sameQuantity({ value: got.value, unit: null }, { value: want.value, unit: null }) ||
    Math.abs(got.value - want.value) <= 0.5 * 10 ** -decimals + 1e-12;
  return close ? { ok: true, computed } : { ok: false, reason: `the expression gives ${computed}, not ${result.slice(0, 40)}` };
}

// ---------- Dates ----------
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number) => String(n).padStart(2, "0");
function validDay(y: number | null, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const days = new Date(Date.UTC(y ?? 2024, m, 0)).getUTCDate();
  return d <= days;
}
/** A timeline date must be a real calendar date written YYYY-MM-DD. */
export function parseIsoDate(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  return validDay(Number(m[1]), Number(m[2]), Number(m[3])) ? m[0] : null;
}
/** Dates written in a quote: YYYY-MM-DD, "October 14, 2026", "Oct. 14", "14 Oct 2026", "10/14/2026", "10/14". "--MM-DD" when the year isn't written. */
export function datesIn(text: string): string[] {
  const out = new Set<string>();
  const add = (y: number | null, m: number, d: number) => {
    if (validDay(y, m, d)) out.add(`${y === null ? "-" : y}-${pad(m)}-${pad(d)}`);
  };
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) add(Number(m[1]), Number(m[2]), Number(m[3]));
  const month = "(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
  for (const m of text.matchAll(new RegExp(`\\b${month}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`, "gi")))
    add(m[3] ? Number(m[3]) : null, MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase()) + 1, Number(m[2]));
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${month}(?:,?\\s+(\\d{4}))?`, "gi")))
    add(m[3] ? Number(m[3]) : null, MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase()) + 1, Number(m[1]));
  for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b/g))
    add(m[3] ? Number(m[3]) : null, Number(m[1]), Number(m[2]));
  return [...out];
}
function dateMatches(date: string, canonical: string[], quote: string): boolean {
  if (canonical.includes(date)) return true;
  return datesIn(quote).some((q) => q === date || (q.startsWith("--") && q.slice(2) === date.slice(5)));
}

// ---------- Guides ----------
function blockProblem(kind: GuideDoc["kind"], b: GuideBlockOutput, columns: string[] | null): { code: DropCode; reason: string } | null {
  if (!BLOCKS_FOR[kind].includes(b.kind)) return { code: "kind", reason: `a ${b.kind} block doesn't belong in a ${kind}` };
  if ((b.kind === "definition" || b.kind === "question" || b.kind === "row") && !b.heading?.trim())
    return { code: "shape", reason: `a ${b.kind} block needs its heading` };
  if (b.kind === "row" && (!columns || columns.length < 2 || b.cells?.length !== columns.length))
    return { code: "shape", reason: `a comparison row needs one cell per column (${columns?.length ?? 0})` };
  if (b.kind === "example" && !!b.expression?.trim() !== !!b.result?.trim())
    return { code: "shape", reason: "a worked example needs both its expression and its result" };
  if (b.kind === "event" && !b.date) return { code: "date", reason: "a timeline event needs its date" };
  return null;
}

export function reviewGuide(kind: GuideDoc["kind"], output: GuideOutput, input: GuideInput, passages: Passage[], resolve?: Resolve): Review<GuideDoc> {
  const ground = grounder(passages, resolve);
  const drops: GuideDrop[] = [];
  const stats: ReviewStats = { generated: 0, accepted: 0, quoteChecks: { passed: 0, total: 0 }, arithmetic: { checked: 0, mismatches: 0 }, dates: { checked: 0, mismatches: 0 } };
  const sections: GuideSection[] = [];
  output.sections.forEach((s, si) => {
    const blocks: GuideBlock[] = [];
    s.blocks.forEach((b, bi) => {
      stats.generated++;
      const at = `section ${si + 1} block ${bi + 1}`;
      const problem = blockProblem(kind, b, s.columns);
      if (problem) return void drops.push({ at, ...problem });
      stats.quoteChecks.total++;
      const g = ground(b.sourceId, b.quote);
      if (typeof g === "string") return void drops.push({ at, code: "quote", reason: g });
      stats.quoteChecks.passed++;
      let computed: string | null = null;
      if (b.kind === "example" && b.expression?.trim()) {
        stats.arithmetic.checked++;
        const r = recompute(b.expression, b.result!);
        if (!r.ok) {
          stats.arithmetic.mismatches++;
          return void drops.push({ at, code: "arithmetic", reason: r.reason });
        }
        computed = r.computed;
      }
      if (b.kind === "event") {
        stats.dates.checked++;
        const date = parseIsoDate(b.date!);
        if (!date || !dateMatches(date, input.dates, g.quote)) {
          stats.dates.mismatches++;
          return void drops.push({ at, code: "date", reason: date ? `${date} matches no course date and isn't in the quote` : `"${b.date}" isn't a YYYY-MM-DD date` });
        }
      }
      const { sourceId: _s, quote: _q, ...rest } = b;
      blocks.push({ ...rest, id: `s${si}b${bi}`, source: g, computed });
    });
    if (kind === "timeline") blocks.sort((a, b) => (a.date! < b.date! ? -1 : a.date! > b.date! ? 1 : 0));
    if (blocks.length) sections.push({ id: `s${si}`, title: s.title, topics: s.topics, columns: s.columns, blocks });
  });
  stats.accepted = sections.reduce((n, s) => n + s.blocks.length, 0);
  return { doc: { kind, title: output.title, sections }, drops, stats };
}

// ---------- Concept map ----------
/** `input.topics` entries of the form "child > parent" are the course map's hierarchy (conceptmap only). */
export function hierarchyOf(input: GuideInput): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of input.topics) {
    const [child, parent] = t.split(" > ");
    if (child && parent) out.set(normaliseLabel(child), normaliseLabel(parent));
  }
  return out;
}
export const topicName = (t: string) => t.split(" > ")[0]!;

export function reviewConceptMap(output: ConceptMapOutput, input: GuideInput, passages: Passage[], resolve?: Resolve): Review<ConceptMapDoc> {
  const ground = grounder(passages, resolve);
  const drops: GuideDrop[] = [];
  const stats: ReviewStats = { generated: 0, accepted: 0, quoteChecks: { passed: 0, total: 0 }, arithmetic: { checked: 0, mismatches: 0 }, dates: { checked: 0, mismatches: 0 } };
  const known = new Set(input.topics.map((t) => normaliseLabel(topicName(t))));
  const parents = hierarchyOf(input);
  const nodes: MapNode[] = [];
  output.nodes.forEach((n, i) => {
    stats.generated++;
    const at = `node ${i + 1}`;
    if (nodes.some((x) => x.id === n.id)) return void drops.push({ at, code: "node", reason: `node id ${n.id} is repeated` });
    let source: Grounded | null = null;
    if (n.quote?.trim()) {
      stats.quoteChecks.total++;
      const g = ground(n.sourceId, n.quote);
      if (typeof g !== "string") {
        stats.quoteChecks.passed++;
        source = g;
      } else if (!known.has(normaliseLabel(n.label))) return void drops.push({ at, code: "quote", reason: g });
    }
    const reason = source ? null : known.has(normaliseLabel(n.label)) ? "a topic on the course map" : null;
    if (!source && !reason) return void drops.push({ at, code: "node", reason: `"${n.label}" has no quote and isn't a course topic` });
    nodes.push({ id: n.id, label: n.label, source, reason });
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges: MapEdge[] = [];
  output.edges.forEach((e, i) => {
    stats.generated++;
    const at = `edge ${i + 1}`;
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from || !to || e.from === e.to) return void drops.push({ at, code: "edge", reason: `edge ${e.from} → ${e.to} doesn't join two kept nodes` });
    if (edges.some((x) => x.from === e.from && x.to === e.to && x.kind === e.kind)) return void drops.push({ at, code: "edge", reason: "a repeated edge" });
    let source: Grounded | null = null;
    let failed: string | null = null;
    if (e.quote?.trim()) {
      stats.quoteChecks.total++;
      const g = ground(e.sourceId, e.quote);
      if (typeof g === "string") failed = g;
      else {
        stats.quoteChecks.passed++;
        source = g;
      }
    }
    const reason =
      !source && e.kind === "part_of" && parents.get(normaliseLabel(from.label)) === normaliseLabel(to.label)
        ? `the course map places ${from.label} under ${to.label}`
        : null;
    if (!source && !reason) return void drops.push({ at, code: failed ? "quote" : "edge", reason: failed ?? "no quote and no reason code can derive" });
    edges.push({ from: e.from, to: e.to, kind: e.kind, source, reason });
  });
  stats.accepted = nodes.length + edges.length;
  return { doc: { kind: "conceptmap", title: output.title, nodes, edges }, drops, stats };
}

export function reviewAny(kind: GuideKind, output: unknown, input: GuideInput, passages: Passage[], resolve?: Resolve): Review<GuideDoc | ConceptMapDoc> {
  return kind === "conceptmap"
    ? reviewConceptMap(output as ConceptMapOutput, input, passages, resolve)
    : reviewGuide(kind, output as GuideOutput, input, passages, resolve);
}

/**
 * The pack-level check the runner acts on (retry with these errors, escalate once, then
 * needs_student). Retried only when fewer than half the blocks survive; otherwise the bad ones
 * are dropped one by one with their reasons.
 */
export function guideCheck<O>(kind: GuideKind): PackCheck<GuideInput, O> {
  return (output, input, context: CheckContext) => {
    const r = reviewAny(kind, output, input, context.passages);
    if (!r.stats.generated) return ["nothing was returned"];
    if (r.stats.accepted >= Math.ceil(r.stats.generated / 2)) return [];
    return r.drops.slice(0, 20).map((d) => `${d.at}: ${d.reason}`);
  };
}
