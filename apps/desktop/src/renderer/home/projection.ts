import { assignmentPrerequisite } from './prerequisite';
import type { ResourceView, Snapshot, SourceHealth, DeadlineSpan, Link } from '@magic/contracts';
import { localTime } from '@magic/domain';
import { projectScheduleResources, scheduleAssignmentId, schedulePlanning, type ScheduleResource, type ScheduleAlias } from '../schedule-projection';
import { projectCourseLabel } from '../../../../../packages/domain/src/course-label';

export const scopeKey = (r: ResourceView, sources: SourceHealth[]) => {
  const source = sources.find(s => s.id === r.sourceId);
  return JSON.stringify([source?.accountScope ?? r.sourceId, r.courseId]);
};
export function providerIdentity(r: ResourceView & ScheduleResource) {
  const assignment = scheduleAssignmentId(r);
  if (assignment) return `assignment:${assignment}`;
  if (r.kind === 'message' && /\/discussion_topics\/|\/announcements\//.test(r.url)) return `message:${r.url.split(/[?#]/)[0]}`;
  return `resource:${r.id}`;
}
/** A display projection of already permitted resources. It never widens inclusion. */
export function canonicalHomeResources(resources: ResourceView[], sources: SourceHealth[], links: Link[] = [], aliases: ScheduleAlias[] = []): ResourceView[] {
  const byId = new Map(sources.map(source => [source.id, source]));
  const scoped = resources.map(resource => {
    const source = byId.get(resource.sourceId);
    return { ...resource, accountScope: source?.accountScope, sourceScope: source?.scope, sourceKind: source?.kind };
  });
  const projected = projectScheduleResources(scoped, links, aliases);
  const seen = new Set<string>();
  return projected.filter(resource => {
    const key = JSON.stringify([scopeKey(resource, sources), providerIdentity(resource)]);
    // Schedule families already respect explicit rejected/stale links; never collapse them again.
    if (resource.kind !== 'message') return true;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
export function homeCourseLabel(r: ResourceView, resources: ResourceView[], sources: SourceHealth[]) {
  const course = resources.find(c => c.kind === 'course' && scopeKey(c,sources) === scopeKey(r,sources));
  const source = course && sources.find(s => s.id === course.sourceId);
  const label = course && source ? projectCourseLabel({resource:course,source}) : null;
  return { title:label?.displayTitle ?? r.courseName, code:label?.displayCode, raw:label?.rawName ?? r.courseName };
}
export function openHomeWork(r: ResourceView) {
  return (r.kind === 'assignment' || Boolean((r as ScheduleResource).scheduleDeadline)) && !r.deleted && !r.completed && !r.submitted && !r.submission?.excused;
}
export type UpcomingGroup = {key:string; category:string|null; day:string; at:string; items:ResourceView[]};
/** A collapsed set hides at least two rows; "+1 more" would cost as much space as the row it hides. */
export const GROUP_MIN = 3;
export function homeWork(resources: ResourceView[], sources: SourceHealth[], now: string, timeZone: string) {
  const today = localTime(now,timeZone).date;
  const dated = resources.filter(r => openHomeWork(r) && schedulePlanning(r,timeZone))
    .sort((a,b)=>schedulePlanning(a,timeZone)!.at.localeCompare(schedulePlanning(b,timeZone)!.at) || a.id.localeCompare(b.id));
  const day = (r:ResourceView) => schedulePlanning(r,timeZone)!.date;
  const groups = new Map<string,UpcomingGroup>();
  for (const r of dated.filter(r=>day(r)>today)) {
    const category = r.assignmentGroupId ? resources.find(c=>c.assignmentGroup && c.externalId===r.assignmentGroupId && scopeKey(c,sources)===scopeKey(r,sources)) : undefined;
    // Same account, course, verified gradebook category and exact due instant. A different time is its own row.
    const planning = schedulePlanning(r,timeZone)!;
    const groupable = category && planning.minute !== null && !planning.personal && !planning.conflict && !planning.needsReview;
    const key = groupable ? JSON.stringify([scopeKey(r,sources),r.assignmentGroupId,planning.at]) : `item:${r.id}`;
    const group = groups.get(key) ?? {key,category:category ? category.title : null,day:day(r),at:schedulePlanning(r,timeZone)!.at,items:[]};
    group.items.push(r);
    groups.set(key,group);
  }
  const upcoming = [...groups.values()].flatMap(g => g.items.length >= GROUP_MIN ? [g] : g.items.map(r => ({...g,key:`item:${r.id}`,category:null,items:[r]})));
  return {upcoming, today:dated.filter(r=>day(r)===today), earlier:dated.filter(r=>day(r)<today).reverse()};
}
export type HomePassage = {resource:ResourceView; span:DeadlineSpan; reason:'changed-date'|'instruction'|'information'};
const instructionWords = /\b(must|required|please|bring|read|review|submit|complete|prepare)\b/i;
const usefulWords = /\b(must|required|please|bring|read|review|submit|complete|prepare|extended|moved|changed|cancelled|canceled|available|posted|will meet|office hours)\b/i;
const dependentContext = /\b(if|unless|except|exception|only|applies|applicable|otherwise|however|instead|provided|regardless|not|never|example|incorrect|superseded|revoked|obsolete|outdated|correction)\b/i;
const introducesContinuation = (text:string)=>/:\s*$/.test(text) || /\b(following|below|these (?:steps|items|materials|requirements))\b/i.test(text);
const listItem = /^\s*(?:[-*•]|\d+[.)])\s/;
const PASSAGE_LIMIT = 440;
type PassageBlock = {start:number;end:number;text:string};
/** Keep paragraphs and lists intact. Sentence punctuation is not a context boundary. */
function passageBlocks(text:string):PassageBlock[] {
  const blocks:PassageBlock[]=[];
  for (const match of text.matchAll(/[^\r\n]+(?:\r?\n(?![ \t]*\r?\n)[^\r\n]+)*/g)) {
    let start=match.index!,end=start+match[0].length;
    while(start<end && /\s/.test(text[start]!)) start++;
    while(end>start && /\s/.test(text[end-1]!)) end--;
    // Remove only standalone social sentences, never a greeting containing work or a condition.
    const greeting=/^(?:(?:hi|hello)(?: everyone| all| class)?|dear students|good morning|good afternoon)[.!?](?:[ \t]+|\r?\n|$)/i.exec(text.slice(start,end));
    if(greeting && !usefulWords.test(greeting[0]) && !dependentContext.test(greeting[0])) start+=greeting[0].length;
    const closing=/(?:[ \t]+|\r?\n)(?:(?:thanks|thank you)(?: for your time)?|best|regards)[.!?]?$/i.exec(text.slice(start,end));
    if(closing && !usefulWords.test(closing[0]) && !dependentContext.test(closing[0])) end=start+closing.index;
    if(start<end) blocks.push({start,end,text:text.slice(start,end)});
  }
  return blocks;
}
function coherentPassage(resource:ResourceView,blocks:PassageBlock[],first:number,last=first):DeadlineSpan|null {
  // Blank lines from HTML can separate a rule from its exception, or a heading from its list.
  // Merge those neighbors before applying the display bound; never clip their qualifying text.
  const introduced=blocks.findIndex((block,index)=>index<=first && introducesContinuation(block.text));
  if(introduced>=0) first=introduced;
  const connected=(left:PassageBlock,right:PassageBlock)=>dependentContext.test(left.text) || dependentContext.test(right.text) || introducesContinuation(left.text) || listItem.test(left.text) || listItem.test(right.text);
  while(first>0 && connected(blocks[first-1]!,blocks[first]!)) first--;
  while(last+1<blocks.length && connected(blocks[last]!,blocks[last+1]!)) last++;
  // Plain-text HTML captures do not retain list markers. A colon may introduce several
  // following blocks, so keep that continuation whole rather than guessing its last item.
  if(blocks.slice(first,last+1).some(block=>introducesContinuation(block.text))) last=blocks.length-1;
  const start=blocks[first]!.start,end=blocks[last]!.end,text=resource.text.slice(start,end);
  if(text.length<35 || text.length>PASSAGE_LIMIT || /<\/?(?:p|div|br|li|ul|ol|script|style)\b/i.test(text)) return null;
  return {resourceId:resource.id,contentHash:resource.contentHash,version:resource.version,field:'text',start,end,text};
}
/** Literal bounded context, not a summary. Long or ambiguous context stays in the saved item. */
export function meaningfulPassage(resource:ResourceView): HomePassage|null {
  const blocks=passageBlocks(resource.text);
  const candidates=blocks.map((block,index)=>({block,index})).filter(({block})=>usefulWords.test(block.text) || dependentContext.test(block.text) || !/^(hi\b|hello\b|dear\b|good (morning|afternoon)|thanks\b|thank you\b|best\b|regards\b|https?:)/i.test(block.text));
  const ranked=[...candidates.filter(({block})=>usefulWords.test(block.text)),...candidates.filter(({block})=>!usefulWords.test(block.text))];
  for(const {index} of ranked) {
    const span=coherentPassage(resource,blocks,index);
    if(span) return {resource,span,reason:instructionWords.test(span.text)?'instruction':'information'};
  }
  return null;
}
function changedDatePassage(resource:ResourceView,span:DeadlineSpan):HomePassage|null {
  if(span.field!=='text' || span.version!==resource.version || span.contentHash!==resource.contentHash || !Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start<0 || span.end<=span.start || span.end>resource.text.length || resource.text.slice(span.start,span.end)!==span.text) return null;
  const blocks=passageBlocks(resource.text);
  const first=blocks.findIndex(block=>block.start<=span.start && block.end>span.start);
  const last=blocks.findIndex(block=>block.start<span.end && block.end>=span.end);
  if(first<0 || last<first) return null;
  const context=coherentPassage(resource,blocks,first,last);
  return context ? {resource,span:context,reason:'changed-date'} : null;
}
export function selectHomeEvidence(resources:ResourceView[], snapshot:Pick<Snapshot,'links'|'sources'>, now:string, timeZone:string) {
  const work=homeWork(resources,snapshot.sources,now,timeZone);
  const activeWork = [...work.today,...work.upcoming.flatMap(g=>g.items)];
  const active = new Set(activeWork.map(r=>r.id));
  const prerequisites = activeWork.flatMap(r => { const claim = assignmentPrerequisite(r, resources, snapshot.sources); return claim ? [claim] : []; }).slice(0, 1);
  const messages=resources.filter(r=>r.kind==='message' && r.text).sort((a,b)=>(b.createdAt ?? b.updatedAt ?? '').localeCompare(a.createdAt ?? a.updatedAt ?? '') || a.id.localeCompare(b.id));
  const passages:HomePassage[]=[];
  for (const r of [...resources.filter(r=>active.has(r.id)),...messages]) {
    const change=r.deadline.claims.flatMap(claim=>{
      if(claim.authority!=='explicit_change' || !claim.span) return [];
      const source=resources.find(s=>s.id===claim.span!.resourceId);
      const passage=source && changedDatePassage(source,claim.span);
      return passage ? [passage] : [];
    })[0];
    const candidate=change ?? meaningfulPassage(r);
    if (candidate && !passages.some(p=>p.resource.id===candidate.resource.id || p.span.text===candidate.span.text)) passages.push(candidate);
    if (passages.length===2) break;
  }
  const relevant = [...passages.map(p=>p.resource),...work.today,...work.upcoming.flatMap(g=>g.items)];
  const byId=new Map(resources.map(r=>[r.id,r]));
  const study:Array<{material:ResourceView;context:ResourceView}>=[];
  for (const context of relevant) for (const link of snapshot.links) {
    if(link.status!=='accepted'||link.type!=='specifies'||link.toId!==context.id) continue;
    const material=byId.get(link.fromId);
    if(!material||material.kind!=='material'||!material.text.trim()||material.assignmentGroup||material.module||link.inputHash!==material.contentHash||scopeKey(material,snapshot.sources)!==scopeKey(context,snapshot.sources)) continue;
    if(/^(home|modules|assignments|announcements|syllabus|course overview|grades|pages|files)$/i.test(material.title.trim())) continue;
    // Exact saved link is required, not an arbitrary accepted relation.
    if(!(context.links??[]).some(pointer=>(typeof pointer==='string'?pointer:pointer.url)===material.url)) continue;
    if(!study.some(s=>s.material.id===material.id)) study.push({material,context});
    if(study.length===2) break;
  }
  return {work,passages,prerequisites,study:study.slice(0,2)};
}
