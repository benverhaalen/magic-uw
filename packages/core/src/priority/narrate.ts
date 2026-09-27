/**
 * "Why now" lines (D49, D52). The model writes one line per top item over code's facts, in its own
 * words (no sentence templates); code checks that every number, weekday, month and relative day in
 * the line matches those facts and drops a line that fails. Without a client, or for a dropped
 * line, code writes a plain fact line ("Due Thu 11:59 pm · about 2 h · 15 pts").
 */
import { payloadHash } from "../egress";
import { addDays } from "../graph/agenda";
import { AGENDA_CONFIG, type AgendaConfig } from "./config";
import { formatMinutes } from "./estimate";
import type { RankedItem } from "./rank";

export const NARRATION_VERSION = "agenda.why.v1";

interface LocalParts {
  date: string;
  weekday: string;
  weekdayLong: string;
  month: string;
  monthLong: string;
  monthNum: number;
  day: number;
  year: number;
  hour24: number;
  hour12: number;
  minute: number;
  ampm: "am" | "pm";
}
const formatters = new Map<string, Intl.DateTimeFormat>();
export function localParts(ms: number, timeZone: string): LocalParts {
  let f = formatters.get(timeZone);
  if (!f)
    formatters.set(
      timeZone,
      (f = new Intl.DateTimeFormat("en-US", {
        timeZone, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", hourCycle: "h23",
      })),
    );
  const p = Object.fromEntries(f.formatToParts(ms).map((x) => [x.type, x.value]));
  const monthNum = new Date(`${p.month} 1, 2000`).getMonth() + 1;
  const hour24 = Number(p.hour) % 24;
  const day = Number(p.day);
  const year = Number(p.year);
  return {
    date: `${year}-${String(monthNum).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    weekday: p.weekday!.slice(0, 3),
    weekdayLong: p.weekday!,
    month: p.month!.slice(0, 3),
    monthLong: p.month!,
    monthNum,
    day,
    year,
    hour24,
    hour12: hour24 % 12 || 12,
    minute: Number(p.minute),
    ampm: hour24 < 12 ? "am" : "pm",
  };
}
const clock = (t: LocalParts) => `${t.hour12}${t.minute ? `:${String(t.minute).padStart(2, "0")}` : ""} ${t.ampm}`;
/** "Thu 11:59 pm" within the coming week, else "Thu Oct 14, 11:59 pm". */
export function when(ms: number, now: number, timeZone: string): string {
  const t = localParts(ms, timeZone);
  const near = Math.abs(ms - now) < 6 * 86_400_000;
  return near ? `${t.weekday} ${clock(t)}` : `${t.weekday} ${t.month} ${t.day}, ${clock(t)}`;
}

/** Code's line: the facts, plainly. */
export function codeLine(item: RankedItem, now: number, timeZone: string): string {
  const f = item.fact;
  const verb = f.kind === "exam" ? "Exam" : item.dateKind === "closes" ? "Closes" : item.flags.late ? "Was due" : "Due";
  const parts = [`${verb} ${when(item.dueMs, now, timeZone)}`];
  if (item.flags.missing) parts.unshift(item.flags.late ? "Missing, still accepted" : "Missing");
  parts.push(`about ${formatMinutes(item.estimate.minutes)}${f.kind === "exam" ? " of study" : ""}`);
  if (f.points) parts.push(`${f.points} pts`);
  if (item.flags.notYetOpen && f.unlockAt) parts.push(`opens ${when(Date.parse(f.unlockAt), now, timeZone)}`);
  return parts.join(" · ");
}

/** The facts the model sees for one item, as the strings code will check its line against. */
export interface NarrationFact {
  id: string;
  kind: string;
  course: string;
  title: string;
  due: string;
  startBy: string;
  estimate: string;
  daysLeft: number;
  points: number | null;
  gradeWeight: string | null;
  status: string[];
  covers: string[];
}

export function narrationFact(
  item: RankedItem,
  localId: string,
  now: number,
  timeZone: string,
  extra: { course: string; title: string; covers: string[] },
): NarrationFact {
  const f = item.fact;
  const day = (ms: number) => localParts(ms, timeZone).date;
  const daysLeft = Math.round((Date.parse(`${day(item.dueMs)}T00:00:00Z`) - Date.parse(`${day(now)}T00:00:00Z`)) / 86_400_000);
  const status = [
    ...(item.flags.missing ? ["missing"] : []),
    ...(item.flags.late ? ["overdue, still accepted"] : []),
    ...(item.flags.notYetOpen && f.unlockAt ? [`opens ${when(Date.parse(f.unlockAt), now, timeZone)}`] : []),
  ];
  return {
    id: localId,
    kind: f.kind,
    course: extra.course,
    title: extra.title,
    due: `${item.dateKind === "closes" ? "closes" : f.kind === "exam" ? "exam on" : "due"} ${when(item.dueMs, now, timeZone)}`,
    startBy: when(item.latestStartMs, now, timeZone),
    estimate: `about ${formatMinutes(item.estimate.minutes)} (estimate)`,
    daysLeft,
    points: f.points,
    gradeWeight: f.grade
      ? f.grade.basis === "computed"
        ? `about ${f.grade.percent}% of the course grade`
        : `its group or exam is ${f.grade.percent}% of the course grade`
      : null,
    status,
    covers: extra.covers,
  };
}

/** The agenda's fact hash: the top items' code facts and the local day. Narration is cached on it. */
export function narrationHash(items: RankedItem[], now: number, timeZone: string): string {
  return payloadHash({
    v: NARRATION_VERSION,
    today: localParts(now, timeZone).date,
    timeZone,
    items: items.map((i) => ({
      id: i.fact.id,
      hash: i.fact.contentHash,
      due: i.dueMs,
      kind: i.fact.kind,
      estimate: [i.estimate.minutes, i.estimate.method],
      points: i.fact.points,
      grade: i.fact.grade,
      flags: i.flags,
      unlock: i.fact.unlockAt,
    })),
  });
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** Number words checked like digits ("one" and "half" are too often not numbers to check). */
const WORD_NUMBERS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100,
};
const numbersIn = (text: string) => (text.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);

/**
 * Code's check of one model line against its item's facts. Every digit number must be one the
 * facts state (or a unit form of the estimate), every weekday and month one they name, and
 * "today", "tonight", "tomorrow" and "yesterday" must be true of the due date or the start-by
 * time. "Missing" and "overdue" need the flag.
 */
export function checkLine(
  line: string,
  fact: NarrationFact,
  item: RankedItem,
  now: number,
  timeZone: string,
  config: AgendaConfig = AGENDA_CONFIG,
): { ok: true } | { ok: false; reason: string } {
  const text = line.trim();
  if (!text) return { ok: false, reason: "empty" };
  if (text.length > config.narration.maxChars) return { ok: false, reason: "too long" };
  if (/[\r\n]/.test(text)) return { ok: false, reason: "more than one line" };
  const today = localParts(now, timeZone);
  const dates = [item.dueMs, item.latestStartMs, ...(item.fact.unlockAt ? [Date.parse(item.fact.unlockAt)] : [])].map((ms) => localParts(ms, timeZone));
  const factText = [fact.course, fact.title, fact.due, fact.startBy, fact.estimate, fact.gradeWeight ?? "", ...fact.status, ...fact.covers].join(" \n ");
  const allowed = new Set<number>([
    ...numbersIn(factText),
    fact.daysLeft,
    ...(fact.points !== null ? [fact.points] : []),
    item.estimate.minutes,
    Math.round((item.estimate.minutes / 60) * 2) / 2,
    ...dates.flatMap((d) => [d.day, d.monthNum, d.year, d.hour12, d.hour24, d.minute]),
    today.day, today.year,
  ]);
  for (const n of numbersIn(text)) if (!allowed.has(n)) return { ok: false, reason: `number ${n} isn't in the facts` };
  const lower = text.toLowerCase();
  for (const [word, n] of Object.entries(WORD_NUMBERS))
    if (new RegExp(`\\b${word}\\b`).test(lower) && !allowed.has(n)) return { ok: false, reason: `"${word}" isn't in the facts` };
  // A number with a unit must be that fact: hours and minutes the estimate, points the points,
  // a percent the grade weight, days the days left (a title's "Lab 3" doesn't license "3 hours").
  const hours = item.estimate.minutes / 60;
  const unitFacts: [RegExp, number[]][] = [
    [/\b(\d+(?:\.\d+)?|[a-z]+)[\s-]*(?:h|hrs?|hours?)\b/g, [hours, Math.round(hours * 2) / 2, Math.round(hours)]],
    [/\b(\d+|[a-z]+)[\s-]*(?:mins?|minutes?)\b/g, [item.estimate.minutes]],
    [/\b(\d+|[a-z]+)[\s-]*(?:pts?|points?)\b/g, fact.points !== null ? [fact.points] : []],
    [/\b(\d+(?:\.\d+)?)\s*(?:%|percent)/g, item.fact.grade ? [item.fact.grade.percent] : []],
    [/\b(\d+|[a-z]+)[\s-]*days?\b/g, [fact.daysLeft]],
  ];
  for (const [pattern, values] of unitFacts)
    for (const m of lower.matchAll(pattern)) {
      const n = /^\d/.test(m[1]!) ? Number(m[1]) : WORD_NUMBERS[m[1]!];
      if (n === undefined) continue; // "few hours", "extra points": no number claimed
      if (!values.includes(n)) return { ok: false, reason: `${m[0].trim()} doesn't match the facts` };
    }
  const days = new Set([...dates.map((d) => WEEKDAYS.indexOf(d.weekday.toLowerCase())), WEEKDAYS.indexOf(today.weekday.toLowerCase())]);
  for (const m of lower.matchAll(/\b(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|sday|nesday|rsday|urday)?\b/g)) {
    const i = WEEKDAYS.indexOf(m[1]!.slice(0, 3));
    if (!days.has(i)) return { ok: false, reason: `weekday ${m[0]} isn't in the facts` };
  }
  const months = new Set([...dates.map((d) => d.monthNum - 1), today.monthNum - 1]);
  for (const m of lower.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)(?:uary|ruary|ch|il|e|y|ust|tember|ober|ember)?\b/g)) {
    if (m[1] === "may" && !/\bmay\s+\d/.test(lower.slice(m.index!))) continue; // "may" the verb
    const i = MONTHS.indexOf(m[1]!.slice(0, 3));
    if (!months.has(i)) return { ok: false, reason: `month ${m[0]} isn't in the facts` };
  }
  // A written date ("Oct 2", "October 2nd", "10/2") must be one of the facts' dates, as a pair.
  const pairs = new Set([...dates, today].map((d) => `${d.monthNum}/${d.day}`));
  for (const m of lower.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/g)) {
    const pair = `${MONTHS.indexOf(m[1]!) + 1}/${Number(m[2])}`;
    if (!pairs.has(pair)) return { ok: false, reason: `date ${m[0]} isn't in the facts` };
  }
  for (const m of lower.matchAll(/\b(\d{1,2})\/(\d{1,2})\b/g))
    if (!pairs.has(`${Number(m[1])}/${Number(m[2])}`)) return { ok: false, reason: `date ${m[0]} isn't in the facts` };
  // A written time ("11:59 pm", "9 am", "23:59") must be one of the facts' times.
  const times = dates.flatMap((d) => [`${d.hour12}:${d.minute}${d.ampm}`, `${d.hour12}:${d.minute}`, `${d.hour24}:${d.minute}`, ...(d.minute === 0 ? [`${d.hour12}${d.ampm}`] : [])]);
  for (const m of lower.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?![\w/])/g)) {
    if (m[2] === undefined && !m[3]) continue;
    const ampm = m[3] ? (m[3].startsWith("a") ? "am" : "pm") : "";
    const key = m[2] !== undefined ? `${Number(m[1])}:${Number(m[2])}${ampm}` : `${Number(m[1])}${ampm}`;
    if (!times.includes(key)) return { ok: false, reason: `time ${m[0].trim()} isn't in the facts` };
  }
  const dueDay = localParts(item.dueMs, timeZone).date;
  const startDay = localParts(item.latestStartMs, timeZone).date;
  const tomorrow = addDays(today.date, 1);
  const yesterday = addDays(today.date, -1);
  if (/\b(today|tonight)\b/.test(lower) && dueDay !== today.date && startDay !== today.date) return { ok: false, reason: "says today, but neither date is today" };
  if (/\btomorrow\b/.test(lower) && dueDay !== tomorrow && startDay !== tomorrow) return { ok: false, reason: "says tomorrow, but neither date is tomorrow" };
  if (/\byesterday\b/.test(lower) && dueDay !== yesterday) return { ok: false, reason: "says yesterday, but it wasn't due yesterday" };
  if (/\bmissing\b/.test(lower) && !item.flags.missing) return { ok: false, reason: "says missing, but it isn't" };
  if (/\boverdue\b|\blate\b/.test(lower) && !item.flags.late) return { ok: false, reason: "says overdue, but it isn't" };
  return { ok: true };
}
