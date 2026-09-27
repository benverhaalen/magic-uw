/**
 * Grade what-ifs in code, 0 tokens (D57's grade bank, packages/learning/src/grades): "what do I need
 * on the final for a B if I get 80 on the midterm". The student's captured Canvas scores and the
 * course's listed weights (Canvas, else the syllabus; never a guess), the hypothetical scores the
 * question states, and the letter cutoff read by code from the course's own grading scale. The
 * answer never reaches the model, so no sharing gate applies. It is arithmetic on stated facts, not
 * a grade prediction.
 */
import type { IntentCitation } from "@magic/contracts";
import { gradeInputs, groupResult, resolveWeights, type CourseGradeInput, type GradeItem } from "../../../../learning/src/grades/index";
import { gpaBySemester, gradesNeeded } from "../../../../domain/src/gpa";
import { baseArgs, courseLabel } from "../action-args";
import type { ActionContext, ActionSpec, ResolvedArgs, ResolvedCourse } from "../types";

const LETTERS = ["A", "AB", "B", "BC", "C", "D"] as const;
type Letter = (typeof LETTERS)[number];
/** A grading-scale heading, then the letter lines within this many characters. */
const SCALE_WINDOW = 400;
const SCALE_HEAD = /\b(?:letter grades?|grading scale|grade scale|grade cutoffs?|scale)\b/i;
const SCALE_ENTRY = /(?<![A-Za-z])(AB|BC|A|B|C|D)\s*(?:[:=]|is|at|>=|≥|-|–)?\s*(\d{2}(?:\.\d+)?)\s*%?/g;

/** The course's letter cutoffs, read by code from a grading-scale passage ("Letter grades: A 93 and above, AB 88, B 83"). */
export function letterScale(text: string): { cutoffs: Map<Letter, number>; start: number; end: number } | null {
  const head = SCALE_HEAD.exec(text);
  if (!head) return null;
  const window = text.slice(head.index, head.index + SCALE_WINDOW);
  const cutoffs = new Map<Letter, number>();
  let end = head.index;
  for (const m of window.matchAll(SCALE_ENTRY)) {
    const letter = m[1] as Letter;
    if (cutoffs.has(letter)) continue;
    cutoffs.set(letter, Number(m[2]));
    end = head.index + m.index! + m[0].length;
  }
  // A scale names at least two letters in falling order.
  const values = LETTERS.filter((l) => cutoffs.has(l)).map((l) => cutoffs.get(l)!);
  if (values.length < 2 || values.some((v, i) => i > 0 && v >= values[i - 1]!)) return null;
  return { cutoffs, start: head.index, end };
}

const WORD_TO_KIND: Record<string, GradeItem["examKind"]> = { final: "final", midterm: "midterm", "mid-term": "midterm", exam: "exam", quiz: "quiz" };
/** The unscored item a phrase names ("the final", "the midterm", "homework 4"). */
function itemNamed(items: GradeItem[], phrase: string): GradeItem | null {
  const p = phrase.toLowerCase().replace(/^(?:the|my)\s+/, "").replace(/\s+(?:exam|examination|test)$/, "").trim();
  const kind = WORD_TO_KIND[p];
  const hits = items.filter((x) => (kind ? x.examKind === kind : x.title.toLowerCase().includes(p)));
  return hits.length === 1 ? hits[0]! : null;
}

