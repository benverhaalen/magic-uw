import type { ResourceView, SourceHealth } from "@magic/contracts";
import { courseKey } from "../../../../../packages/domain/src/course-page";
import type { CourseCard } from "../../../../../packages/domain/src/course-page";
import { IDENTITY_HUES, type IdentityHue } from "../../../../../packages/ui/src/deadline-emphasis";

/**
 * Course identity hue for the Courses index. Proposed shared seam: it reads the same
 * IDENTITY_HUES wheel and [data-magic-hue] role pairs as the assignment-type mapper and adds no
 * palette. Each course starts at a hash of its stable key (account scope + course id, never the
 * name). A taken hue, or one beside a taken hue on the wheel (green/mint read alike on neighbouring
 * cards), steps on around the wheel. At least ceil(n / 3) courses always fit apart; when no such slot is left, any free hue is used, and only past
 * IDENTITY_HUES.length courses do hues repeat. Deterministic for a set of keys in any order.
 */
export function courseIdentityHues(keys: readonly string[]): Map<string, IdentityHue> {
  const n = IDENTITY_HUES.length;
  const used = new Set<number>(), result = new Map<string, IdentityHue>();
  const near = (slot: number) => used.has((slot + 1) % n) || used.has((slot + n - 1) % n);
  for (const key of [...new Set(keys)].sort()) {
    const start = fnv1a(key) % n;
    const order = Array.from({ length: n }, (_, i) => (start + i) % n);
    const slot =
      order.find((s) => !used.has(s) && !near(s)) ?? order.find((s) => !used.has(s)) ?? start;
    used.add(slot);
    result.set(key, IDENTITY_HUES[slot]!);
  }
  return result;
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return hash;
}

/** The heading names a term only when every card reports the same captured term. */
export function sharedTerm(cards: readonly CourseCard[]): string | null {
  const terms = new Set(cards.map((c) => c.term?.trim() || null));
  const [only] = terms;
  return terms.size === 1 && only ? compactCourseTerm(only) : null;
}

export type Coverage = CourseCard["freshness"];
export interface CoverageGroup {
  freshness: Exclude<Coverage, "current_capture">;
  cards: CourseCard[];
  /** Oldest last-checked time in the group; null when a course was never checked. */
  checkedAt: string | null;
}

/**
 * Courses whose saved copy is not a complete current capture, grouped by state. Empty when every
 * course is current, so the page shows no freshness note at all.
 */
export function coverageGroups(cards: readonly CourseCard[]): CoverageGroup[] {
  const order: CoverageGroup["freshness"][] = ["stale", "partial", "unknown"];
  return order
    .map((freshness) => {
      const group = cards.filter((c) => c.freshness === freshness);
      const times = group.map((c) => c.lastSuccessAt);
      const checkedAt = times.includes(null) ? null : ([...times].sort()[0] ?? null);
      return { freshness, cards: group, checkedAt };
    })
    .filter((g) => g.cards.length);
}

/**
 * What a card says when it has no dated upcoming work. A complete current capture may say there is
 * none; anything less says only what the saved copy contains, so partial coverage is never an all-clear.
 */
export function emptyNextText(card: Pick<CourseCard, "freshness" | "assignments">): string {
  const current = card.freshness === "current_capture";
  if (!card.assignments) return current ? "No assignments found" : "No assignments in the saved copy";
  return current ? "No upcoming dated work" : "No upcoming dated work in the saved copy";
}

export const undatedText = (count: number) =>
  count === 1 ? "1 assignment has no due date" : `${count} assignments have no due date`;


/** Presentation only for the captured UW Fall academic-year label. Membership keeps its raw term. */
export function compactCourseTerm(term: string): string {
  const match = /^Fall\s+(\d{4})\s*[-–]\s*(\d{4})$/i.exec(term.trim());
  return match && Number(match[2]) === Number(match[1]) + 1 ? `Fall ${match[1]}` : term;
}

export interface CanvasCurrentGrade { score: number; observedAt: string }
/** Exact saved LMS evidence, never a calculated average, final score, planning grade or cross-account match. */
export function canvasCurrentGrades(cards: readonly CourseCard[], resources: readonly ResourceView[], sources: readonly SourceHealth[], now: string): Map<string, CanvasCurrentGrade> {
  const result = new Map<string, CanvasCurrentGrade>();
  const bySource = new Map(sources.map(source => [source.id, source]));
  const currentCards = new Set(cards.filter(card => card.freshness === "current_capture").map(card => card.key));
  const records = new Map<string, ResourceView[]>();
  for (const record of resources) {
    const source = bySource.get(record.sourceId);
    if (record.deleted || record.kind !== "course" || source?.kind !== "canvas" || !source.accountScope) continue;
    const key = courseKey(source.accountScope, record.courseId);
    if (!currentCards.has(key)) continue;
    records.set(key, [...(records.get(key) ?? []), record]);
  }
  for (const [key, courses] of records) {
    const evidence = courses.flatMap(course => course.course?.gradeEvidence ?? []);
    // Reuse the course read model's one-day current-capture horizon, and check the exact grade
    // record too: a successful assignment fetch cannot make an older course score current.
    const fresh = courses.every(course => {
      const source = bySource.get(course.sourceId)!;
      const age = Date.parse(now) - Date.parse(course.observedAt);
      return source.status === "ok" && source.complete && Number.isFinite(age) && age >= 0 && age <= 86_400_000;
    });
    if (!fresh || !evidence.length || courses.some(course => !course.course?.gradeEvidence?.length) || evidence.some(grade => typeof grade.currentScore !== "number" || !Number.isFinite(grade.currentScore))) continue;
    const scores = new Set(evidence.map(grade => grade.currentScore!));
    if (scores.size !== 1) continue;
    result.set(key, { score: [...scores][0]!, observedAt: courses.map(course => course.observedAt).sort()[0]! });
  }
  return result;
}
