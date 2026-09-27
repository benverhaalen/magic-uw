import type { LaunchOutcome } from "./launch-model";

/**
 * Session-only launch outcomes, keyed by assignment. The Home row and the
 * assignment detail read the same entry, so leaving one surface does not
 * erase what happened. Mirrors main's bounded, non-persistent failure record;
 * nothing here is written to disk or sent anywhere.
 */
export interface LaunchEntry {
  outcome: LaunchOutcome;
  /** data-focus-key of the control that started the launch, for focus return. */
  anchor: string | null;
  /** A real handoff is underway or done and the student has not come back yet. */
  awaitingReturn: boolean;
  /** The Magic window lost focus after the launch started. */
  left: boolean;
  /** Set when the student comes back to Magic after a real handoff. */
  returnedAt: string | null;
}

const LIMIT = 20;
const entries = new Map<string, LaunchEntry>();
const listeners = new Set<() => void>();
let version = 0;

function emit() { version++; for (const listener of listeners) listener(); }

export function subscribe(listener: () => void) {
  listeners.add(listener);
  installWindowWatch();
  return () => { listeners.delete(listener); };
}
export function getVersion() { return version; }
export function getEntry(resourceId: string) { return entries.get(resourceId) ?? null; }

export function putOutcome(resourceId: string, outcome: LaunchOutcome, patch: Partial<Omit<LaunchEntry, "outcome">> = {}) {
  const current = entries.get(resourceId);
  entries.delete(resourceId);
  if (entries.size >= LIMIT) entries.delete(entries.keys().next().value!);
  entries.set(resourceId, {
    anchor: current?.anchor ?? null, awaitingReturn: current?.awaitingReturn ?? false,
    left: current?.left ?? false, returnedAt: current?.returnedAt ?? null,
    ...patch, outcome,
  });
  emit();
}
export function patchEntry(resourceId: string, patch: Partial<Omit<LaunchEntry, "outcome">>) {
  const current = entries.get(resourceId);
  if (!current) return;
  entries.set(resourceId, { ...current, ...patch });
  emit();
}
export function clearEntry(resourceId: string) {
  if (entries.delete(resourceId)) emit();
}
/** Test seam only. */
export function resetStore() { entries.clear(); emit(); }

/** Called when the Magic window regains focus. Returns anchors to restore. */
export function noteReturn(now = new Date()) {
  const anchors: string[] = [];
  let changed = false;
  for (const [id, entry] of entries) {
    if (!entry.awaitingReturn || !entry.left) continue;
    entries.set(id, { ...entry, awaitingReturn: false, left: false, returnedAt: now.toISOString() });
    if (entry.anchor) anchors.push(entry.anchor);
    changed = true;
  }
  if (changed) emit();
  return anchors;
}
export function noteLeave() {
  let changed = false;
  for (const [id, entry] of entries)
    if (entry.awaitingReturn && !entry.left) { entries.set(id, { ...entry, left: true }); changed = true; }
  if (changed) emit();
}

let watching = false;
function installWindowWatch() {
  if (watching || typeof window === "undefined") return;
  watching = true;
  window.addEventListener("blur", noteLeave);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") noteLeave(); else back();
  });
  window.addEventListener("focus", back);
}
function back() {
  const anchors = noteReturn();
  const anchor = anchors.at(-1);
  if (!anchor) return;
  // Keep the student's place: only move focus when nothing meaningful holds it.
  requestAnimationFrame(() => {
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const target = Array.from(document.querySelectorAll<HTMLElement>("[data-focus-key]")).find(node => node.dataset.focusKey === anchor);
    if (!target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView?.({ block: "nearest" });
  });
}
