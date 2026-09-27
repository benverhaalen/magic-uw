import type { CourseIntelligence, CourseIntelligenceView, EffectiveCoursePolicy, Resource } from "@magic/contracts";

/** Browser-safe policy projection. Restrictions win; an outdated explicit permission only
 * supports coaching. Raw claims/evidence remain available to explain the effective result. */
export function effectiveCoursePolicy(
  profile: CourseIntelligence | undefined,
  r: Pick<Resource, "id" | "policy" | "contentHash">,
  freshness?: CourseIntelligenceView["freshness"],
): EffectiveCoursePolicy {
  const claims =
    profile?.claims.filter(
      (c) =>
        c.kind === "ai_policy" &&
        (c.scope === "course" || c.assignmentId === r.id),
    ) ?? [];
  const modes = claims.map((c) => c.policyMode);
  const conflict = modes.includes("restricted") && modes.includes("allowed");
  // Restriction wins conservatively; assignment permission cannot silently override a course restriction.
  const mode = modes.includes("restricted")
    ? "restricted"
    : modes.includes("unknown")
      ? "unknown"
      : modes.includes("coaching")
        ? "coaching"
        : modes.includes("allowed")
          ? "allowed"
          : r.policy.mode;
  return {
    mode: freshness && freshness !== "current_capture" && mode === "allowed" ? "coaching" : mode,
    evidence: claims.length
      ? claims
          .map((c) => c.evidence.map((e) => e.quote).join("\n"))
          .join("\n\n")
      : r.policy.evidence,
    claimIds: claims.map((c) => c.id),
    resourceIds: [
      ...new Set(claims.flatMap((c) => c.evidence.map((e) => e.resourceId))),
    ],
    inputHash: profile?.inputHash ?? r.contentHash,
    conflict,
  };
}
