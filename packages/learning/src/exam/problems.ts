/**
 * Solve problems (owner: exam-prep): where they come from and how code checks them before they
 * are stored. Three origins, all quote-grounded:
 * - checked practice items (one step each), snapshotted from the item pool;
 * - the instructor's own problems, cut verbatim from a practice exam, review sheet or past exam
 *   (never from graded work), keyed by code from a paired solutions document when it can read
 *   the key, otherwise marked by the student against the instructor's solution;
 * - problems a model authored through the `problems` pack: steps, hints and a worked example,
 *   each checked here (formula recomputed, expressions parsed, nudges that give the answer away
 *   rejected, Parsons lines found verbatim). A failed check drops the problem with its reason.
 * Stored as learning artifacts (kind "problem"), with an index per course; a source change marks
 * them stale through the store's existing `markStale`.
 */
import { createHash } from "node:crypto";
import { evaluate } from "../arith";
import { normaliseAnswer } from "../grade";
import type { Bloom } from "../config";
import type { ArtifactKind, LearningStore, StoredItem, Tier } from "../store";
import { nudgeGivesAway } from "./hints";
import { parseAnswers, parseExam, type ParsedAnswer } from "./parse";
import { knownUnit, parseExpression } from "./symbolic";
import type { ExamFormat, SolveProblem, SolveStep, StepAnswer } from "./types";

const PROBLEM_KIND = "problem" as ArtifactKind;
const INDEX_KIND = "problem_index" as ArtifactKind;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

export const ITEM_FORMAT: Record<string, ExamFormat> = {
  mc: "multiple_choice",
  tf: "true_false",
  numeric: "numeric",
  typed: "short_answer",
  cloze: "short_answer",
};

/** A checked practice item as a one-step problem (a snapshot: the session keeps it as asked). */
export function itemProblem(x: StoredItem, conceptOrder: string[]): SolveProblem | null {
  const item = x.item;
  const source = x.sources[0];
  if (!source || item.kind === "card") return null;
  let answer: StepAnswer;
  let format: ExamFormat = ITEM_FORMAT[item.kind] ?? "short_answer";
  const expression = item.kind === "typed" || item.kind === "cloze" ? asExpression(String(item.key), item.stem) : null;
  if (item.kind === "mc" || item.kind === "tf") answer = { kind: "choice", options: item.options ?? [], key: String(item.key) };
  else if (item.kind === "numeric") answer = { kind: "numeric", value: Number(item.key), unit: item.unit ?? null, relTol: 0.005, absTol: 0 };
  else if (expression) {
    // A typed key that is an expression is checked for equivalence, not by its words.
    answer = expression;
    format = "symbolic";
  } else answer = { kind: "text", key: String(item.key), keyIdeas: item.keyIdeas };
  const tags = [...x.tags].sort((a, b) => Number(b.primary) - Number(a.primary) || conceptOrder.indexOf(a.conceptId) - conceptOrder.indexOf(b.conceptId));
  return {
    kind: "item",
    id: item.id,
    version: item.version,
    courseRef: item.courseRef,
    stem: item.stem,
    format,
    level: item.bloom,
    conceptIds: tags.map((t) => t.conceptId),
    steps: [{ id: "answer", prompt: item.stem, answer, nudge: null, worked: null, explain: null }],
    workedExample: item.explanation ? [item.explanation] : [],
    source: { resourceId: source.resourceId, contentHash: source.contentHash, start: source.start, end: source.end, quote: source.quote },
    origin: item.origin === "instructor" ? "instructor" : "generated",
    tier: item.tier,
    points: null,
    checks: x.checks.filter((c) => c.outcome === "pass").map((c) => c.check),
    generator: item.generator,
  };
}

/**
 * A typed key that is a math expression ("(x - 1)*(x + 1)"): single-letter variables, an operator,
 * no words, and it parses under the allow-list. The stem sets a required form ("Factor", "Expand").
 */
export function asExpression(key: string, stem: string): Extract<StepAnswer, { kind: "symbolic" }> | null {
  const k = key.trim();
  if (!/[+\-*/^]/.test(k) || !/[a-z]/i.test(k) || /[a-z]{2,}/i.test(k.replace(/\b(?:sin|cos|tan|exp|log|ln|sqrt|abs|pi)\b/g, ""))) return null;
  const variables = [...new Set(k.replace(/\b(?:sin|cos|tan|exp|log|ln|sqrt|abs|pi)\b/g, "").match(/[a-df-z]/gi) ?? [])]; // e is the constant
  if (!parseExpression(k, variables).ok) return null;
  const form = /\bfactor/i.test(stem) ? "factored" : /\b(?:expand|multiply out)/i.test(stem) ? "expanded" : "any";
  return { kind: "symbolic", expr: k, variables, form };
}

