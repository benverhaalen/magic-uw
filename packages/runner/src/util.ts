import { createHash } from "node:crypto";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { RunnerError, type AskContext, type RunnerErrorKind, type Usage } from "./types";

export const zeroUsage = (): Usage => ({ in: 0, cached: 0, out: 0 });
export const addUsage = (a: Usage, b: Usage): Usage => ({
  in: a.in + b.in,
  cached: a.cached + b.cached,
  out: a.out + b.out,
});
/** A deliberately rough estimate used only to refuse oversized asks before sending. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
export const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

/** JSON Schema for the provider; code still validates with the zod schema itself. */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-7", io: "output" }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  return json;
}

export function issuesOf(error: z.ZodError): string[] {
  return error.issues
    .slice(0, 12)
    .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`);
}

/**
 * Content-addressed file in the app-owned folder: the same bytes always get the same path,
 * so a prefix file is byte-identical across calls and sessions.
 */
export async function contentFile(
  dir: string,
  text: string,
  extension: string,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${sha256(text).slice(0, 32)}${extension}`);
  try {
    await stat(path);
  } catch {
    await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
  }
  return path;
}

/** First JSON value in text, tolerating a fenced block; null when none parses. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const body = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(body);
  } catch {
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start >= 0 && end > start)
      try {
        return JSON.parse(body.slice(start, end + 1));
      } catch {
        return null;
      }
    return null;
  }
}

/**
 * Maps a provider's error text to a kind without ever copying the text into our messages.
 * owner: client-health (D50). Ordered: the first match wins, so a busy server is never a usage
 * limit, and a model or plan refusal is never a generic failure. The strings each rule was
 * written against, observed or found in the installed binaries, are listed in
 * apps/desktop/src/clients/health.ts (`HEALTH_EVIDENCE`).
 */
export function classifyFailure(text: string): RunnerErrorKind {
  // owner: client-detection. macOS Keychain refusal (errSecInteractionNotAllowed; the CLIs' exit 36
  // on macOS, which the backends append as "exit 36").
  if (/errSecInteractionNotAllowed|user interaction is not allowed/i.test(text) || (process.platform === "darwin" && /\bexit 36\b/.test(text)))
    return "keychain_locked";
  if (/not your usage limit|overloaded|temporarily limiting requests|experiencing high demand/i.test(text))
    return "unavailable";
  if (/workspace routing discovery failed|error sending request|stream disconnected|connection error|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|getaddrinfo|network is unreachable|fetch failed/i.test(text))
    return "offline";
  if (/not logged in|log ?in required|please (?:run )?\/?login|invalid api key|authentication|unauthori[sz]ed|\b401\b|sign in|missing bearer|(?:oauth )?token (?:has )?expired|login expired/i.test(text))
    return "not_signed_in";
  if (/issue with the selected model|may not exist or you may not have access|model is not supported|model_not_found|unrecognized_model|is not available with the claude \w+ plan/i.test(text))
    return "model_unavailable";
  if (/upgrade to plus|credit balance is too low|seat type doesn't include|claude code (?:may not be|is not) enabled for your organi[sz]ation|not available on (?:the|your) free plan|requires a (?:pro|max|paid) (?:plan|subscription)/i.test(text))
    return "plan_insufficient";
  if (/usage limit|rate[ _-]?limit|limit reached|hit your (?:[\w-]+ )?limit|out of (?:extra )?usage|out of credits|spend cap|quota|usage_limit_reached|too many requests|\b429\b/i.test(text))
    return "usage_limit";
  return "process_failed";
}

/**
 * owner: client-health. The reset time a usage-limit message states, kept as the client wrote
 * it (at most 48 printable characters), or an ISO time for the legacy `…|<epoch seconds>` form.
 */
export function statedReset(text: string): string | undefined {
  const epoch = /usage limit reached\|(\d{9,11})\b/i.exec(text);
  if (epoch) return new Date(Number(epoch[1]) * 1000).toISOString();
  const stated = /\bresets?\s+(?:at\s+|in\s+|on\s+)?([0-9][^·|"\n\r]{0,47})/i.exec(text) ?? /\btry again (?:at|in)\s+([^."\n\r]{1,48})/i.exec(text);
  const value = stated?.[1].replace(/[^\x20-\x7e]/g, "").replace(/[\s.,;:]+$/, "").trim();
  return value ? value.slice(0, 48) : undefined;
}
export const failure = (text: string, detail: string) => {
  const kind = classifyFailure(text);
  return new RunnerError(kind, detail, [], kind === "usage_limit" ? { resetsAt: statedReset(text) } : {});
};

function headerValue(value: string): string {
  const oneLine = value.replace(/[\r\n\t\]\[]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  return /[\s"=]/.test(oneLine) ? JSON.stringify(oneLine) : oneLine;
}
function tokensLabel(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}
/**
 * D38's one-line metadata header, e.g.
 * `[ctx course="COMP SCI 400" profile=computing scope="Midterm 2" intent=items pack=items.v3 sources=r12,r40 budget=6k]`.
 * Field order is fixed so the same ask produces the same bytes.
 */
export function formatAskHeader(
  context: AskContext,
  pack: { id: string; version: string },
  budgetTokens?: number,
): string {
  const parts: string[] = [];
  if (context.course) parts.push(`course=${headerValue(context.course)}`);
  if (context.profile) parts.push(`profile=${headerValue(context.profile)}`);
  if (context.scope) parts.push(`scope=${headerValue(context.scope)}`);
  if (context.intent) parts.push(`intent=${headerValue(context.intent)}`);
  parts.push(`pack=${headerValue(`${pack.id}.${pack.version}`)}`);
  if (context.sources?.length)
    parts.push(
      `sources=${context.sources
        .slice(0, 40)
        .map((s) => s.replace(/[^A-Za-z0-9_.:-]/g, ""))
        .filter(Boolean)
        .join(",")}`,
    );
  if (budgetTokens) parts.push(`budget=${tokensLabel(budgetTokens)}`);
  return `[ctx ${parts.join(" ")}]`;
}
