import { z } from "zod";
import {
  RunnerError,
  type BackendCall,
  type BackendResult,
  type ModelBackend,
  type Tier,
  type Usage,
} from "./types";
import { extractJson } from "./util";

export type ApiProvider = "openrouter" | "anthropic" | "openai" | "gemini";

/**
 * Default model IDs per tier (spec E3). Not verified against each provider's live catalogue:
 * onboarding's probe or the settings view overrides them.
 */
export const API_TIER_MODELS: Record<ApiProvider, Record<Tier, string>> = {
  openrouter: { pass: "anthropic/claude-sonnet-5", strong: "anthropic/claude-opus-5.5" },
  anthropic: { pass: "claude-sonnet-5", strong: "claude-opus-5-5" },
  openai: { pass: "gpt-6-sol", strong: "gpt-6-sol" },
  gemini: { pass: "gemini-3.5-flash", strong: "gemini-3.1-pro-preview" },
};

export interface ApiOptions {
  provider: ApiProvider;
  /** The student's own key, supplied by the caller from encrypted storage. Never logged. */
  key: string;
  models?: Partial<Record<Tier, string>>;
  fetcher?: typeof fetch;
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const count = z.number().int().nonnegative().catch(0);

async function readBounded(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new RunnerError("invalid_output", "response too large");
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString("utf8");
}

interface Built {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}
function build(provider: ApiProvider, key: string, model: string, call: BackendCall): Built {
  const maxTokens = call.maxOutputTokens ?? 8000;
  const schemaText = JSON.stringify(call.jsonSchema);
  switch (provider) {
    case "openrouter":
    case "openai":
      return {
        url:
          provider === "openrouter"
            ? "https://openrouter.ai/api/v1/chat/completions"
            : "https://api.openai.com/v1/chat/completions",
        headers: { Authorization: `Bearer ${key}` },
        body: {
          model,
          messages: [
            { role: "system", content: call.systemPrompt },
            { role: "user", content: call.input },
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name: "output", strict: true, schema: call.jsonSchema },
          },
          max_completion_tokens: maxTokens,
          ...(provider === "openai" && call.tier === "strong" ? { reasoning_effort: "high" } : {}),
        },
      };
    case "anthropic":
      return {
        url: "https://api.anthropic.com/v1/messages",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: {
          model,
          max_tokens: maxTokens,
          // The schema is fixed per pack, so it rides in the cached prefix.
          system: [
            {
              type: "text",
              text: `${call.systemPrompt}\n\nReply with one JSON object matching this JSON Schema and nothing else:\n${schemaText}`,
              cache_control: { type: "ephemeral" },
            },
          ],
          messages: [{ role: "user", content: call.input }],
        },
      };
    case "gemini":
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        headers: { "x-goog-api-key": key },
        body: {
          systemInstruction: { parts: [{ text: call.systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: call.input }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseJsonSchema: call.jsonSchema,
            maxOutputTokens: maxTokens,
          },
        },
      };
  }
}

const chatResponse = z.object({
  model: z.string().optional(),
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullable() }) }))
    .min(1),
  usage: z
    .object({
      prompt_tokens: count,
      completion_tokens: count,
      prompt_tokens_details: z.object({ cached_tokens: count }).partial().optional(),
    })
    .partial()
    .optional(),
});
const anthropicResponse = z.object({
  model: z.string().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  usage: z
    .object({
      input_tokens: count,
      output_tokens: count,
      cache_creation_input_tokens: count.optional(),
      cache_read_input_tokens: count.optional(),
    })
    .partial()
    .optional(),
});
const geminiResponse = z.object({
  modelVersion: z.string().optional(),
  candidates: z
    .array(
      z.object({
        content: z.object({ parts: z.array(z.object({ text: z.string().optional() })) }),
      }),
    )
    .min(1),
  usageMetadata: z
    .object({
      promptTokenCount: count,
      cachedContentTokenCount: count,
      candidatesTokenCount: count,
    })
    .partial()
    .optional(),
});

function must<S extends z.ZodType>(schema: S, raw: unknown, provider: string): z.infer<S> {
  const r = schema.safeParse(raw);
  if (!r.success) throw new RunnerError("invalid_output", `${provider} reply had an unexpected shape`);
  return r.data;
}

function parse(provider: ApiProvider, model: string, raw: unknown): BackendResult {
  let text: string;
  let usage: Usage;
  let served = model;
  if (provider === "anthropic") {
    const r = must(anthropicResponse, raw, provider);
    text = r.content.map((c) => c.text ?? "").join("");
    const u = r.usage ?? {};
    const read = u.cache_read_input_tokens ?? 0;
    usage = {
      in: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + read,
      cached: read,
      out: u.output_tokens ?? 0,
    };
    served = r.model ?? model;
  } else if (provider === "gemini") {
    const r = must(geminiResponse, raw, provider);
    text = r.candidates[0].content.parts.map((p) => p.text ?? "").join("");
    const u = r.usageMetadata ?? {};
    usage = {
      in: u.promptTokenCount ?? 0,
      cached: u.cachedContentTokenCount ?? 0,
      out: u.candidatesTokenCount ?? 0,
    };
    served = r.modelVersion ?? model;
  } else {
    const r = must(chatResponse, raw, provider);
    text = r.choices[0].message.content ?? "";
    const u = r.usage ?? {};
    usage = {
      in: u.prompt_tokens ?? 0,
      cached: u.prompt_tokens_details?.cached_tokens ?? 0,
      out: u.completion_tokens ?? 0,
    };
    served = r.model ?? model;
  }
  const value = extractJson(text);
  if (value === null) throw new RunnerError("invalid_output", `${provider} reply was not JSON`);
  return { value, usage, model: served };
}

/** Direct HTTPS with the student's own key (D36's stored-key route). No redirects, no cookies. */
export function createApiBackend(options: ApiOptions): ModelBackend {
  const fetcher = options.fetcher ?? fetch;
  const models = { ...API_TIER_MODELS[options.provider], ...options.models };
  if (!options.key) throw new RunnerError("not_signed_in", "no key");
  return {
    client: options.provider,
    async call(call: BackendCall): Promise<BackendResult> {
      const model = models[call.tier];
      const built = build(options.provider, options.key, model, call);
      const timeout = AbortSignal.timeout(call.timeoutMs);
      const signal = call.signal ? AbortSignal.any([call.signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await fetcher(built.url, {
          method: "POST",
          redirect: "error",
          credentials: "omit",
          headers: { "Content-Type": "application/json", Accept: "application/json", ...built.headers },
          body: JSON.stringify(built.body),
          signal,
        });
      } catch {
        if (call.signal?.aborted) throw new RunnerError("aborted");
        if (timeout.aborted) throw new RunnerError("timeout");
        throw new RunnerError("unavailable", `${options.provider} unreachable`);
      }
      if (response.status === 429) throw new RunnerError("usage_limit", `${options.provider} 429`);
      if (response.status === 401 || response.status === 403)
        throw new RunnerError("not_signed_in", `${options.provider} ${response.status}`);
      if (!response.ok) throw new RunnerError("unavailable", `${options.provider} ${response.status}`);
      const body = await readBounded(response);
      let raw: unknown;
      try {
        raw = JSON.parse(body);
      } catch {
        throw new RunnerError("invalid_output", `${options.provider} body was not JSON`);
      }
      return parse(options.provider, model, raw);
    },
  };
}
