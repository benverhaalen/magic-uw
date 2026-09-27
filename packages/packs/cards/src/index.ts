/**
 * The flashcards pack: term/definition cards and cloze sentences, each tagged with topics and a
 * section and grounded in one verbatim quote. Cloze answers are blanked by code, not the model.
 */
import { z } from "zod";
import { definePack } from "../../core/src/index";
import { batchCheck, sharedRules, type Draft, type GenerationInput } from "../../items/src/draft";

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

export function cardDrafts(output: CardsOutput): Draft[] {
  return output.cards.map((c, index): Draft => {
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
    if (c.kind === "term")
      return { ...base, kind: "card", stem: c.front.trim(), key: back, keyIdeas: [{ idea: back, synonyms: [], required: true }], problem: null };
    // Cloze: code blanks the first whole-word occurrence of the answer.
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escape(back)}(?![\\p{L}\\p{N}])`, "iu");
    const found = back ? pattern.exec(c.front) : null;
    return {
      ...base,
      kind: "cloze",
      stem: found ? `${c.front.slice(0, found.index)}${CLOZE_BLANK}${c.front.slice(found.index + found[0].length)}`.trim() : c.front.trim(),
      key: back,
      keyIdeas: [{ idea: back, synonyms: [], required: true }],
      problem: found ? null : "the cloze answer doesn't occur in its sentence",
    };
  });
}

export const cardsPack = definePack<GenerationInput, CardsOutput>({
  id: "cards",
  version: "v1",
  tier: "pass",
  system:
    "You write flashcards for a university student from their own course passages: term cards (a key term and its definition as the course states it) and cloze cards (a sentence from the passage and the key words to blank out). One idea per card; keep backs short. Return only JSON matching the schema.",
  template: (i) => `${sharedRules(i)}\n\nWrite ${i.count} flashcards, mixing term and cloze cards.`,
  schema: cardsOutputSchema,
  checks: [batchCheck(cardDrafts)],
  cacheKey: (i) => i,
  categories: ["course_text"],
  intent: "cards",
});
