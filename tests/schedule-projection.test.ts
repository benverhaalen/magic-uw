import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDeadline, buildTodayRail } from '@magic/domain';
import type { ResourceView, SourceHealth, Link } from '@magic/contracts';
import { calendarItems, calendarItemLabel } from '../apps/desktop/src/renderer/calendar/model';
import { canonicalHomeResources, homeWork } from '../apps/desktop/src/renderer/home/projection';
import { projectScheduleResources, schedulePlanning, scheduleRailResources, type ScheduleResource } from '../apps/desktop/src/renderer/schedule-projection';
const tz='America/Chicago', now='2026-09-27T18:00:00Z', first='2026-10-02T04:59:00Z', later='2026-10-17T04:59:00Z';
const sources=[{id:'direct',accountScope:'a',courseId:'c',scope:'assignments'}, {id:'feed',accountScope:'a',courseId:'c',scope:'calendar_feed'}, {id:'outlook',accountScope:'a',courseId:'c',scope:'outlook_calendar'}, {id:'other',accountScope:'b',courseId:'c',scope:'assignments'}] as SourceHealth[];
const claim=(value:string)=>({value,kind:'due' as const,scopeConfirmed:true,authority:'structured' as const,quote:'Synthetic due date'});
const resource=(id:string,patch:Partial<ResourceView & ScheduleResource>={}):ResourceView & ScheduleResource=>({id,externalId:'77',sourceId:'direct',accountScope:'a',sourceScope:'assignments',kind:'assignment',courseId:'c',courseName:'Synthetic course',title:'Synthetic task',url:'https://canvas.example/courses/c/assignments/77',text:'',contentHash:id,version:1,observedAt:now,capturedAt:now,deleted:false,completed:false,submitted:null,points:null,policy:{mode:'unknown',evidence:''},deadlines:[],deadline:resolveDeadline([claim(first)]),kindLabel:null,...patch});
const feed=(id:string,patch:Partial<ResourceView & ScheduleResource>={})=>resource(id,{kind:'event',sourceId:'feed',sourceScope:'calendar_feed',externalId:`calendar:${id}`,url:'https://canvas.example/calendar',deadline:resolveDeadline([]),calendar:{uid:'event-assignment-77',start:first,end:first,allDay:false},...patch});
const choice=(r:ResourceView,selected=later)=>({...r,personalDeadline:{sourceVersion:'version',revision:1,options:[first,later].map((value,i)=>({id:`o${i}`,value,precision:'minute' as const,claims:[claim(value)]})),selected:{optionId:selected===later?'o1':'o0',value:selected,precision:'minute' as const,reportedAt:now},needsReview:false}});
test('Calendar and Home share one canonical conflict, preserving all raw claims and navigation',()=>{
 const direct=resource('assignment',{deadline:resolveDeadline([claim(first),claim(later)])}); const original=JSON.stringify(direct);
 const todo=resource('todo',{sourceScope:'account-todo',externalId:'todo-77'}), f=feed('feed');
 const home=canonicalHomeResources([f,todo,direct],sources); const cal=calendarItems([f,todo,direct],[],'2026-10-01',tz);
 assert.equal(home.length,1);assert.equal(cal.length,1);assert.equal(home[0].id,'assignment');assert.equal(cal[0].resourceId,'assignment');assert.equal(cal[0].conflict,true);assert.equal(calendarItemLabel(cal[0],true),'Dates disagree');assert.equal(homeWork(home,sources,now,tz).upcoming[0].day,'2026-10-01');assert.equal(calendarItems([f,todo,direct],[],'2026-10-16',tz).length,0);assert.equal(JSON.stringify(direct),original);
});
test('valid personal selection moves the single deadline; stale selection returns to uncertainty',()=>{
 const selected=choice(resource('assignment',{deadline:resolveDeadline([claim(first),claim(later)])}));
 for(const r of [selected,{...selected,personalDeadline:{...selected.personalDeadline,selected:null,needsReview:true}}]) {
  const home=canonicalHomeResources([r],sources);const expected=r.personalDeadline.selected?'2026-10-16':'2026-10-01';const cal=calendarItems([r],[],expected,tz);
  assert.equal(homeWork(home,sources,now,tz).upcoming[0].day,expected);assert.equal(cal.length,1);assert.equal(cal[0].personal,!!r.personalDeadline.selected);assert.equal(cal[0].conflict,!r.personalDeadline.selected);assert.equal(home[0].deadline.conflict,true);
 }
});
test('new feed contributor invalidates frontend choice until backend options cover the evidence',()=>{
 const selected=choice(resource('assignment',{deadline:resolveDeadline([claim(first),claim(later)])}));const projected=projectScheduleResources([selected,feed('new')]);
 assert.equal(projected[0].personalDeadline?.selected,null);assert.equal(projected[0].personalDeadline?.needsReview,true);assert.equal(schedulePlanning(projected[0],tz)?.personal,false);assert.match(projected[0].scheduleDeadline?.choiceUnavailable ?? '',/not available yet/);
});
test('feed-only timed and DATE entries are due without manufacturing assignment capability or busy time',()=>{
 for(const dayOnly of [false,true]) {
  const r=feed('feed',{calendar:{uid:'event-assignment-77',start:dayOnly?'2026-09-27':'2026-09-28T04:59:00Z',end:'2026-09-28',allDay:dayOnly}});const home=canonicalHomeResources([r],sources);
  assert.equal(home[0].kind,'event');assert.equal(homeWork(home,sources,now,tz).today.length,1);assert.equal(buildTodayRail(scheduleRailResources(home),now,tz).events.length,0);assert.equal(buildTodayRail(scheduleRailResources(home),now,tz).suggestions.length,0);
  const cal=calendarItems([r],[],'2026-09-27',tz);assert.equal(cal.length,1);assert.equal(cal[0].kind,'deadline');assert.equal(cal[0].allDay,true);assert.match(cal[0].detail,/calendar feed/);assert.equal(cal[0].precision,dayOnly?'day':'minute');assert.equal(calendarItems([r],[],'2026-09-28',tz).length,0);
  if(dayOnly){assert.match(calendarItemLabel(cal[0],true),/time not provided/);assert.equal(schedulePlanning(home[0],'Pacific/Honolulu')?.date,'2026-09-27');}
 }
});
test('same day DATE refines with exact timed evidence, different feed date stays conflicting',()=>{
 const a=resource('a',{deadline:resolveDeadline([claim('2026-09-28T04:59:00Z')])});const f=feed('f',{calendar:{uid:'event-assignment-77',start:'2026-09-27',allDay:true}});
 const same=projectScheduleResources([a,f])[0];assert.equal(same.deadline.conflict,false);assert.equal(schedulePlanning(same,tz)?.minute,1439);
 const different=projectScheduleResources([a,{...f,calendar:{...f.calendar!,start:'2026-09-28'}}])[0];assert.equal(different.deadline.conflict,true);assert.equal(different.deadline.claims.length,2);
});
test('account scope, unknown source, Outlook lookalikes, overrides, contradictory IDs and ordinary meetings never alias',()=>{
 const a=resource('a');const candidates=[feed('other-account',{accountScope:'b'}),feed('unknown',{accountScope:undefined,sourceScope:undefined}),feed('outlook',{sourceScope:'outlook_calendar'}),feed('override',{calendar:{uid:'event-assignment-override-77',start:first,allDay:false}}),feed('contradiction',{calendar:{uid:'event-assignment-77',assignmentExternalId:'88',start:first,allDay:false}}),feed('meeting',{title:a.title,calendar:{uid:'meeting',start:first,end:'2026-10-02T05:59:00Z',allDay:false}})];
 for(const f of candidates){const result=projectScheduleResources([a,f]);assert.equal(result.length,2);if(f.id!=='other-account') assert.equal(calendarItems([f],[],'2026-10-01',tz)[0].kind,'event');}
});
test('rejected and stale relations prevent re-association; deleted/cancelled feed cannot resurrect',()=>{
 const a=resource('a'), f=feed('f');const link={id:'l',fromId:'f',toId:'a',type:'same_as',status:'rejected',inputHash:'f',reason:'Synthetic rejection'} as Link;
 assert.equal(projectScheduleResources([a,f],[link]).length,2);assert.equal(projectScheduleResources([f,a],[{...link,status:'accepted',inputHash:'old'}]).length,2);assert.equal(projectScheduleResources([a,f],[{...link,status:'accepted'}]).length,1);
 assert.equal(projectScheduleResources([a,{...f,deleted:true}]).length,1);assert.equal(projectScheduleResources([{...f,workflowState:'CANCELLED'}]).length,0);
});

