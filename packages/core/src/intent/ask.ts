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
