/**
 * Relative dates in the student's time zone, by code. The model never computes a date: it copies
 * the phrase, and this turns it into an inclusive local-date range.
 */
import type { DateRange } from "./types";

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_ALIASES: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};
const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

/** The local calendar date of `now` in the zone, as UTC-midnight milliseconds for day arithmetic. */
export function localDay(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"));
}
const DAY = 86_400_000;
export const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const range = (from: number, to: number, label: string): DateRange => ({ from: isoDay(from), to: isoDay(to), label });

const WEEKDAY_RE = "(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:s|nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)";
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

/** Date phrases the code path recognises, longest first; used to find and remove the span. */
export const DATE_PATTERN = new RegExp(
  [
    "\\b(?:for |on |by |due )?(?:today|tonight|tomorrow|tmrw|tmr|yesterday)\\b",
    "\\b(?:for |on |by |due )?(?:this|next|last) (?:week(?:end)?|month)\\b",
    `\\b(?:for |on |by |due )?(?:this |next |on |by )?${WEEKDAY_RE}\\b`,
    "\\b(?:in |within |over )?(?:the )?(?:next )?\\d{1,2} days\\b",
    "\\b\\d{4}-\\d{2}-\\d{2}\\b",
    `\\b(?:on |by )?${MONTH_RE}\\.? \\d{1,2}(?:st|nd|rd|th)?\\b`,
    "\\b(?:on |by )?\\d{1,2}/\\d{1,2}\\b",
  ].join("|"),
  "i",
);

/**
 * Resolve a date phrase to an inclusive range. Weeks run Monday to Sunday. "next tuesday" is the
 * Tuesday of next week; a bare weekday ("tuesday", "this tuesday") is the next one on or after today.
 */
export function resolveDate(phrase: string, now: Date, timeZone: string): DateRange | null {
  const p = phrase.toLowerCase().replace(/[.,!?]/g, " ").replace(/\s+/g, " ").trim().replace(/^(?:for|on|by|due|in|within|over) /, "");
  if (!p) return null;
  const today = localDay(now, timeZone);
  const dow = new Date(today).getUTCDay();
  const monday = today - ((dow + 6) % 7) * DAY;
  if (/^(today|tonight)$/.test(p)) return range(today, today, "today");
  if (/^(tomorrow|tmrw|tmr)$/.test(p)) return range(today + DAY, today + DAY, "tomorrow");
  if (p === "yesterday") return range(today - DAY, today - DAY, "yesterday");
  if (p === "this week") return range(today, monday + 6 * DAY, "this week");
  if (p === "next week") return range(monday + 7 * DAY, monday + 13 * DAY, "next week");
  if (p === "last week") return range(monday - 7 * DAY, monday - DAY, "last week");
  if (p === "this weekend") return range(Math.max(today, monday + 5 * DAY), monday + 6 * DAY, "this weekend");
  if (p === "next weekend") return range(monday + 12 * DAY, monday + 13 * DAY, "next weekend");
  if (p === "this month" || p === "next month") {
    const d = new Date(today);
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + (p === "next month" ? 1 : 0);
    const first = Date.UTC(y, m, 1), last = Date.UTC(y, m + 1, 0);
    return range(p === "this month" ? today : first, last, p);
  }
  const days = /^(?:the )?(?:next )?(\d{1,2}) days$/.exec(p);
  if (days) {
    const n = Number(days[1]);
    return n >= 1 && n <= 60 ? range(today, today + (n - 1) * DAY, `the next ${n} days`) : null;
  }
  const wd = /^(this |next |on |by )?([a-z]+)$/.exec(p);
  if (wd && wd[2]! in WEEKDAY_ALIASES) {
    const target = WEEKDAY_ALIASES[wd[2]!]!;
    const ahead = (target - dow + 7) % 7;
    let at = today + ahead * DAY;
    // "next tuesday": the one in next week (Monday-based), never this week's.
    if (wd[1] === "next ") at = monday + 7 * DAY + ((target + 6) % 7) * DAY;
    return range(at, at, `${wd[1] === "next " ? "next " : ""}${WEEKDAYS[target]}`);
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(p);
  if (iso) {
    const ms = Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return Number.isFinite(ms) && isoDay(ms) === p ? range(ms, ms, p) : null;
  }
  const named = /^([a-z]+) (\d{1,2})(?:st|nd|rd|th)?$/.exec(p) ?? null;
  const slash = /^(\d{1,2})\/(\d{1,2})$/.exec(p);
  const md = named && named[1]! in MONTHS ? [MONTHS[named[1]!]!, Number(named[2])] : slash ? [Number(slash[1]), Number(slash[2])] : null;
  if (md) {
    const [m, d] = md as [number, number];
    const year = new Date(today).getUTCFullYear();
    let ms = Date.UTC(year, m - 1, d);
    if (new Date(ms).getUTCMonth() !== m - 1) return null;
    // A date more than two months back means next year's (the term rolls forward).
    if (ms < today - 60 * DAY) ms = Date.UTC(year + 1, m - 1, d);
    return range(ms, ms, isoDay(ms));
  }
  return null;
}
