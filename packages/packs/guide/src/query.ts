/**
 * The `guide` core query (op guide.view): reads only, 0 model calls. Core's store is typed as the
 * base Store; the workspace store also carries the course core and the learning store, which
 * this checks at runtime before reading.
 */
import type { QueryRequest, QueryResult, Store } from "@magic/contracts";
import type { GuideStore } from "./inputs";
import { guideView } from "./run";

type GuideRequest = Extract<QueryRequest, { view: "guide" }>;
type GuideResult = Extract<QueryResult, { view: "guide" }>;

const isGuideStore = (store: Store): store is GuideStore => {
  const s = store as Partial<GuideStore>;
  return (
    typeof s.learning === "object" && s.learning !== null && typeof s.materialFacts === "function" && typeof s.passage === "function" && typeof s.assessments === "function"
  );
};

export function guideQuery(store: Store, request: GuideRequest, now: string): GuideResult {
  const base = { view: "guide" as const, op: "guide.view" as const, kind: request.kind, artifactId: null, stale: false, changedSources: [], modelCalls: 0 as const, guide: null };
  if (request.moduleId && request.assessmentId)
    return { ...base, status: "empty", courseRef: null, message: "Choose a module or an assessment, not both." };
  if (!isGuideStore(store)) return { ...base, status: "unavailable", courseRef: null, message: "Study guides need the workspace's learning store." };
  const scope = {
    courseId: request.courseId,
    ...(request.moduleId ? { moduleId: request.moduleId } : {}),
    ...(request.assessmentId ? { assessmentId: request.assessmentId } : {}),
  };
  const r = guideView({ store, now: () => new Date(now) }, request.kind, scope);
  if (r.status === "ready" || r.status === "stale")
    return { ...base, status: r.status, courseRef: r.courseRef, artifactId: r.artifactId, stale: r.stale, changedSources: r.changedSources, message: null, guide: { view: r.view, drops: r.drops } };
  return { ...base, status: r.status, courseRef: r.courseRef, message: "message" in r ? r.message : null };
}
