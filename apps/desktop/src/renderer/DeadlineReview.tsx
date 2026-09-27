import {useEffect, useRef, useState} from 'react';
import type {Command, CommandResult, ResourceView} from '@magic/contracts';
import {DateChoicePopover} from './date-choice/DateChoicePopover';
import {presentDateChoices, dateChoiceOptions, type CanonicalDateOption} from './date-choice/model';

/** Structural seam also permits compilation against a contracts build that has not
 * yet adopted the additive projection. The core owns the definitive declaration. */
export type DeadlineReviewResource = ResourceView & {scheduleDeadline?: {choiceUnavailable?: string}; personalDeadline?: {
  sourceVersion: string; revision: number; options: CanonicalDateOption[];
  selected: {optionId:string; value:string; precision:'minute'|'day'; reportedAt:string} | null;
  needsReview: boolean;
}};
export function DeadlineReview({resource, run, onInspect}: {
  resource: DeadlineReviewResource;
  run: (command: Command) => Promise<CommandResult | undefined>;
  onInspect: () => void;
}) {
  const state=resource.personalDeadline;
  const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  const options=state ? presentDateChoices(state.options,zone) : dateChoiceOptions(resource.deadline.claims,zone);
  const [pending,setPending]=useState(false), [error,setError]=useState('');
  const active=useRef(false), mounted=useRef(true);
  const viewKey=`${resource.id}:${state?.sourceVersion ?? 'unavailable'}`;
  const currentKey=useRef(viewKey);currentKey.current=viewKey;
  const uncertain=useRef<{optionId:string|null; revision:number; operationId:string} | null>(null);
  useEffect(()=>{mounted.current=true;return ()=>{mounted.current=false;};},[]);
  useEffect(()=>{active.current=false;uncertain.current=null;setPending(false);setError('');},[viewKey]);
  useEffect(()=>{
    if(uncertain.current && state && state.revision>uncertain.current.revision){uncertain.current=null;setError('');}
  },[state?.revision]);
  const unavailable = resource.scheduleDeadline?.choiceUnavailable ?? (!state ? 'Refresh sources to make a planning choice.' : state.options.length<2 ? 'The current sources do not show two different dates to resolve.' : undefined);
  return <DateChoicePopover options={options} focusKey={`date-review-${resource.id}`} sourceVersion={state?.sourceVersion ?? viewKey} savedKey={state?.selected?.optionId ?? null}
    needsReview={state?.needsReview} pending={pending} error={error} unavailable={unavailable}
    unresolvedCount={resource.deadline.unresolved?.length ?? 0} onInspect={onInspect} onCommit={async option=>{
      if(!state || active.current || unavailable)return;
      active.current=true;setPending(true);setError('');
      const ticket=viewKey, optionId=option?.key ?? null;
      const retry=uncertain.current?.optionId===optionId && uncertain.current.revision===state.revision ? uncertain.current : null;
      const intent={optionId,revision:state.revision,operationId:retry?.operationId ?? crypto.randomUUID()};
      const stillCurrent=()=>mounted.current && currentKey.current===ticket;
      const saved=(result:CommandResult | undefined)=>{
        const current=(result?.snapshot.resources.find(item=>item.id===resource.id) as DeadlineReviewResource | undefined)?.personalDeadline;
        return !!current && current.sourceVersion===state.sourceVersion && current.revision>state.revision && (current.selected?.optionId ?? null)===optionId;
      };
      try {
        const result=await run({type:'personal-deadline',value:{operationId:intent.operationId,resourceId:resource.id,sourceVersion:state.sourceVersion,optionId,expectedRevision:state.revision}});
        if(!stillCurrent())return;
        if(!saved(result)) {
          uncertain.current=intent;
          setError('Save not confirmed. Checking your saved planning date…');
          const readback=await run({type:'snapshot'});
          if(!stillCurrent())return;
          if(saved(readback)){uncertain.current=null;setError('');}
          else setError('Save not confirmed. Your last saved date is still in use. Try again.');
        } else {uncertain.current=null;setError('');}
      } catch {
        if(stillCurrent()){uncertain.current=intent;setError('Could not confirm the save. Your last saved date is still in use. Try again.');}
      } finally {if(stillCurrent()){active.current=false;setPending(false);}}
    }}/>;
}
