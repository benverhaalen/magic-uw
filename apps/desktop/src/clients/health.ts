import { lookup } from "node:dns/promises";
import type { ApiKeyStatus, ClientHealth, ClientHealthState, ClientId, ClientMode } from "@magic/contracts";
import {
  RunnerError,
  createApiBackend,
  runProcess,
  type BackendCall,
  type BackendResult,
  type CliCommand,
  type ModelBackend,
} from "@magic/runner";
import { parseClaudeAuth, parseCodexLogin, type ParsedAuth } from "./auth-parse";
import { CLIENTS, authStatus, detectClient, resolveClient } from "./profiles";
import {
  instantEnv,
  instantRunOptions,
  instantSupport,
  instantWorkDir,
  modeOf,
  type InstantDeps,
} from "./instant";

/**
 * owner: client-health (D50). One typed health per client, checked before offering a client and
 * before every run, so a failure always lands on one notice with the exact next step.
 *
 * Every message string the classification relies on, with where it came from. "observed" means
 * produced on this device on 2026-09-27 by the installed client (Claude Code 2.1.283, Codex
 * 0.156.1); "binary" means the text is in the installed executable but the situation could not be
 * produced here (no free or limited account was available), so its mapping is unverified.
 */
export const HEALTH_EVIDENCE: readonly { client: "claude" | "codex"; text: string; state: ClientHealthState | "process_failed"; source: "observed" | "binary" }[] = [
  { client: "claude", text: '{"loggedIn":false,"authMethod":"none",…} (auth status --json, exit 1)', state: "not_signed_in", source: "observed" },
  { client: "claude", text: '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max",…}', state: "ok", source: "observed" },
  { client: "claude", text: "Not logged in · Please run /login", state: "not_signed_in", source: "observed" },
  { client: "claude", text: "There's an issue with the selected model (claude-nonexistent-9). It may not exist or you may not have access to it. Run --model to pick a different model.", state: "model_unavailable", source: "observed" },
  { client: "claude", text: "(no output within 170 s behind an unreachable proxy: the client keeps retrying)", state: "offline", source: "observed" },
  { client: "claude", text: "Claude AI usage limit reached|<epoch seconds>", state: "usage_limited", source: "binary" },
  { client: "claude", text: "You've hit your limit · resets 3pm (America/Chicago)", state: "usage_limited", source: "binary" },
  { client: "claude", text: "Claude Opus is not available with the Claude Pro plan", state: "model_unavailable", source: "binary" },
  { client: "claude", text: "Credit balance is too low", state: "plan_insufficient", source: "binary" },
  { client: "claude", text: "Claude Code may not be enabled for your organization", state: "plan_insufficient", source: "binary" },
  { client: "claude", text: "Server is temporarily limiting requests (not your usage limit)", state: "process_failed", source: "binary" },
  { client: "codex", text: "Not logged in (login status, exit 1)", state: "not_signed_in", source: "observed" },
  { client: "codex", text: "Logged in using ChatGPT", state: "ok", source: "observed" },
  { client: "codex", text: "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header", state: "not_signed_in", source: "observed" },
  { client: "codex", text: "The 'gpt-nonexistent-9' model is not supported when using Codex with a ChatGPT account.", state: "model_unavailable", source: "observed" },
  { client: "codex", text: "workspace routing discovery failed", state: "offline", source: "observed" },
  { client: "codex", text: "Not inside a trusted directory and --skip-git-repo-check was not specified.", state: "process_failed", source: "observed" },
  { client: "codex", text: "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus)", state: "plan_insufficient", source: "binary" },
  { client: "codex", text: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:05 PM.", state: "usage_limited", source: "binary" },
  { client: "codex", text: "Your workspace is out of credits. Add credits to continue.", state: "usage_limited", source: "binary" },
  { client: "codex", text: "stream disconnected - retrying sampling request", state: "offline", source: "binary" },
];

/** Claude plans that include Claude Code. A signed-in account reporting "free" can't run it (inferred, not observed). */
const CLAUDE_FREE_PLANS = new Set(["free"]);

/** The client's own status in the chosen mode, as a health state. */
export function stateFromAuth(id: ClientId, auth: ParsedAuth): { state: ClientHealthState; plan?: string } {
  const plan = auth.plan && /^[A-Za-z0-9 _.-]{1,32}$/.test(auth.plan) ? auth.plan : undefined;
  if (auth.signedIn === null) return { state: "installed" };
  if (!auth.signedIn) return { state: "not_signed_in" };
  if (id === "claude" && auth.method === "subscription" && plan && CLAUDE_FREE_PLANS.has(plan.toLowerCase()))
    return { state: "plan_insufficient", plan };
  return { state: "ok", ...(plan ? { plan } : {}) };
}

/** A failed run's kind as a health state; null when the failure says nothing about the client's health. */
export function stateFromError(error: RunnerError): ClientHealthState | null {
  switch (error.kind) {
    case "not_installed":
      return "not_installed";
    case "not_signed_in":
      return "not_signed_in";
    case "usage_limit":
      return "usage_limited";
    case "plan_insufficient":
      return "plan_insufficient";
    case "model_unavailable":
      return "model_unavailable";
    case "offline":
      return "offline";
    default:
      return null;
  }
}

/** The runner error a gate raises for a health state that must not run; null when a run may go ahead. */
export function errorForState(health: Pick<ClientHealth, "state" | "resetsAt">): RunnerError | null {
  switch (health.state) {
    case "not_installed":
      return new RunnerError("not_installed", "health");
    case "not_signed_in":
      return new RunnerError("not_signed_in", "health");
    case "plan_insufficient":
      return new RunnerError("plan_insufficient", "health");
    case "usage_limited":
      return new RunnerError("usage_limit", "health", [], health.resetsAt ? { resetsAt: health.resetsAt } : {});
    case "model_unavailable":
      return new RunnerError("model_unavailable", "health");
    case "offline":
      return new RunnerError("offline", "health");
    default:
      return null;
  }
}

const PROVIDER_HOSTS: Record<ClientId, string> = { claude: "api.anthropic.com", codex: "chatgpt.com", gemini: "generativelanguage.googleapis.com" };
/** A name lookup of the provider's host (no request is sent): false means this device is offline. */
export async function providerReachable(id: ClientId): Promise<boolean> {
  try {
    await Promise.race([
      lookup(PROVIDER_HOSTS[id]),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000).unref()),
    ]);
    return true;
  } catch {
    return false;
  }
}

