/**
 * Code's reference resolution for the command bar: courses (a code like "CS 400" or
 * "COMP SCI 400", a name or distinctive name word, a subject nickname like "my econ class"),
 * assignments by title words, and topics by the course's concept labels. Built once into an
 * index keyed by the sources' sync state, so a command resolves in well under a millisecond.
 */
import { OUTLOOK_CALENDAR_COURSE_ID } from "@magic/contracts";
import { normaliseLabel } from "../../../learning/src/concepts";
import { courseInclusion } from "../access";
import { resolveDate } from "./dates";
import type { IntentStore, Resolve, ResolvedCourse, SlotResolution } from "./types";

export interface CourseEntry extends ResolvedCourse {
  subject: string | null;
  number: string | null;
  /** year × 10 + season (spring 1, summer 2, fall 3); 0 when the name has no term. */
  termRank: number;
  included: boolean;
  current: boolean;
  nameNorm: string;
  nameTokens: string[];
  url: string | null;
}
export interface AssignmentEntry {
  resourceId: string;
  title: string;
  tokens: string[];
  courseRef: string;
}
export interface IntentIndex {
  signature: string;
  courses: CourseEntry[];
  assignments: AssignmentEntry[];
  /** Alias (lower case) → canonical subjects, longest alias first. */
  aliases: [string, string[]][];
}

/** Common student names for subject codes; the course's own subject code is always an alias. */
const SUBJECT_NICKNAMES: Record<string, string[]> = {
  COMPSCI: ["cs", "comp sci", "compsci", "comp-sci", "computer science"],
  MATH: ["math", "maths", "calc", "calculus"],
  ECE: ["ece", "electrical engineering"],
  PHILOS: ["phil", "philo", "philos", "philosophy"],
  ENGL: ["engl", "english", "lit", "literature"],
  ECON: ["econ", "economics"],
  PHYSICS: ["physics", "phys"],
  CHEM: ["chem", "chemistry"],
  STAT: ["stat", "stats", "statistics"],
  MUSIC: ["music"],
  BIOLOGY: ["bio", "biology"],
  PSYCH: ["psych", "psychology"],
  HISTORY: ["history", "hist"],
  SOC: ["soc", "sociology"],
  "POLI SCI": ["poli sci", "polisci", "political science"],
  LSC: ["lsc", "life sciences communication"],
};
const NAME_STOP = new Set(
  "a an and the of to in for on with at by from intro introduction general i ii iii iv v course class section sections all fa sp su".split(" "),
);
const SEASON: Record<string, number> = { SP: 1, SU: 2, FA: 3, WI: 0 };
const NAME_RE = /^([A-Z][A-Z &]*?)\s?(\d{3}[A-Z]?)\s*:\s*(.+?)\s*(?:\(([^)]*)\))?\s*(?:\b(FA|SP|SU|WI)(\d{2}))?\s*$/;
const TERM_RE = /\b(FA|SP|SU|WI)(\d{2})\b|\b(Fall|Spring|Summer) (20\d{2})\b/;

export const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9'&#\s-]/g, " ").replace(/\s+/g, " ").trim();
const tokens = (s: string) => norm(s).split(/[\s-]+/).filter(Boolean);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const word = (s: string) => `(?<![a-z0-9])${escape(s).replace(/ /g, "\\s*")}(?![a-z0-9])`;

export function parseCourseName(label: string): { subject: string | null; number: string | null; name: string; termRank: number } {
  const clean = label.replace(/\s·\s.*$/, "").trim();
  const m = NAME_RE.exec(clean);
  const term = TERM_RE.exec(clean);
  const termRank = term
    ? term[1]
      ? (2000 + Number(term[2])) * 10 + SEASON[term[1]]!
      : Number(term[4]) * 10 + ({ Spring: 1, Summer: 2, Fall: 3 } as Record<string, number>)[term[3]!]!
    : 0;
  if (!m) return { subject: null, number: null, name: clean, termRank };
  return { subject: m[1]!.trim(), number: m[2]!, name: m[3]!.replace(/\s+/g, " ").trim(), termRank };
}

