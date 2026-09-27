import type { PlanningMeeting, ResourceView } from "@magic/contracts";
import {
  isDone,
  whenDue,
  courseDeadlineDisplay,
  type CourseFactKind,
  type CoursePage,
} from "../../../../../packages/domain/src/course-page";
import { localTime } from "../../../../../packages/domain/src/today-rail";

// Pure presentation choices for the course page. The read model stays in packages/domain.

/** One Canvas object on the course page: the record the row opens plus every saved copy of it. */
export interface WorkEntry {
  key: string;
  resource: ResourceView;
  /** Every saved resource with this identity (the same assignment read from several Canvas lists). */
  copies: ResourceView[];
  /** Saved deadline claims or same-object copies disagree; never a confirmed date cue. */
  dueDiffers: boolean;
  /** Another entry on this page has the same title but a different Canvas id. */
  sameTitleElsewhere: boolean;
}
export interface WorkGroup {
  id: string | null;
  name: string;
  upcoming: WorkEntry[];
  undated: WorkEntry[];
  past: WorkEntry[];
}
export interface NextItem {
  entry: WorkEntry;
  group: string;
  /** Verified Canvas assignment group; null when the assignment has none (rendered neutral). */
  groupId: string | null;
}
export interface CourseWork {
  groups: WorkGroup[];
  next: NextItem[];
  /** Coursework minus what Next up already shows, so no item is listed twice. */
  rest: WorkGroup[];
  counts: { upcoming: number; undatedOpen: number; total: number };
}

/**
 * Canonical identity, the same key the Calendar uses: account, course and the Canvas id. A Canvas
 * assignment read from the assignments list and from to-do or activity lists is one object with one
 * URL. Title, due time and points never make two resources the same.
 */
export function workKey(accountScope: string, r: ResourceView): string {
  return r.kind === "assignment" && r.externalId
    ? JSON.stringify([accountScope, r.courseId, r.externalId])
    : JSON.stringify(["resource", r.id]);
}

// The copy with a known submission state is the direct assignment record; otherwise the newest.
function primary(copies: ResourceView[]): ResourceView {
  const known = (r: ResourceView) => Number(r.submitted === true || r.submitted === false || !!r.submission);
  return [...copies].sort(
    (a, b) => known(b) - known(a) || b.capturedAt.localeCompare(a.capturedAt) || a.id.localeCompare(b.id),
  )[0]!;
}

/**
 * The page's coursework with one entry per Canvas object. Each entry sits where the domain placed
 * its primary copy (group and upcoming/undated/past), so a submitted direct record is not shown
 * as upcoming because an activity-list copy lacks submission data.
 */
export function courseWork(page: Pick<CoursePage, "groups" | "accountScope">, limit = 4): CourseWork {
  type Placed = { resource: ResourceView; group: number; bucket: "upcoming" | "undated" | "past" };
  const placed = new Map<string, Placed[]>();
  page.groups.forEach((g, group) => {
    for (const bucket of ["upcoming", "undated", "past"] as const)
      for (const resource of g[bucket]) {
        const key = workKey(page.accountScope, resource);
        placed.set(key, [...(placed.get(key) ?? []), { resource, group, bucket }]);
      }
  });
  const groups: WorkGroup[] = page.groups.map((g) => ({ id: g.id, name: g.name, upcoming: [], undated: [], past: [] }));
  const titles = new Map<string, Set<string>>();
  for (const [key, all] of placed) {
    const set = titles.get(all[0]!.resource.title) ?? new Set<string>();
    titles.set(all[0]!.resource.title, set.add(key));
  }
  for (const [key, all] of placed) {
    const copies = all.map((p) => p.resource);
    const main = primary(copies);
    const at = all.find((p) => p.resource === main)!;
    groups[at.group]![at.bucket].push({
      key,
      resource: main,
      copies,
      dueDiffers: courseDeadlineDisplay(main, copies).conflict,
      sameTitleElsewhere: (titles.get(main.title)?.size ?? 0) > 1,
    });
  }
  const byDue = (a: WorkEntry, b: WorkEntry) =>
    Date.parse(whenDue(a.resource)!) - Date.parse(whenDue(b.resource)!) || a.resource.title.localeCompare(b.resource.title);
  for (const g of groups) {
    g.upcoming.sort(byDue);
    g.past.sort((a, b) => -byDue(a, b) || 0);
    g.undated.sort((a, b) => a.resource.title.localeCompare(b.resource.title));
  }
  const next = groups
    .flatMap((g) => g.upcoming.map((entry) => ({ entry, group: g.name, groupId: g.id })))
    .sort((a, b) => byDue(a.entry, b.entry))
    .slice(0, limit);
  const shown = new Set(next.map((n) => n.entry.key));
  const rest = groups
    .map((g) => ({ ...g, upcoming: g.upcoming.filter((e) => !shown.has(e.key)) }))
    .filter((g) => g.upcoming.length || g.undated.length || g.past.length);
  const nonEmpty = groups.filter((g) => g.upcoming.length || g.undated.length || g.past.length);
  return {
    groups: nonEmpty,
    next,
    rest,
    counts: {
      upcoming: groups.reduce((n, g) => n + g.upcoming.length, 0),
      undatedOpen: groups.reduce((n, g) => n + g.undated.filter((e) => !isDone(e.resource)).length, 0),
      total: placed.size,
    },
  };
}

