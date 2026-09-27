import assert from "node:assert/strict";
import { test } from "node:test";
import type { Resource, SourceHealth } from "@magic/contracts";
import { runSourceInvestigator, searchInvestigation, InvestigationError, type InvestigationRequest } from "../packages/runner/src/source-investigator";

function setup() {
  const make=(id:string,sourceId:string,kind:string,text:string) => ({ id, sourceId, courseId:"course-a", title:id, text, contentHash:`hash-${id}`, version:1, deleted:false, kind, policy:{mode:"allowed",evidence:""}, observedAt:"2026-09-27T00:00:00Z", url:`https://course.example/${id}`, deadlines:[] }) as unknown as Resource;
  const assignment=make("assignment","source-a","assignment","");
  const schedule=make("schedule","source-a","material","Week 4. Unit 3: Design a garden app interface. Read chapter 3 and build a paper sketch. Week 5. Unit 4: APIs.");
  const distractor=make("distractor","source-a","material","Garden app interface garden app interface garden app interface");
  const cross=make("cross","source-b","material","Unit 3: secret unrelated instructions.");
  const map=new Map([assignment,schedule,distractor,cross].map(r=>[r.id,r]));
  const sources=[{id:"source-a",accountScope:"account-a",courseId:"course-a",status:"ok"},{id:"source-b",accountScope:"account-b",courseId:"course-a",status:"ok"}] as SourceHealth[];
  const req={ store:{ resource:(id:string)=>map.get(id), resources:()=>[...map.values()], sources:()=>sources, courseIntelligence:()=>[], passages:()=>[], passage:()=>undefined, courseInventoryHash:()=>"inventory-1", searchPassages:({query,resourceIds}:{query:string;resourceIds:string[]})=>({hits:[...map.values()].filter(r=>resourceIds.includes(r.id) && r.text.toLowerCase().includes(query.toLowerCase().split(" ")[0] ?? "")).map(r=>({resourceId:r.id,version:r.version,start:0,end:r.text.length})),notFound:false,coverage:1,terms:[]}) },
    backend:{ client:"codex" as const, async call(){ throw new Error("unset") } },
    grant:{ accountScope:"account-a",courseId:"course-a",assignmentId:assignment.id,assignmentHash:assignment.contentHash,selected:[{resourceId:assignment.id,contentHash:assignment.contentHash},{resourceId:schedule.id,contentHash:schedule.contentHash}] },
    context:{ assignmentId:assignment.id,accountScope:"account-a",courseId:"course-a",contentHash:assignment.contentHash,instructions:{status:"empty" as const,chars:0},submission:{status:"none_listed" as const,types:["none"]},sections:[{resourceId:schedule.id,contentHash:schedule.contentHash,start:8,end:90,provisional:true,linkedToAssignment:false}],links:[],unknowns:["The Canvas assignment does not give a submission route."] },
    workSet:{assignmentId:assignment.id,items:[],held:[{resourceId:schedule.id,title:schedule.title,reason:"Possible match"}]}, authorizeEgress:()=>true, project:(_r:Resource,text:string)=>({text}) } as unknown as InvestigationRequest;
  return {req,assignment,schedule,distractor,cross};
}
test("click to exact-ID and lexical investigation returns cited provisional partial result",async()=>{
  const {req,schedule}=setup(); let calls=0; let readCitation="";
  req.backend={client:"codex",async call(call){ calls++; const v=JSON.parse(call.input); const ids=(v.observation?.items??[]) as {citationId:string}[]; if(calls===2) readCitation=ids[0].citationId;
    const value=calls===1?{action:"read_resource",resourceId:schedule.id,start:8,length:75}:calls===2?{action:"search",query:"paper sketch"}:{action:"finish",status:"partial",summary:"The saved course schedule suggests a paper sketch activity.",findings:[{kind:"context",text:"Read chapter 7 and build a paper sketch.",citationIds:[readCitation]}],unknowns:["Confirm whether this schedule entry is the Canvas task."]};
    return {value,usage:{in:2,cached:0,out:1},model:"fixture-model"}; }};
  const result=await runSourceInvestigator(req);
  assert.equal(result.status,"partial"); assert.equal(result.findings[0]?.citations[0]?.provisional,true);
  assert.deepEqual(result.receipts.map(x=>x.action),["read_resource","search"]);
  assert.equal(result.receipts[0]?.citationIds.length,1); assert.equal(result.model,"fixture-model");
  assert.equal(result.citations[0]?.resourceId,schedule.id); assert.equal(result.citations[0]?.start,8);
});
test("selected filtering occurs before lexical top-k and cross-account reads fail",async()=>{
  const {req,cross}=setup();
  assert.deepEqual(searchInvestigation(req,"garden").map(x=>x.resourceId),["schedule"]);
  req.grant.selected=[...req.grant.selected,{resourceId:cross.id,contentHash:cross.contentHash}];
  await assert.rejects(runSourceInvestigator(req),e=>e instanceof InvestigationError && e.code==="scope_changed");
});
test("provisional only evidence cannot be promoted to assignment instructions",async()=>{
  const {req,schedule}=setup(); let calls=0;
  req.backend={client:"codex",async call(call){ calls++; const v=JSON.parse(call.input); return { value:calls===1?{action:"read_resource",resourceId:schedule.id,start:8,length:60}:{action:"finish",status:"resolved",summary:"Do the activity",findings:[{kind:"instruction",text:"Build a form",citationIds:[v.observation.items[0].citationId]}],unknowns:[]},usage:{in:1,cached:0,out:1},model:"fixture" }; }};
  await assert.rejects(runSourceInvestigator(req),e=>e instanceof InvestigationError && e.code==="invalid_action");
});
test("saved link uses only bounded connector port and rejects model-chosen URL",async()=>{
  const {req}=setup(); let calls=0, fetches=0;
  req.context.links=[{url:"https://course.example/guide",captured:null}];
  req.backend={client:"codex",async call(call){calls++;const observation=JSON.parse(call.input).observation;return {value:calls===1?{action:"follow_link",url:"https://course.example/guide"}:{action:"finish",status:"partial",summary:"A saved guide was read.",findings:[{kind:"reading",text:"Review the guide.",citationIds:[observation.items[0].citationId]}],unknowns:[]},usage:{in:1,cached:0,out:1},model:"fixture"};}};
  const text="A saved guide explains the paper sketch.";
  req.external={async readSavedLink(url){fetches++;assert.equal(url,"https://course.example/guide");return {accountScope:"account-a",courseId:"course-a",url,resourceId:"guide",sourceId:"source-a",title:"Guide",text,contentHash:(await import("node:crypto")).createHash("sha256").update(text).digest("hex"),version:1};}};
  const result=await runSourceInvestigator(req);assert.equal(fetches,1);assert.equal(result.citations[0]?.resourceId,"guide");
  req.backend={client:"codex",async call(){return {value:{action:"follow_link",url:"https://unrelated.example/private"},usage:{in:1,cached:0,out:1},model:"fixture"};}};
  await assert.rejects(runSourceInvestigator(req),e=>e instanceof InvestigationError && e.code==="invalid_action");assert.equal(fetches,1);
});
test("consent and current hash are rechecked after the connected action",async()=>{
  const {req,schedule}=setup(); let calls=0, grants=0;
  req.authorizeEgress=()=>++grants<4;
  req.backend={client:"codex",async call(){calls++;return {value:{action:"read_resource",resourceId:schedule.id,start:8,length:40},usage:{in:1,cached:0,out:1},model:"fixture"};}};
  await assert.rejects(runSourceInvestigator(req),e=>e instanceof InvestigationError && e.code==="egress_denied");assert.equal(calls,1);
  req.authorizeEgress=()=>true;calls=0;
  req.backend={client:"codex",async call(){calls++;schedule.contentHash="changed";return {value:{action:"read_resource",resourceId:schedule.id,start:8,length:40},usage:{in:1,cached:0,out:1},model:"fixture"};}};
  await assert.rejects(runSourceInvestigator(req),e=>e instanceof InvestigationError && e.code==="scope_changed");assert.equal(calls,1);
});

test("new same-course source inventory invalidates an in-flight result",async()=>{
  const {req}=setup(); let inventory="inventory-1";
  req.inventoryHash=inventory;
  req.store.courseInventoryHash=()=>inventory;
  req.backend={client:"codex",async call(){inventory="inventory-2";return {value:{action:"finish",status:"partial",summary:"Incomplete",findings:[],unknowns:["Read the new source."]},usage:{in:1,cached:0,out:1},model:"fixture"};}};
  await assert.rejects(runSourceInvestigator(req),e=>e instanceof InvestigationError && e.code==="scope_changed");
});
test("Stop cancels before another model egress",async()=>{
  const {req}=setup(); const controller=new AbortController();req.signal=controller.signal;
  let calls=0;req.backend={client:"codex",async call(){calls++;controller.abort();return {value:{action:"finish",status:"partial",summary:"Incomplete",findings:[],unknowns:[]},usage:{in:1,cached:0,out:1},model:"fixture"};}};
  await assert.rejects(runSourceInvestigator(req),e=>e instanceof InvestigationError && e.code==="aborted");
  assert.equal(calls,1);
});
