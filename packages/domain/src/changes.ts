import type { DeadlineClaim } from "@magic/contracts";
import { resolveDeadline } from "./index";
import { localTime } from "./today-rail";

/** The fields of a stored ResourceChange the rail needs. */
export interface RailChange {
  resourceId: string;
  type: string;
  observedAt: string;
  oldValues: Record<string, unknown>;
  newValues: Record<string, unknown>;
}

const WINDOW_MS = 7 * 86400000;

/** The planning due time a change's values describe; null when due fields are present but empty. */
function dueIn(values: Record<string, unknown>): string | null | undefined {
  if (Array.isArray(values.deadlines))
    return resolveDeadline(values.deadlines as DeadlineClaim[]).planningAt;
  if ("dueAt" in values) return typeof values.dueAt === "string" ? values.dueAt : null;
  return undefined;
}
const hasDue = (c: RailChange) => dueIn(c.oldValues) !== undefined || dueIn(c.newValues) !== undefined;
const hasLock = (c: RailChange) => "lockAt" in c.oldValues || "lockAt" in c.newValues;
const same = (a: unknown, b: unknown) =>
  typeof a === "string" && typeof b === "string" ? Date.parse(a) === Date.parse(b) : a == b;

function describe(iso: string, now: string, timeZone: string) {
  const at = localTime(iso, timeZone);
  const today = localTime(now, timeZone).date;
  const h = Math.floor(at.min / 60), m = at.min % 60;
  const clock = `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  if (at.date === today) return clock;
  const days = Math.abs(Date.parse(at.date) - Date.parse(today)) / 86400000;
  const day = new Intl.DateTimeFormat("en-US", days <= 6 ? { weekday: "short", timeZone } : { month: "short", day: "numeric", timeZone }).format(new Date(iso));
  return `${day} ${clock}`;
}

/**
 * Short notes about what a source changed on each item in the last week: a moved or added
 * due date, a changed late cutoff, or updated instructions. First-import "new" records and
 * plain content edits are not reported. A date moved and then moved back produces no note.
 */
export function changeNotes(changes: RailChange[], now: string, timeZone: string): Map<string, string[]> {
  const nowMs = Date.parse(now);
  const byItem = new Map<string, RailChange[]>();
  for (const c of changes) {
    const age = nowMs - Date.parse(c.observedAt);
    if (!(age >= 0 && age <= WINDOW_MS)) continue;
    if (c.type !== "date_changed" && c.type !== "requirements_changed") continue;
    byItem.set(c.resourceId, [...(byItem.get(c.resourceId) ?? []), c]);
  }
  const out = new Map<string, string[]>();
  for (const [id, list] of byItem) {
    list.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
    const notes: string[] = [];
    const dates = list.filter((c) => c.type === "date_changed");
    const due = dates.filter(hasDue);
    if (due.length) {
      const before = dueIn(due[0]!.oldValues) ?? null;
      const after = dueIn(due.at(-1)!.newValues) ?? null;
      if (!same(before, after)) {
        if (before && after) notes.push(`Was due ${describe(before, now, timeZone)}`);
        else notes.push(after ? "Due date added" : "Due date removed");
      }
    }
    const lock = dates.filter(hasLock);
    if (lock.length && !same(lock[0]!.oldValues.lockAt ?? null, lock.at(-1)!.newValues.lockAt ?? null))
      notes.push("Late cutoff changed");
    if (list.some((c) => c.type === "requirements_changed")) notes.push("Instructions updated");
    if (notes.length) out.set(id, notes);
  }
  return out;
}
