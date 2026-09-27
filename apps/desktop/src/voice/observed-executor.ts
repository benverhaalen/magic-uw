// owner: voice-plan. Binds the observed-executor lane's `ObservedActionController` (observe → Jev
// Choice over observed targets and exact planned destinations → validated action → reobserve) to the
// planner's `ObservedExecutor` seam, and decides whether this computer can run it at all. Electron-free:
// main injects the probes, the helpers and the Jev judge.
import type { ExecutorOutcome, ObservedState } from "../../../../packages/core/src/intent/planner";
import type { ActionJudge, ActionOffer, ActionResult, BrowserObservation, ObservedActionController } from "./observed-actions";
import type { RunExecutor } from "./plan-protocol";

export function observedState(o: BrowserObservation, at: string): ObservedState {
  return {
    status: "observed",
    at,
    browser: { url: o.url, title: o.title },
    focus: o.focusedRole ? { role: o.focusedRole, name: o.focusedTitle } : undefined,
    elements: o.candidates.map((c, i) => ({ id: `link_${i}`, role: "link", name: `${c.title} → ${c.targetURL}` })),
    text: o.text,
  };
}
const describe = (a?: ActionOffer) => (a ? `${a.action} ${a.url ?? a.target?.targetURL ?? a.label}`.slice(0, 300) : "no action");
const JEV_UNAVAILABLE = "Jev action choice was unavailable.";

/**
 * Maps the controller's result to the planner's outcome. `done` needs an observed postcondition: the
 * controller returns `observed` for open/click only after it reobserved the browser at the target URL.
 */
export function outcomeOf<C>(r: ActionResult<C>, at: string): ExecutorOutcome {
  switch (r.status) {
    case "observed":
      return r.after ? { status: "done", action: describe(r.action), observed: observedState(r.after, at) } : { status: "failed", action: describe(r.action), reason: "Magic couldn't read the page after the action." };
    case "needs_confirmation":
      return { status: "needs_confirmation", action: describe(r.action), prompt: `“${r.action?.label.slice(0, 120) ?? "That link"}” might change something, so Magic didn't press it. Open it yourself if you're sure.` };
    case "handoff":
      return { status: "failed", action: null, reason: r.reason ?? "Jev found no safe next action on this page." };
    case "unknown":
      return { status: "failed", action: describe(r.action), reason: "The action may have happened, but Magic couldn't confirm the result." };
    case "stopped":
      return { status: "stopped" };
    case "unavailable":
      return r.reason === JEV_UNAVAILABLE ? { status: "unavailable", reason: "Jev couldn't choose the next action, so Magic stopped." } : { status: "failed", action: r.action ? describe(r.action) : null, reason: r.reason ?? "That action isn't available here." };
  }
}

export interface ObservedExecutorParts<C> {
  observe(signal: AbortSignal, current: () => boolean): Promise<{ status: string; observation?: BrowserObservation; reason?: string }>;
  controller: Pick<ObservedActionController<C>, "step" | "stop">;
  context: C;
  /** The voice session's fence (account, consent revision, Stop); checked by the controller before every action. */
  current(): boolean;
  now(): Date;
}

export function createRunExecutor<C>(parts: ObservedExecutorParts<C>): RunExecutor {
  let stopped = false;
  const live = () => !stopped && parts.current();
  return {
    async observe(signal) {
      if (!live()) return { status: "unknown", at: parts.now().toISOString(), note: "stopped" };
      const r = await parts.observe(signal, live);
      return r.status === "observed" && r.observation ? observedState(r.observation, parts.now().toISOString()) : { status: "unknown", at: parts.now().toISOString(), note: r.reason ?? "The browser could not be read." };
    },
    async act(step, signal) {
      if (!live()) return { status: "stopped" };
      const result = await parts.controller.step({ goal: step.goal, openURLs: step.destinations, context: parts.context, signal, current: live });
      return live() ? outcomeOf(result, parts.now().toISOString()) : { status: "stopped" };
    },
    stop() { stopped = true; parts.controller.stop(); },
  };
}

/** Wraps a judge so every Choice re-checks Jev consent and the voice fence first. */
export function gatedJudge(judge: ActionJudge, allowed: () => Promise<boolean>): ActionJudge {
  return {
    async choose(goal, observation, offers, recent, signal) {
      if (!(await allowed())) throw new Error("Jev is not allowed right now.");
      signal.throwIfAborted();
      return judge.choose(goal, observation, offers, recent, signal);
    },
  };
}

export type VoiceActionCapability = { ok: true } | { ok: false; reason: string };
/**
 * Whether spoken requests may go to the connected planner and observed executor. Every part must be
 * really present; otherwise speech stays on the local page.open trial, whose answer carries this reason.
 */
export async function voiceActionCapability(probes: {
  platform: string;
  helpers(): Promise<boolean>;
  jevKey(): boolean;
  jevAllowed(): Promise<boolean>;
  accessibility(): boolean;
}): Promise<VoiceActionCapability> {
  if (probes.platform !== "darwin") return { ok: false, reason: "Spoken browser actions work only on macOS for now." };
  if (!(await probes.helpers())) return { ok: false, reason: "This build doesn't include the browser helpers for spoken actions." };
  if (!probes.jevKey()) return { ok: false, reason: "Spoken browser actions need Jev, and this build doesn't include it." };
  if (!(await probes.jevAllowed())) return { ok: false, reason: "Spoken browser actions need your permission for Jev in Data & AI." };
  if (!probes.accessibility()) return { ok: false, reason: "Spoken browser actions need Accessibility access for My Magic UW in System Settings › Privacy & Security." };
  return { ok: true };
}

