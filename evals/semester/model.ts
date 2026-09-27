/**
 * The per-semester projection for `pnpm semester`: the measured per-action rows (ours.ts,
 * typical.ts) times a usage mix, for low / mid / high use. Every number here is labelled in the
 * report as measured (from the harness), sourced, inferred or assumed; the assumptions are the
 * constants below, each with its reason. Nothing is fitted to a result.
 */
import type { OurRow, WarmTurn } from "./ours";
import type { TypicalRow } from "./typical";

export type Level = "low" | "mid" | "high";
export const LEVELS: Level[] = ["low", "mid", "high"];

// ── Assumptions (each stated in the report) ─────────────────────────────────────────────────────
export const ASSUME = {
  /** 15 weeks of instruction and finals. */
  semesterDays: 105,
  /** Sonnet 5 list price per million tokens (docs/plans/2026-09-26-course-backend/plan.md price table, OpenRouter 2026-09-26). */
  priceIn: 2,
  priceOut: 10,
  /** Anthropic's prompt-caching multipliers on the input price: 5-minute cache write 1.25×, read 0.1×. */
  cacheWrite: 1.25,
  cacheRead: 0.1,
  /** Anthropic's minimum cacheable prompt for Sonnet-class models; a shorter prompt is never cached. */
  minCacheable: 1024,
  /** Topics a student could quiz or make cards on: 4 courses × 12 topics. */
  topics: 48,
  /** Regenerations per generated topic from a changed lecture or syllabus (one in four). */
  regenPerTopic: 0.25,
  /** Share of explain/exam/mail uses that repeat a byte-identical earlier question (artifact cache hit). */
  identicalRepeatRate: 0,
  /** The baseline's retrieval switch: above this corpus size it sends a top-k budget instead of everything. */
  retrievalThresholdTokens: 50_000,
  retrievalTopKTokens: 4_000,
  /** The corpus size of the scale sensitivity (a 4-course semester's notes, slides and readings). */
  scaleCorpusTokens: 100_000,
};

/**
 * One LMS-visit budget per day, split across the four actions that all draw on the same Canvas
 * page-view proxy (rows 1, 2, 6, 9), so the same visits aren't counted three times. The budget is
 * inferred from ~10–20 page views per student per week (≈1.5–3 a day; high doubles it for a heavy
 * user); the split follows the mix's own relative mid rates (1 : 1 : 3 : 0.3).
 */
export const LMS_BUDGET: Record<Level, number> = { low: 1.5, mid: 3, high: 6 };
const LMS_SPLIT: Record<number, number> = { 1: 1, 2: 1, 6: 3, 9: 0.3 };
const LMS_TOTAL = Object.values(LMS_SPLIT).reduce((s, x) => s + x, 0);

export interface MixRow { id: number; action: string; perDay: Record<Level, number>; label: "inferred" | "assumed" | "sourced"; basis: string }
export function usageMix(): MixRow[] {
  const lms = (id: number): Record<Level, number> => ({
    low: (LMS_BUDGET.low * LMS_SPLIT[id]!) / LMS_TOTAL,
    mid: (LMS_BUDGET.mid * LMS_SPLIT[id]!) / LMS_TOTAL,
    high: (LMS_BUDGET.high * LMS_SPLIT[id]!) / LMS_TOTAL,
  });
  const lmsBasis = "Share of one LMS-visit budget (1.5 / 3 / 6 a day, inferred from Canvas page-view analytics, danaleeling.blogspot.com 2022–2023), split 1 : 1 : 3 : 0.3 across rows 1, 2, 6, 9.";
  return [
    { id: 1, action: "What's due this week", perDay: lms(1), label: "inferred", basis: lmsBasis },
    { id: 2, action: "What changed since yesterday", perDay: lms(2), label: "inferred", basis: lmsBasis },
    { id: 3, action: "Explain <topic> from lecture", perDay: { low: 0, mid: 1, high: 3 }, label: "inferred", basis: "Guelph survey (ERIC EJ1498721): 65.9% of AI-using students use AI for schoolwork at least a few times a week; 'explain concepts' is the top task. The per-day count is inferred from those weekly rates." },
    { id: 4, action: "Quiz me on <topic> (5 questions)", perDay: { low: 0, mid: 0.3, high: 1 }, label: "inferred", basis: "Guelph survey: 38.1% use AI for quizzes/tests; no per-day frequency is reported, so the daily rate is inferred." },
    { id: 5, action: "20-card flashcard review", perDay: { low: 0, mid: 0.5, high: 2 }, label: "inferred", basis: "Anki usage reports of roughly 12–60 cards a day, divided by a 20-card session; inferred." },
    { id: 6, action: "Find the slides/file for <topic>", perDay: lms(6), label: "inferred", basis: lmsBasis },
    { id: 7, action: "When/where is the exam, what's on it", perDay: { low: 0.1, mid: 0.3, high: 1 }, label: "inferred", basis: "Exam-period clustered; Canvas page-view spikes before midterms (danaleeling.blogspot.com 2022); inferred." },
    { id: 8, action: "What do I need on the final for a B", perDay: { low: 0.02, mid: 0.1, high: 0.3 }, label: "assumed", basis: "The mix supplied for this run was cut off at this row; a low-frequency grade-calculator rate is assumed." },
    { id: 9, action: "Summarize the new announcement", perDay: lms(9), label: "inferred", basis: lmsBasis },
    { id: 10, action: "Open the email from my TA about <x>", perDay: { low: 0.1, mid: 0.3, high: 1 }, label: "assumed", basis: "The mix supplied for this run was cut off before this row; an occasional mail lookup is assumed." },
  ];
}

