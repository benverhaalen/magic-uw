// P01: the in-memory practice store, with the SQL keys and cascade rules.
// Targets are checked against the LearningStore, so a star or option tag can't
// point at something that doesn't exist.
import type { LearningStore } from "../store";
import type { LearningView, OptionTag, PracticeStore, Star, StarTarget } from "./store";

export function createMemoryPracticeStore(learning: LearningStore): PracticeStore {
  let stars = new Map<string, Star>();
  let optionTags = new Map<string, OptionTag>();
  let views = new Map<string, LearningView>();
  const starKey = (ref: string, kind: StarTarget, id: string) => `${ref}|${kind}|${id}`;

  const targetExists = (s: Star): boolean => {
    switch (s.targetKind) {
      case "item":
        return learning.items({ courseRef: s.courseRef, ids: [s.targetId] }).length > 0;
      case "card":
        return learning.cards({ courseRef: s.courseRef }).some((c) => c.id === s.targetId);
      case "concept":
        return learning.concepts(s.courseRef).some((c) => c.id === s.targetId);
    }
  };

  return {
    star(star) {
      if (!targetExists(star)) throw new Error(`unknown ${star.targetKind} ${star.targetId} in ${star.courseRef}`);
      const key = starKey(star.courseRef, star.targetKind, star.targetId);
      if (!stars.has(key)) stars.set(key, { ...star });
    },
    unstar(courseRef, targetKind, targetId) {
      stars.delete(starKey(courseRef, targetKind, targetId));
    },
    stars(courseRef, targetKind) {
      return [...stars.values()].filter((s) => s.courseRef === courseRef && (!targetKind || s.targetKind === targetKind)).map((s) => ({ ...s }));
    },
    isStarred(courseRef, targetKind, targetId) {
      return stars.has(starKey(courseRef, targetKind, targetId));
    },
    putOptionTag(tag) {
      const stored = learning.items({ ids: [tag.itemId] }).find((s) => s.item.version === tag.itemVersion);
      if (!stored) throw new Error(`unknown item ${tag.itemId}@${tag.itemVersion}`);
      if (!stored.item.options?.some((o) => o.id === tag.optionId)) throw new Error(`unknown option ${tag.optionId}`);
      if (!learning.concepts(stored.item.courseRef).some((c) => c.id === tag.conceptId)) {
        throw new Error(`concept ${tag.conceptId} is not in the item's course`);
      }
      optionTags.set(`${tag.itemId}|${tag.itemVersion}|${tag.optionId}`, { ...tag });
    },
    optionTags(itemId, itemVersion) {
      return [...optionTags.values()].filter((t) => t.itemId === itemId && (itemVersion === undefined || t.itemVersion === itemVersion)).map((t) => ({ ...t }));
    },
    addView(view) {
      if (view.activeSeconds < 0 || view.end < view.start) throw new Error("invalid view span or duration");
      if (!views.has(view.id)) views.set(view.id, { ...view });
    },
    views(filter = {}) {
      return [...views.values()]
        .filter((v) => (!filter.resourceId || v.resourceId === filter.resourceId) && (!filter.since || v.createdAt >= filter.since))
        .map((v) => ({ ...v }));
    },
    deleteResource(resourceId) {
      for (const [k, v] of views) if (v.resourceId === resourceId) views.delete(k);
    },
    reset() {
      stars = new Map();
      optionTags = new Map();
      views = new Map();
    },
  };
}
