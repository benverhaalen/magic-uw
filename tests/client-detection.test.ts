// owner: client-detection. Finding the student's client wherever its installer or their Node
// manager put it, with an Electron-like minimal PATH; the login shell's PATH on macOS/Linux;
// instant mode by capability, not version; the default pick; and the diagnostics a student sees.
// Scenario names (for the e2e harness's fake-client scenarios) lead each test title.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { z } from "zod";
import { renderToStaticMarkup } from "react-dom/server";
import type { ClientHealth, ClientId } from "../packages/contracts/src/index.ts";
import {
  cliSearchDirs,
  extendPathForClients,
  knownCliDirs,
  loginShellDirs,
  parseShellPath,
  readLoginShellPath,
  resolveCli,
  classifyFailure,
  createClaudeBackend,
  createModelRunner,
  RunnerError,
  type CliCommand,
} from "../packages/runner/src/index.ts";
import {
  CLAUDE_REQUIRED_FLAGS,
  CODEX_REQUIRED_FLAGS,
  INSTANT_TESTED,
  checkHealth,
  codexInstantArgs,
  helpHasFlag,
  instantSupport,
  stateFromAuth,
  stateFromError,
} from "../apps/desktop/src/clients/index.ts";
import { parseClaudeAuth, parseCodexLogin } from "../apps/desktop/src/clients/auth-parse.ts";
import { ClientHealthNotice } from "../apps/desktop/src/renderer/onboarding/ClientHealthNotice.tsx";
import { autoPick, recommendedClient } from "../apps/desktop/src/renderer/onboarding/model.ts";

const tmp = (p: string) => mkdtemp(join(tmpdir(), p));
async function place(dir: string, file: string, text = "") {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), text);
  return join(dir, file);
}

// --- Windows: an app started from the Start menu, PATH = System32 only -------------------------
test("scenario win-install-locations: each installer's folder is found with a minimal PATH", async () => {
  const cases: [string, (root: string) => string, "claude" | "codex"][] = [
    ["claude native installer", (r) => join(r, "home", ".local", "bin"), "claude"],
    ["codex app installer", (r) => join(r, "local", "Programs", "OpenAI", "Codex", "bin"), "codex"],
    ["winget links", (r) => join(r, "local", "Microsoft", "WinGet", "Links"), "claude"],
    ["scoop shims", (r) => join(r, "home", "scoop", "shims"), "codex"],
    ["volta", (r) => join(r, "local", "Volta", "bin"), "claude"],
    ["bun", (r) => join(r, "home", ".bun", "bin"), "claude"],
    ["nvm-windows symlink", (r) => join(r, "nodejs-link"), "codex"],
    ["claude local installer", (r) => join(r, "home", ".claude", "local"), "claude"],
  ];
  for (const [name, dirOf, bin] of cases) {
    const root = await tmp("magic-win-");
    const exe = await place(dirOf(root), `${bin}.exe`);
    const env = {
      Path: "C:\\Windows\\System32",
      USERPROFILE: join(root, "home"),
      LOCALAPPDATA: join(root, "local"),
      APPDATA: join(root, "roaming"),
      NVM_SYMLINK: join(root, "nodejs-link"),
    };
    assert.deepEqual(resolveCli(bin, { env, platform: "win32" }), { file: exe, prefixArgs: [] }, name);
    assert.ok(cliSearchDirs(env, "win32").includes(dirOf(root)), name);
  }
});

test("scenario win-npm-and-pnpm-shims: npm's and pnpm's .cmd shims resolve to node plus the script, no shell", async () => {
  const root = await tmp("magic-shim-");
  const npm = join(root, "roaming", "npm");
  await place(join(npm, "node_modules", "@anthropic-ai", "claude-code"), "cli.js");
  await place(npm, "node.exe");
  await place(npm, "claude.cmd", '@ECHO off\r\nSET dp0=%~dp0\r\n"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n');
  const env = { Path: "C:\\Windows\\System32", USERPROFILE: join(root, "home"), APPDATA: join(root, "roaming"), LOCALAPPDATA: join(root, "local") };
  assert.deepEqual(resolveCli("claude", { env, platform: "win32" }), {
    file: join(npm, "node.exe"),
    prefixArgs: [join(npm, "node_modules", "@anthropic-ai", "claude-code", "cli.js")],
  });
  const pnpm = join(root, "local", "pnpm");
  await place(join(pnpm, "global", "5", "node_modules", "@openai", "codex", "bin"), "codex.js");
  await place(pnpm, "node.exe");
  await place(pnpm, "codex.cmd", '@SETLOCAL\r\n@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n)\r\n');
  const resolved = resolveCli("codex", { env, platform: "win32" }) as CliCommand;
  assert.equal(resolved.file, join(pnpm, "node.exe"));
  assert.equal(resolved.prefixArgs[0], join(pnpm, "global", "5", "node_modules", "@openai", "codex", "bin", "codex.js"));
});

