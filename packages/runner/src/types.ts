import type { z } from "zod";

/** Spec E3 tiers. Pass first everywhere (F5); strong only on escalation or an explicit ask. */
export type Tier = "pass" | "strong";
/** D38 lanes. Interactive keeps a per-course conversation; background rotates per batch. */
export type Lane = "interactive" | "background" | "escalation";
/** Who answers. CLI routes use the student's own signed-in client; key routes the caller's key. */
export type ClientId =
  | "claude"
  | "codex"
  | "openrouter"
  | "anthropic"
  | "openai"
  | "gemini"
  | "local";

/** `in` counts every input token (fresh, cache write and cache read); `cached` is the cache-read share. */
export interface Usage {
  in: number;
  cached: number;
  out: number;
}
export interface PackRef {
  id: string;
  version: string;
}
export interface RunBudget {
  /** Refuse before sending when the estimated prompt exceeds this. */
  maxInputTokens?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
}
/** The fields of the one-line `[ctx …]` header (D38). Values are sanitised to one line. */
export interface AskContext {
  course?: string;
  profile?: string;
  scope?: string;
  intent?: string;
  sources?: string[];
}

export interface RunRequest<T> {
  pack: PackRef;
  /** The stable prefix: byte-identical for the same pack and course (O8). */
  systemPrompt: string;
  /** The ask. Never placed in argv; CLIs read it from stdin. */
  input: string;
  /** Code validates every output against this, whatever the provider promised. */
  schema: z.ZodType<T>;
  tier: Tier;
  budget?: RunBudget;
  signal?: AbortSignal;
  lane?: Lane;
  /** Selects the interactive lane's conversation. */
  courseId?: string;
  /** When present, the runner prepends the one-line metadata header to the input. */
  context?: AskContext;
  /** Code checks beyond the schema: each string is one failed check, fed back on retry. */
  check?: (output: T) => string[];
  /** Final synchronous egress boundary, after headers and retry feedback. */
  beforeCall?: (call: BackendCall) => BackendCall;
  /** Revalidate evidence/permissions after the provider await. */
  afterCall?: () => void;
  /** Also receives this run's ledger rows, after the runner-level sink. */
  ledger?: LedgerSink;
}
export interface RunResult<T> {
  output: T;
  /** Summed over every attempt of this run. */
  usage: Usage;
  model: string;
  latencyMs: number;
  attempts: number;
  client: ClientId;
  tier: Tier;
  escalated: boolean;
}
export interface ModelRunner {
  readonly client: ClientId;
  run<T>(request: RunRequest<T>): Promise<RunResult<T>>;
}

/** One raw model call, with no retry or validation policy: what an adapter or the pool does. */
export interface BackendCall {
  pack: PackRef;
  systemPrompt: string;
  input: string;
  jsonSchema: Record<string, unknown>;
  tier: Tier;
  lane: Lane;
  courseId?: string;
  maxOutputTokens?: number;
  timeoutMs: number;
  signal?: AbortSignal;
}
export interface BackendResult {
  /** Parsed JSON the model returned (not yet validated). */
  value: unknown;
  usage: Usage;
  model: string;
}
export interface ModelBackend {
  readonly client: ClientId;
  call(call: BackendCall): Promise<BackendResult>;
  close?(): Promise<void>;
}

export type RunnerErrorKind =
  | "not_installed"
  | "not_signed_in"
  | "usage_limit"
  | "budget_exhausted"
  | "background_paused"
  | "too_large"
  | "check_failed"
  | "invalid_output"
  | "process_failed"
  | "timeout"
  | "aborted"
  | "unavailable";

const studentMessages: Record<RunnerErrorKind, string> = {
  not_installed: "Your AI client isn't installed. Open Settings to choose one.",
  not_signed_in:
    "Your AI client isn't signed in. Sign in with the provider's own flow, then try again.",
  usage_limit:
    "Your AI plan's usage limit was reached. Try again later; background work is paused.",
  budget_exhausted:
    "Today's background budget is spent. Background work resumes tomorrow.",
  background_paused:
    "Background work is paused after a usage limit. It resumes on its own.",
  too_large: "This request is larger than its budget allows.",
  check_failed:
    "The answer didn't pass the app's checks after a retry and an escalation.",
  invalid_output: "The AI returned an answer the app couldn't read.",
  process_failed: "Your AI client stopped unexpectedly.",
  timeout: "Your AI client took too long to answer.",
  aborted: "Cancelled.",
  unavailable: "The AI service couldn't be reached.",
};

/** Messages never include stderr, prompts or keys: those can hold course text or secrets. */
export class RunnerError extends Error {
  readonly kind: RunnerErrorKind;
  readonly checkErrors: string[];
  readonly studentMessage: string;
  constructor(kind: RunnerErrorKind, detail?: string, checkErrors: string[] = []) {
    super(detail ? `${kind}: ${detail}` : kind);
    this.name = "RunnerError";
    this.kind = kind;
    this.checkErrors = checkErrors;
    this.studentMessage = studentMessages[kind];
  }
}

export type LedgerOutcome =
  | "ok"
  | "check_failed"
  | "error"
  | "usage_limit"
  | "refused";
/** Spec E5: one row per model call (and per refusal before a call). */
export interface LedgerEntry {
  at: string;
  pack: string;
  packVersion: string;
  client: ClientId;
  tier: Tier;
  lane: Lane;
  model: string;
  usage: Usage;
  latencyMs: number;
  /** 1-based within this run. */
  attempt: number;
  escalated: boolean;
  outcome: LedgerOutcome;
  checkErrors: string[];
  errorKind?: RunnerErrorKind;
}
export type LedgerSink = (entry: LedgerEntry) => void;
