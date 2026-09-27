import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ClientId, ClientStatus } from "@magic/contracts";
import {
  RunnerError,
  allowlistedEnv,
  resolveCli,
  runProcess,
  type CliCommand,
} from "@magic/runner";
import { parseClaudeAuth, parseCodexLogin } from "./auth-parse";

/**
 * T80. The student's AI command-line clients, each run in an app-owned profile under
 * `<userData>/clients/<id>/`. The profile is the client's own config directory, redirected by
 * the client's documented variable, so a sign-in made here lands here and never in the
 * student's `~/.claude` or `~/.codex`. Nothing here reads a credential file.
 *
 * Isolation evidence:
 * - Claude Code: `CLAUDE_CONFIG_DIR` (code.claude.com/docs/en/env-vars) holds settings,
 *   sessions and credentials; a spike on Windows with an empty folder reported "Not logged in"
 *   and left `~/.claude` untouched.
 * - Codex: `CODEX_HOME` (openai/codex; the spike with 0.156.1 reported "Not logged in" and left
 *   `~/.codex` untouched). See the config.toml note below for its credential store.
 * - Gemini CLI: no redirect verified, so it gets no profile and is never launched from here.
 */

export const CLIENT_IDS = ["claude", "codex", "gemini"] as const satisfies readonly ClientId[];
export const clientIdSchema = z.enum(CLIENT_IDS);

interface ClientSpec {
  /** The executable name `resolveCli` looks for. */
  bin: string;
  /** The variable that moves the client's config directory; null when not verified. */
  homeVar: "CLAUDE_CONFIG_DIR" | "CODEX_HOME" | null;
  installUrl: string;
  /**
   * Fixed arguments per purpose. Nothing from the renderer is ever appended. Sign-in only:
   * TODO(T81, interactive session): an interactive client can run shell commands typed into
   * the PTY, and D5 says the model never gets tools inside the app. A `session` purpose comes
   * back only with its own threat model (tools off via `--tools ""`, `--strict-mcp-config`,
   * `--setting-sources`, Codex's sandbox and approval flags, and what the student can type).
   */
  args: { signin: readonly string[]; status: readonly string[] };
}
export const CLIENTS: Record<ClientId, ClientSpec> = {
  claude: {
    bin: "claude",
    homeVar: "CLAUDE_CONFIG_DIR",
    installUrl: "https://code.claude.com/docs/en/setup",
    args: { signin: ["auth", "login"], status: ["auth", "status", "--json"] },
  },
  codex: {
    bin: "codex",
    homeVar: "CODEX_HOME",
    installUrl: "https://developers.openai.com/codex/cli",
    args: { signin: ["login"], status: ["login", "status"] },
  },
  gemini: {
    bin: "gemini",
    homeVar: null,
    installUrl: "https://github.com/google-gemini/gemini-cli",
    args: { signin: [], status: [] },
  },
};

export interface ClientsDeps {
  /** Electron's userData (or a temp folder in tests). */
  userData: string;
  /** Base environment; defaults to process.env. Tests point HOME/USERPROFILE elsewhere. */
  env?: NodeJS.ProcessEnv;
  resolve?: (id: ClientId) => CliCommand | null;
  timeoutMs?: number;
}

export const profileDir = (userData: string, id: ClientId) => join(userData, "clients", id);
/** The app-owned working folder the client starts in, so no project settings are picked up. */
export const workDir = (userData: string, id: ClientId) => join(profileDir(userData, id), "work");
export const mcpPlaceholderPath = (userData: string, id: ClientId) =>
  join(profileDir(userData, id), "magic-mcp.json");
const settingsPath = (userData: string) => join(userData, "client-settings.json");

export const isIsolated = (id: ClientId): boolean => CLIENTS[id].homeVar !== null;

/**
 * The only parent variables a client process inherits: what the OS, the runtime and a proxy
 * need. Everything else is dropped, so no ANTHROPIC_*, CLAUDE_CODE_*, OPENAI_*, CODEX_*,
 * GEMINI_*, AWS_*, GITHUB_* and GH_* or other token variable reaches the client, and an inherited
 * CLAUDE_CONFIG_DIR or CODEX_HOME can't point it back at the student's own folder. Beyond the
 * reviewed list: PATHEXT and SYSTEMDRIVE (Windows program lookup), HOMEDRIVE/HOMEPATH,
 * TMPDIR (macOS temp) and USER/LOGNAME (macOS Keychain and home lookup). Matched
 * case-insensitively, as Windows treats names.
 */
