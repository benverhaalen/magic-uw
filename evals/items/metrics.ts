/**
 * Code metrics over a harness run, each defined in thresholds.json before any run was scored.
 * Every rate carries n and a Wilson 95% interval. Model-quality rates count only items the
 * model (or offline model) wrote; planted defects count only toward the catch rate.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { flawProblems, nearDuplicateOf, normaliseText, trigramJaccard, NEAR_DUPLICATE } from "../../packages/learning/src/flaws";
import { CLOZE_BLANK } from "../../packages/packs/cards/src/index";
import type { Defect } from "./planted";
import type { HarnessResult, ItemRecord, UnitRecord } from "./harness";
import { rate, type Rate } from "./stats";

export interface Threshold {
  min?: number;
  max?: number;
  population: string;
  definition: string;
}
export interface Thresholds {
  registered: string;
  decision: string;
  metrics: Record<string, Threshold>;
  subjectRules: Record<string, string>;
}
export const THRESHOLDS_PATH = join(import.meta.dirname, "thresholds.json");
export function loadThresholds(): Thresholds {
  return JSON.parse(readFileSync(THRESHOLDS_PATH, "utf8")) as Thresholds;
}

export type Verdict = "met" | "met, not established at 95%" | "missed" | "not measured";
export interface MetricRow {
  id: string;
  rate: Rate;
  threshold: Threshold | null;
  verdict: Verdict;
  note?: string;
}

export function verdictOf(r: Rate, t: Threshold | null): Verdict {
  if (!t || r.rate === null || !r.ci) return "not measured";
  if (t.min !== undefined) {
    if (r.rate < t.min) return "missed";
    return r.ci[0] < t.min ? "met, not established at 95%" : "met";
  }
  if (t.max !== undefined) {
    if (r.rate > t.max) return "missed";
    return r.ci[1] > t.max ? "met, not established at 95%" : "met";
  }
  return "not measured";
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
const wholeWord = (text: string, word: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "iu").test(text);
const QUANT = new Set(["math", "physical_science", "engineering"]);
const WORDY = new Set(["humanities", "social_science", "arts"]);

export interface SubjectFit {
  course: string;
  family: string;
  pass: boolean;
  checks: { rule: string; pass: boolean; detail: string }[];
}

/** Pre-registered per-family item-type rules (thresholds.json `subjectRules`), over one course's whole-course scope. */
export function subjectFit(course: string, family: string, items: ItemRecord[]): SubjectFit | null {
  const own = items.filter((i) => i.course === course && i.scope === "course" && !i.planted);
  const accepted = own.filter((i) => i.stored);
  const cards = accepted.filter((i) => i.pack === "cards");
  const quiz = accepted.filter((i) => i.pack === "quiz");
  const allCards = [...cards.map((i) => i.stored!), ...cards.flatMap((i) => i.derived)];
  const has = (kind: string, list = allCards) => list.some((s) => s.item.kind === kind);
  const checks: SubjectFit["checks"] = [];
  const check = (rule: string, pass: boolean, detail: string) => checks.push({ rule, pass, detail });
  if (family === "languages") {
    const pairs = allCards.filter((a) => a.item.kind === "card" && allCards.some((b) => b !== a && b.item.kind === "card" && normaliseText(b.item.stem) === normaliseText(String(a.item.key)) && normaliseText(String(b.item.key)) === normaliseText(a.item.stem)));
    check("vocabulary cards in both directions", pairs.length >= 2, `${pairs.length / 2} reverse pairs`);
    check("cloze cards present", has("cloze"), `${allCards.filter((s) => s.item.kind === "cloze").length} cloze`);
    const numeric = quiz.filter((i) => i.stored!.item.kind === "numeric").length;
    check("no numeric quiz items", numeric === 0, `${numeric} numeric`);
  } else if (QUANT.has(family)) {
    const numeric = quiz.filter((i) => i.stored!.item.kind === "numeric");
    check("numeric share of quiz items >= 0.25", quiz.length > 0 && numeric.length / quiz.length >= 0.25, `${numeric.length}/${quiz.length}`);
    const executed = numeric.filter((i) => i.stored!.checks.some((c) => c.check === "executed" && c.outcome === "pass")).length;
    check("at least one numeric item recomputed by code", executed >= 1, `${executed} executed`);
    const wrote = own.filter((i) => i.draft.kind === "numeric");
    const kept = wrote.filter((i) => i.stored).length;
    check("numeric items kept >= 0.9", wrote.length > 0 && kept / wrote.length >= 0.9, `${kept}/${wrote.length}`);
  } else if (family === "computing") {
    check("term cards present", has("card"), "");
    check("cloze cards present", has("cloze"), "");
    check("multiple-choice items present", quiz.some((i) => i.stored!.item.kind === "mc"), "");
  } else if (WORDY.has(family)) {
    check("term cards present", has("card"), "");
    check("cloze cards present", has("cloze"), "");
    const numeric = quiz.filter((i) => i.stored!.item.kind === "numeric");
    const ok = numeric.filter((i) => {
      const k = Number(i.stored!.item.key);
      return (Number.isInteger(k) && k >= 1000 && k <= 2100) || i.stored!.checks.some((c) => c.check === "executed" && c.outcome === "pass");
    });
    check("numeric items are years or recomputed figures", ok.length === numeric.length, `${ok.length}/${numeric.length}`);
  } else return null;
  return { course, family, pass: checks.every((c) => c.pass), checks };
}

