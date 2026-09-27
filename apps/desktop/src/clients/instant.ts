import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ClientId, ClientMode, InstantSupport } from "@magic/contracts";
import { RunnerError, runProcess, type CliCommand } from "@magic/runner";
import { allowedEnv, clientIdSchema, resolveClient, type ClientsDeps } from "./profiles";

/**
 * owner: client-health (D50). Instant mode: the student's own, already signed-in Claude Code or
 * Codex, run with the app's configuration passed as flags only. Nothing is written to the
 * student's settings; every app file lives under `<userData>/clients/instant/<id>/` (removed by
 * "Delete local data" with the rest of `clients/`).
 *
 * Verified on Windows 11, 2026-09-27, against the installed clients (evidence in health.ts,
 * `HEALTH_EVIDENCE`):
 * - Claude Code 2.1.283: the runner's spec argv (`--tools ""`, `--strict-mcp-config`,
 *   `--setting-sources project,local`, `--no-session-persistence`, `--system-prompt-file`) still
 *   loaded the student's `~/.claude/CLAUDE.md` and a CLAUDE.md in a parent of the working folder
 *   (a fake canary): 3,021 input tokens. Adding `--safe-mode` ("CLAUDE.md, skills, installed
 *   plugins, hooks, MCP servers … disabled … Auth … work[s] normally") loaded neither: 1,298.
 * - Codex 0.156.1: `codex exec` refuses a folder outside a git repository without
 *   `--skip-git-repo-check`. It always reads `$CODEX_HOME/AGENTS.md` (no flag or setting turns it
 *   off; `--ignore-user-config` skips only config.toml). Instant mode is still offered, because it
 *   is the default the operator chose (2026-09-27), with a note saying so; answers are checked by
 *   code either way. The overrides below cut a run from 21,424 to 6,373 input tokens, and
 *   `sqlite_home`/`log_dir` keep Codex's databases and logs in the app's folder.
 */

/** The newest versions the flag set was measured against. Older versions aren't offered instant mode. */
export const INSTANT_VERIFIED: Record<"claude" | "codex", string> = { claude: "2.1.283", codex: "0.156.1" };

/** Must all appear in `claude --help` (`--system-prompt` also matches the hidden `-file` form's docs). */
export const CLAUDE_REQUIRED_FLAGS = [
  "--print", "--output-format", "--json-schema", "--tools", "--strict-mcp-config",
  "--setting-sources", "--no-session-persistence", "--safe-mode", "--system-prompt", "--model",
] as const;
/** Must all appear in `codex exec --help`. */
export const CODEX_REQUIRED_FLAGS = [
  "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check",
  "--output-schema", "--sandbox", "--disable", "--config",
] as const;
/**
 * Codex features that give the model tools or pull in user customisations. Only the ones the
 * installed version lists are passed: an unknown name is a hard error ("Unknown feature flag").
 */
export const CODEX_TOOL_FEATURES = [
  "shell_tool", "unified_exec", "apps", "plugins", "memories", "multi_agent", "browser_use",
  "computer_use", "image_generation", "hooks", "view_image", "goals", "skill_search", "tool_suggest",
] as const;

/** Claude Code instant mode adds only this to the runner's spec argv. */
export const CLAUDE_INSTANT_ARGS = ["--safe-mode"] as const;

/** Base instructions for Codex in instant mode (replaces the coding-agent ones; the pack prefix still leads stdin). */
export const CODEX_INSTRUCTIONS =
  "You are the answer engine inside My Magic UW, a study app. You have no tools. Follow the instructions at the start of each message and reply with exactly one JSON value that matches the output schema.\n";

export const instantDir = (userData: string, id: ClientId) => join(userData, "clients", "instant", id);
export const instantWorkDir = (userData: string, id: ClientId) => join(instantDir(userData, id), "work");
const instructionsPath = (userData: string) => join(instantDir(userData, "codex"), "instructions.md");
const codexStateDir = (userData: string) => join(instantDir(userData, "codex"), "state");

/** TOML basic string: JSON's escapes are valid TOML, so any path (quotes, backslashes) is safe. */
const tomlString = (value: string) => JSON.stringify(value);