export interface WhatIf {
  /** The item the student asks about, and the course percent they want. */
  item: string;
  target: { letter: Letter | null; percent: number | null };
  /** "if I get 80 on the midterm": item phrase → percent. */
  assume: { phrase: string; percent: number }[];
}
/** Reads the question in code; null when it isn't a what-if this can answer. */
export function parseWhatIf(text: string): WhatIf | null {
  const t = text.toLowerCase().replace(/[?!]/g, " ").replace(/\s+/g, " ").trim();
  const assume: WhatIf["assume"] = [];
  const IF = /\bif i (?:get|got|score|scored|make|made|end up with) (?:an? )?(\d{1,3}(?:\.\d+)?)(?:\s*(?:%|percent)|\s*\/\s*(\d{1,3}))? on (?:the |my )?([a-z0-9 -]+?)(?=$| and | if |,| for | to | in )/g;
  let rest = t;
  for (const m of t.matchAll(IF)) {
    const value = Number(m[1]);
    const percent = m[2] ? (100 * value) / Number(m[2]) : value;
    if (percent >= 0 && percent <= 150) assume.push({ phrase: m[3]!.trim(), percent });
    rest = rest.replace(m[0], " ");
  }
  const on = /\bneed(?: to (?:get|score|make))?(?: an? | )?(?:on|in) (?:the |my )?([a-z0-9 -]+?)(?=$| for | to | if |,| in )/.exec(rest);
  const goal = /\b(?:for|to get|to end with|to finish with|to keep|to have)(?: an?)? (ab|bc|a|b|c|d|\d{2,3}(?:\.\d+)?\s*%?)(?=$|\s|,)/.exec(rest);
  if (!on || !goal) return null;
  const g = goal[1]!.trim();
  const target = /^\d/.test(g) ? { letter: null, percent: Number(g.replace(/\s*%$/, "")) } : { letter: g.toUpperCase() as Letter, percent: null };
  return { item: on[1]!.trim(), target, assume };
}

const ceil1 = (x: number) => Math.ceil(x * 10 - 1e-9) / 10;

/** The grading scale's source passage, as a checked citation. */
function scaleCitation(ctx: ActionContext, course: ResolvedCourse): { cutoffs: Map<Letter, number>; citation: IntentCitation } | null {
  const scopes = new Map(ctx.store.sources().map((s) => [s.id, s.accountScope]));
  const texts = ctx.store.resources().filter((r) => !r.deleted && r.courseId === course.courseId && scopes.get(r.sourceId) === course.accountScope && r.text && SCALE_HEAD.test(r.text));
  // The syllabus first, then any other course text that states a scale.
  texts.sort((a, b) => Number(/syllabus/i.test(b.title)) - Number(/syllabus/i.test(a.title)) || a.title.localeCompare(b.title));
  for (const r of texts) {
    const s = letterScale(r.text);
    if (s) return { cutoffs: s.cutoffs, citation: { sourceId: "grading-scale", resourceId: r.id, title: r.title, url: r.url, quote: r.text.slice(s.start, s.end), start: s.start, end: s.end } };
  }
  return null;
}

type Answer = { kind: "answer"; text: string; citations: IntentCitation[]; notFound: boolean; dropped: number };
const reply = (text: string, citations: IntentCitation[] = []): Answer => ({ kind: "answer", text, citations, notFound: false, dropped: 0 });

