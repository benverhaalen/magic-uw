/** Motion roles for My Magic UW. Values follow Emil Kowalski's animate skill (d16ebe6):
 * strong custom curves, UI under 300ms, faster exits. motion.css declares the same values as
 * custom properties; tests/ui-motion.test.ts keeps the two in step.
 */
export const MOTION_EASE = {
  /** Entering, exiting and settling UI. */
  out: 'cubic-bezier(0.23, 1, 0.32, 1)',
  /** A panel that changes size in place (sidebar width). */
  drawer: 'cubic-bezier(0.32, 0.72, 0, 1)',
} as const;

export const MOTION_MS = {
  /** Drill in or out of a course, an item, or history Back/Forward. */
  page: 200,
  /** Same-level destination (Home to Calendar, one course to another). */
  pageLateral: 180,
  /** Reduced motion retains a short opacity cue without travel. */
  pageReduced: 120,
  /** Anchored popover or note, opening. */
  overlayEnter: 150,
  /** Closing is a system response, so it is quicker than opening. */
  overlayExit: 100,
  /** Course list rows and chevron. */
  disclosure: 200,
  /** Sidebar width and label fade. */
  drawer: 220,
} as const;

/** Horizontal travel for a directional page entrance, in CSS px. Small enough not to blur text. */
export const PAGE_SHIFT_PX = 12;
/** Starting opacity for a same-level page change. The new content is readable at once. */
export const LATERAL_FROM_OPACITY = 0.3;
export const REDUCED_FROM_OPACITY = 0.5;
