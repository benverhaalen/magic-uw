import type { WorkItem, WorkLaunchReceipt, WorkSet } from "@magic/contracts";

/**
 * What Magic can truthfully say about one prepared destination.
 * `handed_off` means the operating system accepted the link or file. It does
 * not prove the page loaded, the student is signed in, or any work happened.
 */
export type DestinationState =
  | { kind: "ready" }
  | { kind: "sending" }
  | { kind: "handed_off"; via: "browser" | "file" }
  | { kind: "fallback"; reason: string }
  | { kind: "would_open"; via: "browser" | "file" }
  | { kind: "not_sent"; reason: string }
  | { kind: "unconfirmed" };

export type LaunchProblem =
  /** Preview hash no longer matches the saved destinations. Review before opening. */
  | "changed"
  /** Another Start work launch is running app-wide. Safe to try again shortly. */
  | "busy"
  /** UW connection setup/consent is not currently granted. */
  | "setup"
  /** Retry narrowing no longer matches the session record, e.g. after restart. */
  | "retry_expired"
  /** Assignment or course is no longer eligible for prepared work. */
  | "unavailable"
  /** The call failed in a way that does not tell us whether anything opened. */
  | "unknown";

export interface LaunchOutcome {
  resourceId: string;
  /** Destinations this outcome describes; a different current hash means it is an earlier launch. */
  previewHash: string;
  at: string;
  mode: "opened" | "dry_run" | "none";
  items: { resourceId: string; title: string; role: WorkItem["role"]; target: WorkItem["target"]["kind"]; state: DestinationState }[];
  /** `raw` is kept in memory for diagnosis only; it is never rendered. */
  problem: { kind: LaunchProblem; message: string; raw?: string } | null;
  notes: string[];
}

const FALLBACK_NOTE = /^(.*): opened the original because (.+)\.$/;

/** Map the IPC error text from main/core to a recovery. Unknown text never implies nothing opened. */
export function classifyLaunchError(cause: unknown): { kind: LaunchProblem; message: string; raw: string } {
  const raw = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  const text = raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
  return { ...classifyText(text), raw: text.slice(0, 300) };
}
function classifyText(text: string): { kind: LaunchProblem; message: string } {
  if (/Prepared work changed|Review the prepared destinations/.test(text))
    return { kind: "changed", message: "These destinations changed since you reviewed them. Check the updated list, then start again." };
  if (/already opening/.test(text))
    return { kind: "busy", message: "Another Start work is still opening. Try again in a moment." };
  if (/Finish the setup step|consent/i.test(text))
    return { kind: "setup", message: "Finish the UW connection setup step before Magic opens course pages." };
  if (/Retry only the failed items|Invalid retry selection/.test(text))
    return { kind: "retry_expired", message: "Magic no longer has the record of which items failed. Open all again to continue." };
  if (/no longer available|not currently available|nothing to open|available for assignments/.test(text))
    return { kind: "unavailable", message: text || "This item can no longer be prepared." };
  return { kind: "unknown", message: "Magic could not confirm what opened. Check your browser and apps before trying again." };
}

/** Problems that happen before the first handoff: nothing was sent. */
const BEFORE_LAUNCH: ReadonlySet<LaunchProblem> = new Set(["changed", "busy", "setup", "retry_expired", "unavailable"]);

function readableReason(reason: string) {
  if (/Finish the setup step/.test(reason)) return "UW connection setup is not finished";
  if (/Prepared work changed/.test(reason)) return "the destinations changed while opening";
  const text = reason.replace(/\.$/, "");
  // Sentence-case core reasons read as a clause after "Not sent:"; keep acronyms like "UW".
  return /^[A-Z][a-z]/.test(text) ? text[0]!.toLowerCase() + text.slice(1) : text;
}

/** Build the per-destination picture from a real receipt, preserving items the receipt does not mention. */
export function outcomeFromReceipt(set: WorkSet, receipt: WorkLaunchReceipt, previous?: LaunchOutcome | null, only?: readonly string[]): LaunchOutcome {
  const fallbackReasons = new Map<string, string>();
  const notes: string[] = [];
  for (const note of receipt.notes) {
    const match = FALLBACK_NOTE.exec(note);
    if (match) fallbackReasons.set(match[1]!, match[2]!);
    else if (!set.notes.includes(note)) notes.push(note);
  }
  const dry = receipt.mode === "dry_run";
  const items = set.items.map(item => {
    const earlier = previous?.previewHash === set.previewHash ? previous.items.find(entry => entry.resourceId === item.resourceId) : undefined;
    if (only && !only.includes(item.resourceId) && earlier) return { ...earlier };
    const opened = receipt.opened.find(entry => entry.resourceId === item.resourceId);
    const failed = receipt.failed.find(entry => entry.resourceId === item.resourceId);
    let state: DestinationState;
    if (opened && dry) state = { kind: "would_open", via: opened.via === "file" ? "file" : "browser" };
    else if (opened?.via === "browser_fallback") state = { kind: "fallback", reason: readableReason(fallbackReasons.get(item.title) ?? "the saved copy could not be used") };
    else if (opened) state = { kind: "handed_off", via: opened.via === "file" ? "file" : "browser" };
    else if (failed) state = { kind: "not_sent", reason: readableReason(failed.reason) };
    else state = { kind: "unconfirmed" };
    return { resourceId: item.resourceId, title: item.title, role: item.role, target: item.target.kind, state };
  });
  return {
    resourceId: set.assignmentId,
    previewHash: set.previewHash,
    at: receipt.at,
    mode: dry ? "dry_run" : "opened",
    items,
    problem: null,
    notes: [...new Set([...(only && previous?.previewHash === set.previewHash ? previous.notes : []), ...notes])],
  };
}

