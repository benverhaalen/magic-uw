// owner: source-categories. The plain categories a student sees for where their coursework comes from.
// Internal sources (one per Canvas endpoint, course site crawl, feed or file) are grouped into these
// five; raw scope names and diagnostic codes are for developers only.
import type { SourceHealth } from "@magic/contracts";

export type SourceCategory = "canvas" | "uw" | "outlook" | "notes" | "websites";
export const SOURCE_CATEGORY_ORDER: readonly SourceCategory[] = ["canvas", "uw", "outlook", "notes", "websites"];
export const SOURCE_CATEGORIES: Record<SourceCategory, { name: string; covers: string }> = {
  canvas: { name: "Canvas", covers: "Courses, assignments, announcements and files" },
  uw: { name: "UW enrollment", covers: "Your classes, holds and degree audit" },
  outlook: { name: "Outlook", covers: "Mail and calendar" },
  notes: { name: "Notes", covers: "Your synced notes" },
  websites: { name: "Course websites", covers: "Course sites and pages outside Canvas" },
};

/** Which category a saved source belongs to. Planning sources (UW enrollment) are not SourceHealth. */
export function sourceCategory(source: Pick<SourceHealth, "kind" | "courseId">): SourceCategory {
  switch (source.kind) {
    case "canvas":
    case "kaltura":
    case "feed":
    case "fixture":
      return "canvas";
    case "mail":
      return "outlook";
    case "calendar":
      return source.courseId.startsWith("outlook") ? "outlook" : "websites";
    case "notes":
      return "notes";
    default:
      return "websites";
  }
}

const ACCOUNT_LEVEL = new Set(["account", "connection", "outlook-calendar", "outlook-mail"]);
/**
 * The course a student would recognise from a course-level source label ("CHEM 142 · assignments",
 * "CHEM 142 course websites" → "CHEM 142"); null for account-level parts ("Canvas account · todo").
 */
export function sourceCourseName(source: Pick<SourceHealth, "label" | "courseId" | "scope">): string | null {
  if (ACCOUNT_LEVEL.has(source.courseId)) return null;
  const withoutScope = source.label.endsWith(` · ${source.scope}`) ? source.label.slice(0, -(source.scope.length + 3)) : source.label.split(" · ")[0]!;
  const name = withoutScope.replace(/ course websites$/, "").trim();
  return name || null;
}

/** "Canvas (CHEM 142, MATH 125) and Course websites": where updates may be missing, in plain words. */
export function describeSources(sources: readonly Pick<SourceHealth, "kind" | "courseId" | "label" | "scope">[], maxCourses = 3): string {
  const byCategory = new Map<SourceCategory, Set<string>>();
  for (const source of sources) {
    const category = sourceCategory(source);
    const courses = byCategory.get(category) ?? new Set<string>();
    const course = sourceCourseName(source);
    if (course) courses.add(course);
    byCategory.set(category, courses);
  }
  const parts = SOURCE_CATEGORY_ORDER.filter((c) => byCategory.has(c)).map((category) => {
    const courses = [...byCategory.get(category)!];
    const shown = courses.slice(0, maxCourses);
    const more = courses.length - shown.length;
    return shown.length ? `${SOURCE_CATEGORIES[category].name} (${shown.join(", ")}${more ? ` and ${more} more` : ""})` : SOURCE_CATEGORIES[category].name;
  });
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}
