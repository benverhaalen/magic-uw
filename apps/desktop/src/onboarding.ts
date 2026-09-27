import { mkdir } from "node:fs/promises";
import { z } from "zod";
import { createLocalAi } from "@magic/ai";
import {
  RunnerError,
  cliEnvironment,
  resolveCli,
  runProcess,
  type ApiProvider,
  type CliCommand,
  type ModelBackend,
  type RunnerErrorKind,
  type Tier,
} from "@magic/runner";

/**
 * T40 onboarding detection (spec E4, D36, D40). Detects the installed CLIs, asks each CLI for
 * its own sign-in state, and chooses the engine in the order Claude Code → Codex → a stored
 * key (Gemini first) → Ollama. Reads no credential file and never writes the student's client
 * settings. Nothing here prompts: sign-in and install steps are returned as actions for the
 * settings view, and run only when the student starts them there.
 */

export type CliClient = "claude" | "codex";
export interface ClientDetection {
  client: CliClient;
  installed: boolean;
  version: string | null;
  /** null when the CLI couldn't say. */
  signedIn: boolean | null;
  /** "subscription" | "api_key" for Claude; "chatgpt" | "api_key" for Codex. */
  method: string | null;
  /** Claude's `subscriptionType` (pro, max, team, enterprise). */
  plan: string | null;
  command: CliCommand | null;
}
export interface Detection {
  clients: ClientDetection[];
  /** Providers with a key in the app's encrypted store. Presence only, never the key. */
  storedKeys: ApiProvider[];
  local: { ready: boolean; reason: string };
}

export type EngineChoice =
  | { engine: "claude"; route: "subscription" | "api_key"; command: CliCommand }
  | { engine: "codex"; route: "chatgpt" | "api_key"; command: CliCommand }
  | { engine: "api"; provider: ApiProvider }
  | { engine: "local" }
  | { engine: "none" };
export type EnginePreference = CliClient | ApiProvider | "local";
export interface OnboardingSettings {
  /** Fully local mode (spec E3b): hosted AI, Jev included, is blocked. */
  localOnly?: boolean;
  /** D40: Ollama as an opt-in setting even when a client is found. */
  preferLocal?: boolean;
  /** The student's explicit pick in settings; honoured when it's available. */
  preferred?: EnginePreference;
}
export interface SetupAction {
  client: CliClient | ApiProvider | "local";
  kind: "sign_in" | "install" | "add_key" | "start_local";
  /** The provider's own command, shown in the panel; run only after the student clicks. */
  command?: string;
}
export interface EngineDecision {
  choice: EngineChoice;
  reason: string;
  actions: SetupAction[];
  disclosures: string[];
}

/** D36: stored keys after the signed-in CLIs, Gemini first (the only Gemini route). */
const KEY_ORDER: ApiProvider[] = ["gemini", "openrouter", "anthropic", "openai"];

function usable(c: ClientDetection | undefined): c is ClientDetection & { command: CliCommand } {
  return !!c && c.installed && c.signedIn === true && !!c.command;
}
function clientChoice(c: ClientDetection & { command: CliCommand }): EngineChoice {
  return c.client === "claude"
    ? { engine: "claude", route: c.method === "api_key" ? "api_key" : "subscription", command: c.command }
    : { engine: "codex", route: c.method === "api_key" ? "api_key" : "chatgpt", command: c.command };
}

