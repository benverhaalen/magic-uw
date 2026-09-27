/** Anchored overlay entrance: the panel travels a few pixels out of its trigger, so a note or
 * link list visibly belongs to the control that opened it. Translation only; no scale on text.
 */
export type AnchorSide = 'below' | 'above';
export const ANCHOR_ATTRIBUTE = 'data-magic-anchor';

/** Which side of the trigger the placed panel ended up on (collision flipping included). */
export function anchorSide(trigger: { top: number; bottom: number }, panel: { top: number; bottom: number }): AnchorSide {
  return panel.top + panel.bottom < trigger.top + trigger.bottom ? 'above' : 'below';
}

/** Call at the end of the host's placement, synchronously after showPopover(), so the entrance
 * starts from the correct side in the first frame. The panel also needs
 * `data-magic-motion="anchored"` for motion.css to apply.
 */
export function markAnchor(panel: HTMLElement, trigger: Element): AnchorSide {
  const side = anchorSide(trigger.getBoundingClientRect(), panel.getBoundingClientRect());
  panel.setAttribute(ANCHOR_ATTRIBUTE, side);
  return side;
}
