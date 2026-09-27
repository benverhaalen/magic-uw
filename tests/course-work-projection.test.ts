import test from 'node:test';
import assert from 'node:assert/strict';
import type { ResourceView, SourceHealth, Store } from '@magic/contracts';
import type { CourseWorkAdmission } from '../packages/contracts/src/course-work';
import { personalWorkIssue, personalWorkVersion, type PersonalWorkDescriptor, type PersonalWorkState } from '../packages/contracts/src/personal-work';
import { resolveDeadline } from '@magic/domain';
import { courseWorkAdmission } from '../packages/core/src/course-work-scope';
import { projectCourseWork, isCourseWorkActionCurrent, type CourseWorkInput, type CourseWorkResource } from '../apps/desktop/src/renderer/courses/course-work-model';
const now='2026-09-27T18:00:00Z';
const sources=[['direct','a','c','assignments'],['course','a','c','course'],['feed','a','c','calendar_feed'],['module','a','c','module-items:m'],['other','b','c','assignments'],['othercourse','b','c','course'],['excluded','a','540','assignments'],['excludedcourse','a','540','course']].map(([id,accountScope,courseId,scope])=>({id,accountScope,courseId,scope,status:'ok',complete:true,kind:'canvas'})) as SourceHealth[];
const due=(value:string)=>resolveDeadline([{kind:'due',value,quote:'due_at',authority:'structured',scopeConfirmed:true}]);
function resource(id:string,patch:Partial<CourseWorkResource>={}):CourseWorkResource {return {id,externalId:id,sourceId:'direct',kind:'assignment',courseId:'c',courseName:'Course',title:`Task ${id}`,url:`https://canvas.example/courses/c/assignments/${id}`,text:'',contentHash:`hash-${id}`,version:1,observedAt:now,capturedAt:now,deleted:false,completed:false,submitted:false,points:null,policy:{mode:'unknown',evidence:''},deadlines:[],deadline:due('2026-09-28T18:00:00Z'),kindLabel:null,...patch};}
const courses=[resource('course',{kind:'course',sourceId:'course',course:{termId:'fall26',termName:'Fall 2026'}}),resource('othercourse',{kind:'course',sourceId:'othercourse',course:{termId:'fall26',termName:'Fall 2026'}}),resource('excludedcourse',{kind:'course',courseId:'540',sourceId:'excludedcourse',course:{termId:'fall26',termName:'Fall 2026',selection:{included:false,score:1,reasons:['excluded']}}})];
function admission(resources:CourseWorkResource[], selectedTerm:string|null='fall26'):CourseWorkAdmission {
 const store={sources:()=>sources,resources:()=>resources,courseOverrides:()=>[],ingestionSettings:()=>({selectedTerm})} as unknown as Store;
 return courseWorkAdmission(store);
}
function model(rows:CourseWorkResource[],options:Partial<CourseWorkInput>={}) { const resources=[...courses,...rows];return projectCourseWork({resources,sources,admission:admission(resources),generatedAt:now,...options}); }
function descriptor(r:CourseWorkResource):PersonalWorkDescriptor {
 const obligation={title:r.title,instructionHash:'a'.repeat(64),dueAt:r.dueAt??null,lockAt:null,unlockAt:null,moduleDueAt:null,deadlines:[],points:null,submissionTypes:['online_upload'],requirementsHash:'b'.repeat(64)};
 const evidence=[{resourceId:r.id,obligation}],scope={accountScope:'a',courseId:'c',canonicalResourceId:r.id,termKey:'fall26'};
 return {scope,issueId:personalWorkIssue(scope),evidence,sourceVersion:personalWorkVersion(evidence)};
}
test('actual policy admits both accounts, rejects excluded CS540 and unknown sources before joins',()=>{
 const a=resource('77'),b=resource('b77',{externalId:'77',sourceId:'other',url:a.url}),excluded=resource('x',{sourceId:'excluded',courseId:'540'}),unknown=resource('u',{sourceId:'missing'});
 const result=model([a,b,excluded,unknown]);
 assert.deepEqual(result.rows.map(r=>r.accountScope).sort(),['a','b']);assert.equal(result.scope.term.label,'Fall 2026');
 assert.equal(result.rows.some(r=>r.courseId==='540'),false);assert.equal(result.scope.courses.some(c=>c.courseId==='540'),false);
});
test('full inventory preserves old overdue, undated and locked work and later term work',()=>{
 const rows=[resource('old',{deadline:due('2026-09-01T18:00:00Z'),lockAt:'2026-09-02T18:00:00Z'}),resource('none',{deadline:resolveDeadline([])}),resource('later',{deadline:due('2026-12-15T18:00:00Z')})];
 const result=model(rows);assert.equal(result.rows.length,3);assert.equal(result.rows.find(r=>r.resourceId==='none')?.time.state,'undated');assert.equal(result.rows.find(r=>r.resourceId==='old')?.action?.resourceId,'old');
});
test('one shared canonical family joins module and feed assignment copies while retaining date conflicts',()=>{
 const a=resource('77');const module=resource('m77',{kind:'material',sourceId:'module',externalId:'m77',moduleItem:{type:'Assignment',contentId:'77'},deadline:resolveDeadline([])});
 const feed=resource('f77',{kind:'event',sourceId:'feed',calendar:{uid:'event-assignment-77',start:'2026-09-29T18:00:00Z',allDay:false},deadline:resolveDeadline([])});
 const result=model([a,module,feed]);assert.equal(result.rows.length,1);assert.equal(result.rows[0]?.resourceId,'77');assert.deepEqual(result.rows[0]?.evidenceIds,['77','f77','m77']);assert.equal(result.rows[0]?.time.state,'conflict');assert.equal(result.rows[0]?.action?.kind,'open-work-set');
});
test('a valid personal day remains day precision; new contributors make it Dates to confirm',()=>{
 const a=resource('77');const claim={kind:'due' as const,value:'2026-09-29T05:00:00Z',quote:'calendar day',authority:'structured' as const,scopeConfirmed:true,precision:'day' as const};
 a.deadline=resolveDeadline([...a.deadline.claims,claim]);a.personalDeadline={sourceVersion:'version',revision:1,options:[{id:'choice',value:claim.value,precision:'day',claims:[claim]}],selected:{optionId:'choice',value:claim.value,precision:'day',reportedAt:now},needsReview:false};
 const chosen=model([a]).rows[0]!;assert.equal(chosen.time.state,'dated');if(chosen.time.state==='dated'){assert.equal(chosen.time.date,'2026-09-29');assert.equal(chosen.time.minute,null);assert.equal(chosen.time.at,'2026-09-29');assert.equal(chosen.time.personal,true);}
 const alias=resource('copy',{externalId:'77',url:a.url,sourceId:'feed'});const changed=model([a,alias]).rows[0]!;assert.equal(changed.time.state,'conflict');
});
test('personal check survives a grade and unknown submission stays distinct from submitted',()=>{
 const a=resource('77');a.personalWork=descriptor(a);const report:PersonalWorkState={...a.personalWork,checked:true,revision:1,reportedAt:now};
 const graded={...a,completed:true,submission:{workflowState:'graded',grade:'A',score:10},contentHash:'changed'};
 const row=model([graded],{personalWorkReports:[report]}).rows[0]!;assert.equal(row.report?.checked,true);assert.equal(row.sourceState,'unknown');assert.equal(row.sourceLabel,'Submission unknown');
 const submitted=model([{...graded,submitted:true}],{personalWorkReports:[report]}).rows[0]!;assert.equal(submitted.sourceState,'submitted');assert.equal(submitted.report?.checked,true);assert.equal(submitted.action?.label,'View submission');
 const changed=structuredClone(graded);changed.personalWork!.evidence[0]!.obligation.instructionHash='c'.repeat(64);changed.personalWork!.sourceVersion=personalWorkVersion(changed.personalWork!.evidence);
 const revised=model([changed],{personalWorkReports:[report]}).rows[0]!;assert.equal(revised.report?.checked,true);assert.equal(revised.report?.needsReview,true);assert.equal(revised.report?.reportedAt,now);
});
test('only grounded meeting and prep binding produces separate roles; titles cannot invent lecture work',()=>{
 const event=resource('meeting',{kind:'event',sourceId:'feed',calendar:{uid:'real-lecture',start:'2026-09-28T15:30:00Z',allDay:false},deadline:resolveDeadline([])});
 const prep=resource('prep',{kind:'material',sourceId:'module',title:'Read Chapter 2',moduleItem:{type:'Page',completionRequirement:{type:'must_view'}}});prep.personalWork=descriptor(prep);
 const unbound=model([event,prep,resource('fake',{title:'Lecture prep exam reading'})]);assert.equal(unbound.rows.find(r=>r.resourceId==='fake')?.kind,'assignment');assert.ok(unbound.coverage.some(c=>c.kind==='unmapped-meeting'));
 const bound=model([event,prep],{bindings:[{resourceId:'meeting',accountScope:'a',courseId:'c',kind:'lecture',mode:'commitment',evidenceIds:['meeting'],meetingEvidence:'dated-occurrence',occurrenceKey:'lecture-1'}, {resourceId:'prep',accountScope:'a',courseId:'c',kind:'prep',mode:'task',evidenceIds:['prep','meeting'],relation:{occurrenceKey:'lecture-1',label:'Prep for lecture'}}]});
 assert.equal(bound.rows.length,2);const lecture=bound.rows.find(r=>r.kind==='lecture')!;assert.equal(lecture.report,null);assert.equal(lecture.time.state==='dated'&&lecture.time.role,'starts');assert.equal(bound.rows.find(r=>r.kind==='prep')?.relation?.occurrenceKey,'lecture-1');
});
test('unknown term is honest, scope change invalidates prepared action, and feed-only is uncheckable',()=>{
 const feed=resource('f77',{kind:'event',sourceId:'feed',calendar:{uid:'event-assignment-77',start:'2026-09-29',allDay:true},deadline:resolveDeadline([])});
 const before=model([feed]);assert.equal(before.rows[0]?.report,null);assert.equal(before.rows[0]?.sourceState,'not-applicable');assert.equal(before.rows[0]?.time.state==='dated'&&before.rows[0].time.minute,null);
 const after=model([]);assert.equal(isCourseWorkActionCurrent(before.rows[0]!,after),false);
 const unverified=model([resource('77')],{admission:{selectedTerm:'fall26',courses:[{accountScope:'a',courseId:'c',sourceIds:['direct'],termId:null,termName:null,courseLabel:'Course'}],resourceIds:['77'],aliases:[]}});assert.equal(unverified.scope.term.state,'unknown');assert.equal(unverified.scope.term.label,'Your courses');
});

