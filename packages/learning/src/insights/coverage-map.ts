// P13: the coverage map for an upcoming assessment (PI-18) and concept states
// grouped by assessment (PI-19). Each covered material is practiced (≥1 scored
// attempt on an item citing it), studied (≥30 active seconds of reading, not
// practiced) or untouched; material the app didn't capture is listed apart as
// "not captured", never as untouched. Counts only: no readiness figure, no
// percentage, no predicted score.
import type { ItemSource, LearningAttempt } from "../store";
import type { ConceptView } from "../types";
import type { LearningView } from "../practice/store";

export const STUDIED_SECONDS = 30;

export type MaterialStatus = "practiced" | "studied" | "untouched";

export interface CoveredMaterial {
  resourceId: string;
  title: string;
  captured: boolean;
}

export interface CoverageMapResult {
  assessmentId: string;
  tier: "T1" | "T2" | "T3" | "T4";
  rows: { resourceId: string; title: string; status: MaterialStatus }[];
  notCaptured: { resourceId: string; title: string }[];
  counts: { practiced: number; studied: number; untouched: number; notCaptured: number; total: number };
  text: string;
}

export function coverageMap(input: {
  assessmentId: string;
  tier: CoverageMapResult["tier"];
  materials: CoveredMaterial[];
  attempts: LearningAttempt[];
  sourcesByItem: Map<string, ItemSource[]>;
  views: LearningView[];
}): CoverageMapResult {
  const practiced = new Set<string>();
  for (const a of input.attempts) {
    for (const s of input.sourcesByItem.get(a.itemId) ?? []) practiced.add(s.resourceId);
  }
  const seconds = new Map<string, number>();
  for (const v of input.views) seconds.set(v.resourceId, (seconds.get(v.resourceId) ?? 0) + v.activeSeconds);
  const captured = input.materials.filter((m) => m.captured);
  const rows = captured.map((m) => ({
    resourceId: m.resourceId,
    title: m.title,
    status: (practiced.has(m.resourceId) ? "practiced" : (seconds.get(m.resourceId) ?? 0) >= STUDIED_SECONDS ? "studied" : "untouched") as MaterialStatus,
  }));
  const notCaptured = input.materials.filter((m) => !m.captured).map((m) => ({ resourceId: m.resourceId, title: m.title }));
  const count = (s: MaterialStatus) => rows.filter((r) => r.status === s).length;
  const counts = { practiced: count("practiced"), studied: count("studied"), untouched: count("untouched"), notCaptured: notCaptured.length, total: rows.length };
  return {
    assessmentId: input.assessmentId,
    tier: input.tier,
    rows,
    notCaptured,
    counts,
    text: `${counts.practiced} of ${counts.total} materials practiced${notCaptured.length ? `; ${notCaptured.length} not captured` : ""}`,
  };
}

/** Concept states grouped by assessment, with the KM-6 fields only (PI-19). */
export function statesByAssessment(views: ConceptView[], assessments: { id: string; title: string; conceptIds: string[] }[]) {
  const byId = new Map(views.map((v) => [v.conceptId, v]));
  return assessments.map((a) => ({
    assessmentId: a.id,
    title: a.title,
    concepts: a.conceptIds.map((id) => byId.get(id)).filter((v): v is ConceptView => v !== undefined),
  }));
}
