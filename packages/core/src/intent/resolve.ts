/**
 * The code path (0 tokens): exact examples and patterns, course and date references, topics by
 * the course's concept labels. It runs under a hard budget inside try/catch and never throws to
 * the student: an exception, an overrun or an unmatched request becomes `miss` or `partial`,
 * and partial slots (a resolved course, a date) go to the classify call as hints.
 */
import type { IntentCandidate, IntentSlots } from "@magic/contracts";
import { DATE_PATTERN, parseTime } from "./dates";
import { findCourseMentions, narrow, norm, type IntentIndex } from "./courses";
import type { ActionRegistry, AnyAction } from "./registry";
import type { Resolve, ResolvedArgs, ResolvedCourse } from "./types";

export type CodeOutcome =
  | { status: "hit"; action: string; slots: IntentSlots; args: ResolvedArgs }
  | { status: "clarify"; action: string; question: string; candidates: IntentCandidate[]; slots: IntentSlots }
  | { status: "partial" | "miss"; slots: IntentSlots; reason?: "no_match" | "budget" | "error" };

export type SlotCheck =
  | { ok: true; args: ResolvedArgs }
  /** `choose`: the student must pick (code asks, 0 tokens). `unresolved`: a reference didn't resolve. */
  | { ok: false; kind: "choose" | "unresolved"; question: string; candidates: IntentCandidate[] };

const POLITE = /^(?:(?:hey|hi|ok|okay|so|please|pls|can you|can u|could you|could u|would you|will you|i want to|i'd like to|id like to|i wanna|i need to|let me|lets|let's|help me to)\s+)+/;
const CONNECTOR = /^(?:(?:in|for|from|on|of|my|the|about|at|to|with|and)\s+)+|(?:\s+(?:in|for|from|on|of|my|the|about|at|to|with|and|class|course|please|pls))+$/g;
const ALL_COURSES = /\b(?:across |in |for |from )?(?:all|every|any)(?: of)? (?:my )?(?:courses|classes)\b/;

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, "twenty five": 25, thirty: 30,
};
const N = `(\\d{1,3}|${Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length).join("|")})`;
const THINGS = "(?:questions?|items?|problems?|flash ?cards?|cards?)";
/**
 * Where a count sits decides what goes with it, so each action's own pattern still reads the rest:
 * - "a 10 question quiz": the count and its noun go, the quiz stays;
 * - "make 12 cards on …", "12 flashcards due": only the number goes (the noun is the action's word);
 * - "with 5 questions", "using 12 cards", or a count after the topic ("… hash tables, 5 questions"): the whole phrase goes.
 */
const COUNT_RULES: { re: RegExp; whole: boolean }[] = [
  { re: new RegExp(`\\b${N}[ -](?:question|item|problem)s? (?=quiz|test)`), whole: true },
  { re: new RegExp(`(?:^|\\b(?:make|generate|create|build|write|give me|review|study|do)(?: me)?(?: (?:some|a|an|new|more|my|the))? )${N} (?=${THINGS}\\b)`), whole: false },
  { re: new RegExp(`\\b(?:with|using) ${N} ${THINGS}\\b|(?:,| ) ?\\b${N} ${THINGS}$`), whole: true },
  { re: new RegExp(`\\b${N} (?=${THINGS}\\b)`), whole: false },
];
/** How many the student asked for, clamped to what a pack makes (1–30). */
export const clampCount = (n: number) => Math.min(30, Math.max(1, Math.round(n)));

/** The count the request states, and the request without it. Code reads it; the model never does. */
export function extractCount(text: string): { rest: string; count: number | null } {
  for (const { re, whole } of COUNT_RULES) {
    const m = re.exec(text);
    if (!m) continue;
    const said = m.slice(1).find((g) => g !== undefined)!;
    const n = /^\d/.test(said) ? Number(said) : NUMBER_WORDS[said]!;
    // Keep what the match holds before the number (a verb) when only the number goes.
    const at = whole ? m.index : m.index + m[0].lastIndexOf(said);
    const end = whole ? m.index + m[0].length : at + said.length;
    return { rest: `${text.slice(0, at)} ${text.slice(end)}`.replace(/\s+/g, " ").trim(), count: clampCount(n) };
  }
  return { rest: text, count: null };
}

export function normaliseUtterance(text: string): string {
  return norm(text.replace(/[?!.]+\s*$/, "")).replace(POLITE, "").trim();
}
const clean = (s: string) => s.replace(/\s+/g, " ").trim().replace(CONNECTOR, "").trim();

export function courseDisplay(c: ResolvedCourse): string {
  return c.code ?? c.name;
}
function describe(spec: AnyAction, slots: IntentSlots): string {
  const bits = [slots.kind === "cards" ? "flashcards" : slots.kind === "quiz" ? "quiz" : null, slots.topics?.join(", "), slots.assignment, slots.query, slots.date, slots.course].filter(Boolean);
  return `${spec.description.replace(/\.$/, "")}${bits.length ? ` · ${bits.join(" · ")}` : ""}`;
}
export function candidate(spec: AnyAction, slots: IntentSlots, args?: ResolvedArgs): IntentCandidate {
  let label = describe(spec, slots);
  if (args && spec.label) {
    try {
      label = spec.label(args);
    } catch {}
  }
  return { action: spec.name, args: slots, label };
}