export interface HealthDeps extends InstantDeps {
  now?: () => number;
  /** Gemini: presence of the student's key. */
  keyStatus?: () => Promise<ApiKeyStatus>;
  online?: (id: ClientId) => Promise<boolean>;
  /** Tests substitute the status command; the app runs the client's own. */
  status?: (id: "claude" | "codex", mode: "instant" | "isolated") => Promise<ParsedAuth>;
}

async function instantStatus(id: "claude" | "codex", deps: HealthDeps): Promise<ParsedAuth> {
  const command = resolveClient(id, deps);
  if (!command) return { signedIn: null, method: null, plan: null };
  try {
    const r = await runProcess(command, [...CLIENTS[id].args.status], {
      cwd: instantWorkDir(deps.userData, id),
      env: instantEnv(id, deps.env ?? process.env),
      timeoutMs: deps.timeoutMs ?? 20_000,
      maxOutputBytes: 64 * 1024,
    });
    return id === "claude" ? parseClaudeAuth(r.stdout) : parseCodexLogin(`${r.stdout}\n${r.stderr}`, r.code);
  } catch (error) {
    if (error instanceof RunnerError) return { signedIn: null, method: null, plan: null };
    throw error;
  }
}

async function isolatedStatus(id: "claude" | "codex", deps: HealthDeps): Promise<ParsedAuth> {
  const s = await authStatus(id, deps);
  return {
    signedIn: s.signedIn === "unknown" ? null : s.signedIn,
    method: s.method === "api-key" ? "api_key" : s.method === "subscription" ? "subscription" : null,
    plan: s.plan ?? null,
  };
}

/**
 * The client's health in a mode (default: its saved mode). Runs `--version`, `--help` (cached) and
 * the client's own status command; never a model call, never a credential read. A saved instant
 * mode that this version no longer supports is reported, and run, as isolated.
 */
export async function checkHealth(id: ClientId, requested: ClientMode | undefined, deps: HealthDeps): Promise<ClientHealth> {
  const checkedAt = new Date((deps.now ?? Date.now)()).toISOString();
  if (id === "gemini") {
    const key = (await deps.keyStatus?.()) ?? { stored: false, inEnvironment: false };
    return {
      id,
      state: key.stored ? "ok" : "not_signed_in",
      mode: "api_key",
      source: "key",
      instant: { available: false, reason: "Gemini runs only with your own API key." },
      modes: ["api_key"],
      checkedAt,
    };
  }
  const saved = requested ?? (await modeOf(id, deps.userData));
  const detected = await detectClient(id, deps);
  const base = { id, checkedAt, ...(detected.version ? { version: detected.version } : {}) };
  if (!detected.installed || detected.problem)
    return { ...base, state: "not_installed", mode: saved === "instant" ? "instant" : "isolated", source: "detect", instant: { available: false }, modes: ["isolated"] };
  const plan = await instantSupport(id, detected.version, deps);
  const modes: ClientMode[] = plan.support.available ? ["instant", "isolated"] : ["isolated"];
  const mode: "instant" | "isolated" = saved === "instant" && plan.support.available ? "instant" : "isolated";
  const auth = await (deps.status ?? ((c, m) => (m === "instant" ? instantStatus(c, deps) : isolatedStatus(c, deps))))(id, mode);
  const { state, plan: planName } = stateFromAuth(id, auth);
  if (state === "installed" && !(await (deps.online ?? providerReachable)(id)))
    return { ...base, state: "offline", mode, source: "status", instant: plan.support, modes };
  return { ...base, state, mode, source: "status", instant: plan.support, modes, ...(planName ? { plan: planName } : {}) };
}

