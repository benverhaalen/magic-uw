/**
 * Stable pseudonyms for one send (docs/ai-and-privacy.md, "Pseudonyms").
 *
 * A session numbers the people and identifiers of one request: `[STUDENT_1]`, `[EMAIL_2]`,
 * `[PHONE_1]`. The order is an HMAC ranking keyed with this install's local secret and the send
 * context (for example `pack:<course>`), so:
 * - within one request the same person or value always gets the same placeholder;
 * - the same course material in the same context gets the same placeholders again (the pack
 *   cache stays warm and a repeat costs 0 tokens);
 * - another install (another secret) or another context ranks differently, so a placeholder
 *   cannot be linked across students, installs or purposes.
 * The reverse map lives only in the session object, in memory, for that request.
 *
 * The secret comes from main (Electron safeStorage) over the worker channel. Without it (tests,
 * the eval harness) a per-process random key is used; it is never logged or persisted.
 */
import { createHmac, randomBytes } from "node:crypto";

let installKey: Buffer = randomBytes(32);
let configured = false;

/** Set by the worker from main's wrapped secret; `null` falls back to a fresh per-process key. */
export function configurePseudonymKey(key: Uint8Array | null): void {
  installKey = key ? Buffer.from(key) : randomBytes(32);
  configured = !!key;
}
/** True when the key came from the install's protected secret (placeholders survive restarts). */
export function pseudonymKeyConfigured(): boolean {
  return configured;
}

/** The placeholder label of a kind: `student_name` → STUDENT, `secret_url` → SECRET_URL. */
export function labelOf(kind: string): string {
  return kind === "student_name" ? "STUDENT" : kind.toUpperCase();
}
/** The kind a placeholder label counts as (the inverse of `labelOf`). */
export function kindOfLabel(label: string): string {
  return label === "STUDENT" ? "student_name" : label.toLowerCase();
}

export interface PseudonymSession {
  readonly context: string;
  /** Rank and number every identity up front (HMAC order), before any `placeholder` call. */
  prime(entries: Iterable<{ kind: string; key: string }>): void;
  /** The placeholder for one identity; a new identity gets the next number of its kind. */
  placeholder(kind: string, key: string): string;
  /** Placeholder → normalized original, for this request only. Never log or persist it. */
  reverse(): ReadonlyMap<string, { kind: string; key: string }>;
}

export function pseudonymSession(context: string): PseudonymSession {
  const sessionKey = createHmac("sha256", installKey).update(`pseudonym\u0000${context}`).digest();
  const numbers = new Map<string, string>();
  const reverse = new Map<string, { kind: string; key: string }>();
  const counters = new Map<string, number>();
  const id = (kind: string, key: string) => `${kind}\u0000${key}`;
  const assign = (kind: string, key: string) => {
    const k = id(kind, key);
    let p = numbers.get(k);
    if (p) return p;
    const label = labelOf(kind);
    const n = (counters.get(label) ?? 0) + 1;
    counters.set(label, n);
    p = `[${label}_${n}]`;
    numbers.set(k, p);
    reverse.set(p, { kind, key });
    return p;
  };
  return {
    context,
    prime(entries) {
      const fresh = new Map<string, { kind: string; key: string; rank: string }>();
      for (const e of entries) {
        const k = id(e.kind, e.key);
        if (numbers.has(k) || fresh.has(k)) continue;
        fresh.set(k, { ...e, rank: createHmac("sha256", sessionKey).update(k).digest("hex") });
      }
      for (const e of [...fresh.values()].sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0)))
        assign(e.kind, e.key);
    },
    placeholder: assign,
    reverse: () => reverse,
  };
}
