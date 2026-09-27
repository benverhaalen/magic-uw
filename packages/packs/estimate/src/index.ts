/**
 * The effort-estimate pack (D49): one checked call per course batch on the student's own AI.
 * Code chose the items and wrote its own estimate from structured facts (kind, points, questions,
 * rubric, linked material size); the model reads the instructions and the course profile and
 * refines each number. Code then bounds it (5 min–40 h) and labels it "estimate".
 */
import { z } from "zod";
import { definePack, type PackCheck } from "../../core/src/index";

export const ESTIMATE_PACK_VERSION = "v1";

export interface EstimateItemInput {
  /** A short local id (e1, e2…); never a Canvas or database id. */
  id: string;
  kind: "assignment" | "quiz" | "exam" | "discussion";
  title: string;
  points: number | null;
  questions: number | null;
  rubricCriteria: number;
  /** Linked readings code found in the course, with their size. */
  materials: string[];
  /** Code's estimate and what it was built from. */
  codeMinutes: number;
  codeBasis: string[];
  /** The item's own instructions, clipped. */
  instructions: string;
}
export interface EstimateInput {
  items: EstimateItemInput[];
}
export const estimateOutputSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            id: z.string().min(1).max(20),
            /** Minutes of focused work for this student, as a whole number. */
            minutes: z.number(),
            /** One short clause on what drives the time; null when nothing stands out. */
            basis: z.string().max(200).nullable(),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();
export type EstimateOutput = z.infer<typeof estimateOutputSchema>;

/** Every item answered exactly once, with a positive, finite number of minutes. */
const everyItemOnce: PackCheck<EstimateInput, EstimateOutput> = (output, input) => {
  const errors: string[] = [];
  const want = new Set(input.items.map((i) => i.id));
  const seen = new Set<string>();
  for (const row of output.items) {
    if (!want.has(row.id)) errors.push(`${row.id} is not one of the items`);
    else if (seen.has(row.id)) errors.push(`${row.id} is answered twice`);
    seen.add(row.id);
    if (!Number.isFinite(row.minutes) || row.minutes <= 0) errors.push(`${row.id}: minutes must be a positive number`);
  }
  for (const id of want) if (!seen.has(id)) errors.push(`${id} has no estimate`);
  return errors;
};

const describe = (i: EstimateItemInput) =>
  [
    `### ${i.id}: ${i.kind}, "${i.title}"`,
    `Points: ${i.points ?? "not stated"}. Questions: ${i.questions ?? "not stated"}. Rubric criteria: ${i.rubricCriteria || "none captured"}.`,
    `Linked materials: ${i.materials.length ? i.materials.join("; ") : "none found"}.`,
    `The app's rule of thumb: ${i.codeMinutes} min (${i.codeBasis.join(", ")}).`,
    `Instructions:\n${i.instructions || "(no instructions captured)"}`,
  ].join("\n");

export const estimatePack = definePack<EstimateInput, EstimateOutput>({
  id: "agenda-estimate",
  version: ESTIMATE_PACK_VERSION,
  tier: "pass",
  system:
    "You estimate how long a university student needs to finish each piece of their own coursework, as a teaching assistant who knows the subject would. Read each item's instructions against the course profile: what is actually asked, how much writing, problem solving, reading or studying it takes in this subject, and what the linked materials add. The app's rule of thumb is a starting point, not an anchor: move it as far as the instructions justify. For an exam, estimate total study time. Answer in whole minutes of focused work. Return only JSON matching the schema.",
  template: (i) => `${i.items.map(describe).join("\n\n")}\n\nGive one estimate per item id, in minutes, with a short basis.`,
  schema: estimateOutputSchema,
  checks: [everyItemOnce],
  cacheKey: (i) => i,
  categories: ["course_text"],
  intent: "agenda:estimate",
});
