import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, win32 } from "node:path";
import { RunnerError } from "./types";

/** A resolved executable. `prefixArgs` carries a script path when a runtime launches it. */
export interface CliCommand {
  file: string;
  prefixArgs: string[];
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * npm's Windows `.cmd` shim runs `node "%dp0%\node_modules\…\bin\x.js"`. Node refuses to
 * spawn `.cmd`/`.bat` without a shell (CVE-2024-27980), and a shell would re-parse our
 * arguments, so the shim is read (it is an installer file, not a credential) and resolved to
 * its native binary when the package ships one, else to node plus the script.
 */
export function resolveNpmShim(
  shimPath: string,
  env: NodeJS.ProcessEnv = process.env,
): CliCommand | null {
  let text: string;
  try {
    text = readFileSync(shimPath, "utf8");
  } catch {
    return null;
  }
  // npm writes `"%dp0%\…"`; pnpm and yarn (cmd-shim forks) write `"%~dp0\…"`.
  const match = /"%(?:dp0%|~dp0)\\([^"%]+\.(?:js|mjs|cjs))"/i.exec(text);
  if (!match) return null;
  const dir = dirname(shimPath);
  const script = join(dir, ...match[1].split("\\"));
  if (!isFile(script)) return null;
  const native = nativeBinaryFor(script);
  if (native) return { file: native, prefixArgs: [] };
  const localNode = join(dir, "node.exe");
  const node = isFile(localNode) ? localNode : findOnPath("node", env, "win32");
  return node ? { file: node, prefixArgs: [script] } : null;
}

/** Codex's npm package ships its native binary in a platform package (read from its launcher). */
function nativeBinaryFor(script: string): string | null {
  const packageRoot = dirname(dirname(script));
  if (!/[\\/]@openai[\\/]codex$/i.test(packageRoot)) return null;
  const triple =
    process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  const platformPackage =
    process.arch === "arm64" ? "codex-win32-arm64" : "codex-win32-x64";
  for (const candidate of [
    join(packageRoot, "node_modules", "@openai", platformPackage, "vendor", triple, "bin", "codex.exe"),
    join(packageRoot, "vendor", triple, "bin", "codex.exe"),
  ])
    if (isFile(candidate)) return candidate;
  return null;
}

function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  extraDirs: string[] = [],
): string | null {
  const pathValue = envValue(env, "PATH") ?? "";
  const dirs = [...pathValue.split(listSeparator(platform)), ...extraDirs].filter(Boolean);
  const names = platform === "win32" ? [`${name}.exe`] : [name];
  for (const dir of dirs)
    for (const n of names) {
      const candidate = join(dir, n);
      if (isFile(candidate)) return candidate;
    }
  return null;
}

/** A variable by name, case-insensitively (Windows environments spell PATH as Path). */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key ? env[key] : undefined;
}
const listSeparator = (platform: NodeJS.Platform) => (platform === "win32" ? ";" : ":");
const joinFor = (platform: NodeJS.Platform) => (platform === "win32" ? win32.join : posix.join);

/** `~/.nvm/versions/node/*` bin folders, newest Node first (a client may sit under any of them). */
function nvmBins(root: string, platform: NodeJS.Platform): string[] {
  const j = joinFor(platform);
  let names: string[];
  try {
    names = readdirSync(j(root, "versions", "node"));
  } catch {
    return [];
  }
  const parts = (v: string) => v.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  return names
    .filter((n) => /^v?\d+\.\d+\.\d+/.test(n))
    .sort((a, b) => {
      const [x, y] = [parts(a), parts(b)];
      return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
    })
    .map((n) => j(root, "versions", "node", n, "bin"));
}

/**
 * owner: client-detection. Where the clients' own installers and the common Node version and
 * package managers put executables. An app started from Finder, the Dock or a Start-menu entry
 * may not have these on PATH. Existence is checked by the caller; order is the search order.
 * - Claude Code: the native installer's `~/.local/bin` (both platforms; `claude.exe` on Windows),
 *   and the older local installer's `local` folder inside the `.claude` home folder (its binary only).
 * - Codex: the Windows app installer's `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin`; npm, brew or bun
 *   elsewhere.
 * - npm (`%APPDATA%\npm`, `~/.npm-global/bin`), nvm (every version, newest first), nvm-windows
 *   (`%NVM_SYMLINK%`), Volta, pnpm (`$PNPM_HOME`), bun, Homebrew, winget links and scoop shims.
 */
