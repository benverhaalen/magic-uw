import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '@magic/storage';
import { defaultPrivacy } from '@magic/contracts';
import { CONSENT_DISCLOSURE_VERSION } from '@magic/domain';
import { createModelRunner, type BackendCall } from '../packages/runner/src/index';
import { createPackHandler } from '../packages/core/src/pack-handler';
import { egressFor, payloadHash } from '../packages/core/src/egress';
import { memoryArtifactStore } from '../packages/packs/core/src/index';

function setup(local = false) {
  const store = createStore(':memory:');
  store.setPrivacy({...defaultPrivacy, mode: local ? 'local_only' : 'selective_cloud', hostedProvider:'claude', shareCourseText:true});
  store.setConsent!({ action:'grant',recipient:'claude',disclosureVersion: CONSENT_DISCLOSURE_VERSION},'2026-09-26T12:00:00Z');
  store.recordAutoIdentity({accountScope:'account-private',courseId:'c',authors:['Jo Park']});
  store.ingest({source:{id:'s',kind:'fixture',label:'s',scope:'all',accountScope:'account-private',courseId:'c'},observedAt:'2026-09-26T12:00:00Z',status:'ok',complete:true,resources:[{
    externalId:'reading',kind:'material',courseId:'c',courseName:'Jo Park course',title:'Reading',text:'Jo Park studies a stack, a last-in first-out collection. Professor Ada teaches stacks.',url:'https://example.org/r',deadlines:[],policy:{mode:'coaching',evidence:'Jo Park may practice with AI.'},
  }]});
  store.setIdentityRoster({peers:[],retain:['Professor Ada']});
  const calls: BackendCall[] = [];
  const artifacts = memoryArtifactStore();
  const sourceId = `p${store.passages(store.resources()[0]!.id)[0]!.pid}`;
  const valid = () => ({cards:[{kind:'term',front:'Stack',back:'A last-in first-out collection',topics:['Stacks'],section:'Collections',sourceId,quote:local ? 'Jo Park studies a stack, a last-in first-out collection.' : '[STUDENT_1] studies a stack, a last-in first-out collection.'}]});
  let respond = () => valid();
  const runner=createModelRunner({backend:{client:local ? 'local':'claude',async call(call){calls.push(call);return {value:respond(),usage:{in:10,cached:0,out:10},model:'synthetic'};}}});
  const handler=createPackHandler({store,artifacts,runner:()=>runner});
  return {store,calls,artifacts,valid,handler,respond:(fn:()=>any)=>{respond=fn;},run:()=>handler.run('cards',{courseId:'c'})};
}

test('hosted pack scrubs header, policy, passages and retries; frozen quote maps to source',async()=>{
 const x=setup();
 x.respond(()=>x.calls.length===1 ? {cards:[{...x.valid().cards[0],sourceId:'Jo Park private@example.test'}]} : x.valid());
 const result=await x.run();
 assert.equal(result.status,'done'); assert.equal(result.itemIds.length,1); assert.equal(x.calls.length,2);
 for(const call of x.calls){assert.ok(!JSON.stringify(call).includes('Jo Park'));assert.ok(!JSON.stringify(call).includes('account-private'));assert.ok(call.input.includes('Professor Ada'));}
 assert.ok(x.calls[1]!.input.includes('[checks]'));
 const saved=x.store.learning.items({courseRef:'account-private:c'})[0]!;
 assert.ok(JSON.stringify(saved).includes('Jo Park studies'));
 assert.equal((await x.run()).cached,true); assert.equal(x.calls.length,2);
 x.store.recordAutoIdentity({accountScope:'account-private',courseId:'c',authors:['New Person']});
 await x.run(); assert.equal(x.calls.length,3,'roster mutation invalidates cache');
 x.store.close();
});

test('always preview hashes the exact outgoing strings and schema; retry needs its own preview',async()=>{
 const x=setup();x.store.setPrivacy({...x.store.privacy(),alwaysPreview:true});
 const first=await x.run();assert.equal(first.status,'blocked');assert.equal(x.calls.length,0);
 const pending=egressFor(x.store).pending()[0]!;
 egressFor(x.store).acknowledge({id:pending.previewId,payloadHash:pending.payloadHash,decision:'send'},'2026-09-26T12:00:00Z');
 x.respond(()=>({cards:[]}));
 const second=await x.run();assert.equal(second.status,'blocked');assert.equal(x.calls.length,1);
 const sent=x.calls[0]!;
 assert.equal(payloadHash({systemPrompt:sent.systemPrompt,input:sent.input,jsonSchema:sent.jsonSchema}),pending.payloadHash);
 assert.equal(egressFor(x.store).pending().length,1);assert.notEqual(egressFor(x.store).pending()[0]!.payloadHash,pending.payloadHash);
 x.store.close();
});

for(const mutation of ['consent','evidence','source_content','roster','purge'] as const) test(`pack discards result when ${mutation} changes during provider call`,async()=>{
 const x=setup();x.respond(()=>{
  if(mutation==='consent')x.store.setConsent!({action:'revoke',recipient:'claude'},'2026-09-26T12:00:00Z');
  if(mutation==='evidence')x.store.setCourseOverride({accountScope:'account-private',courseId:'c',included:false});
  if(mutation==='source_content') {
    const r=x.store.resources()[0]!;
    x.store.ingest({source:{id:'s',kind:'fixture',label:'s',scope:'all',accountScope:'account-private',courseId:'c'},observedAt:'2026-09-27T12:00:00Z',status:'ok',complete:true,resources:[{...r,text:r.text+' New source version.'}]});
  }
  if(mutation==='roster')x.store.recordAutoIdentity({accountScope:'account-private',courseId:'c',authors:['New Person']});
  if(mutation==='purge')x.store.purge();
  return x.valid();
 });
 assert.equal((await x.run()).status,'blocked');assert.equal(x.calls.length,1);assert.equal(x.artifacts.list().length,0);x.store.close();
});

test('local pack retains original source strings',async()=>{
 const x=setup(true);assert.equal((await x.run()).status,'done');assert.ok(x.calls[0]!.input.includes('Jo Park'));x.store.close();
});

 test('a quote splitting a scrubbed placeholder cannot become a checked item',async()=>{
 const x=setup(); x.respond(()=>({cards:[{...x.valid().cards[0],quote:'STUDENT_1] studies a stack, a last-in first-out collection.'}]}));
 const result=await x.run(); assert.equal(result.status,'done');assert.equal(result.itemIds.length,0);assert.equal(result.counts.droppedBy.quote,1);x.store.close();
});
