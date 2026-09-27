/**
 * Deterministic deadline extraction from course prose and titles.
 *
 * Bounded grammar rather than a general natural-language date parser: a claim is
 * emitted only for a date-like phrase in a clause that also contains deadline
 * language (due, deadline, submit, late ... until, exam). A missing year or a
 * relative day is resolved only from an explicit anchor (the course term, the
 * source's own timestamp, or an announcement's post time); otherwise the phrase is
 * returned unresolved with a reason. Nothing is guessed from "now".
 */
import type {
  DeadlineClaim,
  DeadlineClaimDetails,
  DeadlineSpan,
} from "@magic/contracts";

export const DEADLINE_TIME_ZONE = "America/Chicago";
const DAY = 86_400_000;

// ---------------------------------------------------------------- time zones
const formatters = new Map<string, Intl.DateTimeFormat>();
function zoneParts(ms: number, timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  const p = Object.fromEntries(
    f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]),
  );
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    h: Number(p.hour) % 24,
    min: Number(p.minute),
    s: Number(p.second),
  };
}
/** Wall-clock time in `timeZone` to a UTC ISO instant (DST-aware). */
export function zonedTimeToUtc(
  y: number,
  m: number,
  d: number,
  h: number,
  min: number,
  timeZone = DEADLINE_TIME_ZONE,
): string {
  const target = Date.UTC(y, m - 1, d, h, min);
  let ms = target;
  for (let i = 0; i < 3; i++) {
    const p = zoneParts(ms, timeZone);
    ms -= Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - target;
  }
  return new Date(ms).toISOString();
}
/** Calendar date of an instant in `timeZone`. */
export function zonedDate(iso: string, timeZone = DEADLINE_TIME_ZONE) {
  const p = zoneParts(Date.parse(iso), timeZone);
  return { y: p.y, m: p.m, d: p.d };
}
const validDate = (y: number, m: number, d: number) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};
const weekdayOf = (y: number, m: number, d: number) =>
  new Date(Date.UTC(y, m - 1, d)).getUTCDay();
const calendarMs = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);

// ---------------------------------------------------------------- vocabulary
const MONTH =
  "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const WEEKDAY =
  "(mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)";
const WEEKDAY_FULL = "(monday|tuesday|wednesday|thursday|friday|saturday|sunday)";
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const monthIndex = (s: string) => MONTHS.indexOf(s.slice(0, 3).toLowerCase()) + 1;
const weekdayIndex = (s: string | undefined) =>
  s ? WEEKDAYS.indexOf(s.slice(0, 3).toLowerCase()) : -1;

const ZONE =
  "(?:\\s*\\(?\\s*(ct|cst|cdt|central(?:\\s+time)?|et|est|edt|eastern(?:\\s+time)?|mt|mst|mdt|mountain(?:\\s+time)?|pt|pst|pdt|pacific(?:\\s+time)?|utc|gmt)\\b\\)?)?";
const TIME =
  `(?:(\\d{1,2})(?::([0-5]\\d))?\\s*([ap])\\.?\\s?m\\b\\.?|(noon|midnight)\\b|([01]?\\d|2[0-3]):([0-5]\\d)\\b(?!\\s*[ap]\\.?\\s?m))${ZONE}`;
const TIME_AFTER = new RegExp(
  `^[\\s,]*(?:(?:at|by|@|before|until|till|-|–|—)\\s*)?(?:the\\s+)?${TIME}`,
  "i",
);
const TIME_BEFORE = new RegExp(`${TIME}\\s*(?:on\\s+|,\\s*)?(?:the\\s+)?$`, "i");
/** A time later in the same clause, introduced by deadline language ("9/25 | HW3 due at 11:59pm"). */
const TIME_IN_CLAUSE = new RegExp(`\\b(?:due|by|at|@|before)\\s+(?:the\\s+)?${TIME}`, "i");
const CLASS_TIME =
  /\b(?:(?:start|beginning)\s+of\s+(?:class|lecture|lab|section|discussion)|in\s+class|before\s+(?:class|lecture)|end\s+of\s+(?:the\s+)?day|eod)\b/i;
