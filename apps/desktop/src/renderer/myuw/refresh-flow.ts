import type { AppBridge, CommandResult, SignInOutcome, Snapshot } from "@magic/contracts";
import type { Service } from "./model";

// owner: onboarding-recovery (My UW refresh). Refresh reads the planning sources; when a read in
// this refresh came back "sign in to UW", the app's own UW window opens (or an open one comes
// forward) for the student to finish, Duo included, and the read resumes. Nothing is filled or
// approved here: the window is the existing `signInUW`, the read the existing `syncPlanning`.

/** Codes the planning HTTP client gives a read that UW answered with its login (uw-planning-http). */
const SIGN_IN_CODES = new Set(["unauthorized", "login_redirect"]);
/** Enroll holds the private records, so it goes first; My UW is its own session check. */
const ORDER: Service[] = ["enroll", "myuw"];
const SERVICE: Record<string, Service> = { uw_enroll: "enroll", uw_dars: "enroll", uw_myuw: "myuw" };

export const serviceName: Record<Service, string> = { enroll: "Course Search & Enroll", myuw: "My UW" };

export type RefreshProgress =
  /** Reading the planning sources; `after` is the service just signed in to, if any. */
  | { stage: "reading"; after: Service | null }
  /** UW needs the student in the app's UW window. */
  | { stage: "signin"; service: Service }
  /** The window closed or failed before UW confirmed; the last read's results stand. */
  | { stage: "stopped"; service: Service; outcome: SignInOutcome };

type Bridge = Pick<AppBridge, "syncPlanning" | "signInUW">;

/**
 * Services whose private planning sources were read in this refresh and answered with UW's login.
 * Only sources touched since `before` count, so an older account's leftover row can't open a window.
 * A forbidden, rate-limited or failed read is not a sign-in problem and opens nothing.
 */
export function signInNeeded(before: Record<string, string>, snapshot: Snapshot | undefined): Service[] {
  const needed = new Set<Service>();
  for (const source of snapshot?.planning?.sources ?? []) {
    const service = SERVICE[source.source];
    if (!service || source.accountScope === "public" || before[source.id] === source.observedAt) continue;
    if (source.status === "blocked" && source.diagnostics.some((item) => SIGN_IN_CODES.has(item.code))) needed.add(service);
  }
  return ORDER.filter((service) => needed.has(service));
}

/**
 * Read → (sign in, read again) at most once per service. A second request while a UW window is
 * open joins that window (main brings it forward; singleFlight), so a retry never duplicates it.
 * Returns the last read's result; saved records are never cleared here.
 */
export async function refreshPlanningWithSignIn(
  bridge: Bridge,
  before: Record<string, string>,
  progress: (update: RefreshProgress) => void,
): Promise<CommandResult | undefined> {
  if (!bridge.syncPlanning) return undefined;
  progress({ stage: "reading", after: null });
  let result = await bridge.syncPlanning();
  const tried = new Set<Service>();
  for (;;) {
    const service = signInNeeded(before, result?.snapshot).find((candidate) => !tried.has(candidate));
    if (!service || !bridge.signInUW) return result;
    tried.add(service);
    progress({ stage: "signin", service });
    let outcome: SignInOutcome;
    try {
      outcome = await bridge.signInUW(service);
    } catch (error) {
      outcome = { status: "failed", service, reason: error instanceof Error && error.message.length < 200 ? error.message : undefined };
    }
    if (outcome.status !== "confirmed") {
      progress({ stage: "stopped", service, outcome });
      return result;
    }
    progress({ stage: "reading", after: service });
    result = await bridge.syncPlanning();
  }
}

/** One line for the page's status region; never says every source is current. */
export function progressText(update: RefreshProgress): string {
  if (update.stage === "reading")
    return update.after
      ? `Signed in to ${serviceName[update.after]}. Reading your UW records again…`
      : "Reading Course Search & Enroll, My UW and your degree audits…";
  if (update.stage === "signin")
    return `UW needs you to sign in to ${serviceName[update.service]}. Finish in the UW window, including Duo; the refresh continues after. Close that window to stop.`;
  return update.outcome.status === "cancelled"
    ? `The UW window was closed before ${serviceName[update.service]} confirmed sign-in. Saved records are unchanged; Refresh to try again.`
    : `${update.outcome.reason ?? `${serviceName[update.service]} sign-in didn't finish.`} Saved records are unchanged.`;
}