/** Concept IDs whose label appears as whole words in the text (code-only tagging). */
export function tagByLabel(text: string, topics: { id: string; label: string }[]): string[] {
  const hay = ` ${normaliseAnswer(text)} `;
  return topics.filter((t) => {
    const needle = normaliseAnswer(t.label);
    return needle.length >= 3 && hay.includes(` ${needle} `);
  }).map((t) => t.id);
}

export interface InstructorDoc {
  id: string;
  title: string;
  text: string;
  contentHash: string;
}

/** Pair a solutions document with the problems document its title names ("Practice Midterm 1 Solutions" ↔ "Practice Midterm 1"). */
export function pairsWith(problemsTitle: string, solutionsTitle: string): boolean {
  const strip = (t: string) =>
    normaliseAnswer(t)
      .split(" ")
      .filter((w) => !["solution", "soln", "answer", "key", "keys", "pdf", "docx", "with"].includes(w))
      .join(" ");
  const a = strip(problemsTitle);
  return !!a && a === strip(solutionsTitle);
}



/**
 * The instructor's problems in one document, cut verbatim. A multiple-choice key or a numeric
 * answer is taken from the paired solutions document only when code reads it unambiguously;
 * otherwise the problem is marked by the student against the instructor's solution (or, with no
 * solutions document, against their own reading of the course).
 */
export function instructorProblems(
  doc: InstructorDoc,
  solutions: InstructorDoc | null,
  opts: { courseRef: string; tier: Tier; topics: { id: string; label: string }[] },
): SolveProblem[] {
  const parsed = parseExam(doc.text);
  const answers: ParsedAnswer[] = solutions ? parseAnswers(solutions.text) : [];
  const out: SolveProblem[] = [];
  for (const q of parsed.questions) {
    if (q.stem.length < 12) continue;
    const quote = doc.text.slice(q.start, q.end);
    if (quote.length > 1500) continue;
    const a = answers.find((x) => x.number === q.number) ?? null;
    const solution = a && solutions ? { resourceId: solutions.id, contentHash: solutions.contentHash, start: a.span.start, end: a.span.end, quote: a.text } : null;
    let answer: StepAnswer = { kind: "self", solution };
    const checks = ["quote", "not_graded_work"];
    if (q.format === "multiple_choice" && a?.choice && q.options.some((o) => o.id === a.choice)) {
      answer = { kind: "choice", options: q.options, key: a.choice };
      checks.push("key_from_solutions");
    } else if (q.format === "numeric" && a?.numeric && knownUnit(a.numeric.unit)) {
      // Half the last printed digit: the key is as precise as the instructor printed it.
      const absTol = 0.5 * 10 ** -a.numeric.decimals;
      answer = { kind: "numeric", value: a.numeric.value, unit: a.numeric.unit, relTol: 0.005, absTol };
      checks.push("key_from_solutions");
    }
    const stepPrompt = answer.kind === "self" ? "Work the problem, then compare with the instructor's solution." : q.stem;
    const id = `instr-${hash(`${doc.id}:${doc.contentHash}:${q.number}`).slice(0, 16)}`;
    out.push({
      kind: "problem",
      id,
      version: 1,
      courseRef: opts.courseRef,
      // A self-marked problem keeps its options and parts in the stem: nothing is split off.
      stem: answer.kind === "self" ? doc.text.slice(q.stemSpan.start, q.end).trim() : q.stem,
      format: q.format,
      level: q.level,
      // Tagged by the stem's words; failing that, by the instructor's solution (never by the options, which name distractors).
      conceptIds: (() => {
        const byStem = tagByLabel(q.stem, opts.topics);
        return byStem.length ? byStem : a ? tagByLabel(a.text, opts.topics) : [];
      })(),
      steps: [{ id: "answer", prompt: stepPrompt, answer, nudge: null, worked: null, explain: null }],
      workedExample: solution ? [solution.quote] : [],
      source: { resourceId: doc.id, contentHash: doc.contentHash, start: q.start, end: q.end, quote },
      origin: "instructor",
      tier: opts.tier,
      points: q.points,
      checks,
      generator: null,
    });
  }
  return out;
}

// ---------- Code-only Parsons problems ----------

