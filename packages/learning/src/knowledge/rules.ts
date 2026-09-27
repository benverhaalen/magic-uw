// N07: the Iffy rules R1–R6 (spec §5.6). Each returns a reason with the event
// IDs it rests on and a concrete clearing condition, or null. Only included
// (non-excluded) events reach these functions, so a reason never cites an
// excluded event (KM-8). Windows use the student's local calendar days; "the
// last N days" is today and the N − 1 days before it.
import type { KmParams } from "../config";
import type { Reason } from "../types";
import type { KnowledgeEvent, ReviewEvent } from "./events";

const DAY = 86_400_000;
export const dayAge = (day: string, today: string) => Math.round((Date.parse(today) - Date.parse(day)) / DAY);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const shortDate = (day: string) => {
  const [, m, d] = day.split("-").map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]}`;
};

const RECOGNITION = new Set(["mc", "tf"]);
const RECALL = new Set(["typed", "cloze", "numeric"]);
const right = (e: KnowledgeEvent) => e.y >= 1;
const miss = (e: KnowledgeEvent) => e.y < 0.5;
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export interface RuleInput {
  today: string;
  /** Effective evidence count n_c. */
  n: number;
  pHat: number;
  /** Included events on this concept, oldest first. */
  events: KnowledgeEvent[];
  /** Included events on any concept (for "previously answered correctly" on the same item). */
  allEvents: KnowledgeEvent[];
  reviews: ReviewEvent[];
  r: number | null;
  prevR1: boolean;
  coveredBy: { assessmentId: string; title: string; daysAway: number }[];
}

export function accuracyWindow(events: KnowledgeEvent[], size: number): { acc: number | null; right: number; total: number; ids: string[] } {
  const w = events.slice(-size);
  if (!w.length) return { acc: null, right: 0, total: 0, ids: [] };
  const sum = w.reduce((s, e) => s + e.y, 0);
  return { acc: sum / w.length, right: Math.round(sum), total: w.length, ids: w.map((e) => e.id) };
}

export function r1(x: RuleInput, p: KmParams): { reason: Reason | null; active: boolean } {
  const win = accuracyWindow(x.events, p.accWindow);
  if (win.acc === null || x.n < p.r1MinN) return { reason: null, active: false };
  const enter = win.acc < p.r1AccBelow && x.pHat < p.r1PHatEnter;
  const stay = x.prevR1 && !(win.acc >= p.r1AccBelow || x.pHat >= p.r1PHatExit);
  if (!enter && !stay) return { reason: null, active: false };
  const counts = `right on ${win.right} of ${win.total} answers without help.`;
  return {
    active: true,
    reason: {
      rule: "R1",
      text: win.acc < p.r1MostlyMissed ? `Mostly missed: ${counts}` : counts[0]!.toUpperCase() + counts.slice(1),
      eventIds: win.ids,
      clearsWhen: `Clears when at least 7 of your last ${Math.min(p.accWindow, 10)} answers without help are right, or your recent answers keep coming out right.`,
    },
  };
}

export function r2(x: RuleInput, p: KmParams): Reason | null {
  const answered = x.events.length;
  const thin = (x.n > 0 && x.n < p.r2MaxN) || (answered === 0 && x.reviews.length > 0);
  if (!thin) return null;
  const soon = x.coveredBy.filter((a) => a.daysAway >= 0 && a.daysAway <= p.r2HorizonDays).sort((a, b) => a.daysAway - b.daysAway)[0];
  if (!soon) return null;
  const when = soon.daysAway === 0 ? "today" : `in ${count(soon.daysAway, "day", "days")}`;
  return {
    rule: "R2",
    text: answered ? `Only ${count(answered, "answer", "answers")} so far, and it's on ${soon.title} ${when}.` : `Only card reviews so far, and it's on ${soon.title} ${when}.`,
    eventIds: [...x.events.map((e) => e.id), ...x.reviews.map((r) => r.id)],
    clearsWhen: `Clears after ${p.r2MaxN} answers, or once ${soon.title} has passed.`,
  };
}

export function r3(x: RuleInput, p: KmParams): Reason | null {
  type Lapse = { at: string; day: string; ids: string[]; text: string };
  const lapses: Lapse[] = [];
  for (const e of x.events) {
    if (!miss(e) || dayAge(e.localDay, x.today) >= p.r3WindowDays) continue;
    const before = x.allEvents.filter((o) => o.itemId === e.itemId && o.createdAt < e.createdAt && right(o)).at(-1);
    if (!before) continue;
    lapses.push({ at: e.createdAt, day: e.localDay, ids: [e.id, before.id], text: `Missed a question on ${shortDate(e.localDay)} after getting it right on ${shortDate(before.localDay)}.` });
  }
  for (const rv of x.reviews) {
    if (rv.rating !== 1 || rv.stateBefore !== 2 || dayAge(rv.localDay, x.today) >= p.r3WindowDays) continue;
    lapses.push({ at: rv.createdAt, day: rv.localDay, ids: [rv.id], text: `Forgot a card you knew (rated Again on ${shortDate(rv.localDay)}).` });
  }
  const open = lapses
    .filter((l) => !x.events.some((e) => e.createdAt > l.at && right(e)) && !x.reviews.some((r) => r.createdAt > l.at && r.rating >= 3))
    .sort((a, b) => (a.at < b.at ? -1 : 1))
    .at(-1);
  if (!open) return null;
  return { rule: "R3", text: open.text, eventIds: open.ids, clearsWhen: "Clears when you answer a question on it right without help, or rate a card on it Good or Easy." };
}

export function r4(x: RuleInput, p: KmParams): Reason | null {
  const hits = x.events.filter(
    (e) =>
      miss(e) &&
      e.confidence !== null &&
      e.confidence >= p.r4MinConfidence &&
      dayAge(e.localDay, x.today) < p.r4WindowDays &&
      !x.allEvents.some((o) => o.itemId === e.itemId && o.createdAt > e.createdAt && right(o)),
  );
  const last = hits.at(-1);
  if (!last) return null;
  const sure = last.confidence! >= 1 ? "sure" : "fairly sure";
  return {
    rule: "R4",
    text: `You were ${sure} and got it wrong (${shortDate(last.localDay)}).`,
    eventIds: hits.map((e) => e.id),
    clearsWhen: "Clears when you answer that question right without help.",
  };
}

export function r5(x: RuleInput, p: KmParams): Reason | null {
  if (x.r === null || (x.events.length === 0 && x.reviews.length === 0)) return null;
  if (x.r >= p.r5RequestRetention - p.r5Margin) return null;
  const lastReview = x.reviews.at(-1);
  const lastAttempt = x.events.at(-1);
  const last = [lastReview, lastAttempt].filter(Boolean).sort((a, b) => (a!.createdAt < b!.createdAt ? 1 : -1))[0]!;
  const days = dayAge(last.localDay, x.today);
  return {
    rule: "R5",
    text: `Fading: last reviewed ${count(days, "day", "days")} ago.`,
    eventIds: [last.id],
    clearsWhen: x.reviews.length ? "Clears after a card review on it." : "Clears after a question on it, on a new day.",
  };
}

export function r6(x: RuleInput, p: KmParams): Reason | null {
  const recent = x.events.filter((e) => dayAge(e.localDay, x.today) < p.r6WindowDays);
  const rec = recent.filter((e) => RECOGNITION.has(e.format));
  const cal = recent.filter((e) => RECALL.has(e.format));
  if (rec.length < p.r6MinPerGroup || cal.length < p.r6MinPerGroup) return null;
  const sum = (es: KnowledgeEvent[]) => es.reduce((s, e) => s + e.y, 0);
  const gap = sum(rec) / rec.length - sum(cal) / cal.length;
  if (gap < p.r6Gap) return null;
  return {
    rule: "R6",
    text: `Right on multiple choice (${Math.round(sum(rec))} of ${rec.length}) but on typed answers only ${Math.round(sum(cal))} of ${cal.length}.`,
    eventIds: [...rec, ...cal].map((e) => e.id),
    clearsWhen: "Clears when your typed answers catch up, or as these answers age past 30 days.",
  };
}