/** Dated, unfinished work across every group, soonest first, one row per Canvas object. */
export function nextUp(page: Pick<CoursePage, "groups" | "accountScope">, limit = 4): NextItem[] {
  return courseWork(page, limit).next;
}

/**
 * The course's verified assignment groups in the shape the shared type-hue mapper
 * (`createAssignmentTypeHues`) reads, for when the full snapshot mapper is not bound. Groups keep
 * Canvas order; they are listed under each source the page's rows come from, because the page does
 * not carry the group resources' own source. Titles never type anything.
 */
export function pageTypeGroups(
  page: Pick<CoursePage, "weights" | "courseId">,
  work: Pick<CourseWork, "groups">,
): { sourceId: string; courseId: string; externalId: string; assignmentGroup: { position: number }; title: string }[] {
  const sources = new Set(
    work.groups.flatMap((g) => [...g.upcoming, ...g.undated, ...g.past]).map((e) => e.resource.sourceId),
  );
  return [...sources].flatMap((sourceId) =>
    page.weights.map((w, position) => ({
      sourceId,
      courseId: page.courseId,
      externalId: w.groupId,
      assignmentGroup: { position },
      title: w.name,
    })),
  );
}

/** One hue per verified group: from a row of that group, else from the first row source. */
export function groupHues<H>(
  page: Pick<CoursePage, "weights" | "courseId">,
  work: Pick<CourseWork, "groups">,
  hueOf: (r: { sourceId: string; courseId: string; assignmentGroupId: string }) => H | null,
): Map<string, H> {
  const entries = work.groups.flatMap((g) => [...g.upcoming, ...g.undated, ...g.past]);
  const fallbackSource = entries[0]?.resource.sourceId;
  const hues = new Map<string, H>();
  for (const w of page.weights) {
    const row = entries.find((e) => e.resource.assignmentGroupId === w.groupId)?.resource;
    const sourceId = row?.sourceId ?? fallbackSource;
    const hue = sourceId ? hueOf({ sourceId, courseId: page.courseId, assignmentGroupId: w.groupId }) : null;
    if (hue != null) hues.set(w.groupId, hue);
  }
  return hues;
}

/**
 * The due time as a local civil date ('YYYY-MM-DD') in the given zone, for the shared deadline
 * recipe. Null when the due time is missing or unreadable, which the recipe treats as unknown.
 */
export function dueCivilDate(resource: ResourceView, timeZone: string): string | null {
  const due = whenDue(resource);
  return due && !Number.isNaN(Date.parse(due)) ? localTime(due, timeZone).date : null;
}

/** Verified class meetings for exactly this course (enrollment record), bound by the integrator. */
export interface CourseSchedule {
  meetings: PlanningMeeting[];
  /** The source says this is every meeting; without it no occurrence can be called "next". */
  complete: boolean;
}
export interface NextClass {
  date: string;
  startMinute: number;
  endMinute: number;
  location: string | null;
}

/**
 * The next scheduled class meeting after `now`, from verified meetings only. Returns null when the
 * schedule is incomplete, asynchronous, unconfirmed or has no occurrence in the next two weeks.
 */
export function nextClass(schedule: CourseSchedule | null | undefined, now: string): NextClass | null {
  if (!schedule?.complete) return null;
  let best: NextClass | null = null;
  for (const m of schedule.meetings) {
    if (m.kind !== "class" || m.mode !== "scheduled" || m.startMinute == null || m.endMinute == null || !m.days.length)
      continue;
    const here = localTime(now, m.timezone);
    const base = Date.parse(`${here.date}T00:00:00Z`);
    for (let offset = 0; offset < 14; offset++) {
      const day = new Date(base + offset * 86_400_000);
      const date = day.toISOString().slice(0, 10);
      const weekday = day.getUTCDay() || 7;
      if (!m.days.includes(weekday)) continue;
      if ((m.startDate && date < m.startDate) || (m.endDate && date > m.endDate)) continue;
      if (offset === 0 && m.startMinute <= here.min) continue;
      const candidate = { date, startMinute: m.startMinute, endMinute: m.endMinute, location: m.location };
      if (!best || date < best.date || (date === best.date && m.startMinute < best.startMinute)) best = candidate;
      break;
    }
  }
  return best;
}

