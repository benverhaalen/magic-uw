/**
 * The shared shape both generation packs (quiz items, T45; flashcards) reduce their model output
 * to. The model writes; code decides: a draft is only a proposal until the pack handler grounds
 * its quote, maps its topics and runs the learning engines' checked-item pipeline (N06).
 */
import type { CheckContext, PackCheck } from "../../core/src/index";

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
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

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
export function batchCheck<O>(drafts: (output: O) => Draft[]): PackCheck<GenerationInput, O> {
  return (output, input, context) => {
    const all = drafts(output).slice(0, input.count);
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

/** The prompt part both packs share: sections and topics, and the grounding rules. */
export function sharedRules(input: GenerationInput): string {
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- (none yet)");
  return [
    `Sections already on the course map (use one of these when it fits; otherwise name the module or chapter the passage belongs to):\n${list(input.sections)}`,
    `Topics already on the course map (reuse these labels before inventing a new one):\n${list(input.topics)}`,
    input.focus.length ? `Only write about these topics:\n${list(input.focus)}` : "",
    "Rules: every item cites exactly one passage by its id in `sourceId` and copies a `quote` of 12 to 400 characters from that passage, character for character, that supports the answer. Tag each item with 1 to 3 short topic labels, the first being the main one, and one section. Never write about anything the passages don't state.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