test('strict existing account/course/term/section crosswalk supplies full-term class patterns and a dated exam',()=>{
 const course=resource('course',{kind:'course',sourceId:'course',courseName:'COMPSCI400: Programming III (001) FA26',course:{courseCode:'FA26 COMPSCI 400 001',termId:'fall26',termName:'Fall 2026'}});
 const provenance={sourceUrl:'https://enroll.wisc.edu/',observedAt:now,scope:{kind:'enrollment_term',key:'1272'}};
 const shared={deleted:false,version:1,contentHash:'hash',provenance};
 const records=[{...shared,kind:'subject',id:'subject',localId:'subject',sourceId:'public',accountScope:'public',code:'266',shortName:'COMPSCI',formalName:'Computer Sciences',aliases:[]},
  {...shared,kind:'account_link',id:'link',localId:'link',sourceId:'enroll',accountScope:'planning-account',canvasAccountScope:'a',method:'matched_institutional_login'},
  {...shared,kind:'enrollment_package',id:'pkg',localId:'pkg',sourceId:'enroll',accountScope:'planning-account',courseKey:'uw:266:400',termCode:'1272',sections:['LEC 001','DIS 301'],enrollmentState:'enrolled',status:'open',meetingsComplete:true,meetings:[
    {kind:'class',mode:'scheduled',days:[1,3,5],startMinute:630,endMinute:680,startDate:'2026-09-01',endDate:'2026-12-15',timezone:'America/Chicago',location:'Building'},
    {kind:'exam',mode:'scheduled',days:[4],startMinute:1080,endMinute:1140,startDate:'2026-11-05',endDate:'2026-11-05',timezone:'America/Chicago',location:'Room'},
  ]}];
 const planningSources=[{id:'enroll',accountScope:'planning-account',status:'complete',completeness:'complete',observedAt:now},{id:'public',accountScope:'public',status:'complete',completeness:'complete',observedAt:now}];
 const store={sources:()=>sources,resources:()=>[course],courseOverrides:()=>[],ingestionSettings:()=>({selectedTerm:'fall26'}),planningRecords:()=>records,planningSources:()=>planningSources} as unknown as Store;
 const scope=courseWorkAdmission(store,now);assert.equal(scope.schedules?.length,1);assert.equal(scope.schedules?.[0]?.classKind,'class');
 const result=projectCourseWork({resources:[course],sources,admission:scope,generatedAt:now});
 assert.ok(result.rows.length>40);assert.ok(result.rows.some(row=>row.time.state==='dated'&&row.time.date==='2026-12-14'));
 const exam=result.rows.find(row=>row.kind==='exam')!;assert.equal(exam.report,null);assert.equal(exam.meetingEvidence,'dated-occurrence');assert.equal(exam.time.state==='dated'&&exam.time.at,'2026-11-06T00:00:00.000Z');
 assert.ok(result.coverage.some(item=>item.kind==='recurrence-exceptions'));assert.equal(result.rows[0]?.action?.resourceId,'course');
 // No implicit account selection, mismatched section, or stale account evidence can establish a meeting.
 (records[1] as any).canvasAccountScope='other';assert.equal(courseWorkAdmission(store,now).schedules?.length,0);
 (records[1] as any).canvasAccountScope='a';(records[2] as any).sections=['LEC 002'];assert.equal(courseWorkAdmission(store,now).schedules?.length,0);
 (records[2] as any).sections=['LEC 001'];planningSources[0]!.observedAt='2026-09-01T18:00:00Z';assert.equal(courseWorkAdmission(store,now).schedules?.length,0);
});

