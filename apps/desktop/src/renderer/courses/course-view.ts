import type { ResourceView } from "@magic/contracts";
import {
  isDone,
  whenDue,
  type CourseFactKind,
  type CoursePage,
  type CourseWorkGroup,
} from "../../../../../packages/domain/src/course-page";

// Pure presentation choices for the course page. The read model stays in packages/domain.

export interface NextItem {
  resource: ResourceView;
  group: string;
  /** Canvas entries sharing this exact title, group, due time and points; each stays listed in Coursework. */
  copies: number;
}

/**
 * Dated, unfinished work across every group, soonest first. Groups keep the full index.
 * Exact repeats (same title, group, due time and points) share one row so they don't crowd out
 * the next distinct item; the row says how many entries it stands for.
 */
export function nextUp(page: Pick<CoursePage, "groups">, limit = 4): NextItem[] {
  const items: NextItem[] = [];
  const byKey = new Map<string, NextItem>();
  const sorted = page.groups
    .flatMap((group) => group.upcoming.map((resource) => ({ resource, group: group.name })))
    .sort(
      (a, b) =>
        Date.parse(whenDue(a.resource)!) - Date.parse(whenDue(b.resource)!) ||
        a.resource.title.localeCompare(b.resource.title),
    );
  for (const { resource, group } of sorted) {
    const key = [group, resource.title, whenDue(resource), resource.points ?? ""].join("\u0000");
    const same = byKey.get(key);
    if (same) same.copies++;
    else if (items.length < limit) {
      const item = { resource, group, copies: 1 };
      byKey.set(key, item);
      items.push(item);
    }
  }
  return items;
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
export function groupSummary(group: CourseWorkGroup): string {
  const undatedOpen = group.undated.filter((r) => !isDone(r)).length;
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
