// owner: voice-plan. The connected-agent planner runs in the worker, beside the store, the consent
// authorizer and the student's connected Claude Code/Codex runner. The observed executor runs in main,
// which alone holds the native helpers and the Jev key. This is the typed message seam between them;
// both halves are Electron-free so the whole round trip is tested without a window.
import { randomUUID } from "node:crypto";
import type { ExecutorOutcome, ObservedExecutor, ObservedState, PlannerResult } from "../../../../packages/core/src/intent/planner";
import type { VoiceRequestContext } from "./types";

type ActStep = Parameters<ObservedExecutor["act"]>[0];
export type VoicePlanToWorker =
  | { kind: "voice-plan"; id: string; utterance: string; context: VoiceRequestContext }
  | { kind: "voice-plan-cancel"; id: string }
  | { kind: "voice-exec-result"; id: string; result: ObservedState | ExecutorOutcome };
export type VoicePlanToMain =
  | { kind: "voice-plan-result"; id: string; result?: PlannerResult; error?: string }
  | { kind: "voice-exec"; id: string; planId: string; op: "observe" }
  | { kind: "voice-exec"; id: string; planId: string; op: "act"; step: ActStep }
  | { kind: "voice-exec-cancel"; id: string };

const STOPPED: ExecutorOutcome = { status: "stopped" };

/**
 * Worker half. `run` is `runPlanner` bound to the worker's store and runner. The executor it gets is a
 * proxy: every observe/act is one message to main, and an aborted plan cancels the pending call.
 */
export function createVoicePlanWorker(options: {
  post(message: VoicePlanToMain): void;
  run(request: { runId: string; utterance: string; context: VoiceRequestContext }, executor: ObservedExecutor, signal: AbortSignal): Promise<PlannerResult>;
}) {
  const plans = new Map<string, AbortController>();
  const calls = new Map<string, (value: ObservedState | ExecutorOutcome) => void>();
  const executor = (planId: string): ObservedExecutor => {
    const call = <T extends ObservedState | ExecutorOutcome>(message: { op: "observe" } | { op: "act"; step: ActStep }, signal: AbortSignal, onStop: T) =>
      new Promise<T>((resolve) => {
        if (signal.aborted) return resolve(onStop);
        const id = randomUUID();
        const stop = () => { calls.delete(id); options.post({ kind: "voice-exec-cancel", id }); resolve(onStop); };
        signal.addEventListener("abort", stop, { once: true });
        calls.set(id, (value) => { signal.removeEventListener("abort", stop); resolve(value as T); });
        options.post({ kind: "voice-exec", id, planId, ...message } as VoicePlanToMain);
      });
    return {
      observe: (signal) => call<ObservedState>({ op: "observe" }, signal, { status: "unknown", at: new Date().toISOString(), note: "stopped" }),
      act: (step, signal) => call<ExecutorOutcome>({ op: "act", step }, signal, STOPPED),
    };
  };
  return {
    /** True when the message belonged to this seam. */
    handle(message: { kind?: unknown; id?: unknown } & Record<string, unknown>): boolean {
      if (message.kind === "voice-exec-result" && typeof message.id === "string") {
        const resolve = calls.get(message.id);
        calls.delete(message.id);
        resolve?.(message.result as ObservedState | ExecutorOutcome);
        return true;
      }
      if (message.kind === "voice-plan-cancel" && typeof message.id === "string") {
        plans.get(message.id)?.abort();
        return true;
      }
      if (message.kind !== "voice-plan" || typeof message.id !== "string") return false;
      const { id } = message;
      if (plans.has(id) || typeof message.utterance !== "string") {
        options.post({ kind: "voice-plan-result", id, error: "Invalid voice plan request." });
        return true;
      }
      const controller = new AbortController();
      plans.set(id, controller);
      void options
        .run({ runId: id, utterance: message.utterance, context: (message.context ?? {}) as VoiceRequestContext }, executor(id), controller.signal)
        .then(
          (result) => options.post({ kind: "voice-plan-result", id, result }),
          (error: unknown) => options.post({ kind: "voice-plan-result", id, error: error instanceof Error ? error.message : "The voice plan failed." }),
        )
        .finally(() => plans.delete(id));
      return true;
    },
  };
}

/** One run's executor in main; `stop` must make any later observe/act a no-op. */
export type RunExecutor = ObservedExecutor & { stop(): void };

