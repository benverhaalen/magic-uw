/**
 * Runs the baseline clients as a clean base install would behave, with hard caps.
 *
 * Claude Code (verified on 2.1.283 with zero spend: API base pointed at a closed local port, then
 * the stream's init message read): `--safe-mode` also drops `--mcp-config` servers (mcp_servers: []),
 * so it cannot be used with a browser. This flag set gives the same clean state with the browser:
 * `--setting-sources local` (no user settings, plugins or hooks), `--strict-mcp-config`, `--disable-slash-commands`
 * (no skills), CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 and CLAUDE_CODE_DISABLE_AUTO_MEMORY=1. The init message
 * then listed the built-in tools and agents only, plugins agents-md/telemetry/plugin-authoring (built in),
 * no skills, and the Playwright server connected with its 25 tools.
 *
 * Codex (0.156.1): `--ignore-user-config --ignore-rules --ephemeral`, workspace-write sandbox with
 * network on (so pip works, as Claude's shell has network), approvals never, the same Playwright MCP,
 * and its own browser and desktop-control features off so both clients drive the same signed-in
 * browser. Codex still reads $CODEX_HOME/AGENTS.md (no flag disables it, per the team's instant-mode
 * evidence); `--codex-home` points it at a clean home when the operator prepares one.
 *
 * Both: Playwright MCP's browser_run_code_unsafe is disabled, because Playwright's request context
 * sends requests from Node, not through the read-only proxy.
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ClientId = "claude" | "codex" | "fake";
export interface ClientSpec { client: ClientId; model: string }
export interface McpServerSpec { name: string; command: string; args: string[]; env?: Record<string, string> }
export interface Tokens { input: number; cachedInput: number; cacheCreation: number; output: number }
export interface Attempt {
  exitCode: number | null;
  wallMs: number;
  stoppedBy?: "wall" | "budget" | "tokens";
  /** As the client reports it (Claude Code's total_cost_usd, a client-side estimate). */
  reportedUsd: number | null;
  /** From the price table when the client reports none (Codex; a killed Claude run). */
  estimatedUsd: number | null;
  tokens: Tokens;
  turns: number;
  model: string | null;
  mcpConnected: boolean | null;
  resultSubtype: string | null;
  resultText: string | null;
  structured: unknown;
  stdout: string;
  stderr: string;
}
export interface AgentRun { attempts: Attempt[]; wallMs: number; usd: number | null; usdEstimated: boolean; tokens: Tokens; turns: number }

export interface Prices { [model: string]: { input: number; cachedInput: number; output: number; cacheWrite?: number } | undefined }

export function estimateUsd(model: string | null, tokens: Tokens, prices: Prices): number | null {
  const p = model ? prices[model] : undefined;
  if (!p) return null;
  const fresh = Math.max(0, tokens.input - tokens.cachedInput);
  return (fresh * p.input + tokens.cachedInput * p.cachedInput + tokens.cacheCreation * (p.cacheWrite ?? p.input) + tokens.output * p.output) / 1e6;
}

export const PLAYWRIGHT_DISABLED_TOOLS = ["browser_run_code_unsafe"];

/**
 * The client executable: BENCH_CLAUDE / BENCH_CODEX, else the name on PATH (spawned without a shell,
 * so on Windows it must be an .exe; the npm .cmd shim is skipped by the lookup).
 */
export function clientCommand(client: "claude" | "codex"): string {
  return (client === "claude" ? process.env.BENCH_CLAUDE : process.env.BENCH_CODEX) || client;
}

