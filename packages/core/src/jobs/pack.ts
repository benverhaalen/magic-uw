import { randomUUID } from "node:crypto";
import {
  RunnerError,
  type ClientId,
  type BackendCall,
  type Lane,
  type ModelRunner,
  type RunnerErrorKind,
} from "../../../runner/src/index";
import {
  buildPrompt,
  packCacheKey,
  type ArtifactStore,
  type CourseFrame,
  type LearningArtifact,
  type LedgerStore,
  type PackSpec,
  type Passage,
} from "../../../packs/core/src/index";

class PackAuthorizationError extends Error {}

/** The consent recipient each route sends to (contracts' `consentRecipientSchema`). */
const recipientOf: Record<ClientId, string> = {
  claude: "claude",
  anthropic: "claude",
  codex: "codex",
  openai: "chatgpt",
  openrouter: "openrouter",
  gemini: "gemini",
  local: "local",
};

export interface PackJobDeps {
  runner: ModelRunner;
  artifacts: ArtifactStore;
  ledger: LedgerStore;
  /** The egress decision (`maySend` for the current settings). Checked on every call. */
  authorize: (recipient: string, categories: string[]) => { allowed: boolean; reason: string };
  beforeCall?: (call: BackendCall) => BackendCall;
  validate?: () => void;
  cacheKey?: string;
  /** Jev's typed judgments on the output's items; absent in fully local mode. */
  jev?: (
    gateId: string,
    items: { id: string; text: string }[],
    signal?: AbortSignal,
  ) => Promise<{ id: string; pass: boolean }[]>;
  now?: () => number;
}
export interface PackJobOptions {
  /** `interactive` is on-demand (the student asked); `background` is budgeted and pausable. */
  lane: Exclude<Lane, "escalation">;
  scope?: string;
  signal?: AbortSignal;
}
export type PackJobResult<O> =
  | { status: "done"; artifact: LearningArtifact & { output: O }; cached: boolean }
  /** Retry and escalation both failed the checks: the student decides what happens next. */
  | { status: "needs_student"; question: string; options: ("retry" | "narrow_scope" | "skip")[]; checkErrors: string[] }
  /** Background work waits: a usage limit, the daily budget, or a pause already in force. */
  | { status: "paused"; kind: RunnerErrorKind; message: string; resetsAt?: string }
  | { status: "blocked"; reason: string }
  | { status: "failed"; kind: RunnerErrorKind; message: string; resetsAt?: string };

/**
 * Runs one pack (T13): cache first (a hit spends no tokens), then the egress check, then one
 * checked call through the runner (retry, then escalate), then Jev's gates. Stores the artifact
 * and writes a ledger row per call.
 */
