/**
 * The course prefix: one byte-stable system prompt per course, shared by every course-scoped model
 * call (quiz and cards packs, the six guide kinds, grounded ask). It is the course brief
 * (`syllabus.md`, after a constant preamble), then the pack catalogue: every course pack's
 * instructions in a fixed order. The request names its pack, so switching packs keeps the warm
 * session and a repeat is a full prefix-cache hit.
 *
 * Size: the catalogue is about 0.8k tokens and a brief 0.2–2.1k on the live courses, far under the
 * 20k split point; no second session is needed.
 */
import { packCatalogue } from "../../../packs/core/src/index";
import { quizPack } from "../../../packs/items/src/index";
import { cardsPack } from "../../../packs/cards/src/index";
import { GUIDE_PACKS } from "../../../packs/guide/src/index";
import { askPack } from "../../../packs/intent/src/index";
import { briefPrompt, type CourseBriefSource } from "./brief";

/** Every pack whose calls are scoped to one course. The command-bar classifier is not: it has its own prefix. */
export function coursePacks() {
  return [quizPack, cardsPack, ...Object.values(GUIDE_PACKS), askPack];
}
let catalogue: string | undefined;
/** The pack catalogue for course prompts (computed once; the packs are constants). */
export function coursePackCatalogue(): string {
  return (catalogue ??= packCatalogue(coursePacks()));
}
/**
 * The system prompt for a course: preamble, brief, then the catalogue, with the resources the brief
 * draws on (for receipts). Undefined without a brief.
 */
export type CoursePrefixSource = (courseKey: string) => { text: string; resourceIds: string[] } | undefined;
export function coursePrefixes(briefs: CourseBriefSource | null): CoursePrefixSource {
  return (courseKey) => {
    const brief = briefs?.(courseKey);
    return brief ? { text: `${briefPrompt(brief)}\n\n${coursePackCatalogue()}`, resourceIds: brief.resourceIds } : undefined;
  };
}
