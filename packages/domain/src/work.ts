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

/**
 * The single place open work is sorted. Home's Upcoming and the Today rail both read
 * this, so an assignment has one identity and appears in exactly one group.
 */
export function projectWork(
  resources: RailResource[],
  now: string,
  timeZone: string,
): WorkProjection {
  const nowMs = Date.parse(now);
  const today = localTime(now, timeZone).date;
  const out: WorkProjection = { overdue: [], dueToday: [], upcoming: [] };
  for (const r of resources) {
    if (
      r.kind !== "assignment" ||
      r.deleted ||
      r.completed ||
      r.submitted === true ||
      r.submission?.excused ||
      !r.deadline.planningAt
    )
      continue;
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
