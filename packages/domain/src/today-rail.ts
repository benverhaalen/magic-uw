import { projectWork } from "./work";
import type { DayPlanEntry, DeadlineResolution, ResourceInput } from "@magic/contracts";

export interface RailResource {
  id: string;
  kind: ResourceInput["kind"];
  title: string;
  courseId: string;
  courseName: string;
  completed: boolean;
  submitted: boolean | null;
  deadline: DeadlineResolution;
  kindLabel: string | null;
  calendar?: ResourceInput["calendar"];
  updatedAt?: string | null;
  createdAt?: string | null;
  deleted?: boolean;
  externalId?: string;
  points?: number | null;
  lockAt?: string | null;
  submission?: ResourceInput["submission"];
  assignmentGroupId?: string | null;
  assignmentGroup?: ResourceInput["assignmentGroup"];
}
export interface RailEvent {
  id: string;
  title: string;
  courseName: string;
  startMin: number;
  endMin: number | null;
  startOnly: boolean;
  location?: string;
  onlineMeeting?: "teams";
}
export interface RailDue {
  id: string;
  title: string;
  courseName: string;
  dueMin: number;
  conflict: boolean;
}
export interface EffortBand {
  category: "exam" | "quiz" | "problem_set" | "essay" | "project" | "reading" | "discussion";
  lowMin: number;
  highMin: number;
  basis: string;
}
export interface RailSuggestion {
  id: string;
  type: "prep" | "work" | "exam";
  resourceId: string;
  title: string;
  courseName: string;
  reason: string;
  /** Short, scannable versions of the reason, most important first. */
  factors: string[];
  startMin: number;
  endMin: number;
  effort: EffortBand | null;
  /** suggested: not yet reviewed. planned: the student accepted or edited it. done: crossed out. */
  state: "suggested" | "planned" | "done";
  /** Canvas reports the submission, or the student marked a study block done. */
  doneBy: "canvas" | "student" | null;
}
/** The student's decision about one suggestion on one day; the schema lives in contracts. */
export type PlanEntry = DayPlanEntry;
export type PlanBlock = DayPlanEntry["block"];
export function planEntry(
  s: RailSuggestion,
  date: string,
  status: PlanEntry["status"],
): PlanEntry {
  const { type, resourceId, title, courseName, startMin, endMin } = s;
  return { key: s.id, date, status, block: { type, resourceId, title, courseName, startMin, endMin } };
}
/** Checks a student's edit. Overlapping a class is allowed but reported. */
export function validatePlanEdit(
  range: { startMin: number; endMin: number },
  events: RailEvent[],
): { ok: boolean; reason?: string; overlaps: string[] } {
  const { startMin: s, endMin: e } = range;
  if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e > 24 * 60)
    return { ok: false, reason: "Pick a time within today.", overlaps: [] };
  if (e - s < 10) return { ok: false, reason: "A block needs at least 10 minutes.", overlaps: [] };
  const overlaps = events
    .filter((ev) => s < (ev.endMin ?? ev.startMin + START_ONLY_MIN) && ev.startMin < e)
    .map((ev) => ev.title);
  return { ok: true, overlaps };
}
export interface TodayRail {
  date: string;
  nowMin: number;
  due: RailDue[];
  allDay: RailEvent[];
  events: RailEvent[];
  suggestions: RailSuggestion[];
  hours: { start: number; end: number };
  hasCalendarSource: boolean;
  /** Minutes the student accepted or edited onto today's plan. */
  plannedMin: number;
  /** Minutes still only suggested. Kept separate so proposals never read as plans. */
  suggestedMin: number;
}

const DAY_END = 22 * 60;
const START_ONLY_MIN = 30;
const PREP_MIN = 25;
const MAX_PREP = 2;
const MAX_BLOCK_MIN = 90;
const MIN_BLOCK_MIN = 30;
const HORIZON_DAYS = 7;
const MAX_WORK = 3;
// Planned work stops here; spaced, shorter sessions beat filling every gap.
const DAILY_BUDGET_MIN = 180;
const BREAK_MIN = 15;
// Titles that name a class meeting. Office hours, exams, and other events get no prep block.
const CLASS_SESSION = /\b(lecture|class|workshop|lab|seminar|section|recitation)\b/i;

