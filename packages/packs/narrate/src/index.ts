/**
 * The agenda's "why now" pack (D49, D52): one call per agenda change writes one line for each top
 * item. The model narrates over code's facts in its own words, specialised to the course; code
 * then checks every number, weekday, month and relative day in each line and drops a line that
 * doesn't match (packages/core/src/priority/narrate.ts).
 */
import { z } from "zod";
import { definePack, type PackCheck } from "../../core/src/index";

export const NARRATE_PACK_VERSION = "v1";

export interface NarrateItemInput {
  id: string;
  kind: string;
  course: string;
  title: string;
  due: string;
  startBy: string;
  estimate: string;
  daysLeft: number;
  points: number | null;
  gradeWeight: string | null;
  status: string[];
  covers: string[];
}
export interface NarrateInput {
  /** "Saturday, September 27, 2026": the day the lines are written for. */
  today: string;
  items: NarrateItemInput[];
}
export const narrateOutputSchema = z
  .object({
    lines: z.array(z.object({ id: z.string().min(1).max(20), text: z.string().max(400) }).strict()).max(20),
  })
  .strict();
export type NarrateOutput = z.infer<typeof narrateOutputSchema>;

/** Structure only: each id once. The fact check is per line and drops rather than retries. */
const idsOnce: PackCheck<NarrateInput, NarrateOutput> = (output, input) => {
  const want = new Set(input.items.map((i) => i.id));
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const l of output.lines) {
    if (!want.has(l.id)) errors.push(`${l.id} is not one of the items`);
    else if (seen.has(l.id)) errors.push(`${l.id} has two lines`);
    seen.add(l.id);
  }
  return errors;
};

const describe = (i: NarrateItemInput) =>
  [
    `### ${i.id}: ${i.kind} in ${i.course}: "${i.title}"`,
    `${i.due}; start by ${i.startBy} to finish with a margin; ${i.estimate}; ${i.daysLeft} days left.`,
    i.points !== null ? `Points: ${i.points}.` : "",
    i.gradeWeight ? `Weight: ${i.gradeWeight}.` : "",
    i.status.length ? `Status: ${i.status.join("; ")}.` : "",
    i.covers.length ? `It draws on: ${i.covers.join("; ")}.` : "",
  ]
    .filter(Boolean)
    .join("\n");

export const narratePack = definePack<NarrateInput, NarrateOutput>({
  id: "agenda-why",
  version: NARRATE_PACK_VERSION,
  tier: "pass",
  system:
    "You are the student's study planner. The app has already ranked their coursework by how soon each item must be started; for each item, write one line (under 140 characters) on why it matters now, speaking to the student. Lead with the most decisive fact (the start-by time, what it's worth, what it builds on or prepares for), and use what you know about the subject to say what the work involves. Vary your wording from item to item; don't repeat a pattern. Use only the numbers, dates, weekdays and times given, written the same way, and say today or tomorrow only when a given date is. No emoji. Return only JSON matching the schema.",
  template: (i) => `Today is ${i.today}.\n\n${i.items.map(describe).join("\n\n")}\n\nWrite one line per item id.`,
  schema: narrateOutputSchema,
  checks: [idsOnce],
  cacheKey: (i) => i,
  categories: ["course_text"],
  intent: "agenda:why",
});
