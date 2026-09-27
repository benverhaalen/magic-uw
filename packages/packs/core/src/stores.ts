import type { ClientId, LedgerEntry, Tier, Usage } from "../../../runner/src/index";

/**
 * A `learning_artifacts` row. The SQLite table lands with the data layer's schema v7; until
 * then the job codes against these interfaces and the in-memory stores below.
 */
export interface LearningArtifact {
  id: string;
  packId: string;
  packVersion: string;
  courseId: string;
  cacheKey: string;
  output: unknown;
  /** True only when every code check passed and no Jev gate failed. */
  verified: boolean;
  gates: { id: string; status: "passed" | "failed" | "skipped"; failed: string[] }[];
  sources: string[];
  client: ClientId;
  model: string;
  tier: Tier;
  usage: Usage;
  createdAt: string;
}
export interface ArtifactStore {
  get(cacheKey: string): LearningArtifact | null;
  put(artifact: LearningArtifact): void;
  list(filter?: { courseId?: string; packId?: string }): LearningArtifact[];
}

/** One row per model call (spec E5), plus a zero-token row for a cache hit. */
export type LedgerRecord =
  | (LedgerEntry & { courseId: string; cacheKey: string })
  | {
      at: string;
      pack: string;
      packVersion: string;
      courseId: string;
      cacheKey: string;
      outcome: "cache_hit";
      usage: Usage;
    };
export interface LedgerStore {
  append(record: LedgerRecord): void;
  list(filter?: { courseId?: string; pack?: string }): LedgerRecord[];
}

export function memoryArtifactStore(): ArtifactStore {
  const rows = new Map<string, LearningArtifact>();
  return {
    get: (key) => rows.get(key) ?? null,
    put: (a) => void rows.set(a.cacheKey, a),
    list: (f = {}) =>
      [...rows.values()].filter(
        (a) => (!f.courseId || a.courseId === f.courseId) && (!f.packId || a.packId === f.packId),
      ),
  };
}
export function memoryLedgerStore(): LedgerStore {
  const rows: LedgerRecord[] = [];
  return {
    append: (r) => void rows.push(r),
    list: (f = {}) =>
      rows.filter((r) => (!f.courseId || r.courseId === f.courseId) && (!f.pack || r.pack === f.pack)),
  };
}