export function localTime(iso: string, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    min: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

const RULES: [EffortBand["category"], RegExp, number, number, string][] = [
  ["exam", /\b(midterm|exam)\b|\bfinal\b(?!\s+(project|paper|essay|report|presentation|draft))/i, 60, 240, "exam"],
  ["quiz", /\bquiz\b/i, 30, 60, "quiz"],
  ["problem_set", /problem.?set|homework|\bhw\s*\d|\bps\s*#?\d/i, 60, 180, "problem set"],
  ["essay", /\b(essay|paper|analysis|report)\b/i, 120, 300, "writing assignment"],
  ["project", /\bproject\b/i, 180, 480, "project"],
  ["discussion", /\bdiscussion\b/i, 20, 40, "discussion post"],
];

/** A typical range for the item's type. It is not measured and never an exact duration. */
export function effortBand(r: RailResource): EffortBand | null {
  const label = r.kindLabel?.replaceAll(" ", "_");
  for (const [category, pattern, lowMin, highMin, noun] of RULES)
    if (label === category || pattern.test(r.title))
      return {
        category,
        lowMin,
        highMin,
        basis: `Typical range for a ${noun}; an estimate, not measured.`,
      };
  if (r.kind === "material" || label === "reading")
    return {
      category: "reading",
      lowMin: 20,
      highMin: 45,
      basis: "Typical range for a reading; an estimate, not measured.",
    };
  return null;
}

function fmt(min: number) {
  const h = Math.floor(min / 60),
    m = min % 60;
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
}
function hours(lowMin: number, highMin: number) {
  const f = (v: number) => (v < 60 ? `${v} min` : `${+(v / 60).toFixed(1)} h`);
  return lowMin < 60 && highMin < 60
    ? `${lowMin}–${highMin} min`
    : `${f(lowMin)}–${f(highMin)}`.replace(/ h–/, "–");
}
function shortDate(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" }).format(new Date(iso));
}

/**
 * An assignment's share of its own course grade, from Canvas assignment-group weights.
 * Used only when that course's group weights add up to 100%; otherwise Canvas may not
 * apply them. Never compares raw points across courses.
 */
export function gradeShare(resources: RailResource[]) {
  const groups = resources.filter((r) => r.assignmentGroup?.weight != null);
  const totals = new Map<string, number>();
  for (const g of groups) totals.set(g.courseId, (totals.get(g.courseId) ?? 0) + g.assignmentGroup!.weight!);
  return (r: RailResource): { percent: number; text: string } | null => {
    if (!r.assignmentGroupId) return null;
    const total = totals.get(r.courseId) ?? 0;
    if (total < 99 || total > 101) return null;
    const g = groups.find((x) => x.courseId === r.courseId && (x.externalId ?? x.id) === r.assignmentGroupId);
    const weight = g?.assignmentGroup?.weight;
    if (!g || !weight) return null;
    const siblings = resources.filter(
      (x) => x.kind === "assignment" && x.courseId === r.courseId && x.assignmentGroupId === r.assignmentGroupId,
    );
    const pts = siblings.reduce((n, x) => n + (x.points ?? 0), 0);
    if (!r.points || !pts) return { percent: weight, text: `Counts in ${g.title}, ${weight}% of the ${r.courseName} grade.` };
    const percent = Math.max(1, Math.round((weight * r.points) / pts));
    return { percent, text: `About ${percent}% of the ${r.courseName} grade (${g.title} is ${weight}%, before any dropped scores).` };
  };
}

const done = (r: RailResource) => r.completed || r.submitted === true || r.deleted;

export function buildTodayRail(
  resources: RailResource[],
  now: string,
  timeZone: string,
  plan: PlanEntry[] = [],
): TodayRail {
  const today = localTime(now, timeZone);
  const live = resources.filter((r) => !r.deleted);
  const eventResources = live.filter((r) => r.kind === "event");

  const allDay: RailEvent[] = [];
  const events: RailEvent[] = [];
  for (const r of eventResources) {
    const cal = r.calendar;
    if (cal?.allDay) {
      const end = cal.end ?? cal.start;
      if (cal.start <= today.date && today.date <= end)
        allDay.push({ id: r.id, title: r.title, courseName: r.courseName, startMin: 0, endMin: null, startOnly: false });
      continue;
    }
    const startIso = cal?.start ?? r.deadline.claims.find((c) => c.kind === "event")?.value;
    if (!startIso) continue;
    const start = localTime(startIso, timeZone);
    if (start.date !== today.date) continue;
    const end = cal?.end ? localTime(cal.end, timeZone) : null;
    events.push({
      id: r.id,
      title: r.title,
      courseName: r.courseName,
      startMin: start.min,
      endMin: end ? (end.date === today.date ? end.min : 24 * 60) : null,
      startOnly: !end,
      ...(cal?.location ? { location: cal.location } : {}),
      ...(cal?.onlineMeeting ? { onlineMeeting: cal.onlineMeeting } : {}),
    });
  }
  events.sort((a, b) => a.startMin - b.startMin);

  // Due items and suggestion candidates come from the same projection as Home's Upcoming.
  const work = projectWork(resources, now, timeZone);
  const due: RailDue[] = work.dueToday.map((w) => ({
    id: w.id,
    title: w.title,
    courseName: w.courseName,
    dueMin: w.dueMin,
    conflict: w.conflict,
  }));

  // Free time from now until the evening, around timed events.
  let gaps: [number, number][] = [[Math.ceil(Math.max(today.min + BREAK_MIN, 8 * 60) / 15) * 15, DAY_END]];
  const reserve = (a: number, b: number) => {
    gaps = gaps.flatMap(([s, e]) =>
      b <= s || a >= e ? [[s, e] as [number, number]] : ([[s, a], [b, e]] as [number, number][]).filter(([x, y]) => y - x >= 15),
    );
  };
  for (const e of events) reserve(e.startMin, (e.endMin ?? e.startMin + START_ONLY_MIN) + BREAK_MIN);

  // The student's decisions for today come first: accepted blocks hold their time.
  const todays = plan.filter((p) => p.date === today.date);
  const decided = new Set(todays.map((p) => p.key));
  const accepted = todays.filter((p) => p.status === "accepted");
  for (const p of accepted) reserve(p.block.startMin - BREAK_MIN, p.block.endMin + BREAK_MIN);
  const acceptedWork = accepted.filter((p) => p.block.type !== "prep");

  const suggestions: RailSuggestion[] = [];
  const place = (length: number, latestEnd: number) => {
    const fit = gaps.find(([s, e]) => Math.min(e, latestEnd) - s >= length);
    if (!fit) return null;
    const slot = { start: fit[0], end: fit[0] + length };
    reserve(slot.start, slot.end);
    return slot;
  };

  // Prep: the most recent material in the same course, right before class.
  const prepped = new Set<string>();
  for (const e of events.filter(
    (e) => !e.startOnly && CLASS_SESSION.test(e.title) && e.startMin - today.min >= PREP_MIN,
  )) {
    if (suggestions.length + accepted.length - acceptedWork.length >= MAX_PREP) break;
    if (decided.has(`prep:${e.id}`)) continue;
    const event = eventResources.find((r) => r.id === e.id)!;
    const material = live
      .filter(
        (r) =>
          r.kind === "material" &&
          !r.assignmentGroup &&
          r.courseId === event.courseId &&
          !prepped.has(r.id),
      )
      .sort((a, b) => (b.updatedAt ?? b.createdAt ?? "").localeCompare(a.updatedAt ?? a.createdAt ?? ""))[0];
    if (!material) continue;
    const slot = { start: e.startMin - PREP_MIN, end: e.startMin };
    if (!gaps.some(([s, g]) => s <= slot.start && slot.end <= g)) continue;
    reserve(slot.start, slot.end);
    prepped.add(material.id);
    suggestions.push({
      id: `prep:${e.id}`,
      type: "prep",
      resourceId: material.id,
      title: `Prep for ${e.title}`,
      courseName: e.courseName,
      // Recency alone does not establish assigned or relevant reading; say so.
      reason: `Before ${e.title} at ${fmt(e.startMin)}. Newest saved course material is “${material.title}”; it isn't confirmed as assigned for this session.`,
      factors: [`Before class at ${fmt(e.startMin)}`, "Newest material, not confirmed assigned"],
      startMin: slot.start,
      endMin: slot.end,
      effort: null,
      state: "suggested",
      doneBy: null,
    });
  }

  // Work, in tiers: overdue but still accepted, due within 24 h, tight for its
  // estimated effort, exam review, then everything else due this week.
  const nowMs = Date.parse(now);
  const dayMs = 86400000;
  const share = gradeShare(live);
  const candidates = [...work.overdue, ...work.dueToday, ...work.upcoming]
    .map((w) => {
      const r = w.resource;
      const ms = Date.parse(w.dueAt);
      const band = w.effort;
      const lockMs = r.lockAt ? Date.parse(r.lockAt) : null;
      const hoursLeft = (ms - nowMs) / 3600000;
      const overdue = ms <= nowMs;
      const tight = !!band && !overdue && hoursLeft - band.highMin / 60 < 24;
      const tier = overdue
        ? 0
        : hoursLeft <= 24
          ? 1
          : tight
            ? 2
            : band?.category === "exam"
              ? 3
              : 4;
      return { r, ms, band, lockMs, hoursLeft, overdue, tight, tier, weight: share(r) };
    })
    // Overdue items are already limited by the projection; plan only the coming week.
    .filter((c) => c.overdue || c.ms - nowMs <= HORIZON_DAYS * dayMs)
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        // Grade share only orders ordinary work; urgency decides the other tiers.
        (a.tier === 4 ? (b.weight?.percent ?? -1) - (a.weight?.percent ?? -1) : 0) ||
        a.ms - b.ms,
    );
  let budget = DAILY_BUDGET_MIN - acceptedWork.reduce((n, p) => n + p.block.endMin - p.block.startMin, 0);
  for (const c of candidates) {
    if (suggestions.filter((s) => s.type !== "prep").length + acceptedWork.length >= MAX_WORK) break;
    if (decided.has(`exam:${c.r.id}`) || decided.has(`work:${c.r.id}`)) continue;
    const { r, band, hoursLeft, overdue, tier, weight } = c;
    const at = localTime(r.deadline.planningAt!, timeZone);
    const isExam = band?.category === "exam";
    const days = Math.max(1, Math.ceil(hoursLeft / 24));
    const sessions = Math.min(days, 3);
    const wanted = isExam ? (days <= 1 ? 90 : 60) : Math.min(band?.lowMin ?? 45, MAX_BLOCK_MIN);
    const length = Math.min(wanted, budget);
    if (length < MIN_BLOCK_MIN) break;
    const slot = place(length, !overdue && at.date === today.date ? at.min : DAY_END);
    if (!slot) continue;
    budget -= length;
    reserve(slot.end, slot.end + BREAK_MIN);

    const factors: string[] = [];
    const sentences: string[] = [];
    if (overdue) {
      const lock = c.lockMs ? localTime(r.lockAt!, timeZone) : null;
      factors.push("Overdue");
      sentences.push(
        lock
          ? `Overdue, but Canvas still accepts it until ${lock.date === today.date ? fmt(lock.min) : shortDate(r.lockAt!, timeZone)}.`
          : "Overdue. Canvas has no lock date recorded, so check the late policy.",
      );
    } else if (at.date === today.date) {
      factors.push(`Due ${fmt(at.min)}`);
      sentences.push(`Due tonight at ${fmt(at.min)}.`);
    } else {
      factors.push(`${isExam ? "Exam" : "Due"} in ${days} day${days === 1 ? "" : "s"}`);
      sentences.push(`${isExam ? "Exam" : "Due"} in ${days} day${days === 1 ? "" : "s"}.`);
    }
    if (tier === 2 && band) {
      factors.push("Tight");
      sentences.push(`Tight: about ${Math.round(hoursLeft)} h left for an estimated ${hours(band.lowMin, band.highMin)}.`);
    }
    if (isExam) sentences.push(sessions > 1 ? `Spaced review beats cramming; plan ${sessions} sessions before the exam.` : "Final review before the exam.");
    if (weight) {
      factors.push(`≈${weight.percent}% of grade`);
      sentences.push(weight.text);
    }
    if (band && !isExam) factors.push(`Est. ${hours(band.lowMin, band.highMin)}`);
    sentences.push(band ? `Est. ${hours(band.lowMin, band.highMin)} total.` : "Effort unknown.");
    if (r.deadline.conflict) {
      factors.push("Dates disagree");
      sentences.push("Sources disagree on the date; planning for the earlier one.");
    }
    suggestions.push({
      id: `${isExam ? "exam" : "work"}:${r.id}`,
      type: isExam ? "exam" : "work",
      resourceId: r.id,
      title: isExam
        ? sessions > 1
          ? `Review for ${r.title} · session 1 of ${sessions}`
          : `Final review for ${r.title}`
        : `${length < (band?.lowMin ?? 0) ? "Start" : "Work on"} ${r.title}`,
      courseName: r.courseName,
      reason: sentences.join(" "),
      factors,
      startMin: slot.start,
      endMin: slot.end,
      effort: band,
      state: "suggested",
      doneBy: null,
    });
  }
  for (const p of accepted) {
    const r = resources.find((x) => x.id === p.block.resourceId);
    const doneBy =
      p.block.type === "work"
        ? r?.submitted === true
          ? "canvas"
          : null
        : p.doneAt
          ? "student"
          : null;
    suggestions.push({
      id: p.key,
      ...p.block,
      reason: doneBy === "canvas" ? "Submitted on Canvas." : doneBy === "student" ? "You marked this done." : "On your plan for today.",
      factors: [],
      effort: r ? effortBand(r) : null,
      state: doneBy ? "done" : "planned",
      doneBy,
    });
  }
  suggestions.sort((a, b) => a.startMin - b.startMin);

  const spans = [...events.map((e) => [e.startMin, e.endMin ?? e.startMin + START_ONLY_MIN]), ...suggestions.map((s) => [s.startMin, s.endMin])];
  return {
    date: today.date,
    nowMin: today.min,
    due,
    allDay,
    events,
    suggestions,
    hours: {
      start: Math.min(8, ...spans.map(([s]) => Math.floor(s! / 60))),
      end: Math.max(18, ...spans.map(([, e]) => Math.ceil(e! / 60))),
    },
    hasCalendarSource: eventResources.length > 0,
    plannedMin: suggestions
      .filter((s) => s.state !== "suggested")
      .reduce((n, s) => n + s.endMin - s.startMin, 0),
    suggestedMin: suggestions
      .filter((s) => s.state === "suggested")
      .reduce((n, s) => n + s.endMin - s.startMin, 0),
  };
}