export function indexSignature(store: IntentStore): string {
  return store
    .sources()
    .map((s) => `${s.id}:${s.lastSuccessAt ?? ""}:${s.resourceCount}`)
    .sort()
    .join("|");
}

export function buildIndex(store: IntentStore): IntentIndex {
  const signature = indexSignature(store);
  const sources = new Map(store.sources().map((s) => [s.id, s]));
  const included = courseInclusion(store);
  const groups = new Map<string, { accountScope: string; courseId: string; label: string; courseLabel: string | null; url: string | null; included: boolean }>();
  const assignments: AssignmentEntry[] = [];
  for (const r of store.resources()) {
    if (r.deleted) continue;
    const src = sources.get(r.sourceId);
    if (!src || r.courseId === OUTLOOK_CALENDAR_COURSE_ID || r.courseId === "account" || r.courseId === "connection") continue;
    const ref = `${src.accountScope}:${r.courseId}`;
    let g = groups.get(ref);
    if (!g) {
      g = { accountScope: src.accountScope, courseId: r.courseId, label: r.courseName, courseLabel: null, url: null, included: false };
      groups.set(ref, g);
    }
    if (r.kind === "course") {
      g.courseLabel = r.courseName || r.title;
      g.url = r.url;
    }
    if (!g.included && included(r)) g.included = true;
    if (r.kind === "assignment") assignments.push({ resourceId: r.id, title: r.title, tokens: titleTokens(r.title), courseRef: ref });
  }
  const courses: CourseEntry[] = [...groups.entries()].map(([ref, g]) => {
    const label = g.courseLabel ?? g.label;
    const p = parseCourseName(label);
    const name = p.name;
    return {
      ref,
      accountScope: g.accountScope,
      courseId: g.courseId,
      code: p.subject && p.number ? `${p.subject} ${p.number}` : null,
      name,
      subject: p.subject,
      number: p.number,
      termRank: p.termRank,
      included: g.included,
      current: false,
      nameNorm: norm(name),
      nameTokens: tokens(name).filter((t) => !NAME_STOP.has(t) && t.length >= 4),
      url: g.url,
    };
  });
  const pool = courses.some((c) => c.included) ? courses.filter((c) => c.included) : courses;
  const latest = Math.max(0, ...pool.map((c) => c.termRank));
  for (const c of courses) c.current = c.included && (latest === 0 || c.termRank === latest || c.termRank === 0);
  const aliasMap = new Map<string, Set<string>>();
  for (const c of courses) {
    if (!c.subject) continue;
    const names = [c.subject.toLowerCase(), c.subject.toLowerCase().replace(/ /g, ""), ...(SUBJECT_NICKNAMES[c.subject] ?? [])];
    for (const a of names) (aliasMap.get(a) ?? aliasMap.set(a, new Set()).get(a)!).add(c.subject);
  }
  const aliases = [...aliasMap.entries()].map(([a, s]) => [a, [...s]] as [string, string[]]).sort((x, y) => y[0].length - x[0].length);
  return { signature, courses, assignments, aliases };
}

