import { MagicGlyph } from '../../../../../packages/ui/src/glyph';
import {useEffect, useId, useLayoutEffect, useRef, useState} from 'react';
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
/** A choice is marked saved only when the parent receives a confirming snapshot. */
export function DateChoicePopover({options, focusKey, sourceVersion, savedKey, previousLabel, needsReview=false, pending=false, error, unavailable, unresolvedCount=0, onCommit, onInspect}: DateChoicePopoverProps) {
  const id=useId(), trigger=useRef<HTMLButtonElement>(null), panel=useRef<HTMLDivElement>(null);
  const [open,setOpen]=useState(false);
  const saved=options.find(option=>option.key===savedKey);
  const canChoose=options.length>1 && !unavailable;
  useEffect(()=>{
    const element=panel.current!;
    const update=()=>setOpen(element.matches(':popover-open'));
    element.addEventListener('toggle',update);
    return ()=>element.removeEventListener('toggle',update);
  },[]);
  useEffect(()=>{
    if(open && document.activeElement===document.body) panel.current?.querySelector<HTMLButtonElement>('.magic-date-option, .magic-date-sources')?.focus({preventScroll:true});
  },[sourceVersion,open]);
  function place() {
    const element=panel.current, anchor=trigger.current;
    if(!element || !anchor) return;
    const rect=anchor.getBoundingClientRect(), width=Math.min(292,innerWidth-24);
    element.style.width=`${width}px`;
    element.style.left=`${Math.max(12,Math.min(rect.left,innerWidth-width-12))}px`;
    const below=rect.bottom+7, above=rect.top-element.offsetHeight-7;
    element.style.top=`${Math.max(12,below+element.offsetHeight<=innerHeight-12?below:Math.max(12,above))}px`;
    markAnchor(element,anchor);
  }
  useLayoutEffect(()=>{if(open)place();},[open,options.length,unavailable,previousLabel,error,pending,savedKey]);
  useEffect(()=>{
    if(!open)return;
    window.addEventListener('resize',place);window.addEventListener('scroll',place,true);
    return ()=>{window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);};
  },[open]);
  const close=(returnFocus=false)=>{panel.current?.hidePopover();if(returnFocus)trigger.current?.focus({preventScroll:true});};
  const status=error || (pending?'Saving…':unavailable || (saved?'Saved for your planning.':needsReview?`Sources changed${previousLabel?` since ${previousLabel}`:''}. Choose again.`:options.length===1?'Sources show one date.':options.length===0?'No confirmed date is available.':'Choose a date for your plan.'));
  return <span className="magic-date-review">
    <button ref={trigger} type="button" className="magic-ui-action magic-ui-action--primary" data-action-intent="review" aria-expanded={open} aria-controls={id} aria-haspopup="dialog"
      data-focus-key={focusKey??`date-review-${id}`} onClick={()=>{
        if(panel.current?.matches(':popover-open'))close();
        else{panel.current?.showPopover();place();panel.current?.querySelector<HTMLButtonElement>('.magic-date-option[aria-pressed="true"], .magic-date-option, .magic-date-sources')?.focus({preventScroll:true});}
      }}>{saved?'Planning date':'Review dates'} <MagicGlyph className="magic-ui-glyph" name="chevron" size={16}/></button>
    <div ref={panel} id={id} popover="auto" role="dialog" aria-labelledby={`${id}-title`} className="magic-ui-popover magic-date-popover" data-magic-motion="anchored"
      onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close(true);}}}>
      <h3 id={`${id}-title`}>Planning date</h3>
      <div className="magic-date-options" role="group" aria-label="Choose a sourced planning date">
        {options.map(option=><button type="button" className="magic-date-option" key={option.key} aria-pressed={savedKey===option.key}
          aria-disabled={pending||!canChoose||undefined} onClick={()=>{if(!pending&&canChoose&&savedKey!==option.key)onCommit(option);}}>
          <span className="magic-date-option__date"><strong>{option.dateLabel}</strong><span>{option.timeLabel}</span></span>
          <small>{[...new Set(option.sources.map(source=>source.label))].join(' · ')}</small>
        </button>)}
      </div>
      <div className={`magic-date-status${error?' magic-date-status--error':''}`} role="status" aria-live="polite">{status}</div>
      <div className="magic-date-footer">
        <button className="magic-date-sources" type="button" onClick={()=>{close();onInspect();}}>Date evidence <MagicGlyph className="magic-ui-glyph" name="chevron" size={14}/></button>
        {saved&&<button className="magic-date-undo" type="button" aria-disabled={pending||undefined} onClick={()=>{if(!pending)onCommit(null);}}>Undo</button>}
      </div>
      {unresolvedCount>0&&<p className="magic-date-unresolved">{unresolvedCount===1?'1 date mention needs review':`${unresolvedCount} date mentions need review`}</p>}
    </div>
  </span>;
}
