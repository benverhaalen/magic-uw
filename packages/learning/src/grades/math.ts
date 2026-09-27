// The grade bank (D57): one implementation of the grade math for every consumer (course mastery,
// the pages builder's study offers, the strategy observations). Pure functions over captured
// Canvas records. The FDB-001 rules are enforced here:
// - one account's course only (the caller selects by account scope and course ID; see inputs.ts);
// - weights come from Canvas group weights that add up to 100, else from syllabus lines that add up
//   to 100 and name every graded group; otherwise the weighting is unknown and no course figure is made;
// - a single assignment's share of the grade is given only when capture is complete and its group
//   drops nothing; otherwise only the group's listed weight is stated;
// - a partial capture makes the course grade unknown, because more captured work would change it.
import type {
  AssignmentShare,
  CourseGrade,
  CourseGradeInput,
  GradeGroup,
  GradeItem,
  GroupResult,
  ResolvedWeights,
  SyllabusWeight,
} from "./types";

const round1 = (x: number) => Math.round(x * 10) / 10;
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/s\b/g, "");
const near100 = (sum: number) => sum >= 99 && sum <= 101;

/** Items that count toward a percentage: points possible, not excused. */
const counts = (x: GradeItem) => (x.points ?? 0) > 0 && !x.excused;
const scored = (x: GradeItem) => counts(x) && x.score !== null;

/** The groups that have work counting toward the grade. */
export function gradedGroups(input: CourseGradeInput): GradeGroup[] {
  const used = new Set(input.items.filter(counts).map((x) => x.groupId));
  return input.groups.filter((g) => used.has(g.id));
}

/** Match a syllabus label to a Canvas group title by normalised words ("Quizzes" ~ "Quiz"). */
export function labelMatches(label: string, title: string): boolean {
  const a = norm(label),
    b = norm(title);
  if (!a || !b) return false;
  return a === b || (a.length >= 4 && b.includes(a)) || (b.length >= 4 && a.includes(b));
}

/** Weights by group, from Canvas, else the syllabus; never a guess. */
export function resolveWeights(input: CourseGradeInput): ResolvedWeights {
  const graded = gradedGroups(input);
  if (!graded.length) return { status: "unknown", reason: "No graded assignment groups were captured." };
  const canvas = input.groups.filter((g) => g.weight !== null);
  const canvasSum = canvas.reduce((n, g) => n + g.weight!, 0);
  if (graded.every((g) => g.weight !== null) && near100(canvasSum))
    return {
      status: "known",
      source: "canvas",
      byGroup: new Map(input.groups.map((g) => [g.id, g.weight ?? 0])),
      text: "Group weights as listed in Canvas.",
    };
  const syllabus = input.syllabusWeights;
  if (syllabus.length && near100(syllabus.reduce((n, w) => n + w.weight, 0))) {
    const byGroup = new Map<string, number>();
    for (const g of graded) {
      const hit = syllabus.filter((w) => labelMatches(w.label, g.title));
      if (hit.length !== 1) return { status: "unknown", reason: `The syllabus weights don't name the group "${g.title}" exactly once.` };
      byGroup.set(g.id, hit[0]!.weight);
    }
    return { status: "known", source: "syllabus", byGroup, text: "Weights as listed in the syllabus." };
  }
  if (canvas.length && !near100(canvasSum))
    return { status: "unknown", reason: "The Canvas group weights don't add up to 100, so Canvas may not apply them." };
  return { status: "unknown", reason: "Neither Canvas nor the syllabus lists weights that add up to 100." };
}

/** Choose the `k` items to drop that maximise what is left (Canvas's goal); brute force when small, greedy otherwise. */
function chooseDrops(items: GradeItem[], k: number, direction: "lowest" | "highest"): GradeItem[] {
  if (k <= 0 || items.length <= 1) return [];
  const drop = Math.min(k, items.length - 1);
  const earned = items.reduce((n, x) => n + x.score!, 0);
  const possible = items.reduce((n, x) => n + x.points!, 0);
  const value = (set: GradeItem[]) => {
    const e = earned - set.reduce((n, x) => n + x.score!, 0);
    const p = possible - set.reduce((n, x) => n + x.points!, 0);
    return p > 0 ? e / p : 0;
  };
  // Combinations are bounded: C(n, k) ≤ 5,000, else the greedy rule (lowest or highest ratio first).
  let combos = 1;
  for (let i = 0; i < drop; i++) combos = (combos * (items.length - i)) / (i + 1);
  const better = (a: number, b: number) => (direction === "lowest" ? a > b : a < b);
  if (combos <= 5000) {
    let best: GradeItem[] = [];
    let bestValue = direction === "lowest" ? -Infinity : Infinity;
    const pick = (start: number, chosen: GradeItem[]) => {
      if (chosen.length === drop) {
        const v = value(chosen);
        if (better(v, bestValue)) {
          bestValue = v;
          best = [...chosen];
        }
        return;
      }
      for (let i = start; i < items.length; i++) pick(i + 1, [...chosen, items[i]!]);
    };
    pick(0, []);
    return best;
  }
  const ratio = (x: GradeItem) => x.score! / x.points!;
  return [...items].sort((a, b) => (direction === "lowest" ? ratio(a) - ratio(b) : ratio(b) - ratio(a)) || a.id.localeCompare(b.id)).slice(0, drop);
}