// owner: client-detection: one list for every client spawn (terminal, status, runs, warm pool);
// it lives in the runner as CLIENT_ENV_ALLOW and adds only non-secret system, XDG and
// certificate variables to the reviewed list.
export function allowedEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return allowlistedEnv(base);
}

/**
 * The environment a client runs with: the allowlisted parent variables plus the profile's
 * config-directory variable. For the runner wiring (follow-up) as well as the terminal host.
 * Throws for a client whose profile is not isolated.
 */
export function profileEnv(id: ClientId, deps: Pick<ClientsDeps, "userData" | "env">): NodeJS.ProcessEnv {
  const homeVar = CLIENTS[id].homeVar;
  if (!homeVar) throw new Error(`${id} has no isolated profile.`);
  return { ...allowedEnv(deps.env ?? process.env), [homeVar]: profileDir(deps.userData, id) };
}

export function resolveClient(id: ClientId, deps: ClientsDeps): CliCommand | null {
  return deps.resolve ? deps.resolve(id) : resolveCli(CLIENTS[id].bin, { env: deps.env ?? process.env });
}

/** App-owned files per profile. Each is written only when missing, so the client's own edits stay. */
function profileFiles(id: ClientId): Record<string, string> {
  const mcp = `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`;
  if (id === "claude")
    return {
      // User-scope settings for this profile only: no project MCP servers are auto-approved.
      "settings.json": `${JSON.stringify({ enableAllProjectMcpServers: false }, null, 2)}\n`,
      "magic-mcp.json": mcp,
    };
  if (id === "codex")
    // `file`, not `auto` (keyring). Isolation would hold with `auto`: the keyring entry is
    // `cli|` + sha256(canonical CODEX_HOME)[..16] (openai/codex codex-rs/login/src/auth/
    // storage.rs `compute_store_key`). But that entry outlives the folder: after "Delete local
    // data" removes <userData>/clients, a profile re-created at the same path finds the same
    // entry and is signed in again. With `file` the credential lives in the profile, so the
    // purge removes it. (openai/codex's own app-server test client sets `file` the same way.)
    return {
      "config.toml":
        "# Written by My Magic UW for its own Codex profile. Your ~/.codex is not used.\n" +
        'cli_auth_credentials_store = "file"\n',
      "magic-mcp.json": mcp,
    };
  return {};
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function isProfileReady(id: ClientId, userData: string): Promise<boolean> {
  if (!isIsolated(id)) return false;
  for (const name of Object.keys(profileFiles(id)))
    if (!(await exists(join(profileDir(userData, id), name)))) return false;
  return exists(workDir(userData, id));
}

/** Creates the profile and its app-owned files. Idempotent; never touches the student's home. */
export async function prepareProfile(id: ClientId, deps: Pick<ClientsDeps, "userData">): Promise<boolean> {
  if (!isIsolated(id)) return false;
  const dir = profileDir(deps.userData, id);
  await mkdir(workDir(deps.userData, id), { recursive: true, mode: 0o700 });
  for (const [name, text] of Object.entries(profileFiles(id))) {
    const path = join(dir, name);
    if (!(await exists(path))) await writeFile(path, text, { encoding: "utf8", mode: 0o600, flag: "wx" }).catch((e) => {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    });
  }
  return true;
}

const base = (id: ClientId): ClientStatus => ({
  id,
  installed: false,
  profileReady: false,
  signedIn: "unknown",
  isolated: isIsolated(id),
});

/**
 * `--version` only: no auth, no network, no credential read. Allowed before consent. An
 * isolated client runs with its profile variable set so even this can't write to the home dir.
 */
export async function detectClient(id: ClientId, deps: ClientsDeps): Promise<ClientStatus> {
  const status = { ...base(id), profileReady: await isProfileReady(id, deps.userData) };
  const command = resolveClient(id, deps);
  if (!command) return { ...status, installUrl: CLIENTS[id].installUrl };
  const cwd = isIsolated(id) ? workDir(deps.userData, id) : join(deps.userData, "clients");
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  try {
    const r = await runProcess(command, ["--version"], {
      cwd,
      env: isIsolated(id) ? profileEnv(id, deps) : allowedEnv(deps.env ?? process.env),
      timeoutMs: deps.timeoutMs ?? 20_000,
      maxOutputBytes: 64 * 1024,
    });
    if (r.code !== 0)
      return { ...status, installed: true, problem: `Found, but it didn't start (\`--version\` exited with ${r.code ?? "a signal"}). Reinstall or update it.` };
    const version = /\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?/.exec(r.stdout)?.[0];
    return { ...status, installed: true, ...(version ? { version } : {}) };
  } catch (error) {
    if (!(error instanceof RunnerError)) throw error;
    if (error.kind === "not_installed") return { ...status, installUrl: CLIENTS[id].installUrl };
    return {
      ...status,
      installed: true,
      problem: error.kind === "timeout"
        ? "Found, but `--version` didn't answer in time. Reinstall or update it."
        : "Found, but it didn't start. Reinstall or update it.",
    };
  }
}

export function detectClients(deps: ClientsDeps): Promise<ClientStatus[]> {
  return Promise.all(CLIENT_IDS.map((id) => detectClient(id, deps)));
}

/** Maps the T40 parsers' result onto the bridge's shape. Identity was already dropped there. */
export function toAuthFields(
  parsed: { signedIn: boolean | null; method: string | null; plan: string | null },
): Pick<ClientStatus, "signedIn" | "method" | "plan"> {
  const signedIn = parsed.signedIn === null ? "unknown" : parsed.signedIn;
  const out: Pick<ClientStatus, "signedIn" | "method" | "plan"> = { signedIn };
  if (signedIn === true)
    out.method =
      parsed.method === "api_key" ? "api-key"
        : parsed.method === "subscription" || parsed.method === "chatgpt" ? "subscription"
          : "unknown";
  if (signedIn === true && parsed.plan && /^[A-Za-z0-9 _.-]{1,32}$/.test(parsed.plan)) out.plan = parsed.plan;
  return out;
}

/** The client's own status command inside the profile env. Keeps signed-in, method and plan. */
export async function authStatus(id: ClientId, deps: ClientsDeps): Promise<ClientStatus> {
  const detected = await detectClient(id, deps);
  if (!detected.installed || detected.problem || !isIsolated(id)) return detected;
  await prepareProfile(id, deps);
  const command = resolveClient(id, deps);
  if (!command) return detected;
  const ready = { ...detected, profileReady: await isProfileReady(id, deps.userData) };
  try {
    const r = await runProcess(command, [...CLIENTS[id].args.status], {
      cwd: workDir(deps.userData, id),
      env: profileEnv(id, deps),
      timeoutMs: deps.timeoutMs ?? 20_000,
      maxOutputBytes: 64 * 1024,
    });
    const parsed = id === "claude" ? parseClaudeAuth(r.stdout) : parseCodexLogin(`${r.stdout}\n${r.stderr}`, r.code);
    return { ...ready, ...toAuthFields(parsed) };
  } catch (error) {
    if (error instanceof RunnerError) return ready;
    throw error;
  }
}

const clientSettingsSchema = z.object({ chosen: clientIdSchema.optional() }).strip();
export type ClientSettings = z.infer<typeof clientSettingsSchema>;

export async function readClientSettings(userData: string): Promise<ClientSettings> {
  try {
    const parsed = clientSettingsSchema.safeParse(JSON.parse(await readFile(settingsPath(userData), "utf8")));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** Persists the pick next to session-settings.json. The runner reads it in a follow-up. */
/**
 * owner: reconfigure. "Reconfigure My Magic UW": removes the AI client setup the app keeps, so setup
 * detects everything fresh: the chosen client, each client's connection mode, the separate sign-in
 * profiles and instant-mode working folders. The student's own client installs and settings, the
 * Gemini key (a sign-in), courses and notes are not touched.
 */
export async function resetClientSetup(userData: string): Promise<void> {
  await Promise.all([
    rm(settingsPath(userData), { force: true }),
    rm(join(userData, "client-modes.json"), { force: true }),
    rm(join(userData, "clients"), { recursive: true, force: true }),
  ]);
}
export async function chooseClient(id: ClientId, userData: string): Promise<void> {
  const settings = { ...(await readClientSettings(userData)), chosen: clientIdSchema.parse(id) };
  const path = settingsPath(userData);
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
}
