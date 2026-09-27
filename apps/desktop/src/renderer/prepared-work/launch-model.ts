import type { WorkItem, WorkLaunchReceipt, WorkSet } from "@magic/contracts";
import { CANVAS_ORIGIN, destinationGroups, destinationSummary } from "./destination";

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
  /** `stale`: the prepared list changed while sending; retrying this list cannot work. */
  | { kind: "not_sent"; reason: string; stale?: true }
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
  assignmentTitle: string;
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
const CHANGED = /Prepared work changed|Review the prepared destinations/;

/** Map the IPC error text from main/core to a recovery. Unknown text never implies nothing opened. */
export function classifyLaunchError(cause: unknown): { kind: LaunchProblem; message: string; raw: string } {
  const raw = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  const text = raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
  return { ...classifyText(text), raw: text.slice(0, 300) };
}
function classifyText(text: string): { kind: LaunchProblem; message: string } {
  if (CHANGED.test(text))
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
    else if (failed) state = CHANGED.test(failed.reason) ? { kind: "not_sent", reason: readableReason(failed.reason), stale: true } : { kind: "not_sent", reason: readableReason(failed.reason) };
    else state = { kind: "unconfirmed" };
    return { resourceId: item.resourceId, title: item.title, role: item.role, target: item.target.kind, state };
  });
  const stale = items.some(item => item.state.kind === "not_sent" && item.state.stale);
  return {
    resourceId: set.assignmentId,
    assignmentTitle: set.assignmentTitle,
    previewHash: set.previewHash,
    at: receipt.at,
    mode: dry ? "dry_run" : "opened",
    items,
    // Core re-checks the hash before each item; a change partway means the rest of this list is gone.
    problem: stale ? { kind: "changed", message: "The prepared list changed while sending. Review the updated list before starting again." } : null,
    notes: [...new Set([...(only && previous?.previewHash === set.previewHash ? previous.notes : []), ...notes])],
  };
}

