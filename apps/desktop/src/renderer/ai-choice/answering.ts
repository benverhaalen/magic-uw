// owner: ai-choice. Which AI answers the student, for the "Your AI" choice on Data & AI. The choice is
// the same state the send gate enforces: a hosted AI answers only when it is the selected
// `hostedProvider`, cloud access is on and its agreement is current. "On this computer" and "Off" are
// both "no hosted AI"; which of the two the student picked is a display preference on this device.
// Ported from feat/floating-chat (c82fa42, 615c6f2); the status words follow the Data & AI redesign.
import { useEffect, useSyncExternalStore } from "react";
import type { ClientHealth, ClientId, PrivacyPreferences } from "@magic/contracts";
import { clientInfo } from "../onboarding/model";

export type AiChoice = ClientId | "local" | "off";
export const HOSTED_CHOICES: readonly ClientId[] = ["claude", "codex", "gemini"];

export const LOCAL_KEY = "magic.yourAi.local";
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
  return useSyncExternalStore((listener) => { localListeners.add(listener); return () => { localListeners.delete(listener); }; }, readLocalChoice, () => false);
}

/** The student's choice as the send gate sees it. */
export function aiChoiceOf(privacy: PrivacyPreferences, localOn: boolean): AiChoice {
  const provider = privacy.hostedProvider;
  if (privacy.mode === "selective_cloud" && (HOSTED_CHOICES as readonly string[]).includes(provider)) return provider as ClientId;
  return localOn ? "local" : "off";
}

/** The preference change for a choice (null: none needed). Local and Off both mean "no hosted AI". */
export function aiChoicePatch(privacy: PrivacyPreferences, choice: AiChoice): Partial<PrivacyPreferences> | null {
  if (choice === "local" || choice === "off") return privacy.hostedProvider === "none" ? null : { hostedProvider: "none" };
  if (privacy.hostedProvider === choice && privacy.mode === "selective_cloud") return null;
  return { hostedProvider: choice, mode: "selective_cloud" };
}

export const choiceName = (choice: AiChoice) =>
  choice === "local" ? "On this computer" : choice === "off" ? "Off" : clientInfo[choice].name;

/** What a status line asks the student to do next, if anything. */
export type StatusAction = "sign_in" | "install" | null;
export interface ClientStatusLine { text: string; tone: "ok" | "wait" | "problem"; action: StatusAction }

/** A client's stated reset time, shown as a time when it parses ("3:00 PM"), else as stated. */
export function resetWords(resetsAt: string | undefined): string | null {
  if (!resetsAt) return null;
  const at = Date.parse(resetsAt);
  if (Number.isNaN(at)) return resetsAt.slice(0, 40);
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** One status per client card: Connected, Signed out, Not installed, Usage limit (resets …). */
export function statusLine(health: ClientHealth | null | undefined, checking = false): ClientStatusLine {
  if (!health) return { text: checking ? "Checking…" : "Not checked", tone: "wait", action: null };
  switch (health.state) {
    case "ok": return { text: "Connected", tone: "ok", action: null };
    case "installed":
    case "not_signed_in": return { text: "Signed out", tone: "problem", action: "sign_in" };
    case "not_installed": return { text: "Not installed", tone: "problem", action: "install" };
    case "usage_limited": {
      const at = resetWords(health.resetsAt);
      return { text: at ? `Usage limit (resets ${at})` : "Usage limit", tone: "wait", action: null };
    }
    case "plan_insufficient": return { text: "Plan can't run it", tone: "problem", action: null };
    case "model_unavailable": return { text: "Model unavailable", tone: "problem", action: null };
    case "offline": return { text: "Can't connect", tone: "problem", action: null };
    case "keychain_locked": return { text: "Keychain blocked", tone: "problem", action: null };
    case "tool_use_blocked": return { text: "Stopped: tried a tool", tone: "problem", action: null };
  }
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
/** Stores an answer the page already has (after a mode change), so every reader sees it. */
export function rememberClientHealth(health: ClientHealth): void {
  healthCache.set(health.id, { health, at: Date.now() });
  notify();
}
/** owner: reconfigure. Forgets every cached health answer, so the next reader checks again. */
export function resetClientHealthCache(): void {
  healthCache.clear();
  notify();
}
const subscribeHealth = (listener: () => void) => { healthListeners.add(listener); return () => { healthListeners.delete(listener); }; };
/** Health for several clients (the "Your AI" cards), checked on mount through the same cache. */
export function useClientHealths(ids: readonly ClientId[]): Partial<Record<ClientId, ClientHealth | null>> {
  useSyncExternalStore(subscribeHealth, () => healthVersion, () => 0);
  const key = ids.join(",");
  useEffect(() => { for (const id of key.split(",")) if (id) void checkClientHealth(id as ClientId); }, [key]);
  return Object.fromEntries(ids.map((id) => [id, healthCache.get(id)?.health ?? null]));
}
/** Whether a check is running for this client (the card says "Checking…"). */
export const isChecking = (id: ClientId) => pending.has(id);
