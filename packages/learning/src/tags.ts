// N05: the tag validator (KM-2). An item carries 1–3 concepts of its own
// course with exactly one primary; weights are 1.0 primary, 0.5 secondary.
import { CONFIG } from "./config";
import type { Concept, CourseRef, ItemTag } from "./store";

export interface ProposedTag {
  conceptId: string;
  primary: boolean;
}

export type TagResult = { ok: true; tags: ItemTag[] } | { ok: false; reason: string };

export function validateTags(tags: ProposedTag[], courseRef: CourseRef, map: Concept[]): TagResult {
  if (tags.length < 1 || tags.length > 3) return { ok: false, reason: `an item needs 1–3 concept tags, not ${tags.length}` };
  const ids = tags.map((t) => t.conceptId);
  if (new Set(ids).size !== ids.length) return { ok: false, reason: "a concept is tagged twice" };
  if (tags.filter((t) => t.primary).length !== 1) return { ok: false, reason: "exactly one tag must be primary" };
  const byId = new Map(map.map((c) => [c.id, c]));
  for (const t of tags) {
    const c = byId.get(t.conceptId);
    if (!c) return { ok: false, reason: `unknown concept ${t.conceptId}` };
    if (c.courseRef !== courseRef) return { ok: false, reason: `concept ${t.conceptId} belongs to another course` };
    if (c.status !== "active") return { ok: false, reason: `concept ${t.conceptId} is ${c.status}` };
  }
  return {
    ok: true,
    tags: tags.map((t) => ({
      conceptId: t.conceptId,
      primary: t.primary,
      weight: t.primary ? CONFIG.tagWeightPrimary.value : CONFIG.tagWeightSecondary.value,
    })),
  };
}
