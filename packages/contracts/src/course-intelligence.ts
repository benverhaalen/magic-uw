import { z } from "zod";
/** Local, source-bound course interpretation. Quotes establish provenance, not correctness. */
export interface CourseEvidence {
  resourceId: string;
  sourceId: string;
  contentHash: string;
  version: number;
  url: string;
  field: string;
  quote: string;
  start?: number;
  end?: number;
}
export interface CourseClaim {
  id: string;
  kind: "ai_policy" | "grading" | "topic" | "assessment";
  scope: "course" | "assignment";
  assignmentId?: string;
  label: string;
  value: string | number | boolean | null;
  method: "structured" | "literal" | "local_model";
  evidence: CourseEvidence[];
  policyMode?: "restricted" | "coaching" | "allowed" | "unknown";
}
export interface CourseIntelligence {
  id: string;
  accountScope: string;
  courseId: string;
  courseName: string;
  version: number;
  compilerVersion: string;
  extraction?: {
    extractorVersion: string;
    resultHash: string;
    coverage?: CourseExtractionBatch["coverage"];
  };
  inputHash: string;
  compiledAt: string;
  claims: CourseClaim[];
  unknowns: string[];
  conflicts: {
    kind: CourseClaim["kind"];
    claimIds: string[];
    reason: string;
  }[];
  dependencies: { resourceId: string; contentHash: string; version: number }[];
}
export interface CourseIntelligenceView extends CourseIntelligence {
  semantic?: {
    status: "pending" | "running" | "complete" | "partial" | "unavailable";
    attemptedAt?: string;
  };
  coverage: {
    sourceId: string;
    status: string;
    complete: boolean;
    lastAttemptAt: string;
    lastSuccessAt: string | null;
  }[];
  freshness: "current_capture" | "partial" | "stale";
}
export interface EffectiveCoursePolicy {
  mode: "allowed" | "coaching" | "restricted" | "unknown";
  evidence: string;
  claimIds: string[];
  resourceIds: string[];
  inputHash: string;
  conflict: boolean;
}
/** Extraction output is only a candidate; compiler validates scope, source version and literal spans. */
export interface CourseExtractionCandidate {
  kind: CourseClaim["kind"];
  resourceId: string;
  contentHash: string;
  start: number;
  end: number;
  quote: string;
  label: string;
  value: string;
  policyMode?: CourseClaim["policyMode"];
}
export interface CourseExtractionBatch {
  inputHash: string;
  extractorVersion: string;
  coverage?: {
    status: "complete" | "partial";
    examinedResourceIds: string[];
    omittedResourceIds: string[];
    rejectedCandidates: number;
  };
  candidates: CourseExtractionCandidate[];
}

/** Validates the local extractor boundary even when a caller bypasses the provided adapter. */
export const courseExtractionBatchSchema = z
  .object({
    inputHash: z.string().min(1).max(256),
    extractorVersion: z.string().min(1).max(1000),
    candidates: z
      .array(
        z
          .object({
            kind: z.enum(["ai_policy", "grading", "topic", "assessment"]),
            resourceId: z.string().min(1).max(500),
            contentHash: z.string().min(1).max(256),
            start: z.number().int().nonnegative(),
            end: z.number().int().positive(),
            quote: z.string().min(1).max(4000),
            label: z.string().min(1).max(300),
            value: z.string().min(1).max(4000),
            policyMode: z
              .enum(["restricted", "coaching", "allowed", "unknown"])
              .optional(),
          })
          .strict(),
      )
      .max(300),
    coverage: z
      .object({
        status: z.enum(["complete", "partial"]),
        examinedResourceIds: z.array(z.string()).max(1000),
        omittedResourceIds: z.array(z.string()).max(1000),
        rejectedCandidates: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();
