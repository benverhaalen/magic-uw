import { MOTION_EASE, MOTION_MS } from '../../../../../packages/ui/src/motion/tokens';
import type { CoursesMode } from './CoursesViewToggle';

const FROM = 0.2, SHIFT = 8;
/** Reversal continues from the currently painted opacity; no delayed state commit or exit clone. */
export function courseModeEnterPlan(mode: CoursesMode, reduced: boolean, carried: number | null = null) {
  if (reduced) return null;
  const from = Math.min(1, Math.max(FROM, carried ?? FROM));
  const remaining = (1 - from) / (1 - FROM);
  const duration = Math.round(MOTION_MS.drawer * remaining);
  if (duration < 16) return null;
  const shift = (mode === 'list' ? 1 : -1) * SHIFT * remaining;
  return { from, keyframes: [{ opacity: from, transform: `translateX(${shift}px)` }, { opacity: 1, transform: 'none' }],
    options: { duration, easing: MOTION_EASE.out, fill: 'none' as const } };
}
interface Running { animation: Animation; from: number }
const running = new WeakMap<HTMLElement, Running>();
export function settleCourseMode(pane: HTMLElement) {
  running.get(pane)?.animation.cancel();
  running.delete(pane);
  pane.removeAttribute('data-course-mode-motion');
}
/** Called by navigation after it restores the incoming view's scroll, disclosures and focus.
 * The outgoing React body has already unmounted. Only the live body animates; header stays steady.
 * Animation.finished owns cleanup, and identity checks prevent a cancelled predecessor settling a
 * newer transition. No timers delay navigation, mount an exit layer, or gate clicks.
 */
export function playCourseModeEnter(pane: HTMLElement, mode: CoursesMode) {
  const previous = running.get(pane);
  const progress = previous?.animation.effect?.getComputedTiming().progress;
  const carried = previous && progress != null ? previous.from + (1 - previous.from) * progress : null;
  settleCourseMode(pane);
  const reduced = pane.ownerDocument.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches ?? false;
  const plan = courseModeEnterPlan(mode, reduced, carried);
  const body = pane.querySelector<HTMLElement>('.desktop-courses > .courses-index, .desktop-courses > .cw-list');
  if (!plan || !body || typeof body.animate !== 'function') return;
  pane.setAttribute('data-course-mode-motion', '');
  const entry: Running = { animation: body.animate(plan.keyframes, plan.options), from: plan.from };
  running.set(pane, entry);
  entry.animation.finished.then(() => {
    if (running.get(pane) === entry) settleCourseMode(pane);
  }, () => { /* newer navigation or unmount owns cleanup */ });
}
