/**
 * The grounded ask: a minimal notebook Q&A over the student's own course passages.
 * Code retrieves (contentless FTS, BM25) within a token budget; the coverage gate answers
 * "Not in your materials" with no model call; one checked call writes sentences with quotes;
 * code finds every quote in its passage and drops a sentence none of whose quotes check out.
 * Planning records are a separate table and are never retrieved.
 */
import type { IntentCitation } from "@magic/contracts";
import type { ModelRunner } from "../../../runner/src/index";
import { buildPrompt, type ArtifactStore, type CourseFrame, type LedgerStore, type Passage } from "../../../packs/core/src/index";
import { askPack, type AskOutput } from "../../../packs/intent/src/index";
import { findQuote } from "../../../retrieval/src/quotes";
import { contentCategories } from "../access";
import { runPack } from "../jobs/pack";
import { authorizer } from "./consent";
import { coursePackCatalogue, type CoursePrefixSource } from "../course-facts/prefix"; // owner: course-facts
import { intelligenceView } from "../../../domain/src/course-intelligence";
import { LEARNING_CONTRACT, decideLearning, learningSource, selectTaskMode, uwDefaultReminder } from "../../../domain/src/learning-request";
import type { AskResult, IntentStore, ResolvedCourse } from "./types";
import { originalQuote, passageClass, type IntentProtection } from "../privacy/intent"; // owner: privacy

export const ASK_TOKEN_BUDGET = 3000;
const ASK_MAX_PASSAGES = 8;
export const NOT_IN_MATERIALS = "Not in your materials.";

export interface AskDeps {
  store: IntentStore;
  runner: () => Promise<ModelRunner | null>;
  artifacts: ArtifactStore;
  ledger: LedgerStore;
  now: () => Date;
  tokenBudget?: number;
  resourceId?: string;
  /**
   * The student's raw words. With the question, code chooses the task mode from them; there is no
   * caller-supplied mode, so a frontend or model instruction cannot grant direct help.
   */
  utterance?: string;
  /** owner: privacy. The router's protection; absent means none (a direct caller). */
  protection?: IntentProtection;
  /** owner: course-facts. The course prefix (brief + pack catalogue): used when the ask names one course. */
  coursePrefix?: CoursePrefixSource;
  /** The student's time zone, for the dates in assessment facts. */
  timeZone?: string;
}

const zero = () => ({ in: 0, cached: 0, out: 0 });
const CONTEXT_CHANGED = "Your course sources or AI rules changed while Magic was answering, so it didn't show that answer. Ask again.";
/** Thrown from the runner's pre-dispatch and post-call hooks; it is not a RunnerError, so it stops the job. */
class LearningContextChanged extends Error {}

/** Words that can open a question before the thing it is about ("what does", "explain", "tell me more about"). */
const LEAD_WORDS = new Set(
  "what whats when where why how who whom which whose is are was were be does do did can could should would will may might must the a an and or but so then now also of on in at for to from about with into by as explain define describe tell show give say me more again please ok okay i you we us my our your he she him her his really actually just still mean means meant simply simpler briefly further example examples".split(" "),
);
const BACK_WORDS = new Set(["it", "its", "that", "this", "those", "these", "they", "them"]);
/**
 * Whether a question points back at the previous exchange: a back-reference ("it", "that", "those")
 * comes before any word of its own subject. "why does it resize" and "explain that more simply"
 * refer back; "when is the midterm, and what's on it" names its subject first, so it doesn't.
 */
