// P14: session history (PI-22 as amended by course-backend §L): each session's
// mode, items and outcomes as counts, the concepts touched and their anchors.
// No time-on-task, active-minute or productivity totals, and nothing here feeds
// the knowledge model.
import type { Dispute, ItemSource, LearningAttempt, LearningSession } from "../store";

export interface HistoryAnchor {
  resourceId: string;
  start: number;
  end: number;
  quote: string;
}

export interface SessionSummary {
  sessionId: string;
  kind: string;
  startedAt: string;
  items: number;
  outcomes: { right: number; partial: number; wrong: number; contested: number; withHelp: number };
  concepts: string[];
  anchors: HistoryAnchor[];
}

export function sessionHistory(
  sessions: LearningSession[],
  attempts: LearningAttempt[],
  opts: { disputes?: Dispute[]; sourcesByItem?: Map<string, ItemSource[]> } = {},
): SessionSummary[] {
  const contested = new Set((opts.disputes ?? []).filter((d) => d.status === "open" && d.targetKind === "grade").map((d) => d.targetId));
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const groups = new Map<string, LearningAttempt[]>();
  for (const a of attempts) groups.set(a.sessionId, [...(groups.get(a.sessionId) ?? []), a]);
  const out: SessionSummary[] = [];
  for (const [sessionId, list] of groups) {
    const s = byId.get(sessionId);
    const first = [...list].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0]!;
    const counted = list.filter((a) => !contested.has(a.id));
    const anchors = new Map<string, HistoryAnchor>();
    for (const a of list) {
      for (const src of opts.sourcesByItem?.get(a.itemId) ?? []) {
        if (!src.quoteValid) continue;
        anchors.set(`${src.resourceId}:${src.start}`, { resourceId: src.resourceId, start: src.start, end: src.end, quote: src.quote });
      }
    }
    out.push({
      sessionId,
      kind: s?.kind ?? first.mode,
      startedAt: s?.startedAt ?? first.createdAt,
      items: new Set(list.map((a) => a.itemId)).size,
      outcomes: {
        right: counted.filter((a) => a.score >= 1).length,
        partial: counted.filter((a) => a.score > 0 && a.score < 1).length,
        wrong: counted.filter((a) => a.score === 0).length,
        contested: list.length - counted.length,
        withHelp: counted.filter((a) => a.assistance !== "none").length,
      },
      concepts: [...new Set(list.flatMap((a) => a.conceptTags.map((t) => t.conceptId)))].sort(),
      anchors: [...anchors.values()],
    });
  }
  return out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}
