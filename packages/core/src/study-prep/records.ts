/**
 * owner: study-prep. Where Study prepper keeps what it made, in the learning store's existing
 * artifact table (no table or column is added):
 * - one record per (assessment, source-set hash, kind): its status (generating, ready, failed),
 *   what it holds (the checked guide, or the ids of checked quiz items and cards), and the content
 *   hash of every source it was made from. Freshness is decided by code from those hashes, so a
 *   record is regenerated only when its sources' content changes (item 4);
 * - one passage-set record per (assessment, source-set hash, source content): the passage ids the
 *   first generation retrieved. Asking later for another kind reuses exactly those passages, so the
 *   prompt's prefix and context stay byte-identical and hit the provider's prompt cache (item 3),
 *   even when other course material shifts the search ranking.
 */
import type { ArtifactKind, LearningStore } from "../../../learning/src/store";
import type { StudyPrepExam, StudyPrepExamProblem, StudyPrepGuide, StudyPrepKind, StudyPrepOutline } from "@magic/contracts";
import { sha } from "./scope-hash";

export interface PrepRecord {
  v: 1;
  kind: StudyPrepKind;
  status: "generating" | "ready" | "failed";
  startedAt: string | null;
  generatedAt: string | null;
  message: string | null;
  packVersion: string;
  /** Every source in the selection, at the content it had when this was made. */
  sources: { resourceId: string; contentHash: string; title: string }[];
  guide: StudyPrepGuide | null;
  exam?: StudyPrepExam | null;
  problems?: StudyPrepExamProblem[] | null;
  outline?: StudyPrepOutline | null;
  itemIds: string[];
  dropped: number;
  tokens: { in: number; cached: number; out: number };
  /** The last ready content, kept visible while a regeneration runs or after it fails. */
  previous?: Omit<PrepRecord, "previous"> | null;
}

/** A generation that started this long ago without finishing was interrupted (the worker restarted). */
export const GENERATING_TIMEOUT_MS = 10 * 60_000;

const recordKey = (courseRef: string, assessmentId: string, scopeHash: string, kind: StudyPrepKind) =>
  `study-prep-${kind}-${sha([courseRef, assessmentId, scopeHash, kind]).slice(0, 40)}`;

export function readRecord(learning: LearningStore, courseRef: string, assessmentId: string, scopeHash: string, kind: StudyPrepKind): PrepRecord | null {
  const row = learning.artifact(recordKey(courseRef, assessmentId, scopeHash, kind));
  const b = row?.body as Partial<PrepRecord> | undefined;
  return b && b.v === 1 && b.kind === kind && Array.isArray(b.sources) && Array.isArray(b.itemIds) ? (b as PrepRecord) : null;
}

export function writeRecord(learning: LearningStore, courseRef: string, assessmentId: string, scopeHash: string, record: PrepRecord, at: string): void {
  const key = recordKey(courseRef, assessmentId, scopeHash, record.kind);
  learning.putArtifact({
    id: key,
    courseRef,
    kind: "pack" as ArtifactKind,
    scope: { pointer: "study-prep", assessmentId, scopeHash, kind: record.kind },
    cacheKey: key,
    body: record,
    removedCount: record.dropped,
    status: record.status === "failed" ? "failed" : "ready",
    generator: null,
    pack: "study-prep-record",
    packVersion: "v1",
    createdAt: at,
    sources: [],
  });
  markPrepared(learning, courseRef, assessmentId, at);
}

/**
 * The course's items that have any study material, so a list of hundreds of items reads records
 * only for the few that have them (one artifact read per course instead of six per item).
 */
const indexKey = (courseRef: string) => `study-prep-index-v1-${sha(courseRef).slice(0, 40)}`;
export function preparedItems(learning: LearningStore, courseRef: string): Set<string> {
  const body = learning.artifact(indexKey(courseRef))?.body as { items?: unknown } | undefined;
  return new Set(Array.isArray(body?.items) ? (body.items as string[]) : []);
}
function markPrepared(learning: LearningStore, courseRef: string, itemId: string, at: string): void {
  const items = preparedItems(learning, courseRef);
  if (items.has(itemId)) return;
  items.add(itemId);
  const key = indexKey(courseRef);
  learning.putArtifact({
    id: key, courseRef, kind: "pack" as ArtifactKind, scope: { pointer: "study-prep-index" }, cacheKey: key,
    body: { v: 1, items: [...items] }, removedCount: 0, status: "ready", generator: null, pack: "study-prep-index", packVersion: "v1", createdAt: at, sources: [],
  });
}

const passageKey = (courseRef: string, assessmentId: string, scopeHash: string, content: string) =>
  `study-prep-passages-${sha([courseRef, assessmentId, scopeHash, content]).slice(0, 40)}`;

export function readPassageSet(learning: LearningStore, courseRef: string, assessmentId: string, scopeHash: string, content: string): number[] | null {
  const body = learning.artifact(passageKey(courseRef, assessmentId, scopeHash, content))?.body as { pids?: unknown } | undefined;
  return Array.isArray(body?.pids) && body.pids.every((p) => Number.isSafeInteger(p)) ? (body.pids as number[]) : null;
}

export function writePassageSet(learning: LearningStore, courseRef: string, assessmentId: string, scopeHash: string, content: string, pids: number[], at: string): void {
  const key = passageKey(courseRef, assessmentId, scopeHash, content);
  learning.putArtifact({
    id: key,
    courseRef,
    kind: "pack" as ArtifactKind,
    scope: { pointer: "study-prep-passages", assessmentId, scopeHash },
    cacheKey: key,
    body: { pids },
    removedCount: 0,
    status: "ready",
    generator: null,
    pack: "study-prep-passages",
    packVersion: "v1",
    createdAt: at,
    sources: [],
  });
}