// ── Pricing ─────────────────────────────────────────────────────────────────────────────────────
/** Tokens by how they bill. `fresh` input, cache `write`, cache `read`, and `out`put. */
export interface Bill { fresh: number; write: number; read: number; out: number }
const zero = (): Bill => ({ fresh: 0, write: 0, read: 0, out: 0 });
const add = (a: Bill, b: Bill, k = 1): Bill => ({ fresh: a.fresh + k * b.fresh, write: a.write + k * b.write, read: a.read + k * b.read, out: a.out + k * b.out });
export const usd = (b: Bill) => ((b.fresh + b.write * ASSUME.cacheWrite + b.read * ASSUME.cacheRead) * ASSUME.priceIn + b.out * ASSUME.priceOut) / 1e6;
export const tokensOf = (b: Bill) => b.fresh + b.write + b.read + b.out;

/**
 * One call under automatic prompt caching (what Claude Code does, and the cached baseline):
 * a prompt under the minimum is never cached; otherwise a call with an earlier same-prefix call in
 * the cache window reads the prefix (if the prefix alone meets the minimum) and writes the rest,
 * and any other call writes its whole prompt.
 */
function cachedCall(prefix: number, variable: number, out: number, prior: boolean): Bill {
  const total = prefix + variable;
  if (total < ASSUME.minCacheable) return { fresh: total, write: 0, read: 0, out };
  if (prior && prefix >= ASSUME.minCacheable) return { fresh: 0, write: variable, read: prefix, out };
  return { fresh: 0, write: total, read: 0, out };
}
/**
 * `u` calls a day sharing one prefix, all inside one cache window (the favourable bound: the real
 * 5-minute window is shorter, so this overstates caching for whichever side benefits).
 */
function cachedDay(u: number, prefix: number, variable: number, out: number): Bill {
  const first = Math.min(u, 1);
  const later = Math.max(u - 1, 0);
  return add(add(zero(), cachedCall(prefix, variable, out, false), first), cachedCall(prefix, variable, out, true), later);
}
const freshCall = (input: number, out: number): Bill => ({ fresh: input, write: 0, read: 0, out });

// ── Systems ─────────────────────────────────────────────────────────────────────────────────────
export type SystemId = "ours-oneshot" | "ours-warm-spread" | "ours-warm-burst" | "typical-whole" | "typical-cached" | "typical-retrieval";
export const SYSTEMS: { id: SystemId; label: string; what: string }[] = [
  { id: "ours-oneshot", label: "Ours, one-shot runner", what: "Every model call a fresh CLI with the pack's own prefix (claudeOneShotArgs); prompt caching as the CLI applies it." },
  { id: "ours-warm-spread", label: "Ours, warm pool (asks spread out)", what: "The command bar's warm session pool (worker.ts) with its union-schema prefix; each ask more than 10 minutes after the last, so the pool's idle close gives it a fresh session (no history)." },
  { id: "ours-warm-burst", label: "Ours, warm pool (a day's asks in one burst)", what: "The same pool with every one of a day's asks for one course inside the idle window: each turn re-sends the session's history (cached reads where the CLI can)." },
  { id: "typical-whole", label: "Typical, whole context, no caching", what: "Every question sends every source at the full input price. An upper bound; no current product is known to bill this way at scale." },
  { id: "typical-cached", label: "Typical, whole context + prompt caching", what: "The sources as a byte-stable prefix: the day's first call writes the cache, later calls read it at 0.1×, all inside one window (favourable to the baseline)." },
  { id: "typical-retrieval", label: "Typical, retrieval + prompt caching", what: `Above ${ASSUME.retrievalThresholdTokens.toLocaleString("en-US")} corpus tokens, a top-k budget of ${ASSUME.retrievalTopKTokens.toLocaleString("en-US")} tokens replaces the whole corpus; below it, the same as the cached variant.` },
];

