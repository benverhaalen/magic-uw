/**
 * Code-only personal-data detectors beyond the roster (docs/ai-and-privacy.md, "Protection
 * layers"). Each detector carries a precision guard (a checksum, a validity rule, a required
 * context word or a required shape) so ordinary course text is not mangled. Detection never
 * calls a model and never returns anything but spans of the input.
 */
export type DetectorKind =
  | "secret_url"
  | "email"
  | "card"
  | "ssn"
  | "campus_id"
  | "student_id"
  | "phone"
  | "dob"
  | "address"
  | "ip"
  | "canvas_user"
  | "netid";

export interface Detection {
  kind: DetectorKind;
  /** Span of the value in the input (the context word is never part of it). */
  start: number;
  end: number;
  /** The normalized value; used only in memory to keep one placeholder per value. */
  value: string;
}

/** Overlap priority: an earlier kind wins a tie on span length. */
export const DETECTOR_ORDER: readonly DetectorKind[] = [
  "secret_url", "email", "card", "ssn", "campus_id", "student_id", "phone", "dob", "address", "ip", "canvas_user", "netid",
];

const before = (text: string, start: number, n: number) => text.slice(Math.max(0, start - n), start);
const digits = (s: string) => s.replace(/\D/g, "");

/** Luhn checksum over a digit string. */
export function luhn(value: string): boolean {
  let sum = 0;
  for (let i = 0; i < value.length; i++) {
    let d = value.charCodeAt(value.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return value.length > 0 && sum % 10 === 0;
}

// --- secrets in URLs ---------------------------------------------------------------------
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
/** Query or fragment parameter names that carry a credential or a signature. */
const SECRET_PARAMS = new Set([
  "token", "access_token", "refresh_token", "id_token", "auth", "authorization", "sig", "signature", "key", "apikey",
  "api_key", "verifier", "code", "secret", "client_secret", "password", "pwd", "pass", "session", "sessionid", "sid",
  "jwt", "ticket", "hmac", "x-amz-signature", "x-amz-credential", "x-amz-security-token", "x-goog-signature",
  "x-goog-credential", "googleaccessid", "se", "sv", "skoid", "download_token", "otp", "samlresponse", "relaystate",
]);
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
function trimUrl(url: string) {
  // Trailing sentence punctuation and an unbalanced closing bracket are not part of the URL.
  let end = url.length;
  while (end > 0 && /[.,;:!?)\]}]/.test(url[end - 1]!)) {
    const c = url[end - 1]!;
    if ((c === ")" && url.slice(0, end).split("(").length > url.slice(0, end).split(")").length - 1)) break;
    end--;
  }
  return url.slice(0, end);
}
function secretUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password) return true;
  const params = [...u.searchParams.keys(), ...new URLSearchParams(u.hash.replace(/^#/, "")).keys()];
  if (params.some((k) => SECRET_PARAMS.has(k.toLowerCase()))) return true;
  JWT_RE.lastIndex = 0;
  return JWT_RE.test(url);
}
function detectSecretUrls(text: string, out: Detection[]) {
  for (const m of text.matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    if (secretUrl(url)) out.push({ kind: "secret_url", start: m.index, end: m.index + url.length, value: url });
  }
  // A bare signed token (JWT) outside a URL.
  for (const m of text.matchAll(JWT_RE)) out.push({ kind: "secret_url", start: m.index, end: m.index + m[0].length, value: m[0] });
}

// --- email -------------------------------------------------------------------------------
const EMAIL_RE = /(?<![\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])/g;

// --- payment cards (Luhn + issuer prefix + length) ----------------------------------------
const CARD_RE = /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g;
const CARD_PREFIX = /^(?:4|5[1-5]|2(?:2[2-9]|[3-6]\d|7[01]|720)|3[47]|6(?:011|5|4[4-9]))/;

// --- US SSN (validity rules; a bare 9-digit number needs the context word) ------------------
const SSN_RE = /(?<![\d-])(\d{3})([- ])(\d{2})\2(\d{4})(?![\d-])/g;
const SSN_BARE_RE = /(?<![\d-])\d{9}(?![\d-])/g;
const SSN_CONTEXT = /\b(?:ssn|social\s+security(?:\s+(?:number|no\.?|#))?)\b[^\n]{0,20}$/i;
const validSsn = (area: string, group: string, serial: string) =>
  area !== "000" && area !== "666" && area[0] !== "9" && group !== "00" && serial !== "0000";

// --- campus / student IDs (context required) ------------------------------------------------
const TEN_RE = /(?<![\d-])\d{10}(?![\d-])/g;
const ID_CONTEXT = /\b(?:student|campus|wiscard|id|identification|emplid)\b[^\n]{0,24}$/i;
const CARD_NUMBER_RE = /(?<![\d-])\d(?:[ -]?\d){10,18}(?![\d-])/g;
const WISCARD_CONTEXT = /\b(?:wiscard|campus\s*(?:id|card)|card\s*(?:number|no\.?|#)|iso\s*(?:number|no\.?|#)?)\b[^\n]{0,24}$/i;

// --- phone: the roster scrubber's NANP shape (separators required) plus E.164 ---------------
const NANP_RE = /(?<![\d-])(?:\+?1[-.\s]?)?(?:\(\d{3}\)\s?|\d{3}[-.\s])\d{3}[-.\s]\d{4}(?![\d-])/g;
const E164_RE = /(?<![\w+])\+[1-9](?:[\s.-]?\(?\d{1,4}\)?){2,6}(?![\w-])/g;

// --- dates of birth (context required; only the date is replaced) -----------------------------
const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const DATE = `(?:\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}|\\d{4}-\\d{2}-\\d{2}|${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}|\\d{1,2}\\s+${MONTH},?\\s+\\d{4})`;
const DOB_RE = new RegExp(`\\b(?:born(?:\\s+on)?|dob|d\\.o\\.b\\.?|date\\s+of\\s+birth|birth\\s*date|birthday)\\b\\s*(?:is|was|:|-)?\\s*(${DATE})`, "gid");

// --- street addresses (number + capitalised street name + suffix) ----------------------------
const SUFFIX =
  "(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct|Way|Place|Pl|Parkway|Pkwy|Circle|Cir|Terrace|Ter|Trail|Trl|Highway|Hwy|Square|Sq|Mall|Crossing|Xing|Row|Pass)";
const ADDRESS_RE = new RegExp(
  `(?<![\\w-])\\d{1,6}[A-Za-z]?(?:-\\d{1,4})?\\s+(?:(?:[NSEW]|North|South|East|West)\\.?\\s+)?(?:(?:[A-Z][A-Za-z'.-]*|\\d{1,3}(?:st|nd|rd|th))\\s+){1,4}${SUFFIX}\\b\\.?(?:,?\\s+(?:Apt|Apartment|Unit|Suite|Ste|#)\\.?\\s*[A-Za-z0-9-]{1,6})?`,
  "g",
);

// --- IP addresses -----------------------------------------------------------------------------
const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4_RE = new RegExp(`(?<![\\w.])${OCTET}(?:\\.${OCTET}){3}(?![\\w]|\\.\\d)`, "g");
const IPV4_NOT = /\b(?:section|sec|chapter|ch|version|ver|v|figure|fig|table|eq|equation|step|part|rule|theorem|lemma|definition|def|example|ex|problem|exercise|question|q|item|page|p|pp|§)\.?\s*$/i;
const IP_CONTEXT = /\b(?:ip|ipv4|address|host|server|client|from|login|connected|vpn)\b[^\n]{0,20}$/i;
const IPV6_RE = /(?<![\w:])(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}(?![\w:])|(?<![\w:])(?:[0-9a-f]{1,4}:){2,6}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,4})?(?![\w:])/gi;

// --- Canvas user IDs in URLs -----------------------------------------------------------------
const CANVAS_USER_RE = /\/users\/(\d{1,15})(?!\d)|[?&](?:user_id|student_id)=(\d{1,15})(?!\d)/gd;

// --- a token explicitly labelled as a NetID ---------------------------------------------------
const NETID_RE = /\bnet\s?-?id\b\s*(?:is|:|#|=|-)?\s*([A-Za-z][A-Za-z0-9]{1,15})\b/dgi;

/**
 * What the text is decides what is replaced (the operator's rule, September 27: protect people
 * and credentials, never rewrite teaching material):
 * - "teaching": instructor-authored pages, slides, files, readings, prompts, syllabus, quizzes.
 *   Only identifiers of people and credentials: emails, phones, signed URLs, Canvas user IDs,
 *   labelled NetIDs and context-labelled student IDs. An IP, an address, a date, a card-like or
 *   SSN-like number there is course content (a networking lab, a civics reading, a Luhn exercise).
 * - "personal": posts and replies, comments, feedback, mail, the student's notes. Every detector,
 *   but a number (card, SSN, IP, address) only with a person context word before it.
 * - "all": logs, which need no content: every detector, no context required.
 */
export type DetectMode = "teaching" | "personal" | "all";
export const TEACHING_KINDS: ReadonlySet<DetectorKind> = new Set(["secret_url", "email", "phone", "canvas_user", "netid", "student_id"]);
/** A person context word shortly before a number: whose it is, or what kind of personal number. */
const PERSON_CONTEXT =
  /\b(?:my|me|mine|i'm|i am|his|her|hers|their|theirs|your|yours|our|call|text|reach|contact|home|lives?|living|reside|resides|address|apartment|apt|ssn|social\s+security|card|visa|mastercard|amex|credit|debit|born|dob|birthday|id|login|logged|ip|connected)\b[^\n]{0,32}$/i;
const NEEDS_PERSON_CONTEXT: ReadonlySet<DetectorKind> = new Set(["card", "ssn", "ip", "address"]);

/** Every detection in `text` for `mode`, overlapping candidates included (the caller resolves overlaps). */
export function detect(text: string, mode: DetectMode = "all"): Detection[] {
  const out: Detection[] = [];
  if (!text) return out;
  const push = (kind: DetectorKind, start: number, end: number) => {
    if (mode === "teaching" && !TEACHING_KINDS.has(kind)) return;
    if (mode === "personal" && NEEDS_PERSON_CONTEXT.has(kind) && !PERSON_CONTEXT.test(before(text, start, 48))) return;
    out.push({ kind, start, end, value: text.slice(start, end).toLowerCase() });
  };
  detectSecretUrls(text, out);
  for (const m of text.matchAll(EMAIL_RE)) push("email", m.index, m.index + m[0].length);
  // Digit runs: cheap pre-check skips the numeric detectors for text without long numbers.
  const hasDigits = /\d{3}/.test(text);
  if (hasDigits) {
    for (const m of text.matchAll(CARD_RE)) {
      const d = digits(m[0]);
      if (d.length >= 13 && d.length <= 19 && CARD_PREFIX.test(d) && luhn(d)) push("card", m.index, m.index + m[0].length);
    }
    for (const m of text.matchAll(SSN_RE))
      if (validSsn(m[1]!, m[3]!, m[4]!) && (m[2] === "-" || SSN_CONTEXT.test(before(text, m.index, 40))))
        push("ssn", m.index, m.index + m[0].length);
    for (const m of text.matchAll(SSN_BARE_RE))
      if (SSN_CONTEXT.test(before(text, m.index, 40)) && validSsn(m[0].slice(0, 3), m[0].slice(3, 5), m[0].slice(5)))
        push("ssn", m.index, m.index + m[0].length);
    for (const m of text.matchAll(CARD_NUMBER_RE))
      if (WISCARD_CONTEXT.test(before(text, m.index, 40))) push("campus_id", m.index, m.index + m[0].length);
    // A bare 10-digit number is an ID only after a context word (it is often a timestamp or an ISBN).
    for (const m of text.matchAll(TEN_RE))
      if (ID_CONTEXT.test(before(text, m.index, 40))) push("student_id", m.index, m.index + m[0].length);
    for (const m of text.matchAll(NANP_RE)) push("phone", m.index, m.index + m[0].length);
    for (const m of text.matchAll(E164_RE)) {
      const n = digits(m[0]).length;
      if (n >= 8 && n <= 15) push("phone", m.index, m.index + m[0].length);
    }
    for (const m of text.matchAll(DOB_RE)) {
      const [s, e] = m.indices![1]!;
      push("dob", s, e);
    }
    for (const m of text.matchAll(ADDRESS_RE)) push("address", m.index, m.index + m[0].length);
    for (const m of text.matchAll(IPV4_RE)) {
      const pre = before(text, m.index, 24);
      if (IPV4_NOT.test(pre)) continue;
      const octets = m[0].split(".").map(Number);
      // Dotted section numbers ("1.2.3.4") look like addresses; small ones need a context word.
      if (octets[0] === 0 || (octets.every((o) => o < 10) && !IP_CONTEXT.test(pre))) continue;
      push("ip", m.index, m.index + m[0].length);
    }
    for (const m of text.matchAll(CANVAS_USER_RE)) {
      const [s, e] = (m.indices![1] ?? m.indices![2])!;
      push("canvas_user", s, e);
    }
  }
  if (text.includes(":"))
    for (const m of text.matchAll(IPV6_RE)) {
      const hex = m[0].replace(/:/g, "");
      if (hex.length >= 6 && /\d/.test(hex)) push("ip", m.index, m.index + m[0].length);
    }
  for (const m of text.matchAll(NETID_RE)) {
    const [s, e] = m.indices![1]!;
    push("netid", s, e);
  }
  return out;
}

/** Longest span first, then detector priority; overlapping losers are dropped. */
export function resolveDetections(found: Detection[]): Detection[] {
  const rank = (k: DetectorKind) => DETECTOR_ORDER.indexOf(k);
  const sorted = [...found].sort((a, b) => b.end - b.start - (a.end - a.start) || rank(a.kind) - rank(b.kind) || a.start - b.start);
  const accepted: Detection[] = [];
  for (const d of sorted) if (!accepted.some((a) => d.start < a.end && a.start < d.end)) accepted.push(d);
  return accepted.sort((a, b) => a.start - b.start);
}