/** The decision table. Pure: the same detection and settings give the same answer. */
export function chooseEngine(d: Detection, settings: OnboardingSettings = {}): EngineDecision {
  const claude = d.clients.find((c) => c.client === "claude");
  const codex = d.clients.find((c) => c.client === "codex");
  const actions: SetupAction[] = [];
  for (const c of [claude, codex]) {
    if (!c) continue;
    if (!c.installed) actions.push({ client: c.client, kind: "install" });
    else if (c.signedIn !== true)
      actions.push({ client: c.client, kind: "sign_in", command: c.client === "claude" ? "claude auth login" : "codex login" });
  }
  if (!d.local.ready) actions.push({ client: "local", kind: "start_local" });
  const disclose = (choice: EngineChoice): string[] =>
    choice.engine === "codex" && choice.route === "chatgpt"
      ? ["Codex on a ChatGPT plan has no documented arrangement for third-party apps (openai/codex#36886). Your own OpenAI key is the alternative."]
      : choice.engine === "claude" || choice.engine === "codex"
        ? ["Background work runs on your own client within the background budget, and every run is in the ledger."]
        : [];
  const decide = (choice: EngineChoice, reason: string): EngineDecision => ({
    choice,
    reason,
    actions,
    disclosures: disclose(choice),
  });

  if (settings.localOnly)
    return d.local.ready
      ? decide({ engine: "local" }, "Fully local mode: prompts go only to Ollama on this device.")
      : decide({ engine: "none" }, "Fully local mode is on and no local model is ready; generation waits.");
  const available = (p: EnginePreference): EngineChoice | null => {
    if (p === "local") return d.local.ready ? { engine: "local" } : null;
    if (p === "claude") return usable(claude) ? clientChoice(claude) : null;
    if (p === "codex") return usable(codex) ? clientChoice(codex) : null;
    return d.storedKeys.includes(p) ? { engine: "api", provider: p } : null;
  };
  if (settings.preferred) {
    const picked = available(settings.preferred);
    if (picked) return decide(picked, `Your choice in settings: ${settings.preferred}.`);
  }
  if (settings.preferLocal && d.local.ready)
    return decide({ engine: "local" }, "Ollama is on in settings.");
  if (usable(claude)) return decide(clientChoice(claude), "Claude Code is installed and signed in.");
  if (usable(codex)) return decide(clientChoice(codex), "Codex is installed and signed in.");
  for (const p of KEY_ORDER)
    if (d.storedKeys.includes(p)) return decide({ engine: "api", provider: p }, `A stored ${p} key.`);
  if (d.local.ready) return decide({ engine: "local" }, "No AI client was found; Ollama on this device is ready.");
  actions.push({ client: "openrouter", kind: "add_key" });
  return decide(
    { engine: "none" },
    "No signed-in client, stored key or local model. Study, mapping by code and Jev still work; generation waits.",
  );
}

const claudeAuth = z
  .object({
    loggedIn: z.boolean(),
    authMethod: z.string().max(64).optional(),
    subscriptionType: z.string().max(64).nullable().optional(),
  })
  .strip();

/** Keeps only loggedIn, authMethod and subscriptionType; email and organisation are dropped. */
export function parseClaudeAuth(stdout: string): Pick<ClientDetection, "signedIn" | "method" | "plan"> {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return { signedIn: null, method: null, plan: null };
  }
  const r = claudeAuth.safeParse(raw);
  if (!r.success) return { signedIn: null, method: null, plan: null };
  return {
    signedIn: r.data.loggedIn,
    method: r.data.loggedIn ? (/api/i.test(r.data.authMethod ?? "") ? "api_key" : "subscription") : null,
    plan: r.data.loggedIn ? (r.data.subscriptionType ?? null) : null,
  };
}
/** `codex login status` prints e.g. "Logged in using ChatGPT"; only the method is kept. */
export function parseCodexLogin(text: string, code: number | null): Pick<ClientDetection, "signedIn" | "method" | "plan"> {
  const m = /logged in using (chatgpt|an api key|api key)/i.exec(text);
  if (m) return { signedIn: true, method: /chatgpt/i.test(m[1]) ? "chatgpt" : "api_key", plan: null };
  if (/not logged in/i.test(text) || code !== 0) return { signedIn: false, method: null, plan: null };
  return { signedIn: null, method: null, plan: null };
}

export interface OnboardingDeps {
  /** App-owned folder the CLIs run in. */
  workDir: string;
  resolve?: (name: CliClient) => CliCommand | null;
  storedKeys?: () => Promise<ApiProvider[]>;
  localStatus?: () => Promise<{ ready: boolean; reason: string }>;
  timeoutMs?: number;
}

