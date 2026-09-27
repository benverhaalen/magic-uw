/**
 * The command bar's protection (docs/ai-and-privacy.md, "Egress coverage"). Runs only after the
 * code resolver has missed, so a code hit does no protection work and sends nothing.
 * - classify: the student's command and hints are personal text; the catalogue and course list
 *   are teaching text (cached, so after the first command they cost a hash and a lookup).
 * - ask: the question is personal; each passage is its resource's class. Quotes and sentences in
 *   the reply are mapped back to the original words before the code checks them.
 * The roster covers every course of the student (a command is not one course's) and is rebuilt
 * only when the sources or identities change, checked at most every 2 s; `warm()` builds it when
 * the bar opens, so the first command does not pay for it.
 */
import type { Resource, Store } from "@magic/contracts";
import { toOriginalSpan, type EffectiveRoster, type ScrubResult } from "../identity";
import { accountRoster, classOf, protectText, type ContentClass } from "./protect";
import { pseudonymSession, type PseudonymSession } from "./pseudonyms";

const RECHECK_MS = 2000;
let work = 0;
let criticalMs = 0;
/** Protection calls made on the command bar path (tests: a code hit must not add any). */
export const intentProtectionWork = (): number => work;
/** Milliseconds of protection spent on the dispatch path so far (tests: the privacy share). */
export const intentProtectionMs = (): number => criticalMs;

export interface IntentProtection {
  /** When the bar opens: the roster (revision checked) and, given the stable prefix, its protection. */
  warm(prefix?: string): void;
  /** The stable prefix (catalogue, argument glossary, courses), protected once per content. */
  prefix(value: string): string;
  /** A request's protector: every field it protects shares one pseudonym session. */
  request(context: string): IntentRequest;
}
export interface IntentRequest {
  text(value: string, cls: ContentClass): string;
  /** Protect and keep the span map, so a quote taken from the protected text maps back. */
  frozen(value: string, cls: ContentClass): ScrubResult;
  /** Puts the original words back where the reply repeats a placeholder from this request. */
  restore(value: string): string;
}

/**
 * The dispatch path carries only the student's own short text: the roster's revision check runs
 * when the bar opens and on a timer after a request, never between submit and send; the stable
 * prefix is protected when the bar opens and cached by content (it has its own pseudonym session,
 * so its placeholders, rare in a catalogue, are stable across requests).
 */
export function intentProtection(store: Store, enabled = true): IntentProtection {
  let cached: { signature: string; roster: EffectiveRoster } | null = null;
  let checkedAt = -Infinity;
  let pending: ReturnType<typeof setTimeout> | null = null;
  const signature = () =>
    JSON.stringify([
      store.sources().map((s) => `${s.id}:${s.lastSuccessAt ?? ""}:${s.resourceCount}`),
      store.identityRoster(),
      store.autoIdentities(),
    ]);
  const refresh = () => {
    checkedAt = performance.now();
    const sig = signature();
    if (cached?.signature !== sig) {
      cached = { signature: sig, roster: accountRoster(store, undefined, "intent") };
      prefixes.clear();
    }
    return cached.roster;
  };
  /** The current roster, without a check; the first use builds it (warm() normally has). */
  const roster = (): EffectiveRoster => cached?.roster ?? refresh();
  /** After a request: recheck the revision off the dispatch path, at most every 2 s. */
  const later = () => {
    if (pending || performance.now() - checkedAt < RECHECK_MS) return;
    pending = setTimeout(() => {
      pending = null;
      try {
        refresh();
      } catch {
        // A failed check keeps the roster it has; the next request retries.
      }
    }, 50);
    pending.unref?.();
  };
  const prefixSession = pseudonymSession("intent:prefix");
  const prefixes = new Map<string, string>();
  const prefix = (value: string): string => {
    if (!enabled) return value;
    let out = prefixes.get(value);
    if (out === undefined) {
      // Prefix placeholders get their own namespace ([STUDENT_P1]): the request's session also numbers
      // from 1, and its restore must never map a prefix placeholder to a request original.
      out = protectText(value, roster(), prefixSession, "teaching").text.replace(/\[([A-Z_]+)_(\d+)\]/g, "[$1_P$2]");
      if (prefixes.size >= 16) prefixes.delete(prefixes.keys().next().value!);
      prefixes.set(value, out);
    }
    return out;
  };
  return {
    warm(stable) {
      if (!enabled) return;
      refresh();
      if (stable !== undefined) prefix(stable);
    },
    prefix,
    request(context) {
      if (!enabled) return { text: (v) => v, frozen: (v) => ({ text: v, spans: [] }), restore: (v) => v };
      later();
      const session: PseudonymSession = pseudonymSession(`intent:${context}`);
      const originals = new Map<string, string>();
      const frozen = (value: string, cls: ContentClass): ScrubResult => {
        const t0 = performance.now();
        work++;
        const r = protectText(value, roster(), session, cls);
        for (const s of r.spans) if (!originals.has(s.placeholder)) originals.set(s.placeholder, value.slice(s.originalStart, s.originalEnd));
        criticalMs += performance.now() - t0;
        return r;
      };
      return {
        text: (value, cls) => frozen(value, cls).text,
        frozen,
        restore: (value) => (originals.size ? value.replace(/\[[A-Z_]+_(?:\d+|SELF)\]/g, (p) => originals.get(p) ?? p) : value),
      };
    },
  };
}

/** A quote from a protected passage, as the original words (null when it splits a placeholder). */
export function originalQuote(frozen: ScrubResult, original: string, quote: string): string | null {
  const start = frozen.text.indexOf(quote);
  if (start < 0) return null;
  const span = toOriginalSpan(frozen, start, start + quote.length);
  return span ? original.slice(span.start, span.end) : null;
}

export const passageClass = (r: Resource | undefined): ContentClass => (r ? classOf(r) : "personal");
