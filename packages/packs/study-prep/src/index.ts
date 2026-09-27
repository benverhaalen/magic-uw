/**
 * owner: study-prep. One pack for the Study prepper's Studio: a study guide, a practice quiz and
 * flashcards over code-retrieved passages from the sources the student ticked.
 *
 * Efficiency decisions (recorded here, where they are enforced):
 * - One call for every kind asked together. The schema carries all three parts, each nullable, so
 *   "guide + quiz + cards" sends the passages once instead of three times.
 * - Separate asks stay cache-friendly. Everything the prompt holds before `## Write` (the scope,
 *   materials, topics, facts and grounding rules, and before them the course brief prefix and the
 *   passages) depends only on the scope, never on the kinds, so a later ask for another kind on
 *   the same scope repeats a byte-identical prefix the provider's prompt cache can reuse.
 * - Maths is TeX in generated prose only ($…$ inline, $$…$$ display). Quotes stay verbatim source
 *   text, so the code quote checks are unchanged; worked-example expressions stay plain arithmetic
 *   so code can recompute them.
 */
import { z } from "zod";
import { definePack, type CheckContext, type PackCheck } from "../../core/src/index";
import { quizDrafts, quizOutputSchema, SUBJECT_MIX, draftErrors, type Draft } from "../../items/src/index";
import { cardDrafts, cardsOutputSchema } from "../../cards/src/index";
import { guideOutputSchema, reviewGuide, type GuideInput } from "../../guide/src/index";

export const STUDY_PREP_PACK_ID = "study-prep";
/** Bump when the prompt or schema changes: the version is in the cache key. */
export const STUDY_PREP_PACK_VERSION = "v1";

export type PrepKind = "guide" | "quiz" | "cards";
/** What code selected for the call. Every field shapes the prompt, so every field is in the cache key. */
export interface PrepInput {
  kinds: PrepKind[];
  counts: { quiz: number; cards: number };
  /** "Midterm 1 (2026-10-15). Stated scope: …" */
  scope: string;
  materials: string[];
  sections: string[];
  topics: string[];
  /** Topics the student narrowed to; empty for the whole coverage. */
  focus: string[];
  facts: string[];
  subject?: string;
}

export const studyPrepOutputSchema = z
  .object({
    guide: guideOutputSchema.nullable(),
    quiz: quizOutputSchema.nullable(),
    cards: cardsOutputSchema.nullable(),
  })
  .strict();
export type StudyPrepOutput = z.infer<typeof studyPrepOutputSchema>;

/** The TeX rule every study-prep call carries. Quotes are plain source text; TeX is only in what the model writes. */
export const MATH_RULE = [
  "Maths: write every formula, symbol and equation you write as TeX, inline between single dollar signs (for example $X(e^{j\\omega}) = \\sum_{n} x[n] e^{-j\\omega n}$) or displayed on its own between double dollar signs ($$\\int_{-\\infty}^{\\infty} |x(t)|^2 \\, dt$$).",
  "Use TeX only in text you write: guide text and headings, question stems, options and explanations, card fronts and backs. Write a literal dollar sign as \\$.",
  "A `quote` is copied character for character from its passage and is never rewritten as TeX. A cloze card's front is the quoted sentence exactly as the passage has it.",
  "A worked example's `expression` stays plain arithmetic (numbers, + - * / and parentheses, units allowed) and `result` its plain value, so the app can recompute it; show the TeX form in `text`.",
].join(" ");

const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- (none found)");

/** The kind-independent part of the question: identical for every kind on the same scope. */
export function prepContext(i: PrepInput): string {
  return [
    `Scope: ${i.scope}`,
    `Materials in scope:\n${list(i.materials)}`,
    `Sections already on the course map (use one of these when it fits):\n${list(i.sections)}`,
    `Topics for this scope (reuse these labels before inventing one):\n${list(i.topics)}`,
    i.focus.length ? `Only write about these topics:\n${list(i.focus)}` : "",
    i.facts.length ? `Terms, definitions and formulas the app found in these materials:\n${list(i.facts)}` : "",
    "Grounding: every guide block, question and card cites exactly one passage by its id in `sourceId` and copies a `quote` of 12 to 400 characters from that passage, character for character, that supports it. Never state anything the passages don't support. Spread the work across the passages. Tag each question and card with 1 to 3 short topic labels, the first being the main one, and one section.",
    MATH_RULE,
  ]
    .filter(Boolean)
    .join("\n\n");
}

