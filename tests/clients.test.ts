import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClientId, ConsentRecord } from "../packages/contracts/src/index.ts";
import { CONSENT_DISCLOSURE_VERSION } from "../packages/domain/src/index.ts";
import type { CliCommand } from "../packages/runner/src/index.ts";
import {
  createClients,
  loadNodePty,
  parseOpenRequest,
  profileDir,
  profileEnv,
  providerConsented,
  readClientSettings,
  type PtySpawn,
  type PtyProcess,
} from "../apps/desktop/src/clients/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fakeScript = join(here, "fixtures", "fake-cli", "fake-cli.mjs");
const fake = (kind: "claude" | "codex"): CliCommand => ({ file: process.execPath, prefixArgs: [fakeScript, kind] });

async function setup(extraEnv: Record<string, string> = {}) {
  const userData = await mkdtemp(join(tmpdir(), "magic-t80-data-"));
  const home = await mkdtemp(join(tmpdir(), "magic-t80-home-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
    MAGIC_SECRET_THING: "must-not-reach-the-client",
    ...extraEnv,
  };
  // The client env is an allowlist, so the fake CLI's settings reach it through node's own
  // --env-file rather than through the inherited environment.
  const envFile = join(await mkdtemp(join(tmpdir(), "magic-t80-fake-")), "fake.env");
  await writeFile(envFile, Object.entries(extraEnv).filter(([k]) => k.startsWith("FAKE_CLI_")).map(([k, v]) => `${k}='${v}'`).join("\n"));
  const resolve = (id: ClientId): CliCommand | null =>
    id === "gemini" ? null : { file: process.execPath, prefixArgs: [`--env-file=${envFile}`, fakeScript, id] };
  return { userData, home, env, resolve };
}
const resolveFake = (id: ClientId) => (id === "gemini" ? null : fake(id));

interface Spawned { file: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; killed: boolean }
function fakePty(log: Spawned[]): () => Promise<PtySpawn> {
  return async () => (file, args, options) => {
    const entry: Spawned = { file, args, env: options.env, cwd: options.cwd, killed: false };
    log.push(entry);
    let exit: ((e: { exitCode: number }) => void) | undefined;
    const proc: PtyProcess = {
      pid: 1,
      onData: () => undefined,
      onExit: (cb) => (exit = cb),
      write: () => undefined,
      resize: () => undefined,
      kill: () => {
        entry.killed = true;
        queueMicrotask(() => exit?.({ exitCode: 1 }));
      },
    };
    return proc;
  };
}
const noEvents = { data: () => undefined, exit: () => undefined };

test("detection: --version only; installed, missing and broken binaries", async () => {
  const { userData, env } = await setup({ FAKE_CLI_LOG: "" });
  const clients = createClients({
    userData,
    env,
    resolve: (id) => (id === "claude" ? fake("claude") : id === "codex" ? { file: join(userData, "missing.exe"), prefixArgs: [] } : null),
    consented: async () => false,
    events: noEvents,
  });
  const [claude, codex, gemini] = await clients.detect();
  // A binary that exists but fails `--version` is installed-but-unusable, not "not installed".
  const broken = createClients({
    userData, env, consented: async () => false, events: noEvents,
    resolve: (id) => (id === "codex" ? { file: process.execPath, prefixArgs: ["-e", "process.exit(3)", "--"] } : null),
  });
  const [, brokenCodex] = await broken.detect();
  assert.equal(brokenCodex.installed, true);
  assert.match(brokenCodex.problem ?? "", /exited with 3/);
  assert.equal(brokenCodex.installUrl, undefined);
  assert.equal((await broken.authStatus("codex")).signedIn, "unknown");
  assert.deepEqual(claude, { id: "claude", installed: true, version: "2.1.283", profileReady: false, signedIn: "unknown", isolated: true });
  assert.equal(codex.installed, false);
  assert.equal(codex.installUrl, "https://developers.openai.com/codex/cli");
  assert.equal(gemini.installed, false);
  assert.equal(gemini.isolated, false);
  assert.ok(gemini.installUrl);
});

test("profiles: env points at the app-owned folder, is idempotent, never touches the student's home", async () => {
  const { userData, home, env, resolve } = await setup({
    FAKE_CLI_AUTH_CLAUDE: JSON.stringify({ stdout: '{"loggedIn":false}', exit: 1 }),
    FAKE_CLI_AUTH_CODEX: JSON.stringify({ stdout: "Not logged in\n", exit: 1 }),
  });
  const spawned: Spawned[] = [];
  const clients = createClients({ userData, env, resolve, consented: async () => true, pty: fakePty(spawned), events: noEvents });

  const claudeEnv = profileEnv("claude", { userData, env });
  assert.equal(claudeEnv.CLAUDE_CONFIG_DIR, profileDir(userData, "claude"));
  assert.equal(claudeEnv.MAGIC_SECRET_THING, undefined);
  assert.equal(profileEnv("codex", { userData, env }).CODEX_HOME, profileDir(userData, "codex"));
  assert.equal(profileEnv("codex", { userData, env }).CLAUDE_CONFIG_DIR, undefined, "an inherited redirect is dropped");
  assert.equal(profileEnv("claude", { userData, env }).CODEX_HOME, undefined, "an inherited redirect is dropped");
  assert.throws(() => profileEnv("gemini", { userData, env }));

  const first = await clients.prepare("claude");
  assert.equal(first.profileReady, true);
  const settingsFile = join(profileDir(userData, "claude"), "settings.json");
  await writeFile(settingsFile, '{"edited":"by the client"}');
  const again = await clients.prepare("claude");
  assert.equal(again.profileReady, true);
  assert.equal(await readFile(settingsFile, "utf8"), '{"edited":"by the client"}', "prepare never overwrites");
  assert.deepEqual(JSON.parse(await readFile(join(profileDir(userData, "claude"), "magic-mcp.json"), "utf8")), { mcpServers: {} });
  await clients.prepare("codex");
  assert.match(await readFile(join(profileDir(userData, "codex"), "config.toml"), "utf8"), /cli_auth_credentials_store = "file"/);
  assert.equal((await clients.prepare("gemini")).profileReady, false);

  await clients.detect();
  await clients.authStatus("claude");
  await clients.authStatus("codex");
  const { sessionId } = await clients.terminal.open("owner", "claude", "signin");
  assert.equal(spawned[0].env.CLAUDE_CONFIG_DIR, profileDir(userData, "claude"));
  assert.equal(spawned[0].cwd, join(profileDir(userData, "claude"), "work"));
  await clients.terminal.close("owner", sessionId);
  await clients.choose("codex");
  assert.deepEqual(await readClientSettings(userData), { chosen: "codex" });
  await assert.rejects(clients.choose("--help"));

  assert.deepEqual(await readdir(home), [], "the student's home dir stays empty");
});

test("auth status: signed-in, method and plan only; identity is dropped", async () => {
  const claudeStatus = {
    loggedIn: true,
    authMethod: "claude.ai",
    apiProvider: "firstParty",
    email: "student@wisc.edu",
    orgId: "org-123",
    orgName: "Student Organization",
    subscriptionType: "max",
  };
  const { userData, env, resolve } = await setup({
    FAKE_CLI_AUTH_CLAUDE: JSON.stringify({ stdout: JSON.stringify(claudeStatus), exit: 0 }),
    FAKE_CLI_AUTH_CODEX: JSON.stringify({ stdout: "Logged in using ChatGPT\n", exit: 0 }),
  });
  const clients = createClients({ userData, env, resolve, consented: async () => false, events: noEvents });
  const claude = await clients.authStatus("claude");
  assert.deepEqual(claude, {
    id: "claude", installed: true, version: "2.1.283", profileReady: true, signedIn: true,
    method: "subscription", plan: "max", isolated: true,
  });
  assert.doesNotMatch(JSON.stringify(claude), /wisc|org|Organization/);
  const codex = await clients.authStatus("codex");
  assert.equal(codex.signedIn, true);
  assert.equal(codex.method, "subscription");

  const out = await setup({
    FAKE_CLI_AUTH_CLAUDE: JSON.stringify({ stdout: '{"loggedIn":false,"email":"x@y.z"}', exit: 1 }),
    FAKE_CLI_AUTH_CODEX: JSON.stringify({ stdout: "Logged in using an API key\n", exit: 0 }),
  });
  const c2 = createClients({ userData: out.userData, env: out.env, resolve: out.resolve, consented: async () => false, events: noEvents });
  const signedOut = await c2.authStatus("claude");
  assert.equal(signedOut.signedIn, false);
  assert.equal(signedOut.method, undefined);
  assert.equal((await c2.authStatus("codex")).method, "api-key");
  assert.equal((await c2.authStatus("gemini")).signedIn, "unknown");
});

test("terminal.open is refused without the provider's consent record", async () => {
  const { userData, env } = await setup();
  const spawned: Spawned[] = [];
  const records: ConsentRecord[] = [{ recipient: "codex", disclosureVersion: CONSENT_DISCLOSURE_VERSION, grantedAt: "2026-09-26T00:00:00.000Z" }];
  const clients = createClients({
    userData, env, resolve: resolveFake, pty: fakePty(spawned), events: noEvents,
    consented: async (id) => providerConsented(records, id),
  });
  await assert.rejects(clients.terminal.open("owner", "claude", "signin"), /Agree/);
  assert.equal(spawned.length, 0);
  assert.equal(providerConsented([{ ...records[0], recipient: "claude", disclosureVersion: "old" }], "claude"), false);
  const { sessionId } = await clients.terminal.open("owner", "codex", "signin");
  assert.deepEqual(spawned[0].args, [fakeScript, "codex", "login"]);
  await clients.terminal.close("owner", sessionId);
});

test("the renderer cannot choose the command or inject arguments", async () => {
  const { userData, env } = await setup();
  const spawned: Spawned[] = [];
  const clients = createClients({ userData, env, resolve: resolveFake, consented: async () => true, pty: fakePty(spawned), events: noEvents });
  for (const bad of [
    ["claude", "signin", "--dangerously-skip-permissions"],
    ["claude", "auth login --console"],
    ["claude --mcp-config evil.json", "signin"],
    ["claude", "session"],
    ["codex", "session"],
    ["C:\\Windows\\System32\\cmd.exe", "signin"],
    ["claude"],
    [{ id: "claude" }, "signin"],
  ])
    await assert.rejects(clients.terminal.open("owner", ...bad));
  await assert.rejects(clients.terminal.open("owner", "gemini", "signin"), /profile/);
  assert.equal(spawned.length, 0);
  assert.throws(() => parseOpenRequest(["claude", "signin", "x"]));

  const signin = await clients.terminal.open("owner", "claude", "signin");
  const second = await clients.terminal.open("owner", "codex", "signin");
  assert.deepEqual(spawned.map((s) => [s.file, s.args]), [
    [process.execPath, [fakeScript, "claude", "auth", "login"]],
    [process.execPath, [fakeScript, "codex", "login"]],
  ]);
  // Another window can't drive or close these sessions; bad ids and sizes are refused.
  assert.throws(() => clients.terminal.write("other", signin.sessionId, "x"));
  assert.throws(() => clients.terminal.write("owner", "not-a-session", "x"));
  assert.throws(() => clients.terminal.resize("owner", signin.sessionId, 0, 10));
  assert.throws(() => clients.terminal.write("owner", signin.sessionId, 42));
  await clients.terminal.close("other", signin.sessionId);
  assert.equal(spawned[0].killed, false);
  clients.terminal.closeAll({ owner: "owner" });
  assert.deepEqual(spawned.map((s) => s.killed), [true, true]);
  assert.equal(clients.terminal.sessions().length, 0);
  void second;
});

test("sessions are killed on close (real PTY running the fake client)", { skip: process.platform === "linux" && "node-pty ships prebuilt binaries for Windows and macOS only (the app's targets)" }, async () => {
  const { userData, env } = await setup();
  const exits: Array<[string, number | null]> = [];
  const data: string[] = [];
  const clients = createClients({
    userData, env, resolve: resolveFake, consented: async () => true, pty: loadNodePty,
    events: { data: (_o, _id, chunk) => void data.push(chunk), exit: (_o, id, code) => void exits.push([id, code]) },
  });
  // The fake client ignores `auth login`/`login` and waits on stdin until it is killed.
  const a = await clients.terminal.open("win", "claude", "signin");
  const b = await clients.terminal.open("win", "codex", "signin");
  assert.equal(clients.terminal.sessions().length, 2);
  await clients.terminal.close("win", a.sessionId);
  assert.ok(exits.some(([id]) => id === a.sessionId), "close waits for the exit");
  clients.terminal.closeAll({ owner: "win" });
  const deadline = Date.now() + 5000;
  while (!exits.some(([id]) => id === b.sessionId) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.ok(exits.some(([id]) => id === b.sessionId), "window close kills the rest");
  assert.equal(clients.terminal.sessions().length, 0);
});

test("the client env is an allowlist: no provider keys, tokens or app variables pass through", async () => {
  const secrets = {
    ANTHROPIC_API_KEY: "sk-ant-parent", ANTHROPIC_BASE_URL: "https://proxy.example",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-parent", CLAUDE_CODE_USE_BEDROCK: "1",
    OPENAI_API_KEY: "sk-openai-parent", CODEX_API_KEY: "codex-parent", GEMINI_API_KEY: "g-parent",
    AWS_SECRET_ACCESS_KEY: "aws-parent", GITHUB_TOKEN: "ghp-parent", GH_TOKEN: "gh-parent",
    NPM_TOKEN: "npm-parent", NODE_OPTIONS: "--require evil.js", MAGIC_USER_DATA: "x",
  };
  const { userData, env } = await setup({ ...secrets, LC_ALL: "C.UTF-8", HTTPS_PROXY: "http://proxy.local:8080", no_proxy: "localhost" });
  const spawned: Spawned[] = [];
  const clients = createClients({ userData, env, resolve: resolveFake, consented: async () => true, pty: fakePty(spawned), events: noEvents });
  const { sessionId } = await clients.terminal.open("owner", "claude", "signin");
  for (const child of [spawned[0].env, profileEnv("codex", { userData, env })]) {
    for (const key of Object.keys(secrets)) assert.equal(child[key], undefined, `${key} must not reach the client`);
    assert.ok(Object.keys(child).every((k) => !/(TOKEN|SECRET|API_KEY|PASSWORD)/i.test(k)));
    assert.equal(child.LC_ALL, "C.UTF-8");
    assert.equal(child.HTTPS_PROXY, "http://proxy.local:8080");
    assert.equal(child.no_proxy, "localhost");
    assert.ok(child.PATH ?? child.Path);
  }
  assert.equal(spawned[0].env.CLAUDE_CONFIG_DIR, profileDir(userData, "claude"));
  assert.equal(profileEnv("codex", { userData, env }).CODEX_HOME, profileDir(userData, "codex"));
  await clients.terminal.close("owner", sessionId);
});

test("open re-checks consent and the requesting window right before the spawn", async () => {
  const { userData, env } = await setup();
  const spawned: Spawned[] = [];
  let checks = 0;
  const revokedMidway = createClients({
    userData, env, resolve: resolveFake, pty: fakePty(spawned), events: noEvents,
    consented: async () => ++checks === 1,
  });
  await assert.rejects(revokedMidway.terminal.open("owner", "claude", "signin"), /Agree/);
  assert.equal(checks, 2, "consent is asked again after the awaits");
  assert.equal(spawned.length, 0);
  assert.equal(revokedMidway.terminal.sessions().length, 0);

  let alive = true;
  const closedMidway = createClients({
    userData, env, resolve: resolveFake, events: noEvents,
    consented: async () => true,
    alive: () => alive,
    pty: async () => {
      alive = false; // the window closes while the PTY library loads
      return (await fakePty(spawned)())
    },
  });
  await assert.rejects(closedMidway.terminal.open("owner", "claude", "signin"), /closed/);
  assert.equal(spawned.length, 0);
  assert.equal(closedMidway.terminal.sessions().length, 0);
});

// "Could not select Claude Code" (2026-09-27, Windows): the settings rename failed once and left
// `client-settings.json.<pid>.tmp` behind. A transient EPERM/EACCES/EBUSY is retried, other errors
// still surface, no temp file is left, and two quick picks no longer share one temp name.
test("choosing a client survives a briefly locked settings file and leaves no temp file", async () => {
  const { chooseClient, writeFileAtomic } = await import("../apps/desktop/src/clients/profiles.ts");
  const { rename } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "magic-choose-"));
  const path = join(dir, "client-settings.json");
  let fails = 2;
  await writeFileAtomic(path, "{\"chosen\":\"claude\"}\n", async (from, to) => {
    if (fails-- > 0) throw Object.assign(new Error("locked"), { code: "EPERM" });
    await rename(from, to);
  });
  assert.equal(await readFile(path, "utf8"), "{\"chosen\":\"claude\"}\n");
  await assert.rejects(
    writeFileAtomic(path, "{}", async () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); }),
    /gone/,
  );
  await Promise.all([chooseClient("claude", dir), chooseClient("codex", dir)]);
  assert.ok(["claude", "codex"].includes((await readClientSettings(dir)).chosen ?? ""));
  assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith(".tmp")), []);
});
