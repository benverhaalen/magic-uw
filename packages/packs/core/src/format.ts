import { z } from "zod";
import {
  createBackgroundBudget,
  createModelRunner,
  sha256,
  type BackgroundBudget,
  type ModelBackend,
  type ModelRunner,
  type RunBudget,
  type Tier,
} from "../../../runner/src/index";

/** Passages code assembled for one call. Checks ground quotes against these, never the model. */
export interface Passage {
  sourceId: string;
  text: string;
}
export interface CheckContext {
  passages: Passage[];
}
export type PackCheck<I, O> = (output: O, input: I, context: CheckContext) => string[];

/** A typed judgment Jev makes on the output (spec E1). Declared by the pack, run by the job. */
export interface JevGate<O> {
  id: string;
  items: (output: O) => { id: string; text: string }[];
}

/** Spec E1: a versioned pack. Every field that shapes the prompt or the output is here. */
export interface PackSpec<I, O> {
  id: string;
  version: string;
  /** Pass first everywhere (F5); the runner escalates on failed checks. */
  tier: Tier;
  /** The pack's role text: the first, stable part of the prefix. */
  system: string;
  /** The question, rendered last (O8). */
  template: (input: I) => string;
  schema: z.ZodType<O>;
  checks?: PackCheck<I, O>[];
  jevGates?: JevGate<O>[];
  /** The input fields that determine the output; hashed with the pack, version and prefix. */
  cacheKey: (input: I) => unknown;
  /** Data categories the call sends, for the egress decision (spec G). */
  categories: string[];
  budget?: RunBudget;
  intent?: string;
}

export function definePack<I, O>(spec: PackSpec<I, O>): PackSpec<I, O> {
  if (!/^[a-z][a-z0-9-]*$/.test(spec.id)) throw new Error(`Pack id ${spec.id} must be kebab-case.`);
  if (!/^v\d+$/.test(spec.version)) throw new Error(`Pack version ${spec.version} must look like v1.`);
  const issues = strictSchemaIssues(z.toJSONSchema(spec.schema, { io: "output" }));
  if (issues.length) throw new Error(`Pack ${spec.id} schema: ${issues.join("; ")}`);
  return spec;
}

/**
 * OpenAI-style strict structured output (Codex, OpenAI, OpenRouter) needs every object closed
 * and every property required; optional values must be nullable instead. Checked at definition.
 */
export function strictSchemaIssues(schema: unknown, path = "$"): string[] {
  if (!schema || typeof schema !== "object") return [];
  const s = schema as Record<string, unknown>;
  const issues: string[] = [];
  if (s.type === "object" && s.properties && typeof s.properties === "object") {
    const keys = Object.keys(s.properties);
    const required = Array.isArray(s.required) ? (s.required as string[]) : [];
    if (s.additionalProperties !== false) issues.push(`${path} must be .strict()`);
    for (const k of keys) if (!required.includes(k)) issues.push(`${path}.${k} must be required (use .nullable())`);
    for (const k of keys) issues.push(...strictSchemaIssues((s.properties as Record<string, unknown>)[k], `${path}.${k}`));
  }
  if (s.items) issues.push(...strictSchemaIssues(s.items, `${path}[]`));
  for (const key of ["anyOf", "oneOf", "allOf"])
    if (Array.isArray(s[key])) (s[key] as unknown[]).forEach((v, i) => issues.push(...strictSchemaIssues(v, `${path}.${key}[${i}]`)));
  return issues;
}

/** What the prefix carries about the course: the skeleton and the policy, stable between calls. */
export interface CourseFrame {
  courseId: string;
  course: string;
  profile?: string;
  skeleton: string;
  policy: string;
}

const lf = (text: string) => text.replace(/\r\n?/g, "\n").trimEnd();
/**
 * O8: system, then the course skeleton and policy, then the question last. The prefix depends
 * only on the pack and the course, so it is byte-identical across calls for the same course.
 */
export function buildPrompt<I, O>(
  pack: PackSpec<I, O>,
  frame: CourseFrame,
  input: I,
  passages: Passage[],
): { systemPrompt: string; input: string } {
  const systemPrompt = [
    lf(pack.system),
    `## Course\n${lf(frame.skeleton)}`,
    `## Course AI policy\n${lf(frame.policy) || "No policy was found; coach conservatively."}`,
  ].join("\n\n");
  const sources = passages.map((p) => `<passage id="${p.sourceId}">\n${lf(p.text)}\n</passage>`).join("\n");
  return { systemPrompt, input: `${sources ? `${sources}\n\n` : ""}${lf(pack.template(input))}` };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}
/** Same pack version, course prefix, key fields and passages → same key → no second call. */
export function packCacheKey<I, O>(
  pack: PackSpec<I, O>,
  systemPrompt: string,
  input: I,
  passages: Passage[],
): string {
  return sha256(
    canonical({
      pack: pack.id,
      version: pack.version,
      prefix: sha256(systemPrompt),
      key: pack.cacheKey(input),
      passages: passages.map((p) => [p.sourceId, sha256(p.text)]),
    }),
  );
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();
/**
 * A check: every quote must appear verbatim (whitespace collapsed) in the passage it cites.
 * An invented quote fails the check, so it is retried, escalated, then put to the student;
 * it is never stored as verified.
 */
export function quotesGrounded<I, O>(
  select: (output: O) => { sourceId: string; quote: string }[],
): PackCheck<I, O> {
  return (output, _input, context) => {
    const bySource = new Map(context.passages.map((p) => [p.sourceId, collapse(p.text)]));
    const errors: string[] = [];
    for (const { sourceId, quote } of select(output)) {
      const text = bySource.get(sourceId);
      if (text === undefined) errors.push(`quote cites ${sourceId}, which is not among the passages`);
      else if (!quote.trim() || !text.includes(collapse(quote)))
        errors.push(`quote not found verbatim in ${sourceId}: "${collapse(quote).slice(0, 80)}"`);
    }
    return errors;
  };
}

/** The configuration T13 names: a daily background token budget. */
export interface PackRuntimeConfig {
  dailyBackgroundTokens: number;
  /** How long background work pauses after a provider usage limit. */
  usageLimitPauseMs?: number;
}
/** About a tenth of the §4 term estimate per day; the student changes it in settings. */
export const DEFAULT_PACK_CONFIG: PackRuntimeConfig = { dailyBackgroundTokens: 150_000 };

export function createPackRuntime(
  backend: ModelBackend,
  config: PackRuntimeConfig = DEFAULT_PACK_CONFIG,
  now?: () => number,
): { runner: ModelRunner; budget: BackgroundBudget } {
  const budget = createBackgroundBudget({
    dailyBackgroundTokens: config.dailyBackgroundTokens,
    pauseMs: config.usageLimitPauseMs,
    now,
  });
  return { runner: createModelRunner({ backend, budget, now }), budget };
}
