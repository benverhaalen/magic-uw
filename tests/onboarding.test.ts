import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  chooseEngine,
  detect,
  environmentKey,
  parseClaudeAuth,
  parseCodexLogin,
  probeModels,
  type ClientDetection,
  type Detection,
} from "../apps/desktop/src/onboarding.ts";
import { createClaudeBackend, type CliCommand } from "../packages/runner/src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fakeScript = join(here, "fixtures", "fake-cli", "fake-cli.mjs");
const fake = (kind: "claude" | "codex"): CliCommand => ({ file: process.execPath, prefixArgs: [fakeScript, kind] });

const cmd: CliCommand = { file: "cli", prefixArgs: [] };
const client = (c: "claude" | "codex", over: Partial<ClientDetection> = {}): ClientDetection => ({
  client: c, installed: true, version: "1.0.0", signedIn: true, method: c === "claude" ? "subscription" : "chatgpt", plan: null, command: cmd, ...over,
});
const detection = (over: Partial<Detection> = {}): Detection => ({
  clients: [client("claude"), client("codex")],
  storedKeys: [],
  local: { ready: false, reason: "" },
  ...over,
});
const engine = (d: Detection, s = {}) => {
  const c = chooseEngine(d, s).choice;
  return c.engine === "api" ? `api:${c.provider}` : c.engine === "claude" || c.engine === "codex" ? `${c.engine}:${c.route}` : c.engine;
};

test("decision table: Claude Code → Codex → a stored key (Gemini first) → Ollama → none", () => {
  const out = { installed: false, signedIn: null, command: null } as const;
  const signedOut = { signedIn: false } as const;
  const rows: [string, Detection, object, string][] = [
    ["both signed in", detection(), {}, "claude:subscription"],
    ["claude on a key", detection({ clients: [client("claude", { method: "api_key" }), client("codex")] }), {}, "claude:api_key"],
    ["claude signed out", detection({ clients: [client("claude", signedOut), client("codex")] }), {}, "codex:chatgpt"],
    ["claude missing", detection({ clients: [client("claude", out), client("codex")] }), {}, "codex:chatgpt"],
    ["no CLI, keys", detection({ clients: [client("claude", out), client("codex", signedOut)], storedKeys: ["openai", "gemini", "openrouter"] }), {}, "api:gemini"],
    ["no CLI, openrouter key", detection({ clients: [client("claude", out), client("codex", out)], storedKeys: ["openrouter"] }), {}, "api:openrouter"],
    ["nothing but Ollama", detection({ clients: [client("claude", out), client("codex", out)], local: { ready: true, reason: "" } }), {}, "local"],
    ["nothing", detection({ clients: [client("claude", out), client("codex", out)] }), {}, "none"],
    ["Ollama opted in", detection({ local: { ready: true, reason: "" } }), { preferLocal: true }, "local"],
    ["Ollama opted in, not ready", detection(), { preferLocal: true }, "claude:subscription"],
    ["picked codex", detection(), { preferred: "codex" }, "codex:chatgpt"],
    ["picked an absent key", detection(), { preferred: "gemini" }, "claude:subscription"],
    ["fully local, ready", detection({ local: { ready: true, reason: "" } }), { localOnly: true }, "local"],
    ["fully local, not ready", detection(), { localOnly: true }, "none"],
  ];
  for (const [name, d, s, expected] of rows) assert.equal(engine(d, s), expected, name);
});

