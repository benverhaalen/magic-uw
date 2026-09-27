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
import { BRIEF_POLICY_POINTER, briefHoldsPolicy } from "../course-facts/brief"; // owner: course-facts
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
  /** owner: privacy. The router's protection; absent means none (a direct caller). */
  protection?: IntentProtection;
  /** owner: course-facts. The course prefix (brief + pack catalogue): used when the ask names one course. */
  coursePrefix?: CoursePrefixSource;
  /** The student's time zone, for the dates in assessment facts. */
  timeZone?: string;
}

const zero = () => ({ in: 0, cached: 0, out: 0 });

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
  const found = store.searchPassages({ query, courses: courses.map((c) => ({ accountScope: c.accountScope, courseId: c.courseId })), k: 12 });
  // A one-course exam question also reads what code holds about that course's exams.
  const facts = courses.length === 1 ? assessmentFacts(store, courses[0]!, question, deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone) : { facts: [], pids: [] };
  // The coverage gate: nothing in the materials or the exam facts supports the question, so no model call.
  const searched = found.notFound ? [] : found.hits;
  if (!searched.length && !facts.facts.length && !facts.pids.length) return none(NOT_IN_MATERIALS);
  const budget = deps.tokenBudget ?? ASK_TOKEN_BUDGET;
  const passages: Passage[] = [];
  const meta = new Map<string, { resourceId: string; title: string; url: string }>();
  let used = 0;
  for (const f of facts.facts) {
    passages.push({ sourceId: f.sourceId, text: f.text });
    meta.set(f.sourceId, { resourceId: f.resourceId, title: f.title, url: f.url });
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
    if (passages.length >= ASK_MAX_PASSAGES) break;
    const p = store.passage(h.pid);
    if (!p || p.passage.redacted || !p.text.trim()) continue;
    if (used + p.passage.tokEst > budget && passages.length) continue;
    used += p.passage.tokEst;
    const sourceId = `p${h.pid}`;
    passages.push({ sourceId, text: p.text });
    meta.set(sourceId, { resourceId: h.resourceId, title: h.title, url: h.url });
  }
  if (!passages.length) return none(NOT_IN_MATERIALS);
  const runner = await deps.runner();
  if (!runner)
    return none("", { notFound: false, unavailable: "Answering needs your AI: choose Claude or Codex in Settings and sign in. Search still works without it." });

  const resources = [...new Set([...meta.values()].map((m) => m.resourceId))].flatMap((id) => {
    const r = store.resource(id);
    return r ? [r] : [];
  });
  // owner: course-facts. One course: the shared course prefix opens the prompt, as for packs and guides;
  // the brief's sources are sent too, so their categories are checked and receipted.
  const prefix = courses.length === 1 ? deps.coursePrefix?.(courses[0]!.ref) : undefined;
  const briefResources = (prefix?.resourceIds ?? []).flatMap((id) => store.resource(id) ?? []);
  const categories = [...new Set([...resources, ...briefResources].flatMap((r) => contentCategories(r)))].sort();
  const pack = { ...askPack, categories };
  const label = courses.length === 1 ? (courses[0]!.code ?? courses[0]!.name) : "Your courses";
  const policy = resources.find((r) => r.policy.mode !== "unknown")?.policy;
  const frame: CourseFrame = {
    courseId: courses.length === 1 ? courses[0]!.ref : "all",
    course: label,
    skeleton: courses.map((c) => `Course: ${c.code ? `${c.code}: ` : ""}${c.name}`).join("\n"),
    policy: policy ? `${policy.mode}: ${policy.evidence}` : "",
  };
  // owner: course-facts
  if (prefix) {
    frame.brief = prefix.text;
    if (policy && briefHoldsPolicy(policy.evidence, prefix.text)) frame.policy = `${policy.mode}: ${BRIEF_POLICY_POINTER}`;
  } else {
    // No brief (several courses, or a course with no syllabus found): the pack catalogue alone is
    // the system prompt. It holds this pack's instructions, is the same bytes for every course, and
    // with the pool's protocol and schema passes the prompt-cache minimum (pool.ts promptCacheMinimum).
    frame.brief = coursePackCatalogue();
  }
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
  const result = await runPack(
    { runner, artifacts: deps.artifacts, ledger: deps.ledger, authorize, now: () => deps.now().getTime() },
    pack,
    frame,
    input,
    sent, // owner: privacy
    { lane: "interactive", scope: courses.length === 1 ? "course" : "all", signal },
  );
  if (result.status === "blocked") return none("", { notFound: false, unavailable: result.reason });
  if (result.status === "needs_student") return none("", { notFound: false, unavailable: "The answer didn't pass the app's checks. Try asking more specifically." });
  if (result.status !== "done") return none("", { notFound: false, unavailable: result.message });
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
  return { ...checkAnswer(output, passages, meta, (id) => store.resource(id)?.text ?? null), path, tokens };
}

/** Code checks every quote against its passage; a sentence with no checked quote is dropped. */
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
    sentences.push(`${s.text.trim()} ${marks.map((n) => `[${n + 1}]`).join("")}`);
  }
  if (!sentences.length) return { text: NOT_IN_MATERIALS, citations: [], notFound: true, dropped };
  return { text: sentences.join(" "), citations, notFound: false, dropped };
}
