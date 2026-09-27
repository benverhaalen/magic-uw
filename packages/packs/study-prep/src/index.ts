/**
 * owner: study-prep. One pack for every study action of an item's space: a study guide (or summary,
 * or key points), a practice quiz, flashcards, practice problems, a practice exam and an outline
 * coach, over code-retrieved passages from the sources the student ticked.
 *
 * Efficiency decisions (recorded here, where they are enforced):
 * - One call for every kind asked together. The schema carries every part, each nullable, so
 *   "guide + cards + test" sends the passages once instead of three times.
 * - Separate asks stay cache-friendly. Everything the prompt holds before `## Write` (the item, its
 *   scope, materials, topics, facts and rules, and before them the course brief prefix and the
 *   passages) depends only on the item and its selection, never on the kinds, so a later ask for
 *   another kind repeats a byte-identical prefix the provider's prompt cache can reuse.
 * - Maths is TeX in generated prose only ($…$ inline, $$…$$ display). Quotes stay verbatim source
 *   text, so the code quote checks are unchanged; worked-example expressions, numeric formulas and
 *   answer expressions stay plain so code can recompute or prove them.
 * - Integrity: for graded work the student authors (problem sets, essays, labs, projects, posts,
 *   presentations), the pack coaches the concepts and never does the task; code rejects any
 *   problem that nearly copies the assigned work or a past exam.
 */
import { z } from "zod";
import { definePack, type CheckContext, type PackCheck } from "../../core/src/index";
import { quizDrafts, quizOutputSchema, SUBJECT_MIX, draftErrors, type Draft } from "../../items/src/index";
import { cardDrafts, cardsOutputSchema } from "../../cards/src/index";
import { guideOutputSchema, reviewGuide, MIN_QUOTE, type GuideInput } from "../../guide/src/index";
import { verifyAnswer } from "./problems";

export * from "./problems";

export const STUDY_PREP_PACK_ID = "study-prep";
/** Bump when the prompt or schema changes: the version is in the cache key. */
export const STUDY_PREP_PACK_VERSION = "v2";

export type PrepKind = "guide" | "quiz" | "cards" | "exam" | "problems" | "outline";
export const PREP_KINDS: readonly PrepKind[] = ["guide", "quiz", "cards", "exam", "problems", "outline"];
/** What code selected for the call. Every field shapes the prompt, so every field is in the cache key. */
export interface PrepInput {
  kinds: PrepKind[];
  counts: { quiz: number; cards: number; problems: number };
  /** The item's type (exam, quiz, problem_set, essay, …): it picks each kind's style. */
  itemType: string;
  /** Graded work the student authors: coach the concepts, never do the task. */
  authored: boolean;
  /** "Midterm 2 (2026-10-15). Stated scope: …" */
  scope: string;
  materials: string[];
  sections: string[];
  topics: string[];
  /** Topics the student narrowed to; empty for the whole scope. */
  focus: string[];
  facts: string[];
  subject?: string;
  /** Practice exam only: the form to mirror, from the blueprint (sections, formats, points, length). */
  exam: { form: string; totalPoints: number | null; minutes: number | null; problems: number } | null;
}

const option = z.object({ text: z.string().min(1).max(400), correct: z.boolean() }).strict();
export const problemSchema = z
  .object({
    number: z.string().min(1).max(12),
    section: z.string().max(120).nullable(),
    points: z.number().min(0).max(1000).nullable(),
    format: z.enum(["multiple_choice", "true_false", "numeric", "short_answer", "problem", "proof", "code", "essay"]),
    topic: z.string().min(1).max(80),
    prompt: z.string().min(1).max(2400),
    options: z.array(option).max(6).nullable(),
    answer: z
      .object({
        kind: z.enum(["choice", "numeric", "expression", "none"]),
        value: z.number().nullable(),
        unit: z.string().max(40).nullable(),
        formula: z.string().max(300).nullable(),
        expr: z.string().max(300).nullable(),
        derivation: z.string().max(300).nullable(),
        variables: z.array(z.string().min(1).max(12)).max(6),
      })
      .strict(),
    solution: z.string().min(1).max(4000),
    sources: z.array(z.object({ sourceId: z.string().min(1).max(200), quote: z.string().max(400) }).strict()).min(1).max(3),
  })
  .strict();
