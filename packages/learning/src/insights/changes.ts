// P13: what changed since last week (PI-24). State transitions, each with the
// rule that caused it and its evidence, found by replaying the stored evidence
// at the end of each day; and course materials new or changed since. Every line
// comes from a stored event or capture; nothing is inferred or generated.
import { CONFIG, type KnowledgeConfig } from "../config";
import { shortDate } from "../knowledge/rules";
import { conceptState, type KnowledgeEvidence } from "../knowledge/state";
import type { Concept } from "../store";
import { STATE_LABEL, type ConceptStateName, type RuleId } from "../types";

export interface Transition {
  conceptId: string;
  day: string;
  from: ConceptStateName;
  to: ConceptStateName;
  rules: RuleId[];
  eventIds: string[];
  text: string;
}

const endOfDay = (day: string) => new Date(`${day}T23:59:59.999Z`);

export function stateTransitions(
  evidence: KnowledgeEvidence,
  map: Concept[],
  since: string,
  today: string,
  config: KnowledgeConfig = CONFIG,
): Transition[] {
  const days = [
    ...new Set([
      ...evidence.attempts.map((a) => a.localDay),
      ...evidence.reviews.map((r) => r.localDay),
      today,
    ]),
  ]
    .filter((d) => d > since && d <= today)
    .sort();
  const label = new Map(map.map((c) => [c.id, c.studentLabel ?? c.label]));
  const cut = (day: string): KnowledgeEvidence => ({
    ...evidence,
    attempts: evidence.attempts.filter((a) => a.localDay <= day),
    reviews: evidence.reviews.filter((r) => r.localDay <= day),
    selfRatings: evidence.selfRatings.filter((s) => s.localDay <= day),
  });
  let prev = new Map(conceptState(cut(since), map, config, endOfDay(since), undefined, { today: since }).map((m) => [m.conceptId, m]));
  const out: Transition[] = [];
  for (const day of days) {
    const cur = conceptState(cut(day), map, config, endOfDay(day), undefined, { today: day });
    for (const m of cur) {
      const before = prev.get(m.conceptId);
      if (!before || before.band === m.band) continue;
      const why = m.reasons.length ? ` ${m.reasons.map((r) => `${r.text} (${r.rule})`).join(" ")}` : "";
      out.push({
        conceptId: m.conceptId,
        day,
        from: before.band,
        to: m.band,
        rules: m.reasons.map((r) => r.rule),
        eventIds: [...new Set(m.reasons.flatMap((r) => r.eventIds))],
        text: `${label.get(m.conceptId) ?? m.conceptId}: ${STATE_LABEL[before.band]} → ${STATE_LABEL[m.band]} on ${shortDate(day)}.${why}`,
      });
    }
    prev = new Map(cur.map((m) => [m.conceptId, m]));
  }
  return out;
}

export interface MaterialRecord {
  id: string;
  title: string;
  firstSeenAt: string;
  lastChangedAt: string;
  version: number;
}

export interface MaterialChange {
  resourceId: string;
  kind: "new" | "changed";
  text: string;
  at: string;
}

/** Course materials new or changed since a date, from the capture records. */
export function materialChanges(records: MaterialRecord[], since: string): MaterialChange[] {
  return records
    .flatMap((r): MaterialChange[] => {
      if (r.firstSeenAt.slice(0, 10) > since) return [{ resourceId: r.id, kind: "new", text: `New: ${r.title}`, at: r.firstSeenAt }];
      if (r.version > 1 && r.lastChangedAt.slice(0, 10) > since) return [{ resourceId: r.id, kind: "changed", text: `Changed: ${r.title}`, at: r.lastChangedAt }];
      return [];
    })
    .sort((a, b) => (a.at < b.at ? 1 : -1));
}
