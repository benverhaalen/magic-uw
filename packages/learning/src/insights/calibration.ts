// P14: calibration, confidence against accuracy (PI-21), as counts only. Nothing
// is shown before 10 rated answers. Overconfident topics: "Fairly sure" or
// "Sure" answers wrong at least 4 times, and more often than the student's own
// rate at those levels, linked to their R4 reasons and shown beside delayed
// self-ratings (KM-11). No calibration score and no percentage.
import type { Dispute, LearningAttempt, SelfRating } from "../store";
import type { Reason } from "../types";

export const MIN_RATED = 10;
export const OVERCONFIDENT_MIN_WRONG = 4;

export type ConfidenceLevel = "Guess" | "Unsure" | "Fairly sure" | "Sure";
const LEVELS: [number, ConfidenceLevel][] = [
  [0, "Guess"],
  [0.33, "Unsure"],
  [0.67, "Fairly sure"],
  [1, "Sure"],
];

export function levelOf(confidence: number): ConfidenceLevel {
  return [...LEVELS].sort((a, b) => Math.abs(a[0] - confidence) - Math.abs(b[0] - confidence))[0]![1];
}

export interface LevelCount {
  level: ConfidenceLevel;
  right: number;
  total: number;
  text: string;
}

export interface OverconfidentTopic {
  conceptId: string;
  wrong: number;
  total: number;
  text: string;
  reasons: Reason[];
  selfRatings: SelfRating[];
}

export type Calibration =
  | { status: "not_enough"; rated: number; needed: number; text: string }
  | { status: "ready"; rated: number; levels: LevelCount[]; overconfident: OverconfidentTopic[] };

export function calibration(
  attempts: LearningAttempt[],
  opts: { disputes?: Dispute[]; reasonsByConcept?: Map<string, Reason[]>; selfRatings?: SelfRating[] } = {},
): Calibration {
  const open = (opts.disputes ?? []).filter((d) => d.status === "open");
  const badItems = new Set(open.filter((d) => d.targetKind === "item").map((d) => d.targetId));
  const badGrades = new Set(open.filter((d) => d.targetKind === "grade").map((d) => d.targetId));
  const rated = attempts.filter((a) => a.confidence !== null && a.assistance === "none" && !badItems.has(a.itemId) && !badGrades.has(a.id));
  if (rated.length < MIN_RATED) {
    return { status: "not_enough", rated: rated.length, needed: MIN_RATED, text: `Shown after ${MIN_RATED} answers with a confidence rating (${rated.length} so far).` };
  }
  const right = (a: LearningAttempt) => a.score >= 1;
  const levels = LEVELS.map(([, level]) => {
    const at = rated.filter((a) => levelOf(a.confidence!) === level);
    const r = at.filter(right).length;
    return { level, right: r, total: at.length, text: `${level}: ${r} of ${at.length} right` };
  }).filter((l) => l.total > 0);

  const high = rated.filter((a) => a.confidence! >= 0.67);
  const overallWrong = high.filter((a) => !right(a)).length;
  const byConcept = new Map<string, LearningAttempt[]>();
  for (const a of high) byConcept.set(a.primaryConceptId, [...(byConcept.get(a.primaryConceptId) ?? []), a]);
  const overconfident: OverconfidentTopic[] = [];
  for (const [conceptId, list] of byConcept) {
    const wrong = list.filter((a) => !right(a)).length;
    // Wrong more often than the student's own rate at those levels: wrong/list > overallWrong/high, compared as counts.
    if (wrong >= OVERCONFIDENT_MIN_WRONG && wrong * high.length > overallWrong * list.length) {
      overconfident.push({
        conceptId,
        wrong,
        total: list.length,
        text: `Fairly sure or Sure, and wrong ${wrong} of ${list.length} times.`,
        reasons: (opts.reasonsByConcept?.get(conceptId) ?? []).filter((r) => r.rule === "R4"),
        selfRatings: (opts.selfRatings ?? []).filter((s) => s.conceptId === conceptId && s.delayed),
      });
    }
  }
  overconfident.sort((a, b) => b.wrong - a.wrong || (a.conceptId < b.conceptId ? -1 : 1));
  return { status: "ready", rated: rated.length, levels, overconfident };
}
