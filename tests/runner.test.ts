import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  createApiBackend,
  createBackgroundBudget,
  createClaudeBackend,
  createCodexBackend,
  createLocalBackend,
  createModelRunner,
  formatAskHeader,
  resolveCli,
  resolveNpmShim,
  RunnerError,
  type CliCommand,
  type LedgerEntry,
} from "../packages/runner/src/index.ts";
import { OLLAMA_LOCAL_ORIGIN } from "../packages/ai/src/local.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fakeScript = join(here, "fixtures", "fake-cli", "fake-cli.mjs");
const fake = (kind: "claude" | "codex"): CliCommand => ({
  file: process.execPath,
  prefixArgs: [fakeScript, kind],
});

async function harness(responses: unknown[]) {
  const dir = await mkdtemp(join(tmpdir(), "runner-"));
  const workDir = join(dir, "work");
  await mkdir(workDir);
  const logPath = join(dir, "log.jsonl");
  const env = {
    FAKE_CLI_LOG: logPath,
    FAKE_CLI_STATE: join(dir, "state"),
    FAKE_CLI_RESPONSES: JSON.stringify(responses),
  };
  const calls = async () =>
    existsSync(logPath)
      ? (await readFile(logPath, "utf8"))
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as { argv: string[]; stdin: string; cwd: string; event?: string })
      : [];
  return { dir, workDir, env, calls };
}

const cardSchema = z.object({ front: z.string().min(1), back: z.string().min(1) }).strict();
const pack = { id: "cards", version: "v1" };
const SYSTEM = "You write study cards. Synthetic course: Example 101.";
const forbidden = [
  "--dangerously-skip-permissions",
  "--bare",
  "--dangerously-bypass-approvals-and-sandbox",
  "--full-auto",
];

test("claude one-shot: exact spec E2 argv, prompt only on stdin, byte-stable prefix file, usage parsed", async () => {
  const h = await harness([{ output: { front: "Q", back: "A" } }]);
  const backend = createClaudeBackend({ command: fake("claude"), workDir: h.workDir, env: h.env });
  const ledger: LedgerEntry[] = [];
  const runner = createModelRunner({ backend, ledger: (e) => ledger.push(e) });
  const secretAsk = "SYNTHETIC-ASK-7731 make one card";
  const result = await runner.run({ pack, systemPrompt: SYSTEM, input: secretAsk, schema: cardSchema, tier: "pass" });
  assert.deepEqual(result.output, { front: "Q", back: "A" });
  assert.deepEqual(result.usage, { in: 100, cached: 90, out: 20 });
  assert.equal(result.model, "claude-sonnet-5");
  assert.equal(result.attempts, 1);
  const [call] = await h.calls();
  const prefixPath = call.argv[call.argv.indexOf("--system-prompt-file") + 1];
  const schemaJson = call.argv[call.argv.indexOf("--json-schema") + 1];
  assert.deepEqual(call.argv, [
    "-p", "--output-format", "json", "--json-schema", schemaJson, "--tools", "",
    "--strict-mcp-config", "--setting-sources", "project,local", "--no-session-persistence",
    "--system-prompt-file", prefixPath, "--model", "sonnet",
  ]);
  assert.equal(JSON.parse(schemaJson).type, "object");
  assert.equal(await readFile(prefixPath, "utf8"), SYSTEM);
  assert.equal(call.stdin, secretAsk);
  assert.ok(!call.argv.some((a) => a.includes("SYNTHETIC-ASK")));
  assert.ok(!call.argv.some((a) => forbidden.includes(a)));
  assert.equal(call.cwd.toLowerCase(), h.workDir.toLowerCase());
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].outcome, "ok");
  assert.equal(ledger[0].pack, "cards");
});

test("the same prefix maps to the same file; a different course gets a different one", async () => {
  const h = await harness([{ output: { front: "Q", back: "A" } }]);
  const runner = createModelRunner({ backend: createClaudeBackend({ command: fake("claude"), workDir: h.workDir, env: h.env }) });
  for (const system of [SYSTEM, SYSTEM, `${SYSTEM} Other course.`])
    await runner.run({ pack, systemPrompt: system, input: "x", schema: cardSchema, tier: "pass" });
  const prefixes = (await h.calls()).map((c) => c.argv[c.argv.indexOf("--system-prompt-file") + 1]);
  assert.equal(prefixes[0], prefixes[1]);
  assert.notEqual(prefixes[0], prefixes[2]);
  assert.equal((await readdir(join(h.workDir, "prefix"))).length, 2);
});

