import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { claudeResultSchema, claudeUsageOf } from "./claude";
import { cliEnvironment, killTree, type CliCommand } from "./process";
import { RunnerError, type Usage } from "./types";
import { contentFile, failure } from "./util";
import { toolName, toolUseError } from "./tripwire";

/**
 * The in-app chat's one persistent Claude Code session (decisions.md, 2026-09-27). Unlike the pack
 * pool (tools off, one schema-checked JSON answer), this session keeps its conversation across
 * questions, streams its text as it arrives, and may call exactly the app's own read tools, served by
 * the worker over one `--mcp-config` server. Built-in tools are off (`--tools ""`), no other MCP
 * server loads (`--strict-mcp-config`), only the listed tools are pre-approved and everything else is
 * refused without a prompt (`--permission-mode dontAsk`). The stream check below is the second
 * guard: any other tool, or an extra MCP server, kills the session and fails the question.
 * `--safe-mode` is never passed here: verified live on 2.1.283 (2026-09-27), it also drops the
 * `--mcp-config` server, so the session saw no tools; `--setting-sources project,local` in the
 * app-owned folder keeps the student's own settings, hooks and plugins out instead.
 */
export const CHAT_MODEL = "claude-opus-5-5";

export interface ChatSessionOptions {
  command: CliCommand;
  workDir: string;
  env?: Record<string, string>;
  model?: string;
  systemPrompt: string;
  /** The `--mcp-config` JSON: the app's one server. */
  mcpConfig: string;
  /** The full tool names (`mcp__<server>__<tool>`) the session may call. */
  allowedTools: readonly string[];
  /** The server name the config defines; any other server in `init` stops the session. */
  serverName: string;
  /** Extra argv from the client-health gate; `--safe-mode` is dropped (see above). */
  extraArgs?: readonly string[];
}

export interface ChatTurn {
  text: string;
  /** The tools called this turn, in order (names only). */
  tools: string[];
  usage: Usage;
  ms: number;
  /** The session answered this turn after earlier ones (the conversation was kept). */
  turn: number;
  sessionPid: number | null;
}

export interface ChatAsk {
  text: string;
  onText?(chunk: string): void;
  onTool?(name: string): void;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ChatSession {
  ask(request: ChatAsk): Promise<ChatTurn>;
  /** Starts the CLI now (0 tokens) so the first question skips its start-up. */
  warm(): Promise<void>;
  alive(): boolean;
  pid(): number | null;
  close(): Promise<void>;
}

export function chatSessionArgs(o: { prefixPath: string; model: string; mcpConfig: string; allowedTools: readonly string[] }): string[] {
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--tools",
    "",
    "--mcp-config",
    o.mcpConfig,
    "--strict-mcp-config",
    "--allowedTools",
    o.allowedTools.join(","),
    "--permission-mode",
    "dontAsk",
    "--setting-sources",
    "project,local",
    "--no-session-persistence",
    "--system-prompt-file",
    o.prefixPath,
    "--model",
    o.model,
  ];
}

const KNOWN = new Set(["system", "assistant", "user", "result", "rate_limit_event", "stream_event", "keep_alive"]);
const TOOL_BLOCKS = new Set(["tool_use", "server_tool_use", "mcp_tool_use"]);

/**
 * The chat's stream check: a non-JSON line, an unknown event with content, a tool outside the
 * allowlist, or an MCP server other than the app's stops the session. Returns the allowed tool
 * names an assistant event used, so the caller can record them.
 */
export function chatStreamCheck(
  line: string,
  allowed: ReadonlySet<string>,
  serverName: string,
): { stop: RunnerError } | { tools: string[]; event: Record<string, unknown> | null } {
  const text = line.trim();
  if (!text) return { tools: [], event: null };
  let e: Record<string, unknown>;
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    e = v as Record<string, unknown>;
  } catch {
    return { stop: new RunnerError("invalid_output", "a stream line was not a JSON event") };
  }
  const type = String(e.type ?? "");
  if (type === "system" && e.subtype === "init") {
    const tools = Array.isArray(e.tools) ? e.tools.map(String) : [];
    const extra = tools.find((t) => !allowed.has(t));
    if (extra) return { stop: toolUseError({ event: "tools_enabled", tool: toolName(extra) }) };
    const servers = Array.isArray(e.mcp_servers) ? (e.mcp_servers as { name?: unknown }[]) : [];
    const other = servers.find((s) => s?.name !== serverName);
    if (other) return { stop: toolUseError({ event: "mcp_enabled", tool: toolName(other?.name) }) };
    return { tools: [], event: e };
  }
  if (!KNOWN.has(type) && ("message" in e || "content" in e || "tool" in e))
    return { stop: new RunnerError("invalid_output", `unknown stream event ${toolName(type)}`) };
  const used: string[] = [];
  const message = e.message as { content?: unknown } | undefined;
  if (type === "assistant" && Array.isArray(message?.content))
    for (const block of message.content as { type?: unknown; name?: unknown }[]) {
      if (!TOOL_BLOCKS.has(String(block?.type))) continue;
      const name = String(block?.name ?? "");
      if (!allowed.has(name)) return { stop: toolUseError({ event: String(block.type), tool: toolName(name) }) };
      used.push(name);
    }
  return { tools: used, event: e };
}

