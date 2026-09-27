/**
 * `link.resource` (the material pipeline): one resource's outgoing references (body links resolved
 * to stored resources or compact external records, files and pages it names) and its quoted,
 * code-first facts. Code only. T20's Jev map links (map_links, plan §3) stay a separate job.
 */
import { courseOfSource, isPipelineStore, linkResource } from "../graph/index";
import { stubHandler, type JobHandler } from "./registry";

/** Kept for the default (stub) registry. */
export const linkJob = stubHandler("link.resource", "resource", "T20");

export const linkResourceJob: JobHandler = {
  kind: "link.resource",
  subject: "resource",
  owner: "pipeline",
  ready: true,
  onSave: (r) => !!(r.text || r.links?.length || r.moduleItem?.externalUrl) && r.kind !== "event" && r.kind !== "course",
  async run(job, { store, now }) {
    if (!isPipelineStore(store)) return { status: "retry", error: "This store has no course graph." };
    const resource = store.resource(job.resourceId);
    if (!resource || resource.deleted || resource.contentHash !== job.inputHash) return { status: "done" };
    const course = courseOfSource(store, resource.sourceId);
    if (!course) return { status: "done" };
    const report = linkResource(store, course, resource.id, now());
    return report.errors.length ? { status: "retry", error: report.errors[0]!.slice(0, 500) } : { status: "done" };
  },
};