export function claudeArgs(o: { model: string; budgetUsd: number; mcpConfigPath: string; mcpNames: string[]; jsonSchema?: string }): string[] {
  const allowed = [...o.mcpNames.map((n) => `mcp__${n}`), "Bash(node *)", "Bash(python *)", "Bash(python3 *)", "Bash(py *)", "Bash(pip *)", "Bash(sqlite3 *)"];
  return [
    "-p", "--output-format", "stream-json", "--verbose",
    "--model", o.model,
    "--max-budget-usd", String(o.budgetUsd),
    "--setting-sources", "local",
    "--strict-mcp-config", "--mcp-config", o.mcpConfigPath,
    "--disable-slash-commands",
    "--permission-mode", "acceptEdits", "--permission-prompts", "none",
    "--allowedTools", ...allowed,
    "--disallowedTools", ...PLAYWRIGHT_DISABLED_TOOLS.map((t) => `mcp__playwright__${t}`),
    "--no-session-persistence",
    ...(o.jsonSchema ? ["--json-schema", o.jsonSchema] : []),
  ];
}
export const CLAUDE_ENV = { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" };

const toml = (v: string) => JSON.stringify(v);
export function codexArgs(o: { model: string; cwd: string; mcp: McpServerSpec[]; outputSchemaPath?: string; lastMessagePath?: string }): string[] {
  const mcp = o.mcp.flatMap((s) => [
    "-c", `mcp_servers.${s.name}.command=${toml(s.command)}`,
    "-c", `mcp_servers.${s.name}.args=[${s.args.map(toml).join(",")}]`,
    "-c", `mcp_servers.${s.name}.startup_timeout_sec=90`,
    "-c", `mcp_servers.${s.name}.tool_timeout_sec=180`,
    ...(s.name === "playwright" ? ["-c", `mcp_servers.${s.name}.disabled_tools=[${PLAYWRIGHT_DISABLED_TOOLS.map(toml).join(",")}]`] : []),
  ]);
  return [
    "exec", "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules",
    "-C", o.cwd, "-s", "workspace-write", "-m", o.model,
    "-c", 'approval_policy="never"',
    "-c", "sandbox_workspace_write.network_access=true",
    ...mcp,
    "--disable", "browser_use", "--disable", "browser_use_external", "--disable", "computer_use", "--disable", "in_app_browser",
    ...(o.outputSchemaPath ? ["--output-schema", o.outputSchemaPath] : []),
    ...(o.lastMessagePath ? ["-o", o.lastMessagePath] : []),
    "-",
  ];
}

interface StreamState { tokens: Tokens; turns: number; model: string | null; mcpConnected: boolean | null; reportedUsd: number | null; subtype: string | null; text: string | null; structured: unknown }

/** Folds one stdout line (Claude stream-json or Codex --json) into the running totals. */
export function foldLine(client: ClientId, line: string, s: StreamState): void {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  if (client === "codex") {
    if (event.type === "turn.completed") {
      const u = (event.usage ?? {}) as Record<string, unknown>;
      s.tokens.input += n(u.input_tokens);
      s.tokens.cachedInput += n(u.cached_input_tokens);
      s.tokens.output += n(u.output_tokens);
      s.turns++;
    }
    if (event.type === "item.completed") {
      const item = (event.item ?? {}) as Record<string, unknown>;
      if (item.type === "agent_message" && typeof item.text === "string") s.text = item.text;
      if (item.type === "mcp_tool_call" && s.mcpConnected === null) s.mcpConnected = item.status !== "failed";
    }
    if (event.type === "thread.started" && typeof event.model === "string") s.model = event.model;
    if (event.type === "error" || event.type === "turn.failed") s.subtype = "error";
    return;
  }
  // Claude Code stream-json (the fake agent speaks this too).
  if (event.type === "system" && event.subtype === "init") {
    s.model = typeof event.model === "string" ? event.model : s.model;
    const servers = Array.isArray(event.mcp_servers) ? (event.mcp_servers as Array<{ status?: string }>) : [];
    s.mcpConnected = servers.length > 0 && servers.every((x) => x.status === "connected");
  }
  if (event.type === "assistant") {
    const u = ((event.message as Record<string, unknown> | undefined)?.usage ?? {}) as Record<string, unknown>;
    s.tokens.input += n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens);
    s.tokens.cachedInput += n(u.cache_read_input_tokens);
    s.tokens.cacheCreation += n(u.cache_creation_input_tokens);
    s.tokens.output += n(u.output_tokens);
  }
  if (event.type === "result") {
    s.subtype = typeof event.subtype === "string" ? event.subtype : null;
    s.reportedUsd = typeof event.total_cost_usd === "number" ? event.total_cost_usd : null;
    s.turns = n(event.num_turns);
    s.text = typeof event.result === "string" ? event.result : s.text;
    s.structured = event.structured_output ?? null;
  }
}

export interface RunOptions {
  spec: ClientSpec;
  cwd: string;
  prompt: string;
  mcp: McpServerSpec[];
  budgetUsd: number;
  timeoutMs: number;
  prices: Prices;
  logDir: string;
  label: string;
  jsonSchema?: object;
  env?: Record<string, string>;
  codexHome?: string;
  /** The fake CLI for dry runs: node + the fake agent script. */
  fake?: { command: string; args: string[]; env: Record<string, string> };
}

