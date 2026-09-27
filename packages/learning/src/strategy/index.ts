// Strategy observations (D57). Code derives short, checkable observations from the grade bank and
// course mastery ("Labs: slipping since 3 Oct…", "3 weak topics overlap Final exam…"). A strategy
// is written only when the student clicks "Build my strategy": one checked call on their own client,
// grounded only in these observations, where code checks that every number the plan uses appears in
// an observation it cites. Cached by the observations' hash, so an unchanged course costs 0 tokens.
import { createHash } from "node:crypto";
import type { CourseGrades, Trend, WeightSource } from "../grades/types";
import { shortDate } from "../knowledge/rules";
import type { CourseMasteryData } from "../mastery/types";

export interface Observation {
  id: string;
  kind: "grade" | "course_trend" | "group_trend" | "overlap" | "exam" | "due_review";
  text: string;
}

export interface Overlap {
  itemId: string;
  title: string;
  dueAt: string | null;
  groupTitle: string | null;
  weight: { share: number | null; group: number; source: WeightSource } | null;
  weakTopics: { topicId: string; label: string; stateLabel: string }[];
}

export interface StrategyAction {
  text: string;
  when: string;
  basedOn: string[];
}
export interface StrategyOutput {
  actions: StrategyAction[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const day = (iso: string) => shortDate(iso.slice(0, 10));
const fmt = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));

function trendText(name: string, t: Trend): string | null {
  if (t.kind === "too_few") return null;
  if (t.kind === "steady") return `${name}: steady across ${plural(t.items, "scored item")} (typical score ${fmt(t.level)}).`;
  const dir = t.kind === "slipping" ? "slipping" : "rising";
  const cmp = t.kind === "slipping" ? "below" : "above";
  return `${name}: ${dir} since ${day(t.since)}. Your last ${plural(t.items, "score")} ${t.items === 1 ? "is" : "are"} ${cmp} your earlier level (typical ${fmt(t.earlier)} before, ${fmt(t.recent)} since).`;
}

/** The observations, in a fixed order; IDs are positional (o1, o2, …) so the hash is stable. */
export function strategyObservations(grades: CourseGrades | null, mastery: CourseMasteryData, overlaps: Overlap[]): Observation[] {
  const rows: Omit<Observation, "id">[] = [];
  if (grades) {
    if (grades.grade.status === "known") rows.push({ kind: "grade", text: `Current grade from your captured scores: ${fmt(grades.grade.percent)}% (${grades.weights.status === "known" ? grades.weights.text : "weights unknown"}).` });
    const course = trendText("Scored work overall", grades.trajectory.courseTrend);
    if (course) rows.push({ kind: "course_trend", text: course });
    for (const g of grades.trajectory.groups) {
      const text = trendText(g.title, g.trend);
      if (text) rows.push({ kind: "group_trend", text });
    }
  }
  for (const o of overlaps) {
    if (!o.weakTopics.length) continue;
    const listed = o.weight?.source === "canvas" ? "Canvas" : "the syllabus";
    const weight = !o.weight
      ? ""
      : o.weight.share !== null
        ? `, about ${fmt(o.weight.share)}% of the grade (${o.groupTitle ?? "its group"} is ${fmt(o.weight.group)}%, as listed in ${listed})`
        : `, in ${o.groupTitle ?? "its group"} (${fmt(o.weight.group)}% of the grade, as listed in ${listed})`;
    const due = o.dueAt ? `, due ${day(o.dueAt)}` : "";
    rows.push({ kind: "overlap", text: `${plural(o.weakTopics.length, "weak topic")} (${o.weakTopics.map((t) => `${t.label}: ${t.stateLabel}`).join("; ")}) overlap ${o.title}${due}${weight}.` });
  }
  for (const a of mastery.assessments.slice(0, 3)) {
    if (a.scope !== "linked") continue;
    const iffy = a.counts.iffy ? `; ${a.counts.iffy} Iffy` : "";
    const unseen = a.counts.not_seen ? `; ${a.counts.not_seen} not seen yet` : "";
    rows.push({ kind: "exam", text: `${a.title} ${a.daysAway === 0 ? "today" : a.daysAway === 1 ? "tomorrow" : `in ${a.daysAway} days`}: Mastered ${a.counts.solid} of ${plural(a.topicIds.length, "topic")}${iffy}${unseen}.` });
  }
  const due = mastery.topics.filter((t) => t.dueForReview);
  if (due.length) rows.push({ kind: "due_review", text: `${plural(due.length, "topic")} ${due.length === 1 ? "is" : "are"} due for review: ${due.slice(0, 5).map((t) => t.label).join(", ")}${due.length > 5 ? ` and ${due.length - 5} more` : ""}.` });
  return rows.map((r, i) => ({ id: `o${i + 1}`, ...r }));
}

export function observationHash(observations: Observation[]): string {
  return createHash("sha256").update(JSON.stringify(observations.map((o) => [o.id, o.kind, o.text]))).digest("hex");
}

/** Every number written in a text ("3", "72.5", "25"), as values. */
export function numbersIn(text: string): number[] {
  return [...text.matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => Number(m[0].replace(",", ".")));
}

/**
 * Code's check on a written strategy: 1–5 actions; each cites at least one existing observation;
 * every number in its text and timing appears in an observation it cites. Returns the errors.
 */
export function checkStrategy(output: StrategyOutput, observations: Observation[]): string[] {
  const byId = new Map(observations.map((o) => [o.id, o]));
  const errors: string[] = [];
  if (!output.actions.length) errors.push("the plan has no actions");
  if (output.actions.length > 5) errors.push("the plan has more than 5 actions");
  output.actions.forEach((a, i) => {
    const cited = a.basedOn.map((id) => byId.get(id));
    if (!a.basedOn.length) errors.push(`action ${i + 1} cites no observation`);
    for (const [k, id] of a.basedOn.entries()) if (!cited[k]) errors.push(`action ${i + 1} cites ${id}, which is not an observation`);
    const allowed = new Set(cited.flatMap((o) => (o ? numbersIn(o.text) : [])));
    for (const n of numbersIn(`${a.text} ${a.when}`)) if (!allowed.has(n)) errors.push(`action ${i + 1} uses the number ${n}, which its observations don't contain`);
  });
  return errors;
}
