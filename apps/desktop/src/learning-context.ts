import { createHash } from "node:crypto";
import type { ContextManifest, Resource, Store } from "@magic/contracts";
type Privacy = ReturnType<Store["privacy"]>;
type Source = ReturnType<Store["sources"]>[number];
import { eligibleStudySource, type StudyContext } from "../../../packages/learning/src/router";

type ContextCore = {
  context(id: string, recipient: "local"): ContextManifest;
  /** Optional batch: the same manifests as `context`, with one call's reads shared. */
  contexts?(ids: readonly string[], recipient: "local"): (ContextManifest | null)[];
};
export interface StudyContextResolver {
  (resourceId: string): StudyContext | null;
  /** Every anchor at once, set-based: the same contexts as resolving each, one read of the workspace. */
  many(resourceIds: readonly string[]): (StudyContext | null)[];
}

/** Local evidence selection shared by the desktop and preview. Nothing here sends data. */
export function createStudyContextResolver(store: Store, core: ContextCore): StudyContextResolver {
  function build(
    resourceId: string,
    target: Resource,
    owner: Source,
    manifest: ContextManifest,
    sources: Source[],
    resource: (id: string) => Resource | undefined,
    privacy: Privacy,
  ): StudyContext | null {
    // Do not expose saved excerpts from an excluded course through session reads.
    if (!manifest.allowed) return null;
    const records = manifest.resourceIds.flatMap(id => {
      const resource_ = resource(id);
      const source = resource_ && sources.find(candidate => candidate.id === resource_.sourceId);
      if (!resource_ || resource_.deleted || !source ||
          source.accountScope !== owner.accountScope || resource_.courseId !== target.courseId ||
          source.courseId !== owner.courseId || !eligibleStudySource(resource_)) return [];
      return [{ resource: resource_, source }];
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
      privacy,
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
  }
  const resolve = ((resourceId: string) => {
    const target = store.resource(resourceId);
    if (!target || target.deleted || target.kind !== "assignment") return null;
    const sources = store.sources();
    const owner = sources.find(source => source.id === target.sourceId);
    if (!owner) return null;
    const manifest = core.context(resourceId, "local");
    return build(resourceId, target, owner, manifest, sources, (id) => store.resource(id), store.privacy());
  }) as StudyContextResolver;
  resolve.many = (resourceIds) => {
    // One sources, privacy and manifest read for the batch; each supporting resource read once.
    const sources = store.sources();
    const targets = resourceIds.map((id) => {
      const target = store.resource(id);
      if (!target || target.deleted || target.kind !== "assignment") return null;
      const owner = sources.find(source => source.id === target.sourceId);
      return owner ? { target, owner } : null;
    });
    const wanted = resourceIds.filter((_, i) => targets[i]);
    const manifests = core.contexts
      ? core.contexts(wanted, "local")
      : wanted.map((id) => core.context(id, "local"));
    const byId = new Map(wanted.map((id, i) => [id, manifests[i]]));
    const cache = new Map<string, Resource | undefined>();
    const resource = (id: string) => {
      if (!cache.has(id)) cache.set(id, store.resource(id));
      return cache.get(id);
    };
    const privacy = store.privacy();
    return resourceIds.map((resourceId, i) => {
      const found = targets[i];
      const manifest = byId.get(resourceId);
      return found && manifest ? build(resourceId, found.target, found.owner, manifest, sources, resource, privacy) : null;
    });
  };
  return resolve;
}