export interface GradeRow {
  groupId: string;
  name: string;
  /** Exactly as listed in Canvas; null when the group has no weight. */
  weight: number | null;
  /** Bar length on a fixed 0 to 100 scale; never rescaled to the listed total. */
  bar: number;
  /** "Drops lowest 1", "drops highest 1", joined; empty when Canvas lists no rule. */
  rules: string;
}
export interface GradeWeights {
  rows: GradeRow[];
  /** Sum of the listed weights, shown when it is not 100 or some groups have no weight. */
  listedTotal: number;
  unlisted: number;
}

/**
 * Canvas assignment-group weights as listed. Nothing is normalized: a partial total stays partial,
 * and no row claims what a single assignment is worth.
 */
export function gradeWeights(page: Pick<CoursePage, "weights">): GradeWeights | null {
  if (!page.weights.some((w) => w.weight != null)) return null;
  const rows = page.weights.map((w) => ({
    groupId: w.groupId,
    name: w.name,
    weight: w.weight,
    bar: w.weight == null ? 0 : Math.max(0, Math.min(100, w.weight)),
    rules: [
      w.dropLowest ? `drops lowest ${w.dropLowest}` : "",
      w.dropHighest ? `drops highest ${w.dropHighest}` : "",
    ]
      .filter(Boolean)
      .join(", "),
  }));
  return {
    rows,
    listedTotal: Math.round(rows.reduce((n, w) => n + (w.weight ?? 0), 0) * 100) / 100,
    unlisted: rows.filter((w) => w.weight == null).length,
  };
}

const factNames: Record<CourseFactKind, string> = {
  ai_policy: "AI use policy",
  grading: "grading breakdown",
  assessment: "exam details",
  topic: "topics",
};

/** Facts worth a row: found or conflicting. Grading also counts when Canvas lists group weights. */
export function shownFacts(page: Pick<CoursePage, "facts" | "weights">): CourseFactKind[] {
  const hasWeights = page.weights.some((w) => w.weight != null);
  return (["ai_policy", "grading", "assessment", "topic"] as const).filter(
    (kind) => page.facts[kind].state !== "not_found" || (kind === "grading" && hasWeights),
  );
}

/**
 * The facts the captured sources did not answer, named once instead of one empty row each.
 * Topics are optional and never listed as missing.
 */
export function unknownFacts(page: Pick<CoursePage, "facts" | "weights">): {
  names: string[];
  aiMissing: boolean;
} {
  const shown = new Set(shownFacts(page));
  const kinds = (["ai_policy", "grading", "assessment"] as const).filter((k) => !shown.has(k));
  return { names: kinds.map((k) => factNames[k]), aiMissing: kinds.includes("ai_policy") };
}

/** "3 upcoming · 2 without a due date · 5 past or finished", omitting empty parts. */
export function groupSummary(group: WorkGroup): string {
  const undatedOpen = group.undated.filter((e) => !isDone(e.resource)).length;
  const finished = group.past.length + group.undated.length - undatedOpen;
  return [
    group.upcoming.length ? `${group.upcoming.length} upcoming` : "",
    undatedOpen ? `${undatedOpen} without a due date` : "",
    finished ? `${finished} past or finished` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Status for the header. `text` is the full detail for the info disclosure; `cue` is the short
 * visible word kept for states that could hide changed coursework. Unknown, stale and partial never
 * read as current.
 */
export function freshnessText(
  page: Pick<CoursePage, "freshness" | "lastSuccessAt">,
  format: (iso: string) => string,
): { text: string; attention: boolean; cue: string | null } {
  const at = page.lastSuccessAt ? format(page.lastSuccessAt) : null;
  switch (page.freshness) {
    case "current_capture":
      return { text: `Checked ${at}`, attention: false, cue: null };
    case "partial":
      return { text: at ? `Partly checked ${at}` : "Partly checked", attention: true, cue: "Partly checked" };
    case "stale":
      return {
        text: at ? `Saved copy from ${at}, may be out of date` : "Not checked yet",
        attention: true,
        cue: at ? "May be out of date" : "Not checked yet",
      };
    default:
      return { text: "Freshness unknown", attention: true, cue: "Freshness unknown" };
  }
}
