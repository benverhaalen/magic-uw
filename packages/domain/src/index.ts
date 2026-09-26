import type {
  DeadlineClaim,
  DeadlineResolution,
  PrivacyPreferences,
} from "@magic/contracts";
export function resolveDeadline(claims: DeadlineClaim[]): DeadlineResolution {
  const due = claims.filter((c) => c.kind === "due" && c.scopeConfirmed);
  if (!due.length)
    return {
      dueAt: null,
      planningAt: null,
      conflict: false,
      claims,
      reason: "No confirmed due date in available evidence.",
    };
  const moved = due.filter((c) => c.authority === "explicit_change");
  const considered = moved.length ? moved : due;
  const times = [
    ...new Set(considered.map((c) => new Date(c.value).toISOString())),
  ].sort();
  return {
    dueAt: times.length === 1 ? times[0] : null,
    planningAt: times[0],
    conflict: times.length > 1,
    claims,
    reason:
      times.length > 1
        ? "Dates disagree. Plan for the earlier date until resolved."
        : moved.length
          ? "An explicit, scoped change establishes this due date."
          : "Available scoped claims agree.",
  };
}
export function maySend(
  p: PrivacyPreferences,
  recipient: string,
  categories: string[],
): { allowed: boolean; reason: string } {
  if (recipient === "local")
    return { allowed: true, reason: "Processed on this device." };
  if (p.mode === "local_only")
    return { allowed: false, reason: "Fully local processing is enabled." };
  if (recipient === "jev" && !p.jevEnabled)
    return { allowed: false, reason: "Hosted Jev judgments are disabled." };
  if (recipient !== "jev" && p.hostedProvider !== recipient)
    return { allowed: false, reason: "This hosted AI has not been selected." };
  if (categories.includes("course_text") && !p.shareCourseText)
    return { allowed: false, reason: "Sharing course text is disabled." };
  if (categories.includes("student_work") && !p.shareStudentWork)
    return { allowed: false, reason: "Sharing student work is disabled." };
  return {
    allowed: true,
    reason: "Allowed by your current data-sharing settings.",
  };
}
