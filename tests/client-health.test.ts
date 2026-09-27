// owner: client-health (D50). Health mapping from the clients' real message strings, instant
// mode's argv and environment, the capability gate, Gemini's key rule and Quick chat.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ClientHealth, ClientId } from "../packages/contracts/src/index.ts";
import {
  RunnerError,
  classifyFailure,
  createClaudeBackend,
  createCodexBackend,
  createModelRunner,
  statedReset,
  type BackendCall,
  type CliCommand,
  type ModelBackend,
} from "../packages/runner/src/index.ts";
import {
  CLAUDE_REQUIRED_FLAGS,
  CODEX_REQUIRED_FLAGS,
  HEALTH_EVIDENCE,
  chatArgs,
  checkHealth,
  clientBackend,
  codexInstantArgs,
  createApiKeyStore,
  createClientHealth,
  createClients,
  healthGatedBackend,
  instantEnv,
  instantRunOptions,
  instantSupport,
  instantWorkDir,
  listedFeatures,
  profileDir,
  stateFromAuth,
  stateFromError,
  studentCodexHome,
  writeClientMode,
  type PtyProcess,
  type PtySpawn,
} from "../apps/desktop/src/clients/index.ts";
import { parseClaudeAuth, parseCodexLogin } from "../apps/desktop/src/clients/auth-parse.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fakeScript = join(here, "fixtures", "fake-cli", "fake-cli.mjs");
const fake = (kind: "claude" | "codex"): CliCommand => ({ file: process.execPath, prefixArgs: [fakeScript, kind] });
const resolveFake = (id: ClientId) => (id === "gemini" ? null : fake(id));

async function setup() {
  const userData = await mkdtemp(join(tmpdir(), "magic-health-data-"));
  const home = await mkdtemp(join(tmpdir(), "magic-health-home-"));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SYSTEMROOT: process.env.SYSTEMROOT,
    HOME: home,
    USERPROFILE: home,
    ANTHROPIC_API_KEY: "sk-synthetic-must-not-pass",
    MAGIC_SECRET_THING: "must-not-pass",
  };
  return { userData, home, env };
}
const claudeHelp = `Usage: claude [options]\n${CLAUDE_REQUIRED_FLAGS.join("\n")}\n`;
const codexHelp = `Run Codex non-interactively\n${CODEX_REQUIRED_FLAGS.join("\n")}\n`;
const featureList = [
  "shell_tool                               stable             true",
  "apps                                     stable             true",
  "apply_patch_freeform                     removed            false",
  "multi_agent_v2                           stable             false",
  "memories                                 stable             true",
].join("\n");
const noFile = async () => false;

// --- Mapping from the clients' own strings ------------------------------------------------------------
const kindFor: Record<string, string> = {
  not_signed_in: "not_signed_in",
  usage_limited: "usage_limit",
  plan_insufficient: "plan_insufficient",
  model_unavailable: "model_unavailable",
  offline: "offline",
};

test("every observed and binary-sourced run message maps to its health state", () => {
  const runMessages = HEALTH_EVIDENCE.filter((e) => !e.text.startsWith("{") && !e.text.startsWith("(") && !/login status|Logged in using/.test(e.text));
  assert.ok(runMessages.length >= 14);
  for (const e of runMessages) {
    const kind = classifyFailure(e.text);
    if (e.state === "process_failed") {
      assert.ok(kind === "process_failed" || kind === "unavailable", `${e.text} → ${kind}`);
      assert.equal(stateFromError(new RunnerError(kind)), null);
    } else {
      assert.equal(kind, kindFor[e.state], e.text);
      assert.equal(stateFromError(new RunnerError(kind)), e.state);
    }
  }
  // A busy server is never the student's usage limit.
  assert.equal(classifyFailure("Server is temporarily limiting requests (not your usage limit)"), "unavailable");
  assert.equal(classifyFailure("overloaded_error"), "unavailable");
  // The existing mappings the runner tests pin still hold.
  assert.equal(classifyFailure("Claude AI usage limit reached|1790000000"), "usage_limit");
  assert.equal(classifyFailure("Not logged in · Please run /login"), "not_signed_in");
});

