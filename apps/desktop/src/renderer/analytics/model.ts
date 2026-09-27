// Course Analytics: the view model behind the tab. Pure code over what is already computed and
// stored (0 tokens, no model call):
// - the grade bank (packages/learning/src/grades) for the running grade and each item's weight;
// - the captured submissions for completion;
// - course mastery (packages/learning/src/mastery) for topic states, readiness and the next steps,
//   which that code already ranks with the concept priority (packages/learning/src/priority.ts).
// Readiness is topic states from the student's own practice evidence: never a percentage and never a
// grade prediction. The letter comes only from cutoffs the syllabus states, cited by its line.
import type { CourseGrades, GradeItem } from "../../../../../packages/learning/src/grades/types";
import type { ConceptStateName } from "../../../../../packages/learning/src/types";
import type { CourseMasteryData, MasteryAssessment, NextStepCommand, StateCounts } from "../../../../../packages/learning/src/mastery/types";

export interface AnalyticsInputs {
  courseId: string;
  courseName: string;
  now: Date;
  /** The built-in synthetic sample course (fictional course and people). */
  synthetic: boolean;
  /** The grade bank's answer (`course.grades`), or null with the reason. */
  grades: CourseGrades | null;
  gradesMessage: string | null;
  /** Every captured assignment in the course, one per Canvas assignment (the grade bank's merge). */
  work: GradeItem[];
  mastery: CourseMasteryData | null;
  masteryMessage: string | null;
  /** Topic IDs linked to each upcoming item (`mastery.forItems`), by item ID. */
  itemTopics: Record<string, string[]>;
  /** The captured syllabus text, for the letter cutoffs it states. */
  syllabus: { text: string; resourceId: string } | null;
  /** Due flashcards per topic, when known; otherwise topics due for review are counted. */
  cardsDueByTopic: Record<string, number> | null;
}

export interface EmptyState {
  message: string;
  action: { label: string; kind: "coursework" };
}

// ---------- letter cutoffs ----------

