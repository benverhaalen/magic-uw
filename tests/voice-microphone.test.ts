import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceMicrophone, type MicrophoneEnvironment, type MicrophoneView } from '../apps/desktop/src/renderer/voice/microphone';
import type { VoiceBridge, VoiceEvent, VoiceState, VoiceToken, VoiceAudio, VoiceTurn } from '../apps/desktop/src/voice/types';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (v:T)=>void; let reject!: (e:unknown)=>void; const promise = new Promise<T>((a,b)=>{resolve=a;reject=b}); return {promise,resolve,reject}; }
function fixture(turn?: () => VoiceTurn | undefined) {
  const views:MicrophoneView[]=[]; const delivered:VoiceEvent[]=[];
  let listener:((event:VoiceEvent)=>void)|undefined; let now=0, amplitude=.05, sequence=0, frameSequence=0;
  const frames = new Map<number,FrameRequestCallback>();
  const starts:VoiceToken[]=[];const readyCalls:VoiceToken[]=[];const stopCalls:unknown[]=[];const transcriptions:VoiceAudio[]=[];
  const startQueue:Promise<VoiceState>[]=[];const mediaQueue:Promise<MediaStream>[]=[];const readyQueue:Promise<VoiceState>[]=[];const resumeQueue:Promise<void>[]=[];const transcriptQueue:Promise<any>[]=[];
  let failStop=false;
  class Track extends EventTarget { stops=0; stop(){this.stops++} }
  class Recorder extends EventTarget {
    state='inactive'; starts=0; stops=0;
    start(){this.starts++;this.state='recording'}
    data(size=4){const e=new Event('dataavailable');Object.defineProperty(e,'data',{value:new Blob([new Uint8Array(size)])});this.dispatchEvent(e)}
    stop(){this.stops++;this.state='inactive';this.data();this.dispatchEvent(new Event('stop'))}
  }
  const tracks:Track[]=[];const contexts:{closed:number;disconnected:number}[]=[];const recorders:Recorder[]=[];
  function media(){const track=new Track();tracks.push(track);return {getTracks:()=>[track]} as unknown as MediaStream}
  const bridge:VoiceBridge={
    capabilities:async()=>({microphone:true,transcription:'local-whisper',externalControl:false,streamingSpeech:false}),
    start:()=>{const token={sessionId:'synthetic-'+(++sequence),epoch:sequence};starts.push(token);return startQueue.shift()??Promise.resolve({phase:'starting',token})},
    ready:token=>{readyCalls.push(token);return readyQueue.shift()??Promise.resolve({phase:'listening',token})},
    stop:async reason=>{stopCalls.push(reason);if(failStop)throw Error('synthetic disconnect');return {phase:'idle',token:null}},
    transcribe:async audio=>{transcriptions.push(audio);return await (transcriptQueue.shift()??Promise.resolve({status:'dispatched'}))},
    onEvent:fn=>{listener=fn;return()=>{listener=undefined}},
  };
  const env={
    getUserMedia:()=>mediaQueue.shift()??Promise.resolve(media()),
    audioContext:()=>{const c={closed:0,disconnected:0};contexts.push(c);return {createAnalyser:()=>({fftSize:1024,getFloatTimeDomainData:(samples:Float32Array)=>samples.fill(amplitude)}),createMediaStreamSource:()=>({connect(){},disconnect(){c.disconnected++}}),resume:()=>resumeQueue.shift()??Promise.resolve(),close:async()=>{c.closed++}}},
    recorder:()=>{const r=new Recorder();recorders.push(r);return r},
    frame:(fn:FrameRequestCallback)=>{frames.set(++frameSequence,fn);return frameSequence},cancelFrame:(id:number)=>frames.delete(id),now:()=>now,
  } as unknown as MicrophoneEnvironment;
  const mic=new VoiceMicrophone(bridge,v=>views.push(v),e=>delivered.push(e),env,turn);
  function step(ms=100,amp=.05){now+=ms;amplitude=amp;const entry=[...frames].at(-1);if(entry){frames.delete(entry[0]);entry[1](now)}}
  async function utterance(){for(let i=0;i<4;i++)step();step(1900,0);await tick()}
  return {mic,views,delivered,starts,readyCalls,stopCalls,transcriptions,startQueue,mediaQueue,readyQueue,resumeQueue,transcriptQueue,tracks,contexts,recorders,frames,media,step,utterance,emit:(e:VoiceEvent)=>listener?.(e),setFailStop:()=>{failStop=true},last:()=>views.at(-1)!};
}
test('repeated start while permission pending creates only one session',async()=>{
 const f=fixture(),pending=deferred<VoiceState>();f.startQueue.push(pending.promise);const a=f.mic.start();await f.mic.start();assert.equal(f.starts.length,1);pending.resolve({phase:'starting',token:f.starts[0]!});await a;assert.equal(f.recorders.length,1);await f.mic.stop();
});
test('permission denial stops main ownership and never starts capture',async()=>{
 const f=fixture();f.mediaQueue.push(Promise.reject(new DOMException('synthetic denied','NotAllowedError')));await f.mic.start();assert.equal(f.last().reason,'permission-denied');assert.equal(f.readyCalls.length,0);assert.equal(f.recorders.length,0);assert.deepEqual(f.stopCalls,['permission-denied']);
});
test('Stop while getUserMedia pending closes late stream and leaves idle',async()=>{
 const f=fixture(),pending=deferred<MediaStream>();f.mediaQueue.push(pending.promise);const start=f.mic.start();await tick();await f.mic.stop();pending.resolve(f.media());await start;assert.equal(f.tracks[0]!.stops,1);assert.equal(f.readyCalls.length,0);assert.equal(f.last().phase,'idle');
});
test('Stop during AudioContext resume cleans once and late resume cannot affect restart',async()=>{
 const f=fixture(),pending=deferred<void>();f.resumeQueue.push(pending.promise);const old=f.mic.start();await tick();await f.mic.stop();await f.mic.start();pending.resolve();await old;assert.equal(f.last().token?.sessionId,'synthetic-2');assert.equal(f.tracks[0]!.stops,1);assert.equal(f.tracks[1]!.stops,0);assert.equal(f.contexts[0]!.closed,1);assert.equal(f.recorders.length,1);await f.mic.stop();
});
test('late ready response after Stop cannot clean up a newer recording session',async()=>{
 const f=fixture(),pending=deferred<VoiceState>();f.readyQueue.push(pending.promise);const old=f.mic.start();await tick();await f.mic.stop();await f.mic.start();pending.resolve({phase:'listening',token:f.starts[0]!});await old;
 assert.equal(f.tracks[1]!.stops,0,'old ready callback stopped new microphone track');assert.equal(f.contexts[1]!.closed,0);assert.equal(f.recorders[0]!.state,'recording');assert.equal(f.last().token?.sessionId,'synthetic-2');await f.mic.stop();
});
test('Stop during ASR latency prevents continuation or capture restart',async()=>{
 const f=fixture(),pending=deferred<any>();f.transcriptQueue.push(pending.promise);await f.mic.start();await f.utterance();assert.equal(f.transcriptions.length,1);assert.equal(f.recorders.length,2,'capture continues while ASR or agent works');await f.mic.stop();pending.resolve({status:'dispatched'});await tick();assert.equal(f.last().phase,'idle');assert.equal(f.recorders.length,2);assert.equal(f.frames.size,0);assert.equal(f.tracks[0]!.stops,1);
});
test('a second utterance queues during agent work, and Stop cancels it',async()=>{
 const f=fixture(),pending=deferred<any>();f.transcriptQueue.push(pending.promise);await f.mic.start();await f.utterance();assert.equal(f.transcriptions.length,1);await f.utterance();assert.equal(f.transcriptions.length,1,'second turn waits for first result');assert.equal(f.last().queuedTurns,1);assert.equal(f.last().capturing,true);await f.mic.stop();pending.resolve({status:'dispatched'});await tick();assert.equal(f.transcriptions.length,1,'queued turn must not dispatch after Stop');assert.equal(f.last().phase,'idle');
});
test('bounded queue visibly pauses capture and resumes after work drains',async()=>{
 const f=fixture(),pending=deferred<any>();f.transcriptQueue.push(pending.promise);await f.mic.start();await f.utterance();await f.utterance();await f.utterance();assert.equal(f.transcriptions.length,1);assert.equal(f.last().queuedTurns,2);assert.equal(f.last().capturePaused,true);assert.equal(f.last().capturing,false);pending.resolve({status:'dispatched'});await tick();await tick();assert.equal(f.transcriptions.length,3);assert.equal(f.last().capturePaused,false);assert.equal(f.last().capturing,true);await f.mic.stop();
});
test('old ASR completion after restart cannot overwrite new state or duplicate recorders',async()=>{
 const f=fixture(),pending=deferred<any>();f.transcriptQueue.push(pending.promise);await f.mic.start();await f.utterance();await f.mic.stop();await f.mic.start();pending.resolve({status:'dispatched'});await tick();assert.equal(f.recorders.length,3);assert.equal(f.tracks[1]!.stops,0);assert.equal(f.last().token?.sessionId,'synthetic-2');await f.mic.stop();
});
test('late dataavailable from an old recorder cannot stop a newer session',async()=>{
 const f=fixture();await f.mic.start();const old=f.recorders[0]!;await f.mic.stop();await f.mic.start();old.data(2_000_001);await tick();assert.equal(f.tracks[1]!.stops,0,'old recorder data stopped new session');assert.equal(f.last().phase,'listening');await f.mic.stop();
});
test('duplicate stop callback for one utterance cannot dispatch twice',async()=>{
 const f=fixture(),pending=deferred<any>();f.transcriptQueue.push(pending.promise,pending.promise);await f.mic.start();await f.utterance();f.recorders[0]!.dispatchEvent(new Event('stop'));await tick();assert.equal(f.transcriptions.length,1,'one recorded turn dispatched twice');pending.resolve({status:'dispatched'});await tick();assert.equal(f.recorders.length,2);await f.mic.stop();
});
test('quiet input never dispatches and active analyser samples drive real level values',async()=>{
 const f=fixture();await f.mic.start();f.step(100,.05);assert.ok(Math.abs(f.last().levels.at(-1)!-.4)<.00001);await f.mic.stop();await f.mic.start();f.step(10_100,0);await tick();assert.equal(f.transcriptions.length,0);assert.equal(f.recorders.length,3);await f.mic.stop();
});
test('stale token events cannot replace active session or deliver old transcript',async()=>{
 const f=fixture();await f.mic.start();const old=f.starts[0]!;await f.mic.stop();await f.mic.start();f.emit({type:'state',state:{phase:'transcribing',token:old}});f.emit({type:'transcript-partial',token:old,operationId:'old',text:'open cal'});f.emit({type:'transcript',token:old,operationId:'old',text:'open calendar'});assert.equal(f.last().phase,'listening');assert.equal(f.delivered.length,0);await f.mic.stop();
});
test('device ended closes capture and reports recovery even if bridge Stop rejects',async()=>{
 const f=fixture();await f.mic.start();f.setFailStop();f.tracks[0]!.dispatchEvent(new Event('ended'));await tick();assert.equal(f.last().reason,'device-unavailable');assert.equal(f.tracks[0]!.stops,1);assert.equal(f.contexts[0]!.closed,1);assert.equal(f.frames.size,0);
});
test('dispose unsubscribes, closes all resources, and ignores late native events',async()=>{
 const f=fixture();await f.mic.start();f.mic.dispose();await tick();f.emit({type:'state',state:{phase:'listening',token:f.starts[0]!}});assert.equal(f.last().phase,'idle');assert.equal(f.tracks[0]!.stops,1);assert.equal(f.contexts[0]!.closed,1);assert.equal(f.contexts[0]!.disconnected,1);assert.equal(f.frames.size,0);
});
test('route context is captured once at first speech, not idle capture start or transcript completion',async()=>{
 let context={view:'today',courseId:'c400'},calls=0;const f=fixture(()=>({operationId:'turn-'+(++calls),context:{...context}}));await f.mic.start();f.step(100,0);assert.equal(calls,0);context={view:'resource',courseId:'c400'};f.step();context={view:'calendar',courseId:'c101'};for(let i=0;i<3;i++)f.step();f.step(1900,0);await tick();assert.equal(calls,1);assert.deepEqual(f.transcriptions[0]?.turn,{operationId:'turn-1',context:{view:'resource',courseId:'c400'}});await f.mic.stop();
});
test('late error from completed recorder cannot terminate next turn in same session',async()=>{
 const f=fixture();await f.mic.start();const old=f.recorders[0]!;await f.utterance();assert.equal(f.recorders.length,2);old.dispatchEvent(new Event('error'));await tick();assert.equal(f.last().phase,'listening');assert.equal(f.tracks[0]!.stops,0);await f.mic.stop();
});
