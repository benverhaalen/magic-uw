/**
 * The six study-guide packs: one checked call each on the student's own AI. Code chose the
 * passages, topics, facts and dates; the model writes; code keeps only what it can check.
 */
import { definePack, type PackSpec } from "../../core/src/index";
import { guideCheck, topicName } from "./review";
import { conceptMapOutputSchema, guideOutputSchema, type ConceptMapOutput, type GuideInput, type GuideKind, type GuideOutput } from "./schema";

/** Bump when a prompt or schema changes: the version is in the cache key. */
export const GUIDE_PACK_VERSION = "v1";

const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- (none found)");
function shared(i: GuideInput): string {
  const topics = i.topics.map(topicName);
  return [
    `Scope: ${i.scope}`,
    `Materials in scope:\n${list(i.materials)}`,
    `Topics for this scope (reuse these labels; name a new topic only when the passages clearly teach one):\n${list([...new Set(topics)])}`,
    i.facts.length ? `Terms, definitions and formulas the app found in these materials:\n${list(i.facts)}` : "",
    "Grounding rules: every block cites exactly one passage by its id in `sourceId` and copies a `quote` of 12 to 400 characters from that passage, character for character, that supports the block. Never state anything the passages don't support. Fields a block kind doesn't use are null.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

const ASK: Record<Exclude<GuideKind, "conceptmap">, string> = {
  guide:
    "Write a study guide: 3 to 8 sections, one per main topic in course order, each with 2 to 6 blocks. Use `definition` blocks (heading = the term) for key terms, `point` blocks for the ideas a student must understand, and `example` blocks for worked examples. A worked example gives `expression` (numbers, + - * / and parentheses, units allowed) and `result` (the value it gives, with its unit); the app recomputes it and drops a wrong one.",
  briefing:
    "Write a briefing document: the most important takeaways for this scope, 2 to 5 sections of `point` blocks, most important first. Each point is one or two sentences.",
  faq:
    "Write an FAQ: the questions a student is most likely to have about this scope, grouped into 2 to 5 sections. Each block is a `question` (heading = the question, text = the answer).",
  timeline:
    "Write a timeline: the dated events, deadlines and sessions in this scope, as `event` blocks with `date` as YYYY-MM-DD. Use only dates the passages state or the course dates listed; never infer a year the course doesn't give.",
  compare:
    "Write comparison tables: 1 to 4 sections, each comparing 2 to 6 things the course contrasts or a student could confuse. `columns` names the things compared; each `row` block has heading = the attribute and `cells` = one entry per column, in column order. A `point` block may summarise the key difference.",
};

function guidePack(kind: Exclude<GuideKind, "conceptmap">): PackSpec<GuideInput, GuideOutput> {
  return definePack<GuideInput, GuideOutput>({
    id: kind,
    version: GUIDE_PACK_VERSION,
    tier: "pass",
    system:
      "You write study material for a university student from their own course passages, in the style of a strong teaching assistant: accurate, concise, in plain words, faithful to how the course states things. Return only JSON matching the schema.",
    template: (i) => `${shared(i)}\n\n${kind === "timeline" ? `Course dates:\n${list(i.dates)}\n\n` : ""}${ASK[kind]}`,
    schema: guideOutputSchema,
    checks: [guideCheck<GuideOutput>(kind)],
    cacheKey: (i) => i,
    categories: ["course_text"],
    intent: `guide:${kind}`,
  });
}

export const conceptMapPack = definePack<GuideInput, ConceptMapOutput>({
  id: "conceptmap",
  version: GUIDE_PACK_VERSION,
  tier: "pass",
  system:
    "You map how a university course's topics relate, from the student's own course passages. Return only JSON matching the schema.",
  template: (i) =>
    `${shared(i)}\n\nCourse map (topic > the unit or topic it belongs to):\n${list(i.topics.filter((t) => t.includes(" > ")))}\n\nWrite a concept map: nodes are topics (short ids like n1, n2; labels reuse the topic labels), each with a quote that introduces it when there is one (else sourceId and quote are null). Edges: \`prerequisite\` (from must be understood before to), \`part_of\` (from is part of to), \`confused_with\` (the passages warn these are easily mixed up). Every edge needs a quote that states the relation; a \`part_of\` edge already on the course map may have null sourceId and quote.`,
  schema: conceptMapOutputSchema,
  checks: [guideCheck<ConceptMapOutput>("conceptmap")],
  cacheKey: (i) => i,
  categories: ["course_text"],
  intent: "guide:conceptmap",
});

export const GUIDE_PACKS: Record<GuideKind, PackSpec<GuideInput, GuideOutput> | PackSpec<GuideInput, ConceptMapOutput>> = {
  guide: guidePack("guide"),
  briefing: guidePack("briefing"),
  faq: guidePack("faq"),
  timeline: guidePack("timeline"),
  compare: guidePack("compare"),
  conceptmap: conceptMapPack,
};
