// P11: stars and study filters (PI-14). A star is a private study mark,
// separate from Flag; it never touches the knowledge model. Every mode accepts
// a filter (all, starred, missed, Iffy). An empty filter says so and offers to
// widen it; it never silently serves the unfiltered set.
import type { MistakeEntry } from "../mistakes";
import type { ItemTag, LearningAttempt } from "../store";
import type { ConceptStateName } from "../types";
import type { PracticeStore, StarTarget } from "./store";

export type StudyFilter = "all" | "starred" | "missed" | "iffy";

export function setStar(practice: PracticeStore, courseRef: string, targetKind: StarTarget, targetId: string, starred: boolean, at: string): void {
  if (starred) practice.star({ courseRef, targetKind, targetId, createdAt: at });
  else practice.unstar(courseRef, targetKind, targetId);
}

export interface FilterEntry {
  id: string;
  /** The ID used for the "missed" test (a card's item). */
  itemId: string;
  targetKind: "item" | "card";
  tags: ItemTag[];
}

export interface FilterContext {
  courseRef: string;
  practice: PracticeStore;
  mistakes: MistakeEntry[];
  attempts: LearningAttempt[];
  today: string;
  bandOf: (conceptId: string) => ConceptStateName;
}

const EMPTY: Record<Exclude<StudyFilter, "all">, string> = {
  starred: "Nothing starred here yet. Study everything instead?",
  missed: "Nothing missed in the last 14 days, and nothing in your mistakes queue. Study everything instead?",
  iffy: "No Iffy topics right now. Study everything instead?",
};

const DAY = 86_400_000;

export function applyFilter<T extends FilterEntry>(pool: T[], filter: StudyFilter, ctx: FilterContext): { items: T[]; empty: boolean; message: string | null } {
  if (filter === "all") return { items: pool, empty: pool.length === 0, message: null };
  const primary = (e: T) => e.tags.find((t) => t.primary)?.conceptId ?? e.tags[0]?.conceptId;
  let keep: (e: T) => boolean;
  if (filter === "starred") {
    keep = (e) => {
      const c = primary(e);
      return ctx.practice.isStarred(ctx.courseRef, e.targetKind, e.id) || (c !== undefined && ctx.practice.isStarred(ctx.courseRef, "concept", c));
    };
  } else if (filter === "missed") {
    const queued = new Set(ctx.mistakes.map((m) => m.itemId));
    const recent = new Set(
      ctx.attempts.filter((a) => a.score < 0.5 && (Date.parse(ctx.today) - Date.parse(a.localDay)) / DAY < 14).map((a) => a.itemId),
    );
    keep = (e) => queued.has(e.itemId) || recent.has(e.itemId);
  } else {
    keep = (e) => {
      const c = primary(e);
      return c !== undefined && ctx.bandOf(c) === "iffy";
    };
  }
  const items = pool.filter(keep);
  return { items, empty: items.length === 0, message: items.length === 0 ? EMPTY[filter] : null };
}