export function refersBack(question: string): boolean {
  for (const w of question.toLowerCase().match(/[a-z0-9']+/g) ?? []) {
    const bare = w.replace(/'(?:s|re|ll|d|ve)$/, "");
    if (BACK_WORDS.has(bare)) return true;
    if (!LEAD_WORDS.has(bare)) return false;
  }
  return false;
}
/** The one earlier exchange an ask may carry, shortened: an answer past this is cut. */
export const PREVIOUS_ANSWER_CHARS = 600;
export type PreviousExchange = { question: string; answer: string };
export interface AskOptions {
  /** The one earlier exchange, when the question refers back to it (the router decides). */
  previous?: PreviousExchange | null;
  /** The words to search with: the question without the course it names ("in cs 400"), which no passage contains. */
  searchText?: string;
  /** owner: study-prep. Only these sources (the Study prepper's ticked Sources); absent: the whole course. */
  resourceIds?: readonly string[];
  /** Passage allowlist resolved from the current Study target's topic anchors. */
  passageIds?: readonly number[];
  /** Exact selected topic excerpts; never send unrelated text in an allowed passage. */
  passageText?: ReadonlyMap<number, string>;
  /** Trusted quoted effective directive, additional to the runner's all-source policy decision. */
  policyInstruction?: string;
  /** Recheck the authenticated Study target, source versions, and permission before use. */
  validate?: () => void;
}

const ASSESSMENT_WORD = /\b(exams?|midterms?|finals?|quiz(?:zes)?|tests?)\b/i;
const ASSESSMENT_TITLE = /\b(exam|midterm|final|quiz|test)\b/i;
/** At most this many assessment facts go with an exam question. */
export const ASSESSMENT_FACTS = 4;
type Fact = { sourceId: string; text: string; resourceId: string; title: string; url: string };

/**
 * An exam question's assessment facts, for one course: what code already holds about its exams
 * (the course map's assessments and stated scope, the course facts' assessment claims, and the
 * Canvas assessment records with their dates, points and group weights). Canvas and map records
 * are rendered by code as one line each; a claim contributes the syllabus passage behind its quote.
 * Every fact is a passage the answer's quotes are checked against.
 */
export function assessmentFacts(store: IntentStore, course: ResolvedCourse, question: string, timeZone: string): { facts: Fact[]; pids: number[] } {
  const word = ASSESSMENT_WORD.exec(question)?.[1]?.toLowerCase();
  if (!word) return { facts: [], pids: [] };
  const asked = word.startsWith("quiz") ? "quiz" : word.replace(/s$/, "");
  // "the midterm" means the midterms; "an exam" or "a test" means any of them.
  const matches = (title: string) => ASSESSMENT_TITLE.test(title) && (asked === "exam" || asked === "test" || new RegExp(`\\b${asked}`, "i").test(title));
  const when = (iso: string) => {
    const dated = /^\d{4}-\d{2}-\d{2}$/.test(iso);
    return new Intl.DateTimeFormat("en-US", { timeZone: dated ? "UTC" : timeZone, weekday: "long", month: "long", day: "numeric", year: "numeric", ...(dated ? {} : { hour: "numeric", minute: "2-digit", timeZoneName: "short" }) }).format(new Date(dated ? `${iso}T00:00:00Z` : iso));
  };
  const facts: Fact[] = [];
  const covered = new Set<string>();
  const ref = { accountScope: course.accountScope, courseId: course.courseId };
  for (const a of store.assessments(ref)) {
    if (facts.length >= ASSESSMENT_FACTS || !matches(a.title)) continue;
    const scope = store.assessmentScopes(a.id).find((x) => x.status !== "flagged");
    const resourceId = a.resourceId ?? scope?.evidence?.resourceId;
    const r = resourceId ? store.resource(resourceId) : undefined;
    if (!r) continue;
    const bits = [a.date ? `on ${when(a.date)}` : null, a.weight !== null ? `${a.weight}% of the grade` : null, a.format ? `format: ${a.format}` : null, scope ? `covers: ${scope.stated}` : null].filter(Boolean);
    if (!bits.length) continue;
    covered.add(r.id);
    facts.push({ sourceId: `f${facts.length + 1}`, text: `${a.title} (the app's course map): ${bits.join("; ")}.`, resourceId: r.id, title: r.title, url: r.url });
  }
  const scopeOf = new Map(store.sources().map((x) => [x.id, x.accountScope]));
  const live = store.resources().filter((r) => !r.deleted && r.courseId === course.courseId && scopeOf.get(r.sourceId) === course.accountScope);
  // Canvas assignment groups are their own records; an assignment names its group by ID.
  const groupWeight = new Map(live.flatMap((g) => (g.assignmentGroup?.weight != null ? [[g.externalId, g.assignmentGroup.weight] as const] : [])));
  for (const r of live) {
    if (facts.length >= ASSESSMENT_FACTS || covered.has(r.id) || r.kind !== "assignment" || !matches(r.title)) continue;
    const weight = r.assignmentGroup?.weight ?? (r.assignmentGroupId ? groupWeight.get(r.assignmentGroupId) : undefined);
    const bits = [r.dueAt ? `due ${when(r.dueAt)}` : null, r.points ? `${r.points} points` : null, weight != null ? `its assignment group is ${weight}% of the grade` : null].filter(Boolean);
    if (!bits.length) continue;
    facts.push({ sourceId: `f${facts.length + 1}`, text: `${r.title} (Canvas assignment): ${bits.join("; ")}.`, resourceId: r.id, title: r.title, url: r.url });
  }
  // The course facts' assessment claims: the passages that hold their quotes.
  const profile = store.courseIntelligence().filter((p) => p.accountScope === course.accountScope && p.courseId === course.courseId).sort((x, y) => y.version - x.version)[0];
  const pids = new Set<number>();
  for (const claim of profile?.claims ?? []) {
    if (claim.kind !== "assessment" || !matches(`${claim.label} ${String(claim.value ?? "")}`)) continue;
    for (const e of claim.evidence) {
      if (e.start === undefined || e.end === undefined) continue;
      for (const p of store.passages(e.resourceId)) if (!p.redacted && p.start < e.end && p.end > e.start) pids.add(p.pid);
    }
  }
  return { facts, pids: [...pids] };
}

export async function groundedAsk(deps: AskDeps, question: string, courses: ResolvedCourse[], signal: AbortSignal, options: AskOptions = {}): Promise<AskResult> {
  const { store } = deps;
  const previous = options.previous ?? null;
  const none = (text: string, extra: Partial<AskResult> = {}): AskResult => ({ text, citations: [], notFound: true, dropped: 0, path: "none", tokens: zero(), ...extra });
  if (!courses.length) return none(NOT_IN_MATERIALS);
  // A question that refers back is searched with the question it refers to, so "why does it resize" finds its passages.
  const words = options.searchText?.trim() || question;
  const query = previous ? `${previous.question} ${words}` : words;
  // Study narrows the shared FTS query before ranking, including exact topic passages.
  const allowed = options.resourceIds ? new Set(options.resourceIds) : null;
  const allowedPassages = options.passageIds ? new Set(options.passageIds) : null;
  const accountOf = (sourceId: string) => store.sources().find((s) => s.id === sourceId)?.accountScope;
  const found = store.searchPassages({ query,
    courses: courses.map((c) => ({ accountScope: c.accountScope, courseId: c.courseId })),
    ...(allowed ? { resourceIds: [...allowed] } : {}),
    ...(allowedPassages ? { passageIds: [...allowedPassages] } : {}), k: 12 });
  // A one-course exam question also reads what code holds about that course's exams.
  const allFacts = courses.length === 1 ? assessmentFacts(store, courses[0]!, question, deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone) : { facts: [], pids: [] };
  const facts = allowed || allowedPassages ? { facts: allFacts.facts.filter((f) => (!allowed || allowed.has(f.resourceId)) && !allowedPassages),
    pids: allFacts.pids.filter((pid) => (!allowedPassages || allowedPassages.has(pid)) &&
      (!allowed || allowed.has(store.passage(pid)?.passage.resourceId ?? ""))) } : allFacts;
  // The coverage gate: nothing in the materials or the exam facts supports the question, so no model call.
  const searched = found.notFound ? [] : found.hits;
  if (!searched.length && !facts.facts.length && !facts.pids.length) return none(NOT_IN_MATERIALS);
  const budget = deps.tokenBudget ?? ASK_TOKEN_BUDGET;
  const passages: Passage[] = [];
  const meta = new Map<string, { resourceId: string; title: string; url: string }>();
  // Every source whose passage text goes into the prompt, fixed when that text was read: its account and
  // content hash. The set is never rebuilt from what still resolves later, so a source that disappears
  // while the runner is acquired can't drop out of the policy decision while its passage stays in the prompt.
  const expected = new Map<string, { accountScope: string | undefined; contentHash: string | undefined }>();
  const capture = (id: string) => {
    if (expected.has(id)) return;
    const r = store.resource(id);
    expected.set(id, { accountScope: r ? accountOf(r.sourceId) : undefined, contentHash: r?.contentHash });
  };
  let used = 0;
  for (const f of facts.facts) {
    if (deps.resourceId && f.resourceId !== deps.resourceId) continue; // an item-scoped ask stays within that item
    passages.push({ sourceId: f.sourceId, text: f.text });
    meta.set(f.sourceId, { resourceId: f.resourceId, title: f.title, url: f.url });
    capture(f.resourceId);
    used += Math.ceil(f.text.length / 4);
  }
  const claimHits = facts.pids.flatMap((pid) => {
    const p = store.passage(pid);
    return p ? [{ pid, resourceId: p.passage.resourceId, title: p.title, url: p.url }] : [];
  });
  const seen = new Set<number>();
  for (const h of [...claimHits, ...searched]) {
    if (seen.has(h.pid)) continue;
    seen.add(h.pid);
    if (deps.resourceId && h.resourceId !== deps.resourceId) continue;
    if (allowed && !allowed.has(h.resourceId)) continue;
    if (allowedPassages && !allowedPassages.has(h.pid)) continue;
    if (passages.length >= ASK_MAX_PASSAGES) break;
    const p = store.passage(h.pid);
    const excerpt = options.passageText ? options.passageText.get(h.pid) : p?.text;
    if (!p || p.passage.redacted || !excerpt?.trim()) continue;
    const tokens = Math.ceil(excerpt.length / 4);
    if (used + tokens > budget && passages.length) continue;
    used += tokens;
    const sourceId = `p${h.pid}`;
    passages.push({ sourceId, text: excerpt });
    meta.set(sourceId, { resourceId: h.resourceId, title: h.title, url: h.url });
    capture(h.resourceId);
  }
  if (!passages.length) return none(deps.resourceId ? "I could not find matching passages in this selected item. Try naming the section you want to discuss." : NOT_IN_MATERIALS);
  options.validate?.();
  const runner = await deps.runner();
  if (!runner)
    return none("", { notFound: false, unavailable: "Answering needs your AI: choose Claude or Codex in Settings and sign in. Search still works without it." });

  /** Every expected source, still present under its original account and content; null if any is not. */
  const expectedResources = () => {
    const rows = [...expected].flatMap(([id, at]) => {
      const r = store.resource(id);
      return r && !r.deleted && at.contentHash && at.accountScope && r.contentHash === at.contentHash && accountOf(r.sourceId) === at.accountScope ? [r] : [];
    });
    return rows.length === expected.size ? rows : null;
  };
  const UNCONFIRMED = "Magic couldn't confirm the course and account for every source, so it didn't answer.";
  const resources = expectedResources();
  if (!resources) return none("", { notFound: false, unavailable: UNCONFIRMED });
  // owner: course-facts. One course: the shared course prefix opens the prompt, as for packs and guides;
  // the brief's sources are sent too, so their categories are checked and receipted.
  const prefix = !allowed && !allowedPassages && courses.length === 1 ? deps.coursePrefix?.(courses[0]!.ref) : undefined;
  const briefResources = (prefix?.resourceIds ?? []).flatMap((id) => store.resource(id) ?? []);
  const categories = [...new Set([...resources, ...briefResources].flatMap((r) => contentCategories(r)))].sort();
  const pack = { ...askPack, categories };
  const label = courses.length === 1 ? (courses[0]!.code ?? courses[0]!.name) : "Your courses";
  // Every course whose passages are sent gets its own effective policy; the strictest applies and a
  // withheld course stops the request before any model call. Never "first policy found". An open graded
  // item in scope makes the request graded work whatever the words asked; an unclear use case is never direct help.
  const requested = selectTaskMode([deps.utterance, question]);
  const decide = () => {
    const rows = expectedResources();
    if (!rows) return null;
    const sources = store.sources(), at = deps.now().toISOString();
    const profiles = store.courseIntelligence().map((p) => ({ ...p, freshness: intelligenceView(p, sources, at).freshness }));
    const selected = rows.flatMap((r) => { const s = learningSource(r, sources, profiles); return s ? [s] : []; });
    return selected.length === expected.size ? decideLearning(requested, selected, { learningContract: LEARNING_CONTRACT }) : null;
  };
  const decision = decide();
  if (!decision) return none("", { notFound: false, unavailable: UNCONFIRMED });
  if (decision.status !== "ready") return none("", { notFound: false, unavailable: decision.reason });
  const frame: CourseFrame = {
    courseId: courses.length === 1 ? courses[0]!.ref : "all",
    course: label,
    skeleton: courses.map((c) => `Course: ${c.code ? `${c.code}: ` : ""}${c.name}`).join("\n"),
    // The system prompt's "Course AI policy" section: task mode, help boundary, exact scope and each course's quoted rule.
    policy: options.policyInstruction ? `${decision.request.system}\nStudy target rule: ${options.policyInstruction}` : decision.request.system,
  };
  // owner: course-facts
  // The learning decision's policy text (task mode, help boundary, each course's quotes) stays whole;
  // the brief-pointer shortening (BRIEF_POLICY_POINTER) would drop the mode and boundary, so it isn't applied here.
  if (prefix) frame.brief = prefix.text;
  // No brief: the byte-stable pack catalogue is the system prompt (pool.ts promptCacheMinimum).
  else frame.brief = coursePackCatalogue();
  // end owner: course-facts
  // owner: privacy: the question is the student's; each passage is its resource's class.
  const p = deps.protection?.request("ask");
  const frozen = new Map(passages.map((x) => [x.sourceId, p ? p.frozen(x.text, passageClass(store.resource(meta.get(x.sourceId)!.resourceId))) : { text: x.text, spans: [] }]));
  const sent = passages.map((x) => ({ ...x, text: frozen.get(x.sourceId)!.text }));
  // The brief is the byte-stable system prompt: protected once per content (the stable prefix's
  // protection), so every ask on the course sends the same bytes and the provider's cache holds.
  if (p) Object.assign(frame, { course: p.text(frame.course, "teaching"), skeleton: p.text(frame.skeleton, "teaching"), policy: p.text(frame.policy, "teaching"), ...(frame.brief !== undefined ? { brief: deps.protection?.prefix(frame.brief) ?? frame.brief } : {}) });
  const guard = (text: string) => (p ? p.text(text, "personal") : text);
  const input = {
    question: guard(question.trim().slice(0, 2000)),
    // Only the last exchange, and only when the question refers back to it: earlier turns are never re-sent.
    ...(previous ? { previous: { question: guard(previous.question.trim().slice(0, 500)), answer: guard(previous.answer.trim().slice(0, PREVIOUS_ANSWER_CHARS)) } } : {}),
  };
  const prompt = buildPrompt(pack, frame, input, sent);
  const receiptIds: string[] = [];
  const authorize = authorizer(
    store,
    {
      purpose: "Answer a question from course materials",
      course: label,
      title: "ask",
      text: prompt.input,
      policy: frame.policy,
      resourceIds: [...new Set([...resources.map((r) => r.id), ...(prefix?.resourceIds ?? [])])], // owner: course-facts: + the brief's sources
      characters: prompt.systemPrompt.length + prompt.input.length,
    },
    () => deps.now().toISOString(),
    receiptIds,
  );
  // The decision is rebuilt from current data immediately before every provider dispatch (a queued or
  // retried call under a changed rule never goes out) and after every model call and before the artifact
  // is stored (an answer produced under a changed rule is neither cached nor shown).
  const unchanged = () => {
    options.validate?.();
    const now = decide();
    if (now?.status !== "ready" || now.request.system !== decision.request.system) throw new LearningContextChanged(CONTEXT_CHANGED);
  };
  let result: Awaited<ReturnType<typeof runPack<{ question: string }, AskOutput>>>;
  try {
    result = await runPack(
      {
        runner,
        artifacts: deps.artifacts,
        ledger: deps.ledger,
        authorize,
        now: () => deps.now().getTime(),
        beforeCall: (call) => (unchanged(), call),
        validate: unchanged,
      },
      pack,
      frame,
      input,
      sent, // owner: privacy
      { lane: "interactive", scope: courses.length === 1 ? "course" : "all", signal },
    );
  } catch (error) {
    if (error instanceof LearningContextChanged) return none("", { notFound: false, unavailable: CONTEXT_CHANGED });
    throw error;
  }
  if (result.status === "blocked") return none("", { notFound: false, unavailable: result.reason });
  if (result.status === "needs_student") return none("", { notFound: false, unavailable: "The answer didn't pass the app's checks. Try asking more specifically." });
  if (result.status !== "done") return none("", { notFound: false, unavailable: result.message });
  // The system text states every source's content hash and each policy revision, so the cache key binds
  // them: a cache hit (which skips the runner hooks) matches the current decision. Confirm once more.
  try {
    unchanged();
  } catch {
    return none("", { notFound: false, unavailable: CONTEXT_CHANGED });
  }
  const tokens = result.cached ? zero() : result.artifact.usage;
  const path = result.cached ? "cache" : "ai";
  // owner: privacy: quotes and sentences back in the original words before code checks the quotes.
  const output = p
    ? {
        ...result.artifact.output,
        sentences: result.artifact.output.sentences.map((s) => ({
          ...s,
          text: p.restore(s.text),
          citations: s.citations.map((c) => {
            const f = frozen.get(c.sourceId), original = passages.find((x) => x.sourceId === c.sourceId)?.text;
            return { ...c, quote: (f && original !== undefined && originalQuote(f, original, c.quote)) || c.quote };
          }),
        })),
      }
    : result.artifact.output;
  const checked = checkAnswer(output, passages, meta, (id) => store.resource(id)?.text ?? null);
  // Under UW–Madison's default, an answer touching open graded work always carries the reminder (added by code).
  const reminder = checked.notFound ? null : uwDefaultReminder(decision.request);
  return { ...checked, ...(reminder ? { text: `${checked.text}\n\n${reminder}` } : {}), path, tokens };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const DATE_MD = new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?!\\d)`, "gi");
const DATE_DM = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}(?![a-z])`, "gi");
const WEEKDAY = /\b(mon|tue|wed|thu|fri|sat|sun)(?:day|sday|nesday|rsday|urday)?s?\b/gi;
const MONTH_OR_DAY = new RegExp(`^(?:${MONTH}|(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?s?)$`, "i");
/** Capitalized words that are not names: titles and common words. */
const NOT_NAMES = new Set(["i", "prof", "professor", "dr", "mr", "ms", "mrs", "the", "a", "an", "it", "this", "that", "you", "your", "yes", "no", "note", "also", "am", "pm"]);
const month = (m: string) => MONTHS.find((x) => m.toLowerCase().startsWith(x)) ?? m.toLowerCase();
/** A capitalized label and its number ("Homework 4", "Lab 3"): checked as one phrase, not as a bare number. */
const LABEL = /\b([A-Z][A-Za-z]+)\s+(\d+[A-Za-z]?)\b/g;
/** A room or course code: letters then digits ("B10", "CS400"). Checked as one word, never read as a name. */
const CODE = /\b[A-Za-z]+\d+[A-Za-z]?\b/g;
/** Arithmetic written in a sentence: "7 × 25 = 175", "8 − 1 = 7", "3 x 24". */
const EXPR = /(\d+(?:\.\d+)?)\s*([×x*+−–/÷-])\s*(\d+(?:\.\d+)?)(?:\s*=\s*(\d+(?:\.\d+)?))?/g;
/** Constants a calculation may use besides quoted numbers: one, two, days a week, hours a day, minutes, percent. */
const OPERAND_CONSTANTS = ["1", "2", "7", "24", "60", "100"];
type Claims = { dates: string[]; weekdays: string[]; numbers: string[]; names: string[]; labels: string[]; codes: string[] };
/** The exact claims a text makes: month-day dates, weekdays, labels, codes, other numbers and capitalized names (not sentence-initial). */
function claims(text: string): Claims {
  const t = text.replace(/(\d),(?=\d{3}\b)/g, "$1");
  const dates = [
    ...[...t.matchAll(DATE_MD)].map((m) => `${month(m[1]!)} ${Number(m[2])}`),
    ...[...t.matchAll(DATE_DM)].map((m) => `${month(m[2]!)} ${Number(m[1])}`),
  ];
  const weekdays = [...t.matchAll(WEEKDAY)].map((m) => m[1]!.toLowerCase());
  // A date's day and a label's number are checked with their date or label, so they aren't bare numbers too.
  const undated = t.replace(DATE_MD, " ").replace(DATE_DM, " ");
  const labels: string[] = [];
  const unlabelled = undated.replace(LABEL, (all, word: string, n: string) => {
    if (MONTH_OR_DAY.test(word)) return all;
    labels.push(`${word.toLowerCase()} ${n.toLowerCase()}`);
    return " ";
  });
  const codes = [...unlabelled.matchAll(CODE)].map((m) => m[0].toLowerCase());
  const numbers = [...unlabelled.replace(CODE, " ").matchAll(/\d+(?:\.\d+)?/g)].map((m) => String(Number(m[0])));
  const names: string[] = [];
  let initial = true;
  // A label's word ("Homework" in "Homework 4") is checked with its label, not as a name.
  for (const token of unlabelled.split(/\s+/)) {
    const word = token.replace(/^[("'“‘[]+/, "").replace(/[^A-Za-z'’-]+$/, "");
    // A token with a digit is a code or a number ("B10"), never the name "B".
    if (!initial && !/\d/.test(token) && /^[A-Z][A-Za-z'’-]*$/.test(word) && !NOT_NAMES.has(word.toLowerCase()) && !MONTH_OR_DAY.test(word)) names.push(word.toLowerCase());
    if (word || token) initial = /[.!?:]["'”’)]*$/.test(token);
  }
  return { dates, weekdays, numbers, names, labels, codes };
}
const wordsOf = (text: string) => new Set(text.toLowerCase().split(/[^a-z0-9'’-]+/).filter(Boolean));
const phrase = (text: string) => ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
/** A word without a plural "s", so "Section 303" finds "sections". */
const stem = (w: string) => w.replace(/(?<=[a-z]{3})s$/, "");
/** Date arithmetic written in a sentence: "October 13 + 7 days". */
const DATE_PLUS = new RegExp(`\\b${MONTH}\\s+(\\d{1,2})\\s*([+−–-])\\s*(\\d+)\\s*days?\\b`, "gi");
const numberText = (x: number) => String(Number(x.toFixed(2)));
function calculate(a: number, op: string, b: number): number {
  if (op === "×" || op === "x" || op === "*") return a * b;
  if (op === "+") return a + b;
  if (op === "/" || op === "÷") return b ? a / b : Number.NaN;
  return a - b;
}
/** Days from one month-day date to another (either order), in a common and a leap year, counted both ways. */
function daySpans(dates: string[]): string[] {
  const at = (d: string, year: number) => {
    const [m, day] = d.split(" ");
    return Date.UTC(year, MONTHS.indexOf(m!), Number(day));
  };
  const spans = new Set<string>();
  for (const a of dates)
    for (const b of dates)
      for (const year of [2026, 2024]) {
        const days = Math.round((at(b, year) - at(a, year)) / 86_400_000);
        if (days > 0) for (const n of [days, days + 1]) spans.add(String(n));
      }
  return [...spans];
}
/**
 * True when the sentence says what its quotes say. A kind of detail the quotes state (a date, weekday,
 * name, label or code) must match them. A kind they don't state may come from the rest of the cited
 * passage. That covers a label ("Homework 4") or a heading date just outside the quoted words, and it
 * never lets a sentence contradict its quote. A number must be quoted, stated earlier in the same
 * answer, or be the result of arithmetic written in the sentence from such numbers, which code
 * re-does ("7 × 25 = 175"; the days between two dates the sentence names).
 */
export function claimsMatch(sentence: string, quotes: string, context: { passages?: string; known?: Iterable<string> } = {}): boolean {
  const said = claims(sentence), shown = claims(quotes), around = claims(context.passages ?? "");
  const quoteWords = wordsOf(quotes), passageWords = wordsOf(context.passages ?? "");
  const quotePhrase = phrase(quotes), passagePhrase = phrase(context.passages ?? "");
  const fits = (items: string[], stated: string[], inQuote: (x: string) => boolean, inPassage: (x: string) => boolean) =>
    items.every((x) => inQuote(x) || (!stated.length && inPassage(x)));
  const known = new Set([...shown.numbers, ...(context.known ?? [])]);
  if (!shown.numbers.length) for (const n of around.numbers) known.add(n);
  if (/\bdays?\b/i.test(sentence)) for (const n of daySpans(said.dates)) known.add(n);
  // A date worked out from a date the sentence may state ("October 13 + 7 days") is re-done by code.
  const stateable = (d: string) => shown.dates.includes(d) || (!shown.dates.length && around.dates.includes(d));
  const derivedDates: string[] = [];
  for (const m of sentence.matchAll(DATE_PLUS)) {
    if (!stateable(`${month(m[1]!)} ${Number(m[2])}`)) continue;
    const at = new Date(Date.UTC(2026, MONTHS.indexOf(month(m[1]!)), Number(m[2]) + (m[3] === "+" ? 1 : -1) * Number(m[4])));
    derivedDates.push(`${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}`);
    known.add(numberText(Number(m[4])));
  }
  // A label whose number is quoted may use the passage's word for it ("Section 303" for "303 meets" under "sections").
  const stems = new Set([...quoteWords, ...passageWords].map(stem));
  const labelled = (l: string) => {
    const [word, n] = l.split(" ");
    return shown.numbers.includes(n!) && stems.has(stem(word!));
  };
  // Re-do the sentence's arithmetic until nothing new is verified (one step may feed the next).
  const exprs = [...sentence.replace(/(\d),(?=\d{3}\b)/g, "$1").matchAll(EXPR)];
  for (let changed = true; changed; ) {
    changed = false;
    for (const [, a, op, b, stated] of exprs) {
      const operand = (x: string) => known.has(numberText(Number(x))) || OPERAND_CONSTANTS.includes(numberText(Number(x)));
      if (!operand(a!) || !operand(b!)) continue;
      const result = numberText(calculate(Number(a), op!, Number(b)));
      if (stated !== undefined && result !== numberText(Number(stated))) continue;
      for (const n of [a!, b!, result].map((x) => numberText(Number(x))))
        if (!known.has(n)) (known.add(n), (changed = true));
    }
  }
  return (
    fits(said.dates, shown.dates, (d) => shown.dates.includes(d) || derivedDates.includes(d), (d) => around.dates.includes(d)) &&
    fits(said.weekdays, shown.weekdays, (d) => shown.weekdays.includes(d), (d) => around.weekdays.includes(d)) &&
    fits(said.names, shown.names, (n) => quoteWords.has(n), (n) => passageWords.has(n)) &&
    fits(said.labels, shown.labels, (l) => quotePhrase.includes(` ${l} `) || labelled(l), (l) => passagePhrase.includes(` ${l} `)) &&
    fits(said.codes, shown.codes, (c) => quoteWords.has(c), (c) => passageWords.has(c)) &&
    said.numbers.every((n) => known.has(n))
  );
}

/**
 * Code checks every quote against its passage; a sentence with no checked quote is dropped, and a
 * sentence whose dates, numbers or names differ from its checked quotes is replaced by the quotes.
 */
export function checkAnswer(
  output: AskOutput,
  passages: Passage[],
  meta: Map<string, { resourceId: string; title: string; url: string }>,
  resourceText: (id: string) => string | null,
): Pick<AskResult, "text" | "citations" | "notFound" | "dropped"> {
  const bySource = new Map(passages.map((p) => [p.sourceId, p.text]));
  const citations: IntentCitation[] = [];
  const keyOf = new Map<string, number>();
  const sentences: string[] = [];
  const known = new Set<string>();
  let dropped = 0;
  for (const s of output.found ? output.sentences : []) {
    const marks: number[] = [];
    for (const c of s.citations) {
      const text = bySource.get(c.sourceId);
      const m = meta.get(c.sourceId);
      if (!text || !m || findQuote(text, c.quote).status === "missing") continue;
      const key = `${c.sourceId}\u0000${c.quote}`;
      let n = keyOf.get(key);
      if (n === undefined) {
        const full = resourceText(m.resourceId);
        const at = full ? findQuote(full, c.quote) : null;
        n = citations.length;
        keyOf.set(key, n);
        citations.push({
          sourceId: c.sourceId,
          resourceId: m.resourceId,
          title: m.title,
          url: m.url,
          quote: at?.status === "unique" && full ? full.slice(at.start, at.end) : c.quote.trim(),
          start: at?.status === "unique" ? at.start : null,
          end: at?.status === "unique" ? at.end : null,
        });
      }
      if (!marks.includes(n)) marks.push(n);
    }
    if (!marks.length) {
      dropped++;
      continue;
    }
    const tags = marks.map((n) => `[${n + 1}]`).join("");
    // The quote is real; the sentence must also say what it says (claimsMatch), or the sentence
    // gives way to the quotes. Numbers from sentences already accepted in this answer count as known.
    const cited = [...new Set(marks.map((n) => citations[n]!.sourceId))].map((id) => bySource.get(id) ?? "").join("\n");
    if (!claimsMatch(s.text, marks.map((n) => citations[n]!.quote).join("\n"), { passages: cited, known })) {
      dropped++;
      sentences.push(`${marks.map((n) => `“${citations[n]!.quote}”`).join(" ")} ${tags}`);
      continue;
    }
    for (const n of claims(s.text).numbers) known.add(n);
    sentences.push(`${s.text.trim()} ${tags}`);
  }
  if (!sentences.length) return { text: NOT_IN_MATERIALS, citations: [], notFound: true, dropped };
  return { text: sentences.join(" "), citations, notFound: false, dropped };
}
