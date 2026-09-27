import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { WorkSet } from "@magic/contracts";
import { outcomeFromError, outcomeFromReceipt, retryableIds, sendingOutcome, counts } from "./launch-model";
import { getEntry, getVersion, putOutcome, subscribe, clearEntry, patchEntry, noteReturn } from "./session-store";

export type PrepareState =
  | { kind: "loading" }
  | { kind: "ready"; set: WorkSet }
  | { kind: "error"; message: string };

/**
 * One controller for Start work: prepare the reviewed set, send it, keep a
 * truthful per-destination outcome for the session, narrow retry to failures,
 * and notice when the student comes back to Magic.
 */
export function usePreparedWork(resourceId: string, refreshKey: string, anchor: string) {
  const [prepare, setPrepare] = useState<PrepareState>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(true);
  const currentHash = useRef<string | null>(null);
  useSyncExternalStore(subscribe, getVersion, getVersion);
  const entry = getEntry(resourceId);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let current = true;
    window.magic.execute({ type: "work-set", id: resourceId }).then(result => {
      if (!current) return;
      const set = result.workSet;
      currentHash.current = set?.previewHash ?? null;
      setPrepare(set ? { kind: "ready", set } : { kind: "error", message: "This item has nothing to open." });
    }).catch(cause => {
      if (!current) return;
      currentHash.current = null;
      setPrepare({ kind: "error", message: cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") : "Could not prepare this work." });
    });
    return () => { current = false; };
  }, [resourceId, refreshKey, reload]);

  const set = prepare.kind === "ready" ? prepare.set : null;
  const outcome = entry?.outcome ?? null;
  /** The outcome describes different destinations than the ones on screen now. */
  const earlier = !!(outcome && set && outcome.previewHash !== set.previewHash);
  const canLaunch = !!(set && window.magic.startWork);

  const launch = useCallback(async (only?: string[]) => {
    if (busy.current || !set || !window.magic.startWork) return;
    const hash = set.previewHash;
    const previous = getEntry(resourceId)?.outcome ?? null;
    busy.current = true; setPending(true);
    putOutcome(resourceId, sendingOutcome(set, previous, only), { anchor, awaitingReturn: true, left: false, returnedAt: null });
    try {
      const receipt = await window.magic.startWork(resourceId, hash, only);
      const next = outcomeFromReceipt(set, receipt, previous, only);
      const real = next.mode === "opened" && counts(next).sent > 0;
      const left = getEntry(resourceId)?.left ?? false;
      putOutcome(resourceId, next, { awaitingReturn: real, left: real && left });
      // Already back before the handoff call settled: record the return now.
      if (real && left && document.hasFocus()) noteReturn();
    } catch (cause) {
      const next = outcomeFromError(set, cause, previous, only);
      putOutcome(resourceId, next, { awaitingReturn: next.problem?.kind === "unknown" });
      if (next.problem?.kind === "changed" && mounted.current && currentHash.current === hash) setReload(value => value + 1);
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }, [set, resourceId, anchor]);

  return {
    prepare, set, outcome, earlier, pending, canLaunch,
    returnedAt: entry?.returnedAt ?? null,
    failedIds: outcome && !earlier ? retryableIds(outcome) : [],
    launch,
    retryFailed: () => outcome && void launch(retryableIds(outcome)),
    refresh: () => setReload(value => value + 1),
    dismiss: () => clearEntry(resourceId),
    acknowledgeReturn: () => patchEntry(resourceId, { returnedAt: null }),
  };
}
export type PreparedWorkController = ReturnType<typeof usePreparedWork>;
