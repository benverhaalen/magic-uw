// N10: the priority of a concept (spec §5.7):
//   need = 1 − p̂ (n > 0), 0.6 (Not seen yet); rules = min(0.75, 0.25 × fired)
//   urgency = 1 + 2·e^(−d/7) when covered by an assessment d ≥ 0 days away, else 1
//   priority = urgency · (need + rules)
import { CONFIG, params, type KmParams, type KnowledgeConfig } from "./config";
import type { ConceptModel } from "./knowledge/state";
import { expectedSuccess, guessFloor } from "./knowledge/elo";
import type { ItemTag } from "./store";
import type { ItemFormat } from "./config";

export function conceptPriority(m: Pick<ConceptModel, "n" | "pHat" | "band" | "reasons" | "coveredBy">, config: KnowledgeConfig = CONFIG): number {
  const p: KmParams = params(config);
  const need = m.band === "not_seen" || m.n === 0 ? p.needNotSeen : 1 - m.pHat;
  const rules = Math.min(p.rulesCap, p.rulesPerFire * m.reasons.length);
  const next = m.coveredBy.filter((a) => a.daysAway >= 0).sort((a, b) => a.daysAway - b.daysAway)[0];
  const urgency = next ? 1 + p.urgencyAmplitude * Math.exp(-next.daysAway / p.urgencyTauDays) : 1;
  return urgency * (need + rules);
}

/** Predicted P_i for this student, from the concepts' current abilities. */
export function predictedSuccess(models: Map<string, Pick<ConceptModel, "theta" | "n">>, item: { kind: ItemFormat | "card"; options: number; bPrior: number; tags: ItemTag[] }): number {
  const abilities = new Map([...models].map(([id, m]) => [id, { theta: m.theta, n: m.n }]));
  const g = item.kind === "card" ? 0 : guessFloor(item.kind, item.options);
  return expectedSuccess(abilities, item.tags, item.bPrior, g);
}

/** Distance from a target band: 0 inside it. */
export function bandDistance(p: number, [lo, hi]: [number, number]): number {
  return p < lo ? lo - p : p > hi ? p - hi : 0;
}
