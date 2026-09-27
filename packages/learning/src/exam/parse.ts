/**
 * Reading an instructor's exam document by code (owner: exam-prep): section headings, numbered
 * questions, their options, points, format and cognitive level, the stated length and total
 * points. Every value keeps the offsets of the text it came from. Nothing is inferred beyond
 * what a rule matched: a question whose wording names no format falls back to short answer
 * and says so; a question with no level verb gets no level.
 */
import type { CognitiveLevel, ExamFormat } from "./types";

export interface Span {
  start: number;
  end: number;
}

export interface ParsedOption {
  id: string;
  text: string;
}

export interface ParsedQuestion {
  number: number;
  start: number;
  end: number;
  /** The question text before its options (the stem), trimmed; offsets in `stemSpan`. */
  stem: string;
  stemSpan: Span;
  options: ParsedOption[];
  format: ExamFormat;
  /** The words that set the format; null when it fell back to short answer. */
  formatSpan: Span | null;
  level: CognitiveLevel | null;
  levelSpan: Span | null;
  points: number | null;
  pointsSpan: Span | null;
  sectionIndex: number | null;
  /** The question contains code lines (for tracing and Parsons). */
  hasCode: boolean;
}

export interface ParsedSection {
  label: string;
  span: Span;
  points: number | null;
  /** A format the heading itself names ("Part A: Multiple choice"). */
  format: ExamFormat | null;
  formatSpan: Span | null;
}

export interface ParsedExam {
  sections: ParsedSection[];
  questions: ParsedQuestion[];
  minutes: { value: number; span: Span } | null;
  totalPoints: { value: number; span: Span } | null;
}