export async function runPack<I, O>(
  deps: PackJobDeps,
  pack: PackSpec<I, O>,
  frame: CourseFrame,
  input: I,
  passages: Passage[],
  options: PackJobOptions,
): Promise<PackJobResult<O>> {
  const now = deps.now ?? Date.now;
  const prompt = buildPrompt(pack, frame, input, passages);
  const cacheKey = deps.cacheKey ?? packCacheKey(pack, prompt.systemPrompt, input, passages);
  const hit = deps.artifacts.get(cacheKey);
  if (hit) {
    const output = pack.schema.safeParse(hit.output);
    if (output.success) {
      deps.ledger.append({
        at: new Date(now()).toISOString(),
        pack: pack.id,
        packVersion: pack.version,
        courseId: frame.courseId,
        cacheKey,
        outcome: "cache_hit",
        usage: { in: 0, cached: 0, out: 0 },
      });
      return { status: "done", artifact: { ...hit, output: output.data }, cached: true };
    }
  }
  const permission = deps.authorize(recipientOf[deps.runner.client], pack.categories);
  if (!permission.allowed) return { status: "blocked", reason: permission.reason };

  const context = { passages };
  let result;
  try {
    result = await deps.runner.run({
      beforeCall: (call) => {
        const permission = deps.authorize(recipientOf[deps.runner.client], pack.categories);
        if (!permission.allowed) throw new PackAuthorizationError(permission.reason);
        return deps.beforeCall ? deps.beforeCall(call) : call;
      },
      afterCall: deps.validate,
      pack: { id: pack.id, version: pack.version },
      systemPrompt: prompt.systemPrompt,
      input: prompt.input,
      schema: pack.schema,
      tier: pack.tier,
      ...(pack.escalate === false ? { escalate: false } : {}),
      budget: pack.budget,
      signal: options.signal,
      lane: options.lane,
      courseId: frame.courseId,
      context: {
        course: frame.course,
        profile: frame.profile,
        scope: options.scope,
        intent: pack.intent,
        sources: passages.map((p) => p.sourceId),
      },
      check: (output) => (pack.checks ?? []).flatMap((check) => check(output, input, context)),
      ledger: (entry) => deps.ledger.append({ ...entry, courseId: frame.courseId, cacheKey }),
    });
  } catch (error) {
    if (error instanceof PackAuthorizationError) return { status: "blocked", reason: error.message };
    if (!(error instanceof RunnerError)) throw error;
    if (error.kind === "check_failed")
      return {
        status: "needs_student",
        question: `The ${pack.id} result didn't pass the app's checks, ${pack.escalate === false ? "even after a retry" : "even with a stronger model"}. Try again, narrow the scope, or skip it?`,
        options: ["retry", "narrow_scope", "skip"],
        checkErrors: error.checkErrors,
      };
    if (
      options.lane === "background" &&
      (error.kind === "usage_limit" || error.kind === "budget_exhausted" || error.kind === "background_paused")
    )
      return { status: "paused", kind: error.kind, ...studentFacing(error) };
    return { status: "failed", kind: error.kind, ...studentFacing(error) };
  }

  const gates: LearningArtifact["gates"] = [];
  for (const gate of pack.jevGates ?? []) {
    const items = gate.items(result.output);
    if (!deps.jev || !items.length || !deps.authorize("jev", pack.categories).allowed) {
      gates.push({ id: gate.id, status: "skipped", failed: [] });
      continue;
    }
    const verdicts = await deps.jev(gate.id, items, options.signal);
    const failed = items.filter((i) => verdicts.find((v) => v.id === i.id)?.pass !== true).map((i) => i.id);
    gates.push({ id: gate.id, status: failed.length ? "failed" : "passed", failed });
  }
  const artifact: LearningArtifact & { output: O } = {
    id: randomUUID(),
    packId: pack.id,
    packVersion: pack.version,
    courseId: frame.courseId,
    cacheKey,
    output: result.output,
    // The runner returns only output that passed every code check; a failed gate still flags it.
    verified: gates.every((g) => g.status !== "failed"),
    gates,
    sources: passages.map((p) => p.sourceId),
    client: result.client,
    model: result.model,
    tier: result.tier,
    usage: result.usage,
    createdAt: new Date(now()).toISOString(),
  };
  deps.validate?.();
  deps.artifacts.put(artifact);
  return { status: "done", artifact, cached: false };
}

/**
 * Study time (spec §2): read what a pack already produced. Takes no runner, so it cannot
 * call a model; a miss returns null and the caller offers to generate in the background.
 */
export function readPackArtifact<I, O>(
  artifacts: ArtifactStore,
  pack: PackSpec<I, O>,
  frame: CourseFrame,
  input: I,
  passages: Passage[],
): (LearningArtifact & { output: O }) | null {
  const prompt = buildPrompt(pack, frame, input, passages);
  const hit = artifacts.get(packCacheKey(pack, prompt.systemPrompt, input, passages));
  if (!hit) return null;
  const output = pack.schema.safeParse(hit.output);
  return output.success ? { ...hit, output: output.data } : null;
}

/**
 * owner: client-detection (e2e harness). The student's message for a failed run, with the reset
 * time the client stated when it gave one (a usage limit), so the student learns when to retry.
 */
function studentFacing(error: RunnerError): { message: string; resetsAt?: string } {
  if (!error.resetsAt) return { message: error.studentMessage };
  return { message: `${error.studentMessage} Your plan says it resets ${error.resetsAt}.`, resetsAt: error.resetsAt };
}