/** The what-if for one course, or why it can't be worked out. */
export function whatIf(ctx: ActionContext, course: ResolvedCourse, q: WhatIf): Answer {
  const input: CourseGradeInput = gradeInputs(ctx.store, { accountScope: course.accountScope, courseId: course.courseId });
  const weights = resolveWeights(input);
  if (weights.status !== "known") return reply(`I can't work that out for ${courseLabel(course)}: ${weights.reason}`);
  // The grade bank's rule: a partial capture could change the figures, so no course figure is made.
  if (input.coverage.status !== "complete") return reply(`I can't work that out for ${courseLabel(course)} yet: ${input.coverage.reasons.join("; ") || "its Canvas reads are incomplete"}.`);
  const target = itemNamed(input.items, q.item);
  if (!target) return reply(`I couldn't find one ungraded "${q.item}" in ${courseLabel(course)}'s Canvas assignments.`);
  if (target.score !== null) return reply(`${target.title} already has a score in Canvas (${target.score}/${target.points}).`);
  if (!target.points || !target.groupId || !weights.byGroup.has(target.groupId)) return reply(`${target.title} has no points or weighted group in Canvas, so its part of the grade isn't known.`);
  // The stated hypotheticals become scores; nothing else is assumed.
  const assumed: string[] = [];
  const items = input.items.map((x) => ({ ...x }));
  for (const a of q.assume) {
    const it = itemNamed(items, a.phrase);
    if (!it) return reply(`I couldn't find one "${a.phrase}" in ${courseLabel(course)}'s Canvas assignments.`);
    if (!it.points) return reply(`${it.title} has no points in Canvas.`);
    it.score = (a.percent / 100) * it.points;
    assumed.push(`${it.title} at ${Math.round(a.percent * 10) / 10}% (as you said)`);
  }
  let goal = q.target.percent;
  const citations: IntentCitation[] = [];
  if (q.target.letter) {
    const scale = scaleCitation(ctx, course);
    const cut = scale?.cutoffs.get(q.target.letter);
    if (!scale || cut === undefined) return reply(`${courseLabel(course)}'s materials don't state the cutoff for ${q.target.letter === "A" || q.target.letter === "AB" ? "an" : "a"} ${q.target.letter}. Ask with a percentage instead, like "for an 83".`);
    goal = cut;
    citations.push(scale.citation);
  }
  if (goal === null) return reply("What course grade are you aiming for?");
  // The weighted groups that hold work counting toward the grade.
  const groups = input.groups.filter((g) => (weights.byGroup.get(g.id) ?? 0) > 0 && items.some((x) => x.groupId === g.id && (x.points ?? 0) > 0 && !x.excused));
  // Every weighted group other than the target's needs a score, captured or stated.
  let known = 0;
  const parts: string[] = [];
  for (const g of groups) {
    if (g.id === target.groupId) continue;
    const r = groupResult(g, items, weights);
    if (r.percent === null) return reply(`${g.title} (${weights.byGroup.get(g.id)}% of the grade) has no score yet, so I can't work it out. Ask again with one, like "if I get 80 on the ${g.title.toLowerCase()}".`);
    known += (weights.byGroup.get(g.id)! * r.percent) / 100;
    parts.push(`${g.title} ${r.percent}% (${weights.byGroup.get(g.id)}%)`);
  }
  const group = groups.find((g) => g.id === target.groupId)!;
  const w = weights.byGroup.get(group.id)!;
  // The target's group: its other scored work, plus the target at x%.
  const others = groupResult(group, items.filter((x) => x.id !== target.id), weights);
  const E = others.earned;
  const P = others.possible;
  const x = ((((goal - known) / w) * (P + target.points)) - E) / target.points * 100;
  const need = ceil1(x);
  const basis = `From your Canvas scores and ${weights.source === "canvas" ? "Canvas's group weights" : "the syllabus weights"}: ${[...parts, `${group.title} ${w}%`].join(", ")}${assumed.length ? `; assuming ${assumed.join(", ")}` : ""}. Arithmetic on these figures, not a grade prediction.`;
  const want = q.target.letter ? `${q.target.letter} (${goal}%)` : `${goal}%`;
  const best = Math.round((known + (w * (E + target.points)) / (P + target.points)) * 10) / 10;
  if (need > 100) return reply(`Even 100% on ${target.title} gives about ${best}%, short of ${want}. ${basis}`, citations);
  if (need <= 0) return reply(`You'd reach ${want} whatever you score on ${target.title}. ${basis}`, citations);
  return reply(`You need at least ${need}% on ${target.title} for ${want} in ${courseLabel(course)}. ${basis}`, citations);
}

export const gradeWhatIf: ActionSpec<ResolvedArgs> = {
  name: "grades.whatif",
  description: "Work out the score the student needs on an upcoming exam or assignment for a course grade, from their Canvas scores and the course's weights (code; never a prediction).",
  slots: { course: "optional" },
  argsSchema: baseArgs,
  examples: ["what do i need on the final for a b", "what do i need on the final to get an 83 if i get 80 on the midterm"],
  patterns: [
    /^(?:what|which)(?: (?:score|grade|mark|percent|percentage))? (?:do|would|will|should) i need (?:to (?:get|score|make) )?(?:an? )?(?:on|in) .+ (?:for|to get|to end with|to finish with|to keep|to have) .+$/,
    /^how (?:much|well) (?:do|would|will|should) i need to (?:do|score) on .+ (?:for|to get) .+$/,
  ],
  label: (a) => `Grade what-if${a.course ? ` · ${courseLabel(a.course)}` : ""}`,
  async run(a, ctx) {
    const q = parseWhatIf(a.text);
    if (!q) return reply('Ask like "what do I need on the final for a B", with any scores you want me to assume ("if I get 80 on the midterm").');
    if (a.course) return whatIf(ctx, a.course, q);
    // No course named or open: the one current course with a matching ungraded item and known weights.
    const fits = ctx.resolve.courses().filter((c) => {
      const input = gradeInputs(ctx.store, { accountScope: c.accountScope, courseId: c.courseId });
      const t = itemNamed(input.items, q.item);
      return !!t && t.score === null && resolveWeights(input).status === "known";
    });
    if (fits.length === 1) return whatIf(ctx, fits[0]!, q);
    return reply(fits.length ? `Which course? ${fits.map(courseLabel).join(", ")} each have one. Ask again with the course, like "… in ${courseLabel(fits[0])}".` : `I couldn't find an ungraded "${q.item}" with known weights in your current courses. Name the course, like "… in cs 400".`);
  },
};

