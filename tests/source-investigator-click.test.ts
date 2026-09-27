import assert from "node:assert/strict";
import { test } from "node:test";
import type { Resource, SourceHealth, Store } from "@magic/contracts";
import { investigateAssignmentClick } from "../packages/runner/src/source-investigator-adapter";
import type { CourseCoreStore, GraphStore } from "../packages/contracts/src/course-core";

function clickFixture() {
  const resource=(id:string,kind:"assignment"|"material",title:string,text:string):Resource=>({
    id,sourceId:"course-source",externalId:id,courseId:"course",courseName:"Studio",
    kind,title,text,url:`https://course.example/${id}`,links:[],contentHash:`hash-${id}`,
    version:1,deleted:false,observedAt:"2026-09-27T00:00:00Z",
    deadlines:[],points:null,submitted:false,policy:{mode:"allowed",evidence:""},
  }) as unknown as Resource;
  const assignment=resource("task","assignment","Unit 3 activity","");
  const section=resource("site","material","Course site","Unit 3\nRead the design guide. Make a paper sketch.\nUnit 4\nDifferent work.");
  const extra=resource("extra","material","Design guide","A paper sketch should show the app's main screen.");
  const rows=[assignment,section,extra];
  const sources=[{id:"course-source",accountScope:"account",courseId:"course",scope:"course",label:"Course site",kind:"course_site",status:"ok",complete:true,lastSuccessAt:"2026-09-27T00:00:00Z"}] as unknown as SourceHealth[];
  let inventory="inventory-1";
  const links: any[]=[];
  const store={
    resource:(id:string)=>rows.find(r=>r.id===id),resources:()=>rows,sources:()=>sources,
    links:()=>links,courseOverrides:()=>[],ingestionSettings:()=>({selectedTerm:null}),
    courseIntelligence:()=>[],courseInventoryHash:()=>inventory,
    searchPassages:({query,resourceIds}:{query:string;resourceIds?:string[]})=>({
      hits:rows.filter(r=>resourceIds?.includes(r.id) && r.text.toLowerCase().includes(query.toLowerCase())).map(r=>({resourceId:r.id,version:r.version,start:0,end:r.text.length})),
      notFound:false,coverage:1,terms:[]}),
  } as unknown as Store & CourseCoreStore & Pick<GraphStore,"courseInventoryHash">;
  return {store,assignment,section,extra,links,arrive:()=>{inventory="inventory-2";}};
}
test("sparse assignment click yields a source-linked WorkSet and provisional task context",async()=>{
  const {store,assignment,section}=clickFixture();let calls=0,egress=0;
  const result=await investigateAssignmentClick({store,assignmentId:assignment.id,
    backend:{client:"codex",async call(call){calls++;const observation=JSON.parse(call.input).observation;
      return {value:calls===1
        ? {action:"read_resource",resourceId:section.id,start:0,length:48}
        : {action:"finish",status:"partial",summary:"The course site suggests a sketch activity.",findings:[{kind:"context",text:"Review the design guide and prepare a sketch.",citationIds:[observation.items[0].citationId]}],unknowns:["Confirm that this section applies to the Canvas task."]},
        usage:{in:1,cached:0,out:1},model:"synthetic-connected-codex"};}},
    access:()=>({allowed:()=>true,scrubFor:()=>text=>text}),
    beforeModel:(call)=>{egress++;return call;},
  });
  assert.equal(calls,2);assert.equal(egress,2);
  assert.equal(result.workSet.assignmentId,assignment.id);
  assert.equal(result.workSet.held[0]?.resourceId,section.id);
  assert.equal(result.findings[0]?.citations[0]?.resourceId,section.id);
  assert.equal(result.findings[0]?.citations[0]?.provisional,true);
});
test("clicked result stops on a newly arrived same-course source",async()=>{
  const {store,assignment,arrive}=clickFixture();
  await assert.rejects(investigateAssignmentClick({store,assignmentId:assignment.id,
    backend:{client:"codex",async call(){arrive();return {value:{action:"finish",status:"partial",summary:"",findings:[],unknowns:[]},usage:{in:1,cached:0,out:1},model:"synthetic"};}},
    access:()=>({allowed:()=>true,scrubFor:()=>text=>text}),beforeModel:call=>call,
  }),/inventory changed/i);
});

test("a saved assignment link to a captured course page becomes a reviewed WorkSet target",async()=>{
  const {store,assignment,section,links}=clickFixture();
  links.push({id:"accepted-site",fromId:section.id,toId:assignment.id,type:"specifies",status:"accepted",reason:"Saved assignment link",inputHash:section.contentHash});
  assignment.links=[{url:section.url,text:"Course site activity"}];
  const result=await investigateAssignmentClick({store,assignmentId:assignment.id,
    backend:{client:"codex",async call(call){const o=JSON.parse(call.input).observation;return {value:{action:"finish",status:"partial",summary:"The saved assignment links the captured course page.",findings:[],unknowns:["Read the linked page for details."]},usage:{in:1,cached:0,out:1},model:"synthetic"};}},
    access:()=>({allowed:()=>true,scrubFor:()=>text=>text}),beforeModel:call=>call,
  });
  assert.equal(result.workSet.items.some(x=>x.resourceId===section.id),true);
  assert.equal(store.resource(section.id)?.id,section.id);
});

test("genuine ambiguity remains typed and explicit",async()=>{
  const {store,assignment}=clickFixture();
  const result=await investigateAssignmentClick({store,assignmentId:assignment.id,
    backend:{client:"codex",async call(){return {value:{action:"finish",status:"ambiguous",summary:"The saved sources do not identify this task.",findings:[],unknowns:["Ask the instructor which activity applies."]},usage:{in:1,cached:0,out:1},model:"synthetic"};}},
    access:()=>({allowed:()=>true,scrubFor:()=>text=>text}),beforeModel:call=>call,
  });
  assert.equal(result.status,"ambiguous");assert.ok(result.unknowns.some(x=>x.includes("instructor")));
});