const CODE_LINE = /[;{}]\s*$|^\s*(?:def\s|class\s|return\b|for\b|while\b|if\b|elif\b|else\b|try\b|except\b|finally\b|with\s|int\s|public\s|private\s|void\s|print\(|printf|System\.out|console\.log|let\s|const\s|var\s)/;
/** An assignment or a call: code inside a run, but not enough alone (a math derivation has "=" lines too). */
const WEAK_CODE_LINE = /^\s*[A-Za-z_][\w.]*(?:\[[^\]]*\])?\s*(?:[+\-*/]?=(?!=)\s*\S|\([^()]*\)\s*$)/;

/** Runs of 3 to 15 consecutive code lines in a text, with offsets; each run has at least one unmistakable code line. */
export function codeRuns(text: string): { start: number; end: number; lines: string[] }[] {
  const out: { start: number; end: number; lines: string[] }[] = [];
  const lines = text.split("\n");
  let offset = 0;
  let run: { start: number; end: number; lines: string[]; strong: boolean } | null = null;
  const close = () => {
    if (run && run.strong && run.lines.length >= 3 && run.lines.length <= 15) out.push({ start: run.start, end: run.end, lines: run.lines });
    run = null;
  };
  for (const line of lines) {
    const strong = line.trim().length > 0 && CODE_LINE.test(line);
    const isCode = strong || (line.trim().length > 0 && WEAK_CODE_LINE.test(line));
    if (isCode) {
      if (!run) run = { start: offset, end: offset + line.length, lines: [line], strong };
      else {
        run.lines.push(line);
        run.end = offset + line.length;
        run.strong ||= strong;
      }
    } else close();
    offset += line.length + 1;
  }
  close();
  return out;
}

/** Parsons blocks from verbatim code lines: indentation normalised to levels, IDs by hash. */
export function parsonsAnswer(lines: string[], distractors: string[], seed: string): Extract<StepAnswer, { kind: "parsons" }> {
  const kept = lines.filter((l) => l.trim());
  const widths = kept.map((l) => l.length - l.trimStart().length);
  const unit = Math.max(1, Math.min(...widths.filter((w) => w > 0), 4));
  const base = Math.min(...widths);
  const blocks = kept.map((l, i) => ({ id: `b${hash(`${seed}:${i}:${l}`).slice(0, 8)}`, text: l.trim(), indent: Math.round((widths[i]! - base) / unit) }));
  const extra = distractors.map((d, i) => ({ id: `d${hash(`${seed}:d${i}:${d}`).slice(0, 8)}`, text: d.trim(), indent: 0 }));
  // Identical lines are interchangeable; checkParsons compares by text, so these swaps are only a hint for older readers.
  const alternatives: string[][] = [];
  const byText = new Map<string, number[]>();
  blocks.forEach((b, i) => byText.set(b.text, [...(byText.get(b.text) ?? []), i]));
  for (const idx of byText.values())
    if (idx.length === 2) {
      const alt = blocks.map((b) => b.id);
      [alt[idx[0]!], alt[idx[1]!]] = [alt[idx[1]!]!, alt[idx[0]!]!];
      alternatives.push(alt);
    }
  return {
    kind: "parsons",
    blocks: [...blocks, ...extra],
    solution: blocks.map((b) => b.id),
    alternatives,
    distractors: extra.map((d) => d.id),
    indented: blocks.some((b) => b.indent > 0),
  };
}

/** A code-only Parsons problem from a verbatim code run in a study source. */
export function codeParsonsProblem(
  resource: { id: string; title: string; text: string; contentHash: string },
  run: { start: number; end: number; lines: string[] },
  opts: { courseRef: string; conceptIds: string[] },
): SolveProblem {
  const id = `parsons-${hash(`${resource.id}:${resource.contentHash}:${run.start}`).slice(0, 16)}`;
  const answer = parsonsAnswer(run.lines, [], id);
  return {
    kind: "problem",
    id,
    version: 1,
    courseRef: opts.courseRef,
    stem: `Put the lines of this code from "${resource.title}" in a working order.`,
    format: "code_writing",
    level: "apply",
    conceptIds: opts.conceptIds,
    steps: [{ id: "answer", prompt: "Drag the lines into order" + (answer.indented ? " and set their indentation." : "."), answer, nudge: null, worked: null, explain: null }],
    workedExample: [],
    source: { resourceId: resource.id, contentHash: resource.contentHash, start: run.start, end: run.end, quote: resource.text.slice(run.start, run.end) },
    origin: "code",
    tier: "T4",
    points: null,
    checks: ["quote", "verbatim"],
    generator: null,
  };
}

