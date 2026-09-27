/**
 * The flashcards pack: term/definition cards and cloze sentences, each tagged with topics and a
 * section and grounded in one verbatim quote. Cloze answers are blanked by code, not the model,
 * and code checks what a model can get wrong about a card: a cloze sentence must be the quoted
 * text, its blank must be a real recall target, and a term card's back must say more than its
 * front. For a language course code adds each vocabulary card's reverse direction.
 */
import { z } from "zod";
import { definePack } from "../../core/src/index";
import type { Passage } from "../../core/src/index";
import { batchCheck, citedQuote, sharedRules, type Draft, type GenerationInput } from "../../items/src/draft";

export const cardSchema = z
  .object({
    /** term: front is the term, back its definition. cloze: front is a sentence from the passage, back the words to blank. */
    kind: z.enum(["term", "cloze"]),
    front: z.string().min(1).max(600),
    back: z.string().min(1).max(600),
    topics: z.array(z.string().min(1).max(80)).min(1).max(3),
    section: z.string().min(1).max(120),
    sourceId: z.string().min(1).max(200),
    quote: z.string().max(400),
  })
  .strict();
export const cardsOutputSchema = z.object({ cards: z.array(cardSchema).max(40) }).strict();
export type CardsOutput = z.infer<typeof cardsOutputSchema>;

export const CLOZE_BLANK = "_____";
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
const letters = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, "").length;
const normal = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Words that are never a recall target on their own (English function words). */
const FUNCTION_WORDS = new Set(
  "a an the and or but nor so yet of to in on at by for from with as is are was were be been being it its this that these those there here which who whom whose what when where why how not no do does did has have had can could may might must shall should will would than then also only very you we they he she me us them".split(
    " ",
  ),
);
/** A blank covering more of the sentence than this leaves too little to recall from. */
export const MAX_BLANK_SHARE = 0.6;
/**
 * The negation words the flaw rules want emphasised (packages/learning/src/flaws.ts). Boundaries
 * are Unicode letters, not ASCII \b, so a target-language word that starts with one of these
 * ("notó", "noté", "notícia") is never partly capitalised.
 */
const NEGATION = /(?<![\p{L}\p{N}])(not|except|never|least|incorrect)(?![\p{L}\p{N}])/giu;

export function cardDrafts(output: CardsOutput, passages?: readonly Passage[]): Draft[] {
  return output.cards.map((input, index): Draft => {
    // An abbreviated quote is restored from the passage it cites (expandQuote).
    const c = { ...input, quote: citedQuote(passages, input.sourceId, input.quote) };
    const back = c.back.trim();
    const base = {
      index,
      options: null,
      unit: null,
      formula: null,
      explanation: null,
      topics: c.topics.map((t) => t.trim()).filter(Boolean),
      section: c.section.trim(),
      bloom: "remember" as const,
      sourceId: c.sourceId,
      quote: c.quote,
    };
    if (c.kind === "term") {
      const front = c.front.trim();
      const problem = normal(back) === normal(front) || !normal(back) ? "the back only repeats the front" : null;
      return { ...base, kind: "card", stem: front, key: back, keyIdeas: [{ idea: back, synonyms: [], required: true }], problem };
    }
    // Cloze: code blanks every whole-word occurrence of the answer, so a second occurrence can't
    // give it away, then emphasises negations the way the flaw rules ask of any stem.
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escape(back)}(?![\\p{L}\\p{N}])`, "giu");
    const found = back ? c.front.match(pattern) : null;
    const stem = found ? c.front.replace(pattern, CLOZE_BLANK).trim().replace(NEGATION, (w) => w.toUpperCase()) : c.front.trim();
    const problem = !found
      ? "the cloze answer doesn't occur in its sentence"
      : back.split(/\s+/).every((w) => FUNCTION_WORDS.has(w.toLowerCase()))
        ? "the blank is only function words"
        : letters(back) * found.length > MAX_BLANK_SHARE * letters(c.front)
          ? "the blank covers most of the sentence"
          : !collapse(c.quote).includes(collapse(c.front))
            ? "the cloze sentence isn't the quoted text"
            : null;
    return { ...base, kind: "cloze", stem, key: back, keyIdeas: [{ idea: back, synonyms: [], required: true }], problem };
  });
}

/**
 * A language course's vocabulary in both directions (plan D35), made by code at 0 tokens: each
 * well-formed term card whose meaning is short and doesn't contain the word gets a reverse card
 * (meaning on the front, the word as the key), grounded in the same quote. Reverse drafts take
 * indexes after the model's and name the card they come from.
 */
export const MAX_REVERSE_BACK = 80;
export function reverseCards(drafts: Draft[]): Draft[] {
  let next = drafts.reduce((m, d) => Math.max(m, d.index), -1) + 1;
  const out: Draft[] = [];
  for (const d of drafts) {
    if (d.kind !== "card" || d.problem || d.derivedFrom !== undefined) continue;
    const word = d.stem;
    const meaning = String(d.key);
    if (meaning.length > MAX_REVERSE_BACK) continue;
    if (new RegExp(`(?<![\\p{L}\\p{N}])${escape(word)}(?![\\p{L}\\p{N}])`, "iu").test(meaning)) continue;
    out.push({ ...d, index: next++, stem: meaning, key: word, keyIdeas: [{ idea: word, synonyms: [], required: true }], derivedFrom: d.index });
  }
  return out;
}

export const cardsPack = definePack<GenerationInput, CardsOutput>({
  id: "cards",
  version: "v2",
  tier: "pass",
  escalate: false, // items are checked one by one: failures are dropped, never escalated to the strong model
  system:
    "You write flashcards for a university student from their own course passages: term cards (a key term and its definition as the course states it) and cloze cards (a sentence from the passage and the key words to blank out). One idea per card; keep backs short. For a cloze card, copy the sentence exactly as the passage has it, quote that sentence (or a longer span containing it), and blank a key term, name, number or form: never a function word, never most of the sentence. Return only JSON matching the schema.",
  template: (i) => `${sharedRules(i, "cards")}\n\nWrite ${i.count} flashcards, mixing term and cloze cards.`,
  schema: cardsOutputSchema,
  checks: [batchCheck(cardDrafts)],
  cacheKey: (i) => i,
  categories: ["course_text"],
  intent: "cards",
});
