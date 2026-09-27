/**
 * N15: the practice exam builder (owner: exam-prep). Code assembles a sectioned practice exam
 * from checked questions, stored problems and the instructor's own problems, matched to the
 * blueprint: its sections, format mix and cognitive levels, with topic counts from the coverage
 * weights (spec §5.7: exam-faithful λ = 0; "lean toward my iffy topics" λ = 0.5; largest
 * remainder; at least one question per covered topic when the length allows). Graded work
 * (real quizzes, exams, open assignments) is never a source; a question outside the stated
 * scope is dropped, and a past-term question that can't be placed in scope says it may not apply.
 */
import { tierLabel } from "../labels";
import type { Tier } from "../store";
import type { ConceptStateName } from "../types";
import type { CognitiveLevel, ExamBlueprint, ExamFormat, ExamQuestionPlan, PracticeExamPlan, SolveProblem } from "./types";

export interface BuildInput {
  blueprint: ExamBlueprint;
  /** Every candidate, already source-checked against the current study context. */
  candidates: SolveProblem[];
  length: number;
  lean: boolean;
  states: Map<string, ConceptStateName>;
  labels: Map<string, string>;
  /** Titles of the documents instructor problems were cut from, by resource ID. */
  sourceTitles: Map<string, string>;
  minutes?: number | null;
}

export const LEAN = 0.5;

/** κ'_c = κ_c · (1 + λ·[Iffy] + 0.5λ·[Not seen yet]), normalised (spec §5.7). */
export function leanWeights(weights: Map<string, number>, states: Map<string, ConceptStateName>, lean: boolean): Map<string, number> {
  const lambda = lean ? LEAN : 0;
  const raw = new Map<string, number>();
  for (const [c, k] of weights) {
    const s = states.get(c) ?? "not_seen";
    raw.set(c, k * (1 + lambda * (s === "iffy" ? 1 : 0) + 0.5 * lambda * (s === "not_seen" ? 1 : 0)));
  }
  const sum = [...raw.values()].reduce((a, b) => a + b, 0);
  return new Map([...raw].map(([c, v]) => [c, sum > 0 ? v / sum : 0]));
}

/**
 * Largest-remainder allocation of `total` over `weights`, capped per key, with at least one per
 * key when the total allows. Deterministic: ties go to the key that sorts first.
 */
export function allocate(weights: Map<string, number>, total: number, caps: Map<string, number>): Map<string, number> {
  const keys = [...weights.keys()].filter((k) => (caps.get(k) ?? Infinity) > 0).sort();
  const out = new Map(keys.map((k) => [k, 0]));
  let remaining = Math.min(total, keys.reduce((s, k) => s + (caps.get(k) ?? Infinity), 0));
  if (!keys.length || remaining <= 0) return out;
  const floor = remaining >= keys.length;
  let open = [...keys];
  while (remaining > 0 && open.length) {
    const wsum = open.reduce((s, k) => s + (weights.get(k) ?? 0), 0);
    const target = new Map(open.map((k) => [k, wsum > 0 ? ((weights.get(k) ?? 0) / wsum) * remaining : remaining / open.length]));
    const add = new Map(open.map((k) => [k, Math.floor(target.get(k)!)]));
    let left = remaining - [...add.values()].reduce((a, b) => a + b, 0);
    const byRemainder = [...open].sort((a, b) => target.get(b)! - add.get(b)! - (target.get(a)! - add.get(a)!) || (a < b ? -1 : 1));
    for (const k of byRemainder) {
      if (left <= 0) break;
      add.set(k, add.get(k)! + 1);
      left--;
    }
    let used = 0;
    for (const k of open) {
      const cap = (caps.get(k) ?? Infinity) - out.get(k)!;
      const give = Math.min(cap, add.get(k)!);
      out.set(k, out.get(k)! + give);
      used += give;
    }
    remaining -= used;
    open = open.filter((k) => out.get(k)! < (caps.get(k) ?? Infinity));
    if (used === 0) break;
  }
  if (floor)
    for (const k of keys)
      if (out.get(k) === 0) {
        const donor = keys
          .filter((d) => out.get(d)! >= 2)
          .sort((a, b) => out.get(b)! - (weights.get(b) ?? 0) * total - (out.get(a)! - (weights.get(a) ?? 0) * total) || (a < b ? -1 : 1))[0];
        if (!donor) break;
        out.set(donor, out.get(donor)! - 1);
        out.set(k, 1);
      }
  return out;
}

