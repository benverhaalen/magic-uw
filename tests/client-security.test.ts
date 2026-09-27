// owner: client-detection (security review and the operator's defence in depth, 2026-09-27).
// The model never gets tools: the runtime tripwire kills any run whose stream shows a tool use,
// Codex runs tools-off in both modes, and no parent variable beyond the allowlist reaches a client.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ClientId } from "../packages/contracts/src/index.ts";
import {
  RunnerError,
  claudeToolUse,
  cliEnvironment,
  codexArgs,
  codexToolUse,
  createClaudeBackend,
  createCodexBackend,
  createModelRunner,
  createSessionPool,
  type CliCommand,
  type LedgerEntry,
} from "../packages/runner/src/index.ts";
import { CODEX_OPTIONAL_FLAGS, CODEX_REQUIRED_FLAGS, clientRunOptions } from "../apps/desktop/src/clients/index.ts";

const fakeScript = join(import.meta.dirname, "fixtures", "fake-cli", "fake-cli.mjs");
const fake = (kind: "claude" | "codex"): CliCommand => ({ file: process.execPath, prefixArgs: [fakeScript, kind] });
const tmp = (p: string) => mkdtemp(join(tmpdir(), p));
const schema = z.object({ ok: z.boolean() });
const ask = { pack: { id: "probe", version: "v1" }, systemPrompt: "S", input: "x", schema, tier: "pass" as const, lane: "interactive" as const };
const toolUse = (name: string) => ({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name, input: { command: "SECRET-CONTENT" } }] } });

// --- Layer 1: the runtime tripwire ------------------------------------------------------------
test("tripwire, Claude: a tool_use kills the run at once, discards output and writes a receipt (kind and name only)", async () => {
  const dir = await tmp("magic-trip-");
  const ledger: LedgerEntry[] = [];
  const runner = createModelRunner({
    backend: createClaudeBackend({ command: fake("claude"), workDir: dir, env: { FAKE_CLI_STATE: join(dir, "s"), FAKE_CLI_RESPONSES: JSON.stringify([{ events: [toolUse("Bash")], holdMs: 8000, output: { ok: true } }]) } }),
    ledger: (e) => ledger.push(e),
  });
  const started = Date.now();
  await assert.rejects(runner.run(ask), (e: unknown) => e instanceof RunnerError && e.kind === "tool_use_blocked" && e.blocked?.tool === "Bash");
  assert.ok(Date.now() - started < 4000, "killed before the fake's 8 s hold ended");
  assert.equal(ledger.length, 1, "not retried or escalated");
  assert.deepEqual([ledger[0].errorKind, ledger[0].blocked], ["tool_use_blocked", { event: "tool_use", tool: "Bash" }]);
  assert.ok(!JSON.stringify(ledger).includes("SECRET-CONTENT"));
});

test("tripwire, Claude: only the built-in StructuredOutput tool (--json-schema) passes; tools or MCP in init are blocked", async () => {
  assert.equal(claudeToolUse(JSON.stringify(toolUse("StructuredOutput"))), null);
  assert.equal(claudeToolUse(JSON.stringify({ type: "system", subtype: "init", tools: ["StructuredOutput"], mcp_servers: [] })), null);
  assert.deepEqual(claudeToolUse(JSON.stringify({ type: "system", subtype: "init", tools: ["StructuredOutput", "Read"], mcp_servers: [] })), { event: "tools_enabled", tool: "Read" });
  assert.deepEqual(claudeToolUse(JSON.stringify({ type: "system", subtype: "init", tools: [], mcp_servers: [{ name: "fs", status: "connected" }] })), { event: "mcp_enabled", tool: "fs" });
  assert.deepEqual(claudeToolUse(JSON.stringify({ type: "assistant", message: { content: [{ type: "server_tool_use", name: "web_search" }] } })), { event: "server_tool_use", tool: "web_search" });
  assert.equal(claudeToolUse("not json"), null);
  const dir = await tmp("magic-trip-");
  const runner = createModelRunner({
    backend: createClaudeBackend({ command: fake("claude"), workDir: dir, env: { FAKE_CLI_STATE: join(dir, "s"), FAKE_CLI_RESPONSES: JSON.stringify([{ events: [toolUse("StructuredOutput")], output: { ok: true } }]) } }),
  });
  assert.deepEqual((await runner.run(ask)).output, { ok: true });
});

