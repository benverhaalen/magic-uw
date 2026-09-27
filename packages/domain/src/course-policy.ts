import type { CourseIntelligence, CourseIntelligenceView, EffectiveCoursePolicy, Resource } from "@magic/contracts";
import { UW_DEFAULT_POLICY_EVIDENCE } from "./uw-ai-policy";

type Mode = EffectiveCoursePolicy["mode"];

/**
 * One policy from several readings of the same rules. A restriction always wins. A real rule (coaching or
 * allowed) wins over an unclassified quote ("unknown"), but an unclassified quote beside a permission
 * caps it at coaching: the quote may carry a condition code could not read. Unknown alone stays unknown.
 */
export function combinePolicyModes(modes: readonly (Mode | undefined)[]): Mode | undefined {
  if (modes.includes("restricted")) return "restricted";
  if (modes.includes("coaching")) return "coaching";
  if (modes.includes("allowed")) return modes.includes("unknown") ? "coaching" : "allowed";
  return modes.includes("unknown") ? "unknown" : undefined;
}

/** Browser-safe policy projection. Restrictions win; an outdated explicit permission only
 * supports coaching. Raw claims/evidence remain available to explain the effective result.
 * A course that states no AI policy at all (no policy claim, and no captured rule or quote on the
 * item) falls back to UW–Madison's default (`source: "uw-default"`, coaching). */
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
  const inputHash = profile?.inputHash ?? r.contentHash;
  if (!claims.length && r.policy.mode === "unknown" && !r.policy.evidence.trim())
    return { mode: "coaching", source: "uw-default", evidence: UW_DEFAULT_POLICY_EVIDENCE, claimIds: [], resourceIds: [], inputHash, conflict: false };
  // Restriction wins conservatively; assignment permission cannot silently override a course restriction.
  const mode = combinePolicyModes(modes) ?? r.policy.mode;
  return {
    mode: freshness && freshness !== "current_capture" && mode === "allowed" ? "coaching" : mode,
    source: "course",
    evidence: claims.length
      ? claims
          .map((c) => c.evidence.map((e) => e.quote).join("\n"))
          .join("\n\n")
      : r.policy.evidence,
    claimIds: claims.map((c) => c.id),
    resourceIds: [
      ...new Set(claims.flatMap((c) => c.evidence.map((e) => e.resourceId))),
    ],
    inputHash,
    conflict,
  };
}

/** The policy a course-level prompt frame quotes: the course's own stated rule before the UW default. */
export function courseFramePolicy(policies: readonly EffectiveCoursePolicy[]): EffectiveCoursePolicy | undefined {
  return (
    policies.find((p) => p.source === "course" && p.mode !== "unknown") ??
    policies.find((p) => p.source === "course") ??
    policies[0]
  );
}
