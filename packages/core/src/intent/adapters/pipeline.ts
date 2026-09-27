/**
 * The material pipeline (#13): the daily agenda (preferred over the D40 `due` verb when the store
 * has the pipeline), an assignment's references, and a course's structure. Reads only.
 */
import { agenda, courseGraph, isPipelineStore, references } from "../../graph/index";
import { localDate } from "../../graph/agenda";
import { isoDay, localDay } from "../dates";
import { courseLabel, withAssignment, withCourse, type WithAssignment, type WithCourse } from "../action-args";
import type { ActionContext, ActionSpec, ResolvedArgs } from "../types";

/** The pipeline's agenda over a local-date range, filtered to a course when one is named; null without the pipeline. */
export function pipelineAgenda(ctx: ActionContext, a: ResolvedArgs) {
  const store = ctx.store;
  if (!isPipelineStore(store)) return null;
  const today = localDay(ctx.now, ctx.timeZone);
  const from = a.date?.from ?? isoDay(today);
  const to = a.date?.to ?? isoDay(today + 6 * 86_400_000);
  const days = Math.min(60, Math.max(1, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1));
  const result = agenda(store, { date: from, tz: ctx.timeZone, days, now: ctx.now.toISOString(), withReferences: false });
  // The agenda also carries overdue work and a window edge; keep the days the student asked for.
  const entries = result.entries.filter((e) => {
    const day = localDate(Date.parse(e.at), ctx.timeZone);
    return day >= from && day <= to && (!a.course || (e.courseId === a.course.courseId && e.accountScope === a.course.accountScope));
  });
  return { source: "pipeline" as const, range: { from, to, label: a.date?.label ?? "this week" }, entries };
}

export const assignmentReferences: ActionSpec<WithAssignment> = {
  name: "assignment.references",
  description: "The materials an assignment points to (readings, slides, pages), found by code.",
  slots: { assignment: "required", course: "optional" },
  argsSchema: withAssignment,
  examples: ["what do I need for homework 3 in cs 400", "readings for essay 1"],
  patterns: [/^(?:what do i need for|what(?:'s| is) needed for|materials for|readings for|references for|what should i read for) (?<assignment>.+)$/],
  label: (a) => `Materials for ${a.assignment.title}`,
  async run(a, ctx) {
    if (!isPipelineStore(ctx.store)) return { status: "not_built", message: "References aren't available yet." };
    return { assignment: a.assignment, references: references(ctx.store, a.assignment.resourceId) };
  },
};

export const courseOverview: ActionSpec<WithCourse> = {
  name: "course.overview",
  description: "A course's structure: its modules, assessments and how much of its material has been read.",
  slots: { course: "required" },
  argsSchema: withCourse,
  examples: ["course overview for ece 203", "show the modules in cs 400"],
  patterns: [/^(?:(?:show(?: me)?|open|view) )?(?:the )?(?:course )?(?:overview|structure|outline|modules|course map)$/],
  label: (a) => `Overview · ${courseLabel(a.course)}`,
  async run(a, ctx) {
    if (!isPipelineStore(ctx.store)) return { status: "not_built", message: "The course overview isn't available yet." };
    return courseGraph(ctx.store, { accountScope: a.course.accountScope, courseId: a.course.courseId });
  },
};
