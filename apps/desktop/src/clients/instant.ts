import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ClientId, ClientMode, InstantSupport } from "@magic/contracts";
import { RunnerError, runProcess, type CliCommand } from "@magic/runner";
import { allowedEnv, clientIdSchema, resolveClient, writeFileAtomic, type ClientsDeps } from "./profiles";

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

/**
 * owner: client-detection. The versions the flag set and its side effects were measured on.
 * Information only (shown in the notice's details): instant mode is offered by what the
 * installed version's `--help` lists, not by its number.
 */
export const INSTANT_TESTED: Record<"claude" | "codex", string> = { claude: "2.1.283", codex: "0.156.1" };

/**
 * Must all appear in `claude --help`. `--safe-mode` is the one that keeps the student's own
 * CLAUDE.md, plugins, hooks and MCP servers out (measured on 2.1.283: `--setting-sources` alone
 * doesn't). No other verified means exists for a version without it, so such a version isn't
 * offered instant mode; the separate sign-in stays available.
 */
export const CLAUDE_REQUIRED_FLAGS = [
  "--print", "--output-format", "--json-schema", "--tools", "--strict-mcp-config",
  "--setting-sources", "--no-session-persistence", "--safe-mode", "--system-prompt", "--model",
] as const;
/** Must all appear in `codex exec --help` (`--ignore-user-config` keeps config.toml and its MCP servers out). */
export const CODEX_REQUIRED_FLAGS = [
  "--ephemeral", "--ignore-user-config", "--skip-git-repo-check", "--output-schema", "--sandbox", "--config",
] as const;
/**
 * Used when listed, dropped when not: `--ignore-rules` (execpolicy rules only matter to commands,
 * which are off) and `--disable` (the tool features; the sandbox stays read-only without it).
 */
export const CODEX_OPTIONAL_FLAGS = ["--ignore-rules", "--disable"] as const;

/** A flag as its own word in a help text (`--system-prompt` isn't satisfied by `--append-system-prompt`). */
export function helpHasFlag(help: string, flag: string): boolean {
  return new RegExp(`(^|[\\s,\\[(])${flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "m").test(help);
}
/**
 * owner: client-detection (security review, 2026-09-27). The only Codex features left as they
 * are: transport and auth plumbing that gives the model nothing to act with. Every other feature
 * the installed version lists (tools, browsers, sleep, code mode, apps, plugins, memories, hooks …)
 * is passed to `--disable`, whether or not it is on today, so a feature a newer version adds or
 * the student's config turns on is off here too. Only listed names are passed: an unknown name is
 * a hard error ("Unknown feature flag"). Keeping `secret_auth_storage` keeps the student's saved
 * sign-in readable.
 */
export const CODEX_SAFE_FEATURES = new Set([
  "enable_request_compression", "content_item_kinds", "compaction_image_budget",
  "secret_auth_storage", "system_proxy_fallback", "unbounded_connection_retries",
]);

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
export function codexInstantArgs(o: { instructionsPath: string; stateDir: string; features: readonly string[]; ignoreRules?: boolean }): string[] {
  // `--skip-git-repo-check` is in the runner's spec argv (codexArgs) for both modes.
  return [
    ...(o.ignoreRules === false ? [] : ["--ignore-rules"]),
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
  /** Codex only: false when this version's `exec --help` doesn't list `--ignore-rules`. */
  ignoreRules?: boolean;
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
 * owner: client-detection. Whether instant mode can be offered for the installed client, by
 * capability: its `--help` must list every required flag. Runs only `--help` (and, for Codex,
 * `features list`): no auth, no network, no model call. Cached per client and version. The tested
 * version is reported as information; an older or newer version with the flags is offered.
 */
export async function instantSupport(id: ClientId, version: string | undefined, deps: InstantDeps): Promise<InstantPlan> {
  const no = (reason: string, missingFlags?: string[]): InstantPlan => ({
    support: { available: false, reason, ...(missingFlags?.length ? { missingFlags } : {}) },
    features: [],
  });
  if (id === "gemini") return no("Gemini runs only with your own API key.");
  const name = id === "claude" ? "Claude Code" : "Codex";
  const testedWith = INSTANT_TESTED[id];
  const key = `${id}@${version ?? "?"}@${deps.userData}`;
  const cached = cache.get(key);
  if (cached && !deps.help) return cached;
  const help = await (deps.help ?? ((c) => runText(c, c === "claude" ? ["--help"] : ["exec", "--help"], deps)))(id);
  const required = id === "claude" ? CLAUDE_REQUIRED_FLAGS : CODEX_REQUIRED_FLAGS;
  const missing = required.filter((flag) => !helpHasFlag(help, flag));
  let plan: InstantPlan;
  if (!help.trim()) plan = no(`${name} didn't answer --help, so its options couldn't be checked.`);
  else if (missing.length)
    plan = no(
      missing.includes("--safe-mode")
        ? `This ${name}${version ? ` (${version})` : ""} has no --safe-mode, which instant mode needs to keep your own CLAUDE.md, plugins and hooks out of My Magic UW's requests.`
        : `This ${name}${version ? ` (${version})` : ""} doesn't offer ${missing.join(", ")}, which instant mode needs to keep your own settings out of My Magic UW's requests.`,
      [...missing],
    );
  else if (id === "claude") plan = { support: { available: true, testedWith }, features: [] };
  else {
    const home = studentCodexHome(deps.env ?? process.env);
    const has = deps.exists ?? fileExists;
    const personal = (await has(join(home, "AGENTS.md"))) || (await has(join(home, "AGENTS.override.md")));
    const features = await codexFeaturesToDisable(help, version, deps);
    // Security review, 2026-09-27: the model never gets tools, so a Codex whose features can't be
    // listed and turned off (the shell among them) isn't run at all.
    plan = !features
      ? no(`This Codex${version ? ` (${version})` : ""} can't turn off its shell and other tools, and My Magic UW never lets the model use tools.`, ["--disable shell_tool"])
      : {
          support: {
            available: true,
            testedWith,
            ...(personal ? { note: "Codex adds your personal AGENTS.md to each request. My Magic UW still checks every answer." } : {}),
          },
          features,
          ignoreRules: helpHasFlag(help, "--ignore-rules"),
        };
  }
  if (!plan.support.available) plan.support.testedWith = testedWith;
  cache.set(key, plan);
  return plan;
}

