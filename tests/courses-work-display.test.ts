import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CourseWorkRow } from '../apps/desktop/src/renderer/courses/course-work-model';
import { groupCourseWork, initialWorkListState, workPlacement, workPageSize, workTimeLabel } from '../apps/desktop/src/renderer/courses/course-work-display';
const today = '2026-09-27';
function row(key: string, changes: Partial<CourseWorkRow> = {}): CourseWorkRow {
  return { key, accountScope: 'a', courseId: 'course', resourceId:key, evidenceIds:[key], sourceIds:['source'], kind:'assignment',mode:'task',title:'Task',courseLabel:'COURSE 1',time:{state:'dated',date:today,minute:1439,at:'2026-09-28T04:59:00Z',timeZone:'America/Chicago',role:'due',personal:false,sourceConflict:false},sourceState:'unknown',report:{issueId:key,obligationVersion:'version',revision:1,checked:true,needsReview:false} as CourseWorkRow['report'],action:null,...changes };
}
test('personally checked graded unknown, unsubmitted and missing stay active while submitted can fold',()=>{
  for(const sourceState of ['unknown','unsubmitted','missing'] as const) assert.equal(workPlacement(row('x',{sourceState}),today).section,'current');
  assert.equal(workPlacement(row('x',{sourceState:'submitted'}),today).section,'done');
  assert.equal(workPlacement(row('x',{kind:'prep'}),today).section,'done');
});
test('conflicting dates have no day placement and personal choice remains explicitly personal',()=>{
  assert.deepEqual(workPlacement(row('x',{time:{state:'conflict',needsReview:false}}),today),{section:'conflict',date:null});
  const chosen=row('x'); chosen.time={state:'dated',date:today,minute:null,at:today,timeZone:'America/Chicago',role:'planning',personal:true,sourceConflict:true};
  assert.equal(workTimeLabel(chosen,today),'Your plan that day · source dates disagree');
  assert(!workTimeLabel(chosen,today).includes('12:00'));
});
test('no arbitrary overdue cutoff and full-term future rows remain in reachable Later',()=>{
  const old=row('old');if(old.time.state==='dated')old.time={...old.time,date:'2026-01-02'};
  const future=row('future');if(future.time.state==='dated')future.time={...future.time,date:'2026-12-14'};
  const buckets=groupCourseWork([old,future],today,initialWorkListState());
  assert.equal(buckets[0]!.groups[0]!.label,'Past due');assert.equal(buckets[1]!.section,'later');
});
test('past lecture is earlier context and never past due homework',()=>{
  const lecture=row('l',{mode:'commitment',kind:'lecture',report:null});if(lecture.time.state==='dated')lecture.time={...lecture.time,date:'2026-09-26',role:'starts'};
  assert.equal(workPlacement(lecture,today).section,'earlier');
});
test('explicit prep occurrence joins placement without inventing due time and never crosses scope',()=>{
  const lecture=row('l',{kind:'lecture',mode:'commitment',report:null});
  const prep=row('p',{kind:'prep',report:null,time:{state:'undated'},relation:{occurrenceKey:'l',label:'Before the lecture'}});
  const groups=groupCourseWork([lecture,prep],today,initialWorkListState());
  assert.deepEqual(groups[0]!.groups[0]!.rows.map(r=>r.key),['p','l']);assert.equal(workTimeLabel(prep,today),'Before the lecture');
  const wrong={...prep,accountScope:'other'};assert.equal(workPlacement(wrong,today,[lecture,wrong]).section,'undated');
});
test('new source completion preserves acted-on row position for this visit',()=>{
  const original=row('x',{report:null});const state=initialWorkListState();state.pins.x=workPlacement(original,today);
  assert.equal(groupCourseWork([{...original,sourceState:'submitted'}],today,state)[0]!.section,'current');
});
test('forty rows in one day stay bounded and all slices can be reached',()=>{
  const groups=groupCourseWork(Array.from({length:40},(_,i)=>row(String(i))),today,initialWorkListState())[0]!.groups;
  assert.equal(workPageSize(groups),20);assert.equal(workPageSize(groups,40),40);
});
test('day arithmetic survives year transition without invented clock time',()=>{
  const next=row('next');if(next.time.state==='dated')next.time={...next.time,date:'2027-01-01',minute:null,at:'2027-01-01'};
  assert.equal(groupCourseWork([next],'2026-12-31',initialWorkListState())[0]!.groups[0]!.label,'Tomorrow');
  assert.equal(workTimeLabel(next,'2026-12-31'),'Due that day');
});

test('new unresolved conflict overrides a previous date pin, including submitted work',()=>{
  const state=initialWorkListState();state.pins.x={section:'current',date:today};
  const conflict=row('x',{sourceState:'submitted',time:{state:'conflict',needsReview:true}});
  assert.equal(groupCourseWork([conflict],today,state)[0]!.section,'conflict');
});
