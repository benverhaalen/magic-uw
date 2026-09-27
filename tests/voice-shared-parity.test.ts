import test from 'node:test';
import assert from 'node:assert/strict';
import { workspace, NOW, TZ } from './intent-fixtures';
import { createIntentRouter } from '../packages/core/src/intent/router';
import { createInteractiveDispatch, INTERACTIVE_ACTIONS } from '../apps/desktop/src/voice/intent-dispatch';
import { VoiceSession } from '../apps/desktop/src/voice/session';
import type { VoiceEvent, VoiceRequestContext } from '../apps/desktop/src/voice/types';
import type { CommandResult, IntentCommand, IntentCommandResult } from '../packages/contracts/src';
const stable=(r:IntentCommandResult)=>{const {latencyMs,...rest}=r;return rest};
function fixture(){
 const {store}=workspace();const requests:IntentCommand[]=[];const effects:any[]=[];
 const router=createIntentRouter({store,runner:()=>null,now:()=>NOW,timeZone:TZ});
 const dispatch=createInteractiveDispatch(async(command:any,signal)=>{
  requests.push(command.value);const result=await router.handle(command.value,{workspace:async value=>{effects.push(value);return {verb:value.verb,status:'ok'}}},signal!);
  return {command:result} as CommandResult;
 });
 return {store,dispatch,requests,effects};
}
for(const text of ['Open calendar, actually open my courses.','go to philosophy','open homework 3 in cs 400',"What's due tomorrow?",'make 5 flashcards on hash tables for cs400']){
 test('typed/voice shared adapter parity: '+text,async()=>{
  const f=fixture();try{
   const context:VoiceRequestContext={view:'resource',courseId:'c400',noteId:'synthetic-note',resourceId:f.store.resources().find(r=>r.title==='Recursion notes')!.id};const typed=await f.dispatch(text,context,{signal:new AbortController().signal,current:()=>true,operationId:'typed-turn'});
   const events:VoiceEvent[]=[];const session=new VoiceSession({context:()=>({account:'synthetic',revision:'r1',allowed:true}),requestMicrophone:async()=>true,transport:()=>({start:async()=>{},transcribe:async()=>text,close(){}}),dispatch:f.dispatch,event:event=>events.push(event)});
   const state=await session.start();session.ready(state.token!);await session.transcribe({token:state.token!,turn:{operationId:'voice-turn',context},bytes:new ArrayBuffer(5),mimeType:'audio/webm',durationMs:2000,voicedMs:500});
   const event=events.find(e=>e.type==='result');assert.ok(event&&event.type==='result');assert.deepEqual(stable(event.result),stable(typed));assert.equal(f.requests.length,2);assert.deepEqual(f.requests[0],f.requests[1]);assert.deepEqual(f.requests[0]?.allowedActions,INTERACTIVE_ACTIONS);assert.deepEqual(f.requests[0]?.context,context);assert.equal(f.requests[0]?.text,text);
   if(text.startsWith('make')){assert.equal(typed.status,'unavailable');assert.equal(f.effects.length,0)}session.stop();
  }finally{f.store.close()}
 });
}
test('shared adapter rejects revoked or already aborted operations before execute',async()=>{
 let calls=0;const dispatch=createInteractiveDispatch(async()=>{calls++;throw Error('unexpected')});
 await assert.rejects(dispatch('open calendar',{}, {signal:new AbortController().signal,current:()=>false,operationId:'revoked'}));const stop=new AbortController();stop.abort();await assert.rejects(dispatch('open calendar',{}, {signal:stop.signal,current:()=>true,operationId:'aborted'}));assert.equal(calls,0);
});
test('shared adapter threads exact signal to worker seam and suppresses uncooperative late result',async()=>{
 let resolve!:(result:CommandResult)=>void;const pending=new Promise<CommandResult>(r=>resolve=r);let workerSignal:AbortSignal|undefined;const dispatch=createInteractiveDispatch(async(_c,signal)=>{workerSignal=signal;return pending});const stop=new AbortController();const result=dispatch('open calendar',{}, {signal:stop.signal,current:()=>true,operationId:'latency'});const settled=result.then(()=>false,()=>true);assert.equal(workerSignal,stop.signal);stop.abort();resolve({command:{status:'unavailable',reason:'synthetic',path:'none',latencyMs:0,tokens:{in:0,cached:0,out:0}}} as CommandResult);assert.equal(await settled,true);
});
