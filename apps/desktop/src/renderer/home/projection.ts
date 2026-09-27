import type { ResourceView, Snapshot, SourceHealth, DeadlineSpan } from '@magic/contracts';
import { localTime, resolveDeadline } from '@magic/domain';
import { projectCourseLabel } from '../../../../../packages/domain/src/course-label';

export const scopeKey = (r: ResourceView, sources: SourceHealth[]) => {
  const source = sources.find(s => s.id === r.sourceId);
  return JSON.stringify([source?.accountScope ?? r.sourceId, r.courseId]);
};
export function providerIdentity(r: ResourceView) {
  if (r.calendar?.assignmentExternalId) return `assignment:${r.calendar.assignmentExternalId}`;
  // Canvas course calendar feeds name assignment entries `event-assignment-<id>` with the provider's own
  // assignment id. Override entries (`event-assignment-override-<id>`) carry another id and stay separate.
  const feedAssignment = r.kind === 'event' ? /^event-assignment-(\d+)$/.exec(r.calendar?.uid ?? '')?.[1] : undefined;
  if (feedAssignment) return `assignment:${feedAssignment}`;
  if (r.kind === 'assignment') {
    const match = /\/courses\/[^/]+\/assignments\/([^/?#]+)/.exec(r.url);
    return `assignment:${match?.[1] ?? r.externalId}`;
  }
  // Only exact provider object URLs, never titles or matching prose.
  if (r.kind === 'message' && /\/discussion_topics\/|\/announcements\//.test(r.url)) return `message:${r.url.split(/[?#]/)[0]}`;
  return `resource:${r.id}`;
}
/** A display projection of already permitted resources. It never widens inclusion. */
export function canonicalHomeResources(resources: ResourceView[], sources: SourceHealth[]): ResourceView[] {
  const groups = new Map<string, ResourceView[]>();
  for (const r of resources.filter(r => !r.deleted)) {
    const key = `${scopeKey(r, sources)}:${providerIdentity(r)}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()].map(group => {
    const ranked = [...group].sort((a,b) => {
      const rank = (r: ResourceView) => r.kind === 'assignment' && sources.find(s => s.id === r.sourceId)?.scope === 'assignments' ? 3 : r.kind === 'assignment' ? 2 : r.calendar ? 0 : 1;
      return rank(b)-rank(a) || b.observedAt.localeCompare(a.observedAt) || a.id.localeCompare(b.id);
    });
    const main = ranked[0]!;
    // Copies without a due claim (calendar entries) only collapse duplicates; they cannot move the deadline.
    const dated = group.filter(r => r === main || r.deadline.claims.some(c => c.kind === 'due'));
    if (dated.length === 1) return main;
    const claims = [...new Map(dated.flatMap(r => r.deadline.claims).map(c => [JSON.stringify(c), c])).values()];
    const unresolved = [...new Map(dated.flatMap(r => r.deadline.unresolved ?? []).map(c => [JSON.stringify(c),c])).values()];
    const contributors = [...new Map(dated.flatMap(r => r.deadlineContributors ?? [{resourceId:r.id,contentHash:r.contentHash}]).map(c=>[c.resourceId,c])).values()];
    return {...main, deadline:resolveDeadline(claims, unresolved), deadlineContributors:contributors};
  });
}
export function homeCourseLabel(r: ResourceView, resources: ResourceView[], sources: SourceHealth[]) {
  const course = resources.find(c => c.kind === 'course' && scopeKey(c,sources) === scopeKey(r,sources));
  const source = course && sources.find(s => s.id === course.sourceId);
  const label = course && source ? projectCourseLabel({resource:course,source}) : null;
  return { title:label?.displayTitle ?? r.courseName, code:label?.displayCode, raw:label?.rawName ?? r.courseName };
}
export function openHomeWork(r: ResourceView) {
  return r.kind === 'assignment' && !r.deleted && !r.completed && !r.submitted && !r.submission?.excused;
}
export type UpcomingGroup = {key:string; category:string|null; day:string; at:string; items:ResourceView[]};
/** A collapsed set hides at least two rows; "+1 more" would cost as much space as the row it hides. */
export const GROUP_MIN = 3;
export function homeWork(resources: ResourceView[], sources: SourceHealth[], now: string, timeZone: string) {
  const today = localTime(now,timeZone).date;
  const dated = resources.filter(r => openHomeWork(r) && r.deadline.planningAt && Number.isFinite(Date.parse(r.deadline.planningAt)))
    .sort((a,b)=>a.deadline.planningAt!.localeCompare(b.deadline.planningAt!) || a.id.localeCompare(b.id));
  const day = (r:ResourceView) => localTime(r.deadline.planningAt!,timeZone).date;
  const groups = new Map<string,UpcomingGroup>();
  for (const r of dated.filter(r=>day(r)>today)) {
    const category = r.assignmentGroupId ? resources.find(c=>c.assignmentGroup && c.externalId===r.assignmentGroupId && scopeKey(c,sources)===scopeKey(r,sources)) : undefined;
    // Same account, course, verified gradebook category and exact due instant. A different time is its own row.
    const key = category ? JSON.stringify([scopeKey(r,sources),r.assignmentGroupId,r.deadline.planningAt]) : `item:${r.id}`;
    const group = groups.get(key) ?? {key,category:category ? category.title : null,day:day(r),at:r.deadline.planningAt!,items:[]};
    group.items.push(r);
    groups.set(key,group);
  }
  const upcoming = [...groups.values()].flatMap(g => g.items.length >= GROUP_MIN ? [g] : g.items.map(r => ({...g,key:`item:${r.id}`,category:null,items:[r]})));
  return {upcoming, today:dated.filter(r=>day(r)===today), earlier:dated.filter(r=>day(r)<today).reverse()};
}
export type HomePassage = {resource:ResourceView; span:DeadlineSpan; reason:'changed-date'|'instruction'|'information'};
/** Literal sentence/paragraph selection. No paraphrased requirements or invented preparation relation. */
export function meaningfulPassage(resource:ResourceView): HomePassage|null {
  const text = resource.text;
  const segments = [...text.matchAll(/[^\n.!?]+(?:[.!?](?=\s|$)|$)/g)].map(match=>({text:match[0].trim(),start:match.index!+match[0].indexOf(match[0].trim())}));
  const useful = segments.filter(s=>s.text.length>=35 && s.text.length<=440 && !/^(hi\b|hello\b|dear\b|good (morning|afternoon)|thanks\b|thank you\b|best\b|regards\b|https?:)/i.test(s.text));
  const chosen = useful.find(s=>/\b(please|must|required|bring|read|review|submit|complete|prepare|extended|moved|changed|cancelled|canceled|available|posted|will meet|office hours)\b/i.test(s.text)) ?? useful[0];
  if (!chosen) return null;
  return {resource,span:{resourceId:resource.id,contentHash:resource.contentHash,version:resource.version,field:'text',start:chosen.start,end:chosen.start+chosen.text.length,text:chosen.text},reason:/\b(must|required|please|bring|read|review|submit|complete|prepare)\b/i.test(chosen.text)?'instruction':'information'};
}
export function selectHomeEvidence(resources:ResourceView[], snapshot:Pick<Snapshot,'links'|'sources'>, now:string, timeZone:string) {
  const work=homeWork(resources,snapshot.sources,now,timeZone);
  const active = new Set([...work.today,...work.upcoming.flatMap(g=>g.items)].map(r=>r.id));
  const messages=resources.filter(r=>r.kind==='message' && r.text).sort((a,b)=>(b.createdAt ?? b.updatedAt ?? '').localeCompare(a.createdAt ?? a.updatedAt ?? '') || a.id.localeCompare(b.id));
  const passages:HomePassage[]=[];
  for (const r of [...resources.filter(r=>active.has(r.id)),...messages]) {
    const change=r.deadline.claims.find(c=>c.authority==='explicit_change' && c.span && resources.some(s=>s.id===c.span!.resourceId && s.contentHash===c.span!.contentHash && s.text.slice(c.span!.start,c.span!.end)===c.span!.text));
    const candidate=change?.span ? {resource:resources.find(s=>s.id===change.span!.resourceId)!,span:change.span,reason:'changed-date' as const} : meaningfulPassage(r);
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
  return {work,passages,study:study.slice(0,2)};
}