export interface ProjectionInput {
  ours: OurRow[];
  typical: TypicalRow[];
  burst: WarmTurn[];
  /** Override the baseline's corpus prefix size (tokens) for the scale sensitivity. */
  corpusTokens?: number;
}
export interface SystemTotal {
  system: SystemId;
  bill: Bill;
  tokens: number;
  usd: number;
  uses: number;
  zeroTokenUses: number;
  zeroTokenShare: number;
  /** Median over uses of per-action latency, when it is determined by measured code paths; else null. */
  medianLatencyMs: number | null;
  medianNote: string;
  /** Per action: uses and bill. */
  perAction: { id: number; uses: number; calls: number; bill: Bill }[];
}

const GENERATION = [4, 5];
const BAR_MODEL = [3, 7, 8, 10];

/** Generation calls per semester for a quiz or card action with `uses` uses: one per topic studied, plus regenerations. */
export function generations(uses: number): { first: number; regen: number } {
  const first = Math.min(uses, ASSUME.topics);
  return { first, regen: first * ASSUME.regenPerTopic };
}

/** Per-day cost of a burst of `u` asks in one session, from the measured turns (extended by their mean). */
function burstDay(u: number, turns: WarmTurn[]): Bill {
  if (!turns.length || u <= 0) return zero();
  const meanIn = turns.reduce((s, t) => s + t.inputTokens, 0) / turns.length;
  const meanOut = turns.reduce((s, t) => s + t.outputTokens, 0) / turns.length;
  const prefix = turns[0]!.prefixTokens;
  const run = (n: number): Bill => {
    let bill = zero();
    let history = 0;
    let written = false;
    for (let k = 0; k < n; k++) {
      const m = turns[k]?.inputTokens ?? meanIn;
      const o = turns[k]?.outputTokens ?? meanOut;
      const cachedPart = prefix + history;
      const total = cachedPart + m;
      // The previous turn's prompt and reply are the cached part, if that turn was written.
      const call: Bill = total < ASSUME.minCacheable ? { fresh: total, write: 0, read: 0, out: o } : written && cachedPart >= ASSUME.minCacheable ? { fresh: 0, write: m, read: cachedPart, out: o } : { fresh: 0, write: total, read: 0, out: o };
      written = total >= ASSUME.minCacheable;
      bill = add(bill, call);
      history += m + o;
    }
    return bill;
  };
  const lo = Math.floor(u);
  const frac = u - lo;
  return add(add(zero(), run(lo), 1 - frac), run(lo + 1), frac);
}

