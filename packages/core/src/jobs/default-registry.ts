/**
 * The default job registry and the per-job runner (T05b). The course-core drain in `../drain`
 * (T10: `createDrain`, `lease(kinds[])`) is the long-term path; core wires onto it in a follow-up.
 */
import type { Job, Store } from "@magic/contracts";
import type { JobOutcome, JobRegistry } from "./registry";
import { cardJob } from "./card";
import { linkJob, linkResourceJob } from "./link";
import { compileCourseJob, compileJob } from "./compile";
import { passagesResourceJob } from "./passages";
import { stubHandler } from "./registry";
import { createJobRegistry } from "./registry";

/** The resource-passages stub kind; T10's real passages job runs through the course-core drain. */
const passagesJob = stubHandler("passages.resource", "resource", "T10");

/** The registry every core instance starts with: the known kinds, all stubs until built. */
export function defaultJobRegistry(): JobRegistry {
  return createJobRegistry([passagesJob, cardJob, linkJob, compileJob]);
}
/**
 * The material pipeline's registry (the desktop worker passes it to core): passages, links and
 * facts, and the course pass are real code jobs; cards (T20) stay a stub. Nothing here sends.
 */
export function pipelineJobRegistry(): JobRegistry {
  return createJobRegistry([passagesResourceJob, cardJob, linkResourceJob, compileCourseJob]);
}
/**
 * Runs one leased job through its handler and records the outcome. Returns false when the
 * drain should stop for this wake (a handler refused, for example on consent).
 */
export async function runRegistered(
  job: Job,
  registry: JobRegistry,
  store: Store,
  now: () => string,
  signal: AbortSignal,
): Promise<boolean> {
  const handler = registry.get(job.kind);
  if (!handler) {
    store.finish(job, "Unsupported job kind", now());
    return true;
  }
  let outcome: JobOutcome;
  try {
    outcome = await handler.run(job, { store, now, signal });
  } catch {
    outcome = { status: "retry", error: "Job failed; local data is still usable" };
  }
  if (signal.aborted) return false;
  store.finish(job, outcome.status === "done" ? undefined : outcome.error, now());
  return outcome.status !== "stop";
}