/**
 * Surface slots → resolved args, by code. Shared by both paths: whatever the model said is
 * re-resolved here, so an invented course, assignment or date is refused, never run.
 */
export function resolveSlots(spec: AnyAction, slots: IntentSlots, resolve: Resolve, text: string, contextCourseId?: string): SlotCheck {
  const args: ResolvedArgs = { text };
  const fail = (question: string, candidates: IntentCandidate[] = [], kind: "choose" | "unresolved" = candidates.length ? "choose" : "unresolved"): SlotCheck => ({ ok: false, kind, question, candidates });
  const needs = spec.slots;
  if (slots.scope === "all" && needs.scope) args.scope = "all";
  if (slots.course?.trim()) {
    const r = resolve.course(slots.course);
    if (r.status === "ok") args.course = r.value;
    else if (r.status === "ambiguous")
      return fail(
        `Which course did you mean by "${slots.course}"?`,
        r.options.slice(0, 6).map((c) => candidate(spec, { ...slots, course: courseDisplay(c) })),
      );
    else
      return fail(
        `I couldn't find a course called "${slots.course}". Which one did you mean?`,
        resolve.courses().slice(0, 8).map((c) => candidate(spec, { ...slots, course: courseDisplay(c) })),
        "unresolved",
      );
  } else if (contextCourseId && needs.course && args.scope !== "all") {
    const c = resolve.courseById(contextCourseId);
    if (c) args.course = c;
  }
  // No course named or open: the one current course whose topics match what was named.
  if (!args.course && needs.course === "required" && slots.topics?.length) {
    const owners = resolve.courses().filter((c) => resolve.topics(c, slots.topics!).ids.length);
    if (owners.length === 1) args.course = owners[0];
  }
  if (needs.course === "required" && !args.course)
    return fail(
      "Which course?",
      resolve.courses().slice(0, 8).map((c) => candidate(spec, { ...slots, course: courseDisplay(c) })),
    );
  if (slots.date?.trim() && needs.date) {
    const d = resolve.date(slots.date);
    if (!d) return fail(`I couldn't read the date "${slots.date}". Which day do you mean?`);
    args.date = d;
  } else if (needs.date === "required") return fail("For which day?", [], "choose");
  if (needs.time) {
    const t = parseTime(slots.time?.trim() || text);
    if (t) args.time = t;
    else if (needs.time === "required") return fail("What time?", [], "choose");
  }
  if (slots.assignment?.trim() && needs.assignment) {
    const r = resolve.assignment(slots.assignment, args.course);
    if (r.status === "ok") args.assignment = r.value;
    else if (r.status === "ambiguous")
      return fail(
        `Which one did you mean by "${slots.assignment}"?`,
        r.options.map((o) => candidate(spec, { ...slots, assignment: o.title }, { ...args, assignment: o })),
      );
    else return fail(`I couldn't find "${slots.assignment}"${args.course ? ` in ${courseDisplay(args.course)}` : ""}.`);
  } else if (needs.assignment === "required") return fail("Which assignment?");
  if (slots.topics?.length && needs.topics && args.course) {
    const t = resolve.topics(args.course, slots.topics);
    if (t.ids.length) args.topicIds = t.ids;
    if (t.unmatched.length) args.topicText = t.unmatched.join(", ").slice(0, 500);
  }
  if (slots.query?.trim() && needs.query) args.query = slots.query.trim().slice(0, 500);
  else if (needs.query === "required") return fail("What should I search for?");
  if (slots.kind && needs.kind) args.kind = slots.kind;
  else if (needs.kind === "required") return fail("Flashcards or a quiz?", (["cards", "quiz"] as const).map((k) => candidate(spec, { ...slots, kind: k })));
  if (slots.count && needs.count) args.count = clampCount(slots.count);
  const parsed = spec.argsSchema.safeParse(args);
  if (!parsed.success) return fail("I need a bit more detail to do that.");
  return { ok: true, args: parsed.data };
}

export interface ResolverDeps {
  registry: ActionRegistry;
  resolve: Resolve;
  index: () => IntentIndex;
  /** Hard budget for the whole code path (≤20 ms of CPU time). */
  budgetMs?: number;
  clock?: () => number;
}

