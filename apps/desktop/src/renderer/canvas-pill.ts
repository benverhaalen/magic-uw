import { useSyncExternalStore } from "react";
import type { Snapshot, SourceHealth } from "@magic/contracts";
import { buildSourcesModel, isStale } from "./sources/model";

// owner: onboarding-recovery (shell Canvas pill). The white Canvas pill in the upper right says
// "Up to Date" only when every relevant saved Canvas account was reachable and read fresh; every
// other state has its own word. The renderer has no authoritative current-account or session
// selector (Snapshot carries none; main's sessionGeneration never crosses; the planning account
// link is an identity match, not the live session), so no account is guessed: each relevant
// account is judged by the Sources page's own Canvas rule (buildSourcesModel) and the worst wins.

export type CanvasPillState = "up_to_date" | "refreshing" | "signing_in" | "offline" | "expired" | "partial" | "stale" | "unreachable";
export interface CanvasPill { state: CanvasPillState; label: string; description: string; action: "signin" | "sources" | null }

/** A Canvas batch still marked "reading" this long after its attempt is an interrupted read, not a live one. */
const READING_WINDOW_MS = 10 * 60_000;

const PILLS: Record<CanvasPillState, Omit<CanvasPill, "state">> = {
  up_to_date: { label: "Up to Date", description: "Canvas is up to date. Open connected sources.", action: "sources" },
  refreshing: { label: "Refreshing…", description: "Reading Canvas now. Saved coursework stays available.", action: null },
  signing_in: { label: "Signing in…", description: "Finish signing in to Canvas in the UW window.", action: null },
  offline: { label: "Offline", description: "This computer is offline. Saved Canvas coursework is still here.", action: "sources" },
  expired: { label: "Sign in to", description: "Sign in to Canvas. Your UW session ended; saved coursework is still here.", action: "signin" },
  partial: { label: "Partly read", description: "Canvas was not read completely. Open connected sources for details.", action: "sources" },
  stale: { label: "Out of date", description: "Canvas has not been read recently. Open connected sources.", action: "sources" },
  unreachable: { label: "Can’t reach", description: "The last Canvas check did not finish. Saved coursework is still here.", action: "sources" },
};
/** Every label the pill can show; the shell reserves the widest so a state change never moves the header. */
export const CANVAS_PILL_LABELS = Object.values(PILLS).map((pill) => pill.label);

type PillSnapshot = Pick<Snapshot, "sources" | "syncRuns" | "planning" | "fixtureMode"> & { resources?: unknown };
type AccountState = "connected" | "needs_sign_in" | "error" | "partial" | "stale" | "unknown";
/** Worst first. "unknown" (no rule result) is never Up to Date. */
const SEVERITY: AccountState[] = ["needs_sign_in", "error", "partial", "unknown", "stale", "connected"];
const isConnectionRow = (s: SourceHealth) => s.accountScope.startsWith("connection:");

/**
 * Each saved Canvas account judged on its own rows plus the account-independent connection rows.
 * Relevant accounts: those with a course site that is current or included (left-out sites stay out
 * of Today and AI context, so they don't hold the pill back). When no account has one (no course
 * choice yet, or no course rows loaded), every saved account counts. Order is by account scope,
 * never by recency: a newer success can't hide an older account's failure.
 */
export function canvasAccountStates(snapshot: PillSnapshot, now: Date): Array<{ accountScope: string | null; state: AccountState; relevant: boolean }> {
  const canvas = snapshot.sources.filter((s) => s.kind === "canvas");
  const connection = canvas.filter(isConnectionRow);
  const scopes = [...new Set(canvas.filter((s) => !isConnectionRow(s)).map((s) => s.accountScope))].sort();
  const judge = (sources: SourceHealth[]) => {
    const model = buildSourcesModel({ ...snapshot, sources, resources: snapshot.resources as never }, { now, outlook: { icsConnected: null } })
      .connections.find((c) => c.id === "canvas");
    const state = model?.state;
    return {
      state: (state === "connected" || state === "needs_sign_in" || state === "error" || state === "partial" || state === "stale" ? state : "unknown") as AccountState,
      included: Boolean(model?.courses.some((c) => c.relevance === "current" || c.relevance === "included")),
    };
  };
  if (!scopes.length) return connection.length ? [{ accountScope: null, state: judge(connection).state, relevant: true }] : [];
  const judged = scopes.map((accountScope) => {
    const own = canvas.filter((s) => s.accountScope === accountScope);
    const judgement = judge([...connection, ...own]);
    // Freshness from the account's own rows: the shared connection row's recent success says the
    // session answered, not that this account's coursework was read.
    const newestOwn = own.map((s) => s.lastSuccessAt).filter((at): at is string => Boolean(at)).sort().at(-1) ?? null;
    return { accountScope, ...judgement, state: judgement.state === "connected" && isStale(newestOwn, now) ? "stale" as const : judgement.state };
  });
  const anyIncluded = judged.some((a) => a.included);
  return judged.map(({ accountScope, state, included }) => ({ accountScope, state, relevant: !anyIncluded || included }));
}

export function canvasPill(
  snapshot: PillSnapshot,
  options: { now: Date; online: boolean; signInStage: "idle" | "signin" | "checking" },
): CanvasPill | null {
  const sources = snapshot.sources.filter((s) => s.kind === "canvas");
  if (snapshot.fixtureMode || !sources.length) return null;
  const pill = (state: CanvasPillState): CanvasPill => ({ state, ...PILLS[state] });
  if (options.signInStage === "signin") return pill("signing_in");
  if (options.signInStage === "checking") return pill("refreshing");
  if (!options.online) return pill("offline");
  const reading = sources.some((s) => s.progress?.phase === "reading" && options.now.getTime() - Date.parse(s.lastAttemptAt) < READING_WINDOW_MS);
  if (reading) return pill("refreshing");
  const relevant = canvasAccountStates(snapshot, options.now).filter((a) => a.relevant);
  const worst = SEVERITY.find((state) => relevant.some((a) => a.state === state));
  switch (worst) {
    case "connected": return pill("up_to_date");
    case "needs_sign_in": return pill("expired");
    case "error": return pill("unreachable");
    case "stale": return pill("stale");
    default: return pill("partial"); // partial, unknown, or nothing judged: never Up to Date
  }
}

const subscribe = (notify: () => void) => {
  window.addEventListener("online", notify);
  window.addEventListener("offline", notify);
  return () => { window.removeEventListener("online", notify); window.removeEventListener("offline", notify); };
};
/** The browser's own online/offline events; no polling. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, () => navigator.onLine, () => true);
}