/** One group's scored work after its drop rules. */
export function groupResult(group: GradeGroup, items: GradeItem[], weight: ResolvedWeights): GroupResult {
  const mine = items.filter((x) => x.groupId === group.id && counts(x));
  let kept = mine.filter((x) => x.score !== null);
  const dropped: string[] = [];
  const droppable = () => kept.filter((x) => !group.neverDrop.includes(x.externalId));
  for (const x of chooseDrops(droppable(), group.dropLowest, "lowest")) dropped.push(x.id);
  kept = kept.filter((x) => !dropped.includes(x.id));
  for (const x of chooseDrops(droppable(), group.dropHighest, "highest")) dropped.push(x.id);
  kept = kept.filter((x) => !dropped.includes(x.id));
  const earned = kept.reduce((n, x) => n + x.score!, 0);
  const possible = kept.reduce((n, x) => n + x.points!, 0);
  const w = weight.status === "known" ? weight.byGroup.get(group.id) : undefined;
  return {
    groupId: group.id,
    title: group.title,
    weight: w !== undefined && weight.status === "known" ? { value: w, source: weight.source } : null,
    earned: round1(earned),
    possible: round1(possible),
    percent: possible > 0 ? round1((100 * earned) / possible) : null,
    scored: kept.length,
    dropped,
    missing: mine.filter((x) => x.missing && x.score === null).length,
    ungraded: mine.filter((x) => x.score === null).length,
  };
}

/** Weighted over the groups with scored work (Canvas renormalises the same way for a current grade). */
export function weightedPercent(groups: GroupResult[]): number | null {
  const live = groups.filter((g) => g.percent !== null && g.weight && g.weight.value > 0);
  const total = live.reduce((n, g) => n + g.weight!.value, 0);
  if (!total) return null;
  return round1(live.reduce((n, g) => n + g.weight!.value * g.percent!, 0) / total);
}

/** The course's current grade from captured scores, or why it can't be known. */
export function courseGrade(input: CourseGradeInput, weights = resolveWeights(input)): { grade: CourseGrade; groups: GroupResult[] } {
  const groups = input.groups
    .slice()
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
    .map((g) => groupResult(g, input.items, weights));
  if (input.coverage.status !== "complete")
    return {
      grade: {
        status: "unknown",
        reason: `Some of this course's Canvas reads were partial${input.coverage.reasons.length ? ` (${input.coverage.reasons.join("; ")})` : ""}, so a course figure could change as more work is captured.`,
      },
      groups,
    };
  if (weights.status !== "known") return { grade: { status: "unknown", reason: weights.reason }, groups };
  if (input.items.some((x) => scored(x) && x.groupId === null))
    return { grade: { status: "unknown", reason: "Some scored work isn't in an assignment group." }, groups };
  const percent = weightedPercent(groups);
  if (percent === null) return { grade: { status: "unknown", reason: "No scored work has been captured yet." }, groups };
  return { grade: { status: "known", percent, basis: `From your captured Canvas scores. ${weights.text} Ungraded work isn't counted yet.` }, groups };
}

/**
 * One assignment's share of the course grade (the pages builder's grade shares). Known only with
 * complete capture, known weights and a group that drops nothing; otherwise the group's listed
 * weight is stated, or the share is unknown.
 */
export function assignmentShare(input: CourseGradeInput, itemId: string, weights = resolveWeights(input)): AssignmentShare {
  const item = input.items.find((x) => x.id === itemId || x.externalId === itemId);
  if (!item) return { status: "unknown", reason: "That assignment isn't in this course's captured work." };
  if (!item.groupId) return { status: "unknown", reason: "This assignment isn't in an assignment group." };
  const group = input.groups.find((g) => g.id === item.groupId);
  if (!group) return { status: "unknown", reason: "This assignment's group wasn't captured." };
  if (weights.status !== "known") return { status: "unknown", reason: weights.reason };
  const w = weights.byGroup.get(group.id) ?? 0;
  const where = weights.source === "canvas" ? "as listed in Canvas" : "as listed in the syllabus";
  const groupText = `Counts in ${group.title}, which is ${w}% of the grade (${where}).`;
  if (input.coverage.status !== "complete")
    return { status: "group_only", groupWeight: w, source: weights.source, text: groupText, reason: "Capture is partial, so this assignment's part of its group isn't known." };
  if (group.dropLowest > 0 || group.dropHighest > 0)
    return { status: "group_only", groupWeight: w, source: weights.source, text: groupText, reason: "This group drops scores, so one assignment's part isn't fixed." };
  if (!counts(item)) return { status: "group_only", groupWeight: w, source: weights.source, text: groupText, reason: "This assignment has no points possible." };
  const siblings = input.items.filter((x) => x.groupId === group.id && counts(x));
  const pts = siblings.reduce((n, x) => n + x.points!, 0);
  const share = round1((w * item.points!) / pts);
  return { status: "known", share, groupWeight: w, source: weights.source, text: `About ${share}% of the grade: ${item.points} of the ${pts} points in ${group.title} (${w}%, ${where}).` };
}

/** Weights read from syllabus lines such as "Quizzes: 20%" or "Final exam — 25 %". Code only; each keeps its line. */
export function syllabusWeights(text: string, resourceId: string): SyllabusWeight[] {
  const out: SyllabusWeight[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^[-•*·\s]*([A-Za-z][A-Za-z&/ ()'-]{1,58}?)\s*(?:[:\-–—.]|\.{2,})?\s*(\d{1,3}(?:\.\d+)?)\s*%\s*\.?$/.exec(line);
    if (!m) continue;
    const label = m[1]!.replace(/\s*\($/, "").trim();
    const weight = Number(m[2]);
    if (!label || weight <= 0 || weight > 100) continue;
    out.push({ label, weight, resourceId, quote: line });
  }
  return out;
}
