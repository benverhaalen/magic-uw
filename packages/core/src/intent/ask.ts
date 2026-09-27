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
import type { AskResult, IntentStore, ResolvedCourse } from "./types";

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
  const categories = [...new Set(resources.flatMap((r) => contentCategories(r)))].sort();
  const pack = { ...askPack, categories };
  const label = courses.length === 1 ? (courses[0]!.code ?? courses[0]!.name) : "Your courses";
  const policy = resources.find((r) => r.policy.mode !== "unknown")?.policy;
  const frame: CourseFrame = {
    courseId: courses.length === 1 ? courses[0]!.ref : "all",
    course: label,
    skeleton: courses.map((c) => `Course: ${c.code ? `${c.code}: ` : ""}${c.name}`).join("\n"),
    policy: policy ? `${policy.mode}: ${policy.evidence}` : "",
  };
  const input = { question: question.trim().slice(0, 2000) };
  const prompt = buildPrompt(pack, frame, input, passages);
  const receiptIds: string[] = [];
  const authorize = authorizer(
    store,
    {
      purpose: "Answer a question from course materials",
      course: label,
      title: "ask",
      text: prompt.input,
      policy: frame.policy,
      resourceIds: resources.map((r) => r.id),
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
    passages,
    { lane: "interactive", scope: courses.length === 1 ? "course" : "all", signal },
  );
  if (result.status === "blocked") return none("", { notFound: false, unavailable: result.reason });
  if (result.status === "needs_student") return none("", { notFound: false, unavailable: "The answer didn't pass the app's checks. Try asking more specifically." });
  if (result.status !== "done") return none("", { notFound: false, unavailable: result.message });
  const tokens = result.cached ? zero() : result.artifact.usage;
  const path = result.cached ? "cache" : "ai";
  return { ...checkAnswer(result.artifact.output, passages, meta, (id) => store.resource(id)?.text ?? null), path, tokens };
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
