import { createHash } from "node:crypto";
import type {
  CourseClaim,
  CourseEvidence,
  CourseExtractionBatch,
  CourseIntelligence,
  CourseIntelligenceView,
  EffectiveCoursePolicy,
  Resource,
  SourceHealth,
} from "@magic/contracts";

export const COURSE_COMPILER_VERSION = "course-intelligence.v1";
export const courseExtractionHash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const hash = courseExtractionHash;
export const courseIntelligenceId = (account: string, course: string) =>
  hash([account, course]);
export function courseInputHash(resources: Resource[]) {
  return hash([
    COURSE_COMPILER_VERSION,
    resources
      .map((r) => [r.sourceId, r.id, r.contentHash, r.version])
      .sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
  ]);
}
function textEvidence(r: Resource, start: number, end: number): CourseEvidence {
  return {
    resourceId: r.id,
    sourceId: r.sourceId,
    contentHash: r.contentHash,
    version: r.version,
    url: r.url,
    field: "text",
    quote: r.text.slice(start, end),
    start,
    end,
  };
}
function fieldEvidence(
  r: Resource,
  field: string,
  value: unknown,
): CourseEvidence {
  return {
    resourceId: r.id,
    sourceId: r.sourceId,
    contentHash: r.contentHash,
    version: r.version,
    url: r.url,
    field,
    quote: JSON.stringify(value),
  };
}
function scope(r: Resource): Pick<CourseClaim, "scope" | "assignmentId"> {
  return r.kind === "assignment"
    ? { scope: "assignment", assignmentId: r.id }
    : { scope: "course" };
}
/** Only narrow declarative prohibitions are actionable automatically; all permission prose stays unresolved. */
export function literalPolicyMode(text: string): CourseClaim["policyMode"] {
  const normalized = text.trim().replace(/[.!]$/, "").toLowerCase();
  if (
    /^(?:the use of )?(?:generative ai|artificial intelligence|ai tools|chatgpt) (?:is|are) (?:strictly )?(?:prohibited|not permitted|not allowed)(?: (?:in this course|on this assignment|for this assignment))?$/.test(
      normalized,
    )
  )
    return "restricted";
  return "unknown";
}
export function compileCourseIntelligence(
  accountScope: string,
  courseId: string,
  resources: Resource[],
  compiledAt: string,
  previous?: CourseIntelligence,
  extraction?: CourseExtractionBatch,
  sources: Pick<SourceHealth, "id" | "kind" | "scope">[] = [],
): CourseIntelligence {
  const ordered = [...resources].sort((a, b) => a.id.localeCompare(b.id));
  const inputHash = courseInputHash(ordered);
  const claims: CourseClaim[] = [];
  function add(c: Omit<CourseClaim, "id">) {
    claims.push({ id: hash(c), ...c });
  }
  const trusted = (r: Resource) => {
    const source = sources.find((s) => s.id === r.sourceId);
    return (
      !!source &&
      (source.kind === "canvas" || source.kind === "fixture") &&
      !r.gitlab
    );
  };
  const syllabus = (r: Resource) =>
    trusted(r) &&
    r.externalId === "syllabus" &&
    sources.find((s) => s.id === r.sourceId)?.scope === "syllabus";
  for (const r of ordered) {
    if (!trusted(r)) continue;
    if (r.assignmentGroup) {
      for (const [key, value] of Object.entries(r.assignmentGroup)) {
        if (key === "position") continue;
        add({
          kind: "grading",
          scope: "course",
          label: `${r.title}: ${key}`,
          value: typeof value === "number" ? value : JSON.stringify(value),
          method: "structured",
          evidence: [fieldEvidence(r, `assignmentGroup.${key}`, value)],
        });
      }
    }
    if (r.kind === "assignment") {
      for (const [key, value] of Object.entries({
        points: r.points,
        submissionTypes: r.submissionTypes,
        rubric: r.rubric,
        assignmentGroupId: r.assignmentGroupId,
      })) {
        if (value == null || (Array.isArray(value) && !value.length)) continue;
        add({
          kind:
            key === "points" || key === "assignmentGroupId"
              ? "grading"
              : "assessment",
          ...scope(r),
          label: key,
          value: typeof value === "number" ? value : JSON.stringify(value),
          method: "structured",
          evidence: [fieldEvidence(r, key, value)],
        });
      }
    }
    // Existing explicit policy records are preserved as assertions, with their original field provenance.
    if (
      r.policy.mode !== "unknown" &&
      r.policy.evidence &&
      (r.kind === "assignment" || r.kind === "course" || syllabus(r))
    ) {
      add({
        kind: "ai_policy",
        ...scope(r),
        label: "Captured policy assertion",
        value: r.policy.evidence,
        method: "structured",
        policyMode: r.policy.mode,
        evidence: [fieldEvidence(r, "policy", r.policy)],
      });
    }
    // Course-level extraction is restricted to the connector's syllabus scope (not arbitrary linked pages).
    const isSyllabus = syllabus(r);
    if (!isSyllabus && r.kind !== "assignment") continue;
    let section: CourseClaim["kind"] | undefined;
    for (const match of r.text.matchAll(/[^\n]+/g)) {
      const line = match[0],
        start = match.index!;
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (
        /^(?:topics|learning objectives|learning outcomes|course content)\s*:?$/i.test(
          trimmed,
        )
      )
        section = "topic";
      else if (
        /^(?:assessment|exam format|exam scope|allowed materials|examinations)\s*:?$/i.test(
          trimmed,
        )
      )
        section = "assessment";
      else if (/^(?:grading|grade breakdown|evaluation)\s*:?$/i.test(trimmed))
        section = "grading";
      else if (/^(?:[A-Z][A-Za-z ]{2,50}):$/.test(trimmed)) section = undefined;
      const kind =
        /\b(?:generative ai|artificial intelligence|chatgpt|ai tools)\b/i.test(
          line,
        )
          ? "ai_policy"
          : section;
      if (!kind || line.length > 4000) continue;
      add({
        kind,
        ...scope(r),
        label:
          kind === "ai_policy" ? "AI policy passage" : "Source section passage",
        value: line,
        method: "literal",
        ...(kind === "ai_policy"
          ? {
              policyMode:
                r.text.trim() === line.trim()
                  ? literalPolicyMode(line)
                  : "unknown",
            }
          : {}),
        evidence: [textEvidence(r, start, start + line.length)],
      });
    }
  }
  if (extraction?.inputHash === inputHash)
    for (const c of extraction.candidates.slice(0, 300)) {
      const r = ordered.find(
        (r) => r.id === c.resourceId && r.contentHash === c.contentHash,
      );
      if (
        !r ||
        typeof c.quote !== "string" ||
        typeof c.label !== "string" ||
        typeof c.value !== "string" ||
        (!syllabus(r) && !(trusted(r) && r.kind === "assignment")) ||
        !Number.isInteger(c.start) ||
        !Number.isInteger(c.end) ||
        c.start < 0 ||
        c.end <= c.start ||
        c.end > r.text.length ||
        r.text.slice(c.start, c.end) !== c.quote ||
        !c.quote.trim() ||
        c.quote.length > 4000 ||
        c.value !== c.quote ||
        c.label.length > 300 ||
        c.value.length > 4000
      )
        continue;
      if (!["ai_policy", "grading", "topic", "assessment"].includes(c.kind))
        continue;
      // A grounded quote is not proof of model interpretation. No inferred permission or numeric grade computation.
      add({
        kind: c.kind,
        ...scope(r),
        label: c.label,
        value: c.value,
        method: "local_model",
        evidence: [textEvidence(r, c.start, c.end)],
        ...(c.kind === "ai_policy"
          ? {
              policyMode:
                r.text.trim() === c.quote.trim()
                  ? literalPolicyMode(c.quote)
                  : "unknown",
            }
          : {}),
      });
    }
  const conflicts: CourseIntelligence["conflicts"] = [];
  for (const assignmentId of new Set(
    claims.filter((c) => c.kind === "ai_policy").map((c) => c.assignmentId),
  )) {
    const policies = claims.filter(
      (c) =>
        c.kind === "ai_policy" &&
        c.assignmentId === assignmentId &&
        c.policyMode !== "unknown",
    );
    if (new Set(policies.map((c) => c.policyMode)).size > 1)
      conflicts.push({
        kind: "ai_policy",
        claimIds: policies.map((c) => c.id),
        reason:
          "Policy assertions disagree at the same scope; no permissive resolution inferred.",
      });
  }
  const rejectedByCompiler = extraction
    ? extraction.candidates.length -
      claims.filter((c) => c.method === "local_model").length
    : 0;
  const extractionCoverage =
    extraction && rejectedByCompiler > 0
      ? {
          status: "partial" as const,
          examinedResourceIds: extraction.coverage?.examinedResourceIds ?? [],
          omittedResourceIds: extraction.coverage?.omittedResourceIds ?? [],
          rejectedCandidates:
            (extraction.coverage?.rejectedCandidates ?? 0) + rejectedByCompiler,
        }
      : extraction?.coverage;
  const unknowns = [
    "Captured sources do not establish complete course coverage.",
    "Syllabus term relevance and completeness require verification; old copies may remain published.",
    "Topic presence does not establish exam scope or student mastery.",
    "Canvas group weights do not establish that weighting is enabled or the final grade formula.",
  ];
  for (const kind of ["ai_policy", "grading", "topic", "assessment"] as const)
    if (!claims.some((c) => c.kind === kind))
      unknowns.push(`No ${kind} evidence recognized in captured sources.`);
  if (extractionCoverage?.status === "partial")
    unknowns.push(
      "Semantic extraction was partial; some source text or candidates were omitted.",
    );
  if (!extraction)
    unknowns.push(
      "Semantic extraction has not run; prose coverage is limited to literal sections and structured fields.",
    );
  return {
    id: courseIntelligenceId(accountScope, courseId),
    accountScope,
    courseId,
    courseName: ordered[0]?.courseName ?? courseId,
    version: (previous?.version ?? 0) + 1,
    compilerVersion: COURSE_COMPILER_VERSION,
    ...(extraction
      ? {
          extraction: {
            extractorVersion: extraction.extractorVersion,
            resultHash: hash(extraction),
            coverage: extractionCoverage,
          },
        }
      : {}),
    inputHash,
    compiledAt,
    claims,
    unknowns,
    conflicts,
    dependencies: ordered.map((r) => ({
      resourceId: r.id,
      contentHash: r.contentHash,
      version: r.version,
    })),
  };
}
export function intelligenceView(
  profile: CourseIntelligence,
  sources: SourceHealth[],
  now: string,
): CourseIntelligenceView {
  const coverage = sources
    .filter(
      (s) =>
        s.accountScope === profile.accountScope &&
        s.courseId === profile.courseId,
    )
    .map(({ id, status, complete, lastAttemptAt, lastSuccessAt }) => ({
      sourceId: id,
      status,
      complete,
      lastAttemptAt,
      lastSuccessAt,
    }));
  const stale = coverage.some(
    (s) =>
      !s.lastSuccessAt ||
      Date.parse(now) - Date.parse(s.lastSuccessAt) > 24 * 60 * 60 * 1000 ||
      !["ok", "partial"].includes(s.status),
  );
  return {
    ...profile,
    coverage,
    freshness: stale
      ? "stale"
      : coverage.some((s) => !s.complete || s.status !== "ok")
        ? "partial"
        : "current_capture",
  };
}
export function effectiveCoursePolicy(
  profile: CourseIntelligence | undefined,
  r: Resource,
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
    mode,
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
