import { join } from "node:path";
import { z } from "zod";
import { cliEnvironment, runProcess, type CliCommand } from "./process";
import {
  RunnerError,
  type BackendCall,
  type BackendResult,
  type ModelBackend,
  type Tier,
} from "./types";
import { contentFile, extractJson, failure } from "./util";

export interface CodexTierModel {
  /** Omitted: the CLI's built-in default, which the student's plan serves by construction. */
  model?: string;
  /** Passed as `-c model_reasoning_effort="…"` (key inferred from Codex docs; P9 confirms). */
  effort?: "low" | "medium" | "high";
}
export const CODEX_TIER_MODELS: Record<Tier, CodexTierModel> = {
  pass: {},
  strong: { effort: "high" },
};

export interface CodexOptions {
  command: CliCommand;
  workDir: string;
  models?: Partial<Record<Tier, CodexTierModel>>;
  env?: Record<string, string>;
  /** owner: client-health. Appended after the spec argv (instant mode's overrides, D50). */
  extraArgs?: readonly string[];
}

/**
 * Spec E2 argv: read-only sandbox, ephemeral, user config ignored, prompt from stdin ("-").
 * `--skip-git-repo-check` (added 2026-09-27): Codex 0.156.1 refuses any folder outside a git
 * repository ("Not inside a trusted directory and --skip-git-repo-check was not specified."), and
 * the app's work folders never are one, so without it every Codex run failed.
 * Never --dangerously-bypass-approvals-and-sandbox or --full-auto.
 */
export function codexArgs(o: { schemaPath: string } & CodexTierModel): string[] {
  const args = [
    "exec",
    "-",
    "--json",
    "--output-schema",
    o.schemaPath,
    "--ephemeral",
    "-s",
    "read-only",
    "--ignore-user-config",
    "--skip-git-repo-check",
  ];
  if (o.model) args.push("-m", o.model);
  if (o.effort) args.push("-c", `model_reasoning_effort="${o.effort}"`);
  return args;
}

/**
 * Codex has no system-prompt flag that keeps text out of argv, so the prefix leads stdin.
 * It is byte-identical per pack and course, which is what provider prefix caching keys on.
 */
export function codexStdin(systemPrompt: string, input: string): string {
  return `${systemPrompt}\n\n---\n\n${input}`;
}

const count = z.number().int().nonnegative().catch(0);
const event = z
  .object({
    type: z.string(),
    item: z.object({ type: z.string(), text: z.string().optional() }).passthrough().optional(),
    usage: z
      .object({ input_tokens: count, cached_input_tokens: count.optional(), output_tokens: count })
      .partial()
      .optional(),
    error: z.object({ message: z.string().optional() }).passthrough().optional(),
    message: z.string().optional(),
  })
  .passthrough();

/** Reads `codex exec --json` JSONL: the last agent message and the turn's usage. */
export function parseCodexEvents(stdout: string, model: string): BackendResult {
  let text: string | null = null;
  let usage = { in: 0, cached: 0, out: 0 };
  const failures: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const e = event.safeParse(raw);
    if (!e.success) continue;
    const ev = e.data;
    if (ev.type === "item.completed" && ev.item?.type === "agent_message" && ev.item.text !== undefined)
      text = ev.item.text;
    else if (ev.type === "turn.completed" && ev.usage)
      usage = {
        in: usage.in + (ev.usage.input_tokens ?? 0),
        cached: usage.cached + (ev.usage.cached_input_tokens ?? 0),
        out: usage.out + (ev.usage.output_tokens ?? 0),
      };
    else if (ev.type === "turn.failed" || ev.type === "error")
      failures.push(ev.error?.message ?? ev.message ?? ev.type);
  }
  if (text === null) {
    if (failures.length) throw failure(failures.join(" "), "codex turn failed");
    throw new RunnerError("invalid_output", "codex returned no message");
  }
  const value = extractJson(text);
  if (value === null) throw new RunnerError("invalid_output", "codex message was not JSON");
  return { value, usage, model: model || "codex-default" };
}

export function createCodexBackend(options: CodexOptions): ModelBackend {
  const models = { ...CODEX_TIER_MODELS, ...options.models };
  return {
    client: "codex",
    async call(call: BackendCall): Promise<BackendResult> {
      const tier = models[call.tier];
      const schemaPath = await contentFile(
        join(options.workDir, "schema"),
        JSON.stringify(call.jsonSchema),
        ".json",
      );
      const run = await runProcess(options.command, [...codexArgs({ schemaPath, ...tier }), ...(options.extraArgs ?? [])], {
        stdin: codexStdin(call.systemPrompt, call.input),
        cwd: options.workDir,
        env: cliEnvironment(options.env),
        timeoutMs: call.timeoutMs,
        signal: call.signal,
      });
      try {
        return parseCodexEvents(run.stdout, tier.model ?? "");
      } catch (error) {
        if (run.code !== 0 && error instanceof RunnerError && error.kind === "invalid_output")
          throw failure(`${run.stderr}\nexit ${run.code}`, `codex exited ${run.code}`);
        throw error;
      }
    },
  };
}
