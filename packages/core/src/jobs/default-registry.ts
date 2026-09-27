/**
 * The material pipeline's registry (the desktop worker passes it to core): passages, links and
 * facts, and the course pass are real code jobs; cards (T20) stay a stub, never enqueued or
 * leased. Core adds Jev's `enrich.resource` (`./enrich`) to whatever registry it is given, and
 * runs them all in its one drain (`./pipeline`).
 */
import type { JobRegistry } from "./registry";
import { cardJob } from "./card";
import { linkResourceJob } from "./link";
import { compileCourseJob } from "./compile";
import { passagesResourceJob } from "./passages";
import { createJobRegistry } from "./registry";

export function pipelineJobRegistry(): JobRegistry {
  return createJobRegistry([passagesResourceJob, cardJob, linkResourceJob, compileCourseJob]);
}
/**
 * owner: drain. The registry the desktop app runs, with the pipeline loop's `derive` on: passages,
 * facts and references and the course pass are reconciled in batches (`./derive`), so nothing is
 * queued per row for them. Only kinds that need a queue stay (the cards stub; core adds Jev's).
 * `pipelineJobRegistry` keeps the per-row path, which the equivalence test compares against.
 */
export function appJobRegistry(): JobRegistry {
  return createJobRegistry([cardJob]);
}