// ---------- Model-authored problems (the `problems` pack), checked by code ----------

export interface AuthoredStep {
  prompt: string;
  answerKind: "numeric" | "symbolic" | "text";
  numeric: { value: number; unit: string | null; formula: string | null } | null;
  symbolic: { expr: string; variables: string[]; form: "any" | "expanded" | "factored" } | null;
  text: { key: string; keyIdeas: string[] } | null;
  nudge: string;
  workedStep: string;
  explainPrompt: string | null;
}

export interface AuthoredProblem {
  stem: string;
  format: "numeric" | "symbolic" | "parsons" | "short_answer";
  bloom: Bloom;
  steps: AuthoredStep[];
  workedExample: string[];
  parsons: { code: string; distractors: string[] } | null;
}

export interface AuthoringContext {
  id: string;
  courseRef: string;
  resource: { id: string; kind: string; text: string; contentHash: string };
  /** The grounded span of the cited quote in the resource text (null: not found uniquely). */
  span: { start: number; end: number } | null;
  courseRestricted: boolean;
  openGraded: boolean;
  conceptIds: string[];
  generator: SolveProblem["generator"];
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** Code checks on one authored problem. Returns the stored problem, or the reasons it was dropped. */
export function checkAuthored(a: AuthoredProblem, ctx: AuthoringContext): { problem: SolveProblem | null; reasons: string[] } {
  const reasons: string[] = [];
  if (ctx.courseRestricted) reasons.push("policy: the course restricts AI-made practice");
  if (ctx.openGraded) reasons.push("open_graded: the source is graded work that is still open");
  if (!ctx.span) reasons.push("quote: not found exactly once in the cited source");
  if (!ctx.conceptIds.length) reasons.push("tags: no topic on the course map");
  const steps: SolveStep[] = [];
  if (a.format === "parsons") {
    const code = a.parsons?.code ?? "";
    const lines = code.split("\n").filter((l) => l.trim());
    const hay = ctx.resource.text.split("\n").map(collapse);
    if (lines.length < 3 || lines.length > 15) reasons.push("verbatim: a Parsons problem needs 3 to 15 code lines");
    else if (!lines.every((l) => hay.includes(collapse(l)))) reasons.push("verbatim: a Parsons line isn't in the cited source");
    const distractors = (a.parsons?.distractors ?? []).filter((d) => d.trim()).slice(0, 3);
    if (distractors.some((d) => lines.some((l) => collapse(l) === collapse(d)))) reasons.push("distractors: a distractor repeats a solution line");
    const answer = parsonsAnswer(lines, distractors, ctx.id);
    const first = a.steps[0];
    if (first && nudgeGivesAway(first.nudge, answer)) reasons.push("restraint: the nudge states the answer");
    steps.push({ id: "s1", prompt: first?.prompt || "Put the lines in a working order.", answer, nudge: first?.nudge || null, worked: first?.workedStep || null, explain: null });
  } else {
    if (!a.steps.length || a.steps.length > 8) reasons.push("schema: a problem needs 1 to 8 steps");
    a.steps.forEach((s, i) => {
      const tag = `step ${i + 1}`;
      let answer: StepAnswer | null = null;
      if (s.answerKind === "numeric" && s.numeric) {
        if (!Number.isFinite(s.numeric.value)) reasons.push(`schema: ${tag} has no finite value`);
        if (!knownUnit(s.numeric.unit)) reasons.push(`units: ${tag}'s unit "${s.numeric.unit}" isn't recognised`);
        // Code decides the key: the formula's value when it agrees with the stated one (a rounded
        // statement within 0.5%); a formula that disagrees drops the problem.
        let value = s.numeric.value;
        if (s.numeric.formula) {
          try {
            const q = evaluate(s.numeric.formula);
            if (Math.abs(q.value - s.numeric.value) > 0.005 * Math.max(1e-9, Math.abs(q.value))) reasons.push(`recompute: ${tag}'s formula gives ${q.value}, not ${s.numeric.value}`);
            else value = q.value;
          } catch (e) {
            reasons.push(`recompute: ${tag}'s formula can't be evaluated (${(e as Error).message})`);
          }
        }
        answer = { kind: "numeric", value, unit: s.numeric.unit?.trim() || null, relTol: 0.01, absTol: 0 };
      } else if (s.answerKind === "symbolic" && s.symbolic) {
        const parsed = parseExpression(s.symbolic.expr, s.symbolic.variables);
        if (!parsed.ok) reasons.push(`parse: ${tag}'s expression: ${parsed.reason}`);
        answer = { kind: "symbolic", expr: s.symbolic.expr, variables: s.symbolic.variables, form: s.symbolic.form };
      } else if (s.answerKind === "text" && s.text && s.text.key.trim()) {
        const ideas = (s.text.keyIdeas.length ? s.text.keyIdeas : [s.text.key]).map((idea) => ({ idea, synonyms: [], required: true }));
        answer = { kind: "text", key: s.text.key.trim(), keyIdeas: ideas };
      } else reasons.push(`schema: ${tag} has no answer of its kind`);
      if (!s.prompt.trim()) reasons.push(`schema: ${tag} has no prompt`);
      if (answer && s.nudge && nudgeGivesAway(s.nudge, answer)) reasons.push(`restraint: ${tag}'s nudge states the answer`);
      if (answer)
        steps.push({
          id: `s${i + 1}`,
          prompt: s.prompt.trim(),
          answer,
          nudge: s.nudge.trim() || null,
          worked: s.workedStep.trim() || null,
          explain: s.explainPrompt ? { prompt: s.explainPrompt, keyIdeas: answer.kind === "text" ? answer.keyIdeas : [] } : null,
        });
    });
  }
  if (!a.workedExample.filter((l) => l.trim()).length) reasons.push("schema: no worked example");
  if (reasons.length || !ctx.span) return { problem: null, reasons };
  const format: ExamFormat = a.format === "parsons" ? "code_writing" : a.format;
  return {
    problem: {
      kind: "problem",
      id: ctx.id,
      version: 1,
      courseRef: ctx.courseRef,
      stem: a.stem.trim(),
      format,
      level: a.bloom,
      conceptIds: ctx.conceptIds,
      steps,
      workedExample: a.workedExample.map((l) => l.trim()).filter(Boolean),
      source: { resourceId: ctx.resource.id, contentHash: ctx.resource.contentHash, start: ctx.span.start, end: ctx.span.end, quote: ctx.resource.text.slice(ctx.span.start, ctx.span.end) },
      origin: "generated",
      tier: "T4",
      points: null,
      checks: ["policy", "open_graded", "quote", "tags", "schema", ...(a.format === "parsons" ? ["verbatim"] : ["recompute", "parse"]), "restraint"],
      generator: ctx.generator,
    },
    reasons: [],
  };
}

// ---------- Storage (learning artifacts; no new table) ----------

const problemKey = (courseRef: string, id: string, version: number) => `problem:${courseRef}:${id}@${version}`;
const indexKey = (courseRef: string) => `problem-index:${courseRef}`;

export function putProblem(store: LearningStore, p: SolveProblem, at: string): void {
  store.putArtifact({
    id: `problem-${hash(problemKey(p.courseRef, p.id, p.version)).slice(0, 24)}`,
    courseRef: p.courseRef,
    kind: PROBLEM_KIND,
    scope: { problemId: p.id, version: p.version },
    cacheKey: problemKey(p.courseRef, p.id, p.version),
    body: p,
    removedCount: 0,
    status: "ready",
    generator: p.generator,
    pack: "problems",
    packVersion: "v1",
    createdAt: at,
    sources: [{ resourceId: p.source.resourceId, contentHash: p.source.contentHash }],
  });
  const index = store.artifact(indexKey(p.courseRef));
  const ids = ((index?.body as { problems?: { id: string; version: number }[] } | null)?.problems ?? []).filter((x) => !(x.id === p.id && x.version === p.version));
  store.putArtifact({
    id: `problem-index-${hash(p.courseRef).slice(0, 24)}`,
    courseRef: p.courseRef,
    kind: INDEX_KIND,
    scope: { courseRef: p.courseRef },
    cacheKey: indexKey(p.courseRef),
    body: { problems: [...ids, { id: p.id, version: p.version }] },
    removedCount: 0,
    status: "ready",
    generator: null,
    pack: "problems",
    packVersion: "v1",
    createdAt: at,
    sources: [],
  });
}

/** The course's stored problems that are still ready (a changed source marks them stale). */
export function storedProblems(store: LearningStore, courseRef: string): SolveProblem[] {
  const index = store.artifact(indexKey(courseRef));
  const ids = (index?.body as { problems?: { id: string; version: number }[] } | null)?.problems ?? [];
  return ids.flatMap(({ id, version }) => {
    const a = store.artifact(problemKey(courseRef, id, version));
    return a && a.status === "ready" ? [a.body as SolveProblem] : [];
  });
}