/** A thrown launch: either known to be before any handoff, or unknown. Earlier states are kept. */
export function outcomeFromError(set: WorkSet, cause: unknown, previous?: LaunchOutcome | null, only?: readonly string[]): LaunchOutcome {
  const problem = classifyLaunchError(cause);
  const nothingSent = BEFORE_LAUNCH.has(problem.kind);
  const same = previous?.previewHash === set.previewHash ? previous : null;
  // Another surface is still sending this list: its receipt will describe what happened.
  if (problem.kind === "busy" && same && counts(same).pending) return same;
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
    assignmentTitle: set.assignmentTitle,
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
    assignmentTitle: set.assignmentTitle,
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
  return outcome.items.filter(item => item.state.kind === "not_sent" && !item.state.stale).map(item => item.resourceId);
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
    case "fallback": return "Sent the original to your browser";
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

const SENT: ReadonlySet<DestinationState["kind"]> = new Set(["handed_off", "fallback", "would_open"]);

/** Titles an outcome actually handed off, for the read-only "earlier attempt" line. */
export function sentTitles(outcome: LaunchOutcome) {
  return outcome.mode === "opened" ? outcome.items.filter(item => SENT.has(item.state.kind)).map(item => item.title) : [];
}

/** A plain confirmation with nothing to act on; the shell may show it as a notice. */
export function noticeLine(outcome: LaunchOutcome): string | null {
  const { sent, total } = counts(outcome);
  if (outcome.problem || sent !== total) return null;
  if (outcome.mode === "dry_run") return `${outcome.assignmentTitle}: verification only, nothing opened.`;
  if (outcome.mode !== "opened") return null;
  return `${outcome.assignmentTitle}: sent ${total === 1 ? "1 item" : `${total} items`} to your browser and apps.`;
}

/**
 * Literal action name. One assignment page is "Open assignment"; "Start work"
 * is reserved for a prepared set that really sends more than one destination.
 */
export function launchLabel(set: Pick<WorkSet, "items">) {
  if (set.items.length > 1) return "Start work";
  const only = set.items[0];
  if (!only) return "Start work";
  if (only.role === "instructions") return "Open assignment";
  return `Open ${destinationGroups([only])[0]!.label.replace(/^1 /, "")}`;
}

/** Canvas can record a page view only when a destination, or its fallback, is on Canvas. */
export function pageViewApplies(set: Pick<WorkSet, "items">) {
  const onCanvas = (url: string | undefined) => { try { return !!url && new URL(url).origin === CANVAS_ORIGIN; } catch { return false; } };
  return set.items.some(({ target }) => target.kind === "web" ? onCanvas(target.url) : onCanvas(target.fallbackUrl));
}

/** "Sends 1 PDF and 2 Canvas pages" for the tile description. */
export function sendsLine(set: Pick<WorkSet, "items">) {
  return set.items.length ? `Sends ${destinationSummary(destinationGroups(set.items))}` : "Nothing is prepared to open";
}

export type SlotRemedy = "retry_failed" | "retry_all" | "setup" | "review" | "refresh";
export interface SlotView {
  /** Short visible state (fits the 92px slot beside the info trigger); carried by the remedy's name when a remedy is shown. */
  text: string;
  tone: "idle" | "pending" | "sent" | "attention";
  remedy: { kind: SlotRemedy; label: string; name: string } | null;
  /** Inspectable lines for the details popover; empty means no details control. */
  details: string[];
  /** Original error text, shown only inside details. */
  technical: string | null;
}

/**
 * The one reserved status slot on a tile: idle, pending, sent or needs
 * attention, with at most one short remedy. It replaces "Sending…" in place;
 * nothing is added below the tile.
 */
export function slotView(input: {
  outcome: LaunchOutcome | null; earlier: boolean; pending: boolean;
  prepareError: { kind: LaunchProblem; message: string; raw: string } | null;
  canSetup: boolean; canReview: boolean;
}): SlotView {
  const { outcome, earlier, pending, prepareError, canSetup, canReview } = input;
  const view = (patch: Partial<SlotView>): SlotView => ({ text: "", tone: "idle", remedy: null, details: [], technical: null, ...patch });
  const refresh = { kind: "refresh" as const, label: "Retry", name: "Destinations unavailable. Prepare them again" };
  // With a route, the remedy's name already says why; details would only repeat it and crowd the slot.
  const setup = (details: string[]) => canSetup
    ? view({ text: "Needs setup", tone: "attention", remedy: { kind: "setup", label: "Finish setup", name: "Finish setup: UW connection setup is not finished" }, details: details.slice(1) })
    : view({ text: "Needs setup", tone: "attention" });
  if (pending) return view({ text: "Sending…", tone: "pending" });
  if (prepareError) {
    if (prepareError.kind === "setup") return setup([SETUP_TEXT]);
    return view({ text: "Unavailable", tone: "attention", remedy: refresh, details: [prepareError.message], technical: prepareError.raw || null });
  }
  if (!outcome) return view({});
  if (earlier) {
    const sent = sentTitles(outcome);
    if (!sent.length && outcome.problem?.kind !== "changed") return view({});
    const details = ["The prepared list changed since the last attempt.", sent.length ? `Earlier attempt sent ${sent.join(", ")}.` : "Nothing from the earlier attempt was sent."];
    return canReview
      ? view({ text: "Changed", tone: "attention", remedy: { kind: "review", label: "Review", name: "The prepared list changed. Review the updated list" }, details })
      : view({ text: "Changed", tone: "attention", details });
  }
  const rows = outcome.items.filter(item => item.state.kind !== "ready").map(item => `${item.title}: ${stateLabel(item.state)}.`);
  const problem = outcome.problem;
  const { sent, failed, unconfirmed, total } = counts(outcome);
  if (problem?.kind === "setup") return setup([problem.message, ...rows]);
  if (problem?.kind === "busy") return view({ text: "Busy", tone: "attention", remedy: { kind: "retry_all", label: "Try again", name: "Another Start work is still sending. Try again" }, details: [problem.message, ...rows] });
  if (problem?.kind === "changed") return view({ text: "Changed", tone: "attention", details: [problem.message, ...rows] });
  // Unknown: the student checks their browser first; a visible retry would invite duplicate tabs.
  if (problem?.kind === "unknown") return view({ text: "Not sure", tone: "attention", details: [problem.message, ...rows], technical: problem.raw || null });
  if (problem?.kind === "retry_expired") return view({ text: "Not sent", tone: "attention", remedy: { kind: "retry_all", label: "Open all", name: "Retry record expired. Open all again" }, details: [problem.message, ...rows] });
  if (problem?.kind === "unavailable") return view({ text: "Unavailable", tone: "attention", remedy: refresh, details: [problem.message, ...rows] });
  if (outcome.mode === "dry_run") return view({ text: "Test only", tone: "sent", details: [summaryLine(outcome), ...rows] });
  if (failed) return view({ text: `${failed} not sent`, tone: "attention", remedy: { kind: "retry_failed", label: failed === total ? "Try again" : `Retry ${failed}`, name: `${failed} not sent. Try ${failed === 1 ? "it" : "them"} again` }, details: [summaryLine(outcome), ...rows] });
  if (unconfirmed) return view({ text: "Not sure", tone: "attention", details: [summaryLine(outcome), ...rows] });
  return view({ text: sent === total ? "Sent" : `Sent ${sent} of ${total}`, tone: "sent", details: [summaryLine(outcome), ...rows] });
}
const SETUP_TEXT = "Finish the UW connection setup step before Magic opens course pages.";
