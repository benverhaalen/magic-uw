import { RunnerError, type ToolUseEvent } from "./types";

/**
 * owner: client-detection (security, operator 2026-09-27: defence in depth). The model never
 * gets tools inside the app (D5). The flags turn them off; this catches a tool use anyway, from
 * each client's streaming output as it arrives, so the run is killed before the tool finishes
 * and its output is discarded. Only the event kind and the tool's name are kept.
 *
 * Event shapes, verified from real runs on this machine (2026-09-27):
 * - Claude Code 2.1.283 `--output-format stream-json --verbose`: `system/init` lists `tools` and
 *   `mcp_servers`; an assistant message carries `tool_use` content blocks; `--json-schema` works
 *   through a built-in `StructuredOutput` tool (init lists it, and it appears as `tool_use`), the
 *   one tool allowed.
 * - Codex 0.156.1 `exec --json`: `item.started` / `item.completed` events whose `item.type` is
 *   one of agent_message, reasoning, command_execution, file_change, mcp_tool_call,
 *   collab_tool_call, web_search, todo_list (names from the binary's enum; a real run here
 *   produced only agent_message). Only agent_message, reasoning and error are allowed.
 */

/** Claude Code's own structured-output mechanism for `--json-schema`: not a tool the model can act with. */
export const CLAUDE_ALLOWED_TOOLS = new Set(["StructuredOutput"]);
const CLAUDE_TOOL_BLOCKS = new Set(["tool_use", "server_tool_use", "mcp_tool_use"]);
const CODEX_ALLOWED_ITEMS = new Set(["agent_message", "reasoning", "error"]);

/** A tool name as recorded: letters, digits and a few separators, at most 64 characters. */
export const toolName = (value: unknown): string =>
  typeof value === "string" ? value.replace(/[^A-Za-z0-9_.:/-]/g, "").slice(0, 64) || "unknown" : "unknown";

function parse(line: string): Record<string, unknown> | null {
  const text = line.trim();
  if (!text.startsWith("{")) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A tool use in one line of Claude Code's stream-json output, or null. */
export function claudeToolUse(line: string): ToolUseEvent | null {
  const e = parse(line);
  if (!e) return null;
  if (e.type === "system" && e.subtype === "init") {
    const tools = Array.isArray(e.tools) ? e.tools.filter((t) => !CLAUDE_ALLOWED_TOOLS.has(String(t))) : [];
    if (tools.length) return { event: "tools_enabled", tool: toolName(tools[0]) };
    const mcp = Array.isArray(e.mcp_servers) ? e.mcp_servers : [];
    if (mcp.length) return { event: "mcp_enabled", tool: toolName((mcp[0] as { name?: unknown })?.name) };
    return null;
  }
  const message = e.message as { content?: unknown } | undefined;
  if ((e.type === "assistant" || e.type === "user") && Array.isArray(message?.content))
    for (const block of message.content as { type?: unknown; name?: unknown }[]) {
      if (CLAUDE_TOOL_BLOCKS.has(String(block?.type)) && !CLAUDE_ALLOWED_TOOLS.has(String(block?.name)))
        return { event: String(block.type), tool: toolName(block.name) };
    }
  return null;
}

/** A tool use in one line of `codex exec --json` output, or null. */
export function codexToolUse(line: string): ToolUseEvent | null {
  const e = parse(line);
  if (!e || typeof e.type !== "string" || !e.type.startsWith("item.")) return null;
  const item = e.item as { type?: unknown; server?: unknown; tool?: unknown } | undefined;
  const kind = String(item?.type ?? "");
  if (!kind || CODEX_ALLOWED_ITEMS.has(kind)) return null;
  const tool =
    kind === "command_execution" ? "shell"
      : kind === "file_change" ? "apply_patch"
        : kind === "mcp_tool_call" ? `mcp:${toolName(item?.server)}/${toolName(item?.tool)}`
          : kind;
  return { event: kind, tool: toolName(tool) };
}

export const toolUseError = (blocked: ToolUseEvent): RunnerError =>
  new RunnerError("tool_use_blocked", `${blocked.event} ${blocked.tool}`, [], { blocked });

/**
 * The deny-every-tool PreToolUse hook passed with `--settings` (a file in the app's run folder,
 * never the student's config). Exit code 2 blocks the call (code.claude.com hooks reference).
 * Verified live on 2.1.283: it denies without `--safe-mode`, but `--safe-mode` disables it, so in
 * instant mode the flags and the tripwire above carry the guarantee.
 */
export const DENY_TOOLS_SETTINGS = `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "exit 2" }] }] } }, null, 2)}\n`;
