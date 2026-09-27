/**
 * The offline model: a deterministic, rule-based item writer that stands in for the student's
 * AI in offline runs. It reads only the prompt the app actually sent (the passages and the
 * instructions, after scrubbing), and follows the instructions literally:
 *
 * - It extracts facts from passage sentences: definitions ("A stack is a ..."), vocabulary
 *   ("The word perro means dog."), verb forms ("The yo form of hablar is hablo."), worked
 *   arithmetic ("25 * 4 = 100 bytes") and dated events ("In 1789, ...").
 * - Quiz: multiple choice (4 options, one correct, distractors of the same kind from other facts),
 *   true/false and numeric items "where the passages give numbers"; a numeric item's formula is
 *   the passage's arithmetic "using numbers, + - * / and parentheses" and its unit goes in
 *   `unit`, exactly as the prompt asks. Negations are written in capitals.
 * - Cards: term cards ("a key term and its definition as the course states it") and cloze cards
 *   ("a sentence from the passage and the key words to blank out"), quoting the sentence.
 * - When the prompt carries a subject profile line ("Subject profile (<family>): ..."), it
 *   follows that family's item mix; otherwise the generic mix.
 *
 * It is not a language model and writes no prose of its own: offline numbers measure the
 * app's code (the pack path, checks, pipeline and store), never model writing quality.
 */
import type { QuizOutput } from "../../packages/packs/items/src/index";
import type { CardsOutput } from "../../packages/packs/cards/src/index";

export interface PromptPassage {
  sourceId: string;
  text: string;
}

export type Fact =
  | { kind: "definition"; term: string; def: string; verb: string; sentence: string; sourceId: string; section: string }
  | { kind: "vocab"; word: string; gloss: string; sentence: string; sourceId: string; section: string }
  | { kind: "form"; person: string; verb: string; form: string; sentence: string; sourceId: string; section: string }
  | { kind: "arith"; expr: string; value: number; unit: string | null; sentence: string; sourceId: string; section: string }
  | { kind: "date"; year: number; event: string; sentence: string; sourceId: string; section: string };

export interface ParsedPrompt {
  passages: PromptPassage[];
  count: number;
  family: string | null;
}

export function parsePrompt(input: string): ParsedPrompt {
  const passages: PromptPassage[] = [];
  for (const m of input.matchAll(/<passage id="([^"]+)">\n([\s\S]*?)\n<\/passage>/g)) passages.push({ sourceId: m[1]!, text: m[2]! });
  const count = Number(/Write (\d+) (?:quiz questions|flashcards)/.exec(input)?.[1] ?? 8);
  const family = /Subject profile \(([a-z_]+)\)/.exec(input)?.[1] ?? null;
  return { passages, count, family };
}

/** Sentences as verbatim substrings of the passage text. */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z(¿¡"])/u)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12);
}

