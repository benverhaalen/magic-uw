/**
 * The passages job (T11b). Ingest splits a changed version inline, in its own transaction, so
 * search never shows an old version. This job re-splits a live resource's current version when
 * the passages must be rebuilt without new content: a splitter version change, or a backfill.
 */
import type { Store } from "@magic/contracts";
import type { CourseCoreStore } from "../../../contracts/src/course-core";
import type { JobHandler } from "./registry";

/**
 * The material pipeline's `passages.resource` (enqueued on save for every resource with text):
 * makes sure the current version is split and indexed. Ingest already indexes inline, so this is
 * usually a check; it rebuilds when the passages are missing or belong to an older version.
 */
export const passagesResourceJob: JobHandler = {
  kind: "passages.resource",
  subject: "resource",
  owner: "pipeline",
  ready: true,
  onSave: (resource) => resource.text.length > 0,
  async run(job, { store }) {
    const s = store as Store & Partial<CourseCoreStore>;
    if (!s.passages || !s.rebuildPassages) return { status: "retry", error: "This store has no passage index." };
    const resource = store.resource(job.resourceId);
    if (!resource || resource.deleted) return { status: "done" };
    const current = s.passages(resource.id);
    if (!current.length || current.some((p) => p.version !== resource.version)) s.rebuildPassages(resource.id);
    return { status: "done" };
  },
};