const HEADING =
  /^[ \t]*((?:part|section)\s+(?:[A-Z]|\d{1,2}|[IVX]{1,4})\b[^\n]{0,100}|(?:multiple[- ]choice|true\s*(?:\/|or)\s*false|short[- ]answers?|free[- ]response|long[- ]answers?|essays?|proofs?|problems?|programming|coding|calculations?|computations?|code tracing|derivations?)(?:\s+(?:questions?|problems?|section))?(?:[ \t]*[:(\[][^\n]{0,60})?)[ \t]*$/gim;
const QUESTION = /^[ \t]*(?:(?:q(?:uestion)?|problem|exercise)\s*#?\s*(\d{1,2})\s*[.:)]?|(\d{1,2})\s*[.)])[ \t]+(?=\S)/gim;
const OPTION = /^[ \t]*\(?([a-eA-E])[.)][ \t]+(\S[^\n]*)$/gm;
const POINTS = /[([]\s*(\d{1,3}(?:\.\d)?)\s*(?:points?|pts?\.?|marks?)\s*[)\]]|\b(\d{1,3})\s*(?:points?|pts)\b/i;
const MINUTES = /\b(\d{1,3})[ \t-]*(?:minutes?|mins?)\b|\b(\d(?:\.\d)?)[ \t-]*(?:hours?|hrs?)\b/i;
const TOTAL = /\b(?:total(?:\s+of)?|out of|worth)\s*:?\s*(\d{2,3})\s*(?:points?|pts)\b|\b(\d{2,3})\s*(?:points?|pts)\s+(?:total|in total|possible)\b/i;
const CODE_LINE = /;\s*$|[{}]\s*$|^\s*(?:def|return|for\s*\(|for\s+\w+\s+in\b|while\s*[( ]|if\s*\(|else\b|int\s+\w|public\s|private\s|void\s|import\s|print\(|printf|System\.out|console\.log)/m;

/** Format rules in priority order; each names the words that decide it. */
const FORMAT_RULES: [ExamFormat, RegExp][] = [
  ["true_false", /\btrue\s*(?:or|\/)\s*false\b|\bT\s*\/\s*F\b/i],
  ["proof", /\b(?:prove|show that|give a proof|proof)\b/i],
  ["code_tracing", /\b(?:what (?:is|does|will)\b[^?\n]{0,60}\b(?:print|output|return|display)\w*|trace (?:the|this)|output of)\b/i],
  ["code_writing", /\b(?:write|implement|complete)\b[^.\n]{0,40}\b(?:function|method|program|class|code|loop|recursive)\b/i],
  ["diagram", /\b(?:draw|sketch|label|diagram|graph the|plot)\b/i],
  ["symbolic", /\b(?:simplify|factor|expand|differentiate|derivative|integrate|integral|solve for|derive an expression|find an expression)\b/i],
  ["numeric", /\b(?:compute|calculate|how (?:many|much|long|far|fast)|what is the (?:value|magnitude|probability|speed|mass|energy|force|rate)|determine the|find the|estimate)\b/i],
  ["essay", /\b(?:essay|discuss|in (?:a|one) paragraph|argue)\b/i],
  ["short_answer", /\b(?:explain|describe|why|define|compare|contrast|what is|list|name|identify|state)\b/i],
];

/** Bloom's levels by verb (the highest level a question asks for wins). */
const LEVEL_RULES: [CognitiveLevel, RegExp][] = [
  ["create", /\b(?:design|construct|create|propose|develop|formulate|compose|write a (?:program|function|method|class))\b/i],
  ["evaluate", /\b(?:justify|critique|assess|argue|defend|judge|prove|evaluate whether|which is better)\b/i],
  ["analyse", /\b(?:analy[sz]e|compare|contrast|derive|trace|differentiate between|distinguish|examine)\b/i],
  ["apply", /\b(?:compute|calculate|solve|apply|use|implement|determine|find|evaluate the|simplify|factor|expand|differentiate|integrate)\b/i],
  ["understand", /\b(?:explain|describe|summari[sz]e|interpret|classify|paraphrase|give an example|illustrate|why)\b/i],
  ["remember", /\b(?:define|list|name|state|identify|recall|label|true\s*(?:or|\/)\s*false)\b/i],
];

export const LEVEL_ORDER: CognitiveLevel[] = ["remember", "understand", "apply", "analyse", "evaluate", "create"];

function formatOf(text: string, options: number, hasCode: boolean, base: number): { format: ExamFormat; span: Span | null } {
  if (options >= 3) return { format: "multiple_choice", span: null };
  for (const [format, re] of FORMAT_RULES) {
    if (format === "code_tracing" && !hasCode) continue;
    const m = re.exec(text);
    if (m) return { format, span: { start: base + m.index, end: base + m.index + m[0].length } };
  }
  return { format: "short_answer", span: null };
}

function levelOf(text: string, base: number): { level: CognitiveLevel | null; span: Span | null } {
  for (const [level, re] of LEVEL_RULES) {
    const m = re.exec(text);
    if (m) return { level, span: { start: base + m.index, end: base + m.index + m[0].length } };
  }
  return { level: null, span: null };
}

/** A format a section heading names. */
export function headingFormat(label: string): ExamFormat | null {
  const l = label.toLowerCase();
  if (/multiple[- ]choice/.test(l)) return "multiple_choice";
  if (/true\s*(?:\/|or)\s*false/.test(l)) return "true_false";
  if (/short[- ]answer|free[- ]response/.test(l)) return "short_answer";
  if (/long[- ]answer|essay/.test(l)) return "essay";
  if (/proof/.test(l)) return "proof";
  if (/code tracing|tracing/.test(l)) return "code_tracing";
  if (/programming|coding/.test(l)) return "code_writing";
  if (/derivation/.test(l)) return "symbolic";
  if (/calculation|computation|numerical/.test(l)) return "numeric";
  return null;
}

/** Formats a stated description names ("75 minutes; multiple choice and short answer"). */
export function statedFormats(text: string): { format: ExamFormat; span: Span }[] {
  const out: { format: ExamFormat; span: Span }[] = [];
  const rules: [ExamFormat, RegExp][] = [
    ["multiple_choice", /multiple[- ]choice/gi],
    ["true_false", /true\s*(?:\/|or)\s*false/gi],
    ["short_answer", /short[- ]answers?|free[- ]response/gi],
    ["essay", /\bessays?\b|long[- ]answers?/gi],
    ["proof", /\bproofs?\b/gi],
    ["numeric", /\b(?:calculations?|computations?|numerical problems?|problem[- ]solving)\b/gi],
    ["code_writing", /\b(?:programming|coding|write code)\b/gi],
    ["code_tracing", /\bcode tracing\b/gi],
    ["symbolic", /\bderivations?\b/gi],
  ];
  for (const [format, re] of rules)
    for (const m of text.matchAll(re)) {
      if (out.some((o) => o.format === format)) break;
      out.push({ format, span: { start: m.index, end: m.index + m[0].length } });
    }
  return out.sort((a, b) => a.span.start - b.span.start);
}

export function statedMinutes(text: string): { value: number; span: Span } | null {
  const m = MINUTES.exec(text);
  if (!m) return null;
  const value = m[1] ? Number(m[1]) : Math.round(Number(m[2]) * 60);
  return value >= 5 && value <= 600 ? { value, span: { start: m.index, end: m.index + m[0].length } } : null;
}

/** Parse an exam-like document. */
export function parseExam(text: string): ParsedExam {
  const sections: ParsedSection[] = [];
  for (const m of text.matchAll(HEADING)) {
    const raw = m[1]!;
    const lead = m[0].indexOf(raw);
    const label = raw.trim();
    if (label.length > 110) continue;
    const start = m.index + lead;
    const p = POINTS.exec(label);
    const format = headingFormat(label);
    const fAt = format ? label.toLowerCase().search(/multiple|true|short|free|long|essay|proof|tracing|programming|coding|derivation|calculation|computation|numerical/) : -1;
    sections.push({
      label,
      span: { start, end: start + label.length },
      points: p ? Number(p[1] ?? p[2]) : null,
      format,
      formatSpan: format && fAt >= 0 ? { start: start + fAt, end: start + label.length } : null,
    });
  }
  const starts: { number: number; start: number; bodyStart: number }[] = [];
  for (const m of text.matchAll(QUESTION)) {
    const number = Number(m[1] ?? m[2]);
    // A heading line ("Part 2 (20 points)") is not a question.
    if (sections.some((s) => s.span.start <= m.index + m[0].length && m.index <= s.span.end)) continue;
    starts.push({ number, start: m.index + (m[0].length - m[0].trimStart().length), bodyStart: m.index + m[0].length });
  }
  const questions: ParsedQuestion[] = [];
  starts.forEach((q, i) => {
    const nextQ = starts[i + 1]?.start ?? text.length;
    const nextHeading = sections.find((s) => s.span.start > q.start)?.span.start ?? text.length;
    const end = Math.min(nextQ, nextHeading);
    const body = text.slice(q.bodyStart, end);
    const options: ParsedOption[] = [];
    let firstOption = body.length;
    for (const o of body.matchAll(OPTION)) {
      options.push({ id: o[1]!.toLowerCase(), text: o[2]!.trim() });
      firstOption = Math.min(firstOption, o.index);
    }
    const usable = options.length >= 3 ? options : [];
    const stemRaw = body.slice(0, usable.length ? firstOption : body.length);
    // A leading points marker ("(5 points) Which …") is kept in the quote but not in the stem.
    const marker = /^\s*[([]\s*\d{1,3}(?:\.\d)?\s*(?:points?|pts?\.?|marks?)\s*[)\]]\s*/i.exec(stemRaw);
    const lead = marker ? marker[0].length : stemRaw.length - stemRaw.trimStart().length;
    const stem = stemRaw.slice(lead).trim();
    const stemSpan = { start: q.bodyStart + lead, end: q.bodyStart + lead + stem.length };
    const hasCode = CODE_LINE.test(body);
    const f = formatOf(body, usable.length, hasCode, q.bodyStart);
    const l = levelOf(body, q.bodyStart);
    const p = POINTS.exec(body);
    const sectionIndex = sections.reduce<number | null>((acc, s, k) => (s.span.start < q.start ? k : acc), null);
    questions.push({
      number: q.number,
      start: q.start,
      end: q.start + text.slice(q.start, end).trimEnd().length,
      stem,
      stemSpan,
      options: usable,
      format: f.format,
      formatSpan: f.span,
      level: l.level,
      levelSpan: l.span,
      points: p ? Number(p[1] ?? p[2]) : null,
      pointsSpan: p ? { start: q.bodyStart + p.index, end: q.bodyStart + p.index + p[0].length } : null,
      sectionIndex,
      hasCode,
    });
  });
  const head = text.slice(0, 1500);
  const minutes = statedMinutes(head);
  const t = TOTAL.exec(head);
  return {
    sections: sections.filter((s) => questions.some((q) => q.sectionIndex === sections.indexOf(s)) || s.format !== null),
    questions,
    minutes,
    totalPoints: t ? { value: Number(t[1] ?? t[2]), span: { start: t.index, end: t.index + t[0].length } } : null,
  };
}

/** A solutions document's answers by question number: the answer span, and what code could read from it. */
export interface ParsedAnswer {
  number: number;
  span: Span;
  text: string;
  choice: string | null;
  numeric: { value: number; unit: string | null; decimals: number } | null;
}

const NUMERIC_ANSWER = /(?:=|answer\s*:|≈)\s*(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*([A-Za-zµΩ°][A-Za-z0-9µΩ°/^*·²³]*)?\s*\.?\s*$/i;
const CHOICE_ANSWER = /^(?:answer\s*:?\s*)?\(?([a-eA-E])\)?(?=[\s.,;:)]|$)/;

export function parseAnswers(text: string): ParsedAnswer[] {
  const out: ParsedAnswer[] = [];
  const starts = [...text.matchAll(QUESTION)].map((m) => ({ number: Number(m[1] ?? m[2]), start: m.index + (m[0].length - m[0].trimStart().length), body: m.index + m[0].length }));
  starts.forEach((s, i) => {
    const end = starts[i + 1]?.start ?? text.length;
    const raw = text.slice(s.body, end);
    const body = raw.trim();
    const lead = raw.length - raw.trimStart().length;
    const span = { start: s.body + lead, end: s.body + lead + body.length };
    const choice = CHOICE_ANSWER.exec(body)?.[1]?.toLowerCase() ?? null;
    const lastLine = body.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
    const n = NUMERIC_ANSWER.exec(lastLine) ?? NUMERIC_ANSWER.exec(body.split("\n")[0] ?? "");
    const numeric = n
      ? { value: Number(n[1]), unit: n[2] ?? null, decimals: (n[1]!.split(".")[1] ?? "").replace(/[eE].*$/, "").length }
      : null;
    out.push({ number: s.number, span, text: body, choice, numeric: numeric && Number.isFinite(numeric.value) ? numeric : null });
  });
  return out;
}
