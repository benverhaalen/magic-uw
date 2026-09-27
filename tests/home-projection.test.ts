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
 // A copy without a due claim cannot move the deadline or change the reportable contributor set.
 assert.equal(result.find(r=>r.id==='77'),a);
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
// Home Today reveals due items three at a time ("Show next N"), like Upcoming: Ben's d44e863 and
// 5c3b87a replaced the earlier "up to six, then a disclosure" rule. The heading still counts every item.
test('Home Today counts unique items, reveals them three at a time, and all-day entries are reachable buttons',()=>{
 const render=(count:number,allDay:number,shown?:number)=>{
  const dueItems=Array.from({length:count},(_,i)=>resource(`d${i}`,{deadline:due('2026-09-28T04:59:00Z')}));
  const entries=Array.from({length:allDay},(_,i)=>feedEntry(`a${i}`,`event-calendar-event-${i}`));
  return renderToStaticMarkup(createElement(TodayRail,{now,homeDueItems:dueItems,homeDueCount:shown,courseLabel:()=>'COURSE 1',compactEmpty:true,resources:[...dueItems,...entries],sources,onSelect:()=>{},onPlan:async()=>{}}));
 };
 const rows=(html:string)=>(html.match(/data-focus-key="today-d\d+"/g) ?? []).length;
 const three=render(3,0);
 assert.equal(rows(three),3);assert.doesNotMatch(three,/home-show-next/);assert.match(three,/<span>Due today<\/span><span>3<\/span>/);
 const six=render(6,1);
 assert.equal(rows(six),3);assert.match(six,/<span>Due today<\/span><span>6<\/span>/);assert.doesNotMatch(six,/more due today/);
 assert.match(six,/<button class="home-show-next" data-focus-key="today-next" aria-label="Show next 3 due today; 3 of 6 shown">Show next 3<\/button>/);
 assert.match(six,/<button[^>]*class="rail-allday rail-allday--home"/);
 const sixAll=render(6,1,6);
 assert.equal(rows(sixAll),6);assert.doesNotMatch(sixAll,/home-show-next/);
 const eight=render(8,4,6);
 assert.match(eight,/<span>Due today<\/span><span>8<\/span>/);assert.equal(rows(eight),6);
 assert.match(eight,/aria-label="Show next 2 due today; 6 of 8 shown">Show next 2<\/button>/);
 assert.equal(rows(render(8,4,8)),8);
 assert.match(eight,/2 more all day/);assert.equal((eight.match(/rail-allday--home/g) ?? []).length,4);
});
