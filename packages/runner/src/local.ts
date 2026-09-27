import { z } from "zod";
import {
  createLocalAi,
  OLLAMA_LOCAL_ORIGIN,
  type LocalCommandRunner,
} from "../../ai/src/local";
import {
  RunnerError,
  type BackendCall,
  type BackendResult,
  type ModelBackend,
} from "./types";
import { estimateTokens, extractJson } from "./util";

/** The verified selection is fitted for a 4k context (packages/ai/src/local.ts). */
const LOCAL_CONTEXT_TOKENS = 4096;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface LocalOptions {
  fetcher?: typeof fetch;
  /** llmfit runner, as in packages/ai; tests inject a fake. */
  run?: LocalCommandRunner;
}

const chatAnswer = z.object({
  model: z.string().min(1).max(200),
  message: z.object({
    role: z.literal("assistant"),
    content: z.string().min(1).max(64_000),
    tool_calls: z.array(z.unknown()).max(0).optional(),
  }),
  done: z.literal(true),
  done_reason: z.string().optional(),
  prompt_eval_count: z.number().int().nonnegative().optional(),
  eval_count: z.number().int().nonnegative().optional(),
  remote_host: z.string().optional(),
  remote_model: z.string().optional(),
});
const normalize = (name: string) => (name.includes(":") ? name : `${name}:latest`);

/**
 * Ollama on this device (spec E3b; D40: an opt-in setting, or the fallback when no client is
 * found). Model choice and the cloud-disabled and weight checks are packages/ai's own
 * `status()`; this adapter adds a schema-constrained chat. One model serves both tiers.
 */
export function createLocalBackend(options: LocalOptions = {}): ModelBackend {
  const fetcher = options.fetcher ?? fetch;
  const local = createLocalAi({ fetcher, run: options.run });
  return {
    client: "local",
    async call(call: BackendCall): Promise<BackendResult> {
      if (estimateTokens(call.systemPrompt + call.input) + (call.maxOutputTokens ?? 800) > LOCAL_CONTEXT_TOKENS)
        throw new RunnerError("too_large", "exceeds the local model's context");
      const status = await local.status(call.signal);
      if (status.status !== "ready" || !status.selected)
        throw new RunnerError("unavailable", "local model not ready");
      const model = status.selected.name;
      const timeout = AbortSignal.timeout(call.timeoutMs);
      const signal = call.signal ? AbortSignal.any([call.signal, timeout]) : timeout;
      let text: string;
      try {
        const response = await fetcher(`${OLLAMA_LOCAL_ORIGIN}/api/chat`, {
          method: "POST",
          redirect: "error",
          credentials: "omit",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            stream: false,
            keep_alive: "1m",
            truncate: false,
            format: call.jsonSchema,
            options: {
              num_ctx: LOCAL_CONTEXT_TOKENS,
              num_predict: call.maxOutputTokens ?? 800,
              temperature: 0,
            },
            messages: [
              { role: "system", content: call.systemPrompt },
              { role: "user", content: call.input },
            ],
          }),
          signal,
        });
        if (!response.ok || !response.body) throw new RunnerError("unavailable", "local chat failed");
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > MAX_RESPONSE_BYTES)
          throw new RunnerError("invalid_output", "local response too large");
        text = Buffer.from(buffer).toString("utf8");
      } catch (error) {
        if (error instanceof RunnerError) throw error;
        if (call.signal?.aborted) throw new RunnerError("aborted");
        if (timeout.aborted) throw new RunnerError("timeout");
        throw new RunnerError("unavailable", "local chat failed");
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new RunnerError("invalid_output", "local body was not JSON");
      }
      const answer = chatAnswer.safeParse(raw);
      if (!answer.success) throw new RunnerError("invalid_output", "local reply had an unexpected shape");
      const a = answer.data;
      if (a.remote_host || a.remote_model || normalize(a.model) !== normalize(model))
        throw new RunnerError("invalid_output", "local reply could not be verified as local");
      if (a.done_reason === "length") throw new RunnerError("invalid_output", "local reply was cut off");
      const value = extractJson(a.message.content);
      if (value === null) throw new RunnerError("invalid_output", "local reply was not JSON");
      return {
        value,
        usage: { in: a.prompt_eval_count ?? 0, cached: 0, out: a.eval_count ?? 0 },
        model,
      };
    },
  };
}
