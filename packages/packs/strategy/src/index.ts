/**
 * "Build my strategy" (D57): one checked call on the student's own client, only when they click.
 * Code derives the observations (grade trends, weak topics under high-weight items, exam readiness,
 * due reviews); the model turns them into 1–5 concrete actions with timing, citing the observations
 * it used; code checks every number against the cited observations and refuses outcome predictions.
 * The call goes through the same job as every pack (cache first, consent via `maySend`, receipts,
 * the ledger, retry then escalation). The cache key is the observations' hash: an unchanged course
 * is a cache hit at 0 tokens.
 */
import { z } from "zod";
import type { PackScope, Store } from "@magic/contracts";
import type { CourseCoreStore } from "../../../contracts/src/course-core";
import type { ModelRunner } from "../../../runner/src/index";
import { buildPrompt, definePack, packCacheKey, type ArtifactStore, type CourseFrame, type LedgerStore } from "../../core/src/index";
import { runPack } from "../../../core/src/jobs/pack";
import { authorizer } from "../../../core/src/intent/consent";
import { payloadScrubber } from "../../../core/src/identity";
import { createPipelineReferences } from "../../../core/src/graph/references-port";
import { isPipelineStore } from "../../../core/src/graph/course-index";
import { createCurrentReferences } from "../../../learning/src/analytics/references";
import type { LearningStore } from "../../../learning/src/store";
import { checkStrategy, observationHash, type Observation, type StrategyOutput } from "../../../learning/src/strategy/index";
import { courseGradesData } from "../../../learning/src/strategy/inputs";

export interface StrategyInput {
  course: string;
  observations: Observation[];
}

export const strategyOutputSchema = z
  .object({
    actions: z
      .array(
        z
          .object({
            text: z.string().min(1).max(300),
            when: z.string().min(1).max(80),
            basedOn: z.array(z.string().min(1).max(8)).min(1).max(5),
          })
          .strict(),
      )
      .min(1)
      .max(5),
  })
  .strict();

export const STRATEGY_SYSTEM = [
  "You write a short study strategy for one university course, for the student themselves.",
  "Use ONLY the numbered observations you are given; they were computed by code from the student's own captured scores and practice. Do not add facts, topics, dates or numbers that are not in them.",
  "Return 2 to 5 concrete actions. Each says what to do and when (\"today\", \"this week\", \"before Midterm 2\"), and cites in basedOn the observation IDs it rests on.",
  "Every number you write must appear in an observation you cite. Prefer words to numbers.",
  "Never predict a grade, a score or an outcome, and never compare the student to anyone else. No game mechanics or rewards.",
  "Plain, calm wording. Return only JSON matching the schema.",
].join("\n");

const PREDICTION = /\b(?:will|going to|should)\s+(?:get|earn|score|pass|fail|end up)\b|\bpredict|\bguarantee|\bchance of\b|\bbetter than (?:other|most|your class)/i;

export const strategyPack = definePack<StrategyInput, StrategyOutput>({
  id: "strategy",
  version: "v1",
  tier: "pass",
  system: STRATEGY_SYSTEM,
  template: (i) => [`Course: ${i.course}`, "Observations:", ...i.observations.map((o) => `${o.id}: ${o.text}`), "", "Write the strategy."].join("\n"),
  schema: strategyOutputSchema,
  checks: [
    (output, input) => checkStrategy(output, input.observations),
    (output) => output.actions.flatMap((a, i) => (PREDICTION.test(`${a.text} ${a.when}`) ? [`action ${i + 1} predicts an outcome`] : [])),
  ],
  cacheKey: (i) => observationHash(i.observations),
  categories: ["grades", "course_text"],
  intent: "study strategy from code-derived observations",
});

export type StrategyStore = Store & CourseCoreStore & { learning: LearningStore };
export interface StrategyDeps {
  store: StrategyStore;
  runner: () => ModelRunner | null | Promise<ModelRunner | null>;
  artifacts: ArtifactStore;
  ledger: LedgerStore;
  now?: () => Date;
}

export type StrategyRunStatus = "done" | "empty" | "blocked" | "no_client" | "needs_student" | "paused" | "failed";
export interface StrategyRunResult {
  status: StrategyRunStatus;
  message: string;
  pack: "strategy";
  courseRef: string | null;
  observations: Observation[];
  observationHash: string | null;
  actions: StrategyOutput["actions"];
  cached: boolean;
  tokens: { in: number; cached: number; out: number };
  receiptIds: string[];
  checkErrors?: string[];
}

const zero = () => ({ in: 0, cached: 0, out: 0 });