export type ProblemOutput = z.infer<typeof problemSchema>;
export const outlineSchema = z
  .object({
    title: z.string().min(1).max(160),
    focus: z.array(z.string().min(1).max(300)).max(6),
    sections: z
      .array(
        z
          .object({
            heading: z.string().min(1).max(120),
            questions: z.array(z.string().min(1).max(300)).max(6),
            evidence: z.array(z.object({ hint: z.string().min(1).max(200), sourceId: z.string().min(1).max(200), quote: z.string().max(400) }).strict()).max(4),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();
export type OutlineOutput = z.infer<typeof outlineSchema>;

export const studyPrepOutputSchema = z
  .object({
    guide: guideOutputSchema.nullable(),
    quiz: quizOutputSchema.nullable(),
    cards: cardsOutputSchema.nullable(),
    exam: z.object({ title: z.string().min(1).max(160), minutes: z.number().int().min(1).max(600).nullable(), problems: z.array(problemSchema).max(30) }).strict().nullable(),
    problems: z.object({ problems: z.array(problemSchema).max(12) }).strict().nullable(),
    outline: outlineSchema.nullable(),
  })
  .strict();
export type StudyPrepOutput = z.infer<typeof studyPrepOutputSchema>;

/** The TeX rule every study-prep call carries. Quotes are plain source text; TeX is only in what the model writes. */
export const MATH_RULE = [
  "Maths: write every formula, symbol and equation you write as TeX, inline between single dollar signs (for example $X(e^{j\\omega}) = \\sum_{n} x[n] e^{-j\\omega n}$) or displayed on its own between double dollar signs ($$\\int_{-\\infty}^{\\infty} |x(t)|^2 \\, dt$$).",
  "Use TeX only in text you write: guide text and headings, question stems, options, explanations, card fronts and backs, problem prompts and solutions. Write a literal dollar sign as \\$.",
  "A `quote` is copied character for character from its passage and is never rewritten as TeX. A cloze card's front is the quoted sentence exactly as the passage has it.",
  "Fields code checks stay plain: a worked example's `expression` and `result`, a numeric answer's `formula` (numbers, + - * / and parentheses), and an answer's `expr` and `derivation` (plain maths such as 3*x^2 or (x-1)*(x+1)).",
].join(" ");
export const INTEGRITY_RULE =
  "Integrity: this is graded work the student does themselves. Coach the concepts it uses and never do the task: don't solve, answer or write any part of the assigned work, and don't restate its problems with small changes.";

const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- (none found)");

/** The kind-independent part of the question: identical for every kind on the same item and selection. */
export function prepContext(i: PrepInput): string {
  return [
    `Item: ${i.itemType.replace(/_/g, " ")}. ${i.scope}`,
    `Materials in scope:\n${list(i.materials)}`,
    `Sections already on the course map (use one of these when it fits):\n${list(i.sections)}`,
    `Topics for this scope (reuse these labels before inventing one):\n${list(i.topics)}`,
    i.focus.length ? `Only write about these topics:\n${list(i.focus)}` : "",
    i.facts.length ? `Terms, definitions and formulas the app found in these materials:\n${list(i.facts)}` : "",
    "Grounding: everything you write cites passages by their id in `sourceId` and copies a `quote` of 12 to 400 characters from that passage, character for character, that supports it. Never state anything the passages don't support. Spread the work across the passages. Tag each question and card with 1 to 3 short topic labels, the first being the main one, and one section.",
    i.authored ? INTEGRITY_RULE : "",
    MATH_RULE,
  ]
    .filter(Boolean)
    .join("\n\n");
}

const GUIDE_STYLE: Record<string, string> = {
  reading: "`guide`: a summary of this material: 2 to 5 sections of `point` blocks in its own order, plus `definition` blocks for the terms it introduces.",
  lecture: "`guide`: a summary of this lecture: 2 to 5 sections of `point` blocks in its order, plus `definition` blocks for the terms and results it introduces and `example` blocks for its worked examples.",
  discussion_post: "`guide`: the key points of the readings the discussion is about: 2 to 5 sections, one per reading or theme, each with `point` blocks stating what the reading argues and its evidence. Never write the post.",
};
const CARD_STYLE: Record<string, string> = {
  problem_set: "Concept cards: definitions, formulas, results and when each applies; never a card that answers an assigned problem.",
  essay: "Reading cards: the readings' claims, key terms, authors, dates and evidence.",
  discussion_post: "Reading cards: the readings' claims, key terms and evidence.",
  lab: "Prelab cards: the procedure's steps and their purpose, the equipment, safety points and the ideas the lab tests.",
  project: "Concept cards: the methods, tools and definitions the project uses.",
  presentation: "Concept cards: the terms and facts the talk rests on.",
};
const QUIZ_STYLE: Record<string, string> = {
  lab: "A concept quiz for before the lab: what each step does and why, and the ideas it tests.",
  reading: "A quick quiz on this material only.",
  lecture: "A quick quiz on this lecture only.",
};

const ASK: Record<PrepKind, (i: PrepInput) => string> = {
  guide: (i) =>
    GUIDE_STYLE[i.itemType] ??
    "`guide`: a study guide for this item, 3 to 8 sections in course order, each with 2 to 6 blocks: `definition` blocks (heading = the term) for key terms, `point` blocks for what a student must understand, and `example` blocks for worked examples (give `expression` and `result` only when the example is arithmetic; otherwise null). Fields a block kind doesn't use are null.",
  quiz: (i) =>
    [
      `\`quiz\`: ${i.counts.quiz} practice questions. ${QUIZ_STYLE[i.itemType] ?? ""} Mix multiple choice (4 options, exactly one correct, plausible distractors of similar length, no "all/none of the above"), true/false statements, and numeric questions where the passages work a calculation (the value, its unit or null, and the arithmetic formula when the passage shows it). Emphasise a negation in capitals (NOT). Every question has an explanation.`,
      i.subject && SUBJECT_MIX[i.subject] ? `Subject profile (${i.subject}): ${SUBJECT_MIX[i.subject]!.quiz}` : "",
    ]
      .filter(Boolean)
      .join(" "),
  cards: (i) =>
    [
      `\`cards\`: ${i.counts.cards} flashcards, one idea each: \`term\` cards (a key term, formula or result on the front; its definition or meaning on the back) and \`cloze\` cards (a sentence copied from the passage on the front, the key words to blank on the back: never a function word, never most of the sentence). ${CARD_STYLE[i.itemType] ?? ""}`,
      i.subject && SUBJECT_MIX[i.subject] ? `Subject profile (${i.subject}): ${SUBJECT_MIX[i.subject]!.cards}` : "",
    ]
      .filter(Boolean)
      .join(" "),
  exam: (i) =>
    [
      `\`exam\`: a NEW practice exam that mirrors the form of this course's exam: ${i.exam?.form ?? "the question types the course uses"}.`,
      i.exam?.problems ? `Write ${i.exam.problems} problems.` : "Write 6 to 10 problems.",
      i.exam?.totalPoints ? `Points must add up to exactly ${i.exam.totalPoints}.` : "Give each problem its points.",
      "Cover the scope's topics in proportion; each problem's `topic` is one of the topic labels. Use different problems from any practice or past exam in the passages: new numbers, new situations, same skills. Give every problem its worked solution in TeX and its answer: `choice` with the options (exactly one correct), `numeric` with the value, unit and the plain arithmetic `formula` that gives it, `expression` with `expr`, a plain `derivation` form of the same answer from the solution and its `variables`, or `none` for a proof or essay.",
    ].join(" "),
  problems: (i) =>
    `\`problems\`: ${i.counts.problems} practice problems that use the same skills as the assigned work but are different problems (never the assigned ones or small variations of them), each with a worked solution in TeX and its answer (as for an exam: \`choice\`, \`numeric\` with its plain \`formula\`, \`expression\` with \`expr\`, \`derivation\` and \`variables\`, or \`none\`). Base each on a worked example or result in the passages.`,
  outline: () =>
    "`outline`: an outline coach, never the text itself: `focus` holds 2 to 5 questions that sharpen the main point or thesis; each section has a short heading (a few words), 2 to 4 questions the student answers in their own words, and evidence to look at (a short hint and a quote from the passages). Every `focus` entry and every question ends with a question mark. Write no sentences of the essay, post or talk.",
};

/** The kind-dependent tail: the only part of the prompt that differs between kinds. */
export function prepAsk(i: PrepInput): string {
  const asked = PREP_KINDS.filter((k) => i.kinds.includes(k));
  const unasked = PREP_KINDS.filter((k) => !i.kinds.includes(k));
  return ["## Write", ...asked.map((k) => ASK[k](i)), unasked.length ? `Set ${unasked.map((k) => `\`${k}\``).join(", ")} to null.` : ""].filter(Boolean).join("\n\n");
}

/** The guide review's input: the timeline's dates don't apply, so they're empty. */
export const guideInputOf = (i: PrepInput): GuideInput => ({ kind: "guide", scope: i.scope, materials: i.materials, topics: i.topics, facts: i.facts, dates: [] });

const collapse = (t: string) => t.replace(/\s+/g, " ").trim();
/** A quote is grounded when it is at least MIN_QUOTE long and appears verbatim in the passage it cites. */
export function groundedIn(context: CheckContext, sourceId: string, quote: string): string | null {
  const p = context.passages.find((x) => x.sourceId === sourceId);
  if (!p) return `cites ${sourceId}, which is not among the passages`;
  const q = collapse(quote);
  if (q.length < MIN_QUOTE) return `a quote in ${sourceId} is shorter than ${MIN_QUOTE} characters`;
  return collapse(p.text).includes(q) ? null : `quote not found verbatim in ${sourceId}: "${q.slice(0, 80)}"`;
}
/** Code's reasons to drop a problem, before near-copy (which needs the course's past exams). */
export function problemErrors(p: ProblemOutput, context: CheckContext): string[] {
  const errors: string[] = [];
  const grounded = p.sources.filter((s) => !groundedIn(context, s.sourceId, s.quote));
  if (!grounded.length) errors.push(groundedIn(context, p.sources[0]!.sourceId, p.sources[0]!.quote) ?? "no grounded quote");
  const v = verifyAnswer(p.answer, p.options);
  if ("reason" in v) errors.push(v.reason);
  return errors;
}
/** An outline entry that reads like the text itself (not a question, or long prose) is dropped. */
export function outlineProblems(o: OutlineOutput): string[] {
  const out: string[] = [];
  for (const q of [...o.focus, ...o.sections.flatMap((s) => s.questions)]) if (!q.trim().endsWith("?")) out.push(`not a question: "${q.slice(0, 60)}"`);
  for (const s of o.sections) if (s.heading.split(/\s+/).length > 12) out.push(`a heading reads like text: "${s.heading.slice(0, 60)}"`);
  return out;
}

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
  const drafts = (kind: "quiz" | "cards", l: Draft[] | null, count: number) => {
    if (!l) return { generated: 0, kept: 0, errors: [`the ${kind} was not returned`] };
    const all = l.slice(0, count);
    const failed = all.map((d) => ({ d, errors: draftErrors(d, context) })).filter((x) => x.errors.length);
    return { generated: all.length, kept: all.length - failed.length, errors: failed.flatMap((x) => x.errors.map((e) => `${kind} ${x.d.index + 1}: ${e}`)) };
  };
  if (input.kinds.includes("quiz")) out.quiz = drafts("quiz", output.quiz ? quizDrafts(output.quiz) : null, input.counts.quiz);
  if (input.kinds.includes("cards")) out.cards = drafts("cards", output.cards ? cardDrafts(output.cards) : null, input.counts.cards);
  const problems = (kind: "exam" | "problems", l: ProblemOutput[] | null) => {
    if (!l) return { generated: 0, kept: 0, errors: [`the ${kind} was not returned`] };
    const failed = l.map((p) => ({ p, errors: problemErrors(p, context) })).filter((x) => x.errors.length);
    return { generated: l.length, kept: l.length - failed.length, errors: failed.flatMap((x) => x.errors.map((e) => `${kind} problem ${x.p.number}: ${e}`)) };
  };
  if (input.kinds.includes("exam")) {
    const r = problems("exam", output.exam?.problems ?? null);
    // The point totals must add up to the exam's stated total.
    const total = (output.exam?.problems ?? []).reduce((s, p) => s + (p.points ?? 0), 0);
    if (output.exam && input.exam?.totalPoints && Math.abs(total - input.exam.totalPoints) > 1e-9) r.errors.unshift(`exam points add up to ${total}, not ${input.exam.totalPoints}`), (r.kept = 0);
    out.exam = r;
  }
  if (input.kinds.includes("problems")) out.problems = problems("problems", output.problems?.problems ?? null);
  if (input.kinds.includes("outline")) {
    if (!output.outline) out.outline = { generated: 0, kept: 0, errors: ["the outline was not returned"] };
    else {
      const issues = outlineProblems(output.outline);
      const entries = output.outline.focus.length + output.outline.sections.reduce((n, s) => n + s.questions.length, 0);
      out.outline = { generated: entries, kept: entries - issues.length, errors: issues.map((e) => `outline: ${e}`) };
    }
  }
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
  escalate: false, // items are checked one by one: failures are dropped, never escalated to the strong model
  system:
    "You write study material for a university student from their own course passages: study guides, practice questions, flashcards, practice problems, practice exams and outline coaching, as asked. Be accurate and concise, in plain words, faithful to how the course states things. Return only JSON matching the schema.",
  template: (i) => `${prepContext(i)}\n\n${prepAsk(i)}`,
  schema: studyPrepOutputSchema,
  checks: [prepCheck],
  cacheKey: (i) => i,
  categories: ["course_text"],
  intent: "study-prep",
});
