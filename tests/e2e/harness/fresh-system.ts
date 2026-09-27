/**
 * The fresh-system launcher: starts the real Electron app with a brand-new home, app data and
 * user data, a PATH of system folders plus a folder of client executables, and nothing else from
 * this machine. Tier 1 puts the fake clients there; Tier 2 puts the cost guard there, which runs
 * the operator's real clients with their own home (see `RealClients`).
 */
import { copyFile, link, mkdir, mkdtemp, readFile, rm, stat, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import electronPath from "electron";
import { _electron, type ElectronApplication, type Page } from "playwright";
import type { Scenario } from "./scenarios";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FAKE = join(REPO, "tests", "e2e", "fake-cli", "fake.mjs");
const GUARD = join(REPO, "tests", "e2e", "real", "guard.mjs");
const isWindows = process.platform === "win32";

/** Canary values set in the app's environment: they must never reach a client in instant mode. */
export const CANARY_ENV = { ANTHROPIC_API_KEY: "e2e-canary-not-a-key", OPENAI_API_KEY: "e2e-canary-not-a-key", ANTHROPIC_BASE_URL: "http://canary.invalid" };
/** Names a client's environment must not carry (unless the scenario is API-key mode). */
export const FORBIDDEN_ENV = /^(ANTHROPIC_|OPENAI_|CLAUDE_CODE_|CODEX_API|GEMINI_|MAGIC_|JEV_|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$)/i;

export interface FakeCall {
  at: number;
  pid: number;
  client: "claude" | "codex";
  kind: "version" | "help" | "features" | "status" | "login" | "interactive" | "rejected" | "run" | "session" | "ask";
  argv: string[];
  env: string[];
  cwd: string;
  wrote?: string[];
  pack?: string;
  stdinBytes?: number;
  systemPromptBytes?: number;
}

/**
 * Tier 2: the operator's real clients behind the cost guard (tests/e2e/real/guard.mjs). The app
 * still runs on a fresh home; the guard gives each real client the operator's own home, app data
 * and PATH (paths only, recorded here), so it runs signed in. Why the app doesn't get the real
 * home: on Windows the app's resolveCli finds ~/.local/bin/claude.exe (and any codex.exe on PATH)
 * before a .cmd on PATH, so it would bypass the guard and its cost cap.
 */
export interface RealClients {
  claude: { file: string; prefixArgs: string[]; model: string } | null;
  codex: { file: string; prefixArgs: string[]; model: string; effort: "low" | "medium" | "high" } | null;
  /** Characters of prompt (system prompt + input) one call may send; about 4 characters per token. */
  capChars: number;
  /** Generation calls per client. */
  maxCalls: number;
}

export interface FreshSystemOptions {
  /** A short name for the artifacts folder. */
  name: string;
  /** Tier 1: the fake clients' scenario. */
  scenario?: Scenario;
  /** Tier 2: the real clients behind the guard. */
  real?: RealClients;
  /** Set the canary API-key variables in the app's environment (Tier 1 default: true). */
  canaries?: boolean;
  artifactsRoot?: string;
}

export interface FreshSystem {
  root: string;
  /** The home the app sees (always fresh). */
  home: string;
  userData: string;
  /** The folder of client executables first on PATH (fakes or the guard). */
  bin: string;
  artifacts: string;
  app: ElectronApplication;
  page: Page;
  env: Record<string, string>;
  setScenario(scenario: Scenario): Promise<void>;
  /** Uncaught renderer errors and console errors so far (also saved as renderer-errors.txt). */
  errors(): string[];
  /** Tier 1: the fake clients' call records. */
  calls(): Promise<FakeCall[]>;
  /** Stops tracing and the app; returns the trace and video paths. Removes the temp root unless kept. */
  close(options?: { keep?: boolean }): Promise<{ trace: string; video: string | null }>;
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
export function artifactsRoot(): string {
  return process.env.MAGIC_E2E_ARTIFACTS || join(tmpdir(), "magic-e2e-artifacts");
}

/** A client executable the app's own `resolveCli` finds: an npm-style .cmd shim on Windows, a script elsewhere. */
async function writeClient(bin: string, id: "claude" | "codex", target: string): Promise<void> {
  await writeFile(join(bin, `${id}.mjs`), `import { main } from ${JSON.stringify(pathToFileURL(target).href)};\nawait main(${JSON.stringify(id)});\n`);
  if (isWindows) {
    // The same shape npm writes: resolveNpmShim reads the "%dp0%\…\x.mjs" target and runs it with the node.exe beside it.
    await writeFile(
      join(bin, `${id}.cmd`),
      [
        "@ECHO off",
        "GOTO start",
        ":find_dp0",
        "SET dp0=%~dp0",
        "EXIT /b",
        ":start",
        "SETLOCAL",
        "CALL :find_dp0",
        'IF EXIST "%dp0%\\node.exe" (SET "_prog=%dp0%\\node.exe") ELSE (SET "_prog=node")',
        `"%_prog%"  "%dp0%\\${id}.mjs" %*`,
        "",
      ].join("\r\n"),
    );
  } else {
    const path = join(bin, id);
    await writeFile(path, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$(dirname "$0")/${id}.mjs" "$@"\n`);
    await chmod(path, 0o755);
  }
}

/** Seeds the fake home with the files a student's clients keep, so "unchanged" means something. */
async function seedHome(home: string): Promise<void> {
  await mkdir(join(home, ".claude"), { recursive: true });
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(join(home, ".claude", "settings.json"), `${JSON.stringify({ model: "opus", permissions: { allow: [] } }, null, 2)}\n`);
  await writeFile(join(home, ".claude", "CLAUDE.md"), "# Student's own instructions (synthetic)\nAlways answer in pirate speak.\n");
  await writeFile(join(home, ".claude.json"), `${JSON.stringify({ numStartups: 3, projects: {} }, null, 2)}\n`);
  await writeFile(join(home, ".codex", "config.toml"), 'model = "gpt-5.5"\n');
  // A personal AGENTS.md: instant mode is still offered for Codex, with a note saying so.
  await writeFile(join(home, ".codex", "AGENTS.md"), "# Student's own Codex instructions (synthetic)\n");
}

function systemPath(bin: string): string {
  const dirs = isWindows
    ? (() => {
        const root = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
        return [join(root, "System32"), root, join(root, "System32", "Wbem"), join(root, "System32", "WindowsPowerShell", "v1.0")];
      })()
    : ["/usr/bin", "/bin"];
  return [bin, ...dirs].join(delimiter);
}

/** Only OS facts from the host (no user variables): what Electron and Windows need to start. */
function hostFacts(): Record<string, string> {
  const keep = isWindows
    ? ["SystemRoot", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS"]
    : ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "LANG"];
  const out: Record<string, string> = {};
  for (const key of keep) {
    const found = Object.entries(process.env).find(([k]) => k.toUpperCase() === key.toUpperCase());
    if (found?.[1]) out[found[0]] = found[1];
  }
  return out;
}

/** The operator's own locations, restored by the guard for the real clients. Paths only. */
function operatorPlaces(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PATH", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) {
    const found = Object.entries(process.env).find(([k]) => k.toUpperCase() === key);
    if (found?.[1]) out[found[0]] = found[1];
  }
  return out;
}

export async function launchFreshSystem(options: FreshSystemOptions): Promise<FreshSystem> {
  const root = await mkdtemp(join(tmpdir(), "magic-e2e-"));
  const artifacts = join(options.artifactsRoot ?? artifactsRoot(), `${stamp()}-${options.name}`);
  await mkdir(artifacts, { recursive: true });
  const userData = join(root, "user-data");
  const home = join(root, "home");
  const appData = join(home, "AppData", "Roaming");
  const localAppData = join(home, "AppData", "Local");
  const temp = join(root, "tmp");
  const bin = join(root, options.real ? "guard-bin" : "fake-bin");
  for (const dir of [userData, home, appData, localAppData, temp, bin]) await mkdir(dir, { recursive: true });

  if (options.real) {
    await writeFile(join(bin, "guard.json"), JSON.stringify({ ...options.real, restore: operatorPlaces() }, null, 2));
    for (const id of ["claude", "codex"] as const) if (options.real[id]) await writeClient(bin, id, GUARD);
  } else {
    await seedHome(home);
    const scenario = options.scenario;
    if (!scenario) throw new Error("A Tier 1 fresh system needs a scenario.");
    await writeFile(join(bin, "scenario.json"), JSON.stringify(scenario, null, 2));
    for (const id of ["claude", "codex"] as const) if (scenario[id].installed !== false) await writeClient(bin, id, FAKE);
  }
  if (isWindows) {
    // node.exe beside the shims (as npm's own layout has it): PATH itself carries no Node.
    await link(process.execPath, join(bin, "node.exe")).catch(() => copyFile(process.execPath, join(bin, "node.exe")));
  }
  const env: Record<string, string> = {
    ...hostFacts(),
    PATH: systemPath(bin),
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    LANG: "en_US.UTF-8",
    ...(options.real || options.canaries === false ? {} : CANARY_ENV),
    MAGIC_USER_DATA: userData,
    MAGIC_HEADLESS: "1",
    MAGIC_GATEWAY_URL: "",
  };

  const app = await _electron.launch({
    executablePath: electronPath as unknown as string,
    // Chromium's resolver answers nothing but loopback: the renderer and the app's sessions
    // can't reach the network. The clients are separate processes, unaffected.
    // Linux CI runners can't start Chromium's setuid sandbox (Ubuntu 24.04 restricts user
    // namespaces), so CI on Linux runs without it; the renderer's own sandbox flag is unchanged.
    args: [
      "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost",
      ...(process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : []),
      join(REPO, "apps", "desktop"),
    ],
    cwd: REPO,
    env,
    recordVideo: { dir: artifacts, size: { width: 1240, height: 820 } },
    timeout: 60_000,
  });
  await app.context().tracing.start({ screenshots: true, snapshots: true, title: options.name });
  const page = await app.firstWindow();
  const rendererErrors: string[] = [];
  page.on("pageerror", (error) => rendererErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") rendererErrors.push(`console: ${message.text().slice(0, 500)}`);
  });
  await page.waitForLoadState("domcontentloaded");

  return {
    root,
    home,
    userData,
    bin,
    artifacts,
    app,
    page,
    env,
    async setScenario(scenario) {
      if (options.real) throw new Error("Real clients have no scenario.");
      await writeFile(join(bin, "scenario.json"), JSON.stringify(scenario, null, 2));
      // Installing or removing a client is adding or removing its executable.
      for (const id of ["claude", "codex"] as const) {
        const exe = join(bin, isWindows ? `${id}.cmd` : id);
        if (scenario[id].installed === false) await rm(exe, { force: true });
        else if (!existsSync(exe)) await writeClient(bin, id, FAKE);
      }
    },
    errors: () => [...rendererErrors],
    async calls() {
      if (!existsSync(join(bin, "calls.jsonl"))) return [];
      const text = await readFile(join(bin, "calls.jsonl"), "utf8");
      return text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as FakeCall);
    },
    async close({ keep } = {}) {
      const trace = join(artifacts, "trace.zip");
      await app.context().tracing.stop({ path: trace }).catch(() => undefined);
      const video = page.video();
      await app.close().catch(() => undefined);
      const videoPath = video ? await video.path().catch(() => null) : null;
      if (rendererErrors.length) await writeFile(join(artifacts, "renderer-errors.txt"), rendererErrors.join("\n"));
      for (const log of ["calls.jsonl", "guard.jsonl"])
        if (existsSync(join(bin, log))) await copyFile(join(bin, log), join(artifacts, log));
      // The temp root holds only files this launcher made (no links into the operator's home).
      if (!keep && !process.env.MAGIC_E2E_KEEP) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
      return { trace, video: videoPath };
    },
  };
}

/** Whether a path exists (for checks on the app's own files). */
export async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}