interface Slot {
  sectionId: string;
  format: ExamFormat | null;
  level: CognitiveLevel | null;
}

/** Slots per section (largest remainder over the section's items or points), then format and level targets inside it. */
function slotsFor(blueprint: ExamBlueprint, length: number): { slots: Slot[]; sections: PracticeExamPlan["sections"] } {
  if (blueprint.thin || !blueprint.sections.length)
    return { slots: Array.from({ length }, () => ({ sectionId: "practice", format: null, level: null })), sections: [{ id: "practice", label: "Practice questions (no exam format found)", questionIds: [], evidence: [] }] };
  const weight = new Map(blueprint.sections.map((s) => [s.id, s.items ?? s.points ?? 1]));
  const perSection = allocate(weight, length, new Map());
  const slots: Slot[] = [];
  for (const s of blueprint.sections) {
    const n = perSection.get(s.id) ?? 0;
    // The section's own questions, as (format, level) pairs, set its slots; a stated format without questions counts once.
    const pairs = new Map<string, number>();
    for (const q of s.profile) pairs.set(`${q.format}|${q.level ?? ""}`, (pairs.get(`${q.format}|${q.level ?? ""}`) ?? 0) + 1);
    const counts = allocate(pairs, n, new Map());
    const keys = [...pairs.keys()];
    for (const key of keys)
      for (let k = 0; k < (counts.get(key) ?? 0); k++) {
        const [format, level] = key.split("|");
        slots.push({ sectionId: s.id, format: format as ExamFormat, level: (level || null) as CognitiveLevel | null });
      }
  }
  return { slots, sections: blueprint.sections.map((s) => ({ id: s.id, label: s.label, questionIds: [], evidence: s.evidence })) };
}

const FORMAT_WORDS: Record<ExamFormat, string> = {
  multiple_choice: "multiple choice",
  true_false: "true/false",
  numeric: "a numeric answer",
  symbolic: "an expression",
  short_answer: "a short answer",
  essay: "an essay",
  proof: "a proof",
  code_writing: "writing code",
  code_tracing: "tracing code",
  diagram: "a diagram",
};

/** Formats close enough to stand in for one another (a numeric step for a numeric problem, recall for recall). */
const NEAR: Partial<Record<ExamFormat, ExamFormat[]>> = {
  numeric: ["symbolic"],
  symbolic: ["numeric"],
  short_answer: ["essay"],
  essay: ["short_answer"],
  code_writing: ["code_tracing"],
  code_tracing: ["code_writing"],
  proof: ["symbolic"],
};

export interface BuiltExam {
  plan: PracticeExamPlan;
  problems: Map<string, SolveProblem>;
}

