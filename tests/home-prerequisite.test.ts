import test from 'node:test';
import assert from 'node:assert/strict';
import type { ResourceView, SourceHealth } from '@magic/contracts';
import {resolveDeadline} from '@magic/domain';
import {assignmentPrerequisite} from '../apps/desktop/src/renderer/home/prerequisite';
import {selectHomeEvidence} from '../apps/desktop/src/renderer/home/projection';
const now='2026-09-27T18:00:00Z';
const sources=[{id:'a',kind:'canvas',accountScope:'account-a',courseId:'course',scope:'assignments'}, {id:'m',kind:'canvas',accountScope:'account-a',courseId:'course',scope:'modules'}, {id:'q',kind:'canvas',accountScope:'account-a',courseId:'course',scope:'module-items:unit'}, {id:'other',kind:'canvas',accountScope:'account-b',courseId:'course',scope:'module-items:unit'}] as SourceHealth[];
const resource=(id:string,patch:Partial<ResourceView>={}):ResourceView=>({id,externalId:id,sourceId:'a',courseId:'course',courseName:'Course',kind:'assignment',title:id,url:`https://canvas.example/courses/course/assignments/${id}`,text:'',contentHash:`hash-${id}`,version:1,observedAt:now,capturedAt:now,deleted:false,submitted:null,completed:false,points:null,policy:{mode:'unknown',evidence:''},deadlines:[],deadline:resolveDeadline([{value:'2026-09-28T04:59:00Z',kind:'due',quote:'due_at',authority:'structured',scopeConfirmed:true}]),kindLabel:null,...patch});
const assignment=resource('task',{title:'Pre-Class 4 assignment: Water chemistry',text:"Dear students,\n\nPlease take the 'Preparation quiz' found within the Unit 2 module before reading and answering the following questions. Then read the supplied article and answer the questions."});
const module=resource('module',{kind:'material',sourceId:'m',title:'Unit 2 - Water',module:{id:'unit',state:'completed'}});
const quiz=resource('quiz-item',{kind:'material',sourceId:'q',title:'Preparation quiz - take before starting Class 4 assignment',url:'https://canvas.example/courses/course/modules/items/quiz-item',moduleItem:{type:'Quiz',moduleId:'unit',contentId:'quiz-content'}});
const fixture=[assignment,module,quiz];

test('explicit named quiz + module + reciprocal class produce exact, source-bound prerequisite',()=>{
 const p=assignmentPrerequisite(assignment,fixture,sources)!;
 assert.ok(p);
 assert.equal(p.assignment,assignment);assert.equal(p.quiz,quiz);assert.equal(p.module,module);
 assert.equal(p.reference,'Preparation quiz');assert.equal(p.completion,'unknown');
 assert.equal(p.evidence.resourceId,assignment.id);assert.equal(p.evidence.contentHash,assignment.contentHash);assert.equal(p.evidence.version,assignment.version);
 assert.equal(assignment.text.slice(p.evidence.start,p.evidence.end),p.evidence.text);
 assert.ok(p.evidence.text.endsWith('answer the questions.'));
 assert.equal(quiz.title.slice(p.quizTitleSpan.start,p.quizTitleSpan.end),p.quizTitleSpan.text);
 assert.equal(module.module?.state,'completed','module completion does not imply quiz completion');
});

test('missing graph link is not invented, but corroborated display fact is selected before narrative filler',()=>{
 const narrative=resource('narrative',{text:'Please read the long account of an interesting scientific discovery and the many researchers who contributed to it.'});
 const result=selectHomeEvidence([narrative,...fixture],{sources,links:[]},now,'America/Chicago');
 assert.equal(result.prerequisites.length,1);
 assert.equal(result.prerequisites[0].assignment.id,assignment.id);
 assert.equal(result.prerequisites[0].quiz.id,quiz.id);
 assert.deepEqual(result.study,[],'no typed material relation is fabricated');
});