export interface Report {
  rows: MetricRow[];
  subjectFit: SubjectFit[];
  planted: { id: string; requiresJudge: boolean; expectedStage: string | null; n: number; caught: number; atExpectedStage: number }[];
  falseDrops: { course: string; pack: string; stage: string; reason: string; stem: string }[];
  diagnostics: Record<string, unknown>;
  perCourse: { course: string; family: string; tier: string; generated: number; accepted: number; dropped: Record<string, number> }[];
  failures: { unit: string; status: string; message: string }[];
}

/** Whether a planted defect's effect reached the stored item. */
function caught(i: ItemRecord, d: Defect | undefined): boolean {
  // A defect only a judge can see counts as caught only when the judge's stage dropped it.
  if (d?.requiresJudge) return i.dropped?.stage === d.expectedStage;
  if (!i.stored) return true;
  if (d?.caughtWhen === "not_revealed") {
    const s = i.stored.item;
    return s.kind !== "cloze" || !wholeWord(s.stem, String(s.key));
  }
  return false;
}

export function score(run: HarnessResult, defects: Defect[], mode: "offline" | "live", thresholds = loadThresholds()): Report {
  const t = (id: string) => thresholds.metrics[id] ?? null;
  const rows: MetricRow[] = [];
  const push = (id: string, r: Rate, note?: string) => rows.push({ id, rate: r, threshold: t(id), verdict: verdictOf(r, t(id)), ...(note ? { note } : {}) });
  const model = run.items.filter((i) => !i.planted);

  // Parse: model responses that parse against the pack schema (planted unparseable excluded).
  const calls = run.calls.filter((c) => !c.planted);
  push("parse", rate(calls.filter((c) => c.parsed).length, calls.length));

  // Verbatim quotes of stored items, against the stored resource text.
  const texts = new Map(run.units.flatMap((u) => u.scopeResources.map((r) => [r.id, r.text] as const)));
  const sources = run.items.flatMap((i) => (i.stored ? [i.stored, ...i.derived] : [])).flatMap((s) => s.sources);
  push("verbatimQuote", rate(sources.filter((s) => texts.get(s.resourceId)?.slice(s.start, s.end) === s.quote).length, sources.length));

  // The model's own quotes, verbatim in a passage it was sent.
  const sentByUnit = new Map(run.units.map((u) => [`${u.course}|${u.scope}|${u.pack}`, new Map(u.sent.map((p) => [p.sourceId, collapse(p.text)]))]));
  const fidelity = model.filter((i) => {
    const text = sentByUnit.get(`${i.course}|${i.scope}|${i.pack}`)?.get(i.draft.sourceId);
    return text !== undefined && i.draft.quote.trim().length > 0 && text.includes(collapse(i.draft.quote));
  });
  push("modelQuoteFidelity", rate(fidelity.length, model.length));

  // Exactly one key on choice items the model wrote.
  const choice = model.filter((i) => i.draft.kind === "mc" || i.draft.kind === "tf");
  push("singleKey", rate(choice.filter((i) => typeof i.draft.key === "string" && i.draft.key !== "" && !/marked correct|statementIsTrue/.test(i.draft.problem ?? "")).length, choice.length));

  // Cue flaws (flaws.ts, the pipeline's own stage 4 rules) on well-formed items the model wrote.
  const formed = model.filter((i) => !i.draft.problem);
  const flawed = formed.filter((i) => flawProblems({ kind: i.draft.kind === "card" ? "card" : i.draft.kind, stem: i.draft.stem, options: i.draft.options, key: i.draft.key }).length);
  push("flawRate", rate(flawed.length, formed.length));

  // Planted defects: caught when dropped (or, for a leak, when the stored item hides the answer).
  const byId = new Map(defects.map((d) => [d.id, d]));
  const planted = run.items.filter((i) => i.planted);
  const codeCatchable = planted.filter((i) => !byId.get(i.planted!)?.requiresJudge);
  const unparseable = run.calls.filter((c) => c.planted === "unparseable");
  // Caught: a later attempt of the same unit parsed and the pack command completed.
  const unitOf = (c: { course: string; scope: string; pack: string }) => run.units.find((u) => u.course === c.course && u.scope === c.scope && u.pack === c.pack);
  const unparseableCaught = unparseable.filter(
    (c) => unitOf(c)?.result.status === "done" && run.calls.some((x) => x.course === c.course && x.scope === c.scope && x.pack === c.pack && x.attempt > c.attempt && x.parsed),
  );
  push(
    "plantedCatch",
    rate(codeCatchable.filter((i) => caught(i, byId.get(i.planted!))).length + unparseableCaught.length, codeCatchable.length + unparseable.length),
    mode === "live" ? "live runs plant nothing; measured offline (the checks are code and don't depend on the writer)" : undefined,
  );
  const plantedTable = [...new Set(planted.map((i) => i.planted!))].sort().map((id) => {
    const rows = planted.filter((i) => i.planted === id);
    const d = byId.get(id);
    return {
      id,
      requiresJudge: d?.requiresJudge ?? false,
      expectedStage: d?.expectedStage ?? null,
      n: rows.length,
      caught: rows.filter((i) => caught(i, d)).length,
      atExpectedStage: rows.filter((i) => i.dropped?.stage === d?.expectedStage).length,
    };
  });
  if (unparseable.length)
    plantedTable.push({ id: "call-unparseable-response", requiresJudge: false, expectedStage: "runner retry", n: unparseable.length, caught: unparseableCaught.length, atExpectedStage: unparseableCaught.length });

  // False drops: offline only (only there is every non-planted item known to be clean).
  const clean = model.filter((i) => i.dropped?.stage !== "near_duplicate" && i.dropped?.stage !== "flaws");
  const falseDropped = clean.filter((i) => i.dropped);
  push("falseDrop", mode === "offline" ? rate(falseDropped.length, clean.length) : rate(0, 0), mode === "live" ? "needs labels; offline only" : undefined);

  // Duplicates: model items dropped as near-duplicates, plus stored pairs that are near-duplicates.
  let dup = model.filter((i) => i.dropped?.stage === "near_duplicate").length;
  const byCourseScope = new Map<string, ItemRecord[]>();
  for (const i of model.filter((x) => x.stored)) byCourseScope.set(`${i.course}|${i.scope}`, [...(byCourseScope.get(`${i.course}|${i.scope}`) ?? []), i]);
  for (const list of byCourseScope.values()) {
    const seen: string[] = [];
    for (const i of list) {
      if (nearDuplicateOf(i.stored!.item.stem, seen)) dup++;
      seen.push(i.stored!.item.stem);
    }
  }
  push("duplicate", rate(dup, model.length));

  // A repeat request with unchanged content: a cache hit, 0 tokens, no model call.
  const done = run.units.filter((u) => u.result.status === "done");
  push("repeatZeroTokens", rate(done.filter((u) => u.repeat.cached && u.repeat.tokens === 0 && u.repeat.backendCalls === 0).length, done.length));

  // Subject-appropriate item types per family (whole-course scope).
  const scored = (u: UnitRecord) => u.scopeKind === "course" && (mode === "live" || u.tier === "synthetic");
  const fits = [...new Map(run.units.filter(scored).map((u) => [u.course, u.family])).entries()]
    .map(([course, family]) => subjectFit(course, family, run.items))
    .filter((f): f is SubjectFit => f !== null);
  push("subjectFit", rate(fits.filter((f) => f.pass).length, fits.length));

  // The prompt carries the course's subject profile (D35/D52), where code knows the family.
  const known = run.units.filter((u) => u.prompt && u.family !== "unknown");
  push("promptSubject", rate(known.filter((u) => u.prompt!.includes(`Subject profile (${u.family})`)).length, known.length));

  // Coverage of the scope: modules with at least one stored item, and the synthetic gold topics.
  const courseUnits = run.units.filter(scored);
  let modules = 0;
  let covered = 0;
  let gold = 0;
  let goldHit = 0;
  for (const course of new Set(courseUnits.map((u) => u.course))) {
    const u = courseUnits.find((x) => x.course === course)!;
    const stored = model.filter((i) => i.course === course && i.scope === "course" && i.stored).flatMap((i) => [i.stored!, ...i.derived]);
    for (const r of u.scopeResources) {
      modules++;
      if (stored.some((s) => s.sources.some((x) => x.resourceId === r.id))) covered++;
    }
    const goldTopics = run.goldByCourse.get(course) ?? [];
    for (const g of goldTopics) {
      const r = u.scopeResources.find((x) => x.externalId === g.resource);
      if (!r) continue;
      gold++;
      const start = r.text.indexOf(g.quote);
      const end = start + g.quote.length;
      if (stored.some((s) => s.sources.some((x) => x.resourceId === r.id && x.start < end && x.end > start))) goldHit++;
    }
  }
  push("moduleCoverage", rate(covered, modules));
  push("goldTopicCoverage", rate(goldHit, gold));

  return {
    rows,
    subjectFit: fits,
    planted: plantedTable,
    falseDrops: [...falseDropped, ...model.filter((i) => i.dropped?.stage === "flaws")].map((i) => ({ course: i.course, pack: i.pack, stage: i.dropped!.stage, reason: i.dropped!.reason, stem: i.draft.stem.slice(0, 120) })),
    diagnostics: diagnostics(run),
    failures: run.units.filter((u) => u.result.status !== "done").map((u) => ({ unit: `${u.course}/${u.scope}/${u.pack}`, status: u.threw ? "threw" : u.result.status, message: u.threw ?? u.result.message })),
    perCourse: [...new Set(run.items.map((i) => i.course))].map((course) => {
      const list = model.filter((i) => i.course === course);
      const dropped: Record<string, number> = {};
      for (const i of list) if (i.dropped) dropped[i.dropped.stage] = (dropped[i.dropped.stage] ?? 0) + 1;
      return { course, family: list[0]?.family ?? "", tier: list[0]?.tier ?? "", generated: list.length, accepted: list.filter((i) => i.stored).length, dropped };
    }),
  };
}