/** The `pack` seam's "strategy": the observations by code, then one checked call (or a cache hit). */
export async function buildStrategy(deps: StrategyDeps, scope: PackScope, signal?: AbortSignal): Promise<StrategyRunResult> {
  const now = deps.now ?? (() => new Date());
  const base = { pack: "strategy" as const, observations: [] as Observation[], observationHash: null, actions: [], cached: false, tokens: zero(), receiptIds: [] as string[] };
  // FDB-003: the scope names no account, so the course must belong to exactly one.
  const accounts = [...new Set(deps.store.sources().filter((s) => s.courseId === scope.courseId).map((s) => s.accountScope))];
  if (!accounts.length) return { ...base, status: "empty", message: "That course isn't captured yet.", courseRef: null };
  if (accounts.length > 1) return { ...base, status: "blocked", message: "Two accounts have a course with this ID; open the course from its own account.", courseRef: null };
  const accountScope = accounts[0]!;
  const ref = `${accountScope}:${scope.courseId}`;
  const store = deps.store;
  const references = isPipelineStore(store) ? createPipelineReferences(store) : createCurrentReferences(store);
  const { data } = courseGradesData({ store: store.learning, ref, courseId: scope.courseId, references, now: now() }, store, accountScope);
  const observations = data.observations;
  if (!observations.length)
    return { ...base, status: "empty", message: "There isn't enough captured work or practice to plan from yet.", courseRef: ref };
  const withObs = { ...base, observations, observationHash: data.observationHash, courseRef: ref };
  const runner = await deps.runner();
  const input: StrategyInput = { course: data.grades.courseName, observations };
  const frame: CourseFrame = { courseId: ref, course: data.grades.courseName, skeleton: `Course: ${data.grades.courseName}`, policy: "" };
  const cachedOnly = (): StrategyRunResult => ({ ...withObs, status: "no_client", message: "Connect your AI first: choose Claude or Codex in Settings and sign in, then try again." });
  const receiptIds: string[] = [];
  // Hosted clients get the same identity scrubbing as every pack: course and item titles can carry names.
  const hosted = runner ? runner.client !== "local" : store.privacy().mode !== "local_only";
  const scrubber = payloadScrubber(store, hosted, accountScope);
  const scrub = (value: string) => scrubber.field(value, scope.courseId);
  const text = scrub(strategyPack.template(input));
  const authorize = authorizer(
    store,
    { purpose: "Write a study strategy from code-derived observations", course: data.grades.courseName, title: "strategy", text, policy: "", resourceIds: [], characters: STRATEGY_SYSTEM.length + text.length },
    () => now().toISOString(),
    receiptIds,
  );
  if (!runner) {
    // A cached strategy for these exact observations still answers without a client.
    const prompt = buildPrompt(strategyPack, frame, input, []);
    const hit = deps.artifacts.get(packCacheKey(strategyPack, prompt.systemPrompt, input, []));
    const parsed = hit && strategyOutputSchema.safeParse(hit.output);
    if (parsed?.success && !checkStrategy(parsed.data, observations).length)
      return { ...withObs, status: "done", message: "Your strategy for these observations.", actions: parsed.data.actions, cached: true };
    return cachedOnly();
  }
  const result = await runPack(
    {
      runner,
      artifacts: deps.artifacts,
      ledger: deps.ledger,
      authorize,
      beforeCall: (call) => ({ ...call, courseId: hosted ? undefined : call.courseId, systemPrompt: scrub(call.systemPrompt), input: scrub(call.input) }),
      now: () => now().getTime(),
    },
    strategyPack,
    frame,
    input,
    [],
    { lane: "interactive", scope: "course", ...(signal ? { signal } : {}) },
  );
  if (result.status === "blocked") return { ...withObs, status: "blocked", message: result.reason, receiptIds };
  if (result.status === "needs_student")
    return { ...withObs, status: "needs_student", message: "The strategy didn't pass the app's number checks. Try again.", checkErrors: result.checkErrors, receiptIds };
  if (result.status !== "done") return { ...withObs, status: result.status, message: result.message, receiptIds };
  // Re-check on every read, cached or fresh: the observations are the ones computed now.
  const errors = checkStrategy(result.artifact.output, observations);
  if (errors.length) return { ...withObs, status: "needs_student", message: "The strategy didn't pass the app's number checks. Try again.", checkErrors: errors, receiptIds };
  return {
    ...withObs,
    status: "done",
    message: result.cached ? "Your strategy for these observations (saved, no new AI call)." : "Your strategy, checked against these observations.",
    actions: result.artifact.output.actions,
    cached: result.cached,
    tokens: result.cached ? zero() : result.artifact.usage,
    receiptIds,
  };
}