test('quiz namespace and exact module references share only admitted canonical families',()=>{
 const a=resource('assignment'), quiz=resource('quiz',{sourceScope:'quizzes',url:'https://canvas.example/courses/c/quizzes/77'});
 const module=resource('module',{kind:'material',sourceScope:'modules',externalId:'module-item',moduleItem:{type:'Assignment',contentId:'77'},deadline:resolveDeadline([claim(later)])});
 assert.equal(projectScheduleResources([a,quiz]).length,2);
 const linked=projectScheduleResources([module,a,quiz],[],[{resourceId:'module',targetId:'assignment'}]);
 assert.equal(linked.length,2);assert.equal(linked[0].id,'assignment');assert.equal(linked[0].deadline.conflict,true);assert.equal(linked[0].scheduleDeadline?.evidenceIds.length,2);
 assert.equal(projectScheduleResources([module,a,quiz],[],[{resourceId:'module',targetId:'quiz'}]).length,3);
 assert.equal(projectScheduleResources([{...module,accountScope:'b'},a],[],[{resourceId:'module',targetId:'assignment'}]).length,2);
 assert.equal(projectScheduleResources([module,a],[],[{resourceId:'module',targetId:'missing'}]).length,2);
});

test('module-only graded quiz appears once in Home Today and Calendar with original source identity',()=>{
 const quiz=resource('module-quiz',{kind:'material',externalId:'module-item-1',sourceScope:'module-items:1',sourceId:'module-source',url:'https://canvas.example/courses/c/quizzes/92',moduleItem:{type:'Quiz',contentId:'92',dueAt:'2026-09-28T04:59:59Z'},deadline:resolveDeadline([claim('2026-09-28T04:59:59Z')])});
 const copy={...quiz,id:'another-module-reference',externalId:'module-item-2'};
 const src=[...sources,{id:'module-source',accountScope:'a',courseId:'c',scope:'module-items:1'}] as SourceHealth[];
 const projected=canonicalHomeResources([quiz,copy],src);
 assert.equal(projected.length,1);assert.equal(projected[0].kind,'material');assert.equal(homeWork(projected,src,now,tz).today.length,1);
 const cal=calendarItems(projectScheduleResources([quiz,copy]),[],'2026-09-27',tz);assert.equal(cal.length,1);assert.equal(cal[0].kind,'deadline');assert.match(cal[0].detail,/module quiz/);assert.equal(cal[0].feedOnly,false);
 const direct=resource('direct-quiz',{sourceScope:'quizzes',externalId:'92',url:'https://canvas.example/courses/c/assignments/77'});
 assert.equal(projectScheduleResources([quiz,direct],[],[{resourceId:quiz.id,targetId:direct.id}]).length,1);
});