/** Every listed Codex feature not on the safe list (removed ones excluded), to pass to `--disable`. */
export function featuresToDisable(listText: string): string[] {
  return [...listedFeatures(listText)].filter((f) => !CODEX_SAFE_FEATURES.has(f));
}

const featureCache = new Map<string, string[] | null>();
/** owner: reconfigure. Forgets what was learned about installed clients, so the next check starts fresh. */
export function clearInstantCaches(): void {
  cache.clear();
  featureCache.clear();
}
/**
 * The features to turn off for this Codex, read from `codex features list` once per detected
 * version (cached). Null (don't run) when `--disable` isn't in its `exec --help`, the list can't
 * be read, or the shell tool isn't among the listed features.
 */
async function codexFeaturesToDisable(help: string, version: string | undefined, deps: InstantDeps): Promise<string[] | null> {
  if (!helpHasFlag(help, "--disable")) return null;
  const key = `${version ?? "?"}@${deps.userData}`;
  if (featureCache.has(key) && !deps.features) return featureCache.get(key)!;
  const list = await (deps.features ?? (() => runText("codex", ["features", "list"], deps)))().catch(() => "");
  const off = featuresToDisable(list);
  const result = off.includes("shell_tool") ? off : null;
  if (!deps.features) featureCache.set(key, result);
  return result;
}

/**
 * owner: client-detection (security review, 2026-09-27). The app's own Codex profile gets the
 * same tools-off arguments as instant mode (every non-safe feature disabled, web search off,
 * rules ignored when listed); the read-only sandbox and `approval_policy="never"` are in the
 * runner's spec argv for both modes. Null when this Codex can't turn its tools off: then it isn't run.
 */
export async function codexToolsOffArgs(deps: InstantDeps, version?: string): Promise<string[] | null> {
  const help = await (deps.help ?? ((c) => runText(c, ["exec", "--help"], deps)))("codex");
  const features = await codexFeaturesToDisable(help, version, deps);
  if (!features) return null;
  return [
    ...(helpHasFlag(help, "--ignore-rules") ? ["--ignore-rules"] : []),
    "-c", 'web_search="disabled"',
    ...features.flatMap((f) => ["--disable", f]),
  ];
}

/**
 * owner: client-detection (security review, 2026-09-27). Quick chat's Codex arguments: the
 * interactive CLI takes `--disable` and `-a never` (`codex --help`, 0.156.1: approval values are
 * on-request and never; the old `-a untrusted` isn't one), so its tools are turned off exactly as
 * in runs. Null when they can't be: then Codex has no Quick chat.
 */
export async function codexChatArgs(deps: InstantDeps, version?: string): Promise<string[] | null> {
  const execHelp = await (deps.help ?? ((c) => runText(c, ["exec", "--help"], deps)))("codex");
  const features = await codexFeaturesToDisable(execHelp, version, deps);
  if (!features) return null;
  return ["-s", "read-only", "-a", "never", "-c", 'approval_policy="never"', "-c", 'web_search="disabled"', ...features.flatMap((f) => ["--disable", f])];
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
  return { command, workDir, env, extraArgs: codexInstantArgs({ instructionsPath: path, stateDir, features: plan.features, ignoreRules: plan.ignoreRules }) };
}

/**
 * Quick chat (the `chat` terminal purpose): the client's interactive session with tools, MCP and
 * user customisations off. Fixed per client; the renderer can't add to it. Codex's arguments come
 * from `codexChatArgs` (its features are read per version); without them there is no Codex chat.
 */
export function chatArgs(id: ClientId, codex: readonly string[] | null = null): string[] {
  if (id === "claude") return ["--tools", "", "--strict-mcp-config", "--setting-sources", "project,local", ...CLAUDE_INSTANT_ARGS];
  if (id === "codex" && codex) return [...codex];
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
  await writeFileAtomic(path, `${JSON.stringify({ modes }, null, 2)}\n`);
}
