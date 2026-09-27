import type { PlanningSnapshot } from "@magic/contracts";
import { currentEnrollment, type CurrentEnrollment } from "../../../../packages/domain/src/enrollment-match";

const MAX_ENROLLMENT_AGE_MS = 24 * 60 * 60 * 1000;

/** Only same-person, recently complete UW enrollment can label a Canvas site current. */
export function verifiedCanvasEnrollment(
  planning: PlanningSnapshot | undefined,
  canvasAccounts: ReadonlySet<string>,
  now: Date,
): { canvasAccountScope: string; enrollment: CurrentEnrollment } | undefined {
  if (!planning) return undefined;
  const links = new Map<string, Extract<PlanningSnapshot["records"][number], { kind: "account_link" }>>();
  for (const row of planning.records) {
    if (row.deleted || row.kind !== "account_link" || !canvasAccounts.has(row.canvasAccountScope)) continue;
    links.set(`${row.accountScope}:${row.canvasAccountScope}`, row);
  }
  if (links.size !== 1) return undefined;
  const link = [...links.values()][0]!;
  const records = planning.records.filter((row) => row.accountScope === link.accountScope || row.accountScope === "public");
  const enrollment = currentEnrollment(records, now);
  if (!enrollment) return undefined;
  const freshTerms = new Set(planning.sources.filter((source) => {
    if (source.accountScope !== link.accountScope || source.source !== "uw_enroll" || source.scope.kind !== "enrollment_term") return false;
    if (source.status !== "complete" || source.completeness !== "complete" || !source.lastSuccessAt) return false;
    const age = now.getTime() - Date.parse(source.lastSuccessAt);
    return Number.isFinite(age) && age >= -5 * 60_000 && age <= MAX_ENROLLMENT_AGE_MS;
  }).map((source) => source.scope.key));
  if (!enrollment.classes.every((course) => freshTerms.has(course.termCode))) return undefined;
  return { canvasAccountScope: link.canvasAccountScope, enrollment };
}
