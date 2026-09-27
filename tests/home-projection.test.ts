import {canvasContent} from '../packages/connectors/src/canvas-content';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {ResourceView,SourceHealth} from '@magic/contracts';
import {resolveDeadline} from '@magic/domain';
import {canonicalHomeResources,homeWork,meaningfulPassage,selectHomeEvidence} from '../apps/desktop/src/renderer/home/projection';
import {TodayRail} from '../apps/desktop/src/renderer/TodayRail';
const sources=[{id:'canonical',accountScope:'a',courseId:'c',scope:'assignments'},{id:'account',accountScope:'a',courseId:'c',scope:'upcoming'},{id:'other',accountScope:'b',courseId:'c',scope:'assignments'},
  {id:'todo',accountScope:'a',courseId:'c',scope:'account-todo',kind:'canvas'},{id:'events',accountScope:'a',courseId:'c',scope:'account-upcoming-events',kind:'canvas'},{id:'feed',accountScope:'a',courseId:'c',scope:'calendar_feed',kind:'calendar'}] as SourceHealth[];
const now='2026-09-27T18:00:00Z',tz='America/Chicago';
const due=(value:string)=>resolveDeadline([{kind:'due',value,quote:'due_at',authority:'structured',scopeConfirmed:true}]);
function resource(id:string,patch:Partial<ResourceView>={}):ResourceView {return {id,externalId:id,sourceId:'canonical',kind:'assignment',courseId:'c',courseName:'Course',title:`Task ${id}`,url:`https://canvas.example/courses/c/assignments/${id}`,text:'',contentHash:`hash-${id}`,version:1,observedAt:now,capturedAt:now,deleted:false,completed:false,submitted:false,points:null,policy:{mode:'unknown',evidence:''},deadlines:[],deadline:due('2026-09-28T18:00:00Z'),kindLabel:null,...patch};}
function feedEntry(id:string,uid:string,patch:Partial<ResourceView>={}):ResourceView {return resource(id,{kind:'event',sourceId:'feed',externalId:`calendar:${id}`,url:'https://canvas.example/calendar?include_contexts=course_c',deadline:resolveDeadline([]),calendar:{uid,start:'2026-09-27',end:'2026-09-28',allDay:true,lastModified:null},...patch});}
test('canonical provider identity keeps accounts separate and preserves independent conflicts/contributors',()=>{
 const a=resource('1');const alias=resource('alias',{externalId:'1',url:a.url,sourceId:'account',deadline:due('2026-09-29T18:00:00Z')});
 const other=resource('other-id',{externalId:'1',url:a.url,sourceId:'other'});
 const result=canonicalHomeResources([alias,a,other],sources);
 assert.equal(result.length,2);assert.equal(result[0].id,'1');assert.equal(result[0].deadline.conflict,true);assert.equal(result[0].deadline.claims.length,2);assert.equal(result[0].deadlineContributors?.length,2);assert.equal(alias.deadline.conflict,false);
});
test('three captured representations of one assignment count once in Today; equal titles in another course stay separate',()=>{
 const tonight='2026-09-28T04:59:00Z';
 const reps=[1,2,3,4,5].flatMap(n=>[resource(`${n}`,{deadline:due(tonight)}),resource(`todo-${n}`,{sourceId:'todo',externalId:`todo-${n}`,url:`https://canvas.example/courses/c/assignments/${n}#submit`,deadline:due(tonight)}),resource(`event-${n}`,{sourceId:'events',externalId:`assignment_${n}`,url:`https://canvas.example/courses/c/assignments/${n}`,deadline:due(tonight)})]);
 const sameTitle=resource('elsewhere',{courseId:'d',title:'Task 1',url:'https://canvas.example/courses/d/assignments/1',deadline:due(tonight)});
 const work=homeWork(canonicalHomeResources([...reps,sameTitle],sources),sources,now,tz);
 assert.equal(reps.length,15);
 assert.deepEqual(work.today.map(r=>r.id),['1','2','3','4','5','elsewhere']);
 assert.equal(work.today[0].deadlineContributors?.length,3);assert.equal(work.today[0].deadline.conflict,false);
});
test('Canvas feed assignment entries merge by exact provider id only; overrides, other courses and events stay visible',()=>{
 const a=resource('77',{deadline:due('2026-09-28T04:59:00Z')});
 const copy=feedEntry('copy','event-assignment-77'),override=feedEntry('override','event-assignment-override-77'),event=feedEntry('lab','event-calendar-event-9');
 const elsewhere=feedEntry('elsewhere','event-assignment-77',{courseId:'d'});
 const result=canonicalHomeResources([copy,a,override,event,elsewhere],sources);
 assert.deepEqual(result.map(r=>r.id).sort(),['77','elsewhere','lab','override']);
 // DATE feed evidence agrees with the precise timed deadline and remains inspectable.
 const projected=result.find(r=>r.id==='77')!;
 assert.equal(projected.id,a.id);assert.equal(projected.deadline.conflict,false);assert.equal(projected.deadlineContributors?.length,2);assert.equal(a.deadline.claims.length,1);
});
test('groups need three items with the same account, course, verified category and exact due time',()=>{
 const category=resource('g',{kind:'material',assignmentGroup:{weight:10},title:'Problem sets'});
 const at='2026-09-29T04:59:00Z';
 const same=['1','2','3'].map(id=>resource(id,{assignmentGroupId:'g',deadline:due(at)}));
 const differentTime=resource('4',{assignmentGroupId:'g',deadline:due('2026-09-29T02:00:00Z')});
 const pair=['5','6'].map(id=>resource(id,{assignmentGroupId:'g',deadline:due('2026-09-30T04:59:00Z')}));
 const unverified=resource('7',{assignmentGroupId:'missing',deadline:due(at)}),cross=resource('8',{assignmentGroupId:'g',sourceId:'other',deadline:due(at)}),done=resource('9',{assignmentGroupId:'g',submitted:true,deadline:due(at)});
 const work=homeWork([...same,category,differentTime,...pair,unverified,cross,done],sources,now,tz);
 const grouped=work.upcoming.filter(g=>g.items.length>1);
 assert.equal(grouped.length,1);assert.deepEqual(grouped[0].items.map(r=>r.id),['1','2','3']);assert.equal(grouped[0].category,'Problem sets');assert.equal(Date.parse(grouped[0].at),Date.parse(at));
 assert.deepEqual(work.upcoming.map(g=>g.items[0].id),['4','1','7','8','5','6']);
 assert.equal(work.upcoming.flatMap(g=>g.items).length,8);
});
test('Today owns the whole local day, including earlier times; all older unresolved work remains reachable',()=>{
 const work=homeWork([resource('morning',{deadline:due('2026-09-27T13:00:00Z')}),resource('later',{deadline:due('2026-09-28T02:00:00Z')}),resource('old',{deadline:due('2026-08-01T18:00:00Z')}),resource('future',{deadline:due('2026-09-28T13:00:00Z')})],sources,now,tz);
 assert.deepEqual(work.today.map(r=>r.id),['morning','later']);assert.equal(work.earlier[0].id,'old');assert.equal(work.upcoming[0].items[0].id,'future');
});
test('briefing chooses literal meaningful instruction after greeting with exact offsets',()=>{
 const r=resource('notice',{kind:'message',text:'Hello everyone! Please bring the revised worksheet to the next discussion meeting. Thanks for your time.'});
 const p=meaningfulPassage(r)!;assert.match(p.span.text,/^Please bring/);assert.equal(r.text.slice(p.span.start,p.span.end),p.span.text);assert.equal(p.span.contentHash,r.contentHash);
});
test('review selection requires current exact linked material in same scope; empty pools invent no quiz',()=>{
 const material=resource('reading',{kind:'material',title:'Evidence and inference',text:'A saved passage with useful concepts.'});
 const assignment=resource('1',{text:'Please review the evidence notes before attempting the comparison task.',links:[material.url]});
 const link={id:'link',fromId:material.id,toId:assignment.id,type:'specifies' as const,status:'accepted' as const,inputHash:material.contentHash,reason:'Direct link'};
 assert.equal(selectHomeEvidence([assignment,material],{sources,links:[link]},now,tz).study[0].material.id,material.id);
 assert.equal(selectHomeEvidence([assignment,material],{sources,links:[{...link,inputHash:'stale'}]},now,tz).study.length,0);
 assert.equal(selectHomeEvidence([assignment,material],{sources,links:[link]},now,tz).study.length,1);
 assert.equal(selectHomeEvidence([assignment,{...material,sourceId:'other'}],{sources,links:[link]},now,tz).study.length,0);
 assert.deepEqual(selectHomeEvidence([],{sources,links:[]},now,tz).study,[]);
});
test('Home Today initially shows three unique deadlines and reachable all-day entries',()=>{
 const dueItems=Array.from({length:8},(_,i)=>resource(`d${i}`,{deadline:due('2026-09-28T04:59:00Z')}));
 const entries=[feedEntry('all-day','event-calendar-event-0')];
 const render=(homeDueCount:number)=>renderToStaticMarkup(createElement(TodayRail,{now,homeDueCount,homeDueItems:dueItems,courseLabel:()=>'COURSE 1',compactEmpty:true,resources:[...dueItems,...entries],sources,onSelect:()=>{},onPlan:async()=>{}}));
 const rows=(html:string)=>(html.match(/data-focus-key="today-d\d+"/g) ?? []).length;
 const initial=render(3);assert.equal(rows(initial),3);assert.match(initial,/Show next 3/);
 assert.match(initial,/<span>Due today<\/span><span>8<\/span>/);
 assert.match(initial,/<button[^>]*class="rail-allday rail-allday--home"/);
 const expanded=render(6);assert.equal(rows(expanded),6);assert.match(expanded,/Show next 2/);assert.match(expanded,/Show less/);
 const all=render(9);assert.equal(rows(all),8);assert.doesNotMatch(all,/Show next/);assert.match(all,/Show less/);
});

