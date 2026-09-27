import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createStore} from "@magic/storage";
import {createCore} from "@magic/core";
import {createMcpService} from "../packages/core/src/mcp";
import {createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {captureBatchSchema, personalWorkState, type Store, type PersonalWorkChange, type ResourceInput} from "@magic/contracts";
import fixture from "../fixtures/course.json";
const batch = captureBatchSchema.parse(fixture);
const stamp = "2026-09-27T12:00:00.000Z";
const clock = {now: () => new Date(stamp)};
function course(store: Store, accountScope = "synthetic", courseId = "sample-101") {
  store.ingest(captureBatchSchema.parse({...batch, source: {...batch.source, id: `${accountScope}:course`, accountScope, courseId, scope: "course"}, resources: [{externalId: courseId,kind:"course",courseId,courseName:"Writing",title:"Writing",url:"https://example.org/course",text:"",course:{termId:"fall-2026",termName:"Fall 2026",accessState:"open",selection:{included:true,score:1,reasons:[]}}}]}));
}
function setup(path = ":memory:") {const store=createStore(path,clock);store.ingest(batch);course(store);return store;}
function descriptor(store:Store) {return store.describePersonalWork(store.resources().find(r=>r.kind==="assignment")!.id)!;}
function change(store:Store, extra:Partial<PersonalWorkChange> = {}): PersonalWorkChange {return {...descriptor(store),operationId:"check-one",expectedRevision:0,checked:true,...extra};}
function update(store:Store, patch:Partial<ResourceInput>) {store.ingest({...batch,observedAt:stamp,resources:batch.resources.map(r=>r.kind==="assignment"?{...r,...patch}:r)});}

test("check → submitted → graded/commented/missing remains checked; real SQLite reopen and Undo", () => {
 const dir=mkdtempSync(join(tmpdir(),"magic-work-"));const path=join(dir,"work.sqlite");let store=setup(path);
 try {const input=change(store);const receipt=store.setPersonalWork(input);const original=store.resources().find(r=>r.kind==="assignment")!.contentHash;
 update(store,{submitted:true,submission:{workflowState:"submitted",submittedAt:stamp},updatedAt:stamp});
 assert.notEqual(store.resources().find(r=>r.kind==="assignment")!.contentHash,original);
 assert.equal(personalWorkState(store.personalWorkReports(),descriptor(store)).checked,true);
 update(store,{submitted:true,submission:{workflowState:"graded",grade:"A",score:30,comments:[{text:"Nice work",createdAt:stamp}],missing:true,late:true},updatedAt:stamp});
 assert.equal(descriptor(store).sourceVersion,input.sourceVersion);
 store.close();store=createStore(path,clock);
 assert.equal(personalWorkState(store.personalWorkReports(),descriptor(store)).needsReview,false);
 assert.deepEqual(store.setPersonalWork(input),receipt);
 store.setPersonalWork(change(store,{operationId:"undo",expectedRevision:1,checked:false}));
 assert.deepEqual(store.setPersonalWork(input),receipt);
 assert.equal(store.personalWorkReports()[0]!.checked,false);
 store.close();store=createStore(path,clock);
 assert.equal(store.personalWorkReports()[0]!.revision,2);
 assert.deepEqual(store.personalWorkHistory(input.issueId).map(e=>e.checked),[true,false]);
 assert.equal(store.resources().find(r=>r.kind==="assignment")!.completed,false);
 } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test("changed due date/instructions retain report and exact review reason; current Undo never expires",()=>{
 const store=setup();try{const input=change(store);store.setPersonalWork(input);
 update(store,{dueAt:"2026-10-01T12:00:00Z",text:"Submit a revised 1200 word essay."});
 const state=personalWorkState(store.personalWorkReports(),descriptor(store));
 assert.equal(state.checked,true);assert.equal(state.needsReview,true);assert.equal(state.record?.reportedAt,stamp);
 assert.ok(state.changes.some(c=>c.field==="dueAt" && c.after==="2026-10-01T12:00:00Z"));assert.ok(state.changes.some(c=>c.field==="instructionHash"));
 assert.throws(()=>store.setPersonalWork({...input,operationId:"stale",expectedRevision:1}),/requirements changed/);
 assert.deepEqual(store.personalWorkHistory(input.issueId)[0]?.evidence,input.evidence);
 store.setPersonalWork(change(store,{operationId:"undo-current",checked:false,expectedRevision:1}));
 assert.equal(personalWorkState(store.personalWorkReports(),descriptor(store)).checked,false);
 }finally{store.close();}
});

test("independent SQLite connection CAS, duplicate operation collision and retry after Undo",()=>{
 const dir=mkdtempSync(join(tmpdir(),"magic-work-cas-"));const path=join(dir,"work.sqlite");const first=setup(path);const second=createStore(path,clock);
 try{const input=change(first);first.setPersonalWork(input);
 assert.throws(()=>second.setPersonalWork({...input,operationId:"second"}),/another view/);
 assert.throws(()=>second.setPersonalWork({...input,checked:false}),/operation ID/);
 second.setPersonalWork({...input,operationId:"undo",checked:false,expectedRevision:1});
 assert.equal(first.setPersonalWork(input).revision,1);assert.equal(first.personalWorkReports()[0]!.revision,2);
 }finally{first.close();second.close();rmSync(dir,{recursive:true,force:true});}
});

test("source removal/exclusion/unknown membership refuse state; cached expired sign-in remains local",()=>{
 const store=setup();try{const input=change(store);store.setPersonalWork(input);
 store.setCourseOverride({accountScope:"synthetic",courseId:"sample-101",included:false});
 assert.equal(store.personalWorkReports().length,0);assert.throws(()=>store.setPersonalWork({...input,operationId:"excluded",checked:false,expectedRevision:1}),/no longer available/);
 store.setCourseOverride({accountScope:"synthetic",courseId:"sample-101",included:true});
 assert.equal(store.personalWorkReports().length,1);
 store.removeSource(batch.source.id);assert.equal(store.personalWorkReports().length,0);assert.throws(()=>store.setPersonalWork(input),/no longer available/);
 }finally{store.close();}
 const orphan=createStore(":memory:",clock);try{orphan.ingest(batch);assert.equal(orphan.describePersonalWork(orphan.resources()[0]!.id),undefined);}finally{orphan.close();}
});

test("scope covers account+course+canonical resource; no mixed account evidence or lecture check",()=>{
 const store=setup();try{const input=change(store);store.setPersonalWork(input);
 store.ingest({...batch,source:{...batch.source,id:"other-assignments",accountScope:"other"}});course(store,"other");
 const other=store.resources().find(r=>r.sourceId==="other-assignments"&&r.kind==="assignment")!;
 assert.notEqual(store.describePersonalWork(other.id)!.issueId,input.issueId);
 assert.equal(store.describePersonalWork(other.id,[input.scope.canonicalResourceId]),undefined);
 assert.equal(store.describePersonalWork(store.resources().find(r=>r.kind==="event")!.id),undefined);
 assert.ok(store.describePersonalWork(store.resources().find(r=>r.kind==="material"&&r.sourceId===batch.source.id)!.id));
 }finally{store.close();}
});

test("core snapshot has server descriptor and receipt; purge clears reports and obsolete retry",async()=>{
 const store=setup();const core=createCore(store,{now:clock.now,fixture:batch});try{
 const view=core.snapshot().resources.find(r=>r.kind==="assignment")!;assert.ok(view.personalWork);
 const input={...view.personalWork!,operationId:"core-check",checked:true,expectedRevision:0};
 const result=await core.execute({type:"personal-work",value:input});assert.equal(result.snapshot.personalWorkReports?.[0]?.checked,true);
 assert.equal(result.personalWorkReceipt?.issueId,input.issueId);
 const payload=core.context(input.scope.canonicalResourceId,"local").payload;
 const token="local-work-test";store.setMcpGrant({id:"work-test",label:"Work test",recipient:"local",enabled:true,courses:[{accountScope:"synthetic",courseId:"sample-101"}],categories:["course_text"],tokenHash:createHash("sha256").update(token).digest("hex")});
 const exported=createMcpService(store,"work-test",token).call("get_item",{id:input.scope.canonicalResourceId});
 for(const output of [payload,exported]) {assert.equal(JSON.stringify(output).includes("personalWork"),false);assert.equal(JSON.stringify(output).includes(input.issueId),false);}
 await core.execute({type:"personal-work",value:{...input,operationId:"core-undo",checked:false,expectedRevision:1}});
 const replay=await core.execute({type:"personal-work",value:input});assert.equal(replay.snapshot.personalWorkReports?.[0]?.checked,false);assert.equal(replay.personalWorkReceipt?.revision,1);
 store.purge();assert.deepEqual(core.snapshot().personalWorkReports,[]);assert.deepEqual(store.personalWorkHistory(input.issueId),[]);
 await assert.rejects(core.execute({type:"personal-work",value:input}),/no longer available/);
 }finally{store.close();}
});

test("date-only extension annotates schedule without reopening checked work",()=>{
 const store=setup();try{store.setPersonalWork(change(store));update(store,{dueAt:"2026-10-04T12:00:00Z"});
 const state=personalWorkState(store.personalWorkReports(),descriptor(store));
 assert.equal(state.checked,true);assert.equal(state.needsReview,false);assert.equal(state.scheduleChanged,true);
 assert.ok(state.changes.some(c=>c.field==="dueAt"));
 }finally{store.close();}
});

test("removed secondary evidence keeps recoverable CAS revision without exposing removed content",()=>{
 const store=setup();try{
 const primary=store.resources().find(r=>r.kind==="assignment")!;
 const secondaryBatch={...batch,source:{...batch.source,id:"calendar-evidence"},resources:[{...batch.resources[0]!,externalId:"date-notice",title:"Private removed title"}]};
 store.ingest(secondaryBatch);const secondary=store.resources().find(r=>r.sourceId==="calendar-evidence")!;
 const descriptorBefore=store.describePersonalWork(primary.id,[secondary.id])!;
 store.setPersonalWork({...descriptorBefore,operationId:"multi",checked:true,expectedRevision:0});
 store.removeSource("calendar-evidence");
 const states=store.personalWorkReports();assert.equal(states[0]!.revision,1);assert.equal(JSON.stringify(states).includes("Private removed title"),false);
 const state=personalWorkState(states,store.describePersonalWork(primary.id)!);assert.equal(state.checked,true);assert.equal(state.needsReview,true);
 store.setPersonalWork({...store.describePersonalWork(primary.id)!,operationId:"undo-missing",checked:false,expectedRevision:state.revision});
 assert.equal(store.personalWorkReports()[0]!.checked,false);
 }finally{store.close();}
});

test("needs-sign-in capture retains available local checks; inaccessible source refuses them",()=>{
 const store=setup();try{const input=change(store);store.setPersonalWork(input);
 store.ingest({...batch,observedAt:stamp,status:"needs_sign_in",complete:false,resources:[]});
 assert.equal(store.personalWorkReports()[0]!.checked,true);
 store.setPersonalWork({...descriptor(store),operationId:"local-undo",checked:false,expectedRevision:1});
 store.ingest({...batch,observedAt:"2026-09-27T12:01:00.000Z",status:"inaccessible",complete:false,resources:[]});
 assert.equal(store.personalWorkReports().length,0);assert.throws(()=>store.setPersonalWork(input),/no longer available/);
 }finally{store.close();}
});


test("term journal capacity refuses new checks but retains Undo and the next term partition",()=>{
 const dir=mkdtempSync(join(tmpdir(),"magic-work-cap-"));const path=join(dir,"work.sqlite");const store=setup(path);
 try {const input=change(store);const key="personalWork:"+JSON.stringify([input.scope.accountScope,input.scope.termKey]);
 const seed=new DatabaseSync(path);seed.prepare("INSERT INTO preferences VALUES (?,?)").run(key,JSON.stringify(Array.from({length:20000},(_,i)=>({...input,operationId:`seed-${i}`,expectedRevision:i,revision:i+1,reportedAt:stamp}))));seed.close();
 assert.throws(()=>store.setPersonalWork({...input,operationId:"full",expectedRevision:20000}),/history for this term is full/);
 store.setPersonalWork({...input,operationId:"full-undo",expectedRevision:20000,checked:false});
 assert.equal(store.personalWorkReports()[0]!.checked,false);
 // A newly observed term gets a fresh capacity partition; old history remains intact.
 const courseResource=store.resources().find(r=>r.kind==="course")!;
 store.ingest(captureBatchSchema.parse({...batch,source:{...batch.source,id:"synthetic:course",scope:"course"},observedAt:"2026-09-28T12:00:00Z",resources:[{externalId:courseResource.externalId,kind:"course",courseId:"sample-101",courseName:"Writing",title:"Writing",url:"https://example.org/course",text:"",course:{termId:"spring-2027",termName:"Spring 2027",accessState:"open"}}]}));
 store.setPersonalWork(change(store,{operationId:"next-term",expectedRevision:20001}));
 const db=new DatabaseSync(path);assert.equal(db.prepare("SELECT count(*) AS n FROM preferences WHERE key LIKE 'personalWork:%'").get()!.n,2);db.close();
 assert.equal(store.personalWorkReports()[0]!.revision,20002);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test("core recomputes contributor set and refuses a caller omitting independent deadline evidence",async()=>{
 const store=setup();const core=createCore(store,{now:clock.now,fixture:batch});try{
 const primary=store.resources().find(r=>r.kind==="assignment")!;const incomplete=store.describePersonalWork(primary.id)!;
 store.ingest(captureBatchSchema.parse({...batch,source:{...batch.source,id:"date-announcement",scope:"announcements"},resources:[{externalId:"notice",kind:"message",courseId:primary.courseId,courseName:primary.courseName,title:primary.title,url:primary.url+"/notice",text:`${primary.title} is due September 30, 2026 at 11:59pm.`,createdAt:stamp}]}));
 const current=core.snapshot().resources.find(r=>r.id===primary.id)!.personalWork!;assert.equal(current.evidence.length,2);
 await assert.rejects(core.execute({type:"personal-work",value:{...incomplete,operationId:"omit",checked:true,expectedRevision:0}}),/requirements changed/);
 assert.equal(store.personalWorkReports().length,0);
 const saved=await core.execute({type:"personal-work",value:{...current,operationId:"complete-evidence",checked:true,expectedRevision:0}});assert.equal(saved.personalWorkReceipt?.checked,true);
 }finally{store.close();}
});

test("module-only Quiz/Assignment are checkable while unrelated files remain uncheckable",()=>{
 const store=setup();try {
 const material=batch.resources.find(r=>r.kind==="material")!;
 store.ingest({...batch,observedAt:stamp,resources:[...batch.resources,
   {...material,externalId:"module-quiz",url:"https://example.org/module-quiz",moduleItem:{type:"Quiz",contentId:"745546",dueAt:"2026-09-28T04:59:59Z"}},
   {...material,externalId:"module-assignment",url:"https://example.org/module-assignment",moduleItem:{type:"Assignment",contentId:"745547"}},
   {...material,externalId:"unassigned-file",url:"https://example.org/unassigned-file",moduleItem:{type:"File",contentId:"745548"}},
 ]});
 const resources=store.resources();const projected=store.personalWorkSnapshot(resources.map(r=>({canonicalResourceId:r.id})),resources);
 for(const externalId of ["module-quiz","module-assignment"]) {
   const resource=resources.find(r=>r.externalId===externalId)!;
   const descriptor=projected.descriptors.find(d=>d.scope.canonicalResourceId===resource.id)!;assert.ok(descriptor);
   assert.deepEqual(store.describePersonalWork(resource.id),descriptor);
   store.setPersonalWork({...descriptor,operationId:externalId,expectedRevision:0,checked:true});
 }
 assert.equal(projected.descriptors.some(d=>d.scope.canonicalResourceId===resources.find(r=>r.externalId==="unassigned-file")!.id),false);
 store.setCourseOverride({accountScope:"synthetic",courseId:"sample-101",included:false});
 assert.equal(store.personalWorkSnapshot(resources.map(r=>({canonicalResourceId:r.id})),resources).descriptors.length,0);
 }finally{store.close();}
});

test("snapshot admission uses four SQL reads for 100 and 1900 tasks with no per-material source scan",()=>{
 const originalPrepare=DatabaseSync.prototype.prepare;
 let enabled=false;const reads:string[]=[];
 DatabaseSync.prototype.prepare=function(sql:string) {
   const statement=originalPrepare.call(this,sql);
   return new Proxy(statement,{get(target,property){const value=Reflect.get(target,property,target);
     if(typeof value!=="function")return value;
     return (...args:unknown[])=>{if(enabled&&(property==="all"||property==="get"))reads.push(sql);return Reflect.apply(value,target,args);};
   }});
 };
 let store:Store|undefined;
 try{
   store=setup();const template=batch.resources.find(r=>r.kind==="material")!;
   const materials=Array.from({length:1900},(_,i)=>({...template,externalId:`reading-${i}`,url:`https://example.org/assigned-${i}`,text:"Assigned instruction. ".repeat(50)}));
   const assignment={...batch.resources.find(r=>r.kind==="assignment")!,links:materials.map(r=>r.url)};
   const imported=store.ingest({...batch,source:{...batch.source,id:"scale-source"},observedAt:stamp,resources:[assignment,...materials]});
   assert.ok(imported.created > 1800,JSON.stringify(imported));
   const saved=store.resources();const tasks=saved.filter(r=>r.kind==="material"&&r.sourceId==="scale-source");const results:unknown[]=[];
   for(const count of [100,1900]) {
     reads.length=0;enabled=true;const start=performance.now();
     const snapshot=store.personalWorkSnapshot(tasks.slice(0,count).map(r=>({canonicalResourceId:r.id})),saved);
     const elapsed=performance.now()-start;enabled=false;
     assert.equal(snapshot.descriptors.length,count);assert.equal(reads.length,4);
     assert.equal(reads.some(sql=>/resource_versions/.test(sql)),false);
     results.push({tasks:count,sqlReads:reads.length,resourceDecodes:0,milliseconds:Math.round(elapsed)});
   }
   console.info("personal-work snapshot scaling",JSON.stringify(results));
 }finally{enabled=false;store?.close();DatabaseSync.prototype.prepare=originalPrepare;}
});


test("snapshot shares one resource read and rechecks changed course access on the next snapshot", () => {
  const store = setup();
  const core = createCore(store, {now: clock.now, fixture: batch});
  const read = store.resources.bind(store);
  let reads = 0;
  store.resources = (...args) => { reads++; return read(...args); };
  try {
    const first = core.snapshot();
    assert.equal(reads, 1);
    assert.ok(first.courseWorkAdmission?.resourceIds.length);
    assert.ok(first.resources.some(r => r.personalWork));
    store.setCourseOverride({accountScope: "synthetic", courseId: "sample-101", included: false});
    reads = 0;
    const excluded = core.snapshot();
    assert.equal(reads, 1);
    assert.equal(excluded.courseWorkAdmission?.resourceIds.length, 0);
    assert.equal(excluded.resources.some(r => r.personalWork), false);
    store.setCourseOverride({accountScope: "synthetic", courseId: "sample-101", included: true});
    reads = 0;
    const restored = core.snapshot();
    assert.equal(reads, 1);
    assert.deepEqual(restored.courseWorkAdmission, first.courseWorkAdmission);
  } finally { store.close(); }
});
