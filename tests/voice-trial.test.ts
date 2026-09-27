import test from 'node:test';
import assert from 'node:assert/strict';
import {createVoiceTrialDispatch} from '../apps/desktop/src/voice/intent-dispatch';
import type {Snapshot, ResourceView, SourceHealth} from '@magic/contracts';
test('voice trial handles exact page navigation locally with no workspace call', async()=>{
 const dispatch=createVoiceTrialDispatch();
 const operation={signal:new AbortController().signal,current:()=>true,operationId:'trial'};
 const rejected=await dispatch('solve my open assignment',{},operation);assert.equal(rejected.status,'unavailable');
 const result=await dispatch('Open Calendar',{},operation);assert.deepEqual(result,{status:'ran',action:'page.open',args:{text:'Open Calendar'},result:{navigate:{view:'calendar'}},path:'code',latencyMs:0,tokens:{in:0,cached:0,out:0}});
 const controller=new AbortController();controller.abort();await assert.rejects(dispatch('Open Home',{}, {...operation,signal:controller.signal}));
 await assert.rejects(dispatch('Open Home',{}, {...operation,current:()=>false}));
});
const now='2026-09-27T12:00:00.000Z';
function course(accountScope:string, courseId:string, name:string, code:string, term='Fall 2026') {
 const source={id:`source-${accountScope}-${courseId}`,label:name,kind:'canvas',accountScope,courseId,scope:'course',status:'ok',complete:true,lastAttemptAt:now,lastSuccessAt:now,resourceCount:1} as SourceHealth;
 const resource={id:`resource-${accountScope}-${courseId}`,sourceId:source.id,externalId:courseId,kind:'course',courseId,courseName:name,title:name,url:'https://canvas.test/course',text:'',links:[],deadlines:[],points:null,submitted:null,policy:{mode:'unknown',evidence:''},contentHash:'hash',version:1,observedAt:now,capturedAt:now,deleted:false,completed:false,deadline:{dueAt:null,planningAt:null,conflict:false,claims:[],reason:''},kindLabel:null,course:{courseCode:code,termName:term,termId:term,selection:{included:true,reasons:[]}}} as unknown as ResourceView;
 return {source,resource};
}
function snapshot(...courses:ReturnType<typeof course>[]):Snapshot {return {sources:courses.map(item=>item.source),resources:courses.map(item=>item.resource),generatedAt:now} as Snapshot;}
test('voice trial uses current included courses and asks on unknown or ambiguous names',async()=>{
 const first=course('a','1','Introduction to Biology','BIO 101');
 const second=course('b','2','Introduction to Biology','BIO 101');
 let current=snapshot(first);
 const dispatch=createVoiceTrialDispatch(()=>current);
 const operation={signal:new AbortController().signal,current:()=>true,operationId:'course-trial'};
 const opened=await dispatch('Open my BIO 101 course',{},operation);
 assert.equal(opened.status,'ran');if(opened.status==='ran')assert.deepEqual(opened.result,{navigate:{view:'course',courseId:'1',accountScope:'a'}});
 assert.equal((await dispatch('Open Biology',{},operation)).status,'ran');
 assert.equal((await dispatch('Open chemistry course',{},operation)).status,'clarify');
 current=snapshot(first,second);
 const ambiguous=await dispatch('Open BIO 101',{},operation);assert.equal(ambiguous.status,'clarify');
 current=snapshot(second);
 const changed=await dispatch('Open BIO 101',{},operation);assert.equal(changed.status,'ran');if(changed.status==='ran')assert.deepEqual(changed.result,{navigate:{view:'course',courseId:'2',accountScope:'b'}});
 const denied=course('b','3','Private course','PRI 101');(denied.resource.course as {selection:{included:boolean}}).selection.included=false;
 current=snapshot(denied);
 assert.equal((await dispatch('Open PRI 101',{},operation)).status,'clarify');
});