export function knownCliDirs(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const j = joinFor(platform);
  const v = (name: string) => envValue(env, name);
  const home = platform === "win32" ? (v("USERPROFILE") ?? v("HOME") ?? "") : (v("HOME") ?? v("USERPROFILE") ?? "");
  const under = (base: string | undefined, ...rest: string[]) => (base ? j(base, ...rest) : "");
  const dirs =
    platform === "win32"
      ? [
          under(home, ".local", "bin"),
          under(v("LOCALAPPDATA"), "Programs", "OpenAI", "Codex", "bin"),
          under(v("APPDATA"), "npm"),
          v("PNPM_HOME") ?? "",
          under(v("LOCALAPPDATA"), "pnpm"),
          v("NVM_SYMLINK") ?? "",
          under(v("ProgramFiles") ?? v("PROGRAMFILES"), "nodejs"),
          under(v("LOCALAPPDATA"), "Volta", "bin"),
          under(v("ProgramFiles") ?? v("PROGRAMFILES"), "Volta"),
          under(home, ".bun", "bin"),
          under(home, ".claude", "local"),
          under(home, ".claude", "local", "node_modules", ".bin"),
          under(v("LOCALAPPDATA"), "Microsoft", "WinGet", "Links"),
          under(v("SCOOP") ?? under(home, "scoop"), "shims"),
        ]
      : [
          under(home, ".local", "bin"),
          under(home, ".claude", "local"),
          under(home, ".claude", "local", "node_modules", ".bin"),
          under(home, ".npm-global", "bin"),
          ...nvmBins(v("NVM_DIR") ?? under(home, ".nvm"), platform),
          under(v("VOLTA_HOME") ?? under(home, ".volta"), "bin"),
          v("PNPM_HOME") ?? "",
          platform === "darwin" ? under(home, "Library", "pnpm") : under(home, ".local", "share", "pnpm"),
          under(v("BUN_INSTALL") ?? under(home, ".bun"), "bin"),
          "/opt/homebrew/bin",
          "/usr/local/bin",
        ];
  return [...new Set(dirs.filter(Boolean))];
}

// --- The login shell's PATH (macOS and Linux) ------------------------------------------------------
let shellDirs: string[] = [];
/** The PATH folders read from the student's login shell at startup ([] until read, and on Windows). */
export const loginShellDirs = (): readonly string[] => shellDirs;
const PATH_MARK = "__MAGIC_PATH__";
/** ANSI escape sequences a shell's startup files may print. */
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

/** Pulls PATH out of the login shell's output: only what sits between the markers counts. */
export function parseShellPath(stdout: string): string | null {
  const parts = stdout.split(PATH_MARK);
  if (parts.length < 3) return null;
  const line = parts[1]
    .replace(ANSI, "")
    .split(/\r?\n/)
    .find((l) => l.startsWith("PATH="));
  const value = line?.slice(5).trim();
  return value ? value : null;
}

export type ShellRunner = (shell: string, args: string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<string>;
const runShell: ShellRunner = (shell, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(shell, args, { env: options.env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const out: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("timeout"));
    }, options.timeoutMs);
    child.stdout.on("data", (c: Buffer) => out.length < 256 && out.push(c));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(out).toString("utf8"));
    });
  });

/**
 * owner: client-detection. An app started from Finder or the Dock gets launchd's short PATH, not
 * the one the student's terminal has, so `claude` installed through nvm, Volta or a shell-managed
 * prefix isn't found. This asks the student's login shell for its PATH once, the way the
 * `shell-env` package does (MIT; approach only, no code copied): `$SHELL -ilc` printing `env`
 * between markers, oh-my-zsh auto-update and tmux autostart disabled, ANSI stripped, zsh then bash
 * as fallbacks. stdin and stderr are ignored, and only the PATH line between the markers is kept,
 * so nothing a startup file prints leaks. Two seconds at most. Never runs on Windows.
 */
export async function readLoginShellPath(
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; timeoutMs?: number; run?: ShellRunner; shell?: string } = {},
): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return null;
  const env = options.env ?? process.env;
  const deadline = Date.now() + (options.timeoutMs ?? 2000);
  const own = options.shell ?? envValue(env, "SHELL");
  const shells = [...new Set([own, "/bin/zsh", "/bin/bash"].filter((s): s is string => !!s && s.startsWith("/")))];
  const script = `command printf '%s' ${PATH_MARK}; command env; command printf '%s' ${PATH_MARK}; exit`;
  const shellEnv = { ...env, DISABLE_AUTO_UPDATE: "true", ZSH_TMUX_AUTOSTARTED: "true", ZSH_TMUX_AUTOSTART: "false" };
  for (const shell of shells) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const out = await Promise.race([
        (options.run ?? runShell)(shell, ["-ilc", script], { env: shellEnv, timeoutMs: left }),
        new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("timeout")), left))),
      ]).finally(() => clearTimeout(timer));
      const path = parseShellPath(out);
      if (path) return path;
    } catch {
      // Try the next shell.
    }
  }
  return null;
}

/**
 * owner: client-detection. Run once at startup, before the worker starts: PATH becomes the
 * current PATH, then the login shell's folders (macOS, Linux), then every known install folder
 * that exists. Children (the worker, the clients) inherit it, so a script-based client such as
 * an npm-installed `claude` also finds its `node`. Returns the folders added.
 */