test('date-only obligation extension annotates the schedule without rewriting a saved personal check',()=>{
 const original=resource('77',{dueAt:'2026-09-28T18:00:00Z'});original.personalWork=descriptor(original);
 const saved:PersonalWorkState={...original.personalWork,revision:2,checked:true,reportedAt:now};
 const updated=structuredClone(original);updated.dueAt='2026-09-30T18:00:00Z';updated.deadline=due(updated.dueAt);
 updated.personalWork!.evidence[0]!.obligation.dueAt=updated.dueAt;updated.personalWork!.sourceVersion=personalWorkVersion(updated.personalWork!.evidence);
 const row=model([updated],{personalWorkReports:[saved]}).rows[0]!;assert.equal(row.report?.checked,true);assert.equal(row.report?.needsReview,false);assert.equal(row.report?.scheduleChanged,true);assert.equal(row.report?.changeLabel,'Due date changed');
});


test('module-only quiz is real dated work and shares its canonical key with a later captured quiz',()=>{
 const module=resource('module-quiz',{kind:'material',sourceId:'module',url:'https://canvas.example/courses/c/modules/items/123',moduleItem:{type:'Quiz',contentId:'745546'},deadline:due('2026-09-28T04:59:59Z')});
 module.personalWork=descriptor(module);
 const first=model([module]).rows[0]!;
 assert.equal(first.kind,'quiz');assert.equal(first.mode,'task');assert.equal(first.time.state==='dated'&&first.time.date,'2026-09-27');assert.equal(first.report?.checked,false);assert.equal(first.action?.kind,'open-resource');assert.equal(first.action?.resourceId,module.id);
 const quiz=resource('quiz',{sourceId:'quiz-source',externalId:'745546',url:'https://canvas.example/courses/c/quizzes/745546',deadline:module.deadline});
 const quizSource={...sources[0]!,id:'quiz-source',scope:'quizzes'};
 const resources=[...courses,module,quiz], input=admission(resources);
 input.resourceIds.push(quiz.id);input.courses.find(c=>c.accountScope==='a'&&c.courseId==='c')!.sourceIds.push(quizSource.id);
 const later=projectCourseWork({resources,sources:[...sources,quizSource],admission:input,generatedAt:now});
 assert.equal(later.rows.length,1);assert.equal(later.rows[0]?.key,first.key);assert.equal(later.rows[0]?.kind,'quiz');assert.equal(later.rows[0]?.resourceId,quiz.id);
});