test("codex one-shot: exact spec E2 argv, prefix leads stdin, strong tier adds effort, usage parsed", async () => {
  const h = await harness([{ output: { front: "Q", back: "A" }, usage: { input_tokens: 500, cached_input_tokens: 400, output_tokens: 30 } }]);
  const backend = createCodexBackend({ command: fake("codex"), workDir: h.workDir, env: h.env });
  const runner = createModelRunner({ backend });
  const pass = await runner.run({ pack, systemPrompt: SYSTEM, input: "ask one", schema: cardSchema, tier: "pass" });
  assert.deepEqual(pass.usage, { in: 500, cached: 400, out: 30 });
  await runner.run({ pack, systemPrompt: SYSTEM, input: "ask two", schema: cardSchema, tier: "strong" });
  const [first, second] = await h.calls();
  const schemaPath = first.argv[first.argv.indexOf("--output-schema") + 1];
  assert.deepEqual(first.argv, [
    "exec", "-", "--json", "--output-schema", schemaPath, "--ephemeral", "-s", "read-only", "--ignore-user-config",
  ]);
  assert.equal(JSON.parse(await readFile(schemaPath, "utf8")).additionalProperties, false);
  assert.ok(first.stdin.startsWith(SYSTEM));
  assert.ok(first.stdin.endsWith("ask one"));
  assert.deepEqual(second.argv.slice(-2), ["-c", 'model_reasoning_effort="high"']);
  for (const c of [first, second]) assert.ok(!c.argv.some((a) => forbidden.includes(a) || a.includes("ask")));
});

test("a failed check retries once at the same tier with the errors, then succeeds", async () => {
  const h = await harness([{ output: { front: "", back: "A" } }, { output: { front: "Q", back: "A" } }]);
  const ledger: LedgerEntry[] = [];
  const runner = createModelRunner({
    backend: createClaudeBackend({ command: fake("claude"), workDir: h.workDir, env: h.env }),
    ledger: (e) => ledger.push(e),
  });
  const result = await runner.run({ pack, systemPrompt: SYSTEM, input: "ask", schema: cardSchema, tier: "pass" });
  assert.equal(result.attempts, 2);
  assert.equal(result.escalated, false);
  assert.deepEqual(result.usage, { in: 200, cached: 180, out: 40 });
  const calls = await h.calls();
  assert.match(calls[1].stdin, /\[checks\][\s\S]*front/);
  assert.deepEqual(calls[1].argv, calls[0].argv);
  assert.deepEqual(ledger.map((e) => e.outcome), ["check_failed", "ok"]);
});

test("code checks fail twice at pass: escalate once to strong on the escalation lane", async () => {
  const h = await harness([
    { output: { front: "Q", back: "A" } },
    { output: { front: "Q", back: "A" } },
    { output: { front: "Q2", back: "A2" }, model: "claude-opus-5-5" },
  ]);
  const ledger: LedgerEntry[] = [];
  const runner = createModelRunner({
    backend: createClaudeBackend({ command: fake("claude"), workDir: h.workDir, env: h.env }),
    ledger: (e) => ledger.push(e),
  });
  const result = await runner.run({
    pack, systemPrompt: SYSTEM, input: "ask", schema: cardSchema, tier: "pass",
    check: (card) => (card.front === "Q" ? ["front repeats an earlier card"] : []),
  });
  assert.equal(result.escalated, true);
  assert.equal(result.tier, "strong");
  assert.equal(result.model, "claude-opus-5-5");
  assert.equal(result.attempts, 3);
  const calls = await h.calls();
  assert.deepEqual(calls.map((c) => c.argv[c.argv.indexOf("--model") + 1]), ["sonnet", "sonnet", "opus"]);
  assert.match(calls[2].stdin, /front repeats an earlier card/);
  assert.deepEqual(ledger.map((e) => [e.tier, e.lane, e.outcome]), [
    ["pass", "background", "check_failed"],
    ["pass", "background", "check_failed"],
    ["strong", "escalation", "ok"],
  ]);
});

