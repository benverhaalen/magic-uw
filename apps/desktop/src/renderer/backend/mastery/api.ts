// Course mastery's calls (D57), through the app's one bridge (`execute`). The view never reads a
// store: every figure comes from the worker's router. Injectable so a headless harness renders the
// same component against recorded router output.
import type { LearningRequest, LearningResult, Snapshot } from "@magic/contracts";
import type {
  AssessmentMasteryData,
  ClaimData,
  CourseMasteryData,
  ExamHistoryData,
  HideData,
  NextStepCommand,
} from "../../../../../../packages/learning/src/mastery/types";
import type { CourseGradesData } from "../../../../../../packages/learning/src/strategy/inputs";
import type { StrategyRunResult } from "../../../../../../packages/packs/strategy/src/index";

export type { AssessmentMasteryData, ClaimData, CourseGradesData, CourseMasteryData, ExamHistoryData, HideData, NextStepCommand, StrategyRunResult };

export interface MasteryApi {
  learning(request: LearningRequest): Promise<LearningResult>;
  pack(pack: string, scope: { courseId: string; topicIds?: string[] }): Promise<unknown>;
}

export const bridgeApi: MasteryApi = {
  async learning(request) {
    const response = await window.magic.execute({ type: "learning", request });
    return response.learning ?? { op: request.op, status: "failed", message: "The study service didn't answer." };
  },
  async pack(pack, scope) {
    const response = await window.magic.execute({ type: "pack", pack, scope });
    return response.pack ?? null;
  },
};

export interface CourseChoice {
  key: string;
  courseId: string;
  name: string;
  /** Assignment resources the worker's trusted resolver authorizes as the course's practice scope. */
  anchorIds: string[];
}

/** The courses the student can open, each with its anchors (its assignments, at most 50). */
export function courseChoices(snapshot: Snapshot): CourseChoice[] {
  const account = new Map(snapshot.sources.map((s) => [s.id, s.accountScope]));
  const byKey = new Map<string, CourseChoice>();
  for (const r of snapshot.resources) {
    if (r.deleted) continue;
    const key = `${account.get(r.sourceId) ?? r.sourceId}:${r.courseId}`;
    const c = byKey.get(key) ?? { key, courseId: r.courseId, name: r.courseName, anchorIds: [] };
    if (r.kind === "assignment" && c.anchorIds.length < 50) c.anchorIds.push(r.id);
    byKey.set(key, c);
  }
  return [...byKey.values()].filter((c) => c.anchorIds.length).sort((a, b) => a.name.localeCompare(b.name));
}

export const operationId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `op-${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** A learning call that must succeed; the thrown message is the router's own words. */
export async function must<T>(api: MasteryApi, request: LearningRequest): Promise<T> {
  const result = await api.learning(request);
  if (result.status !== "ok") throw new Error(result.message ?? "That didn't work. Your saved work is unchanged.");
  return result.data as T;
}
