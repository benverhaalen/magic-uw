/**
 * Outlook through the app's own Microsoft sign-in (#12). Mail search reads stored fields only
 * (gist, sender, category; never a body) through core's `mail.search` query. A calendar event is
 * only ever a proposal: the router returns its fields, the renderer asks main for a proposal
 * (`calendarProposeEvent`, whose single-use ID is main's), and main writes the event only after the
 * student clicks to confirm (`calendarCreateEvent`). The router never creates an event.
 */
import { z } from "zod";
import { dayStart } from "../../graph/agenda";
import { TIME_PHRASE } from "../dates";
import { baseArgs, courseLabel, rangeSchema, timeSchema } from "../action-args";
import type { ActionSpec, ResolvedArgs } from "../types";

export const mailSearch: ActionSpec<ResolvedArgs> = {
  name: "mail.search",
  description: "Search the student's Outlook mail (subject, sender and gist; never message bodies).",
  slots: { query: "optional", course: "optional", date: "optional" },
  argsSchema: baseArgs,
  examples: ["search my email for exam room", "any emails from my TA this week"],
  patterns: [
    /^(?:search|find|check|show(?: me)?|look through)?\s*(?:my\s+)?(?:e-?mails?|inbox|outlook|mail)(?:\s+(?:for|about|from|on|regarding)\s+(?<query>.+))?$/,
    /^(?:any|did i get(?: any)?|new)\s+(?:e-?mails?|mail|messages)(?:\s+(?:from|about|on|regarding)\s+(?<query>.+))?$/,
  ],
  label: (a) => `Search mail${a.query ? ` for "${a.query}"` : ""}${a.course ? ` · ${courseLabel(a.course)}` : ""}`,
  async run(a, ctx) {
    if (!ctx.host.query) return { status: "not_built", message: "Mail search isn't available yet." };
    const since = a.date ? new Date(dayStart(a.date.from, ctx.timeZone)).toISOString() : undefined;
    const result = ctx.host.query({
      view: "mail.search",
      ...(a.query ? { text: a.query } : {}),
      ...(a.course ? { courseId: a.course.courseId } : {}),
      ...(since ? { since } : {}),
      limit: 20,
    });
    return result.view === "mail.search" ? { items: result.items } : { items: [] };
  },
};

const eventArgs = baseArgs.extend({ date: rangeSchema, time: timeSchema, query: z.string().min(1).max(255) });
export const calendarPropose: ActionSpec<z.infer<typeof eventArgs>> = {
  name: "calendar.proposeEvent",
  description: "Propose an event for the student's Outlook calendar; they confirm it with a click before anything is written.",
  slots: { query: "required", date: "required", time: "required" },
  argsSchema: eventArgs,
  examples: ["schedule a study session tomorrow at 3pm", "block off friday 2-4pm for the ece lab report"],
  patterns: [
    /^(?:schedule|put|block(?: out| off)?|book|set up|plan)\s+(?:an?\s+|the\s+)?(?<query>.+?)(?:\s+(?:on|to|in)\s+(?:my\s+)?(?:outlook\s+)?calendar)?$/,
    /^add\s+(?:an?\s+|the\s+)?(?<query>.+?)\s+(?:to|on)\s+(?:my\s+)?(?:outlook\s+)?calendar$/,
  ],
  label: (a) => `Propose "${a.query}" on ${a.date.from}`,
  async run(a, ctx) {
    const day = dayStart(a.date.from, ctx.timeZone);
    const subject =
      a.query
        .replace(TIME_PHRASE, " ")
        .replace(/\b(?:on|to|in) (?:my )?(?:outlook )?calendar\b/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^(?:(?:for|a|an|the) )+/, "") || a.query;
    // Minutes after local midnight. On a day whose UTC offset changes, the student sees the
    // shifted time in the proposal before confirming.
    return {
      handoff: "calendarProposeEvent" as const,
      proposal: {
        subject: subject.charAt(0).toUpperCase() + subject.slice(1, 255),
        start: new Date(day + a.time.start * 60_000).toISOString(),
        end: new Date(day + a.time.end * 60_000).toISOString(),
        timeZone: ctx.timeZone,
      },
      confirm: "Main issues the proposal ID; nothing is written until the student clicks to confirm.",
    };
  },
};
