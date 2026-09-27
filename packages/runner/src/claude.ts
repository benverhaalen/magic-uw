import { join } from "node:path";
import { z } from "zod";
import { cliEnvironment, runProcess, type CliCommand } from "./process";
import {
  RunnerError,
  type BackendCall,
  type BackendResult,
  type ModelBackend,
  type Tier,
  type Usage,
} from "./types";
import { contentFile, extractJson, failure } from "./util";
import { DENY_TOOLS_SETTINGS, claudeStreamCheck } from "./tripwire"; // owner: client-detection

/** Aliases resolve to the latest model of each family on the student's plan (`claude --help`). */
export const CLAUDE_TIER_MODELS: Record<Tier, string> = { pass: "sonnet", strong: "opus" };
/** Windows caps a command line at 32,767 characters; the inline schema must leave room. */
const MAX_INLINE_SCHEMA = 20_000;

export interface ClaudeOptions {
  command: CliCommand;
  /** App-owned working folder; project and local settings resolve here, never the student's. */
  workDir: string;
  models?: Partial<Record<Tier, string>>;
  /** For a key route only (D36): passed to the spawned process, never written anywhere. */
  env?: Record<string, string>;
  /** owner: client-health. Appended after the spec argv (instant mode's `--safe-mode`, D50). */
  extraArgs?: readonly string[];
}

/**
 * Spec E2 argv. Tools off, no MCP, no user settings, no saved session, our system prompt.
 * `--json-schema` takes the schema itself (claude --help, 2.1.283: "--json-schema <schema>").
 * Never --dangerously-skip-permissions or --bare (bare mode skips the subscription login).
 */
export function claudeOneShotArgs(o: {
  schemaJson: string;
  prefixPath: string;
  model: string;
  /** owner: client-detection: the deny-every-tool PreToolUse hook (tripwire.ts), a file in the run folder. */
  settingsPath?: string;
}): string[] {
  return [
    "-p",
    // owner: client-detection (security): streamed, so the tripwire sees a tool use as it starts.
    "--output-format",
    "stream-json",
    "--verbose",
    ...(o.settingsPath ? ["--settings", o.settingsPath] : []),
    "--json-schema",
    o.schemaJson,
    "--tools",
    "",
    "--strict-mcp-config",
    "--setting-sources",
    "project,local",
    "--no-session-persistence",
    "--system-prompt-file",
    o.prefixPath,
    "--model",
    o.model,
  ];
}

const count = z.number().int().nonnegative().catch(0);
const claudeUsage = z
  .object({
    input_tokens: count,
    cache_creation_input_tokens: count.optional(),
    cache_read_input_tokens: count.optional(),
    output_tokens: count,
  })
  .partial()
  .catch({});
/** The `result` event (one-shot JSON output, or the last line of a stream-json turn). */
export const claudeResultSchema = z
  .object({
    type: z.literal("result"),
    subtype: z.string().optional(),
    is_error: z.boolean().optional(),
    result: z.string().optional(),
    structured_output: z.unknown().optional(),
    usage: claudeUsage.optional(),
    modelUsage: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type ClaudeResult = z.infer<typeof claudeResultSchema>;

export function claudeUsageOf(result: ClaudeResult): Usage {
  const u = result.usage ?? {};
  const read = u.cache_read_input_tokens ?? 0;
  return {
    in: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + read,
    cached: read,
    out: u.output_tokens ?? 0,
  };
}

/** Turns a result event into a backend result, or the right error kind. */
export function claudeOutcome(result: ClaudeResult, requestedModel: string): BackendResult {
  if (result.is_error || (result.subtype && result.subtype !== "success"))
    throw failure(`${result.subtype ?? ""} ${result.result ?? ""}`, "claude reported an error");
  const value =
    result.structured_output !== undefined
      ? result.structured_output
      : extractJson(result.result ?? "");
  if (value === null || value === undefined)
    throw new RunnerError("invalid_output", "claude returned no structured output");
  const model = Object.keys(result.modelUsage ?? {})[0] ?? requestedModel;
  return { value, usage: claudeUsageOf(result), model };
}

export function parseClaudeJson(stdout: string): ClaudeResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    // owner: client-detection: stream-json is one event per line; the result event is the last.
    parsed = stdout
      .split(/\r?\n/)
      .map((line) => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          return null;
        }
      })
      .filter((v) => v !== null);
  }
  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  for (const c of candidates.reverse()) {
    const r = claudeResultSchema.safeParse(c);
    if (r.success) return r.data;
  }
  return null;
}

export async function prefixFile(workDir: string, systemPrompt: string): Promise<string> {
  return contentFile(join(workDir, "prefix"), systemPrompt, ".md");
}
export function inlineSchema(jsonSchema: Record<string, unknown>): string {
  const text = JSON.stringify(jsonSchema);
  if (text.length > MAX_INLINE_SCHEMA)
    throw new RunnerError("too_large", "schema too large for a command line");
  return text;
}

export function createClaudeBackend(options: ClaudeOptions): ModelBackend {
  const models = { ...CLAUDE_TIER_MODELS, ...options.models };
  return {
    client: "claude",
    async call(call: BackendCall): Promise<BackendResult> {
      const model = models[call.tier];
      const prefixPath = await prefixFile(options.workDir, call.systemPrompt);
      const settingsPath = await contentFile(join(options.workDir, "settings"), DENY_TOOLS_SETTINGS, ".json"); // owner: client-detection
      const args = [
        ...claudeOneShotArgs({ schemaJson: inlineSchema(call.jsonSchema), prefixPath, model, settingsPath }),
        ...(options.extraArgs ?? []),
      ];
      const run = await runProcess(options.command, args, {
        stdin: call.input,
        cwd: options.workDir,
        env: cliEnvironment(options.env),
        timeoutMs: call.timeoutMs,
        signal: call.signal,
        // owner: client-detection (security): any tool use kills the run and discards its output.
        onStdoutLine: claudeStreamCheck,
      });
      const result = parseClaudeJson(run.stdout);
      if (!result) {
        if (run.code !== 0) throw failure(`${run.stderr}\nexit ${run.code}`, `claude exited ${run.code}`);
        throw new RunnerError("invalid_output", "claude output was not a result");
      }
      return claudeOutcome(result, model);
    },
  };
}