test("status commands: observed outputs map to ok and not signed in; a free Claude plan is plan_insufficient", () => {
  assert.deepEqual(stateFromAuth("claude", parseClaudeAuth('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max","email":"x@example.edu"}')), { state: "ok", plan: "max" });
  assert.deepEqual(stateFromAuth("claude", parseClaudeAuth('{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}')), { state: "not_signed_in" });
  assert.deepEqual(stateFromAuth("codex", parseCodexLogin("Logged in using ChatGPT", 0)), { state: "ok" });
  assert.deepEqual(stateFromAuth("codex", parseCodexLogin("Not logged in", 1)), { state: "not_signed_in" });
  // Inferred, not observed: no free account was available to check what it reports.
  assert.deepEqual(stateFromAuth("claude", parseClaudeAuth('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"free"}')), { state: "plan_insufficient", plan: "free" });
  assert.deepEqual(stateFromAuth("claude", parseClaudeAuth("not json")), { state: "installed" });
});

test("a usage limit keeps the reset time the client stated, and only that", () => {
  assert.equal(statedReset("Claude AI usage limit reached|1790000000"), new Date(1790000000 * 1000).toISOString());
  assert.equal(statedReset("You've hit your limit · resets 3pm (America/Chicago)"), "3pm (America/Chicago)");
  assert.equal(statedReset("You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:05 PM."), "3:05 PM");
  assert.equal(statedReset("Usage limit reached"), undefined);
});

test("the runner turns a failed CLI run into the health kind, with the reset time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "magic-health-run-"));
  const env = {
    FAKE_CLI_STATE: join(dir, "state"),
    FAKE_CLI_RESPONSES: JSON.stringify([{ error: "You've hit your limit · resets 3pm (America/Chicago)" }]),
  };
  const schema = z.object({ ok: z.boolean() });
  const ask = { pack: { id: "probe", version: "v1" }, systemPrompt: "S", input: "x", schema, tier: "pass" as const, lane: "interactive" as const };
  const runner = createModelRunner({ backend: createClaudeBackend({ command: fake("claude"), workDir: dir, env }) });
  await assert.rejects(runner.run(ask), (e: unknown) => e instanceof RunnerError && e.kind === "usage_limit" && e.resetsAt === "3pm (America/Chicago)");
  const codexEnv = { FAKE_CLI_STATE: join(dir, "state2"), FAKE_CLI_RESPONSES: JSON.stringify([{ error: "The 'gpt-x' model is not supported when using Codex with a ChatGPT account." }]) };
  const codex = createModelRunner({ backend: createCodexBackend({ command: fake("codex"), workDir: dir, env: codexEnv }) });
  await assert.rejects(codex.run(ask), (e: unknown) => e instanceof RunnerError && e.kind === "model_unavailable");
});

// --- Instant mode -----------------------------------------------------------------------------------
test("instant argv: Claude adds --safe-mode to the spec flags; nothing points at the student's config", async () => {
  const { userData, home, env } = await setup();
  const studentConfig = join(home, ".claude-own");
  const base = { ...env, CLAUDE_CONFIG_DIR: studentConfig };
  const plan = await instantSupport("claude", "2.1.283", { userData, env: base, resolve: resolveFake, help: async () => claudeHelp });
  assert.equal(plan.support.available, true);
  const options = await instantRunOptions("claude", fake("claude"), plan, { userData, env: base });
  assert.deepEqual(options.extraArgs, ["--safe-mode"]);
  assert.equal(options.workDir, instantWorkDir(userData, "claude"));
  // The student's own config folder is where their sign-in lives: passed as their env, never the app profile.
  assert.equal(options.env.CLAUDE_CONFIG_DIR, studentConfig);
  assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(options.env.MAGIC_SECRET_THING, undefined);

  const log = join(userData, "fake.log");
  const backend = createClaudeBackend({ ...options, env: { ...options.env, FAKE_CLI_LOG: log, FAKE_CLI_STATE: join(userData, "st"), FAKE_CLI_RESPONSES: JSON.stringify([{ output: { ok: true } }]) } });
  await backend.call({ pack: { id: "p", version: "v1" }, systemPrompt: "S", input: "ask", jsonSchema: { type: "object" }, tier: "pass", lane: "interactive", timeoutMs: 20_000 } as BackendCall);
  const argv: string[] = JSON.parse((await readFile(log, "utf8")).trim().split("\n")[0]).argv;
  for (const flag of ["-p", "--tools", "--strict-mcp-config", "--no-session-persistence", "--system-prompt-file", "--safe-mode"]) assert.ok(argv.includes(flag), flag);
  assert.equal(argv[argv.indexOf("--tools") + 1], "");
  assert.equal(argv[argv.indexOf("--setting-sources") + 1], "project,local");
  assert.ok(argv[argv.indexOf("--system-prompt-file") + 1].startsWith(userData));
  for (const a of argv) {
    assert.ok(!a.includes(studentConfig) && !a.includes(join(home, ".claude")) && !a.includes(profileDir(userData, "claude")), a);
    assert.ok(!/--bare|--dangerously|--settings\b|--mcp-config/.test(a), a);
  }
});