export interface Cutoff {
  letter: string;
  min: number;
  quote: string;
}
const LETTER_ORDER = ["A+", "A", "A-", "AB", "B+", "B", "B-", "BC", "C+", "C", "C-", "CD", "D+", "D", "D-", "F"];
const CUTOFF_LINE = /^[\s\-•*·|]*(AB|BC|CD|[A-DF][+-]?)(?=[\s:=(\-–—|])[\s:=(\-–—|]*(below|under|less than|<)?\s*(?:≥|>=|at least)?\s*(\d{1,3}(?:\.\d+)?)\s*%?/i;

/** Letter cutoffs stated in the syllabus ("A 93–100", "AB: 88%", "F below 60"). Empty unless they form one consistent scale. */
export function letterCutoffs(text: string): Cutoff[] {
  const found = new Map<string, Cutoff>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = CUTOFF_LINE.exec(line);
    if (!m) continue;
    const letter = m[1]!.toUpperCase();
    const min = m[2] ? 0 : Number(m[3]);
    if (!LETTER_ORDER.includes(letter) || !(min >= 0 && min <= 100) || found.has(letter)) continue;
    found.set(letter, { letter, min, quote: line });
  }
  const scale = [...found.values()].sort((a, b) => LETTER_ORDER.indexOf(a.letter) - LETTER_ORDER.indexOf(b.letter));
  if (scale.length < 3 || !scale.some((c) => c.letter.startsWith("A"))) return [];
  for (let i = 1; i < scale.length; i++) if (!(scale[i]!.min < scale[i - 1]!.min)) return [];
  return scale;
}

export function letterFor(percent: number, cutoffs: Cutoff[]): Cutoff | null {
  return cutoffs.find((c) => percent >= c.min) ?? null;
}

// ---------- small helpers ----------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const round1 = (x: number) => Math.round(x * 10) / 10;
export const monthDay = (d: Date) => `${MONTHS[d.getMonth()]} ${d.getDate()}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const DAY = 86_400_000;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
/** Whole local days from `now` to `at` (0 = today). */
export function daysUntil(at: string, now: Date): number {
  return Math.round((startOfDay(new Date(at)).getTime() - startOfDay(now).getTime()) / DAY);
}
export function whenText(at: string, now: Date): string {
  const d = new Date(at);
  const n = daysUntil(at, now);
  const rel = n === 0 ? "today" : n === 1 ? "tomorrow" : n > 1 ? `in ${n} days` : `${-n} days ago`;
  return `${DAYS[d.getDay()]}, ${monthDay(d)} · ${rel}`;
}
const counted = (x: GradeItem) => (x.points ?? 0) > 0 && !x.excused;

/** An item's weight in words, from the grade bank's group weights: "Essays · about 8.6% of the grade". */
export function weightText(item: GradeItem, grades: CourseGrades | null, work: GradeItem[]): string {
  const group = grades?.groups.find((g) => g.groupId === item.groupId);
  if (!group) return "Weight not listed";
  if (!group.weight) return `${group.title} · weight not listed`;
  const pts = work.filter((x) => x.groupId === item.groupId && counted(x)).reduce((n, x) => n + x.points!, 0);
  if (!counted(item) || pts <= 0 || group.dropped.length) return `${group.title} · ${group.weight.value}% of the grade`;
  return `${group.title} · about ${round1((group.weight.value * item.points!) / pts)}% of the grade`;
}

// ---------- 1. grade trend ----------

export interface TrendPoint {
  itemId: string;
  at: number;
  title: string;
  /** The running course grade after this item. */
  running: number;
  percent: number;
  scoreText: string;
  weightText: string;
  late: boolean;
}
export interface WhatIfBand {
  x0: number;
  x1: number;
  lo: number;
  hi: number;
  loRate: number;
  hiRate: number;
  text: string;
}
export type GradeTrendView =
  | ({ status: "empty" } & EmptyState)
  | {
      status: "ok";
      points: TrendPoint[];
      current: { percent: number; basis: string } | { percent: null; reason: string };
      letter: { letter: string; min: number; quote: string; resourceId: string } | null;
      letterNote: string;
      cutoffs: Cutoff[];
      band: WhatIfBand | null;
      trendText: string;
      summary: string;
    };

/**
 * The what-if range: the course grade if every remaining counted item scored at the student's own
 * lower-quartile item percent so far, and at their upper quartile. Both edges come from captured scores; this is a
 * range of what-ifs, not a forecast. Needs known weights and no group drop rules.
 */
export function whatIfBand(grades: CourseGrades, work: GradeItem[], now: Date): WhatIfBand | null {
  if (grades.grade.status !== "known" || grades.weights.status !== "known") return null;
  if (grades.groups.some((g) => g.dropped.length)) return null;
  const nowIso = now.toISOString();
  const remaining = work.filter((x) => counted(x) && x.score === null && x.groupId !== null && (x.dueAt ?? "") >= nowIso);
  const past = grades.trajectory.course;
  if (!remaining.length || past.length < 3) return null;
  // The middle half of the student's own item scores (25th to 75th percentile), so one missing zero
  // or one perfect score doesn't set the whole range.
  const rates = past.map((p) => p.percent / 100).sort((a, b) => a - b);
  const q = (f: number) => {
    const i = (rates.length - 1) * f,
      lo = Math.floor(i);
    return rates[lo]! + (rates[Math.min(lo + 1, rates.length - 1)]! - rates[lo]!) * (i - lo);
  };
  const loRate = q(0.25),
    hiRate = q(0.75);
  const at = (rate: number) => {
    let total = 0,
      sum = 0;
    for (const g of grades.groups) {
      if (!g.weight || g.weight.value <= 0) continue;
      const extra = remaining.filter((x) => x.groupId === g.groupId).reduce((n, x) => n + x.points!, 0);
      const possible = g.possible + extra;
      if (possible <= 0) continue;
      total += g.weight.value;
      sum += (g.weight.value * (g.earned + rate * extra)) / possible;
    }
    return total ? round1((100 * sum) / total) : null;
  };
  const lo = at(loRate),
    hi = at(hiRate);
  if (lo === null || hi === null) return null;
  const last = Math.max(...remaining.map((x) => Date.parse(x.dueAt!)));
  return {
    x0: Date.parse(past.at(-1)!.at),
    x1: last,
    lo,
    hi,
    loRate: round1(loRate * 100),
    hiRate: round1(hiRate * 100),
    text: `What-if range ${lo}–${hi}%: if every remaining item scores like the middle half of your items so far (${round1(loRate * 100)}–${round1(hiRate * 100)}%). Not a prediction.`,
  };
}

export function gradeTrend(input: AnalyticsInputs): GradeTrendView {
  const { grades, work, now } = input;
  const course = grades?.trajectory.course ?? [];
  if (!grades || !course.length)
    return { status: "empty", message: input.gradesMessage && !grades ? input.gradesMessage : "No grades posted yet", action: { label: "View coursework", kind: "coursework" } };
  const byId = new Map(work.map((x) => [x.id, x]));
  const points: TrendPoint[] = course.map((p) => {
    const item = byId.get(p.itemId);
    return {
      itemId: p.itemId,
      at: Date.parse(p.at),
      title: p.title,
      running: p.running,
      percent: p.percent,
      scoreText: item && item.score !== null && item.points ? `${item.score}/${item.points} (${p.percent}%)` : `${p.percent}%`,
      weightText: item ? weightText(item, grades, work) : "Weight not listed",
      late: item?.late === true,
    };
  });
  const cutoffs = input.syllabus ? letterCutoffs(input.syllabus.text) : [];
  const current = grades.grade.status === "known" ? { percent: grades.grade.percent, basis: grades.grade.basis } : { percent: null, reason: grades.grade.reason };
  const hit = current.percent !== null ? letterFor(current.percent, cutoffs) : null;
  const letter = hit && input.syllabus ? { ...hit, resourceId: input.syllabus.resourceId } : null;
  const letterNote = letter
    ? `Letter from the syllabus cutoff: “${letter.quote}”`
    : current.percent === null
      ? "No letter while the course grade isn't known."
      : cutoffs.length
        ? "Below every cutoff the syllabus lists."
        : "The captured syllabus doesn't list letter cutoffs, so no letter is shown.";
  const t = grades.trajectory.courseTrend;
  const trendText =
    t.kind === "slipping"
      ? `Item scores have sat below your earlier level (${t.earlier}%) for the last ${plural(t.items, "item")}.`
      : t.kind === "rising"
        ? `Item scores have sat above your earlier level (${t.earlier}%) for the last ${plural(t.items, "item")}.`
        : t.kind === "steady"
          ? `Item scores are steady around ${t.level}%.`
          : `${plural(t.items, "scored item")} so far.`;
  const band = whatIfBand(grades, work, now);
  const last = points.at(-1)!;
  const summary =
    `Running course grade across ${plural(points.length, "graded item")}, from ${points[0]!.running}% after ${points[0]!.title} to ${last.running}% after ${last.title}.` +
    (current.percent !== null ? ` Current grade ${current.percent}%${letter ? `, letter ${letter.letter} by the syllabus cutoffs` : ""}.` : ` ${current.reason}`) +
    (band ? ` ${band.text}` : "");
  return { status: "ok", points, current, letter, letterNote, cutoffs, band, trendText, summary };
}

// ---------- 2. homework completion ----------

export const COMPLETION = ["on_time", "late", "missing", "upcoming"] as const;
export type CompletionKey = (typeof COMPLETION)[number];
export const COMPLETION_LABEL: Record<CompletionKey, string> = { on_time: "On time", late: "Late", missing: "Missing", upcoming: "Upcoming" };

/** One item's completion bucket from its captured submission; null when excused or when nothing is recorded for past work. */
export function completionOf(item: GradeItem, now: Date): CompletionKey | null {
  if (item.excused) return null;
  if (item.missing) return "missing";
  if (item.submitted === true || item.submittedAt !== null || item.score !== null) return item.late ? "late" : "on_time";
  if (item.dueAt !== null && item.dueAt >= now.toISOString()) return "upcoming";
  return null;
}

export type CompletionView =
  | ({ status: "empty" } & EmptyState)
  | {
      status: "ok";
      weeks: { label: string; start: number; values: number[] }[];
      totals: Record<CompletionKey, number>;
      /** "14 of 17 submitted on time": a count, nothing gamified. */
      onTimeText: string;
      /** Past items with no submission or missing flag recorded. */
      unrecorded: number;
      summary: string;
    };

const mondayOf = (d: Date) => {
  const s = startOfDay(d);
  s.setDate(s.getDate() - ((s.getDay() + 6) % 7));
  return s;
};

export function completion(input: AnalyticsInputs, maxWeeks = 16): CompletionView {
  const totals: Record<CompletionKey, number> = { on_time: 0, late: 0, missing: 0, upcoming: 0 };
  const byWeek = new Map<number, number[]>();
  let unrecorded = 0;
  for (const item of input.work) {
    const key = completionOf(item, input.now);
    if (!key) {
      if (!item.excused && item.dueAt) unrecorded++;
      continue;
    }
    totals[key]++;
    if (!item.dueAt) continue;
    const week = mondayOf(new Date(item.dueAt)).getTime();
    const row = byWeek.get(week) ?? [0, 0, 0, 0];
    row[COMPLETION.indexOf(key)]!++;
    byWeek.set(week, row);
  }
  const all = COMPLETION.reduce((n, k) => n + totals[k], 0);
  if (!all) return { status: "empty", message: "No assignments with submissions or due dates captured yet", action: { label: "View coursework", kind: "coursework" } };
  const starts = [...byWeek.keys()].sort((a, b) => a - b);
  const weeks: { label: string; start: number; values: number[] }[] = [];
  if (starts.length) {
    // Contiguous weeks, so a quiet week shows as a gap rather than disappearing.
    for (let d = new Date(starts[0]!); d.getTime() <= starts.at(-1)!; d.setDate(d.getDate() + 7)) {
      const t = d.getTime();
      weeks.push({ label: monthDay(d), start: t, values: byWeek.get(t) ?? [0, 0, 0, 0] });
    }
  }
  const shown = weeks.slice(-maxWeeks);
  const submitted = totals.on_time + totals.late;
  const onTimeText = `${totals.on_time} of ${submitted + totals.missing} due so far submitted on time`;
  const summary = `${totals.on_time} on time, ${totals.late} late, ${totals.missing} missing and ${totals.upcoming} upcoming${shown.length ? `, across ${plural(shown.length, "week")} from ${shown[0]!.label}` : ""}.`;
  return { status: "ok", weeks: shown, totals, onTimeText, unrecorded, summary };
}

// ---------- 3. assignment prep ----------

export interface PrepRow {
  itemId: string;
  title: string;
  kind: string;
  dueAt: string;
  when: string;
  weight: string;
  /** Topic states over the item's linked topics. Counts only: no percentage, no grade. */
  counts: StateCounts;
  topics: number;
  readiness: string;
  due: string | null;
}
export type PrepView = ({ status: "empty" } & EmptyState) | { status: "ok"; rows: PrepRow[]; note: string };

const zero = (): StateCounts => ({ solid: 0, getting_there: 0, iffy: 0, not_seen: 0 });
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const KIND_LABEL: Record<string, string> = { exam: "Exam", midterm: "Midterm", final: "Final", quiz: "Quiz" };

export function upcomingWork(input: AnalyticsInputs): GradeItem[] {
  const nowIso = input.now.toISOString();
  return input.work
    .filter((x) => x.dueAt !== null && x.dueAt >= nowIso && x.score === null && x.submitted !== true && !x.excused)
    .sort((a, b) => a.dueAt!.localeCompare(b.dueAt!) || a.id.localeCompare(b.id));
}

function assessmentFor(item: GradeItem, mastery: CourseMasteryData | null): MasteryAssessment | undefined {
  return mastery?.assessments.find((a) => a.assessmentId === item.id || norm(a.title) === norm(item.title));
}

export function prep(input: AnalyticsInputs, max = 5): PrepView {
  const rows = upcomingWork(input).slice(0, max);
  if (!rows.length) return { status: "empty", message: "No upcoming assignments or exams captured", action: { label: "View coursework", kind: "coursework" } };
  const state = new Map(input.mastery?.topics.map((t) => [t.topicId, t]) ?? []);
  return {
    status: "ok",
    rows: rows.map((item) => {
      const a = assessmentFor(item, input.mastery);
      const ids = [...new Set(input.itemTopics[item.id] ?? a?.topicIds ?? [])].filter((id) => state.has(id));
      const counts = zero();
      for (const id of ids) counts[state.get(id)!.state]++;
      let due: string | null = null;
      if (ids.length && input.cardsDueByTopic) {
        const n = ids.reduce((s, id) => s + (input.cardsDueByTopic![id] ?? 0), 0);
        due = n ? `${plural(n, "card")} due` : "No cards due";
      } else if (ids.length) {
        const n = ids.filter((id) => state.get(id)!.dueForReview).length;
        due = n ? `${plural(n, "topic")} due for review` : "Nothing due for review";
      }
      return {
        itemId: item.id,
        title: item.title,
        kind: item.examKind ? KIND_LABEL[item.examKind]! : "Assignment",
        dueAt: item.dueAt!,
        when: whenText(item.dueAt!, input.now),
        weight: weightText(item, input.grades, input.work),
        counts,
        topics: ids.length,
        readiness: ids.length ? `${counts.solid} of ${plural(ids.length, "topic")} mastered` : "No topics linked yet",
        due,
      };
    }),
    note: "Readiness is your topic states from your own practice. It isn't a grade or a score prediction.",
  };
}

// ---------- 4. topic mastery ----------

export const STATE_LEVEL: Record<ConceptStateName, number> = { not_seen: 0, iffy: 1, getting_there: 2, solid: 3 };
export interface TopicRow {
  topicId: string;
  label: string;
  module: string | null;
  state: ConceptStateName;
  stateLabel: string;
  /** 0–4: Not seen, Iffy, Getting there, Mastered, Mastered and confirmed by a later-day recall. */
  level: number;
  tier: string;
  due: boolean;
  why: string;
}
export type TopicsView = ({ status: "empty" } & EmptyState) | { status: "ok"; rows: TopicRow[]; counts: StateCounts; label: string; summary: string };

export function topicMastery(input: AnalyticsInputs): TopicsView {
  const m = input.mastery;
  if (!m || m.status !== "ok" || !m.topics.length)
    return { status: "empty", message: m?.message ?? input.masteryMessage ?? "No topic map for this course yet", action: { label: "View coursework", kind: "coursework" } };
  const rows = m.topics.map((t) => ({
    topicId: t.topicId,
    label: t.label,
    module: t.moduleLabel,
    state: t.state,
    stateLabel: t.stateLabel,
    level: STATE_LEVEL[t.state] + (t.state === "solid" && t.confirmed ? 1 : 0),
    tier: t.state === "solid" ? (t.confirmed ? "Confirmed by a later-day recall" : "Mastered") : t.awaitingLaterRecall ? "Mastered once you recall it on a later day" : t.stateLabel,
    due: t.dueForReview,
    why: t.why,
  }));
  rows.sort((a, b) => a.level - b.level || a.label.localeCompare(b.label));
  return { status: "ok", rows, counts: m.counts, label: m.label, summary: `${m.label}. ${rows.filter((r) => r.state === "iffy").length} iffy and ${rows.filter((r) => r.state === "not_seen").length} not seen yet.` };
}

// ---------- 5. what to do next ----------

export interface ActionCard {
  id: string;
  kind: "review" | "quiz" | "recall_check" | "generate" | "start";
  title: string;
  detail: string;
  cta: string;
  usesAi: boolean;
  command?: NextStepCommand;
  itemId?: string;
}
export type ActionsView = ({ status: "empty" } & EmptyState) | { status: "ok"; cards: ActionCard[] };
const CTA: Record<ActionCard["kind"], string> = { review: "Open flashcards", quiz: "Start quiz", recall_check: "Start check", generate: "Generate with your AI", start: "Open assignment" };

/**
 * Three ranked actions. The course's own next step comes first (course mastery ranks it with the
 * concept priority: need × exam urgency), then the soonest assignment to start, then each upcoming
 * exam's step, soonest first, then later assignments. Duplicates (the same exact command) collapse.
 */
export function nextActions(input: AnalyticsInputs, max = 3): ActionsView {
  const m = input.mastery;
  const fromStep = (s: NonNullable<CourseMasteryData["nextStep"]>, id: string): ActionCard => ({
    id,
    kind: s.kind,
    title: s.label,
    detail: s.detail,
    cta: CTA[s.kind],
    usesAi: s.usesAi,
    command: s.command,
  });
  const starts: ActionCard[] = upcomingWork(input)
    .filter((x) => x.examKind === null)
    .map((x) => ({ id: `start:${x.id}`, kind: "start", title: `Start ${x.title}`, detail: `Due ${whenText(x.dueAt!, input.now)} · ${weightText(x, input.grades, input.work)}`, cta: CTA.start, usesAi: false, itemId: x.id }));
  const exams = (m?.assessments ?? [])
    .filter((a) => a.nextStep)
    .sort((a, b) => a.daysAway - b.daysAway)
    .map((a) => fromStep(a.nextStep!, `exam:${a.assessmentId}`));
  const ordered = [m?.nextStep ? fromStep(m.nextStep, "course") : null, starts[0] ?? null, ...exams, ...starts.slice(1)].filter((x): x is ActionCard => x !== null);
  const seen = new Set<string>();
  const cards = ordered.filter((c) => {
    const key = c.command ? JSON.stringify(c.command) : c.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!cards.length) return { status: "empty", message: m?.nextStepNote ?? "Nothing to do next yet", action: { label: "View coursework", kind: "coursework" } };
  return { status: "ok", cards: cards.slice(0, max) };
}

// ---------- the whole tab ----------

export interface CourseAnalyticsView {
  courseId: string;
  courseName: string;
  synthetic: boolean;
  generatedAt: string;
  grade: GradeTrendView;
  completion: CompletionView;
  prep: PrepView;
  topics: TopicsView;
  actions: ActionsView;
}

export function buildCourseAnalytics(input: AnalyticsInputs): CourseAnalyticsView {
  return {
    courseId: input.courseId,
    courseName: input.courseName,
    synthetic: input.synthetic,
    generatedAt: input.now.toISOString(),
    grade: gradeTrend(input),
    completion: completion(input),
    prep: prep(input),
    topics: topicMastery(input),
    actions: nextActions(input),
  };
}
