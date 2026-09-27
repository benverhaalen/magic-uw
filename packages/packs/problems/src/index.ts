/**
 * The `problems` pack (owner: exam-prep): step-by-step practice problems with a hint ladder and
 * a worked example, grounded in one verbatim quote. The model only writes; code decides. Every
 * problem is checked by `checkAuthored` in the learning engines before it is stored: the quote
 * is grounded, numeric formulas are recomputed, expressions are parsed under an allow-list,
 * nudges that state the answer are rejected, and Parsons lines must be copied from the passage.
 * One checked call per batch through the same runner, consent, receipts and cache as the other
 * generation packs.
 */
import { z } from "zod";
import { definePack } from "../../core/src/index";
import { batchCheck, sharedRules, type Draft, type GenerationInput } from "../../items/src/draft";
import type { AuthoredProblem } from "../../../learning/src/exam/problems";

const bloom = z.enum(["remember", "understand", "apply", "analyse", "evaluate"]);
const stepSchema = z
  .object({
    prompt: z.string().min(1).max(400),
    /** `order` only on the single step of a Parsons problem. */
    answerKind: z.enum(["numeric", "symbolic", "text", "order"]),
    numeric: z.object({ value: z.number(), unit: z.string().max(40).nullable(), formula: z.string().max(200).nullable() }).strict().nullable(),
    symbolic: z
      .object({ expr: z.string().min(1).max(200), variables: z.array(z.string().min(1).max(10)).max(6), form: z.enum(["any", "expanded", "factored"]) })
      .strict()
      .nullable(),
    text: z.object({ key: z.string().min(1).max(200), keyIdeas: z.array(z.string().min(1).max(120)).max(4) }).strict().nullable(),
    nudge: z.string().max(300),
    workedStep: z.string().max(500),
    explainPrompt: z.string().max(200).nullable(),
  })
  .strict();
export const problemSchema = z
  .object({
    stem: z.string().min(1).max(800),
    format: z.enum(["numeric", "symbolic", "parsons", "short_answer"]),
    bloom,
    topics: z.array(z.string().min(1).max(80)).min(1).max(3),
    section: z.string().min(1).max(120),
    sourceId: z.string().min(1).max(200),
    quote: z.string().max(400),
    steps: z.array(stepSchema).min(1).max(8),
    workedExample: z.array(z.string().min(1).max(500)).min(1).max(8),
    parsons: z.object({ code: z.string().max(2000), distractors: z.array(z.string().max(200)).max(3) }).strict().nullable(),
  })
  .strict();
export const problemsOutputSchema = z.object({ problems: z.array(problemSchema).max(10) }).strict();
export type ProblemsOutput = z.infer<typeof problemsOutputSchema>;

/** A draft carrying the authored problem; the handler stores it as a problem, not an item. */
export interface ProblemDraft extends Draft {
  solve: AuthoredProblem;
}
export const isProblemDraft = (d: Draft): d is ProblemDraft => "solve" in d && typeof (d as ProblemDraft).solve === "object";

export function problemDrafts(output: ProblemsOutput): ProblemDraft[] {
  return output.problems.map((p, index): ProblemDraft => {
    const missing = p.steps.findIndex(
      (s) =>
        (s.answerKind === "numeric" && !s.numeric) ||
        (s.answerKind === "symbolic" && !s.symbolic) ||
        (s.answerKind === "text" && !s.text) ||
        (s.answerKind === "order" && p.format !== "parsons"),
    );
    const problem =
      missing >= 0
        ? `step ${missing + 1} has no answer of its kind`
        : p.format === "parsons" && !p.parsons
          ? "a Parsons problem needs its code lines"
          : null;
    return {
      index,
      kind: p.format === "numeric" ? "numeric" : "cloze",
      stem: p.stem.trim(),
      options: null,
      key: "",
      unit: null,
      formula: null,
      keyIdeas: [],
      explanation: null,
      topics: p.topics.map((t) => t.trim()).filter(Boolean),
      section: p.section.trim(),
      bloom: p.bloom,
      sourceId: p.sourceId,
      quote: p.quote,
      problem,
      solve: {
        stem: p.stem.trim(),
        format: p.format,
        bloom: p.bloom,
        steps: p.steps.map((s) => ({
          prompt: s.prompt,
          answerKind: s.answerKind === "order" ? "text" : s.answerKind,
          numeric: s.numeric,
          symbolic: s.symbolic,
          text: s.text,
          nudge: s.nudge,
          workedStep: s.workedStep,
          explainPrompt: s.explainPrompt,
        })),
        workedExample: p.workedExample,
        parsons: p.parsons,
      },
    };
  });
}

export const problemsPack = definePack<GenerationInput, ProblemsOutput>({
  id: "problems",
  version: "v1",
  tier: "pass",
  system:
    "You write step-by-step practice problems for a university student from their own course passages, in the style the course itself uses. Each problem breaks into short steps a student answers one at a time. For every step give a nudge (a question or reminder that points toward the method and never states the step's answer or its number) and a worked step (the step done, with its answer). End with a worked example: one line per step. Return only JSON matching the schema.",
  template: (i) =>
    [
      sharedRules(i),
      `Write ${i.count} problems. Use only numbers, formulas and code that the passages give.`,
      "Numeric steps: give the value, its unit (or null) and the arithmetic formula from the given numbers, using + - * / and parentheses.",
      "Expression steps: plain ASCII math over the variables you list (x^2, sqrt(x), sin(x), exp(x), log(x)); say whether the answer must be expanded or factored, or any equivalent form.",
      "Text steps: a short key answer and up to 4 key ideas a correct answer states.",
      "For a passage with code, you may write a Parsons problem instead: format parsons, parsons.code copies 3 to 15 consecutive lines from the passage exactly, up to 3 plausible wrong lines as distractors, and one step with answerKind order.",
    ].join("\n\n"),
  schema: problemsOutputSchema,
  checks: [batchCheck(problemDrafts)],
  cacheKey: (i) => i,
  categories: ["course_text"],
  intent: "problems",
});