test("tripwire, Codex: every tool item is blocked on item.started; messages and reasoning pass", async () => {
  const item = (type: string, extra: object = {}) => JSON.stringify({ type: "item.started", item: { id: "i", type, ...extra } });
  assert.deepEqual(codexToolUse(item("command_execution", { command: "cat ~/.ssh/id_rsa" })), { event: "command_execution", tool: "shell" });
  assert.deepEqual(codexToolUse(item("file_change")), { event: "file_change", tool: "apply_patch" });
  assert.deepEqual(codexToolUse(item("mcp_tool_call", { server: "fs", tool: "read_file" })), { event: "mcp_tool_call", tool: "mcp:fs/read_file" });
  assert.deepEqual(codexToolUse(item("web_search", { query: "x" })), { event: "web_search", tool: "web_search" });
  assert.deepEqual(codexToolUse(item("todo_list")), { event: "todo_list", tool: "todo_list" });
  assert.deepEqual(codexToolUse(item("collab_tool_call")), { event: "collab_tool_call", tool: "collab_tool_call" });
  for (const ok of ["agent_message", "reasoning", "error"]) assert.equal(codexToolUse(item(ok)), null);
  assert.equal(codexToolUse(JSON.stringify({ type: "turn.completed", usage: {} })), null);
  const dir = await tmp("magic-trip-");
  const events = [{ type: "item.started", item: { id: "i1", type: "command_execution", command: "SECRET-CONTENT" } }];
  const runner = createModelRunner({
    backend: createCodexBackend({ command: fake("codex"), workDir: dir, env: { FAKE_CLI_STATE: join(dir, "s"), FAKE_CLI_RESPONSES: JSON.stringify([{ events, holdMs: 8000, output: { ok: true } }]) } }),
  });
  const started = Date.now();
  await assert.rejects(runner.run(ask), (e: unknown) => e instanceof RunnerError && e.kind === "tool_use_blocked" && e.blocked?.tool === "shell");
  assert.ok(Date.now() - started < 4000);
});

test("tripwire, warm pool: a tool use kills the session and fails the ask (no silent fallback)", async () => {
  const dir = await tmp("magic-trip-pool-");
  const env = { FAKE_CLI_STATE: join(dir, "s"), FAKE_CLI_LOG: join(dir, "log"), FAKE_CLI_RESPONSES: JSON.stringify([{ events: [toolUse("Bash")], output: { kind: "probe", data: { ok: true } } }]) };
  const pool = createSessionPool({ command: fake("claude"), workDir: dir, env, kinds: { probe: schema }, fallback: createClaudeBackend({ command: fake("claude"), workDir: dir, env }) });
  try {
    await assert.rejects(createModelRunner({ backend: pool }).run(ask), (e: unknown) => e instanceof RunnerError && e.kind === "tool_use_blocked");
    const spawn = (await readFile(join(dir, "log"), "utf8")).trim().split("\n").map((l) => JSON.parse(l)).find((l) => l.event === "spawn");
    assert.ok(spawn.argv.includes("--settings"), "the pool's sessions carry the deny hook too");
  } finally {
    await pool.close();
  }
});

// --- Codex tools off in both modes -------------------------------------------------------------
test("Codex: instant and separate-profile runs both disable the shell and tools, read-only, never asking", async () => {
  const userData = await tmp("magic-codex-modes-");
  const help = [...CODEX_REQUIRED_FLAGS, ...CODEX_OPTIONAL_FLAGS].map((f) => `      ${f} <x>`).join("\n");
  const features = "shell_tool stable true\nunified_exec stable true\napps stable true\nplugins stable true\n";
  const deps = { userData, env: { PATH: process.env.PATH, USERPROFILE: userData, HOME: userData }, resolve: (id: ClientId) => (id === "codex" ? fake("codex") : null), help: async () => help, features: async () => features, exists: async () => false, status: async () => ({ signedIn: true, method: "chatgpt", plan: null }), online: async () => true };
  const isolated = async () => ({ command: fake("codex"), workDir: userData, env: {} });
  for (const mode of ["instant", "isolated"] as const) {
    const { writeClientMode } = await import("../apps/desktop/src/clients/index.ts");
    await writeClientMode("codex", mode, userData);
    const run = await clientRunOptions("codex", deps, isolated);
    assert.ok(run, mode);
    assert.equal(run.mode, mode);
    const argv = [...codexArgs({ schemaPath: "/s.json" }), ...(run.options.extraArgs ?? [])];
    const disabled = argv.filter((_, i) => argv[i - 1] === "--disable");
    for (const f of ["shell_tool", "unified_exec", "apps", "plugins"]) assert.ok(disabled.includes(f), `${mode}: ${f}`);
    assert.equal(argv[argv.indexOf("-s") + 1], "read-only", mode);
    assert.ok(argv.includes('approval_policy="never"'), mode);
    assert.ok(argv.includes('web_search="disabled"'), mode);
  }
  // A Codex that can't turn its shell off isn't run in its separate profile either.
  const noDisable = CODEX_REQUIRED_FLAGS.map((f) => `      ${f} <x>`).join("\n");
  assert.equal(await clientRunOptions("codex", { ...deps, help: async () => noDisable }, isolated), null);
});