/** "What GPA do I need…", "what if my GPA…": answered in code, never sent on to the model. */
export const gpaWhatIf: ActionSpec<ResolvedArgs> = {
  name: "grades.gpa",
  description: "GPA what-ifs (a GPA target or projection) are computed by code, not by the AI.",
  slots: {},
  argsSchema: baseArgs,
  examples: ["what gpa do i need", "what if my gpa"],
  // A GPA question that asks for a target or a projection; "what is the gpa requirement" goes on to the ask.
  patterns: [/^(?=.*\bgpa\b)(?=.*\b(?:need|what if|would|will|raise|bring|get|projected?)\b).*$/],
  label: () => "GPA what-if",
  // owner: gpa. Planning records never leave code: computed from the saved course history and this term's enrollment.
  async run(a, ctx) {
    // A "ran" result (the command bar shows its message), so the student sees which action answered.
    const ran = (message: string) => ({ message });
    const records = ctx.store.planningRecords();
    const history = records.flatMap((r) => (r.kind === "course_history"
      ? [{ id: r.id, kind: "course_history" as const, provenance: r.provenance, courseKey: r.courseKey, termCode: r.termCode, state: r.state, credits: r.credits, grade: r.grade, gpaEligible: r.gpaEligible }]
      : []));
    const semesters = gpaBySemester(history);
    const cumulative = semesters.at(-1)?.cumulativeGpa ?? null;
    if (!history.length) return ran("Connect Course Search & Enroll in My UW to compute your GPA from your course history.");
    const target = Number(/([0-3](?:.d{1,3})?|4(?:.0{1,3})?)/.exec(a.text)?.[1] ?? Number.NaN);
    const now = cumulative === null ? "not enough graded credits yet" : cumulative.toFixed(3);
    if (!Number.isFinite(target)) return ran(`Your cumulative GPA from your course history is ${now}. Try "what do I need this term for a 3.5", or open My UW › GPA for what-if grades.`);
    const enrolled = records.filter((r) => r.kind === "enrollment_package" && r.enrollmentState === "enrolled");
    const term = enrolled.map((r) => (r.kind === "enrollment_package" ? r.termCode : "")).sort()[0];
    const catalog = records.filter((r) => r.kind === "catalog_course");
    const current = enrolled.filter((r) => r.kind === "enrollment_package" && r.termCode === term).map((r) => {
      const c = catalog.find((x) => x.kind === "catalog_course" && x.courseKey === (r.kind === "enrollment_package" ? r.courseKey : "") && x.creditMin !== null && x.creditMin === x.creditMax);
      return { courseKey: r.kind === "enrollment_package" ? r.courseKey : "", credits: c && c.kind === "catalog_course" && c.creditMin !== null ? c.creditMin : Number.NaN };
    });
    const r = gradesNeeded(history, current, target);
    return ran(r.status === "unknown" ? `${r.reason} Your cumulative is ${now}; add credits in My UW › GPA.`
      : r.status === "already_met" ? `A ${target.toFixed(2)} cumulative is already reached (${r.achievableCumulative.toFixed(3)}), even with an F this term.`
      : r.status === "reachable" ? `To reach ${target.toFixed(2)} cumulative you need at least ${r.neededGrade} in every class this term (now ${now}).`
      : `${target.toFixed(2)} isn't reachable this term; the best you can reach is ${r.bestAchievableCumulative.toFixed(3)} (now ${now}).`);
  },
};
