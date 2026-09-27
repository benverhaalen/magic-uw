/**
 * The passages job (T11b). Ingest splits a changed version inline, in its own transaction, so
 * search never shows an old version. This job re-splits a live resource's current version when
 * the passages must be rebuilt without new content: a splitter version change, or a backfill.
 * Its input hash is the resource's text hash, so a grade or submission change doesn't stale it.
 */
import type { CourseCoreStore } from "../../../contracts/src/course-core";
import type { DrainHandler } from "../drain";

export const PASSAGES_JOB_KIND = "passages.build";

export function passagesHandler(store: Pick<CourseCoreStore, "rebuildPassages">): DrainHandler {
  return (job) => {
    if (job.subjectKind !== "resource") throw new Error("A passages job's subject is a resource.");
    store.rebuildPassages(job.subjectId);
  };
}

/** Queue a rebuild for one resource at its current text hash. False when stale or already queued. */
export function enqueuePassages(
  store: Pick<CourseCoreStore, "enqueueSubject">,
  resourceId: string,
  textHash: string,
  now: string,
): boolean {
  return store.enqueueSubject(
    { kind: PASSAGES_JOB_KIND, subjectKind: "resource", subjectId: resourceId, inputHash: textHash },
    now,
  );
}
