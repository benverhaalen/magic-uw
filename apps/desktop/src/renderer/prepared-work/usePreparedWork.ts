import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { WorkSet } from "@magic/contracts";
import { classifyLaunchError, counts, noticeLine, outcomeFromError, outcomeFromReceipt, retryableIds, sendingOutcome, type LaunchProblem } from "./launch-model";
import { getEntry, getVersion, putOutcome, subscribe, clearEntry, patchEntry, noteReturn } from "./session-store";

import { createPreparationCache } from "./prepare-cache";
const preparationCache = createPreparationCache<WorkSet | undefined>();

export type PrepareState =
  | { kind: "loading" }
  | { kind: "ready"; set: WorkSet }
  | { kind: "error"; problem: { kind: LaunchProblem; message: string; raw: string } };

export interface PreparedWorkOptions {
  /** False while a lazy tile is off screen: nothing is prepared yet. */
  enabled?: boolean;
  /** Plain confirmation with nothing to act on, for the shell's notification. */
  onNotice?: (text: string) => void;
  /** Original text of an unexpected failure, for the shell's global failure contract. */
  onFailure?: (detail: string) => void;
}

/**
 * One controller for Start work: prepare the reviewed set, send it, keep a
 * truthful per-destination outcome for the session, narrow retry to failures,
 * and notice when the student comes back to Magic.
 */
export function usePreparedWork(resourceId: string, refreshKey: string, anchor: string, options: PreparedWorkOptions = {}) {
  const enabled = options.enabled ?? true;
  const callbacks = useRef(options);
  callbacks.current = options;
  const [prepare, setPrepare] = useState<PrepareState>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const consumedReload = useRef(0);
  const [local, setLocal] = useState(false);
  const busy = useRef(false);
  const reloadedFor = useRef<string | null>(null);
  useSyncExternalStore(subscribe, getVersion, getVersion);
  const entry = getEntry(resourceId);

  useEffect(() => {
    if (!enabled) return;
    let current = true;
    const force = reload !== consumedReload.current;
    consumedReload.current = reload;
    preparationCache.read(`${resourceId}:${refreshKey}`, async () => (await window.magic.execute({ type: "work-set", id: resourceId })).workSet, force).then(set => {
      if (!current) return;
      setPrepare(set ? { kind: "ready", set } : { kind: "error", problem: { kind: "unavailable", message: "This item has nothing to open.", raw: "" } });
    }).catch(cause => {
      if (!current) return;
      const problem = classifyLaunchError(cause);
      if (problem.kind === "unknown") callbacks.current.onFailure?.(problem.raw);
      setPrepare({ kind: "error", problem: problem.kind === "unknown" ? { ...problem, message: "Magic could not prepare this work." } : problem });
    });
    return () => { current = false; };
  }, [resourceId, refreshKey, reload, enabled]);

  const set = prepare.kind === "ready" ? prepare.set : null;
  const outcome = entry?.outcome ?? null;
  /** The outcome describes different destinations than the ones on screen now. */
  const earlier = !!(outcome && set && outcome.previewHash !== set.previewHash);
  /** Shared across Home and detail: a launch started on either surface holds both. */
  const pending = local || !!entry?.launching || (!!outcome && counts(outcome).pending > 0);
  const canLaunch = !!(set && window.magic.startWork);

  // The list changed under a launch (thrown or partway through a receipt): every
  // surface still showing that list reloads once, so no retry of a dead list is offered.
  const staleHash = outcome?.problem?.kind === "changed" && set?.previewHash === outcome.previewHash ? outcome.previewHash : null;
  useEffect(() => {
    if (!staleHash || reloadedFor.current === staleHash) return;
    reloadedFor.current = staleHash;
    setReload(value => value + 1);
  }, [staleHash]);

  const launch = useCallback(async (only?: string[]) => {
    if (busy.current || getEntry(resourceId)?.launching || !set || !window.magic.startWork) return;
    const hash = set.previewHash;
    const previous = getEntry(resourceId)?.outcome ?? null;
    busy.current = true; setLocal(true);
    putOutcome(resourceId, sendingOutcome(set, previous, only), { anchor, awaitingReturn: true, left: false, returnedAt: null, launching: true });
    try {
      const receipt = await window.magic.startWork(resourceId, hash, only);
      const next = outcomeFromReceipt(set, receipt, previous, only);
      const real = next.mode === "opened" && counts(next).sent > 0;
      const left = getEntry(resourceId)?.left ?? false;
      putOutcome(resourceId, next, { awaitingReturn: real, left: real && left, launching: false });
      // Already back before the handoff call settled: record the return now.
      if (real && left && document.hasFocus()) noteReturn();
      const notice = noticeLine(next);
      if (notice) callbacks.current.onNotice?.(notice);
    } catch (cause) {
      const next = outcomeFromError(set, cause, previous, only);
      putOutcome(resourceId, next, { awaitingReturn: next.problem?.kind === "unknown", launching: false });
      if (next.problem?.kind === "unknown") callbacks.current.onFailure?.(next.problem.raw ?? "");
    } finally {
      busy.current = false;
      if (getEntry(resourceId)?.launching) patchEntry(resourceId, { launching: false });
      setLocal(false);
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
    acknowledgeReturn: () => { if (getEntry(resourceId)?.returnedAt) patchEntry(resourceId, { returnedAt: null }); },
  };
}
export type PreparedWorkController = ReturnType<typeof usePreparedWork>;
