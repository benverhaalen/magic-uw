// owner: ai-choice. Which AI answers the student, in one place for the account card, the chat header
// and the "Your AI" choice. The choice is the same state the send gate enforces: a hosted AI answers
// only when it is the selected `hostedProvider`, cloud access is on and its agreement is current
// (`maySend`). The client's mode and plan come from the client-health bridge. "On this computer
// (Ollama)" and "Off" are both "no hosted AI"; which of the two the student picked is a display
// preference on this device, like the floating chat's corner.
import { useEffect, useSyncExternalStore } from "react";
import type { ClientHealth, ClientId, ConsentRecord, PrivacyPreferences } from "@magic/contracts";
import { maySend, withConsents } from "@magic/domain";
import { clientInfo } from "../onboarding/model";

export type AiChoice = ClientId | "local" | "off";
export const HOSTED_CHOICES: readonly ClientId[] = ["claude", "codex", "gemini"];

const LOCAL_KEY = "magic.yourAi.local";
const localListeners = new Set<() => void>();
function storage(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}
export function readLocalChoice(): boolean {
  try { return storage()?.getItem(LOCAL_KEY) === "on"; } catch { return false; }
}
export function writeLocalChoice(on: boolean) {
  try { storage()?.setItem(LOCAL_KEY, on ? "on" : "off"); } catch { /* the choice lasts this session */ }
  for (const listener of localListeners) listener();
}
export function useLocalChoice(): boolean {
  return useSyncExternalStore((listener) => { localListeners.add(listener); return () => localListeners.delete(listener); }, readLocalChoice, () => false);
}

/** The student's choice as the send gate sees it. */
export function aiChoiceOf(privacy: PrivacyPreferences, localOn: boolean): AiChoice {
  const provider = privacy.hostedProvider;
  if (privacy.mode === "selective_cloud" && (HOSTED_CHOICES as readonly string[]).includes(provider)) return provider as ClientId;
  return localOn ? "local" : "off";
}

export const choiceName = (choice: AiChoice) =>
  choice === "local" ? "On this computer (Ollama)" : choice === "off" ? "Off" : clientInfo[choice].name;

const modeWords: Record<ClientHealth["mode"], string> = { instant: "instant", isolated: "separate sign-in", api_key: "your key" };
const stateWords: Record<ClientHealth["state"], string> = {
  ok: "Ready",
  installed: "Sign-in not confirmed",
  not_installed: "Not installed",
  not_signed_in: "Not signed in",
  plan_insufficient: "Plan can't run it",
  usage_limited: "Usage limit reached",
  model_unavailable: "Model unavailable",
  offline: "Can't connect",
};
const plan = (value?: string) => (value ? `${value[0]!.toUpperCase()}${value.slice(1)}` : null);

export interface Answering {
  choice: AiChoice;
  /** Can answer now, as far as the app can tell without running it. */
  ready: boolean;
  /** "Claude Code · instant", "On this computer (Ollama)", or "No AI chosen". */
  label: string;
  /** One more line for the account card: the plan, or why it can't answer. */
  detail: string | null;
}

export function answering(privacy: PrivacyPreferences, consents: readonly ConsentRecord[], localOn: boolean, health: ClientHealth | null): Answering {
  const choice = aiChoiceOf(privacy, localOn);
  if (choice === "off") return { choice, ready: false, label: "No AI chosen", detail: null };
  if (choice === "local") return { choice, ready: true, label: choiceName(choice), detail: "Answers stay on this computer." };
  const name = choiceName(choice);
  if (!maySend(withConsents(privacy, consents), choice, []).allowed)
    return { choice, ready: false, label: name, detail: "Needs your agreement in Data & AI." };
  if (!health || health.id !== choice) return { choice, ready: true, label: name, detail: null };
  const label = `${name} · ${modeWords[health.mode]}`;
  if (health.state !== "ok") return { choice, ready: false, label, detail: stateWords[health.state] };
  return { choice, ready: true, label, detail: plan(health.plan) ? `${plan(health.plan)} plan` : null };
}

// Client health, checked once per client per minute and shared by every reader in the window.
const HEALTH_TTL = 60_000;
const healthCache = new Map<ClientId, { health: ClientHealth | null; at: number }>();
const pending = new Map<ClientId, Promise<void>>();
const healthListeners = new Set<() => void>();
let healthVersion = 0;
function notify() { healthVersion++; for (const listener of healthListeners) listener(); }
/** Checks a client through the existing bridge unless a recent answer is cached. */
export function checkClientHealth(id: ClientId, force = false): Promise<void> {
  const cached = healthCache.get(id);
  if (!force && cached && Date.now() - cached.at < HEALTH_TTL) return Promise.resolve();
  const running = pending.get(id);
  if (running) return running;
  const health = typeof window === "undefined" ? undefined : window.magic?.clients?.health;
  if (!health) return Promise.resolve();
  const next = health(id)
    .then((value) => { healthCache.set(id, { health: value, at: Date.now() }); })
    .catch(() => { healthCache.set(id, { health: null, at: Date.now() }); })
    .finally(() => { pending.delete(id); notify(); });
  pending.set(id, next);
  return next;
}
const subscribeHealth = (listener: () => void) => { healthListeners.add(listener); return () => { healthListeners.delete(listener); }; };
/** Health for several clients (the "Your AI" cards), checked on mount through the same cache. */
export function useClientHealths(ids: readonly ClientId[]): Partial<Record<ClientId, ClientHealth | null>> {
  useSyncExternalStore(subscribeHealth, () => healthVersion, () => 0);
  const key = ids.join(",");
  useEffect(() => { for (const id of key.split(",")) if (id) void checkClientHealth(id as ClientId); }, [key]);
  return Object.fromEntries(ids.map((id) => [id, healthCache.get(id)?.health ?? null]));
}
/** One status line for a client card: "Ready · instant · Max plan", "Not installed", "Not checked". */
export function healthLine(health: ClientHealth | null | undefined): string {
  if (!health) return "Not checked";
  if (health.state !== "ok") return stateWords[health.state];
  return [`Ready · ${modeWords[health.mode]}`, plan(health.plan) ? `${plan(health.plan)} plan` : null].filter(Boolean).join(" · ");
}
/** Health for the chosen hosted client, or null. `check` false reads only what is cached. */
export function useClientHealth(choice: AiChoice, check = true): ClientHealth | null {
  useSyncExternalStore(subscribeHealth, () => healthVersion, () => 0);
  const hosted = (HOSTED_CHOICES as readonly string[]).includes(choice) ? (choice as ClientId) : null;
  useEffect(() => { if (hosted && check) void checkClientHealth(hosted); }, [hosted, check]);
  return hosted ? healthCache.get(hosted)?.health ?? null : null;
}
