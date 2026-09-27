import { resolveDeadline } from "./index";
import type { RailResource, EffortBand } from "./today-rail";
import { effortBand, localTime } from "./today-rail";

/** One open, dated assignment with the facts Upcoming rows and the Today rail both need. */
export interface WorkItem {
  id: string;
  title: string;
  courseId: string;
  courseName: string;
  /** Planning time: the due date, or the earlier of disagreeing dates. */
  dueAt: string;
  dueDate: string;
  dueMin: number;
  conflict: boolean;
  lockAt: string | null;
  points: number | null;
  effort: EffortBand | null;
  isExam: boolean;
  resource: RailResource;
}
export interface WorkProjection {
  /** Past due but still accepted: no lock date, or a lock date still ahead. */
  overdue: WorkItem[];
  /** Due later today. Shown once, in Today. */
  dueToday: WorkItem[];
  /** Due after today, soonest first. Home's Upcoming section. */
  upcoming: WorkItem[];
}

const OVERDUE_WINDOW_MS = 7 * 86400000;

/** Where a saved copy came from; lets copies of one Canvas assignment be recognised. */
export interface WorkSource {
  id: string;
  accountScope: string;
  scope: string;
}
// Canvas lists one assignment in several places. The assignment and quiz lists are the trusted
// copy; to-do, upcoming, and activity copies carry no submission data (same order as agenda.ts).
const AUTHORITY: Record<string, number> = {
  assignments: 0,
  quizzes: 0,
  "account-todo": 1,
  "account-upcoming-events": 2,
  "account-activity": 3,
};
const DONE_STATES = new Set(["submitted", "graded", "pending_review", "complete"]);
/** Done if any copy says so: completed, submitted, a submission time, or a done workflow state. */
function isDone(r: RailResource): boolean {
  return (
    r.completed ||
    r.submitted === true ||
    !!r.submission?.excused ||
    !!r.submission?.submittedAt ||
    DONE_STATES.has(r.submission?.workflowState ?? "")
  );
}

/**
 * The single place open work is sorted. Home's Upcoming and the Today rail both read
 * this, so an assignment has one identity and appears in exactly one group.
 */
export function projectWork(
  resources: RailResource[],
  now: string,
  timeZone: string,
  sources?: WorkSource[],
): WorkProjection {
  const nowMs = Date.parse(now);
  const today = localTime(now, timeZone).date;
  const out: WorkProjection = { overdue: [], dueToday: [], upcoming: [] };
  // One item per Canvas assignment: group its copies by account, course, and id.
  const byId = new Map((sources ?? []).map((s) => [s.id, s]));
  const scopeOf = (r: RailResource) => byId.get(r.sourceId ?? "")?.scope.split(":")[0] ?? "";
  const groups = new Map<string, RailResource[]>();
  for (const r of resources) {
    if (r.kind !== "assignment" || r.deleted) continue;
    const src = byId.get(r.sourceId ?? "");
    // Unknown provenance cannot establish cross-source identity. The renderer's
    // canonical schedule family may also carry a personal date; never regroup it.
    const knownScope = scopeOf(r);
    const key = !("scheduleDeadline" in r) && r.externalId && r.courseId && src?.accountScope && knownScope in AUTHORITY
      ? JSON.stringify([knownScope === "quizzes" ? "Q" : "A", src.accountScope, r.courseId, r.externalId])
      : `id:${r.id}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const copies of groups.values()) {
    if (copies.some(isDone)) continue;
    copies.sort((a, b) => (AUTHORITY[scopeOf(a)] ?? 9) - (AUTHORITY[scopeOf(b)] ?? 9));
    let r = copies.find((c) => c.deadline.planningAt) ?? copies[0]!;
    if (copies.length > 1) {
      const claims = [...new Map(copies.flatMap(c => c.deadline.claims).map(c => [JSON.stringify(c), c])).values()];
      const resolved = resolveDeadline(claims);
      const dates = [...new Set(copies.map(c => c.deadline.planningAt).filter((d): d is string => !!d))].sort();
      const conflict = resolved.conflict || copies.some(c => c.deadline.conflict) || dates.length > 1;
      r = { ...r, deadline: { ...resolved, conflict,
        dueAt: conflict ? null : resolved.dueAt,
        planningAt: conflict ? dates[0] ?? resolved.planningAt : resolved.planningAt ?? r.deadline.planningAt,
        unresolved: copies.flatMap(c => c.deadline.unresolved ?? []),
      } };
    }
    if (!r.deadline.planningAt) continue;
    const dueAt = r.deadline.planningAt;
    const dueMs = Date.parse(dueAt);
    const lockMs = r.lockAt ? Date.parse(r.lockAt) : null;
    const at = localTime(dueAt, timeZone);
    const effort = effortBand(r);
    const item: WorkItem = {
      id: r.id,
      title: r.title,
      courseId: r.courseId,
      courseName: r.courseName,
      dueAt,
      dueDate: at.date,
      dueMin: at.min,
      conflict: r.deadline.conflict,
      lockAt: r.lockAt ?? null,
      points: r.points ?? null,
      effort,
      isExam: effort?.category === "exam",
      resource: r,
    };
    if (dueMs <= nowMs) {
      if ((lockMs == null || lockMs > nowMs) && nowMs - dueMs <= OVERDUE_WINDOW_MS)
        out.overdue.push(item);
    } else if (at.date === today) out.dueToday.push(item);
    else out.upcoming.push(item);
  }
  const byDue = (a: WorkItem, b: WorkItem) => a.dueAt.localeCompare(b.dueAt) || a.title.localeCompare(b.title);
  out.overdue.sort(byDue);
  out.dueToday.sort(byDue);
  out.upcoming.sort(byDue);
  return out;
}