/** A thrown launch: either known to be before any handoff, or unknown. Earlier states are kept. */
export function outcomeFromError(set: WorkSet, cause: unknown, previous?: LaunchOutcome | null, only?: readonly string[]): LaunchOutcome {
  const problem = classifyLaunchError(cause);
  const nothingSent = BEFORE_LAUNCH.has(problem.kind);
  const same = previous?.previewHash === set.previewHash ? previous : null;
  const items = set.items.map(item => {
    const earlier = same?.items.find(entry => entry.resourceId === item.resourceId);
    const attempted = !only || only.includes(item.resourceId);
    const state: DestinationState = !attempted && earlier ? earlier.state
      : nothingSent ? earlier && earlier.state.kind !== "sending" ? earlier.state : { kind: "ready" }
      : { kind: "unconfirmed" };
    return { resourceId: item.resourceId, title: item.title, role: item.role, target: item.target.kind, state };
  });
  return {
    resourceId: set.assignmentId,
    previewHash: set.previewHash,
    at: same?.at ?? new Date().toISOString(),
    mode: same?.mode ?? "none",
    items,
    problem,
    notes: same?.notes ?? [],
  };
}

export function sendingOutcome(set: WorkSet, previous?: LaunchOutcome | null, only?: readonly string[]): LaunchOutcome {
  const same = previous?.previewHash === set.previewHash ? previous : null;
  return {
    resourceId: set.assignmentId,
    previewHash: set.previewHash,
    at: same?.at ?? new Date().toISOString(),
    mode: same?.mode ?? "none",
    items: set.items.map(item => {
      const earlier = same?.items.find(entry => entry.resourceId === item.resourceId);
      const state: DestinationState = only && !only.includes(item.resourceId) && earlier ? earlier.state : { kind: "sending" };
      return { resourceId: item.resourceId, title: item.title, role: item.role, target: item.target.kind, state };
    }),
    problem: null,
    notes: same?.notes ?? [],
  };
}

export function retryableIds(outcome: LaunchOutcome) {
  return outcome.items.filter(item => item.state.kind === "not_sent").map(item => item.resourceId);
}

export function counts(outcome: LaunchOutcome) {
  let sent = 0, failed = 0, unconfirmed = 0, pending = 0;
  for (const { state } of outcome.items) {
    if (state.kind === "handed_off" || state.kind === "fallback" || state.kind === "would_open") sent++;
    else if (state.kind === "not_sent") failed++;
    else if (state.kind === "unconfirmed") unconfirmed++;
    else if (state.kind === "sending") pending++;
  }
  return { sent, failed, unconfirmed, pending, total: outcome.items.length };
}

const time = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
};

/** One sentence summarising the latest attempt. Never says opened, done or complete. */
export function summaryLine(outcome: LaunchOutcome) {
  const { sent, failed, unconfirmed, pending, total } = counts(outcome);
  if (outcome.problem?.kind === "unknown" && !sent && !failed) return "Magic could not confirm what opened.";
  if (pending) return `Sending ${pending === total ? total : pending} ${pending === 1 ? "item" : "items"} to your apps…`;
  if (outcome.mode === "dry_run") return `Verification mode: nothing opened. ${sent} of ${total} would be sent.`;
  if (outcome.mode === "none" && !sent && !failed) return unconfirmed ? "Magic could not confirm what opened." : "Nothing was sent.";
  const at = time(outcome.at);
  const parts = [`Sent ${sent} of ${total}${at ? ` at ${at}` : ""}`];
  if (failed) parts.push(`${failed} not sent`);
  if (unconfirmed) parts.push(`${unconfirmed} not confirmed`);
  return `${parts.join(" · ")}.`;
}

export function stateLabel(state: DestinationState): string {
  switch (state.kind) {
    case "ready": return "Ready";
    case "sending": return "Sending…";
    case "handed_off": return state.via === "file" ? "Sent to its usual app" : "Sent to your browser";
    case "fallback": return `Saved copy not used, sent the original to your browser`;
    case "would_open": return state.via === "file" ? "Would open the saved copy" : "Would send to your browser";
    case "not_sent": return `Not sent: ${state.reason}`;
    case "unconfirmed": return "Not confirmed";
  }
}

export function stateTone(state: DestinationState): "quiet" | "sent" | "attention" {
  if (state.kind === "not_sent" || state.kind === "unconfirmed") return "attention";
  if (state.kind === "handed_off" || state.kind === "fallback" || state.kind === "would_open") return "sent";
  return "quiet";
}

/** Core notes carry ISO instants; show them in local time without changing the fact. */
export function readableNote(note: string, locale?: string) {
  return note.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})\b/g, iso => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
  });
}