const ASK: Record<PrepKind, (i: PrepInput) => string> = {
  guide: () =>
    "`guide`: a study guide for this exam, 3 to 8 sections in course order, each with 2 to 6 blocks: `definition` blocks (heading = the term) for key terms, `point` blocks for what a student must understand, and `example` blocks for worked examples (give `expression` and `result` only when the example is arithmetic; otherwise null). Fields a block kind doesn't use are null.",
  quiz: (i) =>
    [
      `\`quiz\`: ${i.counts.quiz} practice questions. Mix multiple choice (4 options, exactly one correct, plausible distractors of similar length, no "all/none of the above"), true/false statements, and numeric questions where the passages work a calculation (the value, its unit or null, and the arithmetic formula when the passage shows it). Emphasise a negation in capitals (NOT). Every question has an explanation.`,
      i.subject && SUBJECT_MIX[i.subject] ? `Subject profile (${i.subject}): ${SUBJECT_MIX[i.subject]!.quiz}` : "",
    ]
      .filter(Boolean)
      .join(" "),
  cards: (i) =>
    [
      `\`cards\`: ${i.counts.cards} flashcards, one idea each: \`term\` cards (a key term, formula or result on the front; its definition or meaning on the back) and \`cloze\` cards (a sentence copied from the passage on the front, the key words to blank on the back: never a function word, never most of the sentence).`,
      i.subject && SUBJECT_MIX[i.subject] ? `Subject profile (${i.subject}): ${SUBJECT_MIX[i.subject]!.cards}` : "",
    ]
      .filter(Boolean)
      .join(" "),
};

/** The kind-dependent tail: the only part of the prompt that differs between kinds. */
export function prepAsk(i: PrepInput): string {
  const asked = (["guide", "quiz", "cards"] as const).filter((k) => i.kinds.includes(k));
  const unasked = (["guide", "quiz", "cards"] as const).filter((k) => !i.kinds.includes(k));
  return [
    "## Write",
    ...asked.map((k) => ASK[k](i)),
    unasked.length ? `Set ${unasked.map((k) => `\`${k}\``).join(" and ")} to null.` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The guide review's input: the timeline's dates don't apply, so they're empty. */
export const guideInputOf = (i: PrepInput): GuideInput => ({ kind: "guide", scope: i.scope, materials: i.materials, topics: i.topics, facts: i.facts, dates: [] });

/** Per asked kind: how many parts code keeps and the reasons it drops the others. */
export function reviewPrep(output: StudyPrepOutput, input: PrepInput, context: CheckContext) {
  const out: Partial<Record<PrepKind, { generated: number; kept: number; errors: string[] }>> = {};
  if (input.kinds.includes("guide")) {
    if (!output.guide) out.guide = { generated: 0, kept: 0, errors: ["the guide was not returned"] };
    else {
      const r = reviewGuide("guide", output.guide, guideInputOf(input), context.passages);
      out.guide = { generated: r.stats.generated, kept: r.stats.accepted, errors: r.drops.map((d) => `guide ${d.at}: ${d.reason}`) };
    }
  }
  const drafts = (kind: "quiz" | "cards", list: Draft[] | null, count: number) => {
    if (!list) return { generated: 0, kept: 0, errors: [`the ${kind} was not returned`] };
    const all = list.slice(0, count);
    const failed = all.map((d) => ({ d, errors: draftErrors(d, context) })).filter((x) => x.errors.length);
    return { generated: all.length, kept: all.length - failed.length, errors: failed.flatMap((x) => x.errors.map((e) => `${kind} ${x.d.index + 1}: ${e}`)) };
  };
  if (input.kinds.includes("quiz")) out.quiz = drafts("quiz", output.quiz ? quizDrafts(output.quiz) : null, input.counts.quiz);
  if (input.kinds.includes("cards")) out.cards = drafts("cards", output.cards ? cardDrafts(output.cards) : null, input.counts.cards);
  return out;
}

/** Retried (then escalated, then put to the student) only when an asked part keeps fewer than half. */
export const prepCheck: PackCheck<PrepInput, StudyPrepOutput> = (output, input, context) => {
  const r = reviewPrep(output, input, context);
  const errors: string[] = [];
  for (const k of input.kinds) {
    const x = r[k]!;
    if (!x.generated) errors.push(`${k}: nothing was returned`);
    else if (x.kept < Math.ceil(x.generated / 2)) errors.push(...x.errors.slice(0, 10));
  }
  return errors;
};

export const studyPrepPack = definePack<PrepInput, StudyPrepOutput>({
  id: STUDY_PREP_PACK_ID,
  version: STUDY_PREP_PACK_VERSION,
  tier: "pass",
  system:
    "You write exam preparation material for a university student from their own course passages: a study guide, practice questions and flashcards, as asked. Be accurate and concise, in plain words, faithful to how the course states things. Return only JSON matching the schema.",
  template: (i) => `${prepContext(i)}\n\n${prepAsk(i)}`,
  schema: studyPrepOutputSchema,
  checks: [prepCheck],
  cacheKey: (i) => i,
  categories: ["course_text"],
  intent: "study-prep",
});