// --- macOS: an app started from Finder or the Dock, PATH = /usr/bin:/bin -----------------------
test("scenario mac-install-locations: each installer's and Node manager's folder is found with launchd's PATH", async () => {
  const cases: [string, (home: string) => string][] = [
    ["claude native installer", (h) => join(h, ".local", "bin")],
    ["claude local installer", (h) => join(h, ".claude", "local")],
    ["npm global prefix", (h) => join(h, ".npm-global", "bin")],
    ["volta", (h) => join(h, ".volta", "bin")],
    ["pnpm", (h) => join(h, "Library", "pnpm")],
    ["bun", (h) => join(h, ".bun", "bin")],
  ];
  for (const [name, dirOf] of cases) {
    const home = await tmp("magic-mac-");
    const bin = await place(dirOf(home), "claude");
    const found = resolveCli("claude", { env: { PATH: "/usr/bin:/bin", HOME: home }, platform: "darwin" });
    assert.ok(found, name);
    assert.equal(join(found.file), join(bin), name);
  }
});

test("scenario mac-nvm: every nvm version is searched, newest first", async () => {
  const home = await tmp("magic-nvm-");
  const older = await place(join(home, ".nvm", "versions", "node", "v18.20.4", "bin"), "codex");
  const newer = await place(join(home, ".nvm", "versions", "node", "v22.3.0", "bin"), "codex");
  const env = { PATH: "/usr/bin:/bin", HOME: home };
  assert.equal(join(resolveCli("codex", { env, platform: "darwin" })!.file), join(newer));
  const dirs = knownCliDirs(env, "darwin").map((d) => join(d));
  assert.ok(dirs.indexOf(join(newer, "..")) < dirs.indexOf(join(older, "..")));
});

// --- The login shell's PATH ------------------------------------------------------------------
test("scenario mac-login-shell-path: PATH is read between markers; rc noise, ANSI and other variables are dropped", async () => {
  const noisy = "\u001b[32mWelcome back!\u001b[0m\nnvm: using v22\n__MAGIC_PATH__HOME=/Users/s\nPATH=/Users/s/.nvm/versions/node/v22.3.0/bin:/usr/bin\nSECRET_TOKEN=x\n__MAGIC_PATH__goodbye\n";
  assert.equal(parseShellPath(noisy), "/Users/s/.nvm/versions/node/v22.3.0/bin:/usr/bin");
  assert.equal(parseShellPath("PATH=/evil/bin before any marker"), null);
  const calls: string[] = [];
  const path = await readLoginShellPath({
    platform: "darwin",
    env: { SHELL: "/usr/local/bin/fish" },
    run: async (shell, args, options) => {
      calls.push(shell);
      assert.equal(args[0], "-ilc");
      assert.equal(options.env.DISABLE_AUTO_UPDATE, "true");
      if (shell === "/usr/local/bin/fish") throw new Error("not POSIX");
      return noisy;
    },
  });
  assert.equal(path, "/Users/s/.nvm/versions/node/v22.3.0/bin:/usr/bin");
  assert.deepEqual(calls, ["/usr/local/bin/fish", "/bin/zsh"]);
  assert.equal(await readLoginShellPath({ platform: "win32", run: async () => { throw new Error("must not run"); } }), null);
});

test("scenario mac-login-shell-timeout: a hanging shell is abandoned at the deadline and the known folders still apply", async () => {
  const started = Date.now();
  const path = await readLoginShellPath({ platform: "darwin", env: { SHELL: "/bin/zsh" }, timeoutMs: 150, run: () => new Promise(() => undefined) });
  assert.equal(path, null);
  assert.ok(Date.now() - started < 1500);
  const home = await tmp("magic-fallback-");
  const bin = await place(join(home, ".local", "bin"), "claude");
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", HOME: home };
  const added = await extendPathForClients(env, { platform: "darwin", timeoutMs: 100, run: () => new Promise(() => undefined), isDir: (p) => p.startsWith(home) && p.includes(".local") });
  assert.deepEqual(added.map((d) => join(d)), [join(home, ".local", "bin")]);
  // Known folders are searched on every lookup, whatever PATH holds (a fresh env: the test runs
  // the macOS path on Windows, where a drive letter would break a colon-separated PATH).
  assert.equal(join(resolveCli("claude", { env: { PATH: "/usr/bin:/bin", HOME: home }, platform: "darwin" })!.file), join(bin));
});