/**
 * Wraps a model backend so health is checked before every run and a failed run updates it.
 * A healthy result is reused for `ttlMs`; any other state is re-checked on the next run. States
 * that can't run (not signed in, plan, limit, model, offline) refuse before anything is sent.
 */
export function healthGatedBackend(
  backend: ModelBackend,
  check: () => Promise<ClientHealth>,
  options: { ttlMs?: number; now?: () => number; onHealth?: (health: ClientHealth) => void } = {},
): ModelBackend & { lastHealth(): ClientHealth | null } {
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? 5 * 60_000;
  let last: { health: ClientHealth; at: number } | null = null;
  const remember = (health: ClientHealth) => {
    last = { health, at: now() };
    options.onHealth?.(health);
  };
  return {
    client: backend.client,
    lastHealth: () => last?.health ?? null,
    async call(call: BackendCall): Promise<BackendResult> {
      if (!last || last.health.state !== "ok" || now() - last.at > ttl) remember(await check());
      const refusal = errorForState(last!.health);
      if (refusal) throw refusal;
      try {
        return await backend.call(call);
      } catch (error) {
        if (error instanceof RunnerError) {
          const state = stateFromError(error);
          if (state && last)
            remember({
              ...last.health,
              state,
              source: "run",
              checkedAt: new Date(now()).toISOString(),
              ...(error.resetsAt ? { resetsAt: error.resetsAt } : {}),
            });
        }
        throw error;
      }
    },
    close: backend.close ? () => backend.close!() : undefined,
  };
}

/** The factories the caller supplies (the worker pools Claude through core's warm pool). */
export interface BackendFactories {
  claude(options: { command: CliCommand; workDir: string; env: Record<string, string>; extraArgs?: readonly string[] }): ModelBackend;
  codex(options: { command: CliCommand; workDir: string; env: Record<string, string>; extraArgs?: readonly string[] }): ModelBackend;
}

/**
 * The chosen client's backend in its mode, health-gated. Isolated mode takes the existing
 * profile options from the caller (`isolated`) so the D45 wiring stays where it is.
 */
export async function clientBackend(
  id: ClientId,
  deps: HealthDeps & { geminiKey?: () => Promise<string | undefined> },
  factories: BackendFactories,
  isolated: () => Promise<{ command: CliCommand; workDir: string; env: Record<string, string> } | null>,
): Promise<{ backend: ModelBackend & { lastHealth(): ClientHealth | null }; mode: ClientMode } | null> {
  const health = await checkHealth(id, undefined, deps);
  const check = () => checkHealth(id, health.mode, deps);
  if (id === "gemini") {
    const key = await deps.geminiKey?.();
    // Refused before any backend exists: without the student's own key nothing is sent (D36).
    if (!key) throw new RunnerError("not_signed_in", "no Gemini key");
    return { backend: healthGatedBackend(createApiBackend({ provider: "gemini", key }), check), mode: "api_key" };
  }
  if (health.state === "not_installed") return null;
  if (health.mode === "instant") {
    const command = resolveClient(id, deps);
    if (!command) return null;
    const plan = await instantSupport(id, health.version, deps);
    const options = await instantRunOptions(id, command, plan, deps);
    return { backend: healthGatedBackend(factories[id](options), check), mode: "instant" };
  }
  const options = await isolated();
  if (!options) return null;
  return { backend: healthGatedBackend(factories[id](options), check), mode: "isolated" };
}

/** Gemini's key in the app's encrypted vault (safeStorage). Only presence ever leaves this module. */
export const GEMINI_KEY = "ai-key:gemini";
export function createApiKeyStore(
  vault: { get(key: string): Promise<string | undefined>; set(key: string, value: string): Promise<void>; deletePrefix(prefix: string): Promise<void> },
  env: NodeJS.ProcessEnv = process.env,
) {
  const inEnvironment = () => Object.entries(env).some(([k, v]) => k.toUpperCase() === "GEMINI_API_KEY" && !!v);
  const status = async (): Promise<ApiKeyStatus> => ({ stored: !!(await vault.get(GEMINI_KEY).catch(() => undefined)), inEnvironment: inEnvironment() });
  return {
    status,
    async save(value: unknown): Promise<ApiKeyStatus> {
      const key = typeof value === "string" ? value.trim() : "";
      if (!/^[A-Za-z0-9_-]{20,200}$/.test(key)) throw new Error("That doesn't look like a Gemini API key.");
      await vault.set(GEMINI_KEY, key);
      return status();
    },
    async remove(): Promise<ApiKeyStatus> {
      await vault.deletePrefix(GEMINI_KEY);
      return status();
    },
    /** Main-side only: the key for the runner's process environment or request header. */
    value: () => vault.get(GEMINI_KEY),
  };
}
