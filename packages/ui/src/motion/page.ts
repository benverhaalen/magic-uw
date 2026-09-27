import { LATERAL_FROM_OPACITY, REDUCED_FROM_OPACITY, MOTION_EASE, MOTION_MS, PAGE_SHIFT_PX } from './tokens';

/** How a destination relates to where the student was. Direction explains location:
 * forward enters from the right (deeper), back from the left (returning), lateral only fades.
 */
export type PageDirection = 'forward' | 'back' | 'lateral';
/** push = a link or control; back/forward = history travel. */
export type PageVia = 'push' | 'back' | 'forward';

/** History travel keeps the Back/Forward arrow's direction. A push compares hierarchy depth,
 * so "All courses" from a course page reads as returning even though it adds a history entry.
 */
export function pageDirection(fromDepth: number, toDepth: number, via: PageVia): PageDirection {
  if (via !== 'push') return via;
  return toDepth > fromDepth ? 'forward' : toDepth < fromDepth ? 'back' : 'lateral';
}

export interface PageEnterPlan {
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  /** Starting opacity, recorded so a later interruption can continue from the current value. */
  from: number;
  /** Signed horizontal travel in px; 0 when the entrance only fades. */
  shift: number;
}

/** Entrance for the incoming page only. The outgoing page is removed in the same commit, so an
 * old course never shows beneath the new title. No scale, so text does not resample.
 * `carriedOpacity` is the visible opacity of an entrance that a new navigation interrupted: the
 * next page continues from it with proportionally less travel and time. Nothing queues.
 * Returns null when there is nothing left to animate.
 */
export function pageEnterPlan(direction: PageDirection, { reduced = false, carriedOpacity = null }:
  { reduced?: boolean; carriedOpacity?: number | null } = {}): PageEnterPlan | null {
  const quiet = reduced || direction === 'lateral';
  const base = reduced ? REDUCED_FROM_OPACITY : direction === 'lateral' ? LATERAL_FROM_OPACITY : 0;
  const from = Math.min(1, Math.max(base, carriedOpacity ?? 0));
  const remaining = (1 - from) / (1 - base);
  const duration = Math.round((reduced ? MOTION_MS.pageReduced : quiet ? MOTION_MS.pageLateral : MOTION_MS.page) * remaining);
  if (duration < 16) return null;
  const shift = quiet ? 0 : Math.round((direction === 'forward' ? 1 : -1) * PAGE_SHIFT_PX * remaining * 10) / 10;
  const keyframes: Keyframe[] = shift
    ? [{ opacity: from, transform: `translateX(${shift}px)` }, { opacity: 1, transform: 'none' }]
    : [{ opacity: from }, { opacity: 1 }];
  return { keyframes, options: { duration, easing: MOTION_EASE.out, fill: 'none' }, from, shift };
}

export const PAGE_MOTION_ATTRIBUTE = 'data-magic-page-motion';
/** Children marked with this attribute (for example a fixed launcher) never move. */
export const PAGE_STATIC_ATTRIBUTE = 'data-motion-static';

interface Running { animations: Animation[]; from: number }
const running = new WeakMap<Element, Running>();

function visibleOpacity(entry: Running): number | null {
  const animation = entry.animations.find(item => item.playState === 'running');
  const progress = animation?.effect?.getComputedTiming().progress;
  return progress == null ? null : entry.from + (1 - entry.from) * progress;
}

export function prefersReducedMotion(node: Element): boolean {
  return node.ownerDocument.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches ?? false;
}

/** Cancel any running entrance in `pane` without starting a new one (for example on unmount). */
export function settlePage(pane: Element): void {
  running.get(pane)?.animations.forEach(animation => animation.cancel());
  running.delete(pane);
  pane.removeAttribute(PAGE_MOTION_ATTRIBUTE);
}

/** Animate the incoming children of a scroll pane. Call after the destination's scroll, open
 * disclosures and focus are restored, in the same layout effect, so the first painted frame is
 * already the right place. Transforms never change scroll position or focus.
 * While a rightward entrance runs, the pane carries PAGE_MOTION_ATTRIBUTE so motion.css can
 * suppress a transient horizontal scrollbar.
 */
export function playPageEnter(pane: HTMLElement, direction: PageDirection,
  reduced: boolean = prefersReducedMotion(pane)): Animation[] {
  const previous = running.get(pane);
  const carriedOpacity = previous ? visibleOpacity(previous) : null;
  settlePage(pane);
  const plan = pageEnterPlan(direction, { reduced, carriedOpacity });
  const targets = (Array.from(pane.children) as HTMLElement[]).filter(node =>
    typeof node.animate === 'function' && !node.hasAttribute(PAGE_STATIC_ATTRIBUTE));
  if (!plan || !targets.length) return [];
  if (plan.shift > 0) pane.setAttribute(PAGE_MOTION_ATTRIBUTE, '');
  const entry: Running = { animations: targets.map(node => node.animate(plan.keyframes, plan.options)), from: plan.from };
  running.set(pane, entry);
  Promise.all(entry.animations.map(animation => animation.finished)).then(() => {
    if (running.get(pane) === entry) settlePage(pane);
  }, () => { /* cancelled by a newer navigation, which owns the pane now */ });
  return entry.animations;
}
