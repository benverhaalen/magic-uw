/**
 * The built-in command-bar actions. Each wraps an existing path (core's D40 workspace verbs, the
 * learning router's practice ops, the pack handler, passage search, the grounded ask); none adds
 * a new way to reach data or the network.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { LearningRequest } from "@magic/contracts";
import { localDay, isoDay } from "./dates";
import type { ActionContext, ActionSpec, ResolvedArgs } from "./types";
import { baseArgs, courseLabel, withAssignment, withCourse, type WithCourse } from "./action-args";
import { pipelineAgenda } from "./adapters/pipeline";

const args = baseArgs;
// Trailing connectors are trimmed before matching, so "go to" may arrive as "go".
const OPEN = "(?:open|go(?: to)?|goto|show me|show|take me(?: to)?|pull up|bring up|view|launch|jump to|switch to)";

async function practice(ctx: ActionContext, a: WithCourse, mode: "test" | "flashcards" | "learn", count: number) {
  const learning = ctx.host.learning;
  if (!learning) return { status: "not_built", message: "Practice isn't available yet." };
  const request: LearningRequest = {
    op: "practice.target",
    courseId: a.course.courseId,
    mode,
    count: a.count ?? count,
    ...(a.topicIds?.length ? { topicIds: a.topicIds } : {}),
    ...(a.topicText && !a.topicIds?.length && mode === "test" ? { description: a.topicText } : {}),
    anchorIds: ctx.resolve.anchors(a.course),
    operationId: randomUUID(),
  };
  if (!request.anchorIds?.length) delete request.anchorIds;
  return learning.handle(request, ctx.signal);
}

export const openCourse: ActionSpec<WithCourse> = {
  name: "course.open",
  description: "Open a course's page in the app.",
  slots: { course: "required" },
  argsSchema: withCourse,
  examples: ["open cs 400", "go to my philosophy class"],
  patterns: [new RegExp(`^${OPEN}(?: (?:my|the))?(?: (?:course|class|canvas|page|course page|class page|site|homepage|home page))*$`)],
  label: (a) => `Open ${courseLabel(a.course)}`,
  async run(a) {
    return { navigate: { view: "course", courseId: a.course.courseId, accountScope: a.course.accountScope }, course: a.course };
  },
};

export const openAssignment: ActionSpec<z.infer<typeof withAssignment>> = {
  name: "assignment.open",
  description: "Open one assignment by its title (in a course when named).",
  slots: { assignment: "required", course: "optional" },
  argsSchema: withAssignment,
  examples: ["open homework 3 in cs 400", "show me the essay 2 instructions"],
  patterns: [new RegExp(`^${OPEN}(?: (?:my|the))? (?<assignment>.+?)(?: (?:page|instructions|assignment|in canvas|on canvas))?$`)],
  label: (a) => `Open ${a.assignment.title}`,
  async run(a, ctx) {
    const opened = await ctx.host.workspace({ verb: "open", resourceId: a.assignment.resourceId });
    return { navigate: { view: "assignment", resourceId: a.assignment.resourceId }, title: a.assignment.title, url: opened.url ?? null, ...(opened.message ? { message: opened.message } : {}) };
  },
};

export const quizMe: ActionSpec<WithCourse> = {
  name: "practice.quiz",
  description: "Quiz the student on chosen topics of a course from its checked questions.",
  slots: { course: "required", topics: "optional", count: "optional" },
  argsSchema: withCourse,
  examples: ["quiz me on recursion in cs 400", "test me on hash tables"],
  patterns: [
    /^(?:quiz|test|drill) me(?: (?:on|about|over|in|for))?(?: (?<topics>.+))?$/,
    /^(?:give me |start |begin |do )?(?:a )?(?:practice )?(?:quiz|test) (?:me )?(?:on|about|over) (?<topics>.+)$/,
    /^practice(?: questions)? (?:on|about|for) (?<topics>.+)$/,
  ],
  label: (a) => `Quiz me${a.topicText ? ` on ${a.topicText}` : ""} · ${courseLabel(a.course)}`,
  run: (a, ctx) => practice(ctx, a, "test", 10),
};

export const flashcardsDue: ActionSpec<WithCourse> = {
  name: "practice.flashcards",
  description: "Review the course's flashcards that are due.",
  slots: { course: "required", topics: "optional", count: "optional" },
  argsSchema: withCourse,
  examples: ["flashcards due for math 234", "review my cards"],
  patterns: [
    /^(?:review |study |do |start |open |show(?: me)? |practice )?(?:my |the )?(?:due )?(?:flash ?cards?|cards)(?: (?:that are |that's |thats )?due)?(?: (?:on|about|for) (?<topics>.+))?$/,
    /^(?:what |which |any )?(?:flash ?cards?|cards) (?:are |is )?due$/,
  ],
  label: (a) => `Flashcards due · ${courseLabel(a.course)}`,
  run: (a, ctx) => practice(ctx, a, "flashcards", 20),
};

export const learnRound: ActionSpec<WithCourse> = {
  name: "practice.learn",
  description: "Start a Learn round (mixed practice that adapts to what the student misses).",
  slots: { course: "required", topics: "optional", count: "optional" },
  argsSchema: withCourse,
  examples: ["start a learn round for econ", "help me learn recursion"],
  patterns: [
    /^(?:start |do |begin |run )?(?:a )?learn (?:round|session|mode)(?: (?:on|about|for) (?<topics>.+))?$/,
    /^help me learn (?<topics>.+)$/,
  ],
  label: (a) => `Learn round · ${courseLabel(a.course)}`,
  run: (a, ctx) => practice(ctx, a, "learn", 10),
};

const withKind = withCourse.extend({ kind: z.enum(["cards", "quiz"]) });
export const generate: ActionSpec<z.infer<typeof withKind>> = {
  name: "pack.generate",
  description: "Generate new flashcards or quiz questions from a course's materials (uses the student's AI).",
  slots: { course: "required", kind: "required", topics: "optional", count: "optional" },
  argsSchema: withKind,
  examples: ["make flashcards for chapter 3 in phil 101", "generate a quiz on graphs"],
  patterns: [
    /^(?:make|generate|create|build|write)(?: me)?(?: (?:some|a|an|new|more))?(?: (?<count>\d{1,2}))? (?<kind>flash ?cards?|cards|quiz(?:zes)?|practice questions|questions)(?: (?:on|about|for|from|over) (?<topics>.+))?$/,
  ],
  label: (a) => `Generate ${a.kind === "cards" ? "flashcards" : "a quiz"} · ${courseLabel(a.course)}`,
  async run(a, ctx) {
    const pack = ctx.host.pack;
    if (!pack) return { status: "not_built", message: "Generation isn't available yet." };
    // The count the student asked for goes to the pack; without one the pack's default applies.
    return pack(a.kind, { courseId: a.course.courseId, ...(a.topicIds?.length ? { topicIds: a.topicIds } : {}) }, ctx.signal, a.count ? { count: a.count } : undefined);
  },
};

export const agenda: ActionSpec<ResolvedArgs> = {
  name: "agenda.due",
  description: "List what's due on a date or in a range (defaults to this week), optionally for one course.",
  slots: { date: "optional", course: "optional" },
  argsSchema: args,
  examples: ["what's due tomorrow", "anything due in cs 400 this week"],
  patterns: [
    /^(?:(?:what|whats|what's|what is|anything|show me|show|list|my|do i have|have i got|is there|is anything|tell me)\s+)*(?:(?:stuff|things|work|assignments?|homework|hw|anything|left|coming up|that's|thats|else|is)\s+)*(?:due|deadlines?|agenda|upcoming|up|on my (?:plate|agenda))(?:\s+(?:soon|next|coming up|for))?$/,
    /^(?:what do i have|what have i got|what's on|whats on|what is on)$/,
  ],
  label: (a) => `What's due${a.date ? ` ${a.date.label}` : " this week"}${a.course ? ` · ${courseLabel(a.course)}` : ""}`,
  async run(a, ctx) {
    // The material pipeline's agenda (classes, events, exams and due work, deduplicated) when present.
    const merged = pipelineAgenda(ctx, a);
    if (merged) return merged;
    const today = localDay(ctx.now, ctx.timeZone);
    const from = a.date?.from ?? isoDay(today);
    const to = a.date?.to ?? isoDay(today + 6 * 86_400_000);
    const days = Math.min(60, Math.max(1, Math.ceil((Date.parse(`${to}T00:00:00Z`) - today) / 86_400_000) + 2));
    if (to < isoDay(today)) return { range: { from, to }, items: [], message: "That date has passed; only upcoming work is listed." };
    const due = await ctx.host.workspace({ verb: "due", days, ...(a.course ? { courseId: a.course.courseId } : {}) });
    const local = (iso: string) => isoDay(localDay(new Date(iso), ctx.timeZone));
    const items = (due.items ?? []).filter((i) => {
      const d = local(i.dueAt);
      return d >= from && d <= to;
    });
    return { source: "due" as const, range: { from, to, label: a.date?.label ?? "this week" }, items };
  },
};

const withQuery = args.extend({ query: z.string().min(1).max(500) });
export const search: ActionSpec<z.infer<typeof withQuery>> = {
  name: "materials.search",
  description: "Search the student's course materials for words or a topic.",
  slots: { query: "required", course: "optional", scope: "optional" },
  argsSchema: withQuery,
  examples: ["find the slides on recursion", "search for bayes rule in stat 340"],
  patterns: [/^(?:search(?: for)?|find(?: me)?|look up|lookup|where (?:is|are|can i find))(?: (?:my|the|for))* (?<query>.+)$/],
  label: (a) => `Search for "${a.query}"`,
  async run(a, ctx) {
    const courses = a.course && a.scope !== "all" ? [{ accountScope: a.course.accountScope, courseId: a.course.courseId }] : ctx.resolve.courses().map((c) => ({ accountScope: c.accountScope, courseId: c.courseId }));
    const query = a.query.replace(/\b(?:notes|slides|materials|files|readings?|lecture|lectures|on|about)\b/g, " ").trim() || a.query;
    let result = ctx.store.searchPassages({ query, courses, k: 10, mode: "lookup" });
    if (!result.hits.length) result = ctx.store.searchPassages({ query, courses, k: 10 });
    const seen = new Set<string>();
    const hits = result.hits.filter((h) => !seen.has(h.resourceId) && seen.add(h.resourceId)).map((h) => ({ resourceId: h.resourceId, title: h.title, url: h.url, excerpt: h.excerpt, heading: h.heading, page: h.page }));
    return { query, hits, notFound: !hits.length };
  },
};

export const ask: ActionSpec<ResolvedArgs> = {
  name: "ask",
  description: "Answer a question from the student's own course materials, with checked quotes.",
  slots: { query: "optional", course: "optional", scope: "optional" },
  argsSchema: args,
  examples: ["what is the late policy in cs 400?", "how is the final exam weighted"],
  patterns: [
    /^(?:what|why|how|when|where|who|which|whats|what's|is|are|does|do|did|can|could|should|will|would|explain|define|describe|tell me|summarize|compare)\b.*$/,
  ],
  label: (a) => `Ask: ${a.query ?? a.text}`,
  async run(a, ctx) {
    const scope = a.scope === "all" ? "all" : a.course ? [a.course] : ctx.resolve.courses();
    return { kind: "answer" as const, ...(await ctx.ask(a.query ?? a.text, scope, ctx.signal)) };
  },
};