test("instant argv: Codex skips rules, git check, user instructions and tools; state stays in the app folder", async () => {
  const { userData, home, env } = await setup();
  const plan = await instantSupport("codex", "0.156.1", { userData, env, resolve: resolveFake, help: async () => codexHelp, features: async () => featureList, exists: noFile });
  assert.equal(plan.support.available, true);
  assert.deepEqual(plan.features, ["shell_tool", "apps", "memories"]);
  const options = await instantRunOptions("codex", fake("codex"), plan, { userData, env });
  const args = options.extraArgs;
  for (const flag of ["--ignore-rules", "--skip-git-repo-check"]) assert.ok(args.includes(flag), flag);
  const configs = args.filter((_, i) => args[i - 1] === "-c");
  assert.ok(configs.some((c) => c.startsWith("model_instructions_file=") && c.includes(JSON.stringify(userData).slice(1, -1))));
  assert.ok(configs.some((c) => c.startsWith("sqlite_home=") && c.includes(JSON.stringify(userData).slice(1, -1))));
  assert.ok(configs.includes("project_doc_max_bytes=0") && configs.includes('web_search="disabled"'));
  assert.deepEqual(args.filter((_, i) => args[i - 1] === "--disable"), ["shell_tool", "apps", "memories"]);
  const log = join(userData, "fake.log");
  const backend = createCodexBackend({ ...options, env: { ...options.env, FAKE_CLI_LOG: log, FAKE_CLI_STATE: join(userData, "st"), FAKE_CLI_RESPONSES: JSON.stringify([{ output: { ok: true } }]) } });
  await backend.call({ pack: { id: "p", version: "v1" }, systemPrompt: "S", input: "ask", jsonSchema: { type: "object" }, tier: "pass", lane: "interactive", timeoutMs: 20_000 } as BackendCall);
  const argv: string[] = JSON.parse((await readFile(log, "utf8")).trim().split("\n")[0]).argv;
  for (const flag of ["exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check"]) assert.ok(argv.includes(flag), flag);
  assert.equal(argv[argv.indexOf("-s") + 1], "read-only");
  for (const a of argv) assert.ok(!a.includes(studentCodexHome({ USERPROFILE: home })) && !a.includes(profileDir(userData, "codex")), a);
  // A path with a quote or backslash stays one valid TOML string.
  assert.deepEqual(codexInstantArgs({ instructionsPath: "C:\\O'Brien\\a\"b.md", stateDir: "/s", features: [] }).slice(3, 4), ['model_instructions_file="C:\\\\O\'Brien\\\\a\\"b.md"']);
});

test("instant mode is offered only when this version was checked and keeps the student's customisations out", async () => {
  const { userData, env } = await setup();
  const deps = { userData, env, resolve: resolveFake, exists: noFile, features: async () => featureList };
  const noSafe = await instantSupport("claude", "2.1.283", { ...deps, help: async () => claudeHelp.replace("--safe-mode", "") });
  assert.equal(noSafe.support.available, false);
  assert.match(noSafe.support.reason!, /--safe-mode/);
  const old = await instantSupport("claude", "2.0.1", { ...deps, help: async () => claudeHelp });
  assert.equal(old.support.available, false);
  assert.match(old.support.reason!, /2\.1\.283/);
  // Codex always sends a global AGENTS.md; instant is still the default (operator), with a note.
  const agents = await instantSupport("codex", "0.157.0", { ...deps, help: async () => codexHelp, exists: async (p) => p.endsWith("AGENTS.md") });
  assert.equal(agents.support.available, true);
  assert.match(agents.support.note!, /AGENTS\.md/);
  assert.equal((await instantSupport("gemini", "1.0.0", { ...deps })).support.available, false);
  assert.deepEqual([...listedFeatures(featureList)].sort(), ["apps", "memories", "multi_agent_v2", "shell_tool"]);
});

test("instant env: the allowlist plus the student's own config variable, never the app profile", () => {
  const env = instantEnv("codex", { PATH: "p", CODEX_HOME: "D:\\me\\codex", OPENAI_API_KEY: "sk-x", CLAUDE_CONFIG_DIR: "D:\\me\\claude" });
  assert.deepEqual(env, { PATH: "p", CODEX_HOME: "D:\\me\\codex" });
  assert.deepEqual(instantEnv("claude", { PATH: "p", GITHUB_TOKEN: "t" }), { PATH: "p" });
});

