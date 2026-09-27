/**
 * @magic/agent-api: the open academic data platform's read surface (plan D42, spec F3).
 * Versioned by namespace: `v1` is contract "magic.agent-api" 1.x. A client names the version it
 * was built for; a new major version arrives beside the old one, never in place of it.
 */
export * as v1 from "./v1";
export { createReadApi, CONTRACT, VERSION, BUDGET_TOKENS } from "./v1";
export type {
  ReadApiV1,
  ResultsV1,
  CourseV1,
  CourseGraphV1,
  ResourceSummaryV1,
  AssignmentV1,
  ItemV1,
  SourceCoverage,
  Verb,
  Input,
  CourseBriefV1, // owner: course-facts
} from "./v1";
export { authorize, openSession, type Credentials, type SessionOptions, type ReadSession } from "./session";
export { fitToBudget, DETAIL_LEVELS, CHARS_PER_TOKEN, type DetailLevel, type Fitted } from "./budget";
/** The contract versions this build serves. */
export const SUPPORTED_VERSIONS = ["1"] as const;
