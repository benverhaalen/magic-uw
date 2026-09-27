/** Practice analytics (#11): code-only rollups at 0 tokens, through the learning router's ops. */
import { courseLabel, withAssignment, withCourse, type WithAssignment, type WithCourse } from "../action-args";
import type { ActionContext, ActionSpec, ResolvedCourse } from "../types";

/** Analytics ops are course-scoped by anchors, like practice: the course's assignments. */
function scope(ctx: ActionContext, c: ResolvedCourse) {
  const anchorIds = ctx.resolve.anchors(c);
  return anchorIds.length ? { courseId: c.courseId, anchorIds } : null;
}
const NO_ANCHORS = { status: "unavailable", message: "This course has no assignments to measure practice against yet." };
const NOT_BUILT = { status: "not_built", message: "Analytics aren't available yet." };

export const analyticsCourse: ActionSpec<WithCourse> = {
  name: "analytics.course",
  description: "How the student is doing in a course: practice rollups by topic (never a grade prediction).",
  slots: { course: "required" },
  argsSchema: withCourse,
  examples: ["how am I doing in cs 400", "my progress in philosophy"],
  patterns: [/^(?:how am i doing|how'?m i doing|how is my progress|how'?s my progress|my progress|progress|my stats|stats|analytics)$/],
  label: (a) => `Progress · ${courseLabel(a.course)}`,
  async run(a, ctx) {
    if (!ctx.host.learning) return NOT_BUILT;
    const s = scope(ctx, a.course);
    return s ? ctx.host.learning.handle({ op: "analytics.course", ...s }, ctx.signal) : NO_ANCHORS;
  },
};

export const analyticsAssignment: ActionSpec<WithAssignment> = {
  name: "analytics.assignment",
  description: "How ready the student is for one assignment, from their practice on its topics.",
  slots: { assignment: "required", course: "optional" },
  argsSchema: withAssignment,
  examples: ["how ready am I for homework 3 in cs 400"],
  patterns: [/^(?:how ready am i for|am i ready for|how am i doing on|how'?m i doing on) (?<assignment>.+)$/],
  label: (a) => `Readiness · ${a.assignment.title}`,
  async run(a, ctx) {
    if (!ctx.host.learning) return NOT_BUILT;
    const course = a.course ?? ctx.resolve.courseOfResource(a.assignment.resourceId);
    const s = course && scope(ctx, course);
    return s ? ctx.host.learning.handle({ op: "analytics.assignment", ...s, assignmentId: a.assignment.resourceId }, ctx.signal) : NO_ANCHORS;
  },
};

export const analyticsNext: ActionSpec<WithCourse> = {
  name: "analytics.agendaHints",
  description: "What to study next in a course, ranked by code from practice and upcoming work.",
  slots: { course: "required" },
  argsSchema: withCourse,
  examples: ["what should I study next for econ"],
  patterns: [/^(?:what should i (?:study|work on|review|practice)(?: next| now)?|study next|what to study next)$/],
  label: (a) => `Study next · ${courseLabel(a.course)}`,
  async run(a, ctx) {
    if (!ctx.host.learning) return NOT_BUILT;
    const s = scope(ctx, a.course);
    return s ? ctx.host.learning.handle({ op: "analytics.agendaHints", ...s }, ctx.signal) : NO_ANCHORS;
  },
};