export function buildPracticeExam(input: BuildInput): BuiltExam {
  const { blueprint } = input;
  const dropped = new Map<string, number>();
  const drop = (reason: string) => dropped.set(reason, (dropped.get(reason) ?? 0) + 1);
  const excluded = new Set(blueprint.excludedResourceIds);
  const scopeIds = new Set(blueprint.scope.concepts.map((c) => c.conceptId));
  const scoped = blueprint.scope.basis !== "none";
  const mayNotApply = new Set<string>();
  const pool: SolveProblem[] = [];
  const seen = new Set<string>();
  for (const p of [...input.candidates].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    if (excluded.has(p.source.resourceId)) {
      drop("From graded work (a real quiz, exam or assignment): never used as practice.");
      continue;
    }
    const primary = p.conceptIds[0];
    if (primary && scoped && !scopeIds.has(primary)) {
      drop("Outside this exam's stated scope.");
      continue;
    }
    if (!primary && p.origin !== "instructor") {
      drop("Not tagged to a topic on the course map.");
      continue;
    }
    if (p.tier === "T3" && !primary) mayNotApply.add(p.id);
    pool.push(p);
  }

  // Topic quotas: κ from the blueprint, leaned, allocated over the length.
  const kappa = new Map(blueprint.scope.concepts.map((c) => [c.conceptId, c.weight]));
  const leaned = leanWeights(kappa, input.states, input.lean);
  const available = new Map<string, number>();
  for (const p of pool) if (p.conceptIds[0]) available.set(p.conceptIds[0], (available.get(p.conceptIds[0]) ?? 0) + 1);
  const untagged = pool.filter((p) => !p.conceptIds[0]);
  const untaggedCap = Math.min(untagged.length, Math.ceil(input.length / 2));
  const taggedTotal = [...available.values()].reduce((a, b) => a + b, 0);
  const length = Math.min(input.length, taggedTotal + untaggedCap);
  const caps = new Map([...leaned.keys()].map((k) => [k, available.get(k) ?? 0]));
  const quotas = allocate(leaned, Math.min(length, taggedTotal), caps);
  const taken = new Map<string, number>();
  const { slots, sections } = slotsFor(blueprint, length);

  const used = new Set<string>();
  const left = new Map(quotas);
  let untaggedUsed = 0;
  const questions: ExamQuestionPlan[] = [];
  const problems = new Map<string, SolveProblem>();
  const assigned = new Map<number, SolveProblem>();
  const fit = (slot: Slot, p: SolveProblem) =>
    (slot.format ? (p.format === slot.format ? 10 : NEAR[slot.format]?.includes(p.format) ? 4 : 0) : 0) +
    (slot.level && p.level === slot.level ? 1 : 0) +
    (p.origin === "instructor" ? 1 : 0) -
    (p.tier === "T3" ? 1 : 0);
  const take = (i: number, p: SolveProblem) => {
    used.add(p.id);
    const c = p.conceptIds[0];
    if (c) {
      left.set(c, (left.get(c) ?? 0) - 1);
      taken.set(c, (taken.get(c) ?? 0) + 1);
    } else untaggedUsed++;
    assigned.set(i, p);
  };
  // 1. The floor (spec §5.7): one question per covered topic, each placed in the slot it fits best.
  //    Topics with the fewest candidates go first, so a scarce topic isn't crowded out.
  const count = (c: string) => pool.filter((p) => p.conceptIds[0] === c).length;
  const floor = [...quotas].filter(([, q]) => q > 0).map(([c]) => c).sort((a, b) => count(a) - count(b) || (a < b ? -1 : 1));
  //    Pass one places topics that have a question in a slot's own format; pass two places the rest
  //    in whatever slots are left, so a topic with no matching format doesn't take another's slot.
  for (const exactOnly of [true, false])
    for (const c of floor) {
      if (taken.get(c)) continue;
      let best: { i: number; p: SolveProblem; score: number } | null = null;
      for (let i = 0; i < slots.length; i++) {
        if (assigned.has(i)) continue;
        const slot = slots[i]!;
        for (const p of pool) {
          if (used.has(p.id) || p.conceptIds[0] !== c) continue;
          if (exactOnly && slot.format && p.format !== slot.format) continue;
          const score = fit(slot, p);
          if (!best || score > best.score) best = { i, p, score };
        }
      }
      if (best) take(best.i, best.p);
    }
  // 2. The rest: scarce formats first (a numeric slot with three candidates before a multiple-choice
  //    slot with ten), matching format, then the topic shares. A topic may go one question over its
  //    share, and only to keep the exam's format; never more.
  const exact = (slot: Slot) => (slot.format ? pool.filter((p) => p.format === slot.format).length : pool.length);
  const order = slots.map((slot, i) => ({ slot, i })).filter(({ i }) => !assigned.has(i)).sort((a, b) => exact(a.slot) - exact(b.slot) || a.i - b.i);
  for (const { slot, i } of order) {
    let best: { p: SolveProblem; score: number } | null = null;
    for (const p of pool) {
      if (used.has(p.id)) continue;
      const c = p.conceptIds[0];
      if (!c && untaggedUsed >= untaggedCap) continue;
      if (c && (left.get(c) ?? 0) < 0) continue;
      const score = fit(slot, p) + (c ? ((left.get(c) ?? 0) > 0 ? 3 : -3) : 1);
      if (!best || score > best.score) best = { p, score };
    }
    if (best) take(i, best.p);
  }
  // Questions are emitted in the exam's own section order.
  slots.forEach((slot, i) => {
    const p = assigned.get(i);
    if (!p) return;
    const id = `q${questions.length + 1}`;
    const substitute =
      slot.format && p.format !== slot.format
        ? `This part of the exam asks for ${FORMAT_WORDS[slot.format]}; no remaining checked question in that format fits this exam's topic shares, so this one takes ${FORMAT_WORDS[p.format]}.`
        : null;
    const tier: Tier = p.tier;
    const doc = p.origin === "instructor" ? input.sourceTitles.get(p.source.resourceId) : undefined;
    questions.push({
      id,
      source: p.kind === "item" ? { kind: "item", itemId: p.id, itemVersion: p.version } : { kind: "problem", problemId: p.id, problemVersion: p.version },
      sectionId: slot.sectionId,
      format: p.format,
      level: p.level,
      points: p.points,
      conceptIds: p.conceptIds,
      tier,
      provenance: doc ? `${tierLabel(tier)}: ${doc}` : tierLabel(tier),
      substitute,
      mayNotApply: mayNotApply.has(p.id),
    });
    problems.set(id, p);
    sections.find((s) => s.id === slot.sectionId)?.questionIds.push(id);
  });

  const warnings = [...blueprint.warnings];
  if (questions.length < input.length)
    warnings.push(`Only ${questions.length} checked question${questions.length === 1 ? "" : "s"} fit this exam's scope, so the practice exam is shorter than asked.`);
  const missing = blueprint.scope.concepts.filter((c) => !available.get(c.conceptId)).map((c) => c.label);
  if (missing.length) warnings.push(`No checked practice yet for: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` and ${missing.length - 5} more` : ""}.`);
  if (questions.some((q) => q.mayNotApply)) warnings.push("Some questions come from past-term exams and may not apply to this term.");
  const over = [...left].filter(([, n]) => n < 0).map(([c]) => input.labels.get(c) ?? c);
  if (over.length) warnings.push(`To keep the exam's format, ${over.join(", ")} ${over.length === 1 ? "has" : "have"} one question more than ${over.length === 1 ? "its" : "their"} coverage share.`);

  const perQuestionMinutes =
    blueprint.length && blueprint.sections.some((s) => s.items)
      ? blueprint.length.minutes / Math.max(1, blueprint.sections.reduce((s, x) => s + (x.items ?? 0), 0))
      : null;
  const minutes = input.minutes ?? (perQuestionMinutes ? Math.max(5, Math.round(perQuestionMinutes * questions.length)) : (blueprint.length?.minutes ?? null));
  const allocation = blueprint.scope.concepts.map((c) => ({
    conceptId: c.conceptId,
    label: c.label,
    weight: c.weight,
    leaned: leaned.get(c.conceptId) ?? 0,
    questions: questions.filter((q) => q.conceptIds[0] === c.conceptId).length,
  }));
  return {
    plan: {
      assessmentId: blueprint.assessmentId,
      title: `Practice: ${blueprint.title}`,
      tier: blueprint.tier,
      tierLabel: blueprint.tierLabel,
      provenance: `${blueprint.basis} Practice built from your course materials; it isn't the real exam and isn't a grade prediction.`,
      sections: sections.filter((s) => s.questionIds.length),
      questions,
      allocation,
      lean: input.lean,
      minutes,
      warnings,
      dropped: [...dropped].map(([reason, count]) => ({ reason, count })),
    },
    problems,
  };
}
