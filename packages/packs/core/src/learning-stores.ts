/**
 * SQLite-backed pack stores on the shared workspace connection (T13 over schema v7):
 * - artifacts go to `learning_artifacts` through the N24 LearningStore (cache key unique);
 * - ledger rows go to the course-core `ledger` table (one per model call, plus a 0-token
 *   row for a cache hit).
 * Additive: the stores reuse the existing store methods and add no table or column.
 */
import { randomUUID } from "node:crypto";
import type { CourseCoreStore, CourseRef } from "@magic/contracts";
import type { ArtifactKind, LearningStore } from "../../../learning/src/store";
import type { ClientId, Lane, LedgerOutcome, RunnerErrorKind, Tier } from "../../../runner/src/index";
import type { ArtifactStore, LearningArtifact, LedgerRecord, LedgerStore } from "./stores";

/** The course a learning course reference (`accountScope:courseId`) names, or null. */
export type CourseOf = (courseRef: string) => CourseRef | null;
/** The resource and content hash a passage source id stands for, for artifact freshness. */
export type SourceOf = (sourceId: string) => { resourceId: string; contentHash: string } | null;

/**
 * `learning_artifacts.kind` is free text in SQL; the notebook's ArtifactKind union doesn't name
 * pack outputs yet. Pack rows are told apart by their `pack` column.
 */
const PACK_KIND = "pack" as ArtifactKind;

export function learningArtifactStore(learning: LearningStore, sourceOf: SourceOf): ArtifactStore {
  const read = (body: unknown): LearningArtifact | null => {
    const a = body as Partial<LearningArtifact> | null;
    return a && typeof a.cacheKey === "string" && typeof a.packId === "string" ? (a as LearningArtifact) : null;
  };
  return {
    get(cacheKey) {
      const row = learning.artifact(cacheKey);
      return row && row.status !== "stale" && row.status !== "failed" ? read(row.body) : null;
    },
    put(a) {
      const sources = [...new Set(a.sources)].flatMap((id) => {
        const s = sourceOf(id);
        return s ? [s] : [];
      });
      learning.putArtifact({
        id: a.id,
        courseRef: a.courseId,
        kind: PACK_KIND,
        scope: { pack: a.packId, sources: a.sources },
        cacheKey: a.cacheKey,
        body: a,
        removedCount: 0,
        status: a.verified ? "ready" : "partial",
        generator: { client: a.client, model: a.model, tier: a.tier },
        pack: a.packId,
        packVersion: a.packVersion,
        createdAt: a.createdAt,
        sources: [...new Map(sources.map((s) => [s.resourceId, s])).values()],
      });
    },
    list() {
      // The LearningStore reads artifacts by cache key only; listing needs a store method it lacks.
      throw new Error("Listing pack artifacts needs a LearningStore method that doesn't exist yet.");
    },
  };
}

/** Client, lane, outcome, attempt and error kind ride in the row id: the ledger table has no columns for them. */
const META = "~";
export function sqlLedgerStore(store: Pick<CourseCoreStore, "addLedgerEntry" | "ledger">, courseOf: CourseOf): LedgerStore {
  return {
    append(r) {
      const hit = "outcome" in r && r.outcome === "cache_hit";
      const meta = hit
        ? ["cache", "", "cache_hit", "0", ""]
        : (() => {
            const e = r as Exclude<LedgerRecord, { outcome: "cache_hit" }>;
            return [e.client, e.lane, e.outcome, String(e.attempt), e.errorKind ?? ""];
          })();
      const e = r as Exclude<LedgerRecord, { outcome: "cache_hit" }>;
      store.addLedgerEntry({
        id: [randomUUID(), ...meta].join(META),
        pack: r.pack,
        packVersion: r.packVersion,
        tier: hit ? "cache" : e.tier,
        model: hit ? "cache" : e.model,
        tokensIn: r.usage.in,
        tokensCached: r.usage.cached,
        tokensOut: r.usage.out,
        latencyMs: hit ? 0 : e.latencyMs,
        checkFailures: hit ? 0 : e.checkErrors.length,
        escalated: hit ? false : e.escalated,
        course: courseOf(r.courseId),
        createdAt: r.at,
      });
    },
    list(filter = {}) {
      return store
        .ledger(5000)
        .reverse()
        .flatMap((row): LedgerRecord[] => {
          const [, client, lane, outcome, attempt, errorKind] = row.id.split(META);
          const courseId = row.course ? `${row.course.accountScope}:${row.course.courseId}` : "";
          if ((filter.courseId && filter.courseId !== courseId) || (filter.pack && filter.pack !== row.pack)) return [];
          const usage = { in: row.tokensIn, cached: row.tokensCached, out: row.tokensOut };
          if (outcome === "cache_hit")
            return [{ at: row.createdAt, pack: row.pack, packVersion: row.packVersion, courseId, cacheKey: "", outcome: "cache_hit", usage }];
          if (!client || !lane || !outcome) return [];
          return [
            {
              at: row.createdAt,
              pack: row.pack,
              packVersion: row.packVersion,
              client: client as ClientId,
              tier: row.tier as Tier,
              lane: lane as Lane,
              model: row.model,
              usage,
              latencyMs: row.latencyMs,
              attempt: Number(attempt),
              escalated: row.escalated,
              outcome: outcome as LedgerOutcome,
              checkErrors: Array.from({ length: row.checkFailures }, () => "(detail not stored)"),
              ...(errorKind ? { errorKind: errorKind as RunnerErrorKind } : {}),
              courseId,
              cacheKey: "",
            },
          ];
        });
    },
  };
}
