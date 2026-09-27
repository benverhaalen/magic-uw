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
/** Protection calls made on the command bar path (tests: a code hit must not add any). */
export const intentProtectionWork = (): number => work;

export interface IntentProtection {
  warm(): void;
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

export function intentProtection(store: Store, enabled = true): IntentProtection {
  let cached: { signature: string; roster: EffectiveRoster } | null = null;
  let checkedAt = -Infinity;
  const signature = () =>
    JSON.stringify([
      store.sources().map((s) => `${s.id}:${s.lastSuccessAt ?? ""}:${s.resourceCount}`),
      store.identityRoster(),
      store.autoIdentities(),
    ]);
  const roster = (): EffectiveRoster => {
    const t = performance.now();
    if (!cached || t - checkedAt > RECHECK_MS) {
      checkedAt = t;
      const sig = signature();
      if (cached?.signature !== sig) cached = { signature: sig, roster: accountRoster(store, undefined, "intent") };
    }
    return cached.roster;
  };
  return {
    warm() {
      if (enabled) roster();
    },
    request(context) {
      if (!enabled) return { text: (v) => v, frozen: (v) => ({ text: v, spans: [] }), restore: (v) => v };
      const session: PseudonymSession = pseudonymSession(`intent:${context}`);
      const originals = new Map<string, string>();
      const frozen = (value: string, cls: ContentClass): ScrubResult => {
        work++;
        const r = protectText(value, roster(), session, cls);
        for (const s of r.spans) if (!originals.has(s.placeholder)) originals.set(s.placeholder, value.slice(s.originalStart, s.originalEnd));
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
