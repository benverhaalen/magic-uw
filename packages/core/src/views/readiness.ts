/**
 * Readiness on a page (owner: page-views): topic states from the analytics ops (code rollups of the
 * student's own practice, 0 tokens), and "practice these topics" targets as learning requests the
 * renderer can send unchanged. Analytics refreshes its rebuildable per-topic cache on read, as the
 * `analytics.*` ops do; nothing else is written.
 */
import type { PagePracticeTarget, PageReadiness, PageTopic } from "@magic/contracts";
import { learningRequestSchema } from "@magic/contracts";
import { createAnalytics } from "../../../learning/src/analytics/index";
import type { AnalyticsTopic, StudyNextRow } from "../../../learning/src/router-types";
import { createPipelineReferences } from "../graph/references-port";
import type { ViewContext } from "./common";

const NOTE = "Direction and state from your practice, worked out on this device. This is not a grade prediction.";

export interface ReadinessSubject {
  /** A captured assignment, quiz or exam: its topics come from its references. */
  resourceId?: string;
  /** The assessment the practice target is sectioned by (a stored row ID or a resource ID). */
  assessmentId?: string;
}

const fromTopic = (t: AnalyticsTopic): PageTopic => ({
  conceptId: t.conceptId,
  label: t.label,
  moduleLabel: t.moduleLabel,
  state: t.state,
  stateLabel: t.stateLabel,
  reason: t.reasons[0]?.text ?? (t.state === "not_seen" ? "Not practiced yet." : t.stateLabel),
  practiceItems: t.practiceItems,
});
const fromRow = (r: StudyNextRow): PageTopic => ({
  conceptId: r.conceptId,
  label: r.label,
  moduleLabel: null,
  state: r.state,
  stateLabel: r.stateLabel,
  reason: r.reason,
  practiceItems: r.practiceItems,
});

/** A request only when it parses as the learning channel's own schema; otherwise it is left out. */
export function practiceTarget(label: string, request: Record<string, unknown>): PagePracticeTarget[] {
  return learningRequestSchema.safeParse(request).success ? [{ label, request }] : [];
}

const perPage = new WeakMap<ViewContext, ReturnType<typeof createAnalytics> | null>();
/**
 * One analytics instance per page (readiness and offers share it). Null when the course has no
 * topics yet: topics come only from the concept map, so there is nothing for analytics to roll up.
 */
function analyticsFor(ctx: ViewContext): ReturnType<typeof createAnalytics> | null {
  if (perPage.has(ctx)) return perPage.get(ctx)!;
  const learning = ctx.store.learning;
  const ref = `${ctx.course.accountScope}:${ctx.course.courseId}`;
  const analytics =
    learning && learning.concepts(ref).some((c) => c.kind === "concept" && c.status === "active")
      ? createAnalytics({ store: learning, ref, courseId: ctx.course.courseId, references: createPipelineReferences(ctx.courseStore), now: new Date(ctx.now) })
      : null;
  perPage.set(ctx, analytics);
  return analytics;
}

/** The topics behind each item's references, by resource ID (the page's one analytics instance). */
export function topicReader(ctx: ViewContext): (resourceId: string) => PageTopic[] {
  return (resourceId) => {
    try {
      return (analyticsFor(ctx)?.assignment(resourceId)?.topics ?? []).map(fromTopic);
    } catch {
      return [];
    }
  };
}

export function readinessFor(ctx: ViewContext, subject: ReadinessSubject, anchorIds: string[]): PageReadiness {
  const learning = ctx.store.learning;
  const empty = (status: PageReadiness["status"], message: string): PageReadiness => ({ status, message, topics: [], studyNext: [], targets: [], note: NOTE });
  if (!learning) return empty("unavailable", "Practice tracking isn't available in this workspace.");
  let topics: PageTopic[] = [];
  let studyNext: StudyNextRow[] = [];
  let message = "";
  try {
    const analytics = analyticsFor(ctx);
    if (!analytics) return empty("no_topics", "No practice topics exist for this course yet.");
    if (subject.resourceId) {
      const data = analytics.assignment(subject.resourceId);
      topics = (data?.topics ?? []).map(fromTopic);
      studyNext = data?.studyNext ?? [];
      message = data?.reason ?? "";
    } else if (subject.assessmentId) {
      // A syllabus-only assessment: the course rollup's exam row (its study-next rows carry states).
      const exam = analytics.course().exams.find((e) => e.assessmentId === subject.assessmentId);
      if (exam?.topicIds.length) {
        topics = exam.studyNext.map(fromRow);
        studyNext = exam.studyNext;
        const d = exam.distribution;
        message = `${exam.topicIds.length} topics in scope: ${d.solid} solid, ${d.getting_there} getting there, ${d.iffy} iffy, ${d.not_seen} not seen.`;
      } else message = "No practice topics are linked to this assessment yet.";
    }
  } catch {
    return empty("unavailable", "Readiness couldn't be worked out. Try again after the course refreshes.");
  }
  if (!topics.length) return empty("no_topics", message || "No practice topics are linked to this yet.");
  const remaining = topics.filter((t) => t.state !== "solid").map((t) => t.conceptId).slice(0, 50);
  const anchors = anchorIds.slice(0, 50);
  // The target names topics only: the router answers an assessment-sectioned target "not built" yet.
  // The renderer adds a fresh `operationId` when the student starts it.
  const targets = remaining.length
    ? practiceTarget(`Practice the ${remaining.length} topic${remaining.length === 1 ? "" : "s"} not yet solid`, {
        op: "practice.target",
        courseId: ctx.course.courseId,
        topicIds: remaining,
        mode: "learn",
        count: Math.min(60, Math.max(5, remaining.length * 3)),
        ...(anchors.length ? { anchorIds: anchors } : {}),
      })
    : [];
  return {
    status: "ok",
    message,
    topics,
    studyNext: studyNext.map((r) => ({ conceptId: r.conceptId, label: r.label, reason: r.reason })),
    targets,
    note: NOTE,
  };
}
