// N06: the checked-item pipeline (spec §6.3). Stages run in order; a failed
// stage drops the item with its stage and reason logged; the check line lists
// exactly the stages that ran and passed (labels from spec §6.4). N06
// validates; T45 generates and calls it (course-backend §L). Stage 7's verdict
// (Jev or a separate model pass) is computed by the caller and passed in, so
// this module stays pure.
import { CONFIG } from "./config";
import { evaluate, sameQuantity } from "./arith";
import { flawProblems, nearDuplicateOf, schemaProblem } from "./flaws";
import { LABEL, supportByModel, tierLabel } from "./labels";
import { locateQuote, type ValidateQuote } from "./quote-port";
import { validateTags, type ProposedTag } from "./tags";
import type {
  Concept,
  CourseRef,
  ItemCheck,
  ItemKind,
  ItemOption,
  ItemOrigin,
  ItemSource,
  ItemTag,
  KeyIdea,
  LearningItem,
  Tier,
} from "./store";
import type { Bloom } from "./config";

export interface CandidateItem {
  id: string;
  version: number;
  familyId: string;
  courseRef: CourseRef;
  kind: ItemKind;
  stem: string;
  options: ItemOption[] | null;
  key: string | number;
  unit?: string;
  keyIdeas: KeyIdea[];
  explanation: { text: string; citation: { resourceId: string; quote: string } } | null;
  tempting: Record<string, string>;
  bloom: Bloom;
  tier: Tier;
  sourceTerm: string | null;
  origin: ItemOrigin;
  generator: LearningItem["generator"];
  sources: { resourceId: string; quote: string }[];
  tags: ProposedTag[];
  /** Numeric items: the formula from the source, recomputed at stage 6. */
  formula?: string;
}

export interface PipelineResource {
  id: string;
  kind: string;
  text: string;
  contentHash: string;
  textHash?: string;
  dueAt?: string | null;
  lockAt?: string | null;
  submitted?: boolean | null;
}

/** Stage 7's verdict, from Jev (per-option Nouls plus a support Choice) or a separate model pass. */
export interface SupportVerdict {
  method: "jev" | `model:${string}`;
  support: "supports" | "contradicts" | "does_not_address" | "abstain";
  /** Option IDs judged to be right; code checks that exactly the key passes. */
  optionsPass?: string[];
  /** Before Jev's thresholds are fitted, support is shown as shadow. */
  shadow?: boolean;
  sameModel?: boolean;
}

export interface PipelineContext {
  courseRestricted: boolean;
  resources: PipelineResource[];
  validate: ValidateQuote;
  map: Concept[];
  seenStems: string[];
  now: Date;
  support?: SupportVerdict | undefined;
  /** Stage 1's open-graded test; defaults to the N04 rule (lock → due → none; no date = open). */
  isOpenGraded?: (r: PipelineResource, now: Date) => boolean;
}

export type StageName = "policy" | "schema" | "quote" | "flaws" | "near_duplicate" | "executed" | "support" | "tags" | "explanation";

export interface StageLog {
  stage: number;
  name: StageName;
  outcome: "pass" | "fail" | "not_run";
  reason?: string;
}

export interface PipelineResult {
  accepted: boolean;
  item: LearningItem | null;
  sources: ItemSource[];
  tags: ItemTag[];
  checks: ItemCheck[];
  labels: string[];
  log: StageLog[];
  dropped: { stage: number; name: StageName; reason: string } | null;
}

/** The N04 rule: an assignment is open until its closing time (lock → due → none); submitted doesn't close it. */
export function defaultIsOpenGraded(r: PipelineResource, now: Date): boolean {
  if (r.kind !== "assignment") return false;
  const closing = r.lockAt ?? r.dueAt ?? null;
  return closing === null || now.getTime() < Date.parse(closing);
}

export function difficultyPrior(kind: ItemKind, bloom: Bloom): number {
  const bf = kind === "card" ? 0 : CONFIG.bFormat.value[kind];
  return bf + CONFIG.bBloom.value[bloom];
}