test('source/account/course/module/stage mismatches decline, even with identical text',()=>{
 const changes:Partial<ResourceView>[]=[{sourceId:'other'},{courseId:'elsewhere'},{sourceId:'missing'},{moduleItem:{...quiz.moduleItem!,moduleId:'other-unit'}},{title:'Preparation quiz - take before starting Class 5 assignment'},{url:'https://elsewhere.example/courses/course/modules/items/quiz-item'}];
 for(const patch of changes) assert.equal(assignmentPrerequisite(assignment,[assignment,module,{...quiz,...patch}],sources),null);
 assert.equal(assignmentPrerequisite(assignment,[assignment,quiz],sources),null);
 assert.equal(assignmentPrerequisite({...assignment,title:'Class 4 and Class 5 assignment'},fixture,sources),null);
 assert.equal(assignmentPrerequisite(assignment,fixture,sources.filter(s=>s.id!=='a')),null);
});

test('ambiguity and removed resources do not resolve to a guessed quiz',()=>{
 assert.equal(assignmentPrerequisite(assignment,[...fixture,{...quiz,id:'copy'}],sources),null);
 assert.equal(assignmentPrerequisite(assignment,[...fixture,{...module,id:'copy',module:{id:'another'}}],sources),null);
 assert.equal(assignmentPrerequisite(assignment,[assignment,module,{...quiz,deleted:true}],sources),null);
 assert.equal(assignmentPrerequisite(assignment,[assignment,{...module,deleted:true},quiz],sources),null);
 const generic={...quiz,title:'Preparation quiz'};
 assert.equal(assignmentPrerequisite(assignment,[assignment,module,generic],sources),null,'same-name quiz without reciprocal stage is insufficient');
});

test('conditions, exceptions, negation and quoted examples remain in full instructions',()=>{
 for(const qualifier of ['This applies only to the afternoon section.','Unless your instructor says otherwise, follow these steps.','This is an outdated example.','Do not take this quiz.','The quiz is optional.','You can skip this quiz if you attended.']) {
  assert.equal(assignmentPrerequisite({...assignment,text:assignment.text+'\n\n'+qualifier},fixture,sources),null,qualifier);
 }
 assert.equal(assignmentPrerequisite({...assignment,text:assignment.text.replace('Please take','Please do not take')},fixture,sources),null);
 assert.equal(assignmentPrerequisite({...assignment,text:assignment.text+'\n\n'+assignment.text},fixture,sources),null,'multiple instructions are ambiguous');
});

test('verified completed or locked quiz is not promoted; unknown remains unknown',()=>{
 for(const patch of [{submitted:true},{completed:true},{moduleItem:{...quiz.moduleItem!,completionRequirement:{type:'must_submit',completed:true}}},{moduleItem:{...quiz.moduleItem!,lockInfo:{locked:true}}}]) {
  assert.equal(assignmentPrerequisite(assignment,[assignment,module,{...quiz,...patch}],sources),null);
 }
 assert.equal(assignmentPrerequisite({...assignment,submitted:true},fixture,sources),null);
 const unsubmitted={...quiz,submission:{workflowState:'unsubmitted',submittedAt:null,score:null,grade:null,late:false,missing:false}};
 assert.equal(assignmentPrerequisite(assignment,[assignment,module,unsubmitted],sources)?.completion,'not-submitted');
});

test('selection leaves past and completed assignments out',()=>{
 const old={...assignment,deadline:resolveDeadline([{value:'2026-08-01T00:00:00Z',kind:'due',quote:'due_at',authority:'structured',scopeConfirmed:true}])};
 assert.equal(selectHomeEvidence([old,module,quiz],{sources,links:[]},now,'America/Chicago').prerequisites.length,0);
 assert.equal(selectHomeEvidence([{...assignment,submitted:true},module,quiz],{sources,links:[]},now,'America/Chicago').prerequisites.length,0);
});

test('quiz-name punctuation retains the whole exact title span',()=>{
 const task={...assignment,text:assignment.text.replace('Preparation quiz','Preparation - safety quiz')};
 const target={...quiz,title:quiz.title.replace('Preparation quiz','Preparation - safety quiz')};
 const claim=assignmentPrerequisite(task,[task,module,target],sources)!;
 assert.equal(claim.quizTitleSpan.text,'Preparation - safety quiz');
 assert.equal(target.title.slice(claim.quizTitleSpan.start,claim.quizTitleSpan.end),claim.reference);
});