/** One attempt, with the wall cap enforced here and the budget cap by the client (Claude) or here (Codex). */
export async function runOnce(o: RunOptions, attempt: number, budgetUsd: number, timeoutMs: number): Promise<Attempt> {
  mkdirSync(o.logDir, { recursive: true });
  const stdoutPath = join(o.logDir, `${o.label}.attempt${attempt}.stdout.jsonl`);
  const stderrPath = join(o.logDir, `${o.label}.attempt${attempt}.stderr.txt`);
  let command: string, args: string[];
  const env: Record<string, string | undefined> = { ...process.env, ...o.env };
  if (o.spec.client === "claude") {
    const mcpConfigPath = join(o.logDir, `${o.label}.mcp.json`);
    writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: Object.fromEntries(o.mcp.map((s) => [s.name, { command: s.command, args: s.args, ...(s.env ? { env: s.env } : {}) }])) }, null, 2));
    command = clientCommand("claude");
    args = claudeArgs({ model: o.spec.model, budgetUsd, mcpConfigPath, mcpNames: o.mcp.map((s) => s.name), ...(o.jsonSchema ? { jsonSchema: JSON.stringify(o.jsonSchema) } : {}) });
    Object.assign(env, CLAUDE_ENV);
  } else if (o.spec.client === "codex") {
    let outputSchemaPath: string | undefined;
    if (o.jsonSchema) writeFileSync((outputSchemaPath = join(o.logDir, `${o.label}.schema.json`)), JSON.stringify(o.jsonSchema));
    command = clientCommand("codex");
    args = codexArgs({ model: o.spec.model, cwd: o.cwd, mcp: o.mcp, outputSchemaPath, lastMessagePath: join(o.logDir, `${o.label}.attempt${attempt}.last.json`) });
    if (o.codexHome) env.CODEX_HOME = o.codexHome;
  } else {
    if (!o.fake) throw new Error("fake client without a fake command");
    command = o.fake.command;
    args = o.fake.args;
    Object.assign(env, o.fake.env, { BENCH_FAKE_BUDGET: String(budgetUsd), BENCH_FAKE_SCHEMA: o.jsonSchema ? JSON.stringify(o.jsonSchema) : "" });
  }
  const state: StreamState = { tokens: { input: 0, cachedInput: 0, cacheCreation: 0, output: 0 }, turns: 0, model: null, mcpConnected: null, reportedUsd: null, subtype: null, text: null, structured: null };
  const started = performance.now();
  // No shell: arguments such as "Bash(node *)" must reach the client intact.
  const child = spawn(command, args, { cwd: o.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const out = createWriteStream(stdoutPath), err = createWriteStream(stderrPath);
  let stoppedBy: Attempt["stoppedBy"];
  let buffer = "";
  const client: ClientId = o.spec.client === "codex" ? "codex" : "claude";
  child.stdout.on("data", (chunk: Buffer) => {
    out.write(chunk);
    buffer += chunk.toString("utf8");
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      foldLine(client, buffer.slice(0, nl), state);
      buffer = buffer.slice(nl + 1);
    }
    // Codex has no budget flag: stop it here when the estimate reaches the cap.
    if (o.spec.client === "codex") {
      const usd = estimateUsd(state.model ?? o.spec.model, state.tokens, o.prices);
      if (usd !== null && usd >= budgetUsd && !stoppedBy) {
        stoppedBy = "budget";
        child.kill();
      }
    }
  });
  child.stderr.pipe(err);
  child.stdin.end(o.prompt);
  const timer = setTimeout(() => {
    stoppedBy = "wall";
    child.kill();
  }, timeoutMs);
  const exitCode = await new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  clearTimeout(timer);
  if (buffer.trim()) foldLine(client, buffer, state);
  out.end();
  err.end();
  if (state.subtype === "error_max_budget_usd") stoppedBy = "budget";
  let structured = state.structured;
  const last = join(o.logDir, `${o.label}.attempt${attempt}.last.json`);
  if (o.spec.client === "codex" && existsSync(last)) {
    try {
      structured = JSON.parse(readFileSync(last, "utf8"));
    } catch {}
  }
  return {
    exitCode, wallMs: Math.round(performance.now() - started), stoppedBy,
    reportedUsd: state.reportedUsd,
    estimatedUsd: state.reportedUsd === null ? estimateUsd(state.model ?? o.spec.model, state.tokens, o.prices) : null,
    tokens: state.tokens, turns: state.turns, model: state.model ?? o.spec.model, mcpConnected: state.mcpConnected,
    resultSubtype: state.subtype, resultText: state.text, structured, stdout: stdoutPath, stderr: stderrPath,
  };
}

/**
 * The run with its one retry: when an attempt ends on its own (not at a cap) and `incomplete()`
 * says the work is not done, the same task continues once, within what is left of the caps.
 */
export async function runAgent(o: RunOptions, retry?: { incomplete: () => boolean; prompt: string }): Promise<AgentRun> {
  const started = performance.now();
  const attempts: Attempt[] = [await runOnce(o, 1, o.budgetUsd, o.timeoutMs)];
  const spent = () => attempts.reduce((a, x) => a + (x.reportedUsd ?? x.estimatedUsd ?? 0), 0);
  const first = attempts[0]!;
  if (retry && !first.stoppedBy && retry.incomplete()) {
    const budgetLeft = o.budgetUsd - spent();
    const timeLeft = o.timeoutMs - (performance.now() - started);
    if (budgetLeft > 0.05 && timeLeft > 60_000) attempts.push(await runOnce({ ...o, prompt: retry.prompt }, 2, Math.round(budgetLeft * 100) / 100, timeLeft));
  }
  const tokens = attempts.reduce<Tokens>((t, a) => ({
    input: t.input + a.tokens.input, cachedInput: t.cachedInput + a.tokens.cachedInput, cacheCreation: t.cacheCreation + a.tokens.cacheCreation, output: t.output + a.tokens.output,
  }), { input: 0, cachedInput: 0, cacheCreation: 0, output: 0 });
  const known = attempts.every((a) => a.reportedUsd !== null || a.estimatedUsd !== null);
  return {
    attempts, wallMs: Math.round(performance.now() - started),
    usd: known ? Math.round(spent() * 10000) / 10000 : null,
    usdEstimated: attempts.some((a) => a.reportedUsd === null),
    tokens, turns: attempts.reduce((a, x) => a + x.turns, 0),
  };
}
