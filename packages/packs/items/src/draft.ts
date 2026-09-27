/**
 * The shared shape both generation packs (quiz items, T45; flashcards) reduce their model output
 * to. The model writes; code decides: a draft is only a proposal until the pack handler grounds
 * its quote, maps its topics and runs the learning engines' checked-item pipeline (N06).
 */
import type { CheckContext, PackCheck, Passage } from "../../core/src/index";

export type DraftKind = "mc" | "tf" | "numeric" | "cloze" | "card";
export type DraftBloom = "remember" | "understand" | "apply" | "analyse" | "evaluate";

/** What a pack asks for. Every field shapes the prompt, so every field is in the cache key. */
export interface GenerationInput {
  count: number;
  /** The course's sections (modules or chapters) already on the map; the model picks or names one. */
  sections: string[];
  /** Topic labels already on the map, so the model reuses them before inventing new ones. */
  topics: string[];
  /** Topics the student chose ("quiz me on"); empty for the whole scope. */
  focus: string[];
  /**
   * The course's subject family, derived by code from the UW subject code and course title
   * (plan D35; `subjectFamily` in packages/notes). It picks the item-type mix the prompt asks
   * for (D52). Absent when code can't tell.
   */
  subject?: string;
}

export interface Draft {
  index: number;
  kind: DraftKind;
  stem: string;
  /** Choice items only; ids are assigned by code (a, b, c, …). */
  options: { id: string; text: string }[] | null;
  /** MC/TF: the option id; cloze/card: the answer text; numeric: the number. */
  key: string | number;
  unit: string | null;
  formula: string | null;
  /** Recall items: the idea code grades against. */
  keyIdeas: { idea: string; synonyms: string[]; required: boolean }[];
  explanation: string | null;
  topics: string[];
  section: string;
  bloom: DraftBloom;
  sourceId: string;
  quote: string;
  /** A structural problem code found while reading the output; the item is dropped for it. */
  problem: string | null;
  /** Set on an item code derived from another draft (a language card's reverse direction). */
  derivedFrom?: number;
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/** An expanded quote longer than this is not a quote. */
export const MAX_QUOTE_SPAN = 600;
const ELLIPSIS = /\s*(?:…|\.\.\.)\s*/;
const words = (s: string) => new RegExp(s.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "g");
/**
 * Output-token saving: a long quote may come back as its first and last words around an ellipsis
 * ("A collision happens when … the same bucket."). Code restores the exact span from the passage
 * the item cites: the first place the opening words occur that the closing words follow within
 * MAX_QUOTE_SPAN. The result is the passage's own text, checked verbatim like any quote; a full
 * quote, or one that doesn't expand, is returned unchanged and checked as before.
 */
export function expandQuote(passage: string, quote: string): string {
  const q = quote.trim();
  if (!q || collapse(passage).includes(collapse(q))) return quote;
  const parts = q.split(ELLIPSIS);
  if (parts.length !== 2 || !parts[0] || !parts[1]) return quote;
  const head = words(parts[0]);
  const tail = words(parts[1]);
  for (const h of passage.matchAll(head)) {
    tail.lastIndex = h.index + h[0].length;
    const t = tail.exec(passage);
    if (t && t.index + t[0].length - h.index <= MAX_QUOTE_SPAN) return passage.slice(h.index, t.index + t[0].length);
  }
  return quote;
}
/** The quote an item cites, expanded against its passage when one is given. */
export function citedQuote(passages: readonly Passage[] | undefined, sourceId: string, quote: string): string {
  const p = passages?.find((x) => x.sourceId === sourceId);
  return p ? expandQuote(p.text, quote) : quote;
}

/** The per-draft code checks that don't need the store: structure, then the quote against the passages sent. */
export function draftErrors(d: Draft, context: CheckContext): string[] {
  const errors: string[] = [];
  if (d.problem) errors.push(d.problem);
  const passage = context.passages.find((p) => p.sourceId === d.sourceId);
  if (!passage) errors.push(`quote cites ${d.sourceId}, which is not among the passages`);
  else if (!d.quote.trim() || !collapse(passage.text).includes(collapse(d.quote)))
    errors.push(`quote not found verbatim in ${d.sourceId}: "${collapse(d.quote).slice(0, 80)}"`);
  return errors;
}

/**
 * The pack-level check the runner acts on (T13: retry with these errors, escalate once, then
 * needs_student). A batch is retried only when fewer than half its items survive the code
 * checks; otherwise the bad items are dropped one by one, each with its reason, by the handler.
 */
export function batchCheck<O>(drafts: (output: O, passages?: readonly Passage[]) => Draft[]): PackCheck<GenerationInput, O> {
  return (output, input, context) => {
    const all = drafts(output, context.passages).slice(0, input.count);
    if (!all.length) return ["no items were returned"];
    const failed = all
      .map((d) => ({ d, errors: draftErrors(d, context) }))
      .filter((x) => x.errors.length);
    const usable = all.length - failed.length;
    if (usable >= Math.ceil(all.length / 2)) return [];
    return failed.flatMap((x) => x.errors.map((e) => `item ${x.d.index + 1}: ${e}`));
  };
}

export const OPTION_IDS = ["a", "b", "c", "d", "e", "f"] as const;

/**
 * The item-type mix per subject family (plan D35: "the profile picks the generation pack's
 * variant, the item-type mix and the verifiers"). Families code can't tell get no line.
 */
const QUANTITATIVE = {
  quiz: "Prefer numeric questions wherever a passage works a calculation (the value, its unit and the passage's formula, so code can recompute it); use multiple choice for definitions, theorems and rules.",
  cards: "Term cards for definitions, theorems and rules; cloze cards that blank the key term or quantity in a stated result.",
};
const DISCURSIVE = {
  quiz: "Ask about claims, causes, sources and dates with multiple choice and true/false; a numeric question only for a year or figure the passage states.",
  cards: "Concept, argument, source and date cards: a term with its definition as the course states it, and cloze cards that blank a year, name or key term.",
};
export const SUBJECT_MIX: Record<string, { quiz: string; cards: string }> = {
  languages: {
    quiz: "Test meaning and form: multiple choice on what a word means or which form is correct, and true/false on usage. No numeric questions.",
    cards: "Vocabulary term cards with the target-language word or phrase on the front and its meaning as the course gives it on the back (the app adds the reverse direction), and cloze cards that blank one whole conjugated or agreeing word (never part of a word) in a sentence from the passage.",
  },
  math: QUANTITATIVE,
  physical_science: QUANTITATIVE,
  engineering: QUANTITATIVE,
  computing: {
    quiz: "Ask about behaviour and cost: multiple choice on what a structure, algorithm or line of code does, and numeric questions for counts, sizes and running-time arithmetic the passage works.",
    cards: "Term cards for structures, algorithms and definitions; cloze cards that blank the key property (ordering, complexity, invariant).",
  },
  life_science: {
    quiz: "Multiple choice and true/false on structures, processes and their causes; numeric questions only for quantities the passage works out.",
    cards: "Term cards for structures and processes; cloze cards that blank the key step or term in a stated process.",
  },
  humanities: DISCURSIVE,
  social_science: DISCURSIVE,
  arts: DISCURSIVE,
  business: {
    quiz: "Multiple choice on concepts and how they apply to the passage's cases; numeric questions for figures the passage computes.",
    cards: "Term cards for concepts and frameworks; cloze cards that blank the key term in a stated principle.",
  },
};

/** The prompt part both packs share: sections and topics, the subject's item mix, and the grounding rules. */
export function sharedRules(input: GenerationInput, pack?: "quiz" | "cards"): string {
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- (none yet)");
  const mix = pack && input.subject ? SUBJECT_MIX[input.subject]?.[pack] : undefined;
  return [
    `Sections already on the course map (use one of these when it fits; otherwise name the module or chapter the passage belongs to):\n${list(input.sections)}`,
    `Topics already on the course map (reuse these labels before inventing a new one):\n${list(input.topics)}`,
    input.focus.length ? `Only write about these topics:\n${list(input.focus)}` : "",
    mix ? `Subject profile (${input.subject}): ${mix}` : "",
    "Rules: every item cites exactly one passage by its id in `sourceId` and copies a `quote` of 12 to 400 characters from that passage, character for character, that supports the answer. Spread the items across the passages rather than drawing several from one. Tag each item with 1 to 3 short topic labels, the first being the main one, and one section. Never write about anything the passages don't state.",
    // Quiz and cards restore an abbreviated quote from the passage in code (expandQuote); other packs don't.
    pack ? "To save space, a quote longer than 12 words may be written as its first 5 words, then …, then its last 5 words, each copied exactly; the app restores the full quote from the passage." : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
