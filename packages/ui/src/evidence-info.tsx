import { MagicGlyph } from './glyph';
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';

function InfoGlyph() {
  return <MagicGlyph className="magic-info-glyph" name="info" size={16} />;
}

interface Box { left: number; top: number; bottom: number }
/** Below the trigger when it fits, otherwise above, otherwise clamped; always inside the viewport margin. */
export function placeInfoPanel(anchor: Box, panel: { width: number; height: number },
  viewport: { width: number; height: number }, margin = 12, gap = 6) {
  const left = Math.max(margin, Math.min(anchor.left, viewport.width - panel.width - margin));
  const below = anchor.bottom + gap, above = anchor.top - gap - panel.height;
  const top = below + panel.height <= viewport.height - margin ? below
    : above >= margin ? above
    : Math.max(margin, Math.min(below, viewport.height - panel.height - margin));
  return { left, top };
}

/** Small circled-i toggletip for routine provenance, refresh and coverage detail.
 * Click/Enter/Space toggles a native nonmodal popover; focus stays on the trigger and the next Tab
 * enters the panel. Escape closes and returns focus to the trigger; an outside click closes without
 * taking focus back; focus leaving both closes. Declared invoker (popovertarget) keeps a second press
 * from light-dismissing and reopening. Hover never opens it.
 * Children are short phrasing content (text, links); no buttons. A blocking fact keeps a visible cue
 * in the caller; this adds detail beside it. Never place inside another button or link.
 */
export function EvidenceInfo({ label, children }: { label: string; children: ReactNode }) {
  const id = useId(), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const element = panel.current!;
    const update = () => setOpen(element.matches(':popover-open'));
    element.addEventListener('toggle', update);
    return () => element.removeEventListener('toggle', update);
  }, []);
  function place() {
    const element = panel.current!, width = Math.min(320, innerWidth - 24);
    element.style.width = `${width}px`;
    const { left, top } = placeInfoPanel(trigger.current!.getBoundingClientRect(),
      { width, height: element.offsetHeight }, { width: innerWidth, height: innerHeight });
    element.style.left = `${left}px`; element.style.top = `${top}px`;
  }
  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);
  const hide = () => { if (panel.current?.matches(':popover-open')) panel.current.hidePopover(); };
  const leaving = (to: EventTarget | null) => to instanceof Node && !panel.current!.contains(to) && to !== trigger.current;
  return <span className="magic-info" onClick={event => event.stopPropagation()}>
    <button ref={trigger} type="button" className="magic-info-trigger" aria-label={label} aria-expanded={open}
      aria-controls={id} popoverTarget={id}
      onClick={event => {
        event.preventDefault();
        if (panel.current!.matches(':popover-open')) hide();
        else { panel.current!.showPopover(); place(); }
      }}
      onKeyDown={event => { if (event.key === 'Escape' && open) { event.preventDefault(); hide(); } }}
      onBlur={event => { if (leaving(event.relatedTarget)) hide(); }}><InfoGlyph /></button>
    <span ref={panel} id={id} popover="auto" role="note" aria-label={label} className="magic-info-panel"
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); hide(); trigger.current?.focus(); } }}
      onBlur={event => { if (leaving(event.relatedTarget)) hide(); }}
      onClick={event => { if ((event.target as Element).closest('a')) hide(); }}>{children}</span>
  </span>;
}
