// Synthetic cases for the Art of the Break card (docs/break-card.md). Ordinary course content only:
// exam dates, grade weights, office hours, course mail and course links. No real data, no model.
// A seeded generator keeps every run identical, so the before/after counts are reproducible.

export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const other = <T>(r: () => number, xs: readonly T[], not: T): T => {
  for (;;) {
    const x = pick(r, xs);
    if (x !== not) return x;
  }
};

/** Wilson 95% interval for k successes in n trials. */
export function wilson(k: number, n: number): [number, number] {
  const z = 1.959964, p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d, h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
export const pct = (k: number, n: number) => {
  const [lo, hi] = wilson(k, n);
  return `${k}/${n} = ${((100 * k) / n).toFixed(1)}% [${(100 * lo).toFixed(1)}, ${(100 * hi).toFixed(1)}]`;
};

// ---------------------------------------------------------------- B1: grounded ask sentences
const MONTHS = ["September", "October", "November", "December"] as const;
const SHORT: Record<string, string> = { September: "Sept", October: "Oct", November: "Nov", December: "Dec" };
const EVENTS = ["midterm exam", "final exam", "Quiz 2", "project proposal", "lab report", "second exam"] as const;
const PEOPLE = ["Priya Raman", "Daniel Ortiz", "Mei Tanaka", "Samuel Okafor", "Laura Becker", "Tomas Lindqvist", "Aisha Karimi", "Owen Fitzgerald"] as const;
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"] as const;
const ITEMS = ["Problem Set 3", "Homework 4", "the group project", "Lab 5", "the reading quiz"] as const;
const BUILDINGS = ["Humanities", "Van Vleck", "Bascom", "Engineering Hall", "Grainger"] as const;

export interface AskCase {
  kind: "date" | "number" | "name" | "weekday" | "room";
  passage: string;
  quote: string;
  /** A sentence that restates the quote correctly, in different words. */
  right: string;
  /** A sentence that cites the same real quote but states a different date, number or name. */
  wrong: string;
}
export function askCases(n: number, seed = 1): AskCase[] {
  const r = rng(seed);
  const kinds: AskCase["kind"][] = ["date", "number", "name", "weekday", "room"];
  return Array.from({ length: n }, (_, i): AskCase => {
    const kind = kinds[i % kinds.length]!;
    const event = pick(r, EVENTS), m = pick(r, MONTHS), d = 1 + Math.floor(r() * 28);
    const room = 1000 + Math.floor(r() * 9000), building = pick(r, BUILDINGS);
    const tail = " Bring a pencil and your student ID.";
    switch (kind) {
      case "date": {
        const quote = `The ${event} is on ${m} ${d} in ${room} ${building}.`;
        const d2 = d + 1 + Math.floor(r() * 7);
        const right = pick(r, [`Your ${event} is on ${SHORT[m]} ${d}.`, `The ${event} takes place ${m} ${d}.`, `It is scheduled for ${d} ${m}.`]);
        return { kind, passage: quote + tail, quote, right, wrong: `Your ${event} is on ${SHORT[m]} ${d2}.` };
      }
      case "number": {
        const item = pick(r, ITEMS), w = pick(r, [5, 10, 15, 20, 25, 30]);
        const quote = `${item[0]!.toUpperCase()}${item.slice(1)} is worth ${w}% of the final grade.`;
        const w2 = other(r, [5, 10, 15, 20, 25, 30, 35], w);
        const right = pick(r, [`It counts for ${w} percent of your grade.`, `${item[0]!.toUpperCase()}${item.slice(1)} makes up ${w}% of the final grade.`]);
        return { kind, passage: `Grading. ${quote} Late work loses 10% per day.`, quote, right, wrong: `It counts for ${w2}% of your final grade.` };
      }
      case "name": {
        const who = pick(r, PEOPLE), who2 = other(r, PEOPLE, who), day = pick(r, DAYS);
        const quote = `Office hours are held by ${who} on ${day}s in ${room} ${building}.`;
        const right = pick(r, [`${who} holds office hours on ${day}s.`, `Office hours are with ${who}, in ${room} ${building}.`]);
        return { kind, passage: `Staff. ${quote} Email ahead if you can't make it.`, quote, right, wrong: `Office hours are with ${who2} on ${day}s.` };
      }
      case "weekday": {
        const day = pick(r, DAYS), day2 = other(r, DAYS, day), hour = 1 + Math.floor(r() * 5);
        const quote = `Discussion sections meet every ${day} at ${hour}:30 pm.`;
        const right = pick(r, [`Sections meet on ${day}s at ${hour}:30 pm.`, `Your discussion section is every ${day} at ${hour}:30.`]);
        return { kind, passage: `Sections. ${quote} Attendance is recorded.`, quote, right, wrong: `Sections meet on ${day2}s at ${hour}:30 pm.` };
      }
      case "room": {
        const room2 = room + 1 + Math.floor(r() * 50);
        const quote = `The ${event} will be held in ${room} ${building}.`;
        const right = pick(r, [`The ${event} is in room ${room} of ${building}.`, `You take the ${event} in ${room} ${building}.`]);
        return { kind, passage: `${quote} Arrive ten minutes early.`, quote, right, wrong: `The ${event} is in room ${room2} of ${building}.` };
      }
    }
  });
}

// ---------------------------------------------------------------- B2/B3: course mail senders
export const STAFF = ["hopper@cs.wisc.edu", "ta.lindqvist@wisc.edu", "okafor2@wisc.edu"] as const;
const OUTSIDE = ["deals@textbook-outlet.example.com", "hello@studyhub.example.net", "events@startup-fair.example.org", "noreply@notes-exchange.example.com", "team@tutor-match.example.io"] as const;
const SUBJECTS = [
  "CS 564 midterm moved to Thursday",
  "COMP SCI 564: exam room changed",
  "[CS564] deadline extended to Friday",
  "CS 564 quiz postponed",
  "COMPSCI 564 lecture canceled tomorrow",
] as const;
export interface MailCase {
  staff: boolean;
  fromAddress: string;
  fromName: string;
  subject: string;
  preview: string;
}
export function mailCases(n: number, seed = 2): MailCase[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i): MailCase => {
    const staff = i % 2 === 0;
    const subject = pick(r, SUBJECTS);
    return {
      staff,
      fromAddress: staff ? pick(r, STAFF) : pick(r, OUTSIDE),
      fromName: staff ? "Course staff" : pick(r, ["Textbook Outlet", "StudyHub", "Startup Fair", "Notes Exchange", "Tutor Match"]),
      subject,
      preview: staff ? "Hi all, see the course page for the details. Thanks." : "Get ready with our study packs and practice sets, 20% off this week.",
    };
  });
}

// ---------------------------------------------------------------- B4: course links by surface
export interface LinkCase {
  /** Where the only link to the host sits. */
  surface: "discussion" | "module" | "syllabus";
  url: string;
}
export function linkCases(n: number, seed = 3): LinkCase[] {
  const r = rng(seed);
  const hosts = ["notes", "study", "flashcards", "review", "prep", "guide", "wiki", "share"];
  return Array.from({ length: n }, (_, i): LinkCase => {
    const surface = i % 2 === 0 ? "discussion" : pick(r, ["module", "syllabus"] as const);
    const tag = `${pick(r, hosts)}${Math.floor(r() * 1000)}`;
    const url = pick(r, [`https://cs564-${tag}.github.io/`, `https://${tag}.example.com/cs564/`, `https://cs564.${tag}.example.org/`]);
    return { surface, url };
  });
}
