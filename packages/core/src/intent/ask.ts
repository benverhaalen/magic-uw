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
import type { CoursePrefixSource } from "../course-facts/prefix"; // owner: course-facts
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
  resourceId?: string;
  /** owner: privacy. The router's protection; absent means none (a direct caller). */
  protection?: IntentProtection;
  /** owner: course-facts. The course prefix (brief + pack catalogue): used when the ask names one course. */
  coursePrefix?: CoursePrefixSource;
}

const zero = () => ({ in: 0, cached: 0, out: 0 });

export async function groundedAsk(deps: AskDeps, question: string, courses: ResolvedCourse[], signal: AbortSignal): Promise<AskResult> {
  const { store } = deps;
  const none = (text: string, extra: Partial<AskResult> = {}): AskResult => ({ text, citations: [], notFound: true, dropped: 0, path: "none", tokens: zero(), ...extra });
  if (!courses.length) return none(NOT_IN_MATERIALS);
  const found = store.searchPassages({ query: question, courses: courses.map((c) => ({ accountScope: c.accountScope, courseId: c.courseId })), k: 12 });
  // The coverage gate: nothing in the materials supports the question, so no model call.
  if (found.notFound || !found.hits.length) return none(NOT_IN_MATERIALS);
  const budget = deps.tokenBudget ?? ASK_TOKEN_BUDGET;
  const passages: Passage[] = [];
  const meta = new Map<string, { resourceId: string; title: string; url: string }>();
  let used = 0;
  for (const h of found.hits) {
    if (deps.resourceId && h.resourceId !== deps.resourceId) continue;
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
  }
  // end owner: course-facts
  // owner: privacy: the question is the student's; each passage is its resource's class.
  const p = deps.protection?.request("ask");
  const frozen = new Map(passages.map((x) => [x.sourceId, p ? p.frozen(x.text, passageClass(store.resource(meta.get(x.sourceId)!.resourceId))) : { text: x.text, spans: [] }]));
  const sent = passages.map((x) => ({ ...x, text: frozen.get(x.sourceId)!.text }));
  if (p) Object.assign(frame, { course: p.text(frame.course, "teaching"), skeleton: p.text(frame.skeleton, "teaching"), policy: p.text(frame.policy, "teaching"), ...(frame.brief !== undefined ? { brief: p.text(frame.brief, "teaching") } : {}) });
  const input = { question: p ? p.text(question.trim().slice(0, 2000), "personal") : question.trim().slice(0, 2000) };
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

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const DATE_MD = new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?!\\d)`, "gi");
const DATE_DM = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}(?![a-z])`, "gi");
const WEEKDAY = /\b(mon|tue|wed|thu|fri|sat|sun)(?:day|sday|nesday|rsday|urday)?s?\b/gi;
const MONTH_OR_DAY = new RegExp(`^(?:${MONTH}|(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?s?)$`, "i");
/** Capitalized words that are not names: titles and common words. */
const NOT_NAMES = new Set(["i", "prof", "professor", "dr", "mr", "ms", "mrs", "the", "a", "an", "it", "this", "that", "you", "your", "yes", "no", "note", "also"]);
const month = (m: string) => MONTHS.find((x) => m.toLowerCase().startsWith(x)) ?? m.toLowerCase();
/** The exact claims a text makes: month-day dates, weekdays, numbers and capitalized names (not sentence-initial). */
function claims(text: string): { dates: string[]; weekdays: string[]; numbers: string[]; names: string[] } {
  const t = text.replace(/(\d),(?=\d{3}\b)/g, "$1");
  const dates = [
    ...[...t.matchAll(DATE_MD)].map((m) => `${month(m[1]!)} ${Number(m[2])}`),
    ...[...t.matchAll(DATE_DM)].map((m) => `${month(m[2]!)} ${Number(m[1])}`),
  ];
  const weekdays = [...t.matchAll(WEEKDAY)].map((m) => m[1]!.toLowerCase());
  const numbers = [...t.matchAll(/\d+(?:\.\d+)?/g)].map((m) => String(Number(m[0])));
  const names: string[] = [];
  let initial = true;
  for (const token of t.split(/\s+/)) {
    const word = token.replace(/^[("'“‘[]+/, "").replace(/[^A-Za-z'’-]+$/, "");
    if (!initial && /^[A-Z][A-Za-z'’-]*$/.test(word) && !NOT_NAMES.has(word.toLowerCase()) && !MONTH_OR_DAY.test(word)) names.push(word.toLowerCase());
    if (word || token) initial = /[.!?:]["'”’)]*$/.test(token);
  }
  return { dates, weekdays, numbers, names };
}
/** True when every date, weekday, number and name the sentence states is in its quotes. */
export function claimsMatch(sentence: string, quotes: string): boolean {
  const said = claims(sentence), shown = claims(quotes);
  const words = new Set(quotes.toLowerCase().split(/[^a-z0-9'’-]+/).filter(Boolean));
  return (
    said.dates.every((d) => shown.dates.includes(d)) &&
    said.weekdays.every((d) => shown.weekdays.includes(d)) &&
    said.numbers.every((n) => shown.numbers.includes(n)) &&
    said.names.every((n) => words.has(n))
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
    // The quote is real; the sentence must also say what it says. Every date, number and name in
    // the sentence has to appear in its checked quotes, or the sentence gives way to the quotes.
    if (!claimsMatch(s.text, marks.map((n) => citations[n]!.quote).join("\n"))) {
      dropped++;
      sentences.push(`${marks.map((n) => `“${citations[n]!.quote}”`).join(" ")} ${tags}`);
      continue;
    }
    sentences.push(`${s.text.trim()} ${tags}`);
  }
  if (!sentences.length) return { text: NOT_IN_MATERIALS, citations: [], notFound: true, dropped };
  return { text: sentences.join(" "), citations, notFound: false, dropped };
}
