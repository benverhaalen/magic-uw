/**
 * T45: the items pack (quiz). Multiple choice (4 options, exactly one key), true/false and
 * numeric items, each tagged with topics and a section and grounded in one verbatim quote.
 * One checked call per batch; the handler runs N06's stages on every item before it is stored.
 */
import { z } from "zod";
import { definePack } from "../../core/src/index";
import { evaluate } from "../../../learning/src/arith";
import type { Passage } from "../../core/src/index";
import { batchCheck, citedQuote, OPTION_IDS, sharedRules, type Draft, type GenerationInput } from "./draft";

export * from "./draft";

const bloom = z.enum(["remember", "understand", "apply", "analyse", "evaluate"]);
export const quizItemSchema = z
  .object({
    kind: z.enum(["mc", "tf", "numeric"]),
    stem: z.string().min(1).max(600),
    /** mc: exactly 4, exactly one with correct = true. tf and numeric: an empty list. */
    options: z.array(z.object({ text: z.string().min(1).max(300), correct: z.boolean() }).strict()).max(6),
    /** tf only: whether the stem's statement is true. */
    statementIsTrue: z.boolean().nullable(),
    /** numeric only. `formula` is arithmetic from the passage that gives the value, when there is one. */
    numeric: z.object({ value: z.number(), unit: z.string().max(40).nullable(), formula: z.string().max(200).nullable() }).strict().nullable(),
    explanation: z.string().max(800),
    topics: z.array(z.string().min(1).max(80)).min(1).max(3),
    section: z.string().min(1).max(120),
    bloom,
    sourceId: z.string().min(1).max(200),
    quote: z.string().max(400),
  })
  .strict();
export const quizOutputSchema = z.object({ items: z.array(quizItemSchema).max(30) }).strict();
export type QuizOutput = z.infer<typeof quizOutputSchema>;
export type QuizItemOutput = z.infer<typeof quizItemSchema>;

/** Code reads each item into a draft; a structural fault becomes the draft's `problem`. An abbreviated quote is restored from `passages`. */
export function quizDrafts(output: QuizOutput, passages?: readonly Passage[]): Draft[] {
  return output.items.map((it, index): Draft => {
    const base = {
      index,
      stem: it.stem.trim(),
      unit: null,
      formula: null,
      keyIdeas: [],
      explanation: it.explanation.trim() || null,
      topics: it.topics.map((t) => t.trim()).filter(Boolean),
      section: it.section.trim(),
      bloom: it.bloom,
      sourceId: it.sourceId,
      quote: citedQuote(passages, it.sourceId, it.quote),
      problem: null as string | null,
    };
    if (it.kind === "mc") {
      const options = it.options.map((o, i) => ({ id: OPTION_IDS[i]!, text: o.text.trim() }));
      const keys = it.options.flatMap((o, i) => (o.correct ? [OPTION_IDS[i]!] : []));
      const problem =
        it.options.length !== 4
          ? `a multiple-choice item needs 4 options, not ${it.options.length}`
          : keys.length !== 1
            ? `${keys.length} options are marked correct; exactly one key is needed`
            : null;
      return { ...base, kind: "mc", options, key: keys.length === 1 ? keys[0]! : "", problem };
    }
    if (it.kind === "tf")
      return {
        ...base,
        kind: "tf",
        options: [
          { id: "true", text: "True" },
          { id: "false", text: "False" },
        ],
        key: it.statementIsTrue === null ? "" : it.statementIsTrue ? "true" : "false",
        problem: it.statementIsTrue === null ? "a true/false item needs statementIsTrue" : it.options.length ? "a true/false item takes no options" : null,
      };
    const unit = it.numeric?.unit?.trim() || null;
    return {
      ...base,
      kind: "numeric",
      options: null,
      key: it.numeric?.value ?? Number.NaN,
      unit,
      formula: withUnit(it.numeric?.formula?.trim() || null, unit),
      problem: it.numeric ? null : "a numeric item needs its value",
    };
  });
}

/**
 * The prompt asks for the formula "using numbers, + - * / and parentheses" and the unit apart,
 * so a compliant formula for 100 bytes is "25 * 4": unitless. Stage 6 compares units too, and
 * dropped that correct item. When the formula carries no unit and the item has a one-word unit,
 * code applies the unit to the whole formula ("(25 * 4) bytes"). The value is still recomputed
 * and compared, so a wrong value still fails.
 */
export function withUnit(formula: string | null, unit: string | null): string | null {
  if (!formula || !unit || !/^[A-Za-zµΩ°%][A-Za-zµΩ°%0-9^]*$/.test(unit)) return formula;
  try {
    if (evaluate(formula).unit !== null) return formula;
    const wrapped = `(${formula}) ${unit}`;
    return evaluate(wrapped).unit === unit ? wrapped : formula;
  } catch {
    return formula;
  }
}

export const quizPack = definePack<GenerationInput, QuizOutput>({
  id: "quiz",
  version: "v2",
  tier: "pass",
  escalate: false, // items are checked one by one: failures are dropped, never escalated to the strong model
  system:
    "You write quiz questions for a university student from their own course passages. Mix multiple choice (4 options, exactly one correct, plausible distractors of similar length, no \"all/none of the above\"), true/false statements and numeric questions where the passages give numbers. Emphasise a negation in capitals (NOT). Return only JSON matching the schema.",
  template: (i) =>
    `${sharedRules(i, "quiz")}\n\nWrite ${i.count} quiz questions. For numeric questions give the value, its unit (or null) and, when the passage shows the arithmetic, the formula using numbers, + - * / and parentheses.`,
  schema: quizOutputSchema,
  checks: [batchCheck(quizDrafts)],
  cacheKey: (i) => i,
  categories: ["course_text"],
  intent: "quiz",
});
