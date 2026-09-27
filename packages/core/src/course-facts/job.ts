/**
 * `course.facts`: the drain job that turns a course's selected syllabus into course facts, once per
 * syllabus change. Enqueued per course at its inventory hash like `compile.course`; the model is
 * called only when the selected syllabus text changed (the pack cache makes every other run a
 * 0-token hit that re-applies the same quotes to the current profile).
 *
 * Route: the student's own client (Claude Code or Codex) through the egress path, under the
 * background budget. No client connected, or fully local mode: the local (Ollama) extractor.
 */
import type { CourseExtractionBatch, CourseIntelligence, Resource, Store } from "@magic/contracts";
import type { CourseJob } from "../../../contracts/src/course-core";
import type { ModelRunner } from "../../../runner/src/index";
import type { JobHandler, JobOutcome } from "../jobs/registry";
import { courseIncluded } from "../access";
import { createClientCourseExtractor, type ClientExtractorDeps } from "./extractor";
import { selectSyllabus } from "./select";
import { courseKeyOf, type CourseBriefSource } from "./brief";

export const COURSE_FACTS_JOB = "course.facts";

/** The local extractor's shape (`createLocalCourseExtractor` in @magic/ai). */
export interface LocalCourseExtractor {
  version: string;
  extract(
    input: {
      inputHash: string;
      resources: Pick<Resource, "id" | "contentHash" | "text" | "kind" | "externalId">[];
      syllabusResourceIds?: string[];
    },
    signal?: AbortSignal,
  ): Promise<CourseExtractionBatch | null>;
}
export interface CourseFactsJobDeps {
  runner: () => ModelRunner | null | Promise<ModelRunner | null>;
  local?: LocalCourseExtractor;
  artifacts?: ClientExtractorDeps["artifacts"];
  ledger?: ClientExtractorDeps["ledger"];
  now?: () => Date;
  /** Keeps the course's `syllabus.md` current after each pass (it is rewritten only when its bytes change). */
  brief?: CourseBriefSource;
}
export interface CourseFactsRun {
  route: "client" | "local" | "none";
  status: "applied" | "unchanged" | "empty" | "no_client" | "blocked" | "paused" | "failed" | "no_profile";
  message?: string;
  cached?: boolean;
  syllabusResourceIds: string[];
}

function latestProfile(store: Store, accountScope: string, courseId: string): CourseIntelligence | undefined {
  return store
    .courseIntelligence()
    .filter((p) => p.accountScope === accountScope && p.courseId === courseId)
    .sort((a, b) => b.version - a.version)[0];
}

/** One pass for one course (the job's body; tests and the live evaluation call it directly). */
export async function runCourseFacts(
  store: Store,
  course: { accountScope: string; courseId: string },
  deps: CourseFactsJobDeps,
  signal?: AbortSignal,
): Promise<CourseFactsRun> {
  const profile = latestProfile(store, course.accountScope, course.courseId);
  const selection = selectSyllabus(store, course, (deps.now?.() ?? new Date()).toISOString());
  // Storage's rebuild selects with the same rules and roles, so applying a batch recompiles the
  // profile over the same sources.
  const chosen = selection.selected
    .map((s) => selection.resources.find((r) => r.id === s.resourceId)!)
    .filter((r) => courseIncluded(store, r));
  const syllabusResourceIds = chosen.map((r) => r.id);
  if (!profile) return { route: "none", status: "no_profile", syllabusResourceIds };
  if (!chosen.some((r) => r.text.trim())) return { route: "none", status: "empty", syllabusResourceIds };
  // False when the same result is already applied (or the course changed since; its own job follows).
  const apply = (batch: CourseExtractionBatch) =>
    store.applyCourseExtraction(course.accountScope, course.courseId, batch, (deps.now?.() ?? new Date()).toISOString());
  const localOnly = store.privacy().mode === "local_only";
  const runner = localOnly ? null : await deps.runner();
  if (runner) {
    const client = createClientCourseExtractor({ store, runner: () => runner, ...(deps.artifacts ? { artifacts: deps.artifacts } : {}), ...(deps.ledger ? { ledger: deps.ledger } : {}), ...(deps.now ? { now: deps.now } : {}) });
    const label = chosen[0]?.courseName ?? course.courseId;
    const result = await client.extract({ ...course, label, inputHash: profile.inputHash }, chosen, signal);
    if (result.status !== "done")
      return { route: "client", status: result.status === "empty" ? "empty" : result.status, message: result.message, syllabusResourceIds };
    return { route: "client", status: apply(result.batch) ? "applied" : "unchanged", cached: result.cached, syllabusResourceIds };
  }
  if (!deps.local) return { route: "none", status: "no_client", syllabusResourceIds };
  // Fully local: the Ollama extractor over the selected syllabus and the course's assignments (its own cap).
  if (profile.extraction?.extractorVersion.startsWith(`${deps.local.version}:`))
    return { route: "local", status: "unchanged", syllabusResourceIds };
  const assignments = selection.resources.filter((r) => r.kind === "assignment" && !r.gitlab && courseIncluded(store, r));
  const batch = await deps.local.extract(
    {
      inputHash: profile.inputHash,
      resources: [...chosen, ...assignments].map(({ id, contentHash, text, kind, externalId }) => ({ id, contentHash, text, kind, externalId })),
      syllabusResourceIds,
    },
    signal,
  );
  if (!batch) return { route: "local", status: "failed", message: "The local model is unavailable.", syllabusResourceIds };
  return { route: "local", status: apply(batch) ? "applied" : "unchanged", syllabusResourceIds };
}

/** The drain handler for `course.facts`. */
export function createCourseFactsJob(deps: CourseFactsJobDeps): JobHandler {
  return {
    kind: COURSE_FACTS_JOB,
    subject: "course",
    owner: "course-facts",
    ready: true,
    async run(job, { store, signal }): Promise<JobOutcome> {
      const subject = (job as Partial<CourseJob>).subjectId ?? "";
      const split = subject.lastIndexOf(":");
      if (split <= 0) return { status: "done" };
      const course = { accountScope: subject.slice(0, split), courseId: subject.slice(split + 1) };
      const run = await runCourseFacts(store, course, deps, signal);
      if (!signal.aborted) deps.brief?.(courseKeyOf(course));
      // Paused (usage limit or the daily budget) and failed calls retry with the store's backoff; a
      // held preview or a refused grant waits for the student and the next course change.
      if (run.status === "paused" || run.status === "failed")
        return { status: "retry", error: (run.message ?? run.status).slice(0, 500) };
      return { status: "done" };
    },
  };
}