const ZONES: Record<string, string> = {
  ct: DEADLINE_TIME_ZONE,
  cst: DEADLINE_TIME_ZONE,
  cdt: DEADLINE_TIME_ZONE,
  central: DEADLINE_TIME_ZONE,
  et: "America/New_York",
  est: "America/New_York",
  edt: "America/New_York",
  eastern: "America/New_York",
  mt: "America/Denver",
  mst: "America/Denver",
  mdt: "America/Denver",
  mountain: "America/Denver",
  pt: "America/Los_Angeles",
  pst: "America/Los_Angeles",
  pdt: "America/Los_Angeles",
  pacific: "America/Los_Angeles",
  utc: "UTC",
  gmt: "UTC",
};

const LATE =
  /\blate\b[^.;]*?\b(?:until|through|thru|till|by|before)\b|\baccept(?:ed|s)?\s+(?:until|through|thru|till)\b|\bno\s+(?:late\s+)?(?:submissions?|work)\s+(?:will\s+be\s+)?accepted\s+after\b|\blast\s+day\s+to\s+(?:submit|turn)\b/i;
const CLOSES = /\b(?:closes?|locks?|locked|cut-?off|available\s+until)\b/i;
const DUE =
  /\b(?:due|deadlines?|submit(?:ted)?|submissions?|turn(?:ed)?\s+in|hand(?:ed)?\s+in|upload(?:ed)?)\b/i;
const EXAM = /\b(?:exams?|midterms?|finals?|quiz(?:zes)?|tests?|presentations?)\b/i;
const CHANGE =
  /\b(?:extend(?:ed|ing)?|extension|moved?|postpon(?:ed|ing)|pushed|push(?:ing)?\s+back|reschedul(?:ed|ing)|delayed|now\s+due|new\s+(?:due\s+date|deadline)|instead\s+of|changed?)\b/i;
const PREVIOUS =
  /\b(?:from|instead\s+of|originally(?:\s+due)?|previously(?:\s+due)?|was(?:\s+due)?|no\s+longer\s+due|not\s+due)(?:\s+(?:on|by))?\s*(?:the\s+)?$/i;
const NEGATED = /\bno\s+(?:class|lecture|exam|quiz|lab)\b|\bcancel+ed\b/i;
/** Numeric M/D preceded by these is a reference or score, not a date. */
const NOT_DATE_BEFORE =
  /\b(?:ch|chap|chapter|sec|section|§|p|pp|pg|page|pages|problems?|prob|exercises?|ex|questions?|q|slides?|scored?|got|earned|grades?|graded|points?|pts|out\s+of|version|v|rev|ratio|eq|equation|fig|figure|table|rubric)\.?\s*#?\s*(?:\d+(?:[/.\-]\d+)*[a-z]?\s*(?:,|&|and|or|-|–)\s*)*$/i;
const NOT_DATE_AFTER = /^\s*(?:pts|points|marks|%|of\b|correct|right|questions|on\s+the\s+(?:quiz|exam|test))/i;

/** Assignment identifiers such as "HW3", "Homework 3", "Project 2", "Lab 4". */
const CODE =
  /\b(homework|hw|problem\s*set|pset|ps|project|proj|lab|quiz|exam|midterm|assignment|asgn|mp|pa)\s*#?\s*(\d{1,2}[a-z]?)\b|\bp(\d{1,2})\b/gi;
const FAMILY: Record<string, string> = {
  homework: "hw",
  hw: "hw",
  pset: "ps",
  ps: "ps",
  project: "project",
  proj: "project",
  lab: "lab",
  quiz: "quiz",
  exam: "exam",
  midterm: "midterm",
  assignment: "assignment",
  asgn: "assignment",
  mp: "mp",
  pa: "pa",
};
export function identifiersIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(CODE)) {
    if (m[3]) out.add(`project${Number(m[3])}`);
    else {
      const family = FAMILY[m[1]!.toLowerCase().replace(/\s+/g, "")] ??
        (/^problem/i.test(m[1]!) ? "ps" : m[1]!.toLowerCase());
      const num = m[2]!.toLowerCase().replace(/^0+(?=\d)/, "");
      out.add(`${family}${num}`);
    }
  }
  return [...out];
}