/**
 * Main half. `plan` sends one transcript to the worker and resolves with its result. Stop (the
 * operation's signal) or a lost authority (`current()`) cancels the worker run and stops the executor
 * before the next action; a late worker reply or executor request for that run is ignored.
 */
export function createVoicePlanHost(options: { post(message: VoicePlanToWorker): void; executor(planId: string, operation: { signal: AbortSignal; current(): boolean }): RunExecutor }) {
  type Plan = { resolve(result: PlannerResult | { status: "stopped" }): void; reject(error: Error): void; executor: RunExecutor; signal: AbortSignal; current(): boolean };
  const plans = new Map<string, Plan>();
  const execs = new Map<string, AbortController>();
  const finish = (id: string) => { const plan = plans.get(id); plans.delete(id); plan?.executor.stop(); return plan; };
  // A lost fence (account, consent revision) without Stop still ends the worker run before its next model call.
  const cancel = (id: string) => { const plan = finish(id); if (!plan) return; options.post({ kind: "voice-plan-cancel", id }); plan.resolve({ status: "stopped" }); };
  return {
    plan(utterance: string, context: VoiceRequestContext, operation: { signal: AbortSignal; current(): boolean }): Promise<PlannerResult | { status: "stopped" }> {
      if (operation.signal.aborted || !operation.current()) return Promise.resolve({ status: "stopped" });
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const stop = () => { if (!plans.has(id)) return; finish(id); options.post({ kind: "voice-plan-cancel", id }); resolve({ status: "stopped" }); };
        operation.signal.addEventListener("abort", stop, { once: true });
        const done = <T>(fn: (value: T) => void) => (value: T) => { operation.signal.removeEventListener("abort", stop); fn(value); };
        plans.set(id, { resolve: done(resolve), reject: done(reject), executor: options.executor(id, operation), signal: operation.signal, current: operation.current });
        options.post({ kind: "voice-plan", id, utterance, context });
      });
    },
    /** True when the worker message belonged to this seam. */
    handle(message: { kind?: unknown; id?: unknown } & Record<string, unknown>): boolean {
      if (message.kind === "voice-plan-result" && typeof message.id === "string") {
        const plan = finish(message.id);
        if (!plan) return true;
        if (message.result && plan.current() && !plan.signal.aborted) plan.resolve(message.result as PlannerResult);
        else if (message.result) plan.resolve({ status: "stopped" });
        else plan.reject(new Error(typeof message.error === "string" ? message.error : "The voice plan failed."));
        return true;
      }
      if (message.kind === "voice-exec-cancel" && typeof message.id === "string") {
        execs.get(message.id)?.abort();
        return true;
      }
      if (message.kind !== "voice-exec" || typeof message.id !== "string") return false;
      const { id } = message;
      const plan = typeof message.planId === "string" ? plans.get(message.planId) : undefined;
      const reply = (result: ObservedState | ExecutorOutcome) => options.post({ kind: "voice-exec-result", id, result });
      if (!plan || plan.signal.aborted || !plan.current()) {
        if (plan) cancel(message.planId as string);
        reply(message.op === "observe" ? { status: "unknown", at: new Date().toISOString(), note: "stopped" } : STOPPED);
        return true;
      }
      const controller = new AbortController();
      execs.set(id, controller);
      const signal = AbortSignal.any([controller.signal, plan.signal]);
      const run = message.op === "observe" ? plan.executor.observe(signal) : message.op === "act" ? plan.executor.act(message.step as ActStep, signal) : null;
      if (!run) { execs.delete(id); reply(STOPPED); return true; }
      void run
        .then((result) => {
          if (!plan.current() && plans.get(message.planId as string) === plan) cancel(message.planId as string);
          reply(signal.aborted || !plan.current() ? (message.op === "observe" ? { status: "unknown", at: new Date().toISOString(), note: "stopped" } : STOPPED) : result);
        })
        .catch(() => reply(message.op === "observe" ? { status: "unknown", at: new Date().toISOString(), note: "observation failed" } : { status: "failed", action: null, reason: "The action failed." }))
        .finally(() => execs.delete(id));
      return true;
    },
    /** Stops every run (account/consent change, window closed). */
    stopAll() { for (const id of [...plans.keys()]) cancel(id); },
  };
}
