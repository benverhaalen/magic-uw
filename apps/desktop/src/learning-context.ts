import { createHash } from "node:crypto";
import type { ContextManifest, Store } from "@magic/contracts";
import { eligibleStudySource, type StudyContext } from "../../../packages/learning/src/router";

/** Local evidence selection shared by the desktop and preview. Nothing here sends data. */
export function createStudyContextResolver(
  store: Store,
  core: { context(id: string, recipient: "local"): ContextManifest },
): (resourceId: string) => StudyContext | null {
  return (resourceId) => {
    const target = store.resource(resourceId);
    if (!target || target.deleted || target.kind !== "assignment") return null;
    const sources = store.sources();
    const owner = sources.find(source => source.id === target.sourceId);
    if (!owner) return null;
    const manifest = core.context(resourceId, "local");
    // Do not expose saved excerpts from an excluded course through session reads.
    if (!manifest.allowed) return null;
    const records = manifest.resourceIds.flatMap(id => {
      const resource = store.resource(id);
      const source = resource && sources.find(candidate => candidate.id === resource.sourceId);
      if (!resource || resource.deleted || !source ||
          source.accountScope !== owner.accountScope || resource.courseId !== target.courseId ||
          source.courseId !== owner.courseId || !eligibleStudySource(resource)) return [];
      return [{ resource, source }];
    });
    const blocked = (manifest.effectivePolicy?.mode ?? target.policy.mode) === "restricted";
    const stale = [owner, ...records.map(record => record.source)]
      .some(source => source.status !== "ok" || !source.complete);
    const availability = blocked ? "blocked" : stale ? "stale" : "current";
    // Pin policy, source versions and settings as well as the selected assignment.
    const contextHash = createHash("sha256").update(JSON.stringify({
      target: target.contentHash,
      accountScope: owner.accountScope,
      policy: manifest.effectivePolicy ?? target.policy,
      privacy: store.privacy(),
      sources: records.map(({ resource }) => [resource.id, resource.contentHash]),
      availability,
    })).digest("hex");
    return {
      resourceId, accountScope: owner.accountScope, courseId: target.courseId,
      inputHash: target.contentHash, contextHash, label: target.courseName, availability,
      reason: blocked ? "Course policy restricts AI-assisted practice on this work."
        : stale ? "Some course evidence is incomplete or needs refreshing. Saved work is preserved."
        : "Practice uses checked course material. This is not a grade prediction.",
      resources: records.map(({ resource }) => ({
        id: resource.id, contentHash: resource.contentHash, text: resource.text,
        title: resource.title, url: resource.url, observedAt: resource.observedAt, eligible: true,
      })),
    };
  };
}