export async function extendPathForClients(
  env: NodeJS.ProcessEnv = process.env,
  options: { platform?: NodeJS.Platform; timeoutMs?: number; run?: ShellRunner; isDir?: (path: string) => boolean } = {},
): Promise<string[]> {
  const platform = options.platform ?? process.platform;
  const sep = listSeparator(platform);
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const current = (env[key] ?? "").split(sep).filter(Boolean);
  const shellPath = await readLoginShellPath({ env, platform, timeoutMs: options.timeoutMs, run: options.run });
  shellDirs = shellPath ? shellPath.split(":").filter(Boolean) : [];
  const isDir = options.isDir ?? ((p: string) => existsSync(p));
  const seen = new Set(current.map((d) => (platform === "win32" ? d.toLowerCase() : d)));
  const added: string[] = [];
  for (const dir of [...shellDirs, ...knownCliDirs(env, platform).filter(isDir)]) {
    const id = platform === "win32" ? dir.toLowerCase() : dir;
    if (seen.has(id)) continue;
    seen.add(id);
    added.push(dir);
  }
  if (added.length) env[key] = [...current, ...added].join(sep);
  return added;
}

/** Every folder `resolveCli` looks in, in order (for the "Why wasn't my client found?" details). */
export function cliSearchDirs(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const pathDirs = (envValue(env, "PATH") ?? "").split(listSeparator(platform)).filter(Boolean);
  return [...new Set([...pathDirs, ...shellDirs, ...knownCliDirs(env, platform)])];
}

/**
 * Finds a CLI without a shell: a native `.exe` first, then an npm `.cmd` shim resolved to what
 * it launches. Returns null when nothing runnable is found. Reads no configuration.
 */
export function resolveCli(
  name: string,
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): CliCommand | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  // owner: client-detection. Folder by folder, in PATH order, the way the student's terminal
  // resolves the name: in each folder the `.exe` and then an npm or pnpm `.cmd` shim. (Every
  // `.exe` first picked the Codex app's older bundled CLI over the npm one the terminal runs.)
  for (const dir of cliSearchDirs(env, platform)) {
    if (platform !== "win32") {
      const file = join(dir, name);
      if (isFile(file)) return { file, prefixArgs: [] };
      continue;
    }
    const exe = join(dir, `${name}.exe`);
    if (isFile(exe)) return { file: exe, prefixArgs: [] };
    const shim = join(dir, `${name}.cmd`);
    if (existsSync(shim)) {
      const resolved = resolveNpmShim(shim, env);
      if (resolved) return resolved;
    }
  }
  return claudeVersionsBinary(name, env, platform);
}

/**
 * owner: client-detection. Claude Code's native installer keeps each version under
 * `~/.local/share/claude/versions/<version>` and points the launcher in `~/.local/bin` at the
 * active one (code.claude.com/docs/en/setup). When that launcher is missing or its symlink is
 * broken, the newest installed version is used.
 */
function claudeVersionsBinary(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): CliCommand | null {
  if (name !== "claude") return null;
  const home = platform === "win32" ? (envValue(env, "USERPROFILE") ?? envValue(env, "HOME")) : (envValue(env, "HOME") ?? envValue(env, "USERPROFILE"));
  if (!home) return null;
  const dir = joinFor(platform)(home, ".local", "share", "claude", "versions");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const parts = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const newest = names
    .filter((n) => /^\d+\.\d+\.\d+$/.test(n) && isFile(join(dir, n)))
    .sort((a, b) => {
      const [x, y] = [parts(a), parts(b)];
      return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
    })[0];
  return newest ? { file: join(dir, newest), prefixArgs: [] } : null;
}

/** Variables the app itself uses that must not reach the student's client. */
const strippedEnv = ["NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "NODE_TEST_CONTEXT"];
const strippedPrefixes = ["MAGIC_", "JEV_"];
export function cliEnvironment(
  extra: Record<string, string> = {},
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (strippedEnv.includes(key.toUpperCase())) continue;
    if (strippedPrefixes.some((p) => key.toUpperCase().startsWith(p))) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}
export interface ProcessOptions {
  stdin?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
}

/** Runs a command without a shell. The prompt goes on stdin; argv holds only our flags and paths. */
export function runProcess(
  command: CliCommand,
  args: string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  const max = options.maxOutputBytes ?? 8 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new RunnerError("aborted"));
      return;
    }
    const child = spawn(command.file, [...command.prefixArgs, ...args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error: RunnerError | null, result?: ProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) {
        child.kill();
        reject(error);
      } else resolve(result!);
    };
    const onAbort = () => finish(new RunnerError("aborted"));
    const timer = setTimeout(
      () => finish(new RunnerError("timeout")),
      options.timeoutMs,
    );
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const collect = (sink: Buffer[]) => (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > max) finish(new RunnerError("invalid_output", "output too large"));
      else sink.push(chunk);
    };
    child.stdout.on("data", collect(out));
    child.stderr.on("data", collect(err));
    child.on("error", (e: NodeJS.ErrnoException) =>
      finish(
        new RunnerError(e.code === "ENOENT" ? "not_installed" : "process_failed"),
      ),
    );
    child.on("close", (code) =>
      finish(null, {
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      }),
    );
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.stdin ?? "");
  });
}