export function createChatSession(options: ChatSessionOptions): ChatSession {
  const model = options.model ?? CHAT_MODEL;
  const allowed = new Set(options.allowedTools);
  const extra = (options.extraArgs ?? []).filter((a) => a !== "--safe-mode");
  let child: ChildProcess | null = null;
  let turns = 0;
  let queue: Promise<unknown> = Promise.resolve();
  let buffer = "";
  let stopped: RunnerError | null = null;
  let current: {
    onLine(event: Record<string, unknown>, tools: string[]): void;
    fail(error: RunnerError): void;
  } | null = null;

  async function start(): Promise<ChildProcess> {
    if (child && child.exitCode === null && child.signalCode === null) return child;
    const prefixPath = await contentFile(join(options.workDir, "chat-prefix"), options.systemPrompt, ".md");
    const args = [...chatSessionArgs({ prefixPath, model, mcpConfig: options.mcpConfig, allowedTools: options.allowedTools }), ...extra];
    turns = 0;
    buffer = "";
    stopped = null;
    const spawned = spawn(options.command.file, [...options.command.prefixArgs, ...args], {
      cwd: options.workDir,
      env: cliEnvironment(options.env),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    child = spawned;
    spawned.stdout!.setEncoding("utf8");
    spawned.stdout!.on("data", (chunk: string) => read(spawned, chunk));
    // Drained and discarded: stderr can carry local paths or configuration.
    spawned.stderr!.on("data", () => undefined);
    spawned.stdin!.on("error", () => undefined);
    const exited = () => {
      if (child === spawned) child = null;
      current?.fail(stopped ?? new RunnerError("process_failed", "chat session ended"));
    };
    spawned.on("error", exited);
    spawned.on("exit", exited);
    return spawned;
  }

  function read(owner: ChildProcess, chunk: string) {
    if (owner !== child) return;
    buffer += chunk;
    if (buffer.length > 8 * 1024 * 1024) {
      kill();
      return;
    }
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const checked = chatStreamCheck(line, allowed, options.serverName);
      if ("stop" in checked) {
        stopped = checked.stop;
        const c = current;
        kill();
        c?.fail(checked.stop);
        return;
      }
      if (checked.event) current?.onLine(checked.event, checked.tools);
    }
  }

  function kill() {
    const c = child;
    child = null;
    if (c) killTree(c);
  }

  function run(request: ChatAsk): Promise<ChatTurn> {
    return new Promise<ChatTurn>((resolve, reject) => {
      const started = Date.now();
      const tools: string[] = [];
      let streamed = "";
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
        current = null;
        fn();
      };
      // A timed-out or cancelled turn leaves the conversation mid-answer: the session is ended, and
      // the next question starts a new one.
      const fail = (error: RunnerError) => done(() => reject(error));
      const onAbort = () => {
        kill();
        fail(new RunnerError("aborted"));
      };
      const timer = setTimeout(() => {
        kill();
        fail(new RunnerError("timeout"));
      }, request.timeoutMs ?? 240_000);
      if (request.signal?.aborted) return onAbort();
      request.signal?.addEventListener("abort", onAbort, { once: true });
      current = {
        fail,
        onLine(event, used) {
          for (const t of used) {
            tools.push(t);
            request.onTool?.(t);
          }
          if (event.type === "stream_event") {
            const inner = event.event as { type?: unknown; delta?: { type?: unknown; text?: unknown } } | undefined;
            if (inner?.type === "content_block_delta" && inner.delta?.type === "text_delta" && typeof inner.delta.text === "string") {
              streamed += inner.delta.text;
              request.onText?.(inner.delta.text);
            }
            return;
          }
          if (event.type !== "result") return;
          const parsed = claudeResultSchema.safeParse(event);
          if (!parsed.success) return fail(new RunnerError("invalid_output", "chat result"));
          const r = parsed.data;
          if (r.is_error || (r.subtype && r.subtype !== "success")) {
            kill();
            return fail(failure(`${r.subtype ?? ""} ${r.result ?? ""}`, "claude reported an error"));
          }
          turns++;
          const text = typeof r.result === "string" && r.result ? r.result : streamed;
          done(() =>
            resolve({ text, tools, usage: claudeUsageOf(r), ms: Date.now() - started, turn: turns, sessionPid: child?.pid ?? null }),
          );
        },
      };
      start()
        .then((c) => {
          if (settled) return;
          c.stdin!.write(`${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: request.text }] } })}\n`);
        })
        .catch(() => fail(new RunnerError("process_failed", "chat session did not start")));
    });
  }

  return {
    ask(request) {
      // One question at a time; the conversation is the session's own.
      const result = queue.then(() => run(request));
      queue = result.catch(() => undefined);
      return result;
    },
    async warm() {
      await start();
    },
    alive: () => !!child && child.exitCode === null,
    pid: () => child?.pid ?? null,
    /** Ends the session's process tree; resolves once it has exited (at most 5 s). */
    close() {
      const c = child;
      kill();
      if (!c || c.exitCode !== null || c.signalCode !== null) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        c.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}
