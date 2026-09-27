// N07: the Elo-style update (spec §5.3), exactly as specified.
import type { KmParams } from "../config";
import type { ItemTag } from "../store";
import type { KnowledgeEvent } from "./events";

export const sigma = (x: number) => 1 / (1 + Math.exp(-x));

export interface Ability {
  theta: number;
  n: number;
}

/** Normalised tag weights ω_c = w_c / Σ w_k. */
export function omegas(tags: ItemTag[]): Map<string, number> {
  const total = tags.reduce((s, t) => s + t.weight, 0) || 1;
  return new Map(tags.map((t) => [t.conceptId, t.weight / total]));
}

/** Guessing floor: 1/k for MC with k options, 0.5 for T/F, 0 otherwise. */
export function guessFloor(format: KnowledgeEvent["format"], options: number): number {
  if (format === "tf") return 0.5;
  if (format === "mc") return options > 0 ? 1 / options : 0;
  return 0;
}

/** P_i = g + (1 − g)·σ(θ_i − b), with θ_i = Σ ω_c θ_c. */
export function expectedSuccess(abilities: Map<string, Ability>, tags: ItemTag[], b: number, g: number): number {
  let thetaI = 0;
  for (const [c, w] of omegas(tags)) thetaI += w * (abilities.get(c)?.theta ?? 0);
  return g + (1 - g) * sigma(thetaI - b);
}

/** Apply one scored, included event in place. */
export function applyEvent(abilities: Map<string, Ability>, e: KnowledgeEvent, p: KmParams): void {
  const P = expectedSuccess(abilities, e.tags, e.b, guessFloor(e.format, e.options));
  for (const [c, w] of omegas(e.tags)) {
    const a = abilities.get(c) ?? { theta: 0, n: 0 };
    const step = p.alpha / (1 + p.beta * a.n);
    abilities.set(c, { theta: a.theta + e.v * w * step * (e.y - P), n: a.n + e.v * w });
  }
}

/** Concept summaries against the reference item (heuristic margins, not intervals). */
export function summaries(a: Ability, p: KmParams): { s: number; pHat: number; pLow: number; pHigh: number } {
  const s = p.s0 / Math.sqrt(1 + a.n);
  return {
    s,
    pHat: sigma(a.theta - p.bRef),
    pLow: sigma(a.theta - p.bRef - s),
    pHigh: sigma(a.theta - p.bRef + s),
  };
}
