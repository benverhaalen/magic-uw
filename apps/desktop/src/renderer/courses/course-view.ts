import type { ResourceView } from "@magic/contracts";
import {
  isDone,
  whenDue,
  type CourseFactKind,
  type CoursePage,
} from "../../../../../packages/domain/src/course-page";

// Pure presentation choices for the course page. The read model stays in packages/domain.

/** One Canvas object on the course page: the record the row opens plus every saved copy of it. */
export interface WorkEntry {
  key: string;
  resource: ResourceView;
  /** Every saved resource with this identity (the same assignment read from several Canvas lists). */
  copies: ResourceView[];
  /** Copies disagree on the due time; the row says so instead of choosing silently. */
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
      dueDiffers: new Set(copies.map((r) => whenDue(r))).size > 1,
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
    .flatMap((g) => g.upcoming.map((entry) => ({ entry, group: g.name })))
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

/** Status text for the header. Unknown, stale and partial never read as current. */
export function freshnessText(
  page: Pick<CoursePage, "freshness" | "lastSuccessAt">,
  format: (iso: string) => string,
): { text: string; attention: boolean } {
  const at = page.lastSuccessAt ? format(page.lastSuccessAt) : null;
  switch (page.freshness) {
    case "current_capture":
      return { text: `Checked ${at}`, attention: false };
    case "partial":
      return { text: at ? `Partly checked ${at}` : "Partly checked", attention: true };
    case "stale":
      return {
        text: at ? `Saved copy from ${at}, may be out of date` : "Not checked yet",
        attention: true,
      };
    default:
      return { text: "Freshness unknown", attention: true };
  }
}