test("scenario mac-login-shell-extend: the shell's folders and existing known folders join PATH once, in order", async () => {
  const home = await tmp("magic-extend-");
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", HOME: home };
  const added = await extendPathForClients(env, {
    platform: "darwin",
    run: async () => "__MAGIC_PATH__PATH=/opt/custom/bin:/usr/bin__MAGIC_PATH__",
    isDir: (p) => p === "/opt/homebrew/bin",
  });
  assert.deepEqual(added, ["/opt/custom/bin", "/opt/homebrew/bin"]);
  assert.equal(env.PATH, "/usr/bin:/bin:/opt/custom/bin:/opt/homebrew/bin");
  assert.deepEqual(loginShellDirs(), ["/opt/custom/bin", "/usr/bin"]);
  assert.ok(cliSearchDirs(env, "darwin").includes("/opt/custom/bin"));
  assert.deepEqual(await extendPathForClients(env, { platform: "darwin", run: async () => "__MAGIC_PATH__PATH=/opt/custom/bin__MAGIC_PATH__", isDir: (p) => p === "/opt/homebrew/bin" }), []);
});

// --- Instant mode by capability -------------------------------------------------------------------
const claudeHelp = (flags: readonly string[]) => `Usage: claude [options]\n${flags.map((f) => `  ${f} <x>   text`).join("\n")}\n`;
test("scenario claude-older-with-flags: an older Claude Code that lists every flag is offered instant mode", async () => {
  const userData = await tmp("magic-cap-");
  const plan = await instantSupport("claude", "2.0.14", { userData, help: async () => claudeHelp(CLAUDE_REQUIRED_FLAGS) });
  assert.deepEqual(plan.support, { available: true, testedWith: INSTANT_TESTED.claude });
});

test("scenario claude-no-safe-mode: a Claude Code without --safe-mode isn't offered instant mode; the flag is named and the separate sign-in stays", async () => {
  const userData = await tmp("magic-cap-");
  const deps = {
    userData,
    env: { PATH: "/usr/bin", HOME: userData, USERPROFILE: userData },
    resolve: (id: ClientId): CliCommand | null => (id === "claude" ? { file: process.execPath, prefixArgs: [join(import.meta.dirname, "fixtures", "fake-cli", "fake-cli.mjs"), "claude"] } : null),
    help: async () => claudeHelp(CLAUDE_REQUIRED_FLAGS.filter((f) => f !== "--safe-mode")),
    online: async () => true,
  };
  const plan = await instantSupport("claude", "1.0.90", deps);
  assert.equal(plan.support.available, false);
  assert.deepEqual(plan.support.missingFlags, ["--safe-mode"]);
  assert.match(plan.support.reason!, /no --safe-mode/);
  const health = await checkHealth("claude", undefined, deps);
  assert.deepEqual([health.state, health.mode, health.modes], ["installed", "instant", ["isolated"]]);
  const html = renderToStaticMarkup(createElement(ClientHealthNotice, { health, onUseProfile: () => undefined, onCheckAgain: () => undefined, openExternal: () => undefined }));
  assert.match(html, /--safe-mode/);
  assert.match(html, /Use a separate sign-in/);
  assert.match(html, /What My Magic UW found/);
  assert.match(html, /tested with 2\.1\.283/);
});

