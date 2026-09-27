import { RunnerError, type ToolUseEvent } from "./types";

/**
 * owner: client-detection (security, operator 2026-09-27: defence in depth). The model never
 * gets tools inside the app (D5). The flags turn them off; this catches a tool use anyway, from
 * each client's streaming output as it arrives, and stops the run: the whole process tree is
 * killed and the output discarded. A tool call already under way when its event is read may have
 * started before the kill. Only the event kind and the tool's name are kept.
 *
 * Fail-closed: in stream mode every stdout line must be a JSON event. A line that isn't, or a
 * Claude event of an unknown type that carries a message or content, stops the run as
 * `invalid_output`.
 *
 * Event shapes, verified from real runs on this machine (2026-09-27):
 * - Claude Code 2.1.283 `--output-format stream-json --verbose`: `system/init` lists `tools` and
 *   `mcp_servers`; an assistant message carries `tool_use` content blocks; `--json-schema` works
 *   through a built-in `StructuredOutput` tool (init lists it, and it appears as `tool_use`), the
 *   one tool allowed. Other event types seen: `user` (the tool_result), `rate_limit_event`,
 *   `result`.
 * - Codex 0.156.1 `exec --json`: `thread.started`, `turn.started`, `item.started` /
 *   `item.completed` (item types from the binary's enum: agent_message, reasoning,
 *   command_execution, file_change, mcp_tool_call, collab_tool_call, web_search, todo_list),
 *   `turn.completed`, `turn.failed`, `error`. Only agent_message, reasoning and error items pass.
 */

/** Claude Code's own structured-output mechanism for `--json-schema`: not a tool the model can act with. */
export const CLAUDE_ALLOWED_TOOLS = new Set(["StructuredOutput"]);
const CLAUDE_TOOL_BLOCKS = new Set(["tool_use", "server_tool_use", "mcp_tool_use"]);
/** Claude stream-json event types seen or documented; anything else carrying content is refused. */
const CLAUDE_KNOWN_EVENTS = new Set(["system", "assistant", "user", "result", "rate_limit_event", "stream_event", "keep_alive"]);
const CODEX_ALLOWED_ITEMS = new Set(["agent_message", "reasoning", "error"]);

/** A name as recorded: letters, digits and a few separators, at most 64 characters. */
export const toolName = (value: unknown): string =>
  typeof value === "string" ? value.replace(/[^A-Za-z0-9_.:/-]/g, "").slice(0, 64) || "unknown" : "unknown";

type Parsed = { ok: true; event: Record<string, unknown> | null } | { ok: false };
function parse(line: string): Parsed {
  const text = line.trim();
  if (!text) return { ok: true, event: null };
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? { ok: true, event: value as Record<string, unknown> } : { ok: false };
  } catch {
    return { ok: false };
  }
}
const receipt = (event: unknown, tool: unknown): ToolUseEvent => ({ event: toolName(event), tool: toolName(tool) });

/** A tool use in one Claude Code stream-json event, or null. */
function claudeEventToolUse(e: Record<string, unknown>): ToolUseEvent | null {
  if (e.type === "system" && e.subtype === "init") {
    const tools = Array.isArray(e.tools) ? e.tools.filter((t) => !CLAUDE_ALLOWED_TOOLS.has(String(t))) : [];
    if (tools.length) return receipt("tools_enabled", tools[0]);
    const mcp = Array.isArray(e.mcp_servers) ? e.mcp_servers : [];
    if (mcp.length) return receipt("mcp_enabled", (mcp[0] as { name?: unknown })?.name);
    return null;
  }
  const message = e.message as { content?: unknown } | undefined;
  if (Array.isArray(message?.content))
    for (const block of message.content as { type?: unknown; name?: unknown }[]) {
      if (CLAUDE_TOOL_BLOCKS.has(String(block?.type)) && !CLAUDE_ALLOWED_TOOLS.has(String(block?.name)))
        return receipt(block.type, block.name);
    }
  return null;
}

/** A tool use in one line of Claude Code's stream-json output, or null (non-JSON lines: null). */
export function claudeToolUse(line: string): ToolUseEvent | null {
  const p = parse(line);
  return p.ok && p.event ? claudeEventToolUse(p.event) : null;
}

/** The stream check for a Claude run: tool use, a non-JSON line, or an unknown event with content. */
export function claudeStreamCheck(line: string): RunnerError | null {
  const p = parse(line);
  if (!p.ok) return new RunnerError("invalid_output", "a stream line was not a JSON event");
  if (!p.event) return null;
  const blocked = claudeEventToolUse(p.event);
  if (blocked) return toolUseError(blocked);
  const type = String(p.event.type ?? "");
  if (!CLAUDE_KNOWN_EVENTS.has(type) && ("message" in p.event || "content" in p.event || "tool" in p.event))
    return new RunnerError("invalid_output", `unknown stream event ${toolName(type)}`);
  return null;
}

/** A tool use in one Codex `exec --json` event, or null. */
function codexEventToolUse(e: Record<string, unknown>): ToolUseEvent | null {
  const item = e.item as { type?: unknown; server?: unknown; tool?: unknown } | undefined;
  if (!item || typeof item !== "object") return null;
  const kind = String(item.type ?? "");
  if (CODEX_ALLOWED_ITEMS.has(kind)) return null;
  const tool =
    kind === "command_execution" ? "shell"
      : kind === "file_change" ? "apply_patch"
        : kind === "mcp_tool_call" ? `mcp:${toolName(item.server)}/${toolName(item.tool)}`
          : kind || "unknown";
  return receipt(kind || "unknown", tool);
}

/** A tool use in one line of `codex exec --json` output, or null (non-JSON lines: null). */
export function codexToolUse(line: string): ToolUseEvent | null {
  const p = parse(line);
  return p.ok && p.event ? codexEventToolUse(p.event) : null;
}

/** The stream check for a Codex run: any non-message item, or a non-JSON line. */
export function codexStreamCheck(line: string): RunnerError | null {
  const p = parse(line);
  if (!p.ok) return new RunnerError("invalid_output", "a stream line was not a JSON event");
  if (!p.event) return null;
  const blocked = codexEventToolUse(p.event);
  return blocked ? toolUseError(blocked) : null;
}

export const toolUseError = (blocked: ToolUseEvent): RunnerError =>
  new RunnerError("tool_use_blocked", `${blocked.event} ${blocked.tool}`, [], { blocked });

/**
 * The deny-every-tool PreToolUse hook passed with `--settings` (a file in the app's run folder,
 * never the student's config). Exit code 2 blocks the call (code.claude.com hooks reference).
 * Verified live on 2.1.283: it denies without `--safe-mode`, but `--safe-mode` disables it, so in
 * instant mode the flags and the stream check above carry the guarantee.
 */
export const DENY_TOOLS_SETTINGS = `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "exit 2" }] }] } }, null, 2)}\n`;
