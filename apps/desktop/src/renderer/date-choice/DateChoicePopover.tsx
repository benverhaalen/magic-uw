import {useEffect, useId, useLayoutEffect, useRef, useState} from 'react';
import {Action} from '../../../../../packages/ui/src';
import {markAnchor} from '../../../../../packages/ui/src/motion/anchor';
import type {DateChoiceOption} from './model';
import './date-choice.css';

export interface DateChoicePopoverProps {
  options: DateChoiceOption[];
  focusKey?: string;
  sourceVersion: string;
  savedKey: string | null;
  previousLabel?: string;
  needsReview?: boolean;
  pending?: boolean;
  error?: string;
  unavailable?: string;
  unresolvedCount?: number;
  onCommit: (option: DateChoiceOption | null) => void;
  onInspect: () => void;
}
/** Controlled persisted choice. Selecting a radio is a draft; only parent readback
 * can set savedKey. Native popover gives light dismissal without a modal focus trap. */
export function DateChoicePopover({options, focusKey, sourceVersion, savedKey, previousLabel, needsReview=false, pending=false, error, unavailable, unresolvedCount=0, onCommit, onInspect}: DateChoicePopoverProps) {
  const id = useId(), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const [open,setOpen] = useState(false), [draft,setDraft] = useState<string | null>(savedKey);
  const saved = options.find(option => option.key === savedKey);
  const canChoose = options.length > 0 && !unavailable;
  const latestVersion = useRef(sourceVersion);
  // Source changes invalidate unsaved input and keep the review open with the new facts.
  useEffect(() => {
    setDraft(savedKey); latestVersion.current=sourceVersion;
    // A changed evidence version may replace the focused radio's keyed DOM node.
    if(panel.current?.matches(':popover-open') && document.activeElement===document.body) panel.current.querySelector<HTMLInputElement>('input')?.focus({preventScroll:true});
  }, [sourceVersion,savedKey]);
  useEffect(() => {
    const element=panel.current!;
    const update=()=>setOpen(element.matches(':popover-open'));
    element.addEventListener('toggle',update);
    return ()=>element.removeEventListener('toggle',update);
  },[]);
  function place() {
    const element=panel.current, anchor=trigger.current;
    if(!element || !anchor) return;
    const rect=anchor.getBoundingClientRect(), width=Math.min(352,innerWidth-24);
    element.style.width=`${width}px`;
    element.style.left=`${Math.max(12,Math.min(rect.left,innerWidth-width-12))}px`;
    const below=rect.bottom+8;
    const above=rect.top-element.offsetHeight-8;
    element.style.top=`${Math.max(12,below+element.offsetHeight <= innerHeight-12 ? below : Math.max(12,above))}px`;
    markAnchor(element,anchor);
  }
  useLayoutEffect(()=>{if(open) place();},[open,options.length,unavailable,previousLabel]);
  useEffect(()=>{
    if(!open) return;
    window.addEventListener('resize',place);window.addEventListener('scroll',place,true);
    return ()=>{window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);};
  },[open]);
  const close=(returnFocus=false)=>{panel.current?.hidePopover();if(returnFocus) trigger.current?.focus({preventScroll:true});};
  const status=error || (pending ? 'Saving your planning date…' : unavailable || (saved ? `Using ${saved.dateLabel} for your planning.` : needsReview ? `Sources changed${previousLabel ? ` since you chose ${previousLabel}` : ''}. Review the current dates.` : options.length === 1 ? 'These sources show the same date.' : 'Choose a date above. You can change or undo it later.'));
  return <span className="magic-date-review">
    <button ref={trigger} type="button" className="magic-ui-action" popoverTarget={id} aria-expanded={open} aria-controls={id} aria-haspopup="dialog"
      data-focus-key={focusKey ?? `date-review-${id}`} onClick={event=>{
        event.preventDefault();
        if(panel.current?.matches(':popover-open')) close();
        else {setDraft(savedKey);panel.current?.showPopover();place();panel.current?.querySelector<HTMLElement>(savedKey ? 'input:checked' : 'input, button')?.focus({preventScroll:true});}
      }}>{saved ? 'Change planning date' : 'Review dates'} <svg className="magic-ui-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg></button>
    <div ref={panel} id={id} popover="auto" role="dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-help`} className="magic-ui-popover magic-date-popover" data-magic-motion="anchored"
      onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close(true);}}}
      onBlur={event=>{if(event.relatedTarget && !event.currentTarget.contains(event.relatedTarget) && event.relatedTarget!==trigger.current) close();}}>
      <h3 id={`${id}-title`}>Which date should you plan for?</h3>
      <p id={`${id}-help`} className="magic-ui-meta">Your choice is used in My Magic UW. The course’s saved dates stay visible.</p>
      <fieldset className="magic-date-options" aria-label="Planning date" aria-disabled={pending || !canChoose || undefined}>
        {options.map(option=><label className="magic-date-option" key={option.key}>
          <input type="radio" name={`${id}-date`} value={option.key} checked={draft===option.key} aria-disabled={pending || !canChoose || undefined}
            onChange={()=>{if(!pending && canChoose)setDraft(option.key);}}/>
          <span><strong>{option.dateLabel}</strong><span>{option.timeLabel}</span><small>{[...new Set(option.sources.map(source=>source.label))].join(' · ')}</small></span>
        </label>)}
      </fieldset>
      {options.length===0 && <p className="magic-ui-meta">No complete, confirmed date is available to choose. Review the saved evidence.</p>}
      {unresolvedCount>0 && <p className="magic-ui-meta">{unresolvedCount===1 ? 'One other date mention needs' : `${unresolvedCount} other date mentions need`} source review.</p>}
      <div className="magic-date-status" role="status" aria-live="polite">{status}</div>
      <div className="magic-date-actions"><Action pending={pending} disabled={!canChoose || !draft || draft===savedKey} onClick={()=>{
        if(latestVersion.current!==sourceVersion)return;
        const option=options.find(item=>item.key===draft);if(option)onCommit(option);
      }}>Use this date</Action>{saved && <Action tone="quiet" pending={pending} onClick={()=>{onCommit(null);panel.current?.querySelector<HTMLInputElement>('input')?.focus({preventScroll:true});}}>Undo</Action>}</div>
      <button className="magic-date-sources" type="button" onClick={()=>{close();onInspect();}}>View date evidence <svg className="magic-ui-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg></button>
    </div>
  </span>;
}