function exactPassage(text:string) {
 const r=resource('literal',{kind:'message',text});
 const p=meaningfulPassage(r)!;
 assert.ok(p,'expected a complete bounded passage');
 assert.equal(p.resource,r);assert.equal(p.span.resourceId,r.id);assert.equal(p.span.version,r.version);assert.equal(p.span.contentHash,r.contentHash);assert.equal(p.span.field,'text');
 assert.equal(r.text.slice(p.span.start,p.span.end),p.span.text);
 return p.span.text;
}
test('Home keeps adjacent applicability and reversals with the quoted instruction',()=>{
 for(const separator of [' ','\n','\n\n','\r\n\r\n']) {
  const text=`Please prepare the full project presentation for Monday.${separator}This applies only to students assigned to the Monday section; Tuesday students should wait.`;
  assert.equal(exactPassage(text),text);
  const exception=`Please submit a printed copy before the next class.${separator}Except for remote students, who should submit a PDF instead.`;
  assert.equal(exactPassage(exception),exception);
 }
 const preceding='If you are assigned to the Monday section:\n\nPlease prepare the full project presentation for Monday.';
 assert.equal(exactPassage(preceding),preceding);
});
test('Home does not turn a long instruction into a short stronger claim',()=>{
 const text='Please prepare the full project presentation for Monday. '+ 'Retain the annotated planning notes for the discussion. '.repeat(10)+'Except for Tuesday students, who should wait.';
 assert.ok(text.length>440);
 assert.equal(meaningfulPassage(resource('long',{text})),null);
 assert.equal(meaningfulPassage(resource('long-neighbor',{text:text.replace('Except','\n\nExcept')})),null);
 // Another self-contained paragraph is usable; the long block is never clipped into a requirement.
 const short='Office hours will meet in Room 210 this Thursday.';
 assert.equal(exactPassage('Background: '+ 'The project history spans several terms. '.repeat(15)+'\n\n'+short),short);
});
test('Home preserves multiple requirements and HTML paragraph/list conditions without inventing text',()=>{
 const html='<p>Hello everyone!</p><p>Please submit one PDF containing the following:</p><ul><li>The essay and bibliography.</li><li>The annotated source table.</li></ul><p>Only Monday-section students should submit this week.</p>';
 const captured=canvasContent(html,'https://canvas.example/courses/c/assignments/1');
 const selected=exactPassage(captured.text);
 assert.match(selected,/essay and bibliography/);assert.match(selected,/annotated source table/);assert.match(selected,/Only Monday-section/);
 assert.doesNotMatch(selected,/<p>|<li>/);
 const items='Please bring these materials:\n\n1. The revised worksheet.\n\n2. Your annotated reading notes.\n\nExcept for remote students, who may use digital copies.';
 assert.equal(exactPassage(items),items);
});
test('Home punctuation and social trim never split names, decimals, or audience context',()=>{
 const text='Hello everyone! Please read Dr. Rivera’s notes, including sec. 3.2, before the next discussion. This applies only to Group B. Thanks for your time.';
 assert.equal(exactPassage(text),'Please read Dr. Rivera’s notes, including sec. 3.2, before the next discussion. This applies only to Group B.');
 const audience='Hello Monday-section students! Please bring the revised worksheet to the discussion.';
 const selected=meaningfulPassage(resource('audience',{text:audience}));
 assert.ok(!selected || selected.span.text===audience,'do not remove the audience as generic greeting');
 const noPeriod='Please submit both the essay and bibliography in a single PDF\nOnly students in the Monday section submit this week';
 assert.equal(exactPassage(noPeriod),noPeriod);
});
test('Home keeps negation and example context around apparently actionable source text',()=>{
 for(const text of [
  'This is an example of an incorrect instruction:\n\nPlease submit your final response without the required bibliography.',
  'Please upload the complete final report by Monday.\n\nThis instruction is superseded. Do not submit until the revised rubric is posted.',
  'AI tools are available for preliminary brainstorming.\n\nExcept on exams, where all automated assistance is prohibited.',
 ]) assert.equal(exactPassage(text),text);
});
test('changed-date highlighting expands exact evidence to its bounded source context',()=>{
 const text='The project deadline has moved to Monday.\n\nThis applies only to students assigned to the Monday section.';
 const message=resource('change',{kind:'message',text});
 const claimText='The project deadline has moved to Monday.';
 const span={resourceId:message.id,contentHash:message.contentHash,version:message.version,field:'text' as const,start:0,end:claimText.length,text:claimText};
 const assignment=resource('due-change',{deadline:resolveDeadline([{kind:'due',value:'2026-09-28T18:00:00Z',quote:claimText,authority:'explicit_change',scopeConfirmed:true,span}])});
 const p=selectHomeEvidence([assignment,message],{sources,links:[]},now,tz).passages[0]!;
 assert.equal(p.reason,'changed-date');assert.equal(p.span.text,text);assert.equal(message.text.slice(p.span.start,p.span.end),text);
 for(const corrupt of [{version:2},{field:'title' as const},{start:-1},{end:text.length+1},{contentHash:'stale'},{text:'A fabricated change.'}]) {
  const bad=resource('bad',{deadline:resolveDeadline([{kind:'due',value:'2026-09-28T18:00:00Z',quote:claimText,authority:'explicit_change',scopeConfirmed:true,span:{...span,...corrupt}}])});
  const selections=selectHomeEvidence([bad,message],{sources,links:[]},now,tz).passages;
  assert.ok(selections.every(selection=>selection.reason!=='changed-date'));
  assert.ok(selections.every(selection=>selection.resource.text.slice(selection.span.start,selection.span.end)===selection.span.text));
 }
});
test('changed-date claim cannot bypass the bound and hide a late exception',()=>{
 const claimText='The project deadline has moved to Monday.';
 const text=claimText+' '+ 'Keep the source notes for your next discussion. '.repeat(12)+'Only the Monday section is affected.';
 const message=resource('long-change',{kind:'message',text});
 const span={resourceId:message.id,contentHash:message.contentHash,version:message.version,field:'text' as const,start:0,end:claimText.length,text:claimText};
 const assignment=resource('due-long',{deadline:resolveDeadline([{kind:'due',value:'2026-09-28T18:00:00Z',quote:claimText,authority:'explicit_change',scopeConfirmed:true,span}])});
 assert.deepEqual(selectHomeEvidence([assignment,message],{sources,links:[]},now,tz).passages,[]);
});

test('overlong HTML lists cannot leak later isolated requirements after their heading is rejected',()=>{
 const text=canvasContent('<p>Please complete the following steps.</p><ol>'+Array.from({length:12},(_,i)=>`<li>Read step ${i+1} and retain its comparison notes for the discussion.</li>`).join('')+'</ol><p>Only the Monday section should do these steps.</p>','https://canvas.example/courses/c/assignments/1').text;
 assert.ok(text.length>440);
 assert.equal(meaningfulPassage(resource('long-html-list',{text})),null);
});