const TITLE_SYNONYMS: [RegExp, string][] = [
  [/\bhw\s*(?=\d)/g, "homework "],
  [/\bhw\b/g, "homework"],
  [/\bp-?sets?\b|\bps(?=\s*\d)/g, "problem set"],
  [/\bproj\b/g, "project"],
  [/\bprogramming assignment\b|\bpa(?=\s*\d)/g, "p"],
  [/\bexam\b/g, "exam"],
  [/#/g, " "],
];
export function titleTokens(title: string): string[] {
  let t = norm(title);
  for (const [re, to] of TITLE_SYNONYMS) t = t.replace(re, to);
  return t
    .replace(/(\d)([a-z])/g, "$1 $2")
    .replace(/([a-z])(\d)/g, "$1 $2")
    .split(/[\s-]+/)
    .filter((x) => x && !NAME_STOP.has(x) && x !== "my");
}

export interface CourseMention {
  start: number;
  end: number;
  courses: CourseEntry[];
}
/** Every course mention in the normalised text: a code, a full name, or a nickname before "class". */
export function findCourseMentions(index: IntentIndex, text: string): CourseMention[] {
  const out: CourseMention[] = [];
  // A code that names no course ("CS 999") still claims its words, so "cs" alone can't match.
  const claimed: { start: number; end: number }[] = [];
  const add = (start: number, end: number, courses: CourseEntry[]) => {
    if (claimed.some((m) => start < m.end && end > m.start)) return;
    claimed.push({ start, end });
    if (courses.length) out.push({ start, end, courses });
  };
  // 1. Subject alias plus number: "cs 400", "comp sci 400", "compsci400", "math234".
  for (const [alias, subjects] of index.aliases) {
    const re = new RegExp(`(?<![a-z0-9])${escape(alias).replace(/ /g, "\\s*")}\\s*-?\\s*(\\d{3})(?![0-9])`, "g");
    for (const m of text.matchAll(re)) {
      const hit = index.courses.filter((c) => c.subject && subjects.includes(c.subject) && c.number?.replace(/[A-Z]$/, "") === m[1]);
      add(m.index!, m.index! + m[0].length, hit);
    }
  }
  // 2. A full course name.
  for (const c of [...index.courses].sort((a, b) => b.nameNorm.length - a.nameNorm.length)) {
    if (c.nameNorm.length < 6) continue;
    const at = text.indexOf(c.nameNorm);
    if (at >= 0) add(at, at + c.nameNorm.length, index.courses.filter((x) => x.nameNorm === c.nameNorm));
  }
  // 3. "my econ class", "philosophy", "the discrete course": a subject nickname anywhere, or a
  // distinctive name word next to a course cue (so "dynamic programming" stays a topic).
  for (const [alias, subjects] of index.aliases) {
    const cue = alias.length <= 3 && !["cs", "ece", "lit", "bio", "soc", "lsc"].includes(alias);
    const re = cue
      ? new RegExp(`(?:\\b(?:my|the|in|for|from) )${word(alias)}(?: (?:class|course|homework|hw))?|${word(alias)} (?:class|course)`, "g")
      : new RegExp(`(?:\\bmy )?${word(alias)}(?: (?:class|course))?`, "g");
    for (const m of text.matchAll(re)) add(m.index!, m.index! + m[0].length, index.courses.filter((c) => c.subject && subjects.includes(c.subject)));
  }
  const current = index.courses.filter((c) => c.current);
  const counts = new Map<string, number>();
  for (const c of current) for (const t of new Set(c.nameTokens)) counts.set(t, (counts.get(t) ?? 0) + 1);
  for (const c of current)
    for (const t of c.nameTokens) {
      if (counts.get(t) !== 1) continue;
      const re = new RegExp(`(?:\\b(?:my|the|in|for|from|of) )${word(t)}(?: (?:class|course))?|${word(t)} (?:class|course)`, "g");
      for (const m of text.matchAll(re)) add(m.index!, m.index! + m[0].length, [c]);
    }
  return out.sort((a, b) => a.start - b.start);
}

/** Prefer current-term, included courses when a reference names several. */
export function narrow(courses: CourseEntry[]): CourseEntry[] {
  const uniq = [...new Map(courses.map((c) => [c.ref, c])).values()];
  const current = uniq.filter((c) => c.current);
  if (current.length) return current;
  const included = uniq.filter((c) => c.included);
  if (included.length) return included;
  const latest = Math.max(...uniq.map((c) => c.termRank));
  return uniq.filter((c) => c.termRank === latest);
}

const publicCourse = (c: CourseEntry): ResolvedCourse => ({ ref: c.ref, accountScope: c.accountScope, courseId: c.courseId, code: c.code, name: c.name });

export function createResolve(store: IntentStore, index: () => IntentIndex, now: () => Date, timeZone: string): Resolve {
  const byId = (courseId: string) => index().courses.filter((c) => c.courseId === courseId || c.ref === courseId);
  return {
    courses: () => index().courses.filter((c) => c.current).map(publicCourse),
    anchors: (course) =>
      index()
        .assignments.filter((a) => a.courseRef === course.ref)
        .map((a) => a.resourceId)
        .sort()
        .slice(0, 8),
    courseById(courseId) {
      const hits = narrow(byId(courseId));
      return hits.length === 1 ? publicCourse(hits[0]!) : null;
    },
    course(text): SlotResolution<ResolvedCourse> {
      const t = norm(text);
      if (!t) return { status: "none" };
      const exact = byId(text.trim());
      if (exact.length) {
        const n = narrow(exact);
        return n.length === 1 ? { status: "ok", value: publicCourse(n[0]!) } : { status: "ambiguous", options: n.map(publicCourse) };
      }
      const mentions = findCourseMentions(index(), t);
      const all = narrow(mentions.flatMap((m) => m.courses));
      if (!all.length) return { status: "none" };
      if (all.length === 1) return { status: "ok", value: publicCourse(all[0]!) };
      return { status: "ambiguous", options: all.map(publicCourse) };
    },
    date: (text) => resolveDate(text, now(), timeZone),
    topics(course, labels) {
      const concepts = store.learning.concepts(course.ref).filter((c) => c.status === "active" && (c.kind === "concept" || c.kind === "unit"));
      const named = concepts.map((c) => ({ id: c.id, kind: c.kind, n: normaliseLabel(c.studentLabel ?? c.label), raw: normaliseLabel(c.label) }));
      const ids: string[] = [];
      const unmatched: string[] = [];
      for (const label of labels) {
        const n = normaliseLabel(label);
        if (!n) continue;
        const exact = named.filter((c) => c.n === n || c.raw === n);
        const loose = exact.length
          ? exact
          : named.filter((c) => (n.length >= 4 && c.n.includes(n)) || (c.n.length >= 4 && n.includes(c.n)));
        // Prefer topics over units, then the closest length.
        const best = [...loose].sort((a, b) => (a.kind === "concept" ? 0 : 1) - (b.kind === "concept" ? 0 : 1) || Math.abs(a.n.length - n.length) - Math.abs(b.n.length - n.length))[0];
        if (best && best.kind === "concept") {
          if (!ids.includes(best.id)) ids.push(best.id);
        } else if (best) {
          // A unit named: all its topics.
          for (const c of concepts) if (c.parentId === best.id && c.kind === "concept" && !ids.includes(c.id)) ids.push(c.id);
          if (!concepts.some((c) => c.parentId === best.id)) unmatched.push(label);
        } else unmatched.push(label);
      }
      return { ids: ids.slice(0, 50), unmatched };
    },
    assignment(text, course) {
      const q = titleTokens(text).filter((t) => !["open", "the", "assignment"].includes(t));
      if (!q.length) return { status: "none" };
      const idx = index();
      const inScope = idx.assignments.filter((a) => (course ? a.courseRef === course.ref : idx.courses.some((c) => c.current && c.ref === a.courseRef)));
      const hits = inScope.filter((a) => q.every((t) => a.tokens.includes(t)));
      if (!hits.length) return { status: "none" };
      const exact = hits.filter((a) => a.tokens.length === q.length);
      const pick = exact.length === 1 ? exact : hits;
      const value = (a: AssignmentEntry) => ({ resourceId: a.resourceId, title: a.title });
      return pick.length === 1 ? { status: "ok", value: value(pick[0]!) } : { status: "ambiguous", options: pick.slice(0, 5).map(value) };
    },
  };
}