/** The arguments Codex instant mode appends to the runner's spec argv (`codexArgs`). */
export function codexInstantArgs(o: { instructionsPath: string; stateDir: string; features: readonly string[] }): string[] {
  return [
    "--ignore-rules",
    "--skip-git-repo-check",
    "-c", `model_instructions_file=${tomlString(o.instructionsPath)}`,
    "-c", `sqlite_home=${tomlString(o.stateDir)}`,
    "-c", `log_dir=${tomlString(o.stateDir)}`,
    "-c", "project_doc_max_bytes=0",
    "-c", "include_permissions_instructions=false",
    "-c", "include_apps_instructions=false",
    "-c", "include_collaboration_mode_instructions=false",
    "-c", "include_environment_context=false",
    "-c", 'web_search="disabled"',
    ...o.features.flatMap((f) => ["--disable", f]),
  ];
}

/**
 * The student's own environment for instant mode: the allowlist, plus their own
 * CLAUDE_CONFIG_DIR or CODEX_HOME when they set one (that is where their sign-in lives).
 * Never the app's profile folder.
 */
export function instantEnv(id: ClientId, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = allowedEnv(base);
  const own = id === "claude" ? "CLAUDE_CONFIG_DIR" : id === "codex" ? "CODEX_HOME" : null;
  if (own)
    for (const [key, value] of Object.entries(base))
      if (key.toUpperCase() === own && value) env[own] = value;
  return env;
}

/** The student's own Codex home (never read; only checked for a global AGENTS.md by name). */
export function studentCodexHome(base: NodeJS.ProcessEnv = process.env): string {
  const own = Object.entries(base).find(([k]) => k.toUpperCase() === "CODEX_HOME")?.[1];
  return own || join(base.USERPROFILE || base.HOME || homedir(), ".codex");
}

/** Numeric dotted compare; a pre-release suffix is ignored. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/** Feature names from `codex features list` (`name  stage  enabled` rows), removed ones excluded. */
export function listedFeatures(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([a-z0-9_.]+)\s+(stable|experimental|under development|deprecated|removed)\s+(true|false)\s*$/.exec(line.trim());
    if (m && m[2] !== "removed") names.add(m[1]);
  }
  return names;
}

export interface InstantDeps extends ClientsDeps {
  /** Tests stub the help texts and the AGENTS.md check; the app runs the client and stats the file. */
  help?: (id: "claude" | "codex") => Promise<string>;
  features?: () => Promise<string>;
  exists?: (path: string) => Promise<boolean>;
}

