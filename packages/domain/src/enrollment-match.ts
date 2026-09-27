/**
 * fix/current-courses-only. The student's classes this term from their UW current enrollment
 * (Course Search & Enroll), and the exact match of a Canvas course to one of them. Code only:
 * this planning data never goes to AI, Jev or MCP. Shared by the desktop ingestion (which
 * decides what to sync) and onboarding's course chooser (which shows the same decision).
 */
import type { PlanningCrosslist, PlanningRecord, PlanningSubject } from "../../contracts/src/planning";
import { buildCourseIdentityTable, canonicalizeCourseKey, decodeUwTerm, resolveCourseIdentity } from "./planning";

/**
 * A UW Canvas course code's parts: "FA26 COMP SCI 400 001" → subject "COMP SCI", catalog "400",
 * sections ["001"]. Undefined when the code has no catalog number.
 */
export function canvasCourseCode(
  code: string | null | undefined,
): { subject: string; catalog: string; sections: string[] } | undefined {
  const text = (code ?? "")
    .toUpperCase()
    .replace(/^(?:FA|SP|SU)(?:20)?\d{2}[\s:_-]+/, "")
    .trim();
  const match = text.match(/^([A-Z][A-Z &/]*?)\s*(\d{3,4}[A-Z]?)\b((?:\s+\d{3})*)/);
  if (!match) return undefined;
  return {
    subject: match[1]!.trim().replace(/\s+/g, " "),
    catalog: match[2]!,
    sections: match[3]!.trim() ? match[3]!.trim().split(/\s+/) : [],
  };
}
export interface EnrolledClass {
  courseKey: string;
  termCode: string;
  sections: string[];
  /** The catalog title when planning read it; else the course key's subject and number. */
  title: string;
}
export interface CurrentEnrollment {
  classes: EnrolledClass[];
  /** The enrolled class this Canvas course is, by subject and catalog number (and section when both name one). */
  match(course: { course_code?: string | null; name?: string | null }): EnrolledClass | undefined;
}
type Row = PlanningRecord & { deleted?: boolean };
/**
 * The enrolled classes of every term that isn't over: UW's own `past` flag on its term record,
 * else the term code's approximate end (fall Dec 23, spring May 20, summer Aug 20) plus 14 days.
 * Undefined when planning has no current enrollment (the read failed or never ran).
 */
export function currentEnrollment(records: readonly Row[], now: Date): CurrentEnrollment | undefined {
  const live = records.filter((r) => !r.deleted);
  const enrolled = live.flatMap((r) =>
    r.kind === "enrollment_package" && r.enrollmentState === "enrolled" ? [r] : [],
  );
  if (!enrolled.length) return undefined;
  const pastFlag = new Map(
    live.flatMap((r) => (r.kind === "term" && typeof r.past === "boolean" ? [[r.code, r.past] as const] : [])),
  );
  const notPast = (code: string) => {
    const flag = pastFlag.get(code);
    if (flag !== undefined) return !flag;
    try {
      const term = decodeUwTerm(code);
      const end =
        term.season === "fall"
          ? Date.UTC(term.year, 11, 23)
          : term.season === "spring"
            ? Date.UTC(term.year, 4, 20)
            : Date.UTC(term.year, 7, 20);
      return end + 14 * 86400_000 >= now.getTime();
    } catch {
      return false;
    }
  };
  let table: ReturnType<typeof buildCourseIdentityTable>;
  try {
    table = buildCourseIdentityTable(
      live.flatMap((r) => (r.kind === "subject" ? [r as PlanningSubject] : [])),
      live.flatMap((r) => (r.kind === "crosslist" ? [r as PlanningCrosslist] : [])),
    );
  } catch {
    return undefined;
  }
  const titles = new Map(
    live.flatMap((r) => (r.kind === "catalog_course" ? [[canonicalizeCourseKey(r.courseKey, table), r.title] as const] : [])),
  );
  const subjects = new Map(
    live.flatMap((r) => (r.kind === "subject" ? [[(r as PlanningSubject).code, (r as PlanningSubject).shortName] as const] : [])),
  );
  const byKey = new Map<string, EnrolledClass>();
  for (const r of enrolled) {
    if (!notPast(r.termCode)) continue;
    const key = canonicalizeCourseKey(r.courseKey, table);
    if (byKey.has(key)) continue;
    const [, subject, catalog] = r.courseKey.split(":");
    byKey.set(key, {
      courseKey: key,
      termCode: r.termCode,
      sections: r.sections,
      title: titles.get(key) ?? `${subjects.get(subject ?? "") ?? subject} ${catalog}`,
    });
  }
  if (!byKey.size) return undefined;
  return {
    classes: [...byKey.values()],
    match(course) {
      const code = canvasCourseCode(course.course_code) ?? canvasCourseCode(course.name);
      if (!code) return undefined;
      const identity = resolveCourseIdentity({ subject: code.subject, catalog: code.catalog }, table);
      if (identity.status !== "resolved") return undefined;
      const found = byKey.get(canonicalizeCourseKey(identity.courseKey, table));
      if (!found) return undefined;
      const sections = found.sections.flatMap((s) => s.match(/(\d{3})\s*$/)?.[1] ?? []);
      return !code.sections.length || !sections.length || code.sections.some((s) => sections.includes(s))
        ? found
        : undefined;
    },
  };
}
