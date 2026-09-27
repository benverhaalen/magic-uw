/**
 * The last guide made for a scope, so a changed source serves it marked stale (with the changed
 * sources listed) instead of "missing", until the student asks for a new one. Stored as one
 * `learning_artifacts` row per (kind, course, scope) with a deterministic id and cache key; no
 * table or column is added. It holds the checked document, never the model's raw output.
 */
import { createHash } from "node:crypto";
import type { PackScope } from "@magic/contracts";
import type { ArtifactKind, LearningStore } from "../../../learning/src/store";
import type { ConceptMapDoc, GuideDoc, GuideDrop } from "./review";
import type { GuideKind } from "./schema";

export interface LatestGuide {
  v: 1;
  kind: GuideKind;
  packVersion: string;
  cacheKey: string;
  artifactId: string;
  createdAt: string;
  doc: GuideDoc | ConceptMapDoc;
  drops: GuideDrop[];
  /** The resources whose passages were sent, at the content they had then. */
  sources: { resourceId: string; contentHash: string; title: string }[];
  /** Every resource the scope held then, to tell added material apart. */
  scopeResources: string[];
}
export type SourceChange = { resourceId: string; title: string; change: "changed" | "removed" | "added" };

const POINTER_PACK = "guide-latest";
const sorted = (xs?: string[]) => [...(xs ?? [])].sort();
export function latestKey(kind: GuideKind, courseRef: string, scope: PackScope): string {
  const body = JSON.stringify([POINTER_PACK, kind, courseRef, scope.moduleId ?? null, scope.assessmentId ?? null, sorted(scope.resourceIds), sorted(scope.topicIds)]);
  return `${POINTER_PACK}-${createHash("sha256").update(body).digest("hex")}`;
}

export function putLatest(learning: LearningStore, courseRef: string, scope: PackScope, latest: LatestGuide): void {
  const key = latestKey(latest.kind, courseRef, scope);
  learning.putArtifact({
    id: key,
    courseRef,
    kind: "pack" as ArtifactKind,
    scope: { pointer: POINTER_PACK, kind: latest.kind },
    cacheKey: key,
    body: latest,
    removedCount: 0,
    status: "ready",
    generator: null,
    pack: POINTER_PACK,
    packVersion: "v1",
    createdAt: latest.createdAt,
    sources: [],
  });
}

const isLatest = (body: unknown): body is LatestGuide => {
  const b = body as Partial<LatestGuide> | null;
  return !!b && b.v === 1 && typeof b.cacheKey === "string" && typeof b.packVersion === "string" && !!b.doc && Array.isArray(b.sources) && Array.isArray(b.scopeResources);
};
export function readLatest(learning: LearningStore, kind: GuideKind, courseRef: string, scope: PackScope): LatestGuide | null {
  const row = learning.artifact(latestKey(kind, courseRef, scope));
  return row && isLatest(row.body) && row.body.kind === kind ? row.body : null;
}

/** Which sources differ from the ones the guide was made from; code compares content hashes. */
export function changedSources(
  latest: LatestGuide,
  current: (resourceId: string) => { contentHash: string; title: string; deleted: boolean } | undefined,
  scopeNow: { id: string; title: string }[],
): SourceChange[] {
  const out: SourceChange[] = [];
  for (const s of latest.sources) {
    const r = current(s.resourceId);
    if (!r || r.deleted) out.push({ resourceId: s.resourceId, title: s.title, change: "removed" });
    else if (r.contentHash !== s.contentHash) out.push({ resourceId: s.resourceId, title: r.title, change: "changed" });
  }
  const before = new Set(latest.scopeResources);
  for (const r of scopeNow) if (!before.has(r.id)) out.push({ resourceId: r.id, title: r.title, change: "added" });
  return out;
}

/** A stale document keeps its quotes but loses the offsets into material that changed. */
export function withoutChangedSpans<D extends GuideDoc | ConceptMapDoc>(doc: D, changed: Set<string>): D {
  const strip = <S extends { resourceId: string | null; start: number | null; end: number | null }>(s: S): S =>
    s.resourceId && changed.has(s.resourceId) ? { ...s, start: null, end: null } : s;
  if (doc.kind === "conceptmap")
    return {
      ...doc,
      nodes: doc.nodes.map((n) => ({ ...n, source: n.source && strip(n.source) })),
      edges: doc.edges.map((e) => ({ ...e, source: e.source && strip(e.source) })),
    } as D;
  return { ...doc, sections: doc.sections.map((s) => ({ ...s, blocks: s.blocks.map((b) => ({ ...b, source: strip(b.source) })) })) } as D;
}
