// P01: the practice store interface (addendum §6): stars, option tags and
// notebook views. Digests and the notification log are not built: their only
// consumers (P15, P06) were dropped by D20 (course-backend §L).
import type { CourseRef } from "../store";

export type StarTarget = "item" | "card" | "concept";

export interface Star {
  courseRef: CourseRef;
  targetKind: StarTarget;
  targetId: string;
  createdAt: string;
}

/** The concept a distractor belongs to (≤1 per option, same course). Assigned in code (P12). */
export interface OptionTag {
  itemId: string;
  itemVersion: number;
  optionId: string;
  conceptId: string;
}

/** Notebook reading, for the coverage map's "studied" (PI-18). */
export interface LearningView {
  id: string;
  resourceId: string;
  version: number;
  start: number;
  end: number;
  activeSeconds: number;
  localDay: string;
  createdAt: string;
}

export interface PracticeStore {
  star(star: Star): void;
  unstar(courseRef: CourseRef, targetKind: StarTarget, targetId: string): void;
  stars(courseRef: CourseRef, targetKind?: StarTarget): Star[];
  isStarred(courseRef: CourseRef, targetKind: StarTarget, targetId: string): boolean;
  putOptionTag(tag: OptionTag): void;
  optionTags(itemId: string, itemVersion?: number): OptionTag[];
  addView(view: LearningView): void;
  views(filter?: { resourceId?: string; since?: string }): LearningView[];
  /** Cascade: a resource deleted from the workspace takes its views with it. */
  deleteResource(resourceId: string): void;
  reset(): void;
}