export function project(level: Level, system: SystemId, input: ProjectionInput, include: (id: number) => boolean): SystemTotal {
  const mix = usageMix().filter((m) => include(m.id));
  const days = ASSUME.semesterDays;
  const ours = (id: number) => input.ours.find((r) => r.id === id)!;
  const typ = (id: number) => input.typical.find((r) => r.id === id)!;
  const perAction: SystemTotal["perAction"] = [];
  let zeroUses = 0;
  let uses = 0;
  const isOurs = system.startsWith("ours");
  // Baseline prefix and per-call variable part under each variant.
  const corpus = input.corpusTokens ?? input.typical[0]!.prefixTokens;
  const instruction = 60; // the study-assistant instruction alone (typical.ts typicalSystem), ≈ 240 characters
  const retrieval = system === "typical-retrieval" && corpus > ASSUME.retrievalThresholdTokens;
  const tPrefix = retrieval ? instruction : corpus;
  const tVar = (id: number) => typ(id).questionTokens + (retrieval ? ASSUME.retrievalTopKTokens : 0);
  // The baseline's calls a day all share its one prefix; count them to place each in the window.
  const typicalCallsPerDay = mix.reduce((s, m) => s + (GENERATION.includes(m.id) ? 0 : m.perDay[level]), 0);

  for (const m of mix) {
    const u = m.perDay[level] * days;
    uses += u;
    let bill = zero();
    let calls = 0;
    if (GENERATION.includes(m.id)) {
      const g = generations(u);
      const n = g.first + g.regen;
      calls = n;
      zeroUses += Math.max(u - g.first, 0);
      if (isOurs) {
        const r = ours(m.id);
        bill = add(bill, cachedCall(r.prefixTokens, r.inputTokens, r.outputTokens, false), n);
      } else {
        const out = typ(m.id).outputTokensEstimate;
        // A generation reads the day's cached sources when the student asked anything else that day (favourable to the baseline).
        bill = system === "typical-whole" ? add(bill, freshCall(corpus + typ(m.id).questionTokens, out), n) : add(bill, cachedCall(tPrefix, tVar(m.id), out, typicalCallsPerDay >= 1), n);
      }
    } else if (isOurs) {
      const r = ours(m.id);
      const repeatFree = BAR_MODEL.includes(m.id) ? ASSUME.identicalRepeatRate : 0;
      const modelUses = r.calls ? u * (1 - repeatFree) : 0;
      zeroUses += u - modelUses;
      calls = modelUses * Math.max(r.calls, 0);
      const perDay = modelUses / days;
      if (!modelUses) bill = zero();
      else if (system === "ours-oneshot" || !r.pooled) bill = add(bill, cachedDay(perDay, r.prefixTokens, r.inputTokens, r.outputTokens), days);
      else if (system === "ours-warm-spread" || m.id === 10) bill = add(bill, cachedDay(perDay, r.pooled.prefixTokens, r.pooled.inputTokens, r.outputTokens), days);
      else bill = zero(); // the burst's asks are priced together below
    } else {
      calls = u;
      const out = typ(m.id).outputTokensEstimate;
      if (system === "typical-whole") bill = add(bill, freshCall(corpus + typ(m.id).questionTokens, out), u);
      else {
        // Place this action's calls among the day's baseline calls: the first of the day writes, the rest read.
        const share = typicalCallsPerDay ? m.perDay[level] / typicalCallsPerDay : 0;
        const day = cachedDay(typicalCallsPerDay, tPrefix, tVar(m.id), out);
        bill = add(bill, day, days * share);
      }
    }
    perAction.push({ id: m.id, uses: u, calls, bill });
  }
  if (system === "ours-warm-burst") {
    // One course lane's asks (rows 3, 7, 8) in one burst a day; row 10 (classify) has its own lane, priced above.
    const askIds = [3, 7, 8].filter((id) => mix.some((m) => m.id === id) && ours(id).calls);
    const perDay = askIds.reduce((s, id) => s + mix.find((m) => m.id === id)!.perDay[level] * (1 - ASSUME.identicalRepeatRate), 0);
    const day = burstDay(perDay, input.burst);
    for (const id of askIds) {
      const a = perAction.find((p) => p.id === id)!;
      const share = perDay ? (mix.find((m) => m.id === id)!.perDay[level] * (1 - ASSUME.identicalRepeatRate)) / perDay : 0;
      a.bill = add(zero(), day, days * share);
    }
  }
  const bill = perAction.reduce((s, a) => add(s, a.bill), zero());
  const median = medianLatency(level, system, input, include);
  return {
    system, bill, tokens: Math.round(tokensOf(bill)), usd: usd(bill), uses, zeroTokenUses: zeroUses, zeroTokenShare: uses ? zeroUses / uses : 0,
    medianLatencyMs: median.ms, medianNote: median.note, perAction,
  };
}

/**
 * The median latency per use. Model-path latency isn't measured (the fake CLI plays the model and
 * the live baseline was not run), so model uses are ranked above every code path: if code-path and
 * saved-quiz/deck uses are more than half, the median is a measured code-path time; otherwise it
 * is a model call and unmeasured.
 */
function medianLatency(level: Level, system: SystemId, input: ProjectionInput, include: (id: number) => boolean): { ms: number | null; note: string } {
  const mix = usageMix().filter((m) => include(m.id));
  const points: { ms: number; weight: number }[] = [];
  let modelWeight = 0;
  for (const m of mix) {
    const u = m.perDay[level] * ASSUME.semesterDays;
    if (!u) continue;
    const r = input.ours.find((x) => x.id === m.id)!;
    if (GENERATION.includes(m.id)) {
      const g = generations(u).first;
      modelWeight += g;
      // A saved quiz or deck is served by code on both sides; our time is measured (the bar starting it), the baseline's isn't.
      points.push({ ms: system.startsWith("ours") ? r.warmMedianMs : Number.NaN, weight: u - g });
    } else if (system.startsWith("ours") && !r.calls) points.push({ ms: r.warmMedianMs, weight: u });
    else modelWeight += u;
  }
  const total = points.reduce((s, p) => s + p.weight, 0) + modelWeight;
  const sorted = points.filter((p) => p.weight > 0).sort((a, b) => a.ms - b.ms);
  if (sorted.some((p) => Number.isNaN(p.ms))) return { ms: null, note: "not measured (the baseline's saved-item and model latencies were not run live)" };
  let acc = 0;
  for (const p of sorted) {
    acc += p.weight;
    if (acc >= total / 2) return { ms: p.ms, note: "measured code path (median use is answered without a model)" };
  }
  return { ms: null, note: "a model call (model-path latency not measured)" };
}