export interface InstantPlan {
  support: InstantSupport;
  /** Codex only: the tool features this version lists, to be disabled. */
  features: string[];
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function runText(id: "claude" | "codex", args: string[], deps: InstantDeps): Promise<string> {
  const command = resolveClient(id, deps);
  if (!command) return "";
  const cwd = instantWorkDir(deps.userData, id);
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  try {
    const r = await runProcess(command, args, {
      cwd,
      env: instantEnv(id, deps.env ?? process.env),
      timeoutMs: deps.timeoutMs ?? 20_000,
      maxOutputBytes: 512 * 1024,
    });
    return `${r.stdout}\n${r.stderr}`;
  } catch (error) {
    if (error instanceof RunnerError) return "";
    throw error;
  }
}

const cache = new Map<string, InstantPlan>();

/**
 * Whether instant mode can be offered for a client at this version. Runs only `--help` (and, for
 * Codex, `features list`): no auth, no network, no model call. Cached per client and version.
 */
export async function instantSupport(id: ClientId, version: string | undefined, deps: InstantDeps): Promise<InstantPlan> {
  const no = (reason: string): InstantPlan => ({ support: { available: false, reason }, features: [] });
  if (id === "gemini") return no("Gemini runs only with your own API key.");
  if (!version) return no("The installed version couldn't be read, so instant mode wasn't checked.");
  if (compareVersions(version, INSTANT_VERIFIED[id]) < 0)
    return no(`Instant mode is checked from version ${INSTANT_VERIFIED[id]}; update ${id === "claude" ? "Claude Code" : "Codex"} to use it.`);
  const key = `${id}@${version}@${deps.userData}`;
  const cached = cache.get(key);
  if (cached && !deps.help) return cached;
  const help = await (deps.help ?? ((c) => runText(c, c === "claude" ? ["--help"] : ["exec", "--help"], deps)))(id);
  const required = id === "claude" ? CLAUDE_REQUIRED_FLAGS : CODEX_REQUIRED_FLAGS;
  const missing = required.filter((flag) => !help.includes(flag));
  let plan: InstantPlan;
  if (missing.length) plan = no(`This version doesn't offer ${missing.join(", ")}, so the app can't keep your own settings out of its runs.`);
  else if (id === "claude") plan = { support: { available: true }, features: [] };
  else {
    const home = studentCodexHome(deps.env ?? process.env);
    const has = deps.exists ?? fileExists;
    const personal = (await has(join(home, "AGENTS.md"))) || (await has(join(home, "AGENTS.override.md")));
    const listed = listedFeatures(await (deps.features ?? (() => runText("codex", ["features", "list"], deps)))());
    plan = {
      support: personal
        ? { available: true, note: "Codex adds your personal AGENTS.md to each request. My Magic UW still checks every answer." }
        : { available: true },
      features: CODEX_TOOL_FEATURES.filter((f) => listed.has(f)),
    };
  }
  cache.set(key, plan);
  return plan;
}

/** The backend options for an instant-mode run: cwd, env and the extra argv. Creates app files only. */
export async function instantRunOptions(
  id: "claude" | "codex",
  command: CliCommand,
  plan: InstantPlan,
  deps: Pick<ClientsDeps, "userData" | "env">,
): Promise<{ command: CliCommand; workDir: string; env: Record<string, string>; extraArgs: string[] }> {
  if (!plan.support.available) throw new RunnerError("unavailable", "instant mode is not available");
  const workDir = instantWorkDir(deps.userData, id);
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  const env = Object.fromEntries(
    Object.entries(instantEnv(id, deps.env ?? process.env)).flatMap(([k, v]) => (v === undefined ? [] : [[k, v]])),
  );
  if (id === "claude") return { command, workDir, env, extraArgs: [...CLAUDE_INSTANT_ARGS] };
  const stateDir = codexStateDir(deps.userData);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const path = instructionsPath(deps.userData);
  await writeFile(path, CODEX_INSTRUCTIONS, { encoding: "utf8", mode: 0o600 });
  return { command, workDir, env, extraArgs: codexInstantArgs({ instructionsPath: path, stateDir, features: plan.features }) };
}

/**
 * Quick chat (the `chat` terminal purpose): the client's interactive session with tools, MCP and
 * user customisations off. Fixed per client; the renderer can't add to it.
 */
export function chatArgs(id: ClientId, features: readonly string[] = []): string[] {
  if (id === "claude") return ["--tools", "", "--strict-mcp-config", "--setting-sources", "project,local", ...CLAUDE_INSTANT_ARGS];
  if (id === "codex")
    return ["-s", "read-only", "-a", "untrusted", "-c", 'web_search="disabled"', ...features.flatMap((f) => ["--disable", f])];
  throw new Error("This client has no chat.");
}

// --- The saved mode per client --------------------------------------------------------------------
const modesSchema = z
  .object({ modes: z.partialRecord(clientIdSchema, z.enum(["instant", "isolated", "api_key"])).default({}) })
  .strip();
const modesPath = (userData: string) => join(userData, "client-modes.json");

export async function readClientModes(userData: string): Promise<Partial<Record<ClientId, ClientMode>>> {
  try {
    const parsed = modesSchema.safeParse(JSON.parse(await readFile(modesPath(userData), "utf8")));
    return parsed.success ? parsed.data.modes : {};
  } catch {
    return {};
  }
}
/**
 * The default when nothing was saved: the student's own client (operator, 2026-09-27: "it should
 * just auto invoke your machines authenticated claude code"), or Gemini's key. The app's own
 * profile is only ever an explicit opt-in.
 */
export const defaultMode = (id: ClientId): ClientMode => (id === "gemini" ? "api_key" : "instant");
export async function modeOf(id: ClientId, userData: string): Promise<ClientMode> {
  return (await readClientModes(userData))[id] ?? defaultMode(id);
}
export async function writeClientMode(id: ClientId, mode: ClientMode, userData: string): Promise<void> {
  const modes = { ...(await readClientModes(userData)), [clientIdSchema.parse(id)]: mode };
  const path = modesPath(userData);
  await mkdir(userData, { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify({ modes }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
}
