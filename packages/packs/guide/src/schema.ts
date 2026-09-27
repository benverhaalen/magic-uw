/**
 * Study guides: the output schemas the student's AI fills in one checked call. Sections, then
 * blocks; every block carries the `{sourceId, quote}` code checks against the passages sent.
 * One flat block shape serves every kind (strict structured output needs closed objects with
 * every property required, so fields a kind doesn't use are null).
 */
import { z } from "zod";

export const GUIDE_KINDS = ["guide", "briefing", "faq", "timeline", "compare", "conceptmap"] as const;
export type GuideKind = (typeof GUIDE_KINDS)[number];
export const isGuideKind = (name: string): name is GuideKind => (GUIDE_KINDS as readonly string[]).includes(name);

export const BLOCK_KINDS = ["point", "definition", "example", "question", "event", "row"] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];
/** The block kinds each document kind may contain; anything else is dropped by code. */
export const BLOCKS_FOR: Record<Exclude<GuideKind, "conceptmap">, readonly BlockKind[]> = {
  guide: ["point", "definition", "example"],
  briefing: ["point"],
  faq: ["question"],
  timeline: ["event"],
  compare: ["row", "point"],
};

const label = z.string().min(1).max(80);
export const guideBlockSchema = z
  .object({
    kind: z.enum(BLOCK_KINDS),
    /** The topic this block teaches: one label, reusing the course's topic labels. */
    topic: label,
    /** definition: the term; question: the question; row: the attribute compared; else null. */
    heading: z.string().max(200).nullable(),
    /** The explanation, answer or event description, in the student's words. */
    text: z.string().min(1).max(1200),
    /** example only: arithmetic using numbers, + - * / and parentheses; code recomputes it. */
    expression: z.string().max(200).nullable(),
    /** example only: the result the expression gives, with its unit when it has one. */
    result: z.string().max(80).nullable(),
    /** event only: YYYY-MM-DD. */
    date: z.string().max(10).nullable(),
    /** row only: one cell per column of the section. */
    cells: z.array(z.string().max(300)).max(6).nullable(),
    sourceId: z.string().min(1).max(200),
    quote: z.string().max(400),
  })
  .strict();
export const guideSectionSchema = z
  .object({
    title: z.string().min(1).max(160),
    topics: z.array(label).min(1).max(4),
    /** compare only: the things compared (2 to 6); else null. */
    columns: z.array(z.string().min(1).max(80)).max(6).nullable(),
    blocks: z.array(guideBlockSchema).max(12),
  })
  .strict();
export const guideOutputSchema = z
  .object({ title: z.string().min(1).max(160), sections: z.array(guideSectionSchema).max(12) })
  .strict();
export type GuideOutput = z.infer<typeof guideOutputSchema>;
export type GuideBlockOutput = z.infer<typeof guideBlockSchema>;

export const EDGE_KINDS = ["prerequisite", "part_of", "confused_with"] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];
export const conceptMapOutputSchema = z
  .object({
    title: z.string().min(1).max(160),
    nodes: z
      .array(
        z
          .object({
            id: z.string().min(1).max(40),
            label,
            sourceId: z.string().max(200).nullable(),
            quote: z.string().max(400).nullable(),
          })
          .strict(),
      )
      .max(40),
    edges: z
      .array(
        z
          .object({
            from: z.string().min(1).max(40),
            to: z.string().min(1).max(40),
            kind: z.enum(EDGE_KINDS),
            sourceId: z.string().max(200).nullable(),
            quote: z.string().max(400).nullable(),
          })
          .strict(),
      )
      .max(80),
  })
  .strict();
export type ConceptMapOutput = z.infer<typeof conceptMapOutputSchema>;

/** What code selected for the call. Every field shapes the prompt, so every field is in the cache key. */
export interface GuideInput {
  kind: GuideKind;
  /** "Module …" or "Exam: …" with the stated scope. */
  scope: string;
  /** Titles of the materials in scope. */
  materials: string[];
  /** Topic labels for the scope, chosen by code (map, profile, material facts). */
  topics: string[];
  /** Terms, definitions and formulas code found in the materials (material_facts); may be empty. */
  facts: string[];
  /** Canonical dates (YYYY-MM-DD) for the scope; the timeline uses them. */
  dates: string[];
}