// --- The environment allowlist ----------------------------------------------------------------
test("env: planted provider keys and base URLs never reach a client process; each mode's own variable does", async () => {
  const planted = {
    ANTHROPIC_API_KEY: "sk-ant-planted",
    ANTHROPIC_BASE_URL: "https://evil.example",
    OPENAI_API_KEY: "sk-planted",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CODEX_API_KEY: "planted",
    AWS_SECRET_ACCESS_KEY: "planted",
    GEMINI_API_KEY: "planted",
    NODE_OPTIONS: "--require evil.js",
    MAGIC_DB_PATH: "x",
  };
  const env = cliEnvironment({ CLAUDE_CONFIG_DIR: "/own" }, { ...planted, PATH: "/usr/bin", HOME: "/h", SSL_CERT_FILE: "/c.pem" });
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/h", SSL_CERT_FILE: "/c.pem", CLAUDE_CONFIG_DIR: "/own" });
  // End to end: a real spawn through the Claude backend, with the keys planted in this process.
  const dir = await tmp("magic-env-");
  const probe = join(dir, "probe.mjs");
  await writeFile(
    probe,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.PROBE_OUT, JSON.stringify(Object.keys(process.env)));\nprocess.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "{}", structured_output: { ok: true }, usage: {}, modelUsage: { m: {} } }));\n`,
  );
  const saved = { ...process.env };
  Object.assign(process.env, planted);
  try {
    const runner = createModelRunner({ backend: createClaudeBackend({ command: { file: process.execPath, prefixArgs: [probe] }, workDir: dir, env: { PROBE_OUT: join(dir, "env.json") } }) });
    await runner.run(ask);
  } finally {
    for (const k of Object.keys(planted)) if (!(k in saved)) delete process.env[k];
  }
  const seen: string[] = JSON.parse(await readFile(join(dir, "env.json"), "utf8"));
  for (const k of Object.keys(planted)) assert.ok(!seen.some((s) => s.toUpperCase() === k), `${k} reached the client`);
});

// --- Security review, 2026-09-27: land-after-fixes items ------------------------------------------
test("review 1: Codex Quick chat turns every non-safe feature off, never asks, and doesn't open when that can't be done", async () => {
  const { codexChatArgs, chatArgs } = await import("../apps/desktop/src/clients/index.ts");
  const userData = await tmp("magic-chat-");
  const help = [...CODEX_REQUIRED_FLAGS, ...CODEX_OPTIONAL_FLAGS].map((f) => `      ${f} <x>`).join("\n");
  const list = await readFile(join(import.meta.dirname, "fixtures", "codex-features-0.156.1.txt"), "utf8");
  const args = await codexChatArgs({ userData, help: async () => help, features: async () => list });
  assert.ok(args);
  assert.ok(!args.includes("untrusted"));
  assert.equal(args[args.indexOf("-a") + 1], "never");
  assert.equal(args[args.indexOf("-s") + 1], "read-only");
  const disabled = args.filter((_, i) => args[i - 1] === "--disable");
  for (const f of ["shell_tool", "unified_exec", "sleep_tool", "in_app_browser", "browser_use", "browser_use_external", "browser_use_full_cdp_access", "code_mode_host"])
    assert.ok(disabled.includes(f), f);
  assert.deepEqual(chatArgs("codex", args), args);
  assert.throws(() => chatArgs("codex", null), /no chat/);
  assert.equal(await codexChatArgs({ userData, help: async () => help.replace("--disable", ""), features: async () => list }), null);
});

test("review 3: features from `codex features list` (real 0.156.1 output): everything off except the safe list; unreadable means don't run", async () => {
  const { featuresToDisable, CODEX_SAFE_FEATURES, instantSupport } = await import("../apps/desktop/src/clients/index.ts");
  const list = await readFile(join(import.meta.dirname, "fixtures", "codex-features-0.156.1.txt"), "utf8");
  const off = featuresToDisable(list);
  for (const f of ["sleep_tool", "in_app_browser", "browser_use", "browser_use_external", "browser_use_full_cdp_access", "code_mode_host", "shell_tool", "apps", "plugins", "hooks", "memories"])
    assert.ok(off.includes(f), f);
  for (const f of CODEX_SAFE_FEATURES) assert.ok(!off.includes(f), f);
  assert.ok(!off.includes("apply_patch_freeform"), "removed features aren't passed");
  const userData = await tmp("magic-feat-");
  const help = [...CODEX_REQUIRED_FLAGS, ...CODEX_OPTIONAL_FLAGS].map((f) => `      ${f} <x>`).join("\n");
  for (const bad of ["", "garbage\nnot a feature table\n", "apps stable true\n"]) {
    const plan = await instantSupport("codex", "9.9.9", { userData, help: async () => help, features: async () => bad, exists: async () => false });
    assert.equal(plan.support.available, false, JSON.stringify(bad));
  }
});

test("review 2: the kill takes the whole process tree", async () => {
  const dir = await tmp("magic-tree-");
  const marker = join(dir, "grandchild-ran.txt");
  const runner = createModelRunner({
    backend: createClaudeBackend({
      command: fake("claude"),
      workDir: dir,
      env: { FAKE_CLI_STATE: join(dir, "s"), FAKE_CLI_RESPONSES: JSON.stringify([{ grandchild: { marker, ms: 1500 }, events: [toolUse("Bash")], holdMs: 8000, output: { ok: true } }]) },
    }),
  });
  await assert.rejects(runner.run(ask), (e: unknown) => e instanceof RunnerError && e.kind === "tool_use_blocked");
  await new Promise((r) => setTimeout(r, 2500));
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(marker), false, "the grandchild was killed with the client");
});

test("review 4: fail-closed stream checks; UTF-8 split across chunks stays whole", async () => {
  const { claudeStreamCheck, codexStreamCheck, runProcess } = await import("../packages/runner/src/index.ts");
  assert.equal(claudeStreamCheck("Welcome! not json")?.kind, "invalid_output");
  assert.equal(codexStreamCheck("WARNING something")?.kind, "invalid_output");
  assert.equal(claudeStreamCheck(""), null);
  assert.equal(claudeStreamCheck(JSON.stringify({ type: "rate_limit_event" })), null);
  assert.equal(claudeStreamCheck(JSON.stringify({ type: "tool_progress", content: [{ type: "text" }] }))?.kind, "invalid_output");
  assert.equal(claudeStreamCheck(JSON.stringify({ type: "brand_new_event", message: { content: [] } }))?.kind, "invalid_output");
  assert.equal(claudeStreamCheck(JSON.stringify({ type: "brand_new_event", status: "ok" })), null);
  assert.equal(codexStreamCheck(JSON.stringify({ type: "something.new", item: { type: "command_execution" } }))?.kind, "tool_use_blocked");
  // A real call printing a non-JSON line is stopped as invalid_output (the runner then treats it as
  // an unreadable answer, as before: retry, escalate, each attempt stopped the same way).
  const dir = await tmp("magic-closed-");
  const backend = createClaudeBackend({ command: fake("claude"), workDir: dir, env: { FAKE_CLI_STATE: join(dir, "s"), FAKE_CLI_RESPONSES: JSON.stringify([{ events: ["Loading plugins..."], output: { ok: true } }]) } });
  await assert.rejects(
    backend.call({ pack: ask.pack, systemPrompt: "S", input: "x", jsonSchema: { type: "object" }, tier: "pass", lane: "interactive", timeoutMs: 20_000 }),
    (e: unknown) => e instanceof RunnerError && e.kind === "invalid_output",
  );
  // "é" (0xC3 0xA9) written as two chunks: the line check sees the whole character.
  const script = join(dir, "split.mjs");
  await writeFile(script, `process.stdout.write(Buffer.from([0x7b,0x22,0x61,0x22,0x3a,0x22,0xc3]));\nsetTimeout(() => process.stdout.write(Buffer.from([0xa9,0x22,0x7d,0x0a])), 200);\n`);
  const lines: string[] = [];
  await runProcess({ file: process.execPath, prefixArgs: [script] }, [], { cwd: dir, env: { PATH: process.env.PATH }, timeoutMs: 10_000, onStdoutLine: (l) => (lines.push(l), null) });
  assert.deepEqual(lines, ['{"a":"é"}']);
});

test("review 6 and 7: home shown as ~ only on a separator boundary; receipts are sanitised names", async () => {
  const { homeRelative } = await import("../apps/desktop/src/clients/index.ts");
  assert.equal(homeRelative("C:\\Users\\Sam\\.local\\bin", "C:\\Users\\Sam", "win32"), "~\\.local\\bin");
  assert.equal(homeRelative("C:\\Users\\Samantha\\.local\\bin", "C:\\Users\\Sam", "win32"), "C:\\Users\\Samantha\\.local\\bin");
  assert.equal(homeRelative("c:/users/sam/", "C:\\Users\\Sam", "win32"), "~");
  assert.equal(homeRelative("/home/sam/.bun/bin", "/home/sam/", "linux"), "~/.bun/bin");
  assert.equal(homeRelative("/home/Sam/.bun/bin", "/home/sam", "linux"), "/home/Sam/.bun/bin");
  assert.deepEqual(codexToolUse(JSON.stringify({ type: "item.started", item: { type: "evil\u001b[31m type<script>", server: "a b", tool: "c/../d" } })), {
    event: "evil31mtypescript",
    tool: "evil31mtypescript",
  });
});