/** Descriptive numbers with no threshold: what a live run reads to decide the next fix. */
function diagnostics(run: HarnessResult): Record<string, unknown> {
  const model = run.items.filter((i) => !i.planted);
  const stored = model.filter((i) => i.stored).map((i) => i.stored!);
  const mcs = stored.filter((s) => s.item.kind === "mc" && s.item.options);
  const position = [0, 0, 0, 0, 0];
  for (const s of mcs) position[Math.max(0, s.item.options!.findIndex((o) => o.id === s.item.key))]! += 1;
  const expected = mcs.length / 4;
  const chi2 = expected ? position.slice(0, 4).reduce((a, o) => a + ((o - expected) ** 2) / expected, 0) : null;
  const isNum = (t: string) => /^[-+]?\d[\d,.]*\s*\p{L}*$/u.test(t.trim());
  const formMatch = mcs.filter((s) => new Set(s.item.options!.map((o) => isNum(o.text))).size === 1).length;
  const lengthRatios = mcs.map((s) => {
    const l = s.item.options!.map((o) => o.text.trim().length);
    return Math.max(...l) / Math.max(1, Math.min(...l));
  });
  const scopeText = new Map(run.units.map((u) => [`${u.course}|${u.scope}`, u.scopeResources.map((r) => r.text.toLowerCase()).join(" ")]));
  let distractors = 0;
  let grounded = 0;
  for (const i of model.filter((x) => x.stored?.item.kind === "mc")) {
    const text = scopeText.get(`${i.course}|${i.scope}`) ?? "";
    for (const o of i.stored!.item.options!) {
      if (o.id === i.stored!.item.key) continue;
      distractors++;
      const words = normaliseText(o.text).split(" ").filter((w) => w.length >= 4);
      if (words.length && words.every((w) => text.includes(w))) grounded++;
    }
  }
  const clozes = stored.filter((s) => s.item.kind === "cloze");
  const cards = stored.filter((s) => s.item.kind === "card");
  const kinds: Record<string, number> = {};
  for (const s of [...stored, ...model.flatMap((i) => i.derived)]) kinds[s.item.kind] = (kinds[s.item.kind] ?? 0) + 1;
  const passageUse = run.units.map((u) => {
    const cited = new Set(model.filter((i) => i.course === u.course && i.scope === u.scope && i.pack === u.pack && i.stored).map((i) => i.draft.sourceId));
    return { unit: `${u.course}/${u.scope}/${u.pack}`, sent: u.sent.length, cited: cited.size };
  });
  const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : null);
  return {
    storedByKind: kinds,
    keyPosition: { counts: { a: position[0], b: position[1], c: position[2], d: position[3] }, n: mcs.length, chiSquare3df: chi2 && Number(chi2.toFixed(2)), note: "uniform is 7.81 or less at p = 0.05 (3 df)" },
    distractors: {
      optionFormMatch: rate(formMatch, mcs.length),
      medianLongestToShortestOption: median(lengthRatios),
      distractorWordsInScopeText: rate(grounded, distractors),
    },
    cloze: {
      n: clozes.length,
      answerVisibleInStem: clozes.filter((s) => wholeWord(s.item.stem, String(s.item.key))).length,
      blankAtStart: clozes.filter((s) => s.item.stem.startsWith(CLOZE_BLANK)).length,
      medianAnswerWords: median(clozes.map((s) => String(s.item.key).split(/\s+/).length)),
    },
    termCards: { n: cards.length, medianBackChars: median(cards.map((s) => String(s.item.key).length)), derivedReverse: model.reduce((a, i) => a + i.derived.length, 0) },
    nearDuplicateThreshold: NEAR_DUPLICATE,
    /** The most similar pair of stored stems within one course scope (each scope has its own store). */
    maxStoredPairSimilarity: (() => {
      let max = 0;
      const groups = new Map<string, string[]>();
      for (const i of model.filter((x) => x.stored)) groups.set(`${i.course}|${i.scope}`, [...(groups.get(`${i.course}|${i.scope}`) ?? []), i.stored!.item.stem]);
      for (const stems of groups.values())
        for (let a = 0; a < stems.length; a++) for (let b = a + 1; b < stems.length; b++) max = Math.max(max, trigramJaccard(stems[a]!, stems[b]!));
      return Number(max.toFixed(2));
    })(),
    passageUse,
    tokens: run.units.reduce((a, u) => a + u.result.tokens.in + u.result.tokens.cached + u.result.tokens.out, 0),
    models: run.models,
  };
}
