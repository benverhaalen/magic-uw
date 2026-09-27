// Reads everything the Analytics tab needs in one pass: the local snapshot the app already holds
// (submissions, due dates, the syllabus text) plus at most three learning-router calls made in
// parallel, whatever the course's size: `course.grades`, `course.mastery` and one batched
// `mastery.forItems` for the upcoming items. No per-item call (no N+1), no model call.
// The synthetic sample course reads its synthetic inputs instead and makes no call at all.
import type { LearningRequest, LearningResult, Resource, Snapshot } from "@magic/contracts";
import { gradeInputs } from "../../../../../packages/learning/src/grades/inputs";
import type { CourseMasteryData, ItemsMasteryData } from "../../../../../packages/learning/src/mastery/types";
import type { CourseGradesData } from "../../../../../packages/learning/src/strategy/inputs";
import type { AnalyticsInputs } from "./model";
import { sampleInputs } from "./sample";

export interface CourseRef {
  accountScope: string;
  courseId: string;
  courseName: string;
}
export interface StudyApi {
  learning(request: LearningRequest): Promise<LearningResult>;
}

/** The built-in synthetic sample: the course's saved sources are all the sample fixture's. */
export function isSampleCourse(snapshot: Pick<Snapshot, "sources">, course: CourseRef): boolean {
  const mine = snapshot.sources.filter((s) => s.accountScope === course.accountScope && s.courseId === course.courseId);
  return mine.length > 0 && mine.every((s) => s.kind === "fixture");
}

/** The course's captured assignments merged the grade bank's way, its anchors and its syllabus excerpt. From the snapshot: no IPC. */
export function localCourseData(snapshot: Pick<Snapshot, "sources" | "resources">, course: CourseRef) {
  const account = new Map(snapshot.sources.map((s) => [s.id, s.accountScope]));
  const mine = snapshot.resources.filter((r) => !r.deleted && r.courseId === course.courseId && account.get(r.sourceId) === course.accountScope);
  // The snapshot's resource views carry the fields the grade bank reads (submission, group, points, text).
  const asResources = mine as unknown as Resource[];
  const input = gradeInputs({ resources: () => asResources, sources: () => snapshot.sources }, course);
  const anchorIds = mine.filter((r) => r.kind === "assignment").slice(0, 50).map((r) => r.id);
  const syllabus = mine.find((r) => r.externalId === "syllabus" && r.text);
  return { work: input.items, anchorIds, syllabus: syllabus ? { text: syllabus.text, resourceId: syllabus.id } : null };
}

const message = (r: LearningResult | null, fallback: string) => (r && r.status !== "ok" ? (r.message ?? fallback) : null);

export async function loadAnalyticsInputs(api: StudyApi, snapshot: Pick<Snapshot, "sources" | "resources">, course: CourseRef, now = new Date()): Promise<AnalyticsInputs> {
  if (isSampleCourse(snapshot, course)) return sampleInputs(now, snapshot.resources, course.courseId, course.courseName);
  const { work, anchorIds, syllabus } = localCourseData(snapshot, course);
  const base: AnalyticsInputs = {
    courseId: course.courseId,
    courseName: course.courseName,
    now,
    synthetic: false,
    grades: null,
    gradesMessage: null,
    work,
    mastery: null,
    masteryMessage: null,
    itemTopics: {},
    syllabus,
    cardsDueByTopic: null,
  };
  if (!anchorIds.length) return { ...base, gradesMessage: "No grades posted yet", masteryMessage: "No assignments are saved for this course yet." };
  const nowIso = now.toISOString();
  const upcoming = work.filter((x) => x.dueAt !== null && x.dueAt >= nowIso && x.score === null).slice(0, 100).map((x) => x.id);
  const scope = { courseId: course.courseId, anchorIds };
  const settle = (p: Promise<LearningResult>) => p.catch((e: unknown): LearningResult => ({ op: "course.grades", status: "failed", message: e instanceof Error ? e.message : "The study service didn't answer." }));
  const [grades, mastery, items] = await Promise.all([
    settle(api.learning({ op: "course.grades", ...scope })),
    settle(api.learning({ op: "course.mastery", ...scope })),
    upcoming.length ? settle(api.learning({ op: "mastery.forItems", ...scope, itemIds: upcoming })) : Promise.resolve(null),
  ]);
  const itemTopics: Record<string, string[]> = {};
  if (items?.status === "ok") for (const row of (items.data as ItemsMasteryData).items) itemTopics[row.itemId] = row.topicIds;
  return {
    ...base,
    grades: grades.status === "ok" ? (grades.data as CourseGradesData).grades : null,
    gradesMessage: message(grades, "Grades couldn't be read."),
    mastery: mastery.status === "ok" ? (mastery.data as CourseMasteryData) : null,
    masteryMessage: message(mastery, "Topic mastery couldn't be read."),
    itemTopics,
  };
}
