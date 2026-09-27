import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceSession, type VoiceTransport } from '../apps/desktop/src/voice/session';
import type { VoiceAudio, VoiceContext, VoiceEvent, VoiceToken } from '../apps/desktop/src/voice/types';
const deferred = <T>() => { let resolve!: (value:T)=>void; const promise=new Promise<T>(r=>resolve=r); return {promise,resolve}; };
const tick = async () => { for(let i=0;i<5;i++) await Promise.resolve(); };
function fixture() {
  let context: VoiceContext = {account:'synthetic-a',revision:'r1',allowed:true};
  let permission: Promise<boolean> = Promise.resolve(true);
  let startWait: Promise<void> = Promise.resolve();
  let transcript: Promise<string> = Promise.resolve('open calendar');
  const transports: {starts:number; reads:number; closes:number; signal?:AbortSignal; disconnect?:()=>void}[]=[];
  const events: VoiceEvent[]=[];
  const session = new VoiceSession({dispatch:async()=>({status:'unavailable',reason:'synthetic',path:'none',latencyMs:0,tokens:{in:0,cached:0,out:0}}),context:()=>context, requestMicrophone:()=>permission,event:e=>events.push(e),transport:()=>{
    const stats={starts:0,reads:0,closes:0} as typeof transports[number]; transports.push(stats);
    return {start:async(signal,disconnect)=>{stats.starts++;stats.signal=signal;stats.disconnect=disconnect;await startWait}, transcribe:async(_audio,signal)=>{stats.reads++;stats.signal=signal;return transcript},close:()=>{stats.closes++}} satisfies VoiceTransport;
  }});
  const audio=(token:VoiceToken):VoiceAudio=>({token,bytes:new ArrayBuffer(4),mimeType:'audio/webm',durationMs:2000,voicedMs:700});
  return {session,transports,events,audio,setPermission:(p:Promise<boolean>)=>permission=p,setStart:(p:Promise<void>)=>startWait=p,setTranscript:(p:Promise<string>)=>transcript=p,setContext:(c:VoiceContext)=>context=c};
}
test('permission denied closes allocated transport once without starting it',async()=>{
  const f=fixture();f.setPermission(Promise.resolve(false));const state=await f.session.start();
  assert.equal(state.reason,'permission-denied');assert.equal(f.transports[0].starts,0);assert.equal(f.transports[0].closes,1);assert.equal(f.session.allowsMicrophone(),false);
});
test('Stop while permission is pending then restart: old permission cannot start old transport or replace new token',async()=>{
  const f=fixture(),permission=deferred<boolean>();f.setPermission(permission.promise);const old=f.session.start();f.session.stop();f.setPermission(Promise.resolve(true));const next=await f.session.start();f.session.ready(next.token!);permission.resolve(true);await old;
  assert.equal(f.transports[0].starts,0);assert.equal(f.transports[1].starts,1);assert.deepEqual(f.session.status().token,next.token);assert.equal(f.session.status().phase,'listening');
});
test('Stop during transport startup aborts old transport; late resolution and disconnect cannot affect restart',async()=>{
  const f=fixture(),started=deferred<void>();f.setStart(started.promise);const old=f.session.start();await tick();assert.equal(f.transports[0].starts,1);f.session.stop();assert.equal(f.transports[0].signal?.aborted,true);f.setStart(Promise.resolve());const next=await f.session.start();f.session.ready(next.token!);started.resolve();await old;f.transports[0].disconnect?.();
  assert.equal(f.transports[0].closes,1);assert.equal(f.transports[1].closes,0);assert.deepEqual(f.session.status().token,next.token);
});
test('Stop during uncooperative ASR then restart: late result cannot emit transcript or change current state',async()=>{
  const f=fixture(),asr=deferred<string>();f.setTranscript(asr.promise);const old=await f.session.start();f.session.ready(old.token!);const receipt=f.session.transcribe(f.audio(old.token!));f.session.stop();assert.equal(f.transports[0].signal?.aborted,true);const next=await f.session.start();f.session.ready(next.token!);asr.resolve('open calendar');assert.equal((await receipt).status,'stopped');assert.equal(f.events.filter(e=>e.type==='transcript').length,0);assert.deepEqual(f.session.status().token,next.token);assert.equal(f.session.status().phase,'listening');
});
test('pending ASR refuses account, consent and revision changes',async()=>{
  for(const context of [{account:'synthetic-b',revision:'r1',allowed:true},{account:'synthetic-a',revision:'r1',allowed:false},{account:'synthetic-a',revision:'r2',allowed:true}]){
    const f=fixture(),asr=deferred<string>();f.setTranscript(asr.promise);const start=await f.session.start();f.session.ready(start.token!);const receipt=f.session.transcribe(f.audio(start.token!));f.setContext(context);asr.resolve('open calendar');assert.equal((await receipt).status,'context-changed');assert.equal(f.events.filter(e=>e.type==='transcript').length,0);assert.equal(f.transports[0].signal?.aborted,true);assert.equal(f.transports[0].closes,1);
  }
});
test('duplicate concurrent submission stays busy and invokes ASR exactly once',async()=>{
  const f=fixture(),asr=deferred<string>();f.setTranscript(asr.promise);const state=await f.session.start();f.session.ready(state.token!);const first=f.session.transcribe(f.audio(state.token!));const duplicate=await f.session.transcribe(f.audio(state.token!));assert.equal(duplicate.status,'busy');assert.equal(f.transports[0].reads,1);asr.resolve('');assert.equal((await first).status,'silence');
});
test('stale token and silent frames cause no ASR; oversize utterance closes session',async()=>{
  const f=fixture();const state=await f.session.start();f.session.ready(state.token!);
  assert.equal((await f.session.transcribe(f.audio({...state.token!,epoch:-1}))).status,'stopped');assert.equal((await f.session.transcribe({...f.audio(state.token!),voicedMs:0})).status,'silence');assert.equal(f.transports[0].reads,0);
  await f.session.transcribe({...f.audio(state.token!),bytes:new ArrayBuffer(2_000_001)});assert.equal(f.session.status().reason,'too-long');assert.equal(f.transports[0].reads,0);assert.equal(f.transports[0].closes,1);
});

