import {
  RunnerError,
  type BackendCall,
  type BackendResult,
  type Lane,
  type LedgerEntry,
  type LedgerOutcome,
  type LedgerSink,
  type ModelBackend,
  type ModelRunner,
  type RunRequest,
  type RunResult,
  type Tier,
  type Usage,
} from "./types";
import {
  addUsage,
  estimateTokens,
  formatAskHeader,
  issuesOf,
  jsonSchemaOf,
  zeroUsage,
} from "./util";

export interface BudgetState {
  day: string;
  spent: number;
  limit: number;
  pausedUntil: number | null;
}
/**
 * The background budget (D36, T13): a daily token limit on work the student didn't start, and
 * a pause after a provider usage limit. Interactive and escalation asks are never budgeted here;
 * the student started them.
 */
export interface BackgroundBudget {
  admit(lane: Lane, estimatedTokens: number): void;
  record(lane: Lane, usage: Usage): void;
  pauseForUsageLimit(): void;
  resume(): void;
  state(): BudgetState;
}
export function createBackgroundBudget(options: {
  dailyBackgroundTokens: number;
  pauseMs?: number;
  now?: () => number;
}): BackgroundBudget {
  const now = options.now ?? Date.now;
  const pauseMs = options.pauseMs ?? 60 * 60 * 1000;
  let day = "";
  let spent = 0;
  let pausedUntil: number | null = null;
  const today = () => {
    const d = new Date(now());
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (key !== day) {
      day = key;
      spent = 0;
    }
    return key;
  };
  return {
    admit(lane, estimated) {
      if (lane !== "background") return;
      today();
      if (pausedUntil !== null && now() < pausedUntil)
        throw new RunnerError("background_paused");
      pausedUntil = null;
      if (spent + estimated > options.dailyBackgroundTokens)
        throw new RunnerError("budget_exhausted");
    },
    record(lane, usage) {
      if (lane !== "background") return;
      today();
      spent += usage.in + usage.out;
    },
    pauseForUsageLimit() {
      pausedUntil = now() + pauseMs;
    },
    resume() {
      pausedUntil = null;
    },
    state() {
      return { day: today(), spent, limit: options.dailyBackgroundTokens, pausedUntil };
    },
  };
}

export interface RunnerOptions {
  backend: ModelBackend;
  ledger?: LedgerSink;
  budget?: BackgroundBudget;
  now?: () => number;
  defaultTimeoutMs?: number;
}

function retryInput(input: string, errors: string[]): string {
  return `${input}\n\n[checks] Your previous answer failed these checks. Return a corrected answer:\n${errors
    .map((e) => `- ${e}`)
    .join("\n")}`;
}

/**
 * The one-call runner (spec E2, T12): validate every output with code, retry once at the same
 * tier with the check errors, then escalate pass → strong once. A usage limit is never retried
 * or escalated; on the background lane it pauses background work. One ledger row per call.
 */
export function createModelRunner(options: RunnerOptions): ModelRunner {
  const now = options.now ?? Date.now;
  const backend = options.backend;
  return {
    client: backend.client,
    async run<T>(request: RunRequest<T>): Promise<RunResult<T>> {
      const started = now();
      const lane: Lane = request.lane ?? "background";
      const maxOut = request.budget?.maxOutputTokens;
      const input = request.context
        ? `${formatAskHeader(request.context, request.pack, maxOut)}\n${request.input}`
        : request.input;
      const estimate = estimateTokens(request.systemPrompt + input);
      const ledger = (
        e: Omit<LedgerEntry, "at" | "pack" | "packVersion" | "client" | "lane"> & { lane?: Lane },
      ) => {
        const entry: LedgerEntry = {
          at: new Date(now()).toISOString(),
          pack: request.pack.id,
          packVersion: request.pack.version,
          client: backend.client,
          ...e,
          lane: e.lane ?? lane,
        };
        options.ledger?.(entry);
        request.ledger?.(entry);
      };
      const refuse = (error: RunnerError): never => {
        ledger({
          tier: request.tier,
          model: "",
          usage: zeroUsage(),
          latencyMs: 0,
          attempt: 0,
          escalated: false,
          outcome: "refused",
          checkErrors: [],
          errorKind: error.kind,
        });
        throw error;
      };
      if (request.signal?.aborted) throw new RunnerError("aborted");
      if (request.budget?.maxInputTokens && estimate > request.budget.maxInputTokens)
        refuse(new RunnerError("too_large", `about ${estimate} tokens`));
      try {
        options.budget?.admit(lane, estimate + (maxOut ?? 0));
      } catch (error) {
        if (error instanceof RunnerError) refuse(error);
        throw error;
      }
      const jsonSchema = jsonSchemaOf(request.schema);
      const plan: Tier[] =
        request.tier === "pass" ? ["pass", "pass", "strong"] : ["strong", "strong"];
      let usage = zeroUsage();
      let errors: string[] = [];
      for (let i = 0; i < plan.length; i++) {
        const tier = plan[i];
        const escalated = tier !== request.tier;
        const callLane: Lane = escalated ? "escalation" : lane;
        const call: BackendCall = {
          pack: request.pack,
          systemPrompt: request.systemPrompt,
          input: errors.length ? retryInput(input, errors) : input,
          jsonSchema,
          tier,
          lane: callLane,
          courseId: request.courseId,
          maxOutputTokens: maxOut,
          timeoutMs: request.budget?.timeoutMs ?? options.defaultTimeoutMs ?? 180_000,
          signal: request.signal,
        };
        const callStart = now();
        let result: BackendResult | null = null;
        try {
          const outgoing = request.beforeCall ? request.beforeCall(call) : call;
          result = await backend.call(outgoing);
          request.afterCall?.();
        } catch (error) {
          if (!(error instanceof RunnerError)) throw error;
          const outcome: LedgerOutcome =
            error.kind === "usage_limit"
              ? "usage_limit"
              : error.kind === "invalid_output"
                ? "check_failed"
                : "error";
          ledger({
            tier,
            lane: callLane,
            model: "",
            usage: zeroUsage(),
            latencyMs: now() - callStart,
            attempt: i + 1,
            escalated,
            outcome,
            checkErrors: outcome === "check_failed" ? [error.message] : [],
            errorKind: error.kind,
            ...(error.blocked ? { blocked: error.blocked } : {}), // owner: client-detection: security receipt
          });
          if (error.kind === "usage_limit" && lane === "background")
            options.budget?.pauseForUsageLimit();
          // An unreadable answer is a failed check: retry and escalate like one.
          if (error.kind !== "invalid_output") throw error;
          errors = ["The answer was not a single JSON value matching the schema."];
          continue;
        }
        usage = addUsage(usage, result.usage);
        options.budget?.record(lane, result.usage);
        const parsed = request.schema.safeParse(result.value);
        const failed = parsed.success
          ? (request.check?.(parsed.data) ?? [])
          : issuesOf(parsed.error);
        ledger({
          tier,
          lane: callLane,
          model: result.model,
          usage: result.usage,
          latencyMs: now() - callStart,
          attempt: i + 1,
          escalated,
          outcome: failed.length ? "check_failed" : "ok",
          checkErrors: failed,
        });
        if (parsed.success && !failed.length)
          return {
            output: parsed.data,
            usage,
            model: result.model,
            latencyMs: now() - started,
            attempts: i + 1,
            client: backend.client,
            tier,
            escalated,
          };
        errors = failed;
      }
      throw new RunnerError("check_failed", request.pack.id, errors);
    },
  };
}
