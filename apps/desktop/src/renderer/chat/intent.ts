import type { ChatBridge } from "./store";

// owner: chat lane. Consumer side of the intent router on main (ae66b91, #24): the `intent.preview`
// query and the `{type:"command"}` command. Core resolves courses, dates and actions; this file only
// decides which results the chat may run and render. The types mirror @magic/contracts on main,
// because this branch's contracts predate them; replace them with imports once main is merged.

export interface IntentSlots { course?: string | null; assignment?: string | null; date?: string | null; query?: string | null; scope?: "course" | "all" | null }
export interface IntentCandidate { action: string; args: IntentSlots; label: string }
export interface IntentCitation { sourceId: string; resourceId: string; title: string; url: string; quote: string; start: number | null; end: number | null }
export type IntentOutcome =
  | { status: "ran"; action: string; args: Record<string, unknown>; result: unknown }
  | { status: "clarify"; question: string; candidates: IntentCandidate[] }
  | { status: "answer"; text: string; citations: IntentCitation[]; notFound: boolean; dropped: number }
  | { status: "unavailable"; reason: string }
  | { status: "preview"; hint: string | null; action: string | null; slots: IntentSlots }
  | { status: "ready"; ai: boolean };
export type IntentResult = IntentOutcome & { path: "code" | "ai" | "cache" | "none"; latencyMs: number; tokens: { in: number; cached: number; out: number } };
/** Core's resolved course: `ref` is `accountScope:courseId`, the same key as the chat's courses. */
export interface IntentCourse { ref: string; accountScope: string; courseId: string; code: string | null; name: string }
export interface IntentRange { from: string; to: string; label?: string }

/**
 * Actions a chat question may run: they only read, and the chat renders their result. Anything
 * else (notes, practice, generation, calendar proposals, opening) is named, never run from here.
 * `run` is only ever sent after a code-path preview picked one of these: on a code miss core's
 * model fallback would choose and run an action itself, so the chat does not send those.
 */
export const CHAT_READS = new Set(["ask", "agenda.due", "materials.search"]);

let support: "unknown" | "yes" | "no" = "unknown";
export function resetIntentSupport() { support = "unknown"; }
export function intentSupport() { return support; }
/** Old schema (no `intent.preview` view) or no intent seam: the app doesn't have the router. */
function unsupported(message: string) {
  return /intent\.preview|invalid (discriminator|union|enum)|command bar isn't built|expected .*view|unrecognized/i.test(message);
}

/** The code resolver's reading of the prompt: 0 tokens, never the model. Null when the router is not available. */
export async function previewIntent(bridge: ChatBridge, text: string, courseRef: string | null): Promise<Extract<IntentResult, { status: "preview" }> | null> {
  if (support === "no" || !bridge.query || !bridge.execute) return null;
  try {
    const query = bridge.query as unknown as (q: unknown) => Promise<{ view?: string; preview?: IntentResult }>;
    const found = await query({ view: "intent.preview", text: text.slice(0, 500), ...(courseRef ? { courseId: courseRef } : {}) });
    if (found?.view !== "intent.preview" || found.preview?.status !== "preview") { support = "no"; return null; }
    support = "yes";
    return found.preview;
  } catch (cause) {
    if (unsupported(cause instanceof Error ? cause.message : String(cause))) support = "no";
    return null;
  }
}

/** Runs the prompt through the router. Only call after `previewIntent` returned an action in CHAT_READS. */
export async function runIntent(bridge: ChatBridge, text: string, courseRef: string | null): Promise<IntentResult> {
  const execute = bridge.execute as unknown as (c: unknown) => Promise<{ command?: IntentResult }>;
  const result = await execute({ type: "command", value: { text: text.slice(0, 500), context: { view: "chat", ...(courseRef ? { courseId: courseRef } : {}) }, mode: "run" } });
  if (!result?.command) throw new Error("The app returned no result for this request.");
  return result.command;
}

export function intentCourse(args: Record<string, unknown>): IntentCourse | null {
  const c = args.course as IntentCourse | undefined;
  return c && typeof c.ref === "string" ? c : null;
}
/** The due range core settled: the action's own range, else the resolved date, else null (this week). */
export function intentRange(args: Record<string, unknown>, result: unknown): IntentRange | null {
  const r = (result as { range?: IntentRange } | null)?.range ?? (args.date as IntentRange | undefined);
  return r && /^\d{4}-\d{2}-\d{2}$/.test(r.from) && /^\d{4}-\d{2}-\d{2}$/.test(r.to) ? r : null;
}
export interface IntentHit { resourceId: string; title: string; excerpt?: string | null }
export function intentHits(result: unknown): IntentHit[] {
  const hits = (result as { hits?: IntentHit[] } | null)?.hits;
  return Array.isArray(hits) ? hits.filter((h) => typeof h?.resourceId === "string") : [];
}
