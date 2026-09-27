/**
 * "What changed since yesterday": the stored change events (resource_changes) since a local date, by
 * code at 0 tokens. The same rows and notes the Today rail reads (core.query({view:"changes"}) and
 * changeNotes), for the student's current courses, or the one named or open.
 */
import { changeNotes } from "@magic/domain";
import type { ResourceChange } from "@magic/contracts";
import { baseArgs, courseLabel } from "../action-args";
import { isoDay, localDay } from "../dates";
import type { ActionSpec, ResolvedArgs } from "../types";

const DAY = 86_400_000;
/** At most this many changed items are listed, newest first. */
export const CHANGES_LIMIT = 50;

/** The instant a local calendar day (YYYY-MM-DD) starts in the zone. */
export function localMidnight(day: string, timeZone: string): Date {
  const guess = Date.parse(`${day}T00:00:00Z`);
  // The zone's offset at t: its wall clock read as UTC, minus t.
  const offset = (t: number) => localDay(new Date(t), timeZone) + localClockMs(t, timeZone) - t;
  // Two passes settle a day whose midnight sits near a daylight-saving change.
  let t = guess - offset(guess);
  t = guess - offset(t);
  return new Date(t);
}
function localClockMs(t: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(t));
  const get = (k: string) => Number(parts.find((p) => p.type === k)!.value);
  return ((get("hour") * 60 + get("minute")) * 60 + get("second")) * 1000;
}

const WORDS: Record<string, string> = {
  new: "new",
  updated: "updated",
  date_changed: "date changed",
  requirements_changed: "instructions changed",
  submitted: "submitted",
  graded: "graded",
  removed: "removed",
  restored: "restored",
};

export const changesSince: ActionSpec<ResolvedArgs> = {
  name: "changes.since",
  description: "List what changed in the student's courses since a date: moved deadlines, new announcements and items, changed instructions, grades (defaults to since yesterday).",
  slots: { date: "optional", course: "optional" },
  argsSchema: baseArgs,
  examples: ["what changed since yesterday", "anything new in cs 400 this week"],
  patterns: [
    /^(?:(?:what|whats|what's|what has|what have|has anything|have any|anything|any|show me|show|list|tell me)\s+)*(?:(?:been|got|gotten)\s+)?(?:changed|changes|new|updated|updates)(?:\s+(?:since|from|over|in|for|on))*$/,
  ],
  label: (a) => `What changed ${a.date ? (a.date.label === "yesterday" ? "since yesterday" : a.date.label) : "since yesterday"}${a.course ? ` · ${courseLabel(a.course)}` : ""}`,
  async run(a, ctx) {
    const today = localDay(ctx.now, ctx.timeZone);
    const monday = today - ((new Date(today).getUTCDay() + 6) % 7) * DAY;
    // "this week" reads back to Monday; any other phrase from its first day; none from yesterday.
    let fromDay = a.date ? (a.date.label === "this week" ? isoDay(monday) : a.date.from) : isoDay(today - DAY);
    // "since friday" is the last Friday: a bare weekday resolves forward for due dates, back for changes.
    if (a.date && /^[a-z]+day$/.test(a.date.label) && fromDay > isoDay(today)) fromDay = isoDay(Date.parse(`${fromDay}T00:00:00Z`) - 7 * DAY);
    const since = localMidnight(fromDay, ctx.timeZone).toISOString();
    if (since > ctx.now.toISOString()) return { since, label: a.date?.label ?? "since yesterday", items: [], message: "That date hasn't happened yet." };
    const courses = a.course ? [a.course] : ctx.resolve.courses();
    const key = (accountScope: string, courseId: string) => `${accountScope}\n${courseId}`;
    const labels = new Map(courses.map((c) => [key(c.accountScope, c.courseId), courseLabel(c)]));
    const rows = ctx.store.changes({ since, ...(a.course ? { courseId: a.course.courseId, accountScope: a.course.accountScope } : {}), limit: 2000 }).filter((c) => labels.has(key(c.accountScope, c.courseId)) && c.observedAt >= since);
    // A "new" row is news when the item itself is new (created in the window), or, without a
    // creation time, when its source had been read before: a first import of a course isn't news.
    const earliest = new Map<string, string>();
    const firstSeen = (sourceId: string) => {
      let at = earliest.get(sourceId);
      if (at === undefined) {
        at = ctx.store.changes({ sourceId, limit: 2000 }).reduce((m, c) => (c.observedAt < m ? c.observedAt : m), "￿");
        earliest.set(sourceId, at);
      }
      return at;
    };
    const kept = rows.filter((c) => {
      if (c.type !== "new") return true;
      const created = ctx.store.resource(c.resourceId)?.createdAt;
      return created ? created >= since : c.observedAt > firstSeen(c.sourceId);
    });
    const notes = changeNotes(kept.map((c) => ({ resourceId: c.resourceId, type: c.type, observedAt: c.observedAt, oldValues: c.oldValues, newValues: c.newValues })), ctx.now.toISOString(), ctx.timeZone);
    const byItem = new Map<string, ResourceChange[]>();
    for (const c of kept) byItem.set(c.resourceId, [...(byItem.get(c.resourceId) ?? []), c]);
    const items = [...byItem.entries()]
      .map(([resourceId, list]) => {
        const r = ctx.store.resource(resourceId);
        const sorted = [...list].sort((x, y) => x.observedAt.localeCompare(y.observedAt));
        const last = sorted.at(-1)!;
        return {
          resourceId,
          title: r?.title ?? "(removed item)",
          kind: r?.kind ?? null,
          course: labels.get(key(last.accountScope, last.courseId)) ?? "",
          url: r?.url ?? null,
          changes: [...new Set(sorted.map((c) => WORDS[c.type] ?? c.type))],
          notes: notes.get(resourceId) ?? [],
          observedAt: last.observedAt,
        };
      })
      .sort((x, y) => y.observedAt.localeCompare(x.observedAt))
      .slice(0, CHANGES_LIMIT);
    return { since, label: a.date?.label ?? "since yesterday", items, notFound: !items.length };
  },
};