test("setup actions and disclosures are returned, never run", () => {
  const d = chooseEngine(detection({ clients: [client("claude", { signedIn: false }), client("codex", { installed: false, command: null })] }));
  assert.deepEqual(d.actions, [
    { client: "claude", kind: "sign_in", command: "claude auth login" },
    { client: "codex", kind: "install" },
    { client: "local", kind: "start_local" },
    { client: "openrouter", kind: "add_key" },
  ]);
  const codex = chooseEngine(detection({ clients: [client("claude", { signedIn: false }), client("codex")] }));
  assert.match(codex.disclosures[0], /openai\/codex#36886/);
});

test("auth parsing keeps only the sign-in state, method and plan", () => {
  const parsed = parseClaudeAuth(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", email: "student@example.edu", orgName: "Org" }));
  assert.deepEqual(parsed, { signedIn: true, method: "subscription", plan: "max" });
  assert.ok(!JSON.stringify(parsed).includes("example.edu"));
  assert.deepEqual(parseClaudeAuth('{"loggedIn":false}'), { signedIn: false, method: null, plan: null });
  assert.deepEqual(parseClaudeAuth("garbage"), { signedIn: null, method: null, plan: null });
  assert.deepEqual(parseCodexLogin("Logged in using ChatGPT", 0), { signedIn: true, method: "chatgpt", plan: null });
  assert.deepEqual(parseCodexLogin("Logged in using an API key - sk-proj-***", 0), { signedIn: true, method: "api_key", plan: null });
  assert.deepEqual(parseCodexLogin("Not logged in", 1), { signedIn: false, method: null, plan: null });
});

test("detect asks each CLI for its version and its own auth status, from the app's folder", async () => {
  const dir = await mkdtemp(join(tmpdir(), "onboard-"));
  const logPath = join(dir, "log.jsonl");
  const saved = { ...process.env };
  process.env.FAKE_CLI_LOG = logPath;
  process.env.FAKE_CLI_AUTH_CLAUDE = JSON.stringify({ stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro", email: "x@example.edu" }), exit: 0 });
  process.env.FAKE_CLI_AUTH_CODEX = JSON.stringify({ stdout: "Not logged in\n", exit: 1 });
  try {
    const workDir = join(dir, "ai-runtime");
    const d = await detect({
      workDir,
      resolve: (n) => fake(n),
      storedKeys: async () => ["gemini"],
      localStatus: async () => ({ ready: false, reason: "not running" }),
    });
    const [claude, codex] = d.clients;
    assert.equal(claude.version, "2.1.283");
    assert.deepEqual([claude.signedIn, claude.method, claude.plan], [true, "subscription", "pro"]);
    assert.equal(codex.version, "0.156.1");
    assert.equal(codex.signedIn, false);
    assert.equal(engine(d), "claude:subscription");
    const none = await detect({ workDir, resolve: () => null, localStatus: async () => ({ ready: true, reason: "" }) });
    assert.equal(none.clients.every((c) => !c.installed), true);
    assert.equal(engine(none), "local");
  } finally {
    for (const k of ["FAKE_CLI_LOG", "FAKE_CLI_AUTH_CLAUDE", "FAKE_CLI_AUTH_CODEX"]) if (saved[k] === undefined) delete process.env[k];
  }
});

test("the model probe asks each tier once and reports what the plan serves", async () => {
  const dir = await mkdtemp(join(tmpdir(), "probe-"));
  const env = { FAKE_CLI_STATE: join(dir, "state"), FAKE_CLI_RESPONSES: JSON.stringify([{ output: { ok: true } }, { error: "model not available on your plan: 429 rate limit" }]) };
  const result = await probeModels(createClaudeBackend({ command: fake("claude"), workDir: dir, env }));
  assert.deepEqual(result.pass, { served: true, model: "claude-sonnet-5" });
  assert.deepEqual(result.strong, { served: false, model: null, errorKind: "usage_limit" });
});

test("config import: an environment key is read only with consent", () => {
  const env = { OPENROUTER_API_KEY: "sk-or-synthetic" };
  assert.deepEqual(environmentKey("openrouter", false, env), { present: true, key: null });
  assert.deepEqual(environmentKey("openrouter", true, env), { present: true, key: "sk-or-synthetic" });
  assert.deepEqual(environmentKey("gemini", true, env), { present: false, key: null });
});

test("negative: onboarding reads no credential file and writes no client settings", async () => {
  const text = await readFile(join(here, "..", "apps", "desktop", "src", "onboarding.ts"), "utf8");
  assert.ok(!/readFile|writeFile|homedir|\.credentials|auth\.json|oauth_creds|config\.toml|settings\.json/.test(text));
});