export function runPipeline(c: CandidateItem, ctx: PipelineContext): PipelineResult {
  const log: StageLog[] = [];
  const at = ctx.now.toISOString();
  const byId = new Map(ctx.resources.map((r) => [r.id, r]));
  const sources: ItemSource[] = [];
  let tags: ItemTag[] = [];
  const fail = (stage: number, name: StageName, reason: string): PipelineResult => {
    log.push({ stage, name, outcome: "fail", reason });
    return { accepted: false, item: null, sources: [], tags: [], checks: toChecks(log, at, ctx.support), labels: [], log, dropped: { stage, name, reason } };
  };
  const pass = (stage: number, name: StageName) => log.push({ stage, name, outcome: "pass" });
  const skip = (stage: number, name: StageName, reason: string) => log.push({ stage, name, outcome: "not_run", reason });

  // 1. Policy and source gate
  if (ctx.courseRestricted) return fail(1, "policy", "the course restricts AI-made practice");
  const openGraded = ctx.isOpenGraded ?? defaultIsOpenGraded;
  const cited = [...c.sources, ...(c.explanation ? [c.explanation.citation] : [])];
  for (const s of cited) {
    const r = byId.get(s.resourceId);
    if (r && openGraded(r, ctx.now)) return fail(1, "policy", `source ${r.id} is an open graded assignment`);
  }
  pass(1, "policy");

  // 2. Schema
  const schema = schemaProblem(c) ?? (c.origin !== "student" && c.sources.length === 0 ? "no source" : null);
  if (schema) return fail(2, "schema", schema);
  pass(2, "schema");

  // 3. Quote found
  for (const s of c.sources) {
    const r = byId.get(s.resourceId);
    const found = r ? locateQuote(ctx.validate, r.text, s.quote) : null;
    if (!r || !found) return fail(3, "quote", `quote not found in ${s.resourceId}: "${s.quote.slice(0, 60)}"`);
    sources.push({ resourceId: r.id, contentHash: r.contentHash, textHash: r.textHash ?? r.contentHash, start: found.start, end: found.end, quote: s.quote, quoteValid: true });
  }
  if (c.sources.length) pass(3, "quote");
  else skip(3, "quote", "no source (student card)");

  // 4. Flaw rules (cue flaws only)
  const flaws = flawProblems(c);
  if (flaws.length) return fail(4, "flaws", flaws.join("; "));
  pass(4, "flaws");

  // 5. Near-duplicate
  const dup = nearDuplicateOf(c.stem, ctx.seenStems);
  if (dup) return fail(5, "near_duplicate", `near-duplicate of "${dup.slice(0, 60)}"`);
  pass(5, "near_duplicate");

  // 6. Executed answer
  if (c.kind === "numeric" && c.formula) {
    let ok = false;
    let why = "";
    try {
      const got = evaluate(c.formula);
      ok = sameQuantity(got, { value: c.key as number, unit: c.unit ?? got.unit });
      why = `the formula gives ${got.value}${got.unit ? " " + got.unit : ""}`;
    } catch (e) {
      why = `the formula doesn't evaluate: ${(e as Error).message}`;
    }
    if (!ok) return fail(6, "executed", why);
    pass(6, "executed");
  } else skip(6, "executed", "no formula to run");

  // 7. Support and one keyed answer
  const v = ctx.support;
  if (!v) skip(7, "support", "no judge ran");
  else {
    if (v.support === "contradicts") return fail(7, "support", "the source contradicts the item");
    if (v.support === "abstain") return fail(7, "support", "the judge abstained");
    if (v.support === "does_not_address") return fail(7, "support", "the source doesn't address the item");
    if ((c.kind === "mc" || c.kind === "tf") && v.optionsPass) {
      const passing = [...new Set(v.optionsPass)];
      if (passing.length === 0) return fail(7, "support", "no option was judged right");
      if (passing.length > 1) return fail(7, "support", "more than one option was judged right");
      if (passing[0] !== c.key) return fail(7, "support", "the keyed option wasn't the one judged right");
    }
    pass(7, "support");
  }

  // 8. Tags
  const t = validateTags(c.tags, c.courseRef, ctx.map);
  if (!t.ok) return fail(8, "tags", t.reason);
  tags = t.tags;
  pass(8, "tags");

  // 9. Explanation
  if (c.explanation) {
    const r = byId.get(c.explanation.citation.resourceId);
    const found = r ? locateQuote(ctx.validate, r.text, c.explanation.citation.quote) : null;
    if (!r || !found) return fail(9, "explanation", "the explanation's citation isn't found in the source");
    if (!sources.some((s) => s.resourceId === r.id && s.start === found.start)) {
      sources.push({ resourceId: r.id, contentHash: r.contentHash, textHash: r.textHash ?? r.contentHash, start: found.start, end: found.end, quote: c.explanation.citation.quote, quoteValid: true });
    }
    pass(9, "explanation");
  } else skip(9, "explanation", "no explanation");

  const item: LearningItem = {
    id: c.id,
    version: c.version,
    courseRef: c.courseRef,
    familyId: c.familyId,
    kind: c.kind,
    stem: c.stem,
    options: c.options,
    key: c.key,
    ...(c.unit ? { unit: c.unit } : {}),
    keyIdeas: c.keyIdeas,
    explanation: c.explanation?.text ?? null,
    tempting: c.tempting,
    bloom: c.bloom,
    bPrior: difficultyPrior(c.kind, c.bloom),
    tier: c.tier,
    sourceTerm: c.sourceTerm,
    origin: c.origin,
    status: "active",
    statusReason: null,
    generator: c.generator,
    createdAt: at,
  };
  return { accepted: true, item, sources, tags, checks: toChecks(log, at, v), labels: labelsFor(c, log, v), log, dropped: null };
}