test("scenario codex-older-without-optional-flags: without --ignore-rules Codex runs the nearest safe argv; without a way to turn its shell off it isn't run", async () => {
  const userData = await tmp("magic-cap-");
  const help = `Run Codex non-interactively\n${CODEX_REQUIRED_FLAGS.map((f) => `      ${f} <x>`).join("\n")}\n`;
  // Security review, 2026-09-27: no --disable means the shell tool can't be turned off.
  const noDisable = await instantSupport("codex", "0.120.0", { userData, help: async () => help, exists: async () => false, features: async () => { throw new Error("not asked without --disable"); } });
  assert.equal(noDisable.support.available, false);
  assert.deepEqual(noDisable.support.missingFlags, ["--disable shell_tool"]);
  assert.match(noDisable.support.reason!, /can't turn off its shell tool/);
  const withDisable = `${help}      --disable <FEATURE>\n`;
  const plan = await instantSupport("codex", "0.121.0", { userData, help: async () => withDisable, exists: async () => false, features: async () => "shell_tool   stable   true\nunified_exec   stable   true\n" });
  assert.equal(plan.support.available, true);
  assert.deepEqual([plan.features, plan.ignoreRules], [["shell_tool", "unified_exec"], false]);
  const args = codexInstantArgs({ instructionsPath: "/i.md", stateDir: "/s", features: plan.features, ignoreRules: plan.ignoreRules });
  assert.ok(!args.includes("--ignore-rules"));
  assert.deepEqual(args.filter((_, i) => args[i - 1] === "--disable"), ["shell_tool", "unified_exec"]);
  assert.equal((await instantSupport("codex", "0.119.0", { userData, help: async () => help.replace("--ignore-user-config", ""), exists: async () => false })).support.missingFlags?.[0], "--ignore-user-config");
});

test("flags are matched as whole words", () => {
  assert.equal(helpHasFlag("  --append-system-prompt <p>", "--system-prompt"), false);
  assert.equal(helpHasFlag("  --system-prompt-file <p>", "--system-prompt"), false);
  assert.equal(helpHasFlag("  --system-prompt <p>", "--system-prompt"), true);
  assert.equal(helpHasFlag("  -p, --print   Print", "--print"), true);
  assert.equal(helpHasFlag("  --allowedTools, --allowed-tools <tools...>", "--tools"), false);
});

// --- The default pick and diagnostics ----------------------------------------------------------
const h = (id: ClientId, state: ClientHealth["state"]): ClientHealth => ({ id, state, mode: "instant", source: "status", instant: { available: true }, modes: ["instant", "isolated"], checkedAt: "2026-09-27T00:00:00.000Z" });
test("scenario default-pick: Claude Code when both are signed in; the only installed client without asking", () => {
  assert.equal(recommendedClient({ claude: h("claude", "ok"), codex: h("codex", "ok") }), "claude");
  assert.equal(autoPick({ claude: h("claude", "ok"), codex: h("codex", "ok") }), null);
  assert.equal(autoPick({ claude: h("claude", "not_installed"), codex: h("codex", "not_signed_in"), gemini: h("gemini", "not_signed_in") }), "codex");
  assert.equal(autoPick({ claude: h("claude", "ok"), codex: h("codex", "not_installed") }), "claude");
  assert.equal(autoPick({ claude: h("claude", "not_installed"), codex: h("codex", "not_installed") }), null);
});

test("scenario not-found-diagnostics: the notice lists the folders searched, home shown as ~", async () => {
  const home = await tmp("magic-diag-");
  const health = await checkHealth("claude", undefined, { userData: home, env: { PATH: "C:\\Windows\\System32", USERPROFILE: home, HOME: home, LOCALAPPDATA: join(home, "AppData", "Local") }, resolve: () => null });
  assert.equal(health.state, "not_installed");
  const searched = health.diagnostics!.searched;
  assert.ok(searched.some((d) => d.startsWith("~") && d.includes(".local")), searched.join(" | "));
  assert.ok(!searched.some((d) => d.includes(home)));
  const html = renderToStaticMarkup(createElement(ClientHealthNotice, { health, openExternal: () => undefined }));
  assert.match(html, /Why wasn(&#x27;|')t my client found\?/);
  assert.match(html, /Not in any folder below/);
});

// --- Resolution order, native layout, Keychain (the macOS brief, research/mac, 2026-09-27) --------
test("scenario win-path-order: the folder that comes first on PATH wins, as in the student's terminal", async () => {
  const root = await tmp("magic-order-");
  const npm = join(root, "npm");
  await place(join(npm, "node_modules", "@openai", "codex", "bin"), "codex.js");
  await place(npm, "node.exe");
  await place(npm, "codex.cmd", '"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
  const appBundled = await place(join(root, "Programs", "OpenAI", "Codex", "bin"), "codex.exe");
  const env = { Path: `${npm};${join(root, "Programs", "OpenAI", "Codex", "bin")}`, USERPROFILE: join(root, "home") };
  const found = resolveCli("codex", { env, platform: "win32" })!;
  assert.equal(found.file, join(npm, "node.exe"), "npm's shim, earlier on PATH, not the app-bundled codex.exe");
  const reversed = { ...env, Path: `${join(root, "Programs", "OpenAI", "Codex", "bin")};${npm}` };
  assert.equal(resolveCli("codex", { env: reversed, platform: "win32" })!.file, appBundled);
});

test("scenario claude-native-versions: with the launcher missing, the newest installed version is used", async () => {
  for (const platform of ["darwin", "win32"] as const) {
    const home = await tmp("magic-versions-");
    await place(join(home, ".local", "share", "claude", "versions"), "2.1.281");
    const newest = await place(join(home, ".local", "share", "claude", "versions"), "2.1.283");
    await place(join(home, ".local", "share", "claude", "versions"), "claude.exe.old.123");
    const env = platform === "win32" ? { Path: "C:\Windows\System32", USERPROFILE: home } : { PATH: "/usr/bin:/bin", HOME: home };
    assert.equal(join(resolveCli("claude", { env, platform })!.file), join(newest), platform);
    assert.equal(resolveCli("codex", { env, platform }), null);
  }
});

test("scenario mac-homebrew: Homebrew's prefixes are searched on macOS whatever PATH holds", () => {
  const dirs = knownCliDirs({ PATH: "/usr/bin:/bin", HOME: "/Users/s" }, "darwin");
  for (const d of ["/opt/homebrew/bin", "/usr/local/bin", "/Users/s/.local/bin", "/Users/s/.bun/bin", "/Users/s/.volta/bin", "/Users/s/Library/pnpm"]) assert.ok(dirs.includes(d), d);
});

test("scenario codex-config-error: an older Codex that can't read a newer config.toml is unconfirmed, not signed out", () => {
  const text = "Error loading configuration: ~/.codex/config.toml:167:1: invalid type: string \"medium\", expected struct AgentRoleToml";
  assert.deepEqual(parseCodexLogin(text, 1), { signedIn: null, method: null, plan: null });
  assert.equal(stateFromAuth("codex", parseCodexLogin(text, 1)).state, "installed");
  assert.deepEqual(parseCodexLogin("Not logged in", 1), { signedIn: false, method: null, plan: null });
});

test("scenario mac-keychain-locked: macOS refusing the Keychain item is its own state, from status and from runs", async () => {
  const refused = "SecKeychainItemCopyContent failed: errSecInteractionNotAllowed";
  assert.equal(stateFromAuth("claude", parseClaudeAuth("", { stderr: refused, code: 1, platform: "darwin" })).state, "keychain_locked");
  assert.equal(stateFromAuth("claude", parseClaudeAuth("", { stderr: "", code: 36, platform: "darwin" })).state, "keychain_locked");
  assert.equal(stateFromAuth("claude", parseClaudeAuth("", { stderr: "", code: 36, platform: "win32" })).state, "installed");
  assert.equal(stateFromAuth("codex", parseCodexLogin(refused, 1)).state, "keychain_locked");
  assert.equal(classifyFailure(refused), "keychain_locked");
  // A run through the real Claude backend against the fake CLI printing the error.
  const dir = await tmp("magic-keychain-");
  const runner = createModelRunner({
    backend: createClaudeBackend({
      command: { file: process.execPath, prefixArgs: [join(import.meta.dirname, "fixtures", "fake-cli", "fake-cli.mjs"), "claude"] },
      workDir: dir,
      env: { FAKE_CLI_STATE: join(dir, "s"), FAKE_CLI_RESPONSES: JSON.stringify([{ error: refused }]) },
    }),
  });
  await assert.rejects(
    runner.run({ pack: { id: "p", version: "v1" }, systemPrompt: "S", input: "x", schema: z.object({ ok: z.boolean() }), tier: "pass", lane: "interactive" }),
    (e: unknown) => e instanceof RunnerError && e.kind === "keychain_locked" && stateFromError(e) === "keychain_locked",
  );
  const health = { ...h("claude", "keychain_locked") };
  const html = renderToStaticMarkup(createElement(ClientHealthNotice, { health, onCheckAgain: () => undefined, onQuickChat: async () => "s" }));
  const text = html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
  assert.match(text, /macOS blocked access to Claude Code's saved sign-in/);
  assert.match(text, /Open Terminal, run claude once, allow Keychain access \(Always Allow\), then click Check again\./);
  assert.match(html, /<code class="chn-command">claude<\/code>/);
});
