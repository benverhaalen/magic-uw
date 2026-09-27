import type { DeadlineResolution, ResourceInput } from "@magic/contracts";

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
}
export interface RailEvent {
  id: string;
  title: string;
  courseName: string;
  startMin: number;
  endMin: number | null;
  startOnly: boolean;
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
  startMin: number;
  endMin: number;
  effort: EffortBand | null;
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
}

const DAY_END = 22 * 60;
const START_ONLY_MIN = 30;
const PREP_MIN = 25;
const EXAM_BLOCK_MIN = 60;
const MAX_BLOCK_MIN = 90;
const HORIZON_DAYS = 7;
const MAX_WORK = 3;
// Titles that name a class meeting. Office hours, exams, and other events get no prep block.
const CLASS_SESSION = /\b(lecture|class|workshop|lab|seminar|section|recitation)\b/i;

function local(iso: string, timeZone: string) {
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
  ["exam", /\b(midterm|exam|final)\b/i, 60, 240, "exam"],
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
const done = (r: RailResource) => r.completed || r.submitted === true || r.deleted;

export function buildTodayRail(
  resources: RailResource[],
  now: string,
  timeZone: string,
): TodayRail {
  const today = local(now, timeZone);
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
    const start = local(startIso, timeZone);
    if (start.date !== today.date) continue;
    const end = cal?.end ? local(cal.end, timeZone) : null;
    events.push({
      id: r.id,
      title: r.title,
      courseName: r.courseName,
      startMin: start.min,
      endMin: end ? (end.date === today.date ? end.min : 24 * 60) : null,
      startOnly: !end,
    });
  }
  events.sort((a, b) => a.startMin - b.startMin);

  const open = live.filter((r) => r.kind === "assignment" && !done(r) && r.deadline.planningAt);
  const due: RailDue[] = open
    .map((r) => ({ r, at: local(r.deadline.planningAt!, timeZone) }))
    .filter(({ at }) => at.date === today.date)
    .map(({ r, at }) => ({ id: r.id, title: r.title, courseName: r.courseName, dueMin: at.min, conflict: r.deadline.conflict }))
    .sort((a, b) => a.dueMin - b.dueMin);

  // Free time from now until the evening, around timed events.
  let gaps: [number, number][] = [[Math.ceil(Math.max(today.min, 8 * 60) / 15) * 15, DAY_END]];
  const reserve = (a: number, b: number) => {
    gaps = gaps.flatMap(([s, e]) =>
      b <= s || a >= e ? [[s, e] as [number, number]] : ([[s, a], [b, e]] as [number, number][]).filter(([x, y]) => y - x >= 15),
    );
  };
  for (const e of events) reserve(e.startMin, e.endMin ?? e.startMin + START_ONLY_MIN);

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
    const event = eventResources.find((r) => r.id === e.id)!;
    const material = live
      .filter((r) => r.kind === "material" && r.courseId === event.courseId && !prepped.has(r.id))
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
      title: `Review ${material.title}`,
      courseName: e.courseName,
      reason: `Before ${e.title} at ${fmt(e.startMin)}. Latest material saved for this course.`,
      startMin: slot.start,
      endMin: slot.end,
      effort: null,
    });
  }

  // Work: due within 24h first, then exams within 3 days, then soonest.
  const nowMs = Date.parse(now);
  const dayMs = 86400000;
  const candidates = open
    .map((r) => ({ r, ms: Date.parse(r.deadline.planningAt!), band: effortBand(r) }))
    .filter(({ ms }) => ms > nowMs && ms - nowMs <= HORIZON_DAYS * dayMs)
    .map((c) => ({
      ...c,
      tier: c.ms - nowMs <= dayMs ? 0 : c.band?.category === "exam" && c.ms - nowMs <= 3 * dayMs ? 1 : 2,
    }))
    .sort((a, b) => a.tier - b.tier || a.ms - b.ms);
  for (const { r, ms, band, tier } of candidates) {
    if (suggestions.filter((s) => s.type !== "prep").length >= MAX_WORK) break;
    const at = local(r.deadline.planningAt!, timeZone);
    const isExam = band?.category === "exam";
    const length = isExam ? EXAM_BLOCK_MIN : Math.min(band?.lowMin ?? 45, MAX_BLOCK_MIN);
    const slot = place(length, at.date === today.date ? at.min : DAY_END);
    if (!slot) continue;
    const days = Math.round((ms - nowMs) / dayMs);
    const when =
      at.date === today.date
        ? `Due tonight at ${fmt(at.min)}`
        : `${isExam ? "Exam" : "Due"} in ${days} day${days === 1 ? "" : "s"}`;
    const effortText = band ? ` Est. ${hours(band.lowMin, band.highMin)} total.` : " Effort unknown.";
    const why = tier === 0 && at.date !== today.date ? " Due soonest." : tier === 1 ? " Exam coming up; spread review over the days before." : "";
    suggestions.push({
      id: `${isExam ? "exam" : "work"}:${r.id}`,
      type: isExam ? "exam" : "work",
      resourceId: r.id,
      title: isExam ? `Review for ${r.title}` : `${length < (band?.lowMin ?? 0) ? "Start" : "Work on"} ${r.title}`,
      courseName: r.courseName,
      reason: `${when}.${why}${effortText}${r.deadline.conflict ? " Sources disagree on the date; planning for the earlier one." : ""}`,
      startMin: slot.start,
      endMin: slot.end,
      effort: band,
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
  };
}
