/** Study guides (#10): the personalised view of a cached guide at 0 tokens (core's `guide` query). */
import { courseLabel, withCourse, type WithCourse } from "../action-args";
import type { ActionSpec } from "../types";

type GuideKind = "guide" | "briefing" | "faq" | "timeline" | "compare" | "conceptmap";
const KINDS: [RegExp, GuideKind][] = [
  [/\bbriefing\b/, "briefing"],
  [/\bfaqs?\b/, "faq"],
  [/\btimeline\b/, "timeline"],
  [/\bcompar(?:e|ison)\b/, "compare"],
  [/\bconcept ?map\b|\bmind ?map\b/, "conceptmap"],
];
export const guideKind = (text: string): GuideKind => KINDS.find(([re]) => re.test(text.toLowerCase()))?.[1] ?? "guide";

export const guideView: ActionSpec<WithCourse> = {
  name: "guide.view",
  description: "Show a course's study guide (or its briefing, FAQ, timeline, comparison or concept map).",
  slots: { course: "required" },
  argsSchema: withCourse,
  examples: ["show the study guide for cs 400", "open the philosophy concept map"],
  patterns: [/^(?:open|show(?: me)?|view|pull up|see)?\s*(?:the |my )?(?:study guide|guide|briefing|faqs?|timeline|comparison|concept ?map|mind ?map)$/],
  label: (a) => `Study ${guideKind(a.text)} · ${courseLabel(a.course)}`,
  async run(a, ctx) {
    if (!ctx.host.query) return { status: "not_built", message: "Study guides aren't available yet." };
    return ctx.host.query({ view: "guide", courseId: a.course.courseId, kind: guideKind(a.text) });
  },
};