function toChecks(log: StageLog[], at: string, v: SupportVerdict | undefined): ItemCheck[] {
  return log.map((l) => ({
    check: l.name,
    method: l.name === "support" && v ? v.method : "code",
    outcome: l.outcome,
    ...(l.reason ? { detail: { reason: l.reason } } : {}),
    createdAt: at,
  }));
}

/** The check line: only the stages that ran and passed, plus the tier. */
export function labelsFor(c: Pick<CandidateItem, "kind" | "tier" | "sourceTerm">, log: StageLog[], v: SupportVerdict | undefined): string[] {
  const passed = (name: StageName) => log.some((l) => l.name === name && l.outcome === "pass");
  const out: string[] = [];
  if (passed("quote")) out.push(LABEL.quoteFound);
  if (passed("executed")) out.push(LABEL.executed);
  const choice = c.kind === "mc" || c.kind === "tf";
  if (passed("support") && v) {
    if (choice && v.optionsPass && v.method === "jev") out.push(LABEL.oneKeyJev);
    else if (choice && passed("schema")) out.push(LABEL.oneKeyStructure);
    if (v.method === "jev") out.push(v.shadow ? LABEL.supportJevShadow : LABEL.supportJev);
    else out.push(supportByModel(v.method.slice("model:".length), v.sameModel ?? false));
  } else {
    if (choice && passed("schema")) out.push(LABEL.oneKeyStructure);
    out.push(LABEL.supportNotChecked);
  }
  out.push(tierLabel(c.tier, c.sourceTerm));
  return out;
}

export interface FamilyResult {
  familyId: string;
  accepted: PipelineResult[];
  dropped: PipelineResult[];
}

/**
 * Accept a family of variants (MC and typed forms of one key idea). The variants
 * must share family_id, key ideas and sources; each runs the stages on its own,
 * and a family with a failing variant keeps only its passing variants.
 */
export function acceptFamily(variants: CandidateItem[], ctx: PipelineContext, supportById: Record<string, SupportVerdict> = {}): FamilyResult {
  if (!variants.length) throw new Error("an empty family");
  const first = variants[0]!;
  const shared = (v: CandidateItem) =>
    v.familyId === first.familyId &&
    JSON.stringify(v.keyIdeas) === JSON.stringify(first.keyIdeas) &&
    JSON.stringify(v.sources) === JSON.stringify(first.sources);
  const accepted: PipelineResult[] = [];
  const dropped: PipelineResult[] = [];
  const seen = [...ctx.seenStems];
  for (const v of variants) {
    if (!shared(v)) {
      dropped.push({ accepted: false, item: null, sources: [], tags: [], checks: [], labels: [], log: [], dropped: { stage: 2, name: "schema", reason: "a variant must share the family's ID, key ideas and sources" } });
      continue;
    }
    const r = runPipeline(v, { ...ctx, seenStems: seen, support: supportById[v.id] ?? ctx.support });
    (r.accepted ? accepted : dropped).push(r);
  }
  return { familyId: first.familyId, accepted, dropped };
}
