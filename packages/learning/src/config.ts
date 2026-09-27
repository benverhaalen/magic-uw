// N00: the one versioned source of every knowledge-model threshold (KM-12).
// Every constant is a starting value that has not been validated (spec §5.9);
// each carries `validated: false` so the "How this works" panel can say so.
import { z } from "zod";

/** A constant with its validation status. */
export interface Constant<T> {
  value: T;
  validated: boolean;
}

const unvalidated = <T>(value: T): Constant<T> => ({ value, validated: false });

export type ItemFormat = "mc" | "tf" | "typed" | "cloze" | "numeric";
export type Bloom = "remember" | "understand" | "apply" | "analyse" | "evaluate";
export type Difficulty = "warmup" | "normal" | "push";

export const CONFIG = {
  version: "km-0.1",
  fsrsVersion: "5.4.2",
  // §5.3 update rules
  alpha: unvalidated(1.0),
  beta: unvalidated(0.06),
  s0: unvalidated(1.5),
  bRef: unvalidated(0.5),
  tagWeightPrimary: unvalidated(1.0),
  tagWeightSecondary: unvalidated(0.5),
  exposureFirst: unvalidated(1.0),
  exposureSeenBefore: unvalidated(0.5),
  // §5.8 difficulty priors
  bFormat: unvalidated<Record<ItemFormat, number>>({ tf: -1.0, mc: -0.5, cloze: 0.0, typed: 0.5, numeric: 0.5 }),
  bBloom: unvalidated<Record<Bloom, number>>({ remember: -0.25, understand: 0, apply: 0.25, analyse: 0.5, evaluate: 0.5 }),
  // §5.5 band cut-offs
  solidMinN: unvalidated(8),
  solidEnterPLow: unvalidated(0.75),
  solidExitPLow: unvalidated(0.65),
  solidMinR: unvalidated(0.8),
  /** Solid needs at least this many unassisted right answers in a recall format (typed, cloze, numeric): §5.5, H4. */
  solidMinRecall: unvalidated(1),
  // §5.6 rule windows and thresholds
  accWindow: unvalidated(10),
  r1MinN: unvalidated(3),
  r1AccBelow: unvalidated(0.7),
  r1PHatEnter: unvalidated(0.6),
  r1PHatExit: unvalidated(0.65),
  r1MostlyMissed: unvalidated(0.4),
  r2MaxN: unvalidated(3),
  r2HorizonDays: unvalidated(14),
  r3WindowDays: unvalidated(7),
  r4WindowDays: unvalidated(14),
  r4MinConfidence: unvalidated(0.67),
  r5RequestRetention: unvalidated(0.9),
  r5Margin: unvalidated(0.1),
  r6WindowDays: unvalidated(30),
  r6MinPerGroup: unvalidated(3),
  r6Gap: unvalidated(0.34),
  // §5.7 priority weights and difficulty bands
  needNotSeen: unvalidated(0.6),
  rulesPerFire: unvalidated(0.25),
  rulesCap: unvalidated(0.75),
  urgencyAmplitude: unvalidated(2),
  urgencyTauDays: unvalidated(7),
  difficultyBands: unvalidated<Record<Difficulty, [number, number]>>({
    warmup: [0.75, 0.9],
    normal: [0.6, 0.8],
    push: [0.45, 0.65],
  }),
  // §5.9 "also starting values"
  retrievalSupportThreshold: unvalidated(1.0),
  minutesPerItem: unvalidated<Record<ItemFormat | "card", number>>({
    card: 0.5,
    tf: 0.75,
    mc: 0.75,
    cloze: 1.5,
    typed: 2,
    numeric: 2,
  }),
  // §5.4 / ST-2 FSRS
  preExamWindowDays: unvalidated(14),
  newCardsPerDay: unvalidated(15),
} as const satisfies Record<string, unknown>;

export type KnowledgeConfig = typeof CONFIG;

const num = z.object({ value: z.number().finite(), validated: z.boolean() }).strict();
const prob = z.object({ value: z.number().gt(0).lt(1), validated: z.boolean() }).strict();
const posInt = z.object({ value: z.number().int().positive(), validated: z.boolean() }).strict();
const days = posInt;
const record = <K extends string>(keys: readonly [K, ...K[]], value: z.ZodType<number>) =>
  z
    .object({
      value: z.object(Object.fromEntries(keys.map((k) => [k, value])) as Record<K, z.ZodType<number>>).strict(),
      validated: z.boolean(),
    })
    .strict();
const band = z
  .tuple([z.number().gt(0).lt(1), z.number().gt(0).lt(1)])
  .refine(([lo, hi]) => lo < hi, "band low must be below band high");

const formats = ["mc", "tf", "typed", "cloze", "numeric"] as const;

export const configSchema = z
  .object({
    version: z.string().regex(/^km-\d+\.\d+$/),
    fsrsVersion: z.string().min(1),
    alpha: num,
    beta: num,
    s0: num,
    bRef: num,
    tagWeightPrimary: num,
    tagWeightSecondary: num,
    exposureFirst: num,
    exposureSeenBefore: num,
    bFormat: record(formats, z.number().finite()),
    bBloom: record(["remember", "understand", "apply", "analyse", "evaluate"] as const, z.number().finite()),
    solidMinN: posInt,
    solidEnterPLow: prob,
    solidExitPLow: prob,
    solidMinR: prob,
    solidMinRecall: posInt,
    accWindow: posInt,
    r1MinN: posInt,
    r1AccBelow: prob,
    r1PHatEnter: prob,
    r1PHatExit: prob,
    r1MostlyMissed: prob,
    r2MaxN: posInt,
    r2HorizonDays: days,
    r3WindowDays: days,
    r4WindowDays: days,
    r4MinConfidence: prob,
    r5RequestRetention: prob,
    r5Margin: prob,
    r6WindowDays: days,
    r6MinPerGroup: posInt,
    r6Gap: prob,
    needNotSeen: prob,
    rulesPerFire: prob,
    rulesCap: prob,
    urgencyAmplitude: num,
    urgencyTauDays: num,
    difficultyBands: z
      .object({
        value: z.object({ warmup: band, normal: band, push: band }).strict(),
        validated: z.boolean(),
      })
      .strict(),
    retrievalSupportThreshold: num,
    minutesPerItem: record([...formats, "card"] as const, z.number().positive()),
    preExamWindowDays: days,
    newCardsPerDay: posInt,
  })
  .strict()
  .refine((c) => c.solidExitPLow.value < c.solidEnterPLow.value, "Solid exit must be below Solid entry")
  .refine((c) => c.r1PHatEnter.value < c.r1PHatExit.value, "R1 entry must be below R1 exit");

/** Validate a configuration; throws a ZodError naming the failing constant. */
export function validateConfig(config: unknown): KnowledgeConfig {
  return configSchema.parse(config) as KnowledgeConfig;
}

/** Plain numeric view of a configuration, for the engines. */
export type KmParams = { [K in keyof KnowledgeConfig]: KnowledgeConfig[K] extends Constant<infer T> ? T : KnowledgeConfig[K] };

export function params(config: KnowledgeConfig = CONFIG): KmParams {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(config)) {
    out[key] = typeof entry === "object" && entry !== null && "value" in entry ? (entry as Constant<unknown>).value : entry;
  }
  return out as KmParams;
}

/** The names of every constant that is still unvalidated (for "How this works"). */
export function unvalidatedConstants(config: KnowledgeConfig = CONFIG): string[] {
  return Object.entries(config)
    .filter(([, e]) => typeof e === "object" && e !== null && "validated" in e && !(e as Constant<unknown>).validated)
    .map(([k]) => k);
}
