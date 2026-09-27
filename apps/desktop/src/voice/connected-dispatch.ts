// owner: voice-plan. Speech routing: the published local trial answers first (no worker, provider or
// snapshot request); a navigation it runs is the result. Next, when the command bar's code resolver places
// the request (0 tokens), it runs through the same interactive dispatch as typed chat: a page, course or item
// opens at once, and an ask lands on the course's warm session. Anything else goes to the connected planner
// (Jev's observed actions, the computer-use fallback, confirmation) when its capability is present; without
// it, the interactive dispatch answers, with the capability's truthful reason. Only the interactive
// allowlist (open, ask, due, search) is reachable, so speech can never become a school action.
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
  /**
   * The command bar's interactive dispatch (INTERACTIVE_ACTIONS only). `code` is its 0-token resolver: true
   * when code alone places the request, so no classify call is added in front of the planner.
   */
  interactive?: { code(text: string, context: VoiceRequestContext, operation: { signal: AbortSignal; current(): boolean }): Promise<boolean>; run: VoiceDispatch };
  now?(): number;
}): VoiceDispatch {
  const now = options.now ?? (() => performance.now());
  return async (text, context, operation) => {
    operation.signal.throwIfAborted();
    if (!operation.current()) throw new Error("Request context changed.");
    const local = await options.trial(text, context, operation);
    if (local.status === "ran") return local;
    const fence = () => {
      operation.signal.throwIfAborted();
      if (!operation.current()) throw new Error("Request context changed.");
    };
    const interactive = options.interactive;
    if (interactive) {
      const placed = await interactive.code(text, context, operation).catch(() => false);
      fence();
      if (placed) return interactive.run(text, context, operation);
    }
    const capability = await options.capability();
    fence();
    if (!capability.ok) {
      if (!interactive) return local.status === "unavailable" ? { ...local, reason: `${capability.reason} ${local.reason}` } : local;
      const answered = await interactive.run(text, context, operation);
      return answered.status === "unavailable" ? { ...answered, reason: `${capability.reason} ${answered.reason}` } : answered;
    }
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
