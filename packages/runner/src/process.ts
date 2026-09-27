import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
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
  const match = /"%dp0%\\([^"%]+\.(?:js|mjs|cjs))"/i.exec(text);
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
  const pathValue = env.PATH ?? env.Path ?? "";
  const dirs = [...pathValue.split(delimiter), ...extraDirs].filter(Boolean);
  const names = platform === "win32" ? [`${name}.exe`] : [name];
  for (const dir of dirs)
    for (const n of names) {
      const candidate = join(dir, n);
      if (isFile(candidate)) return candidate;
    }
  return null;
}

/** Official install locations an app launched outside a shell may not have on PATH. */
function knownDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const home = env.USERPROFILE ?? env.HOME ?? "";
  if (platform === "win32")
    return [
      home && join(home, ".local", "bin"),
      env.APPDATA && join(env.APPDATA, "npm"),
    ].filter((d): d is string => Boolean(d));
  return [
    home && join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ].filter((d): d is string => Boolean(d));
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
  const extra = knownDirs(env, platform);
  const native = findOnPath(name, env, platform, extra);
  if (native) return { file: native, prefixArgs: [] };
  if (platform !== "win32") return null;
  const pathValue = env.PATH ?? env.Path ?? "";
  for (const dir of [...pathValue.split(delimiter), ...extra].filter(Boolean)) {
    const shim = join(dir, `${name}.cmd`);
    if (existsSync(shim)) {
      const resolved = resolveNpmShim(shim, env);
      if (resolved) return resolved;
    }
  }
  return null;
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
