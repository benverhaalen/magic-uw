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
  /** owner: client-detection. macOS refused the client's Keychain item (its saved sign-in). */
  keychainLocked?: true;
}

/**
 * owner: client-detection. macOS Keychain refusal: `errSecInteractionNotAllowed`, exit code 36
 * (anthropics/claude-code#44028, a user report; openai/codex#16728 for Codex's Keychain store).
 * Not observed here (Windows). Exit 36 counts only on macOS.
 */
export function keychainRefused(text: string, code: number | null, platform: NodeJS.Platform = process.platform): boolean {
  return /errSecInteractionNotAllowed|user interaction is not allowed/i.test(text) || (platform === "darwin" && code === 36);
}

/** Keeps only loggedIn, authMethod and subscriptionType; email and organisation are dropped. */
export function parseClaudeAuth(stdout: string, failure?: { stderr: string; code: number | null; platform?: NodeJS.Platform }): ParsedAuth {
  if (failure && keychainRefused(`${stdout}\n${failure.stderr}`, failure.code, failure.platform))
    return { signedIn: null, method: null, plan: null, keychainLocked: true };
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

/**
 * `codex login status` prints e.g. "Logged in using ChatGPT"; only the method is kept.
 * owner: client-detection: only "Not logged in" means signed out. Any other failure (for example
 * an older Codex that can't read a newer config.toml: "Error loading configuration …") is unknown,
 * not signed out.
 */
export function parseCodexLogin(text: string, code: number | null, platform: NodeJS.Platform = process.platform): ParsedAuth {
  const m = /logged in using (chatgpt|an api key|api key)/i.exec(text);
  if (m) return { signedIn: true, method: /chatgpt/i.test(m[1]) ? "chatgpt" : "api_key", plan: null };
  if (/not logged in/i.test(text)) return { signedIn: false, method: null, plan: null };
  if (code !== 0 && keychainRefused(text, code, platform)) return { signedIn: null, method: null, plan: null, keychainLocked: true };
  return { signedIn: null, method: null, plan: null };
}
