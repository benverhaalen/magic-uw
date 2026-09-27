#!/usr/bin/env node
// A stand-in for the `claude` and `codex` CLIs. Makes no network calls and reads no
// credentials. Launched as `node fake-cli.mjs <claude|codex> ...args`.
//
// Environment:
//   FAKE_CLI_LOG        JSONL file; one line per invocation or stream message: {kind, argv, stdin, cwd}
//   FAKE_CLI_STATE      counter file shared by every invocation (responses are consumed in order)
//   FAKE_CLI_RESPONSES  JSON array of response specs; the last one repeats
//                       {output, text, usage, error, exit, stderr, sleepMs, crash, model}
//   FAKE_CLI_AUTH       JSON {stdout, exit} for `claude auth status` / `codex login status`
//                       (FAKE_CLI_AUTH_CLAUDE / FAKE_CLI_AUTH_CODEX override it per CLI)
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [kind, ...args] = process.argv.slice(2);
const env = process.env;

function log(entry) {
  if (env.FAKE_CLI_LOG)
    appendFileSync(env.FAKE_CLI_LOG, `${JSON.stringify({ kind, cwd: process.cwd(), ...entry })}\n`);
}
function nextSpec() {
  const specs = JSON.parse(env.FAKE_CLI_RESPONSES ?? "[{}]");
  let n = 0;
  if (env.FAKE_CLI_STATE && existsSync(env.FAKE_CLI_STATE))
    n = Number(readFileSync(env.FAKE_CLI_STATE, "utf8")) || 0;
  if (env.FAKE_CLI_STATE) writeFileSync(env.FAKE_CLI_STATE, String(n + 1));
  return specs[Math.min(n, specs.length - 1)] ?? {};
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function readAll() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}
function auth() {
  const a = JSON.parse(env[`FAKE_CLI_AUTH_${kind.toUpperCase()}`] ?? env.FAKE_CLI_AUTH ?? '{"stdout":"","exit":1}');
  process.stdout.write(a.stdout);
  process.exit(a.exit ?? 0);
}
function claudeResult(spec) {
  const usage = spec.usage ?? {
    input_tokens: 10,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 90,
    output_tokens: 20,
  };
  if (spec.error)
    return { type: "result", subtype: "success", is_error: true, result: spec.error, usage };
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: spec.text ?? JSON.stringify(spec.output ?? {}),
    ...(spec.text === undefined ? { structured_output: spec.output ?? {} } : {}),
    usage,
    modelUsage: { [spec.model ?? "claude-sonnet-5"]: {} },
  };
}

if (args[0] === "--version") {
  process.stdout.write(kind === "claude" ? "2.1.283 (Claude Code)\n" : "codex-cli 0.156.1\n");
  process.exit(0);
}
if (kind === "claude" && args[0] === "auth" && args[1] === "status") auth();
if (kind === "codex" && args[0] === "login" && args[1] === "status") auth();

if (kind === "claude" && args.includes("--input-format")) {
  // Warm session: one result event per stream-json user message.
  log({ argv: args, stdin: null, event: "spawn" });
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    const content = message.message?.content;
    const text = Array.isArray(content) ? content.map((c) => c.text ?? "").join("") : content;
    log({ argv: args, stdin: text, event: "message" });
    const spec = nextSpec();
    if (spec.sleepMs) await sleep(spec.sleepMs);
    if (spec.crash) process.exit(3);
    process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", model: spec.model ?? "claude-sonnet-5" })}\n`);
    process.stdout.write(`${JSON.stringify({ type: "assistant", message: { content: [] } })}\n`);
    process.stdout.write(`${JSON.stringify(claudeResult(spec))}\n`);
  }
  process.exit(0);
}

const stdin = await readAll();
log({ argv: args, stdin });
const spec = nextSpec();
if (spec.sleepMs) await sleep(spec.sleepMs);
if (spec.stderr) process.stderr.write(spec.stderr);
if (spec.exit && !spec.error) process.exit(spec.exit);

if (kind === "claude") {
  process.stdout.write(JSON.stringify(claudeResult(spec)));
  process.exit(spec.error ? 1 : 0);
}
if (kind === "codex") {
  const out = [{ type: "thread.started", thread_id: "t1" }, { type: "turn.started" }];
  if (spec.error) out.push({ type: "turn.failed", error: { message: spec.error } });
  else {
    out.push({
      type: "item.completed",
      item: { id: "i1", type: "agent_message", text: spec.text ?? JSON.stringify(spec.output ?? {}) },
    });
    out.push({
      type: "turn.completed",
      usage: spec.usage ?? { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 },
    });
  }
  process.stdout.write(out.map((o) => JSON.stringify(o)).join("\n") + "\n");
  process.exit(spec.error ? 1 : 0);
}
process.exit(2);
