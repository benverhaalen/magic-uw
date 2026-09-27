/**
 * Log redaction (docs/ai-and-privacy.md, "Logs"). Every line the app writes about its own work
 * (the dev trial log, diagnostics, error messages) goes through `redactForLog` first:
 * - a URL keeps only its host and a path class (numeric and opaque segments → `:id`, page, file
 *   and user slugs → `:slug`); the query string and fragment are dropped;
 * - emails, phone numbers, IDs, card and social security numbers, addresses, dates of birth,
 *   IP addresses and bare tokens become `[kind]`;
 * - names from a roster passed in, and any name-shaped run of capitalized words, become `[name]`;
 * - values under credential-looking keys become `[redacted]`.
 * Nothing here is reversible; logs never carry a reverse map.
 */
import { detect, resolveDetections } from "./detectors";

const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi;
const SECRET_KEY = /cookie|authorization|token|password|passwd|secret|credential|verifier|signature|session|^key$|apikey|api_key/i;
const MAX_STRING = 500;
const NAME_SHAPED = /(?<![\p{L}\p{N}_])\p{Lu}\p{Ll}+(?:[ '’-]\p{Lu}\p{Ll}+){1,2}(?![\p{L}\p{N}_])/gu;

/** Host plus the shape of the path; never the query, fragment, credentials or slugs. */
export function urlClass(input: string): string {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return "[url]";
  }
  const path = u.pathname
    .split("/")
    .map((seg, i, all) => {
      if (!seg) return seg;
      const prev = all[i - 1]?.toLowerCase();
      if (/^\d+$/.test(seg) || /^[0-9a-f-]{16,}$/i.test(seg) || /^[A-Za-z0-9_-]{24,}$/.test(seg)) return ":id";
      if (prev && ["pages", "files", "wiki", "users", "people", "profile", "download", "u", "user"].includes(prev)) return ":slug";
      if (/[@%]/.test(seg) || seg.length > 40) return ":slug";
      return seg;
    })
    .join("/");
  return `${u.protocol === "https:" ? "" : `${u.protocol}//`}${u.hostname}${path}`.slice(0, 160);
}

function redactString(value: string, names: RegExp | null): string {
  let text = value.length > MAX_STRING * 4 ? value.slice(0, MAX_STRING * 4) : value;
  text = text.replace(URL_IN_TEXT, (url) => urlClass(url));
  const found = resolveDetections(detect(text));
  let out = "", cursor = 0;
  for (const d of found) {
    out += text.slice(cursor, d.start) + `[${d.kind}]`;
    cursor = d.end;
  }
  text = out + text.slice(cursor);
  if (names) text = text.replace(names, "[name]");
  // Logs need no prose: any name-shaped run of two or three capitalized words goes too.
  text = text.replace(NAME_SHAPED, "[name]");
  return text.length > MAX_STRING ? `${text.slice(0, MAX_STRING)}…` : text;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function namePattern(names: readonly string[] | undefined): RegExp | null {
  const parts = [...new Set((names ?? []).flatMap((n) => [n, ...n.split(/\s+/)]).map((n) => n.trim()).filter((n) => n.length >= 2))];
  if (!parts.length) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${parts.sort((a, b) => b.length - a.length).map(escape).join("|")})(?![\\p{L}\\p{N}_])`, "giu");
}

/**
 * Redact any loggable value. Objects and arrays are copied with their keys; strings are
 * redacted; errors keep only their name and a redacted message.
 */
export function redactForLog(value: unknown, options: { names?: readonly string[] } = {}): unknown {
  const names = namePattern(options.names);
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return redactString(v, names);
    if (v instanceof Error) return { name: v.name, message: redactString(v.message, names) };
    if (Array.isArray(v)) return depth > 6 ? "[…]" : v.slice(0, 50).map((x) => walk(x, depth + 1));
    if (v && typeof v === "object") {
      if (depth > 6) return "[…]";
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) && x !== null && typeof x !== "boolean" ? "[redacted]" : walk(x, depth + 1)]),
      );
    }
    return v;
  };
  return walk(value, 0);
}

/** One JSON line for a log file, already redacted. */
export function logLine(event: Record<string, unknown>, options: { names?: readonly string[] } = {}): string {
  return `${JSON.stringify(redactForLog(event, options))}\n`;
}
