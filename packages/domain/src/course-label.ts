import type { Resource, SourceHealth } from "@magic/contracts";

/** A display projection, never a course identity, inclusion rule, or term selector. */
export const COURSE_LABEL_RULE_VERSION = "course-label.v1";

export interface CourseLabelInput {
  resource: Pick<Resource, "id" | "sourceId" | "courseId" | "kind" | "courseName" | "course" | "version" | "contentHash">;
  source: Pick<SourceHealth, "id" | "accountScope" | "courseId">;
}

export interface CourseLabel {
  displayTitle: string;
  displayCode?: string;
  rawName: string;
  /**
   * Course association survives raw fallback, including a joined non-course
   * resource. Null only when the join is invalid. Never key a course by its label.
   */
  identity: { accountScope: string; courseId: string } | null;
  evidence: { resourceId: string; sourceId: string; version: number; contentHash: string };
  context: { section?: string; termToken?: string; termId?: string; termName?: string };
  method: "verified-wrapper" | "raw";
  ruleVersion: typeof COURSE_LABEL_RULE_VERSION;
  reason?: "source-mismatch" | "not-course" | "missing-metadata" | "unknown-code" | "unknown-wrapper" | "metadata-mismatch";
  /** Half-open UTF-16 offsets into rawName; slice(start, end) equals text. */
  removedSpans: Array<{ kind: "code-prefix" | "section-term-suffix"; start: number; end: number; text: string }>;
}

/**
 * Recognizes the corroborated Canvas wrapper only. Both name and structured
 * courseCode must agree on subject, number, section and term. No title guessing,
 * punctuation cleanup, current-term inference, or crosslisted-name rewriting.
 * Call with the course resource and its actual source, not assignment metadata.
 * Consumers can use context/code to disambiguate equal titles without merging IDs.
 */
export function projectCourseLabel({ resource, source }: CourseLabelInput): CourseLabel {
  const rawName = resource.courseName;
  const joined = source.id === resource.sourceId && source.courseId === resource.courseId &&
    Boolean(source.accountScope && source.courseId);
  const result: CourseLabel = {
    displayTitle: rawName,
    rawName,
    identity: joined ? { accountScope: source.accountScope, courseId: resource.courseId } : null,
    evidence: { resourceId: resource.id, sourceId: resource.sourceId, version: resource.version, contentHash: resource.contentHash },
    context: { termId: resource.course?.termId, termName: resource.course?.termName },
    method: "raw",
    ruleVersion: COURSE_LABEL_RULE_VERSION,
    removedSpans: [],
  };
  const fallback = (reason: CourseLabel["reason"]) => ({ ...result, reason });
  if (!joined) return fallback("source-mismatch");
  if (resource.kind !== "course") return fallback("not-course");
  if (!resource.course?.courseCode) return fallback("missing-metadata");

  // FA/SP and single-token subjects are the observed source grammar. Other
  // terms and multi-word subjects stay intact until their wrappers are verified.
  const code = /^((?:FA|SP)\d{2}) ([A-Z]+) (\d{3}) (\d{3})$/.exec(resource.course.courseCode);
  if (!code) return fallback("unknown-code");
  const [, term, subject, number, section] = code;
  // Anchored and deliberately strict: do not normalize unexpected whitespace.
  const name = /^([A-Z]+\d{3}): (\S(?:[^\r\n]*\S)?) \((\d{3})\) ((?:FA|SP)\d{2})$/.exec(rawName);
  if (!name) return fallback("unknown-wrapper");
  if (name[1] !== subject + number || name[3] !== section || name[4] !== term)
    return fallback("metadata-mismatch");

  const titleStart = name[1].length + 2;
  const titleEnd = titleStart + name[2].length;
  return {
    ...result,
    displayTitle: name[2],
    displayCode: `${subject} ${number}`,
    context: { ...result.context, section, termToken: term },
    method: "verified-wrapper",
    removedSpans: [
      { kind: "code-prefix", start: 0, end: titleStart, text: rawName.slice(0, titleStart) },
      { kind: "section-term-suffix", start: titleEnd, end: rawName.length, text: rawName.slice(titleEnd) },
    ],
  };
}