import type { VoiceDispatch } from '../apps/desktop/src/voice/session';
import type { IntentCommandResult } from '../packages/contracts/src';
const answer:IntentCommandResult={status:'ran',action:'page.open',args:{},result:{navigate:{view:'courses'}},path:'code',latencyMs:0,tokens:{in:0,cached:0,out:0}};
function dispatchFixture(dispatch:VoiceDispatch,onEvent?:(event:VoiceEvent,session:VoiceSession)=>void){
 const events:VoiceEvent[]=[];let reads=0;let context:VoiceContext={account:'synthetic',revision:'r1',allowed:true};
 const session=new VoiceSession({context:()=>context,requestMicrophone:async()=>true,transport:()=>({start:async()=>{},transcribe:async()=>{reads++;return 'Open calendar, actually open my courses.'},close(){}}),dispatch,event:event=>{events.push(event);onEvent?.(event,session)}});
 const audio=(token:VoiceToken):VoiceAudio=>({token,bytes:new ArrayBuffer(5),mimeType:'audio/webm',durationMs:2500,voicedMs:600,turn:{operationId:'synthetic-turn-1',context:{view:'resource',courseId:'c400',noteId:'n1'}}});
 return {session,events,audio,reads:()=>reads,setContext:(c:VoiceContext)=>context=c};
}
test('dispatch receives full corrected utterance, captured route context, exact turn ID and live cancellation guard',async()=>{
 const calls:any[]=[];const f=dispatchFixture(async(text,context,operation)=>{calls.push({text,context,operationId:operation.operationId,current:operation.current(),aborted:operation.signal.aborted});return answer});
 const state=await f.session.start();f.session.ready(state.token!);assert.equal((await f.session.transcribe(f.audio(state.token!))).status,'dispatched');
 assert.deepEqual(calls,[{text:'Open calendar, actually open my courses.',context:{view:'resource',courseId:'c400',noteId:'n1'},operationId:'synthetic-turn-1',current:true,aborted:false}]);assert.equal(f.events.filter(e=>e.type==='result').length,1);
});
test('Stop during dispatch latency invalidates signal/current and suppresses late result after restart',async()=>{
 const pending=deferred<IntentCommandResult>();let operation!:Parameters<VoiceDispatch>[2];const f=dispatchFixture(async(_text,_context,op)=>{operation=op;return pending.promise});
 const first=await f.session.start();f.session.ready(first.token!);const receipt=f.session.transcribe(f.audio(first.token!));await tick();assert.equal(operation.current(),true);f.session.stop();assert.equal(operation.signal.aborted,true);assert.equal(operation.current(),false);
 const next=await f.session.start();f.session.ready(next.token!);pending.resolve(answer);assert.equal((await receipt).status,'stopped');assert.equal(f.events.filter(e=>e.type==='result').length,0);assert.deepEqual(f.session.status().token,next.token);
});
test('permission/account revision change during dispatch makes current guard false and suppresses result',async()=>{
 for(const next of [{account:'other',revision:'r1',allowed:true},{account:'synthetic',revision:'r2',allowed:true},{account:'synthetic',revision:'r1',allowed:false}]){
 const pending=deferred<IntentCommandResult>();let op!:Parameters<VoiceDispatch>[2];const f=dispatchFixture(async(_t,_c,o)=>{op=o;return pending.promise});const state=await f.session.start();f.session.ready(state.token!);const receipt=f.session.transcribe(f.audio(state.token!));await tick();f.setContext(next);assert.equal(op.current(),false);pending.resolve(answer);assert.equal((await receipt).status,'stopped');assert.equal(f.events.filter(e=>e.type==='result').length,0);assert.equal(op.signal.aborted,true);
 }
});
test('Stop in transcript callback prevents dispatch; Stop in result callback cannot resurrect listening',async()=>{
 for(const boundary of ['transcript','result']){let calls=0;const f=dispatchFixture(async()=>{calls++;return answer},(event,session)=>{if(event.type===boundary)session.stop()});const state=await f.session.start();f.session.ready(state.token!);await f.session.transcribe(f.audio(state.token!));assert.equal(calls,boundary==='transcript'?0:1);assert.equal(f.session.status().phase,'idle');}
});
test('repeated completed turn ID cannot dispatch twice; fresh ID remains usable',async()=>{
 let calls=0;const f=dispatchFixture(async()=>{calls++;return answer});const state=await f.session.start();f.session.ready(state.token!);const audio=f.audio(state.token!);await f.session.transcribe(audio);assert.equal((await f.session.transcribe(audio)).status,'busy');assert.equal(calls,1);assert.equal(f.reads(),1);await f.session.transcribe({...audio,turn:{...audio.turn!,operationId:'synthetic-turn-2'}});assert.equal(calls,2);
});