// --- Health checks and the gate -----------------------------------------------------------------------
test("checkHealth: instant by default, isolated only when opted in; not installed, signed out, offline, needs update", async () => {
  const { userData, env } = await setup();
  const deps = { userData, env, resolve: resolveFake, help: async (id: "claude" | "codex") => (id === "claude" ? claudeHelp : codexHelp), features: async () => featureList, exists: noFile, online: async () => true };
  const ok = await checkHealth("claude", "instant", { ...deps, status: async () => ({ signedIn: true, method: "subscription", plan: "max" }) });
  assert.deepEqual([ok.state, ok.mode, ok.plan, ok.modes, ok.version], ["ok", "instant", "max", ["instant", "isolated"], "2.1.283"]);
  const seen: string[] = [];
  const out = await checkHealth("codex", undefined, { ...deps, status: async (_c, m) => (seen.push(m), { signedIn: false, method: null, plan: null }) });
  assert.deepEqual([out.state, out.mode], ["not_signed_in", "instant"]);
  const optedIn = await checkHealth("codex", "isolated", { ...deps, status: async (_c, m) => (seen.push(m), { signedIn: false, method: null, plan: null }) });
  assert.deepEqual([optedIn.state, optedIn.mode], ["not_signed_in", "isolated"]);
  assert.deepEqual(seen, ["instant", "isolated"], "the status command ran against the student's own config by default");
  const missing = await checkHealth("claude", "instant", { ...deps, resolve: () => null });
  assert.equal(missing.state, "not_installed");
  const offline = await checkHealth("claude", "instant", { ...deps, status: async () => ({ signedIn: null, method: null, plan: null }), online: async () => false });
  assert.equal(offline.state, "offline");
  // A version that can't run instant safely is reported (update), never silently moved to the app's profile.
  const downgraded = await checkHealth("claude", "instant", { ...deps, help: async () => "", status: async () => ({ signedIn: true, method: "subscription", plan: "pro" }) });
  assert.deepEqual([downgraded.state, downgraded.mode, downgraded.modes, downgraded.instant.available], ["installed", "instant", ["isolated"], false]);
});

function fakeBackend(results: (Error | object)[]): ModelBackend & { calls: number } {
  const b = {
    client: "claude" as const,
    calls: 0,
    async call() {
      const r = results[Math.min(b.calls++, results.length - 1)];
      if (r instanceof Error) throw r;
      return { value: r, usage: { in: 1, cached: 0, out: 1 }, model: "m" };
    },
  };
  return b;
}
const health = (state: ClientHealth["state"]): ClientHealth => ({ id: "claude", state, mode: "instant", source: "status", instant: { available: true }, modes: ["instant", "isolated"], checkedAt: "2026-09-27T00:00:00.000Z" });
const call = { pack: { id: "p", version: "v1" }, systemPrompt: "S", input: "x", jsonSchema: {}, tier: "pass", lane: "interactive", timeoutMs: 1000 } as BackendCall;

test("the gate checks health before every run, refuses without sending, and learns from a failed run", async () => {
  let now = 0;
  const signedOut = fakeBackend([{ ok: true }]);
  const gated = healthGatedBackend(signedOut, async () => health("not_signed_in"));
  await assert.rejects(gated.call(call), (e: unknown) => e instanceof RunnerError && e.kind === "not_signed_in");
  assert.equal(signedOut.calls, 0);

  let checks = 0;
  const limited = fakeBackend([{ ok: true }, new RunnerError("usage_limit", "x", [], { resetsAt: "3pm" }), { ok: true }]);
  const g2 = healthGatedBackend(limited, async () => (checks++, health("ok")), { now: () => now, ttlMs: 1000 });
  await g2.call(call);
  await assert.rejects(g2.call(call), (e: unknown) => e instanceof RunnerError && e.kind === "usage_limit");
  assert.equal(checks, 1, "a healthy check is reused within its time");
  assert.deepEqual([g2.lastHealth()?.state, g2.lastHealth()?.resetsAt, g2.lastHealth()?.source], ["usage_limited", "3pm", "run"]);
  await g2.call(call); // not ok → re-checked (now ok again) before this run
  assert.equal(checks, 2);
  now = 5000;
  await g2.call(call);
  assert.equal(checks, 3, "re-checked after the time runs out");
});

// --- Gemini -------------------------------------------------------------------------------------------
function memoryVault() {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k: string) => data.get(k),
    set: async (k: string, v: string) => void data.set(k, v),
    deletePrefix: async (p: string) => {
      for (const k of [...data.keys()]) if (k.startsWith(p)) data.delete(k);
    },
  };
}