test("after retry and escalation fail, the run ends with check_failed and its errors", async () => {
  const h = await harness([{ text: "not json at all" }]);
  const runner = createModelRunner({ backend: createCodexBackend({ command: fake("codex"), workDir: h.workDir, env: h.env }) });
  await assert.rejects(
    runner.run({ pack, systemPrompt: SYSTEM, input: "ask", schema: cardSchema, tier: "pass" }),
    (e: unknown) => e instanceof RunnerError && e.kind === "check_failed" && e.checkErrors.length > 0,
  );
  assert.equal((await h.calls()).length, 3);
});

test("a usage limit is not retried or escalated; background pauses, interactive still runs", async () => {
  const h = await harness([{ error: "Claude AI usage limit reached|1790000000" }, { output: { front: "Q", back: "A" } }]);
  let clock = Date.parse("2026-09-26T15:00:00Z");
  const budget = createBackgroundBudget({ dailyBackgroundTokens: 100_000, now: () => clock });
  const ledger: LedgerEntry[] = [];
  const runner = createModelRunner({
    backend: createClaudeBackend({ command: fake("claude"), workDir: h.workDir, env: h.env }),
    budget, ledger: (e) => ledger.push(e), now: () => clock,
  });
  const ask = { pack, systemPrompt: SYSTEM, input: "ask", schema: cardSchema, tier: "pass" as const };
  await assert.rejects(runner.run({ ...ask, lane: "background" }), (e: unknown) => e instanceof RunnerError && e.kind === "usage_limit");
  assert.equal((await h.calls()).length, 1);
  await assert.rejects(runner.run({ ...ask, lane: "background" }), (e: unknown) => e instanceof RunnerError && e.kind === "background_paused");
  assert.equal((await h.calls()).length, 1);
  const interactive = await runner.run({ ...ask, lane: "interactive" });
  assert.equal(interactive.output.front, "Q");
  clock += 61 * 60 * 1000;
  await runner.run({ ...ask, lane: "background" });
  assert.deepEqual(ledger.map((e) => e.outcome), ["usage_limit", "refused", "ok", "ok"]);
});

test("the daily background budget refuses before sending and resets the next day", async () => {
  const h = await harness([{ output: { front: "Q", back: "A" }, usage: { input_tokens: 900, output_tokens: 100 } }]);
  let clock = new Date(2026, 8, 26, 12).getTime();
  const budget = createBackgroundBudget({ dailyBackgroundTokens: 1500, now: () => clock });
  const runner = createModelRunner({
    backend: createClaudeBackend({ command: fake("claude"), workDir: h.workDir, env: h.env }),
    budget, now: () => clock,
  });
  const ask = { pack, systemPrompt: SYSTEM, input: "ask", schema: cardSchema, tier: "pass" as const, lane: "background" as const };
  await runner.run(ask);
  assert.equal(budget.state().spent, 1000);
  await assert.rejects(runner.run({ ...ask, budget: { maxOutputTokens: 600 } }), (e: unknown) => e instanceof RunnerError && e.kind === "budget_exhausted");
  assert.equal((await h.calls()).length, 1);
  clock += 24 * 60 * 60 * 1000;
  await runner.run({ ...ask, budget: { maxOutputTokens: 600 } });
  assert.equal((await h.calls()).length, 2);
});

test("the metadata header is one fixed-order line ahead of the ask", async () => {
  assert.equal(
    formatAskHeader(
      { course: "COMP SCI 400", profile: "computing", scope: "Midterm 2", intent: "items", sources: ["r12", "r40", "r41"] },
      { id: "items", version: "v3" },
      6000,
    ),
    '[ctx course="COMP SCI 400" profile=computing scope="Midterm 2" intent=items pack=items.v3 sources=r12,r40,r41 budget=6k]',
  );
  assert.equal(formatAskHeader({ scope: "a]\nb" }, pack), '[ctx scope="a b" pack=cards.v1]');
  const h = await harness([{ output: { front: "Q", back: "A" } }]);
  const runner = createModelRunner({ backend: createClaudeBackend({ command: fake("claude"), workDir: h.workDir, env: h.env }) });
  await runner.run({ pack, systemPrompt: SYSTEM, input: "passages", schema: cardSchema, tier: "pass", context: { course: "Example 101" } });
  assert.equal((await h.calls())[0].stdin, '[ctx course="Example 101" pack=cards.v1]\npassages');
});

