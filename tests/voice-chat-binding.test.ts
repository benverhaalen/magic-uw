import test from 'node:test';
import assert from 'node:assert/strict';
import { startChat, drive, resetChats, stop, acceptVoiceResult, type ChatRuntime, type ChatOrigin } from '../apps/desktop/src/renderer/chat/store';
import { workspace, NOW, TZ } from './intent-fixtures';
import { createIntentRouter } from '../packages/core/src/intent/router';
import type { IntentCommandResult } from '@magic/contracts';
const reply: IntentCommandResult = {status:'ran', action:'page.open', args:{}, result:{navigate:{view:'calendar'}}, path:'code', latencyMs:0, tokens:{in:0,cached:0,out:0}};
const origin:ChatOrigin={view:'today',resourceId:null,courseKey:null,label:'Home',focusKey:null,anchor:null,offset:0,scroll:0,scope:{kind:'workspace',page:'Home',courses:[]}};
const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
const runtime = (extra: Partial<ChatRuntime> = {}):ChatRuntime=>({bridge:{openExternal:async()=>{}},resources:[],sources:[],courses:[],now:NOW.toISOString(),...extra});
test('typed request uses full guarded path and applies canonical navigation once',async()=>{
 resetChats();const requests:any[]=[],routes:any[]=[];const text='Open calendar, actually open my courses.';
 const chat=startChat({prompt:text,origin,idempotencyKey:'typed'})!.chat;
 drive(chat,runtime({bridge:{openExternal:async()=>{},intentRun:async request=>{requests.push(request);return reply}},onNavigate:target=>routes.push(target)}));
 await tick();assert.equal(requests.length,1);assert.equal(requests[0].text,text);assert.equal(requests[0].context.view,'today');assert.deepEqual(routes,[{view:'calendar'}]);assert.equal(chat.exchanges[0].state,'done');
});
test('voice result is adopted once with no second dispatch',()=>{
 resetChats();let calls=0,navigations=0;const rt=runtime({bridge:{openExternal:async()=>{},intentRun:async()=>{calls++;return reply}},onNavigate:()=>{navigations++}});
 const entry={prompt:'Open calendar',origin,idempotencyKey:'voice'};const chat=acceptVoiceResult(entry,reply,rt)!;acceptVoiceResult(entry,reply,rt);drive(chat,rt);
 assert.equal(calls,0);assert.equal(navigations,1);assert.equal(chat.exchanges.length,1);assert.equal(chat.exchanges[0].state,'done');
});
test('typed Stop calls targeted cancel and drops late navigation',async()=>{
 resetChats();let resolve!:(value:IntentCommandResult)=>void;const pending=new Promise<IntentCommandResult>(r=>resolve=r);const cancels:string[]=[];let navigations=0;
 const rt=runtime({bridge:{openExternal:async()=>{},intentRun:()=>pending,cancelIntent:async id=>{cancels.push(id)}},onNavigate:()=>{navigations++}});
 const chat=startChat({prompt:'Open calendar',origin,idempotencyKey:'cancel'})!.chat;drive(chat,rt);stop(chat,chat.exchanges[0],rt.bridge);resolve(reply);await tick();assert.deepEqual(cancels,[chat.exchanges[0].id]);assert.equal(navigations,0);assert.equal(chat.exchanges[0].state,'stopped');
});
test('removed selected material refuses an answer instead of widening silently',async()=>{
 const {store}=workspace();try{const router=createIntentRouter({store,runner:()=>null,now:()=>NOW,timeZone:TZ});
 const result=await router.handle({text:'What is the late policy?',context:{courseId:'acct:c400',resourceId:'missing-selected-item'},allowedActions:['ask']},{workspace:async()=>{throw Error('No write')}},new AbortController().signal);
 assert.equal(result.status,'unavailable');assert.match(result.status==='unavailable'?result.reason:'',/no longer available/);
 }finally{store.close()}
});