test("Gemini refuses without the student's key and never exposes it", async () => {
  const { userData, env } = await setup();
  const vault = memoryVault();
  const keys = createApiKeyStore(vault, { ...env, GEMINI_API_KEY: "AIzaSynthetic-environment-key-000000" });
  assert.deepEqual(await keys.status(), { stored: false, inEnvironment: true });
  await assert.rejects(clientBackend("gemini", { userData, env, geminiKey: keys.value }, { claude: () => fakeBackend([]), codex: () => fakeBackend([]) }, async () => null), (e: unknown) => e instanceof RunnerError && e.kind === "not_signed_in");
  const h = await checkHealth("gemini", undefined, { userData, env, keyStatus: keys.status });
  assert.deepEqual([h.state, h.mode, h.modes, h.instant.available], ["not_signed_in", "api_key", ["api_key"], false]);
  await assert.rejects(keys.save("short"));
  await assert.rejects(keys.save("has spaces in it that are not allowed"));
  const saved = await keys.save("  AIzaSynthetic-pasted-key-0000000000  ");
  assert.deepEqual(saved, { stored: true, inEnvironment: true });
  assert.ok(!JSON.stringify(saved).includes("AIza"));
  assert.equal(vault.data.get("ai-key:gemini"), "AIzaSynthetic-pasted-key-0000000000");
  assert.equal((await checkHealth("gemini", undefined, { userData, env, keyStatus: keys.status })).state, "ok");
  const runtime = createClientHealth({ userData, env, vault });
  assert.equal((await runtime.health("gemini")).state, "ok");
  assert.deepEqual(await runtime.geminiKey.remove(), { stored: false, inEnvironment: false });
  await assert.rejects(runtime.health("evil"), /Unknown client/);
  await assert.rejects(runtime.health("claude", "root"), /Unknown connection mode/);
});

test("setMode saves a mode only when the client can use it here", async () => {
  const { userData, env } = await setup();
  const runtime = createClientHealth({ userData, env: { ...env, USERPROFILE: userData }, vault: memoryVault(), resolve: resolveFake, help: async () => "", online: async () => true });
  await assert.rejects(runtime.setMode("claude", "instant"), /doesn't offer/);
  const h = await runtime.setMode("claude", "isolated");
  assert.equal(h.mode, "isolated");
  assert.deepEqual(JSON.parse(await readFile(join(userData, "client-modes.json"), "utf8")), { modes: { claude: "isolated" } });
});

// --- Quick chat ---------------------------------------------------------------------------------------
test("Quick chat: fixed argv with tools off, in the saved mode's environment and folder", async () => {
  const { userData, home, env } = await setup();
  const own = join(home, "own-claude");
  const spawned: { args: string[]; env: NodeJS.ProcessEnv; cwd: string }[] = [];
  const pty = async (): Promise<PtySpawn> => (file, args, options) => {
    spawned.push({ args, env: options.env, cwd: options.cwd });
    return { pid: 1, onData: () => undefined, onExit: () => undefined, write: () => undefined, resize: () => undefined, kill: () => undefined } as PtyProcess;
  };
  const clients = createClients({ userData, env: { ...env, CLAUDE_CONFIG_DIR: own }, resolve: resolveFake, consented: async () => true, pty, events: { data: () => undefined, exit: () => undefined } });
  await clients.terminal.open("owner", "claude", "chat"); // default: instant
  await writeClientMode("claude", "isolated", userData); // the advanced opt-in
  await clients.terminal.open("owner", "claude", "chat");
  const [instant, isolated] = spawned;
  assert.deepEqual(isolated.args, [fakeScript, "claude", ...chatArgs("claude")]);
  assert.deepEqual(chatArgs("claude"), ["--tools", "", "--strict-mcp-config", "--setting-sources", "project,local", "--safe-mode"]);
  assert.equal(isolated.env.CLAUDE_CONFIG_DIR, profileDir(userData, "claude"));
  assert.equal(instant.env.CLAUDE_CONFIG_DIR, own);
  assert.equal(instant.cwd, instantWorkDir(userData, "claude"));
  assert.equal(instant.env.ANTHROPIC_API_KEY, undefined);
  await assert.rejects(clients.terminal.open("owner", "gemini", "chat"));
  await assert.rejects(clients.terminal.open("owner", "claude", "chat", "--dangerously-skip-permissions"));
  clients.terminal.closeAll();
});
