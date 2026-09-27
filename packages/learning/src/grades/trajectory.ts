// Grade over time and where it starts slipping (D57), measured against the student's own earlier
// level only: no comparison to anyone else and no forecast. Pure code over captured scores.
import { groupResult, resolveWeights, weightedPercent } from "./math";
import type { CourseGradeInput, GradeItem, GroupTrajectory, ResolvedWeights, TrajectoryPoint, Trend } from "./types";

/** Starting values, not validated (the same status as the knowledge-model constants). */
export const TREND = {
  /** A run must sit this many percentage points below (or above) the earlier level. */
  margin: 10,
  /** Items in the run, at least. */
  minRun: 3,
  /** Earlier items the level is measured from, at least. */
  minEarlier: 3,
} as const;

const round1 = (x: number) => Math.round(x * 10) / 10;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const scoredDated = (x: GradeItem) => (x.points ?? 0) > 0 && !x.excused && x.score !== null && x.at !== null;
const pct = (x: GradeItem) => round1((100 * x.score!) / x.points!);

/**
 * The earliest point from which every later item sits `margin` points below (slipping) or above
 * (rising) the median of the items before it, with at least `minRun` items in that run and
 * `minEarlier` before it. The run must reach the latest item: an old dip that recovered is not slipping.
 */
export function trend(series: { at: string; itemId: string; percent: number }[], t: typeof TREND = TREND): Trend {
  if (series.length < t.minEarlier + t.minRun) return { kind: "too_few", items: series.length };
  for (let k = t.minEarlier; k <= series.length - t.minRun; k++) {
    const earlier = median(series.slice(0, k).map((p) => p.percent));
    const run = series.slice(k).map((p) => p.percent);
    if (run.every((p) => p <= earlier - t.margin))
      return { kind: "slipping", since: series[k]!.at, sinceItemId: series[k]!.itemId, earlier: round1(earlier), recent: round1(median(run)), items: run.length };
    if (run.every((p) => p >= earlier + t.margin))
      return { kind: "rising", since: series[k]!.at, sinceItemId: series[k]!.itemId, earlier: round1(earlier), recent: round1(median(run)), items: run.length };
  }
  return { kind: "steady", level: round1(median(series.map((p) => p.percent))), items: series.length };
}

/** Scored items in time order, per group and for the course, with the running figure after each. */
export function gradeTrajectory(
  input: CourseGradeInput,
  weights: ResolvedWeights = resolveWeights(input),
  t: typeof TREND = TREND,
): { course: TrajectoryPoint[]; courseTrend: Trend; groups: GroupTrajectory[]; undated: number } {
  const dated = input.items.filter(scoredDated).sort((a, b) => a.at!.localeCompare(b.at!) || a.id.localeCompare(b.id));
  const undated = input.items.filter((x) => (x.points ?? 0) > 0 && !x.excused && x.score !== null && x.at === null).length;
  const course: TrajectoryPoint[] = [];
  const seen: GradeItem[] = [];
  for (const x of dated) {
    seen.push(x);
    let running: number | null = null;
    if (weights.status === "known") running = weightedPercent(input.groups.map((g) => groupResult(g, seen, weights)));
    if (running === null) {
      const e = seen.reduce((n, y) => n + y.score!, 0),
        p = seen.reduce((n, y) => n + y.points!, 0);
      running = round1((100 * e) / p);
    }
    course.push({ at: x.at!, itemId: x.id, title: x.title, groupId: x.groupId, percent: pct(x), running });
  }
  const titleOf = new Map(input.groups.map((g) => [g.id, g.title]));
  const groupIds = [...new Set(dated.map((x) => x.groupId))];
  const groups: GroupTrajectory[] = groupIds.map((id) => {
    const points = course.filter((p) => p.groupId === id);
    let e = 0,
      p = 0;
    const withRunning = points.map((pt) => {
      const x = dated.find((y) => y.id === pt.itemId)!;
      e += x.score!;
      p += x.points!;
      return { ...pt, running: round1((100 * e) / p) };
    });
    return {
      groupId: id,
      title: id ? (titleOf.get(id) ?? "Ungrouped") : "Ungrouped",
      points: withRunning,
      trend: trend(withRunning, t),
    };
  });
  return { course, courseTrend: trend(course, t), groups, undated };
}