const STOP = new Set(["in", "the", "and", "of", "to", "a", "an", "for", "at", "on", "with", "by", "per", "total"]);
const DEF = /^(?:(An?|The)\s+)?([\p{Lu}\p{Ll}][\p{L}-]*(?:\s+[\p{L}-]+){0,3}?)\s+(is|are|was|were)\s+((?:an?|the)\s+.+)\.$/u;
const VOCAB = /^The word ([\p{L}]+) means ([\p{L} '-]+)\.$/u;
const FORM = /^The ([\p{L}]+) form of ([\p{L}]+) is ([\p{L}]+)\.$/u;
const DATE = /^In (\d{4}),\s+(.+)\.$/u;

function sectionOf(text: string): string {
  const m = /^(Module \d+)[^:]*:\s*([^.]+)\./.exec(text);
  return m ? `${m[1]}: ${m[2]!.trim()}` : "Course material";
}

/** Arithmetic worked in a sentence: "<expr> = <value> [unit]". */
function arithmetic(sentence: string): { expr: string; value: number; unit: string | null; at: number }[] {
  const out: { expr: string; value: number; unit: string | null; at: number }[] = [];
  for (const m of sentence.matchAll(/=\s*(-?\d+(?:\.\d+)?)(?![\d.]\d)(?:\s+([a-z]+))?/g)) {
    const before = sentence.slice(0, m.index);
    const run = /[\d.\s()+\-*/×÷]*$/.exec(before)?.[0] ?? "";
    const expr = run.trim().replace(/^[)\s]+/, "");
    const numbers = expr.match(/\d+(?:\.\d+)?/g) ?? [];
    if (numbers.length < 2 || !/[+\-*/×÷]/.test(expr)) continue;
    let depth = 0;
    let balanced = true;
    for (const ch of expr) {
      depth += ch === "(" ? 1 : ch === ")" ? -1 : 0;
      if (depth < 0) balanced = false;
    }
    if (!balanced || depth !== 0) continue;
    const unit = m[2] && !STOP.has(m[2]) ? m[2] : null;
    out.push({ expr, value: Number(m[1]), unit, at: m.index! });
  }
  return out;
}

export function extractFacts(passages: PromptPassage[]): Fact[] {
  const facts: Fact[] = [];
  for (const p of passages) {
    const section = sectionOf(p.text);
    for (const s of sentences(p.text)) {
      const base = { sentence: s, sourceId: p.sourceId, section };
      const vocab = VOCAB.exec(s);
      if (vocab) {
        facts.push({ kind: "vocab", word: vocab[1]!, gloss: vocab[2]!.trim(), ...base });
        continue;
      }
      const form = FORM.exec(s);
      if (form) {
        facts.push({ kind: "form", person: form[1]!, verb: form[2]!, form: form[3]!, ...base });
        continue;
      }
      const date = DATE.exec(s);
      if (date) {
        facts.push({ kind: "date", year: Number(date[1]), event: date[2]!, ...base });
        continue;
      }
      const arith = arithmetic(s);
      if (arith.length) {
        const a = arith[arith.length - 1]!;
        facts.push({ kind: "arith", expr: a.expr, value: a.value, unit: a.unit, ...base });
        continue;
      }
      const def = DEF.exec(s);
      // Not a term: sentence openers such as "What is ..." or "It was ..." in lecture speech.
      if (def && !/^(This|These|That|It)\b/.test(s) && !/^(what|which|who|whom|whose|how|why|when|where|that|this|these|those|it|there|here|so|and|but|or|now|then|well|i|you|we|they|he|she)\b/i.test(def[2]!))
        facts.push({ kind: "definition", term: def[2]!, def: def[4]!, verb: def[3]!, ...base });
    }
  }
  return facts;
}

/** A stable small hash for deterministic choices. */
export function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** The literal reading of "Emphasise a negation in capitals (NOT)". */
const emphasise = (s: string) => s.replace(/\b(not|except|never|least|incorrect)\b/g, (w) => w.toUpperCase());

function answerOf(f: Fact): string {
  switch (f.kind) {
    case "definition":
      return f.term;
    case "vocab":
      return f.gloss;
    case "form":
      return f.form;
    case "arith":
      return String(f.value);
    case "date":
      return String(f.year);
  }
}

/** Three distractors of the same kind from other facts, "of similar length" to the key (the prompt's words). */
function distractors(f: Fact, all: Fact[]): string[] | null {
  const key = answerOf(f);
  const pool = [...new Set(all.filter((o) => o.kind === f.kind && o !== f).map(answerOf))].filter((a) => a.toLowerCase() !== key.toLowerCase());
  if (pool.length < 3) return null;
  const gap = (a: string) => Math.abs(a.length - key.length);
  return pool.sort((a, b) => gap(a) - gap(b) || hash(`${f.sentence}|${a}`) - hash(`${f.sentence}|${b}`)).slice(0, 3);
}

type QuizItem = QuizOutput["items"][number];
type Card = CardsOutput["cards"][number];

const topicOf = (f: Fact) =>
  (f.kind === "definition" ? f.term : f.kind === "vocab" ? f.word : f.kind === "form" ? `${f.verb} (${f.person})` : f.kind === "date" ? f.event.split(/\s+/).slice(0, 3).join(" ") : `${f.section} arithmetic`).slice(0, 80);

function mc(f: Fact, all: Fact[]): QuizItem | null {
  const ds = distractors(f, all);
  if (!ds) return null;
  const stem =
    f.kind === "definition"
      ? `Which term does the course define as ${f.def}?`
      : f.kind === "vocab"
        ? `What does the word ${f.word} mean?`
        : f.kind === "form"
          ? `What is the ${f.person} form of ${f.verb}?`
          : f.kind === "date"
            ? `In what year did this happen: ${f.event}?`
            : null;
  if (!stem) return null;
  const keyAt = hash(f.sentence) % 4;
  const texts = [...ds];
  texts.splice(keyAt, 0, answerOf(f));
  return {
    kind: "mc",
    stem: emphasise(stem),
    options: texts.map((text, i) => ({ text, correct: i === keyAt })),
    statementIsTrue: null,
    numeric: null,
    explanation: `The passage states: ${f.sentence}`,
    topics: [topicOf(f)],
    section: f.section,
    bloom: "remember",
    sourceId: f.sourceId,
    quote: f.sentence,
  };
}

function tf(f: Fact, all: Fact[]): QuizItem | null {
  let statement: string;
  let truth = hash(f.sentence) % 2 === 0;
  if (f.kind === "definition") {
    const other = all.find((o) => o.kind === "definition" && o !== f && o.term.toLowerCase() !== f.term.toLowerCase());
    if (!other) truth = true;
    statement = truth ? `${cap(f.def)} describes the ${f.term.toLowerCase()}.` : `${cap(f.def)} describes the ${(other as Extract<Fact, { kind: "definition" }>).term.toLowerCase()}.`;
  } else if (f.kind === "vocab") {
    const other = all.find((o) => o.kind === "vocab" && o !== f);
    if (!other) truth = true;
    statement = `In this course, ${f.word} means ${truth ? f.gloss : (other as Extract<Fact, { kind: "vocab" }>).gloss}.`;
  } else if (f.kind === "date") {
    statement = `${cap(f.event)} in ${truth ? f.year : f.year + 10}.`;
  } else return null;
  return {
    kind: "tf",
    stem: emphasise(statement),
    options: [],
    statementIsTrue: truth,
    numeric: null,
    explanation: `The passage states: ${f.sentence}`,
    topics: [topicOf(f)],
    section: f.section,
    bloom: "understand",
    sourceId: f.sourceId,
    quote: f.sentence,
  };
}

function numeric(f: Fact): QuizItem | null {
  if (f.kind === "arith") {
    const cut = f.sentence.indexOf(`${f.expr}`);
    const lead = cut > 0 ? f.sentence.slice(0, cut).replace(/[\s,]+$/, "") : "";
    const stem = `${lead ? `${lead}: ` : ""}what is ${f.expr}${f.unit ? ` in ${f.unit}` : ""}?`;
    return {
      kind: "numeric",
      stem: emphasise(cap(stem)),
      options: [],
      statementIsTrue: null,
      numeric: { value: f.value, unit: f.unit, formula: f.expr },
      explanation: `The passage works it out: ${f.sentence}`,
      topics: [topicOf(f)],
      section: f.section,
      bloom: "apply",
      sourceId: f.sourceId,
      quote: f.sentence,
    };
  }
  if (f.kind === "date")
    return {
      kind: "numeric",
      stem: emphasise(`In what year: ${f.event}?`),
      options: [],
      statementIsTrue: null,
      numeric: { value: f.year, unit: null, formula: null },
      explanation: `The passage states: ${f.sentence}`,
      topics: [topicOf(f)],
      section: f.section,
      bloom: "remember",
      sourceId: f.sourceId,
      quote: f.sentence,
    };
  return null;
}

function term(f: Fact): Card | null {
  if (f.kind === "definition")
    return { kind: "term", front: cap(f.term), back: f.def, topics: [topicOf(f)], section: f.section, sourceId: f.sourceId, quote: f.sentence };
  if (f.kind === "vocab")
    return { kind: "term", front: f.word, back: f.gloss, topics: [topicOf(f)], section: f.section, sourceId: f.sourceId, quote: f.sentence };
  return null;
}

function cloze(f: Fact): Card | null {
  const back = f.kind === "definition" ? f.term : f.kind === "form" ? f.form : f.kind === "date" ? String(f.year) : f.kind === "arith" ? String(f.value) : f.gloss;
  return { kind: "cloze", front: f.sentence, back, topics: [topicOf(f)], section: f.section, sourceId: f.sourceId, quote: f.sentence };
}

/** Facts in round-robin order across passages, so items spread over the scope. */
function spread(facts: Fact[]): Fact[] {
  const by = new Map<string, Fact[]>();
  for (const f of facts) by.set(f.sourceId, [...(by.get(f.sourceId) ?? []), f]);
  const lists = [...by.values()];
  const out: Fact[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (l[i]) out.push(l[i]!);
  return out;
}

const QUANT = new Set(["math", "physical_science", "engineering"]);
const WORDY = new Set(["humanities", "social_science", "arts", "life_science", "business"]);

/** The quiz a literal prompt-follower writes: up to `count` items, one per fact first. */
export function writeQuiz(prompt: ParsedPrompt, count: number): QuizItem[] {
  const facts = spread(extractFacts(prompt.passages));
  const family = prompt.family;
  const out: QuizItem[] = [];
  const kinds = (f: Fact): ((f: Fact) => QuizItem | null)[] => {
    const m = (x: Fact) => mc(x, facts);
    const t = (x: Fact) => tf(x, facts);
    if (family === "languages") return [m, t];
    if (family && QUANT.has(family)) return f.kind === "arith" ? [numeric] : [m, t];
    if (family === "computing") return f.kind === "arith" ? [numeric] : [m, t];
    if (family && WORDY.has(family)) return f.kind === "date" ? [numeric, m, t] : [m, t];
    // Generic: "numeric questions where the passages give numbers", otherwise a mix.
    return f.kind === "arith" || f.kind === "date" ? [numeric, t] : [m, t];
  };
  for (let round = 0; round < 2 && out.length < count; round++)
    for (const [i, f] of facts.entries()) {
      if (out.length >= count) break;
      const options = kinds(f);
      const writer = options[(i + round) % options.length]!;
      const item = writer(f) ?? options.map((w) => w(f)).find(Boolean) ?? null;
      if (item && !out.some((o) => o.stem === item.stem)) out.push(item);
      if (round === 0 && out.length >= Math.min(count, facts.length)) break;
    }
  return out.slice(0, count);
}

/** The cards a literal prompt-follower writes: term and cloze, mixed. */
export function writeCards(prompt: ParsedPrompt, count: number): Card[] {
  const facts = spread(extractFacts(prompt.passages));
  const family = prompt.family;
  const out: Card[] = [];
  for (const [i, f] of facts.entries()) {
    if (out.length >= count) break;
    let card: Card | null;
    if (family === "languages") card = f.kind === "vocab" || f.kind === "definition" ? term(f) : cloze(f);
    else if (family && QUANT.has(family)) card = f.kind === "definition" ? (i % 2 ? cloze(f) : term(f)) : cloze(f);
    else card = i % 2 === 0 ? (term(f) ?? cloze(f)) : cloze(f);
    if (card && !out.some((o) => o.front === card!.front)) out.push(card);
  }
  return out;
}
