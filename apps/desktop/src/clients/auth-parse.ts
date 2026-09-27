import { z } from "zod";

/**
 * Parses each CLI's own sign-in status text. Used to detect an already-signed-in client
 * before launching it in an app-owned profile (see profiles.ts). Reads no credential file.
 */

const claudeAuth = z
  .object({
    loggedIn: z.boolean(),
    authMethod: z.string().max(64).optional(),
    subscriptionType: z.string().max(64).nullable().optional(),
  })
  .strip();

export interface ParsedAuth {
  signedIn: boolean | null;
  method: string | null;
  plan: string | null;
}

/** Keeps only loggedIn, authMethod and subscriptionType; email and organisation are dropped. */
export function parseClaudeAuth(stdout: string): ParsedAuth {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return { signedIn: null, method: null, plan: null };
  }
  const r = claudeAuth.safeParse(raw);
  if (!r.success) return { signedIn: null, method: null, plan: null };
  return {
    signedIn: r.data.loggedIn,
    method: r.data.loggedIn ? (/api/i.test(r.data.authMethod ?? "") ? "api_key" : "subscription") : null,
    plan: r.data.loggedIn ? (r.data.subscriptionType ?? null) : null,
  };
}

/** `codex login status` prints e.g. "Logged in using ChatGPT"; only the method is kept. */
export function parseCodexLogin(text: string, code: number | null): ParsedAuth {
  const m = /logged in using (chatgpt|an api key|api key)/i.exec(text);
  if (m) return { signedIn: true, method: /chatgpt/i.test(m[1]) ? "chatgpt" : "api_key", plan: null };
  if (/not logged in/i.test(text) || code !== 0) return { signedIn: false, method: null, plan: null };
  return { signedIn: null, method: null, plan: null };
}