// ---------------------------------------------------------------- sentences
const ABBREVIATIONS = new Set([
  // am/pm are omitted on purpose: "11:59pm. Next sentence" must split.
  "jan", "feb", "mar", "apr", "jun", "jul", "aug",
  "sep", "sept", "oct", "nov", "dec", "mon", "tue", "tues", "wed", "thu",
  "thur", "thurs", "fri", "sat", "sun", "no", "vs", "e.g", "i.e", "etc", "dr",
  "prof", "mr", "ms", "mrs", "st", "ch", "sec", "pp", "p", "fig", "approx",
  "ex", "q",
]);
function sentences(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = 0;
  const push = (end: number) => {
    let s = start,
      e = end;
    while (s < e && /\s/.test(text[s]!)) s++;
    while (e > s && /\s/.test(text[e - 1]!)) e--;
    if (e > s) out.push([s, e]);
    start = end;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    let cut = c === "\n" || c === "!" || c === "?" || c === ";" || c === "•";
    if (c === "." && (i === text.length - 1 || /^\s+[A-Z0-9("'“]/.test(text.slice(i + 1, i + 4)))) {
      const word = /([A-Za-z.]+)$/
        .exec(text.slice(Math.max(0, i - 8), i))?.[1]
        ?.toLowerCase()
        .replace(/^\.+/, "");
      cut = !word || !ABBREVIATIONS.has(word);
    }
    if (cut) push(i + 1);
  }
  push(text.length);
  return out;
}

// ---------------------------------------------------------------- matching
interface DateToken {
  start: number;
  end: number;
  priority: number;
  kind: "absolute" | "relative" | "weekday" | "vague";
  y?: number;
  m?: number;
  d?: number;
  weekday?: number;
  /** For explicit instants such as ISO with offset. */
  instant?: string;
  hour?: number;
  minute?: number;
  word?: string;
  qualifier?: string;
}
const PATTERNS: Array<{ re: RegExp; build: (m: RegExpExecArray) => DateToken | null }> = [
  {
    re: /\b(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?(?!\d)/g,
    build: (m) => {
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const token: DateToken = { start: m.index, end: m.index + m[0].length, priority: 0, kind: "absolute", y, m: mo, d };
      if (m[4]) {
        if (m[6]) {
          const parsed = Date.parse(m[0].replace(" ", "T"));
          if (Number.isFinite(parsed)) token.instant = new Date(parsed).toISOString();
        } else {
          token.hour = Number(m[4]);
          token.minute = Number(m[5]);
        }
      }
      return token;
    },
  },
  {
    re: new RegExp(`\\b(?:${WEEKDAY}\\.?,?\\s+)?${MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?![\\d:])(?:,?\\s+(\\d{4}))?`, "gi"),
    build: (m) =>
      m[2] === "may" ? null : {
        start: m.index,
        end: m.index + m[0].length,
        priority: 1,
        kind: "absolute",
        weekday: weekdayIndex(m[1]),
        m: monthIndex(m[2]!),
        d: Number(m[3]),
        ...(m[4] ? { y: Number(m[4]) } : {}),
      },
  },
  {
    re: new RegExp(`\\b(?:${WEEKDAY}\\.?,?\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\.?(?![a-z])(?:,?\\s+(\\d{4}))?`, "gi"),
    build: (m) =>
      m[3] === "may" ? null : {
        start: m.index,
        end: m.index + m[0].length,
        priority: 2,
        kind: "absolute",
        weekday: weekdayIndex(m[1]),
        m: monthIndex(m[3]!),
        d: Number(m[2]),
        ...(m[4] ? { y: Number(m[4]) } : {}),
      },
  },
  {
    re: new RegExp(`(?<![\\w/.\\-:])(?:${WEEKDAY}\\.?,?\\s+)?(\\d{1,2})\\/(\\d{1,2})(?:\\/(\\d{4}|\\d{2}))?(?![\\w/])`, "gi"),
    build: (m) => {
      const year = m[4] ? Number(m[4].length === 2 ? `20${m[4]}` : m[4]) : undefined;
      return {
        start: m.index,
        end: m.index + m[0].length,
        priority: 3,
        kind: "absolute",
        weekday: weekdayIndex(m[1]),
        m: Number(m[2]),
        d: Number(m[3]),
        ...(year ? { y: year } : {}),
      };
    },
  },
  {
    re: /\b(today|tonight|tomorrow)\b/gi,
    build: (m) => ({ start: m.index, end: m.index + m[0].length, priority: 4, kind: "relative", word: m[1]!.toLowerCase() }),
  },
  {
    re: new RegExp(`\\b(?:(this|next|coming|on)\\s+)?${WEEKDAY_FULL}\\b`, "gi"),
    build: (m) => ({
      start: m.index,
      end: m.index + m[0].length,
      priority: 5,
      kind: "weekday",
      weekday: weekdayIndex(m[2]),
      qualifier: m[1]?.toLowerCase(),
    }),
  },
  {
    re: /\b(next\s+week|this\s+week|end\s+of\s+(?:the\s+)?(?:week|month|semester|term)|this\s+weekend|next\s+weekend|later\s+this\s+(?:week|month))\b/gi,
    build: (m) => ({ start: m.index, end: m.index + m[0].length, priority: 6, kind: "vague", word: m[1]!.toLowerCase() }),
  },
];
function dateTokens(text: string): DateToken[] {
  const found: DateToken[] = [];
  for (const { re, build } of PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const token = build(m);
      if (token) found.push(token);
    }
  }
  found.sort((a, b) => a.priority - b.priority || a.start - b.start);
  const accepted: DateToken[] = [];
  for (const t of found)
    if (!accepted.some((a) => t.start < a.end && a.start < t.end)) accepted.push(t);
  return accepted
    .filter((t) => {
      if (t.kind !== "absolute" || t.priority !== 3) return true;
      if (t.m! < 1 || t.m! > 12 || t.d! < 1 || t.d! > 31) return false;
      return (
        !NOT_DATE_BEFORE.test(text.slice(Math.max(0, t.start - 48), t.start)) &&
        !NOT_DATE_AFTER.test(text.slice(t.end, t.end + 24))
      );
    })
    .sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------- extraction
export interface ExtractionAnchors {
  /** When the source said this (e.g. announcement post). Anchors today/tomorrow/weekday phrases. */
  statedAt?: string;
  /** The source's own timestamp (updated/created). Anchors a missing year only. */
  sourceDate?: string;
  /** Course term window. Anchors a missing year. */
  term?: { start: string; end: string } | null;
}
export interface ExtractionSource {
  resourceId: string;
  version: number;
  contentHash: string;
  field: "title" | "text";
  text: string;
}
export interface DeadlineMention {
  kind: DeadlineClaim["kind"];
  detail?: DeadlineClaimDetails["detail"];
  /** Null when the phrase could not be pinned without inventing information. */
  value: string | null;
  precision?: "minute" | "day";
  inference?: DeadlineClaimDetails["inference"];
  unresolvedReason?: string;
  note?: string;
  /** Sentence states a change (extended, moved, now due ...). */
  change: boolean;
  /** This date is the one being replaced ("from 9/26", "instead of 9/26"). */
  previous: boolean;
  supersedes?: string;
  span: DeadlineSpan;
  /** The date phrase itself within the source text. */
  match: { start: number; end: number; text: string };
  identifiers: string[];
}

function classify(lead: string, tail: string, prefix: string) {
  const test = (s: string) =>
    LATE.test(s)
      ? { kind: "lock" as const, detail: "late_until" as const }
      : CLOSES.test(s)
        ? { kind: "lock" as const, detail: "closes" as const }
        : DUE.test(s)
          ? { kind: "due" as const }
          : EXAM.test(s)
            ? { kind: "event" as const, detail: "exam" as const }
            : null;
  return test(lead) ?? test(prefix) ?? test(tail);
}
function timeFrom(m: RegExpExecArray | null) {
  if (!m) return null;
  let hour: number, minute: number;
  if (m[1]) {
    hour = Number(m[1]);
    minute = Number(m[2] ?? 0);
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (m[3]!.toLowerCase() === "p" ? 12 : 0);
  } else if (m[4]) {
    if (m[4].toLowerCase() === "midnight") return { ambiguous: "midnight" as const };
    hour = 12;
    minute = 0;
  } else {
    hour = Number(m[5]);
    minute = Number(m[6]);
  }
  const zone = m[7] ? ZONES[m[7].toLowerCase().split(/\s+/)[0]!] : undefined;
  return { hour, minute, zone };
}
type Resolved =
  | { ok: true; y: number; m: number; d: number; inference?: DeadlineMention["inference"] }
  | { ok: false; reason: string };
function resolveYear(m: number, d: number, anchors: ExtractionAnchors): Resolved {
  const pick = (years: number[], lo: number, hi: number) =>
    [...new Set(years)].filter((y) => {
      if (!validDate(y, m, d)) return false;
      const t = calendarMs(y, m, d);
      return t >= lo && t <= hi;
    });
  let fromTerm: number[] | null = null,
    fromSource: number[] | null = null;
  if (anchors.term) {
    const s = zonedDate(anchors.term.start),
      e = zonedDate(anchors.term.end);
    fromTerm = pick(
      [s.y - 1, s.y, e.y, e.y + 1],
      calendarMs(s.y, s.m, s.d) - 21 * DAY,
      calendarMs(e.y, e.m, e.d) + 21 * DAY,
    );
  }
  const stamp = anchors.statedAt ?? anchors.sourceDate;
  if (stamp) {
    const a = zonedDate(stamp),
      t = calendarMs(a.y, a.m, a.d);
    fromSource = pick([a.y - 1, a.y, a.y + 1], t - 60 * DAY, t + 300 * DAY);
  }
  if (fromTerm?.length === 1) {
    if (fromSource?.length === 1 && fromSource[0] !== fromTerm[0])
      return { ok: false, reason: "The course term and the source date imply different years." };
    return { ok: true, y: fromTerm[0]!, m, d, inference: "year_from_term" };
  }
  if (fromTerm && fromTerm.length === 0 && !fromSource?.length)
    return { ok: false, reason: "No year is stated and the date falls outside the course term." };
  if (fromSource?.length === 1)
    return { ok: true, y: fromSource[0]!, m, d, inference: "year_from_source_date" };
  return {
    ok: false,
    reason: "No year is stated and no course term or source date anchors it.",
  };
}
function resolveToken(
  t: DateToken,
  anchors: ExtractionAnchors,
): Resolved | { ok: true; instant: string } {
  if (t.instant) return { ok: true, instant: t.instant };
  if (t.kind === "absolute") {
    let r: Resolved;
    if (t.y !== undefined)
      r = validDate(t.y, t.m!, t.d!)
        ? { ok: true, y: t.y, m: t.m!, d: t.d! }
        : { ok: false, reason: "Not a valid calendar date." };
    else if (!validDate(2024, t.m!, t.d!)) r = { ok: false, reason: "Not a valid calendar date." };
    else r = resolveYear(t.m!, t.d!, anchors);
    if (r.ok && t.weekday !== undefined && t.weekday >= 0 && weekdayOf(r.y, r.m, r.d) !== t.weekday)
      return { ok: false, reason: `The stated weekday does not match ${r.m}/${r.d}/${r.y}.` };
    return r;
  }
  if (t.kind === "vague")
    return { ok: false, reason: `“${t.word}” does not name a specific day.` };
  if (!anchors.statedAt)
    return {
      ok: false,
      reason:
        t.kind === "weekday"
          ? "A weekday without a date, and the source has no post time to anchor it."
          : `“${t.word}” is relative, and the source has no post time to anchor it.`,
    };
  const base = zonedDate(anchors.statedAt);
  let offset: number;
  if (t.kind === "relative") offset = t.word === "tomorrow" ? 1 : 0;
  else {
    if (t.qualifier === "next")
      return { ok: false, reason: "“next <weekday>” can mean this coming or the following week." };
    offset = (t.weekday! - weekdayOf(base.y, base.m, base.d) + 7) % 7;
    if (offset === 0)
      return { ok: false, reason: "The weekday is the same as the post day; it could mean today or next week." };
  }
  const day = new Date(calendarMs(base.y, base.m, base.d) + offset * DAY);
  return {
    ok: true,
    y: day.getUTCFullYear(),
    m: day.getUTCMonth() + 1,
    d: day.getUTCDate(),
    inference: "relative_to_post",
  };
}

const MAX_SPAN = 600;
export function extractDeadlineMentions(
  source: ExtractionSource,
  anchors: ExtractionAnchors = {},
): DeadlineMention[] {
  const text = source.text;
  const all = dateTokens(text);
  const out: DeadlineMention[] = [];
  for (const [sStart, sEnd] of sentences(text)) {
    const tokens = all.filter((t) => t.start >= sStart && t.end <= sEnd);
    if (!tokens.length) continue;
    const sentence = text.slice(sStart, sEnd);
    const identifiers = identifiersIn(sentence);
    const change = CHANGE.test(sentence);
    const local: DeadlineMention[] = [];
    let previousEnd = sStart;
    tokens.forEach((t, i) => {
      const nextStart = tokens[i + 1]?.start ?? sEnd;
      const lead = text.slice(previousEnd, t.start);
      const tail = text.slice(t.end, nextStart);
      const after = TIME_AFTER.exec(tail);
      const before = after ? null : TIME_BEFORE.exec(lead);
      const later = after || before ? null : TIME_IN_CLAUSE.exec(tail.slice(0, 80));
      const timeEnd = after ? t.end + after[0].length : t.end;
      previousEnd = timeEnd;
      if (NEGATED.test(lead)) return;
      const kind = classify(lead, tail, text.slice(sStart, t.start));
      if (!kind) return;
      const previous = kind.kind === "due" && PREVIOUS.test(lead);
      const spanStart = sEnd - sStart > MAX_SPAN ? Math.max(sStart, t.start - 250) : sStart;
      const spanEnd = sEnd - sStart > MAX_SPAN ? Math.min(sEnd, timeEnd + 250) : sEnd;
      const mention: DeadlineMention = {
        ...kind,
        value: null,
        change: change && kind.kind === "due" && !previous,
        previous,
        span: {
          resourceId: source.resourceId,
          version: source.version,
          contentHash: source.contentHash,
          field: source.field,
          start: spanStart,
          end: spanEnd,
          text: text.slice(spanStart, spanEnd),
        },
        match: { start: t.start, end: timeEnd, text: text.slice(t.start, timeEnd) },
        identifiers,
      };
      const resolved = resolveToken(t, anchors);
      if (!resolved.ok) {
        mention.unresolvedReason = resolved.reason;
        local.push(mention);
        return;
      }
      if ("instant" in resolved) {
        mention.value = resolved.instant;
        mention.precision = "minute";
        local.push(mention);
        return;
      }
      if (resolved.inference) mention.inference = resolved.inference;
      const time =
        t.hour !== undefined
          ? { hour: t.hour, minute: t.minute!, zone: undefined }
          : timeFrom(after ?? before ?? (later ? (TIME_AFTER.exec(later[0].replace(/^\S+/, "")) ?? null) : null));
      const classTime = CLASS_TIME.exec(`${lead.slice(-40)} ${tail.slice(0, 40)}`);
      if (time && !("ambiguous" in time)) {
        mention.value = zonedTimeToUtc(resolved.y, resolved.m, resolved.d, time.hour, time.minute, time.zone ?? DEADLINE_TIME_ZONE);
        mention.precision = "minute";
      } else {
        mention.value = zonedTimeToUtc(resolved.y, resolved.m, resolved.d, 0, 0);
        mention.precision = "day";
        mention.note =
          time && "ambiguous" in time
            ? "“Midnight” could mean the start or end of this day; planning uses the start."
            : classTime
              ? `Time is given as “${classTime[0]}”, not a clock time.`
              : "No time of day is stated.";
      }
      local.push(mention);
    });
    // Attach each replaced date to the change it belongs to (nearest following, else preceding).
    local.forEach((m, i) => {
      if (!m.previous) return;
      const target =
        local.slice(i + 1).find((x) => !x.previous && x.kind === "due") ??
        [...local.slice(0, i)].reverse().find((x) => !x.previous && x.kind === "due");
      if (target && m.value) {
        target.change = true;
        target.supersedes = m.value;
      }
    });
    out.push(...local);
  }
  return out;
}

/** True only when the span is a literal slice of this exact resource version. */
export function validateDeadlineSpan(
  resource: { id: string; version: number; contentHash: string; title: string; text: string },
  span: DeadlineSpan,
): boolean {
  if (
    span.resourceId !== resource.id ||
    span.version !== resource.version ||
    span.contentHash !== resource.contentHash
  )
    return false;
  const source = span.field === "title" ? resource.title : resource.text;
  return (
    Number.isInteger(span.start) &&
    Number.isInteger(span.end) &&
    span.start >= 0 &&
    span.end <= source.length &&
    span.start < span.end &&
    source.slice(span.start, span.end) === span.text
  );
}
