// owner: study frontend. Pure decisions for the study panel: which actions to offer, which topics
// to show and what each backend outcome means to the student. No percentages, scores or grades;
// unknown or partial evidence is never shown as ready, done or mastered.
import type {
  Capability,
  ConceptStateName,
  GuideQueryResult,
  PackOutcome,
  PracticePathData,
  PracticeResults,
  TopicStateView,
} from "./types";

export function when(value: string | null | undefined): string {
  if (!value) return "time unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "time unknown";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

const RANK: Record<ConceptStateName, number> = { iffy: 0, getting_there: 1, not_seen: 2, solid: 3 };

/** Up to `limit` topics worth attention: weakest first, then topics practice can reach now. */
export function focusTopics(topics: TopicStateView[], limit = 5): TopicStateView[] {
  return [...topics]
    .sort(
      (a, b) =>
        RANK[a.state] - RANK[b.state] ||
        Number(b.practiceItems > 0) - Number(a.practiceItems > 0) ||
        a.label.localeCompare(b.label),
    )
    .slice(0, limit);
}

/** One honest line under a topic: the backend's first reason, else the evidence it has. */
export function topicReason(topic: Pick<TopicStateView, "reasons" | "counts" | "practiceItems">): string {
  const reason = topic.reasons[0]?.text;
  if (reason) return reason;
  const { answers, cardReviews } = topic.counts;
  if (!answers && !cardReviews)
    return topic.practiceItems ? "No practice answers yet." : "No checked practice covers this topic yet.";
  return `${plural(answers, "answer")} and ${plural(cardReviews, "card review")} so far.`;
}

export type Tone = "study" | "blue" | "rose" | "coral";
export interface StudyAction {
  id: "practice" | "cards" | "guide" | "make-practice" | "make-guide";
  tone: Tone;
  title: string;
  detail: string;
  disabled?: string;
}

export interface ActionInputs {
  path: Capability<PracticePathData> | null;
  guide: Capability<GuideQueryResult> | null;
  courseLabel: string;
  restricted: boolean;
  guideScopeLabel: string;
  /** The backend's course pick belongs to another account, so generation would not reach this one. */
  otherAccount?: boolean;
  /**
   * Practice reads need an assignment anchor (the study context resolver accepts only
   * assignments). False on a material page with no course anchor: no path was read at all.
   */
  anchored?: boolean;
}

/** The small set of next study actions this item can support right now. */
export function studyActions(input: ActionInputs): StudyAction[] {
  const actions: StudyAction[] = [];
  const path = input.path && (input.path.state === "ok" || input.path.state === "unavailable") ? input.path.data : undefined;
  const current = path?.availability === "current";
  if (path && path.questions > 0)
    actions.push({
      id: "practice",
      tone: "study",
      title: `Practice ${plural(path.questions, "checked question")}`,
      detail: `About 15 minutes · ${input.courseLabel}`,
      ...(current ? {} : { disabled: path.reason || "Practice is paused until the course material is current." }),
    });
  if (path && path.cards.total > 0)
    actions.push(
      path.cards.dueToday > 0
        ? {
            id: "cards",
            tone: "blue",
            title: `Review ${plural(path.cards.dueToday, "card")} due`,
            detail: `Due today in ${input.courseLabel}`,
            ...(current ? {} : { disabled: path.reason }),
          }
        : {
            id: "cards",
            tone: "blue",
            title: "No cards due today",
            detail: `${plural(path.cards.total, "card")} saved in ${input.courseLabel}`,
            disabled: "Nothing is due today.",
          },
    );
  const guide = input.guide?.state === "ok" ? input.guide.data : null;
  if (guide && (guide.status === "ready" || guide.status === "stale"))
    actions.push({
      id: "guide",
      tone: "rose",
      title: "Read the study guide",
      detail: guide.stale
        ? `${plural(guide.changedSources.length, "source")} changed since it was made`
        : `Quotes checked against ${input.guideScopeLabel}`,
    });
  if (input.restricted || input.otherAccount) return actions;
  if (input.anchored === false)
    actions.push({
      id: "make-practice",
      tone: "coral",
      title: "Make practice from this material",
      detail: "Uses your connected AI. Magic checks each question against this material.",
    });
  // Only an answered path says the pool is empty; a failed or unknown read offers nothing to make.
  else if (path && path.questions === 0)
    actions.push({
      id: "make-practice",
      tone: "coral",
      title: "Make practice from this material",
      detail: "Uses your connected AI. Magic checks each question against the source.",
      ...(path && path.availability !== "current" ? { disabled: path.reason } : {}),
    });
  if (guide && guide.status === "missing")
    actions.push({
      id: "make-guide",
      tone: "rose",
      title: "Make a study guide",
      detail: `From ${input.guideScopeLabel}. Uses your connected AI.`,
    });
  return actions;
}

export interface Notice {
  tone: "info" | "attention";
  text: string;
  /** The generation reached the backend and may have changed what is ready. */
  refresh: boolean;
}
const NOUN: Record<string, string> = { quiz: "practice", cards: "flashcards", guide: "study guide" };

/** What a `pack` outcome means for the student, with nothing implied beyond the backend's answer. */
export function packNotice(outcome: PackOutcome): Notice {
  const noun = NOUN[outcome.pack] ?? "study material";
  switch (outcome.status) {
    case "done":
      return {
        tone: "info",
        text:
          outcome.pack === "guide"
            ? `${outcome.message} Open it below; every quote was checked against the saved material.`
            : outcome.counts.accepted > 0
              ? outcome.message
              : `No ${noun} passed the source checks. Nothing new is ready.`,
        refresh: true,
      };
    case "no_client":
      return { tone: "attention", text: outcome.message, refresh: false };
    case "blocked":
      return { tone: "attention", text: `Nothing was sent. ${outcome.message}`, refresh: false };
    case "needs_student":
      return { tone: "attention", text: outcome.message, refresh: true };
    case "empty":
      return { tone: "attention", text: outcome.message, refresh: false };
    case "paused":
    case "failed":
      return { tone: "attention", text: `${outcome.message} Your saved coursework is unchanged; you can try again.`, refresh: true };
    case "unknown_pack":
      return { tone: "attention", text: `Making ${noun} is not connected in this build.`, refresh: false };
  }
}

export function guideScopeLabel(moduleId: string | undefined, courseLabel: string): string {
  return moduleId ? "this module's saved materials" : `${courseLabel} saved materials`;
}

/**
 * The guide query and the `pack` command take only a course id, and the backend picks one account
 * for that course. A guide is shown for this item only when its `courseRef` is this item's
 * `accountScope:courseId`; any other answer is never mixed into this account's page.
 */
export function guideForAccount(
  guide: Capability<GuideQueryResult>,
  accountScope: string | undefined,
  courseId: string,
): Capability<GuideQueryResult> {
  if (guide.state !== "ok" || guide.data.courseRef === null) return guide;
  if (accountScope && guide.data.courseRef === `${accountScope}:${courseId}`) return guide;
  return {
    state: "unavailable",
    message: accountScope
      ? "Study guides for this course are saved under another connected account, so none are shown here."
      : "This item's account could not be confirmed, so no study guide is shown.",
  };
}

/** A study-guide status the student can act on; null when there is nothing worth saying. */
export function guideStatusText(guide: Capability<GuideQueryResult> | null): string | null {
  if (!guide || guide.state === "unconnected") return null;
  if (guide.state === "failed" || guide.state === "unavailable") return guide.message;
  const g = guide.data;
  if (g.status === "blocked" || g.status === "empty" || g.status === "unavailable") return g.message;
  return null;
}

const DIRECTION: Record<PracticeResults["topics"][number]["direction"], string> = {
  up: "Moved up to",
  down: "Moved down to",
  same: "Still",
  new: "First evidence:",
};
export function resultTopicLine(topic: PracticeResults["topics"][number]): string {
  return `${DIRECTION[topic.direction]} ${topic.afterLabel}`;
}
export function resultsSummary(results: PracticeResults): string {
  const parts = [`You answered ${results.answered}`];
  if (results.answered) parts.push(`${results.correct} matched the checked answer`);
  if (results.unscored) parts.push(`${results.unscored} could not be checked and ${results.unscored === 1 ? "was" : "were"} kept unscored`);
  if (results.skipped) parts.push(`${results.skipped} skipped`);
  return `${parts.join(", ")}.`;
}

export const RATINGS = [
  { rating: 1, label: "Again" },
  { rating: 2, label: "Hard" },
  { rating: 3, label: "Good" },
  { rating: 4, label: "Easy" },
] as const;