async function detectClient(client: CliClient, deps: OnboardingDeps): Promise<ClientDetection> {
  const command = (deps.resolve ?? ((n: CliClient) => resolveCli(n)))(client);
  const none: ClientDetection = { client, installed: false, version: null, signedIn: null, method: null, plan: null, command: null };
  if (!command) return none;
  const exec = (args: string[]) =>
    runProcess(command, args, {
      cwd: deps.workDir,
      env: cliEnvironment(),
      timeoutMs: deps.timeoutMs ?? 20_000,
      maxOutputBytes: 64 * 1024,
    });
  let version: string | null;
  try {
    const v = await exec(["--version"]);
    if (v.code !== 0) return none;
    version = /\d+\.\d+\.\d+/.exec(v.stdout)?.[0] ?? null;
  } catch (error) {
    if (error instanceof RunnerError) return none;
    throw error;
  }
  try {
    if (client === "claude") {
      const s = await exec(["auth", "status", "--json"]);
      return { ...none, installed: true, version, command, ...parseClaudeAuth(s.stdout) };
    }
    const s = await exec(["login", "status"]);
    return { ...none, installed: true, version, command, ...parseCodexLogin(`${s.stdout}\n${s.stderr}`, s.code) };
  } catch (error) {
    if (error instanceof RunnerError) return { ...none, installed: true, version, command };
    throw error;
  }
}

export async function detect(deps: OnboardingDeps): Promise<Detection> {
  await mkdir(deps.workDir, { recursive: true });
  const localStatus =
    deps.localStatus ??
    (async () => {
      const s = await createLocalAi().status();
      return { ready: s.status === "ready", reason: s.reason };
    });
  const [claude, codex, storedKeys, local] = await Promise.all([
    detectClient("claude", deps),
    detectClient("codex", deps),
    deps.storedKeys ? deps.storedKeys() : Promise.resolve([] as ApiProvider[]),
    localStatus().catch(() => ({ ready: false, reason: "The local model service could not be checked." })),
  ]);
  return { clients: [claude, codex], storedKeys, local };
}

export interface TierProbe {
  served: boolean;
  model: string | null;
  errorKind?: RunnerErrorKind;
}
const probeSchema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
/**
 * Asks each tier's model for a one-field answer (spec E3: detected, not assumed). This spends a
 * few tokens, so it runs only when the student presses the check in settings.
 */
export async function probeModels(backend: ModelBackend, signal?: AbortSignal): Promise<Record<Tier, TierProbe>> {
  const out = {} as Record<Tier, TierProbe>;
  for (const tier of ["pass", "strong"] as const) {
    try {
      const r = await backend.call({
        pack: { id: "probe", version: "v1" },
        systemPrompt: "Reply with {\"ok\": true}.",
        input: "ok?",
        jsonSchema: probeSchema,
        tier,
        lane: "interactive",
        maxOutputTokens: 20,
        timeoutMs: 60_000,
        signal,
      });
      out[tier] = { served: true, model: r.model };
    } catch (error) {
      if (!(error instanceof RunnerError)) throw error;
      out[tier] = { served: false, model: null, errorKind: error.kind };
    }
  }
  return out;
}

/** "Config import" (T40): an environment key is read only after the student agrees. */
export function environmentKey(
  provider: ApiProvider,
  consented: boolean,
  env: NodeJS.ProcessEnv = process.env,
): { present: boolean; key: string | null } {
  const name = { openrouter: "OPENROUTER_API_KEY", anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", gemini: "GEMINI_API_KEY" }[provider];
  const value = env[name];
  return { present: !!value, key: consented && value ? value : null };
}

export interface OnboardingState {
  detection: Detection;
  decision: EngineDecision;
  checkedAt: string;
}
/** The settings view reads `state()`; `refresh()` re-detects. Nothing runs until called. */
export function createOnboarding(deps: OnboardingDeps & { settings?: () => OnboardingSettings }) {
  let current: OnboardingState | null = null;
  let running: Promise<OnboardingState> | null = null;
  return {
    state: () => current,
    refresh(): Promise<OnboardingState> {
      running ??= (async () => {
        try {
          const detection = await detect(deps);
          current = { detection, decision: chooseEngine(detection, deps.settings?.() ?? {}), checkedAt: new Date().toISOString() };
          return current;
        } finally {
          running = null;
        }
      })();
      return running;
    },
  };
}
