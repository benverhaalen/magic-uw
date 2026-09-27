/**
 * `compile.course` (the material pipeline): the code pass over a whole course. Re-reads every
 * resource against the current course index, so a link written before its target was captured
 * resolves once the target arrives. Keyed by the course inventory hash. T21's course brief and
 * map (D33, D34) remain model work and are not done here.
 */
import type { CourseJob } from "../../../contracts/src/course-core";
import { compileCourse, isPipelineStore } from "../graph/index";
import { stubHandler, type JobHandler } from "./registry";

/** Kept for the default (stub) registry. */
export const compileJob = stubHandler("compile.course", "course", "T21");

export const compileCourseJob: JobHandler = {
  kind: "compile.course",
  subject: "course",
  owner: "pipeline",
  ready: true,
  async run(job, { store, now }) {
    if (!isPipelineStore(store)) return { status: "retry", error: "This store has no course graph." };
    const subject = (job as Partial<CourseJob>).subjectId ?? "";
    const split = subject.lastIndexOf(":");
    if (split <= 0) return { status: "done" };
    const course = { accountScope: subject.slice(0, split), courseId: subject.slice(split + 1) };
    if (store.courseInventoryHash(course) !== job.inputHash) return { status: "done" }; // a newer pass is queued
    const report = await compileCourse(store, course, now());
    return report.errors.length ? { status: "retry", error: report.errors[0]!.slice(0, 500) } : { status: "done" };
  },
};