test("an oversized ask is refused before any process starts; a hung CLI times out", async () => {
  const h = await harness([{ output: { front: "Q", back: "A" }, sleepMs: 5000 }]);
  const ledger: LedgerEntry[] = [];
  const runner = createModelRunner({
    backend: createClaudeBackend({ command: fake("claude"), workDir: h.workDir, env: h.env }),
    ledger: (e) => ledger.push(e),
  });
  await assert.rejects(
    runner.run({ pack, systemPrompt: SYSTEM, input: "x".repeat(4000), schema: cardSchema, tier: "pass", budget: { maxInputTokens: 500 } }),
    (e: unknown) => e instanceof RunnerError && e.kind === "too_large",
  );
  assert.equal((await h.calls()).length, 0);
  await assert.rejects(
    runner.run({ pack, systemPrompt: SYSTEM, input: "x", schema: cardSchema, tier: "pass", budget: { timeoutMs: 300 } }),
    (e: unknown) => e instanceof RunnerError && e.kind === "timeout",
  );
  assert.deepEqual(ledger.map((e) => e.outcome), ["refused", "error"]);
});

test("a not-signed-in client surfaces not_signed_in without retrying", async () => {
  const h = await harness([{ error: "Not logged in · Please run /login" }]);
  const runner = createModelRunner({ backend: createClaudeBackend({ command: fake("claude"), workDir: h.workDir, env: h.env }) });
  await assert.rejects(
    runner.run({ pack, systemPrompt: SYSTEM, input: "x", schema: cardSchema, tier: "pass" }),
    (e: unknown) => e instanceof RunnerError && e.kind === "not_signed_in" && !e.message.includes("login"),
  );
  assert.equal((await h.calls()).length, 1);
});

test("API-key routes: key in a header only, no redirects or cookies, schema sent, usage parsed, 429 is a usage limit", async () => {
  const seen: { url: string; init: RequestInit; body: any }[] = [];
  const replies: Record<string, unknown> = {
    openrouter: { model: "anthropic/claude-sonnet-5", choices: [{ message: { content: '{"front":"Q","back":"A"}' } }], usage: { prompt_tokens: 50, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 40 } } },
    anthropic: { model: "claude-sonnet-5", content: [{ type: "text", text: '{"front":"Q","back":"A"}' }], usage: { input_tokens: 5, cache_read_input_tokens: 40, cache_creation_input_tokens: 5, output_tokens: 5 } },
    gemini: { modelVersion: "gemini-3.5-flash", candidates: [{ content: { parts: [{ text: '{"front":"Q","back":"A"}' }] } }], usageMetadata: { promptTokenCount: 50, cachedContentTokenCount: 40, candidatesTokenCount: 5 } },
  };
  for (const provider of ["openrouter", "anthropic", "gemini"] as const) {
    const fetcher: typeof fetch = async (url, init = {}) => {
      seen.push({ url: String(url), init, body: JSON.parse(String(init.body)) });
      return Response.json(replies[provider]);
    };
    const runner = createModelRunner({ backend: createApiBackend({ provider, key: "sk-synthetic-000", fetcher }) });
    const r = await runner.run({ pack, systemPrompt: SYSTEM, input: "ask", schema: cardSchema, tier: "pass" });
    assert.deepEqual(r.output, { front: "Q", back: "A" });
    assert.deepEqual(r.usage, { in: 50, cached: 40, out: 5 });
  }
  for (const s of seen) {
    assert.ok(s.url.startsWith("https://"));
    assert.ok(!s.url.includes("sk-synthetic"));
    assert.equal(s.init.redirect, "error");
    assert.equal(s.init.credentials, "omit");
    assert.ok(Object.values(s.init.headers as Record<string, string>).some((v) => v.includes("sk-synthetic-000")));
  }
  assert.equal(seen[0].body.response_format.json_schema.strict, true);
  assert.equal(seen[2].body.generationConfig.responseJsonSchema.type, "object");
  const limited = createModelRunner({
    backend: createApiBackend({ provider: "openai", key: "sk-synthetic-000", fetcher: async () => new Response("{}", { status: 429 }) }),
  });
  await assert.rejects(
    limited.run({ pack, systemPrompt: SYSTEM, input: "ask", schema: cardSchema, tier: "pass" }),
    (e: unknown) => e instanceof RunnerError && e.kind === "usage_limit" && !e.message.includes("sk-"),
  );
});

