import type { PlanningGradeAggregate, PlanningGradeDistribution, PlanningGradeSummary, Store, StoredPlanningRecord } from "@magic/contracts";
import {
  buildCourseIdentityTable, calculateGradeDistributionAverage, canonicalizeCourseKey, decodeUwTerm, type CourseIdentityTable,
} from "../../domain/src/planning";

type StoredGrade = Extract<StoredPlanningRecord, { kind: "grade_distribution" }>;

/** Explicit subject/cross-list evidence only. Conflicting mappings yield null rather than a chosen equivalence. */
export function planningIdentityTable(store: Pick<Store, "planningRecords">): CourseIdentityTable | null {
  const rows = store.planningRecords().filter((row) => !row.deleted && row.accountScope === "public");
  try {
    return buildCourseIdentityTable(
      rows.filter((row): row is Extract<StoredPlanningRecord, { kind: "subject" }> => row.kind === "subject"),
      rows.filter((row): row is Extract<StoredPlanningRecord, { kind: "crosslist" }> => row.kind === "crosslist"),
    );
  } catch { return null; }
}

function aggregate(rows: PlanningGradeDistribution[]): PlanningGradeAggregate {
  const merged = new Map<string, number>();
  for (const row of rows) for (const item of row.counts) {
    const grade = item.grade.trim().toUpperCase();
    merged.set(grade, (merged.get(grade) ?? 0) + item.count);
  }
  // Reuse the single tested grade rule (A/AB/B/BC/C/D/F → 4/3.5/3/2.5/2/1/0; everything else excluded).
  const coverage = rows.some((row) => row.coverage === "suppressed" || row.coverage === "unknown") ? "unknown"
    : rows.some((row) => row.coverage === "partial") ? "partial" : "published";
  const base = rows[0]!;
  const { instructorIds: _ids, ...plain } = base;
  const result = calculateGradeDistributionAverage({ ...plain, instructorNames: [], counts: [...merged].map(([grade, count]) => ({ grade, count })), coverage });
  return { average: result.average, includedCount: result.includedCount, excludedCount: result.excludedCount, totalCount: result.totalCount, status: result.status };
}
const strip = (row: StoredGrade): PlanningGradeDistribution => {
  const { localId, sourceId, accountScope, contentHash, version, deleted, ...record } = row;
  return record;
};

/**
 * Per-term and per-instructor historical distributions for one course, from saved local records only.
 * Ambiguous aggregates are omitted: several course-level rows in one term, a section described twice, or a
 * co-taught section (attribution to one instructor is unknown). Instructors group by source ID, never by name.
 */
export function summarizePlanningGrades(store: Pick<Store, "planningRecords" | "planningSources">, courseKey: string, now: string, refresh: PlanningGradeSummary["refresh"] = null): PlanningGradeSummary {
  const summary: PlanningGradeSummary = { courseKey, createdAt: now, refresh, warnings: [], terms: [], instructors: [], overall: null };
  const table = planningIdentityTable(store);
  if (!table) {
    summary.warnings.push("Saved cross-list mappings disagree. Course equivalence is unknown, so grade evidence is not shown.");
    return summary;
  }
  const canonical = canonicalizeCourseKey(courseKey, table);
  summary.courseKey = canonical;
  const sources = new Map(store.planningSources().map((source) => [source.id, source]));
  const rows = store.planningRecords().filter((row): row is StoredGrade => !row.deleted && row.kind === "grade_distribution" && row.accountScope === "public" && canonicalizeCourseKey(row.courseKey, table) === canonical);
  const byTerm = new Map<string, StoredGrade[]>();
  for (const row of rows) byTerm.set(row.termCode, [...(byTerm.get(row.termCode) ?? []), row]);
  let ambiguousTerms = 0, duplicateSections = 0;
  const overallRows: PlanningGradeDistribution[] = [];
  const instructors = new Map<string, { names: Set<string>; terms: Set<string>; rows: PlanningGradeDistribution[]; coTaught: number }>();
  for (const [termCode, termRows] of [...byTerm].sort(([a], [b]) => b.localeCompare(a))) {
    const courseLevel = termRows.filter((row) => row.section === null);
    if (courseLevel.length === 1) {
      const row = courseLevel[0]!;
      summary.terms.push({ termCode, label: decodeUwTerm(termCode).label, sourceUrl: row.provenance.sourceUrl, observedAt: row.provenance.observedAt, ...aggregate([strip(row)]) });
      overallRows.push(strip(row));
    } else ambiguousTerms++;
    const sections = new Map<string, StoredGrade[]>();
    for (const row of termRows) if (row.section !== null) sections.set(row.section, [...(sections.get(row.section) ?? []), row]);
    for (const sectionRows of sections.values()) {
      if (sectionRows.length !== 1) { duplicateSections++; continue; }
      const row = sectionRows[0]!;
      const source = sources.get(row.sourceId)?.source;
      if (!row.instructorIds?.length || !source) continue;
      if (row.instructorIds.length > 1) {
        for (const id of row.instructorIds) {
          const entry = instructors.get(`${source}:${id}`) ?? { names: new Set(), terms: new Set(), rows: [], coTaught: 0 };
          entry.coTaught++; instructors.set(`${source}:${id}`, entry);
        }
        continue;
      }
      const key = `${source}:${row.instructorIds[0]}`;
      const entry = instructors.get(key) ?? { names: new Set(), terms: new Set(), rows: [], coTaught: 0 };
      for (const name of row.instructorNames) entry.names.add(name);
      entry.terms.add(termCode); entry.rows.push(strip(row)); instructors.set(key, entry);
    }
  }
  if (ambiguousTerms) summary.warnings.push(`${ambiguousTerms} terms have no single course-level distribution (several sources or only section rows); they are omitted from term and all-term averages.`);
  if (duplicateSections) summary.warnings.push(`${duplicateSections} sections are described by more than one record and were omitted from instructor averages.`);
  if (overallRows.length && !ambiguousTerms) summary.overall = { termCount: overallRows.length, ...aggregate(overallRows) };
  else if (overallRows.length) summary.warnings.push("No all-term average is shown because some terms are ambiguous.");
  summary.instructors = [...instructors].map(([key, entry]) => ({
    instructorId: key, names: [...entry.names].sort(), termCodes: [...entry.terms].sort().reverse(), sectionCount: entry.rows.length,
    coTaughtSectionsExcluded: entry.coTaught,
    ...(entry.rows.length ? aggregate(entry.rows) : { average: null, includedCount: 0, excludedCount: 0, totalCount: 0, status: "unknown" as const }),
  })).sort((a, b) => a.instructorId.localeCompare(b.instructorId));
  if (summary.instructors.some((row) => row.coTaughtSectionsExcluded)) summary.warnings.push("Co-taught sections are excluded from individual instructor averages because attribution is unknown.");
  if (rows.length) summary.warnings.push("Historical averages of published grades. Not a prediction of your grade, a measure of instructor quality, or a ranking signal.");
  return summary;
}