/** Everything the code path can say about the text, whether or not an action matched. */
export function extractSlots(index: IntentIndex, n: string, deadline: () => void): { rest: string; slots: IntentSlots; courses: ResolvedCourse[] } {
  let rest = n;
  const slots: IntentSlots = {};
  if (ALL_COURSES.test(rest)) {
    slots.scope = "all";
    rest = rest.replace(ALL_COURSES, " ");
  }
  const date = DATE_PATTERN.exec(rest);
  if (date) {
    slots.date = date[0].replace(/^(?:for|on|by|due) /, "").trim();
    // "due tomorrow": keep "due" in the text for the agenda pattern.
    rest = `${rest.slice(0, date.index)} ${/^due /.test(date[0]) ? "due " : ""}${rest.slice(date.index + date[0].length)}`;
  }
  deadline();
  let courses: ResolvedCourse[] = [];
  const mentions = findCourseMentions(index, rest);
  deadline();
  if (mentions.length) {
    const m = mentions[0]!;
    courses = narrow(mentions.flatMap((x) => x.courses));
    const said = rest.slice(m.start, m.end);
    slots.course = courses.length === 1 ? (courses[0]!.code ?? courses[0]!.name) : said.replace(/^(?:my|the|in|for|from|of) /, "").replace(/ (?:class|course)$/, "");
    for (const x of [...mentions].reverse()) rest = `${rest.slice(0, x.start)} ${rest.slice(x.end)}`;
  }
  return { rest: clean(rest), slots, courses };
}

export function resolveCode(text: string, contextCourseId: string | undefined, deps: ResolverDeps): CodeOutcome {
  // The budget bounds the resolver's own work, so it counts this thread's CPU time: a machine
  // under load that preempts the (synchronous) resolver doesn't turn a code hit into a model call,
  // and neither does work on other threads (GC helpers, the thread pool) running meanwhile.
  const clock = deps.clock ?? cpuMs;
  const budget = deps.budgetMs ?? 20;
  let slots: IntentSlots = {};
  let started = clock();
  const deadline = () => {
    if (clock() - started > budget) throw new BudgetError();
  };
  try {
    const n = normaliseUtterance(text);
    if (!n) return { status: "miss", slots, reason: "no_match" };
    // The index is cached state (prewarm builds it when the bar opens); a rebuild after a sync is
    // data preparation, not resolution, so the budget starts once it's ready.
    const index = deps.index();
    started = clock();
    const extracted = extractSlots(index, n, deadline);
    slots = extracted.slots;
    const { rest } = extracted;
    const question = /\?\s*$/.test(text.trim());
    // A stated count ("with 5 questions", "12 cards") is read only for the actions that take one, so
    // another action's words ("open homework 3 problems") are never cut.
    const counted = extractCount(rest);
    for (const spec of deps.registry.list()) {
      deadline();
      let groups: Record<string, string | undefined> | null = null;
      let count: number | null = null;
      const tries = spec.slots.count && counted.count !== null && spec.matchOn !== "raw" ? [counted.rest, rest] : [spec.matchOn === "raw" ? text.trim() : rest];
      for (const [i, on] of tries.entries()) {
        for (const p of spec.patterns ?? []) {
          const m = p.exec(on);
          if (m) {
            groups = { ...(m.groups ?? {}) };
            if (tries.length === 2 && i === 0) count = counted.count;
            break;
          }
        }
        if (groups) break;
      }
      // An exact example claims the request even when no pattern does.
      if (!groups && spec.examples.some((e) => normaliseUtterance(e) === n)) groups = {};
      // A question mark routes to ask only when no other action claimed it.
      if (!groups && spec.name === "ask" && question) groups = {};
      if (!groups) continue;
      const s: IntentSlots = { ...slots };
      if (groups.topics) s.topics = groups.topics.split(/\s*(?:,|\band\b|&|\bplus\b)\s*/).map(clean).filter(Boolean).slice(0, 10);
      if (groups.assignment) s.assignment = clean(groups.assignment);
      if (groups.query) s.query = clean(groups.query);
      if (count !== null) s.count = count;
      if (groups.count) s.count = clampCount(Number(groups.count));
      if (groups.kind) s.kind = /quiz|question/.test(groups.kind) ? "quiz" : "cards";
      if (spec.name === "ask") s.query = text.trim().slice(0, 500);
      const checked = resolveSlots(spec, s, deps.resolve, text.trim(), contextCourseId);
      // A resolved match is kept even past the budget: it is already paid for, and a model call costs more.
      if (checked.ok) return { status: "hit", action: spec.name, slots: s, args: checked.args };
      deadline();
      // The action is clear and the student must choose: code asks, at 0 tokens. A reference that
      // didn't resolve goes on to the model with what code did settle.
      if (checked.kind === "choose") return { status: "clarify", action: spec.name, question: checked.question, candidates: checked.candidates, slots: s };
      return { status: slots.course || slots.date ? "partial" : "miss", slots, reason: "no_match" };
    }
    return { status: slots.course || slots.date ? "partial" : "miss", slots, reason: "no_match" };
  } catch (error) {
    return { status: slots.course || slots.date ? "partial" : "miss", slots, reason: error instanceof BudgetError ? "budget" : "error" };
  }
}

// Thread CPU time (Node >= 23.9); the process's CPU time counted GC helper threads too, which on
// a loaded CI runner tripped the budget on a code hit. Falls back where the call is missing.
const threadCpu = (process as { threadCpuUsage?: () => NodeJS.CpuUsage }).threadCpuUsage?.bind(process);
const cpuMs = () => {
  const u = threadCpu ? threadCpu() : process.cpuUsage();
  return (u.user + u.system) / 1000;
};
class BudgetError extends Error {
  constructor() {
    super("resolver budget");
  }
}
