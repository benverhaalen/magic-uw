// N09: the mistakes queue (ST-6, ST-9). Every missed item is in it; confident
// misses come first; a spaced unassisted success lowers an item's priority;
// nothing retires. A flagged or quarantined item leaves at once and never
// returns while flagged.
import { CONFIG } from "./config";
import type { Dispute, LearningAttempt } from "./store";

export interface MistakeEntry {
  itemId: string;
  lastMissId: string;
  lastMissDay: string;
  /** An unassisted miss at confidence ≥ 0.67 not yet answered right since. */
  confident: boolean;
  /** Spaced unassisted successes after the last miss (each on a later day). */
  spacedSuccesses: number;
  priority: number;
  /** Not yet attempted today. */
  due: boolean;
}

export function mistakesQueue(
  attempts: LearningAttempt[],
  opts: { today: string; disputes?: Dispute[]; quarantined?: Set<string> },
): MistakeEntry[] {
  const blocked = new Set([
    ...(opts.disputes ?? []).filter((d) => d.status === "open" && d.targetKind === "item").map((d) => d.targetId),
    ...(opts.quarantined ?? []),
  ]);
  const disputedGrades = new Set((opts.disputes ?? []).filter((d) => d.status === "open" && d.targetKind === "grade").map((d) => d.targetId));
  const byItem = new Map<string, LearningAttempt[]>();
  for (const a of [...attempts].sort((x, y) => (x.createdAt < y.createdAt ? -1 : 1))) {
    if (disputedGrades.has(a.id)) continue;
    byItem.set(a.itemId, [...(byItem.get(a.itemId) ?? []), a]);
  }
  const out: MistakeEntry[] = [];
  for (const [itemId, list] of byItem) {
    if (blocked.has(itemId)) continue;
    const misses = list.filter((a) => a.score < 0.5);
    const lastMiss = misses.at(-1);
    if (!lastMiss) continue;
    const after = list.filter((a) => a.createdAt > lastMiss.createdAt);
    const spaced = new Set(after.filter((a) => a.assistance === "none" && a.score >= 1 && a.localDay > lastMiss.localDay).map((a) => a.localDay)).size;
    const confidentMiss = misses.some(
      (m) => m.assistance === "none" && m.confidence !== null && m.confidence >= CONFIG.r4MinConfidence.value && !list.some((a) => a.createdAt > m.createdAt && a.assistance === "none" && a.score >= 1),
    );
    // Priority halves with each spaced success and never reaches zero: nothing retires.
    const priority = (1 + (confidentMiss ? 1 : 0) + 0.25 * Math.min(misses.length - 1, 4)) / 2 ** spaced;
    out.push({
      itemId,
      lastMissId: lastMiss.id,
      lastMissDay: lastMiss.localDay,
      confident: confidentMiss,
      spacedSuccesses: spaced,
      priority,
      due: list.at(-1)!.localDay < opts.today,
    });
  }
  return out.sort((a, b) =>
    a.confident !== b.confident ? (a.confident ? -1 : 1) : b.priority !== a.priority ? b.priority - a.priority : a.lastMissDay < b.lastMissDay ? 1 : a.lastMissDay > b.lastMissDay ? -1 : a.itemId < b.itemId ? -1 : 1,
  );
}
