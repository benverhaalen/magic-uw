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
