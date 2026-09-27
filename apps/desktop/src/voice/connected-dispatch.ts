// owner: voice-plan. Speech routing: the published local trial answers first (no worker, provider or
// snapshot request); a navigation it runs is the result. Any other request goes to the connected planner
// only when every capability is present; otherwise the trial's own answer stands, with the capability's
// truthful reason. Nothing here reaches a generic command path, so unsupported speech can never become a
// school action.
import type { IntentCommandResult } from "@magic/contracts";
import type { PlannerResult } from "../../../../packages/core/src/intent/planner";
import type { VoiceDispatch } from "./session";
import type { VoiceRequestContext } from "./types";
import type { VoiceActionCapability } from "./observed-executor";

const zero = { in: 0, cached: 0, out: 0 };
const unavailable = (reason: string): IntentCommandResult => ({ status: "unavailable", reason, path: "none", latencyMs: 0, tokens: zero });

export function createConnectedVoiceDispatch(options: {
  /** The published local trial (page.open for app pages and included courses only). */
  trial: VoiceDispatch;
  capability(): Promise<VoiceActionCapability>;
  plan(utterance: string, context: VoiceRequestContext, operation: { signal: AbortSignal; current(): boolean }): Promise<PlannerResult | { status: "stopped" }>;
  /** The grounded ask (course AI policy enforced in the producer) for a planner's course question. */
  ask(question: string, context: VoiceRequestContext, operation: { signal: AbortSignal; current(): boolean }): Promise<IntentCommandResult>;
  now?(): number;
}): VoiceDispatch {
  const now = options.now ?? (() => performance.now());
  return async (text, context, operation) => {
    operation.signal.throwIfAborted();
    if (!operation.current()) throw new Error("Request context changed.");
    const local = await options.trial(text, context, operation);
    if (local.status === "ran") return local;
    const capability = await options.capability();
    operation.signal.throwIfAborted();
    if (!operation.current()) throw new Error("Request context changed.");
    if (!capability.ok) return local.status === "unavailable" ? { ...local, reason: `${capability.reason} ${local.reason}` } : local;
    const started = now();
    const result = await options.plan(text, context, operation);
    operation.signal.throwIfAborted();
    if (result.status === "stopped" || !operation.current()) throw new Error("Request context changed.");
    const latencyMs = Math.round(now() - started);
    const steps = result.steps.map((s) => ({ goal: s.goal, outcome: s.outcome.status }));
    switch (result.status) {
      case "course_question":
        return options.ask(result.question, context, operation);
      case "done":
      case "reply":
        return { status: "ran", action: "voice.plan", args: { text }, result: { say: result.say, steps }, path: "ai", latencyMs, tokens: zero };
      case "clarify":
      case "needs_confirmation":
        return { status: "clarify", question: result.say, candidates: [], path: "ai", latencyMs, tokens: zero };
      case "stuck":
        return { ...unavailable(result.say), path: "ai", latencyMs };
      case "unavailable":
        return { ...unavailable(result.reason), latencyMs };
    }
  };
}