test("local route: Ollama through packages/ai's verified selection, the schema as format, zod-checked", async () => {
  const installed = { name: "learner:3b", model: "learner:3b", digest: "a".repeat(64), size: 1, details: { format: "gguf", quantization_level: "Q4_K_M" } };
  const recommendation = { name: "Example/Learner-3B", ollama_name: "learner:3b", score: 85, fit_level: "Good", runtime: "llama.cpp", best_quant: "Q4_K_M", usable_context: 8192, effective_context_length: 4096, memory_required_gb: 3, memory_available_gb: 8, license: "apache-2.0", estimated_tps: 30, estimate_confidence: "estimated" };
  const chats: any[] = [];
  const replies = ['{"front":"","back":"A"}', '{"front":"Q","back":"A"}'];
  const fetcher: typeof fetch = async (url, init = {}) => {
    const u = String(url);
    assert.ok(u.startsWith(`${OLLAMA_LOCAL_ORIGIN}/api/`));
    if (u.endsWith("/status")) return Response.json({ cloud: { disabled: true } });
    if (u.endsWith("/tags")) return Response.json({ models: [installed] });
    if (u.endsWith("/show")) return Response.json({ model_info: { "general.architecture": "synthetic" }, details: installed.details, capabilities: ["completion"] });
    const body = JSON.parse(String(init.body));
    chats.push(body);
    return Response.json({ model: "learner:3b", done: true, message: { role: "assistant", content: replies[chats.length - 1] }, prompt_eval_count: 70, eval_count: 9 });
  };
  const run = async (_f: string, args: readonly string[]) =>
    args[0] === "--version" ? "llmfit 1.1.16" : JSON.stringify({ system: {}, models: [recommendation] });
  const runner = createModelRunner({ backend: createLocalBackend({ fetcher, run }) });
  const r = await runner.run({ pack, systemPrompt: SYSTEM, input: "ask", schema: cardSchema, tier: "pass" });
  assert.equal(r.client, "local");
  assert.equal(r.attempts, 2);
  assert.equal(r.model, "learner:3b");
  assert.equal(chats[0].format.type, "object");
  assert.equal(chats[0].messages[0].content, SYSTEM);
});

test("Windows shims: codex resolves to its native binary; another npm shim to node plus its script", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shim-"));
  const shim = (target: string) =>
    `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*\r\n`;
  const codexPkg = join(dir, "node_modules", "@openai", "codex");
  await mkdir(join(codexPkg, "bin"), { recursive: true });
  await writeFile(join(codexPkg, "bin", "codex.js"), "");
  const triple = process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  const platformPkg = process.arch === "arm64" ? "codex-win32-arm64" : "codex-win32-x64";
  const exe = join(codexPkg, "node_modules", "@openai", platformPkg, "vendor", triple, "bin", "codex.exe");
  await mkdir(dirname(exe), { recursive: true });
  await writeFile(exe, "");
  await writeFile(join(dir, "codex.cmd"), shim("node_modules\\@openai\\codex\\bin\\codex.js"));
  assert.deepEqual(resolveNpmShim(join(dir, "codex.cmd")), { file: exe, prefixArgs: [] });

  await mkdir(join(dir, "node_modules", "tool", "bin"), { recursive: true });
  await writeFile(join(dir, "node_modules", "tool", "bin", "tool.js"), "");
  await writeFile(join(dir, "node.exe"), "");
  await writeFile(join(dir, "tool.cmd"), shim("node_modules\\tool\\bin\\tool.js"));
  assert.deepEqual(resolveNpmShim(join(dir, "tool.cmd")), {
    file: join(dir, "node.exe"),
    prefixArgs: [join(dir, "node_modules", "tool", "bin", "tool.js")],
  });
  const env = { PATH: dir, USERPROFILE: join(dir, "nohome") };
  assert.deepEqual(resolveCli("codex", { env, platform: "win32" }), { file: exe, prefixArgs: [] });
  assert.equal(resolveCli("absent", { env, platform: "win32" }), null);
});

test("negative: no forbidden flag in any argv builder and no credential path in runner source", async () => {
  const src = join(here, "..", "packages", "runner", "src");
  for (const file of await readdir(src)) {
    const text = await readFile(join(src, file), "utf8");
    for (const flag of forbidden) assert.ok(!text.includes(`"${flag}"`), `${file} passes ${flag}`);
    assert.ok(!/\.credentials|auth\.json|oauth_creds|\.claude[\\/]|\.codex[\\/]|\.gemini[\\/]/.test(text), `${file} references a credential path`);
    assert.ok(!/shell:\s*true/.test(text), `${file} uses a shell`);
  }
});
