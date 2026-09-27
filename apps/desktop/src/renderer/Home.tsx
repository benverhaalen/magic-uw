import { HomeStudyCard, openStudyLearn } from "./study-prep"; // owner: study-prep
import { schedulePlanning, type ScheduleResource, type ScheduleAlias } from './schedule-projection';
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Command, ResourceView, Snapshot } from '@magic/contracts';
import { localTime } from '@magic/domain';
import { courseDeadlineDisplay } from '../../../../packages/domain/src/course-page';
import { createAssignmentTypeHues, deadlineEmphasis, deadlineSurface } from '../../../../packages/ui/src/deadline-emphasis';
import { Action, EvidenceLink } from '../../../../packages/ui/src';
import { InlineEntity, InlineTime, presentationLabel, presentationLabels, sourceDates } from '../../../../packages/ui/src/inline-context';
import { deadlineReportEvidence, HandledBriefing } from './PersonalReport';
import './PersonalReport.css';
import { personalReportIssue, personalReportState, personalReportVersion } from '@magic/contracts';
import { preparedWorkRevision } from './StartWork';
import { PreparedWork } from './prepared-work/PreparedWork';
import { EvidenceInfo } from '../../../../packages/ui/src/evidence-info';
import { reportWorkspaceFailure } from './workspace-feedback';
import { TodayRail } from './TodayRail';
import { Glyph } from './DesktopShell';
import { resourceHref } from './navigation';
import { canonicalHomeResources, homeCourseLabel, selectHomeEvidence, type UpcomingGroup } from './home/projection';
import './home/Home.css';
import { HomeMotion } from './home/HomeMotion';
import { homeEnrollmentHolds } from './home/enrollment-holds';
export function ObjectLink({ resource, children }: { resource: ResourceView; children?: ReactNode }) {
  return <EvidenceLink source={{ resourceId: resource.id, version: resource.contentHash, href: resourceHref(resource.id), sourceLabel: resource.courseName, capturedAt: resource.observedAt }}>{children ?? resource.title}</EvidenceLink>;
}
export function dueLabel(value: string | null) {
  return value ? new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : 'Due date not found';
}
/** Rows shown before Upcoming's disclosure; later work stays one click away. */
const UPCOMING_BATCH = 3;
export function Home({ snapshot, resources, onSelect, onCourses, onSources, onMyUw, onPlan, onJoin, onOpenSource, upcomingCount = UPCOMING_BATCH, onUpcomingCountChange, todayCount = 3, onTodayCountChange, report, reviewDates, onSetup, onNotice }: {
  onOpenSource?: (url:string)=>void;
  reviewDates?: (resource: ResourceView) => ReactNode;
  onSetup?: () => void; onNotice?: (text: string) => void;
  todayCount?: number; onTodayCountChange?: (count: number) => void;
  upcomingCount?: number; onUpcomingCountChange?: (count: number) => void;
  snapshot: Snapshot; resources: ResourceView[]; onSelect: (id: string) => void; onCourses: () => void; onSources: () => void;
  onMyUw: (target: 'attention' | 'term') => void;
  onPlan: (command: Command) => Promise<unknown>; onJoin?: (url: string) => void; report?: (resource: ResourceView, summary?: ReactNode) => ReactNode;
}) {
  const [now,setNow]=useState(()=>new Date().toISOString());
  useEffect(()=>{const timer=window.setInterval(()=>setNow(new Date().toISOString()),30_000);return ()=>window.clearInterval(timer);},[]);
  const timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  const canonical=useMemo(()=>canonicalHomeResources(resources,snapshot.sources,snapshot.links,snapshot.courseWorkAdmission?.aliases),[resources,snapshot.sources,snapshot.links,snapshot.courseWorkAdmission?.aliases]);
  const {work,passages,study,prerequisites}=useMemo(()=>selectHomeEvidence(canonical,snapshot,now,timeZone),[canonical,snapshot,now,timeZone]);
  const enrollmentHolds=useMemo(()=>homeEnrollmentHolds(snapshot,Date.parse(now)),[snapshot,now]);
  const refreshKey = preparedWorkRevision(snapshot);
  const prepared = { refreshKey, info: EvidenceInfo, onSetup, onNotice, onFailure: reportWorkspaceFailure };
  const typeHueOf=useMemo(()=>createAssignmentTypeHues(snapshot.resources,snapshot.sources),[snapshot.resources,snapshot.sources]);
  const label=(r:ResourceView)=>homeCourseLabel(r,canonical,snapshot.sources);
  const course=(r:ResourceView)=>label(r).code ?? label(r).title;
  const names=useMemo(()=>{
    const projected=presentationLabels(canonical.map(r=>r.title),canonical.map(r=>{const c=homeCourseLabel(r,canonical,snapshot.sources);return {shownPrefixes:[c.code ?? c.title]};}));
    return new Map(canonical.map((r,i)=>[r.id,projected[i]!]));
  },[canonical,snapshot.sources]);
  const nameOf=(r:ResourceView)=>names.get(r.id) ?? presentationLabel(r.title,{shownPrefixes:[course(r)]});
  const [reviewedDateId,setReviewedDateId]=useState<string|null>(null);
  const conflict = canonical.find(r=>r.id===reviewedDateId && (schedulePlanning(r,timeZone)?.conflict || schedulePlanning(r,timeZone)?.personal)) ?? canonical.find(r => schedulePlanning(r,timeZone)?.conflict && !r.completed && !r.submitted) ?? canonical.find(r=>schedulePlanning(r,timeZone)?.personal);
  const chosenDate=conflict && schedulePlanning(conflict,timeZone)?.personal ? conflict.personalDeadline?.selected : null;
  // Reporting must use exactly the core's contributor set, not a display-only union.
  const originalConflict=conflict && resources.find(r=>r.id===conflict.id);
  const reportable=originalConflict && JSON.stringify(originalConflict.deadlineContributors)===JSON.stringify(conflict?.deadlineContributors);
  const conflictEvidence = reportable && deadlineReportEvidence(originalConflict, snapshot);
  const conflictHandled = conflictEvidence && personalReportState(snapshot.personalReports, personalReportIssue('deadline-review', conflictEvidence.map(item => item.resourceId)), personalReportVersion(conflictEvidence)).record;
  const day=(value:string,precision?:'day'|'minute')=>new Intl.DateTimeFormat(undefined,{weekday:'short',month:'short',day:'numeric',...(precision==='day'?{timeZone:'America/Chicago'}:{})}).format(new Date(value));
  const time=(value:string)=>new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit'}).format(new Date(value));
  const today=localTime(now,timeZone).date;
  const tomorrow=localTime(new Date(Date.parse(`${today}T12:00:00Z`)+86_400_000).toISOString(),'UTC').date;
  const when=(value:string)=>{const date=localTime(value,timeZone).date;return date===today?'Today':date===tomorrow?'Tomorrow':day(value);};
  const whenInline=(value:string)=>{const label=when(value);return label==='Today'||label==='Tomorrow'?label.toLowerCase():label;};
  const shown=work.upcoming.slice(0,upcomingCount);
  const remaining=Math.max(0,work.upcoming.length-upcomingCount);
  // One visible launch per assignment: a briefing action only where no Upcoming row already offers it.
  const launchable=new Set(shown.map(g=>g.items[0]!.id));
  function workRow(resource:ResourceView) {
    const planning=schedulePlanning(resource,timeZone)!;
    const due=planning.at;
    const deadline={conflict:planning.conflict,cue:planning.conflict?'Dates disagree':null};
    const dayLabel=planning.minute===null ? new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',timeZone:'America/Chicago'}).format(new Date(due)) : when(due);
    const timeLabel=planning.minute===null ? 'Time not provided' : time(due);
    if ((resource as ScheduleResource).scheduleDeadline?.sourceOnly) return <div key={resource.id} className="magic-start-work magic-start-work--compact"><div className="home-work-card home-work-typed home-work-typed--source" {...deadlineSurface(deadlineEmphasis({today,due:deadline.conflict?null:planning.date}).bin,typeHueOf(resource)?.hue??null)}><button className="home-work-row" data-focus-key={`inspect-work-${resource.id}`} title="Open the saved deadline source" onClick={()=>onSelect(resource.id)}><span className="home-work-summary"><span className="home-work-identity"><span className="home-work-meta">{course(resource)} · {(resource as ScheduleResource).scheduleDeadline?.sourceLabel ?? 'Saved source'}</span><span className="home-work-name">{nameOf(resource).label}</span></span><span className="home-work-due"><strong>{deadline.cue ?? dayLabel}</strong><span>{deadline.conflict?'Review dates':timeLabel}</span></span><Glyph name="chevron"/></span></button></div></div>;
    return <PreparedWork key={resource.id} resource={resource} {...prepared} openTask={resource.kind === "assignment"} onInspect={() => onSelect(resource.id)} compact={{
      className:'home-work-typed',
      surface:deadlineSurface(deadlineEmphasis({today,due:deadline.conflict?null:planning.date}).bin,typeHueOf(resource)?.hue??null),
      description:deadline.conflict ? `${course(resource)}, saved dates disagree. Review dates.` : `${course(resource)}, ${planning.personal?"your planning date":"due"} ${dayLabel} ${timeLabel}`,
      summary:<span className="home-work-summary">
        <span className="home-work-identity"><span className="home-work-meta" title={label(resource).raw}>{course(resource)}{typeHueOf(resource) && <span>{typeHueOf(resource)!.groupName}</span>}{resource.points!=null && <span>{resource.points} pts</span>}</span><span className="home-work-name" title={resource.title}>{nameOf(resource).label}</span></span>
        <span className="home-work-due"><strong>{deadline.cue ?? dayLabel}</strong><span>{deadline.conflict ? "Review dates" : planning.personal ? `Your date · ${timeLabel}` : timeLabel}</span></span>
      </span>,
      trailing:<a className="home-work-details" href={resourceHref(resource.id)} data-focus-key={`inspect-work-${resource.id}`} aria-label={`Details: ${resource.title}`} title="Details"><Glyph name="chevron"/></a>,
    }}/>;
  }
  const group=(g:UpcomingGroup)=>g.items.length===1 ? workRow(g.items[0]!) : <div className="home-work-group" key={g.key}>{workRow(g.items[0]!)}
    <details className="home-group-more" data-place-disclosure={`upcoming-${g.key}`}><summary className="magic-fb-pill" data-focus-key={`group-${g.key}`}><Glyph name="chevron"/>{g.items.length-1} more {g.category}, also due {whenInline(g.at)} {time(g.at)}</summary><div className="home-work-list">{g.items.slice(1).map(workRow)}</div></details></div>;
  function showNext(event: React.MouseEvent<HTMLButtonElement>) {
    const pane=event.currentTarget.closest('.desktop-workspace') as HTMLElement | null;
    const scroll=pane?.scrollTop ?? 0;
    const next=Math.min(work.upcoming.length,upcomingCount+UPCOMING_BATCH);
    onUpcomingCountChange?.(next);
    requestAnimationFrame(()=>{
      if(pane) pane.scrollTop=scroll;
      if(next===work.upcoming.length) pane?.querySelector<HTMLElement>('[data-focus-key="upcoming-less"]')?.focus({preventScroll:true});
    });
  }
  // Conflict copy: literal concise name after the shown course; only dates a source states, each with its source when known.
  const conflictLabel=conflict && nameOf(conflict);
  const conflictName=conflict && conflictLabel && <>{course(conflict)} <InlineEntity name={conflictLabel}><ObjectLink resource={conflict}>{conflictLabel.label}</ObjectLink></InlineEntity></>;
  const conflictDates=conflict ? sourceDates(conflict.deadline.claims) : [];
  const conflictSourced=conflictDates.every(d=>d.sources.length>0);
  return <div className="home-layout"><HomeMotion>
    <section className="home-briefing" aria-labelledby="briefing-title" data-place-anchor="briefing"><h1 id="briefing-title" tabIndex={-1}>Daily Brief</h1>
      {conflict && <HandledBriefing handled={Boolean(conflictHandled) && !chosenDate} action={<div className="briefing-action briefing-review" onFocusCapture={()=>setReviewedDateId(conflict.id)}>{reviewDates?.(conflict) ?? <Action intent="review" data-focus-key={`review-${conflict.id}`} onClick={() => onSelect(conflict.id)}>Review dates <Glyph name="forward"/></Action>}</div>} report={!chosenDate && reportable && report?.(originalConflict!, <>Dates for {conflictName}: reported handled.</>)}><p>{chosenDate ? <>Your planning date for {conflictName} is <InlineTime dateTime={chosenDate.value} parts={chosenDate.precision==='day'?[day(chosenDate.value,'day')]:[day(chosenDate.value),time(chosenDate.value)]} after="."/></> : <>Check the due date for {conflictName}{conflictDates.length > 1 ? <>: {conflictSourced ? null : 'saved sources list '}{conflictDates.map((d, i) => <Fragment key={d.value}>{i > 0 && (i === conflictDates.length - 1 ? ' and ' : ', ')}{conflictSourced && <>{d.sources.join(' and ')} {d.sources.length > 1 ? 'say' : 'says'} </>}<InlineTime dateTime={d.value} parts={d.precision === 'day' ? [day(d.value,'day')] : [day(d.value), time(d.value)]} after={i === conflictDates.length - 1 ? '.' : undefined}/></Fragment>)}</> : <>. Its saved sources disagree.</>}</>}</p></HandledBriefing>}
      {prerequisites.map(item => {
        const assignmentName=nameOf(item.assignment);
        const due=!item.quiz.deadline.conflict ? item.quiz.deadline.dueAt : null;
        return <div className="briefing-passage" key={`prerequisite-${item.assignment.id}-${item.quiz.id}`}>
          <p>{course(item.assignment)} <span title={item.quiz.title}><ObjectLink resource={item.quiz}>{item.reference}</ObjectLink></span> comes before the reading and questions in <InlineEntity name={assignmentName}><ObjectLink resource={item.assignment}>{assignmentName.label}</ObjectLink></InlineEntity>.{due && <> The quiz is due <InlineTime dateTime={due} parts={[whenInline(due), time(due)]} after="."/></>}</p>
          <div className="briefing-action"><Action intent={onOpenSource ? 'coursework' : 'review'} data-focus-key={`prerequisite-${item.quiz.id}`} onClick={()=>onOpenSource ? onOpenSource(item.quiz.url) : onSelect(item.quiz.id)}>{onOpenSource ? 'Open quiz' : 'Review quiz'} <Glyph name="forward"/></Action></div>
        </div>;
      })}
      {passages.filter(p=>p.resource.id!==conflict?.id && !prerequisites.some(item=>item.assignment.id===p.resource.id)).slice(0,Math.max(0,2-(conflict?1:0)-prerequisites.length)).map(p=>{
        const passagePlanning=schedulePlanning(p.resource,timeZone);
        const due=p.resource.kind==='assignment' && !passagePlanning?.conflict ? passagePlanning?.at : null;
        const launch=p.reason!=='changed-date' && p.resource.kind==='assignment' && !launchable.has(p.resource.id) && work.today.concat(work.upcoming.flatMap(g=>g.items)).some(r=>r.id===p.resource.id);
        const name=nameOf(p.resource);
        return <div className="briefing-passage" key={`${p.resource.id}:${p.span.start}`}><p>{course(p.resource)} <InlineEntity name={name}><ObjectLink resource={p.resource}>{name.label}</ObjectLink></InlineEntity>{due ? <> {passagePlanning?.personal ? "has your planning date" : "is due"} <InlineTime dateTime={due} parts={passagePlanning?.minute===null?[new Intl.DateTimeFormat(undefined,{month:"short",day:"numeric",timeZone:"America/Chicago"}).format(new Date(due)),"time not provided"]:[whenInline(due), time(due)]} after="."/></> : ':'} <q>{p.span.text}</q></p>
          {p.reason==='changed-date' ? <div className="briefing-action"><Action intent="review" data-focus-key={`briefing-${p.resource.id}`} onClick={()=>onSelect(p.resource.id)}>Review change <Glyph name="forward"/></Action></div>
            : launch ? <div className="briefing-action"><PreparedWork resource={p.resource} {...prepared} onInspect={() => onSelect(p.resource.id)} action/></div> : null}</div>;
      })}
      {!conflict && !passages.length && !prerequisites.length && !prerequisites.length && <><p className="home-empty">Full instructions are available in your saved coursework.</p><div className="home-provenance"><button className="magic-fb-pill" onClick={onSources}>Saved sources <Glyph name="chevron"/></button></div></>}
    </section>
    <section className="home-upcoming" aria-labelledby="upcoming-title" data-place-anchor="upcoming"><div className="home-section-heading"><h2 id="upcoming-title">Upcoming</h2><button className="magic-fb-pill" data-focus-key="all-coursework" onClick={onCourses}>All coursework</button></div>
      <div className="home-work-list">{shown.map(group)}</div>
      {!work.upcoming.length && <p className="home-empty">No future dated work in this saved capture.{work.today.length?' Today’s deadlines are in Today.':''}</p>}
      {remaining>0 && <button className="home-show-next magic-fb-pill" data-focus-key="upcoming-next" onClick={showNext}>Show next {Math.min(UPCOMING_BATCH,remaining)}</button>}
      {upcomingCount>UPCOMING_BATCH && <button className="home-show-next magic-fb-pill" data-focus-key="upcoming-less" onClick={()=>{onUpcomingCountChange?.(UPCOMING_BATCH);requestAnimationFrame(()=>{const button=document.querySelector<HTMLElement>('[data-focus-key="upcoming-next"]');button?.focus({preventScroll:true});button?.scrollIntoView({block:"nearest"});});}}>Show less</button>}
    </section>
    <section className="home-study" aria-labelledby="study-title" data-place-anchor="study"><h2 id="study-title">Study &amp; Learn</h2><HomeStudyCard onSeeAll={openStudyLearn}/>{/* owner: study-prep */}<div className="home-study-grid">{study.map(({material,context})=><a className="home-study-action" href={resourceHref(material.id)} data-focus-key={`study-${material.id}`} key={material.id}><span title={label(material).raw}>{course(material)}</span><h3>Review {material.title}</h3><p>Referenced in {context.title}</p><div><span>Open saved material</span><Glyph name="forward"/></div></a>)}</div>
      {!study.length && <p className="home-empty">No specific review material is supported by the current saved instructions.</p>}
    </section>
    <section className="home-enrollment-holds" aria-labelledby="home-enrollment-holds-title" data-place-anchor="enrollment-holds">
      <h2 id="home-enrollment-holds-title">Enrollment &amp; holds</h2>
      <div className="home-enrollment-holds-row"><p>{enrollmentHolds.enrollment}</p><button type="button" className="magic-fb-pill" onClick={()=>onMyUw('term')}>View enrollment <Glyph name="forward"/></button></div>
      <div className="home-enrollment-holds-row"><p>{enrollmentHolds.holds}{enrollmentHolds.holdTitle ? <> <span className="home-enrollment-holds-detail">{enrollmentHolds.holdTitle}{enrollmentHolds.holdCount > 1 ? ' and others' : ''}.</span></> : null}</p><button type="button" className="magic-fb-pill" onClick={()=>onMyUw('attention')}>Review holds <Glyph name="forward"/></button></div>
    </section>
  </HomeMotion><div className="home-today"><div className="home-today-heading"><h2>Today</h2><span>{day(now)}</span></div><TodayRail homeDueCount={todayCount} onHomeDueCountChange={onTodayCountChange} now={now} homeDueItems={work.today} courseLabel={course} compactEmpty onInspectSources={onSources} resources={canonical} sources={snapshot.sources} plan={snapshot.dayPlan} changes={snapshot.changes} onSelect={onSelect} onPlan={onPlan} onJoin={onJoin}/></div></div>;
}
