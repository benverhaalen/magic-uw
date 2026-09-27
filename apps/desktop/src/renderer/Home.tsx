import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Command, ResourceView, Snapshot } from '@magic/contracts';
import { localTime } from '@magic/domain';
import { Action, EvidenceLink } from '../../../../packages/ui/src';
import { deadlineReportEvidence } from './PersonalReport';
import { personalReportIssue, personalReportState, personalReportVersion } from '@magic/contracts';
import { StartWork, preparedWorkRevision } from './StartWork';
import { TodayRail } from './TodayRail';
import { Glyph } from './DesktopShell';
import { resourceHref } from './navigation';
import { canonicalHomeResources, homeCourseLabel, scopeKey, selectHomeEvidence, type UpcomingGroup } from './home/projection';
import './home/Home.css';
export function ObjectLink({ resource, children }: { resource: ResourceView; children?: ReactNode }) {
  return <EvidenceLink source={{ resourceId: resource.id, version: resource.contentHash, href: resourceHref(resource.id), sourceLabel: resource.courseName, capturedAt: resource.observedAt }}>{children ?? resource.title}</EvidenceLink>;
}
export function courseTone(id: string) { return ['rose', 'blue', 'coral'][Array.from(id).reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 3]; }
export function dueLabel(value: string | null) {
  return value ? new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : 'Due date not found';
}
/** Rows shown before Upcoming's disclosure; later work stays one click away. */
const UPCOMING_BATCH = 3;
export function Home({ snapshot, resources, onSelect, onCourses, onSources, onPlan, onJoin, upcomingCount = UPCOMING_BATCH, onUpcomingCountChange, report }: {
  upcomingCount?: number; onUpcomingCountChange?: (count: number) => void;
  snapshot: Snapshot; resources: ResourceView[]; onSelect: (id: string) => void; onCourses: () => void; onSources: () => void;
  onPlan: (command: Command) => Promise<unknown>; onJoin?: (url: string) => void; report?: (resource: ResourceView) => ReactNode;
}) {
  const [now,setNow]=useState(()=>new Date().toISOString());
  useEffect(()=>{const timer=window.setInterval(()=>setNow(new Date().toISOString()),30_000);return ()=>window.clearInterval(timer);},[]);
  const timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  const canonical=useMemo(()=>canonicalHomeResources(resources,snapshot.sources),[resources,snapshot.sources]);
  const {work,passages,study}=useMemo(()=>selectHomeEvidence(canonical,snapshot,now,timeZone),[canonical,snapshot,now,timeZone]);
  const refreshKey = preparedWorkRevision(snapshot);
  const label=(r:ResourceView)=>homeCourseLabel(r,canonical,snapshot.sources);
  const course=(r:ResourceView)=>label(r).code ?? label(r).title;
  const conflict = canonical.find(r => r.deadline.conflict && !r.completed && !r.submitted);
  // Reporting must use exactly the core's contributor set, not a display-only union.
  const originalConflict=conflict && resources.find(r=>r.id===conflict.id);
  const reportable=originalConflict && JSON.stringify(originalConflict.deadlineContributors)===JSON.stringify(conflict?.deadlineContributors);
  const conflictEvidence = reportable && deadlineReportEvidence(originalConflict, snapshot);
  const conflictHandled = conflictEvidence && personalReportState(snapshot.personalReports, personalReportIssue('deadline-review', conflictEvidence.map(item => item.resourceId)), personalReportVersion(conflictEvidence)).record;
  const day=(value:string)=>new Intl.DateTimeFormat(undefined,{weekday:'short',month:'short',day:'numeric'}).format(new Date(value));
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
    const due=resource.deadline.planningAt!;
    return <StartWork key={resource.id} resource={resource} refreshKey={refreshKey} compact={{
      className:`tone-${courseTone(scopeKey(resource,snapshot.sources))}`,
      description:`${course(resource)}, due ${when(due)} ${time(due)}${resource.deadline.conflict?', saved dates disagree':''}`,
      summary:<span className="home-work-summary">
        <span className="home-work-identity"><span className="home-work-meta" title={label(resource).raw}>{course(resource)}{resource.points!=null && <span>{resource.points} pts</span>}</span><span className="home-work-name" title={resource.title}>{resource.title}</span></span>
        <span className="home-work-due"><strong>{when(due)}</strong><span>{time(due)}</span>{resource.deadline.conflict && <span className="home-work-flag">Dates disagree</span>}</span>
      </span>,
      trailing:<a className="home-work-details" href={resourceHref(resource.id)} data-focus-key={`inspect-work-${resource.id}`} aria-label={`Details: ${resource.title}`} title="Details"><Glyph name="chevron"/></a>,
    }}/>;
  }
  const group=(g:UpcomingGroup)=>g.items.length===1 ? workRow(g.items[0]!) : <div className="home-work-group" key={g.key}>{workRow(g.items[0]!)}
    <details className="home-group-more" data-place-disclosure={`upcoming-${g.key}`}><summary data-focus-key={`group-${g.key}`}><Glyph name="chevron"/>{g.items.length-1} more {g.category}, also due {whenInline(g.at)} {time(g.at)}</summary><div className="home-work-list">{g.items.slice(1).map(workRow)}</div></details></div>;
  function showNext(event: React.MouseEvent<HTMLButtonElement>) {
    const pane=event.currentTarget.closest('.desktop-workspace') as HTMLElement | null;
    const scroll=pane?.scrollTop ?? 0;
    const next=Math.min(work.upcoming.length,upcomingCount+UPCOMING_BATCH);
    onUpcomingCountChange?.(next);
    requestAnimationFrame(()=>{
      if(pane) pane.scrollTop=scroll;
      if(next===work.upcoming.length) pane?.querySelector<HTMLElement>('.home-upcoming .magic-start-work:last-child .home-work-details')?.focus({preventScroll:true});
    });
  }
  return <div className="home-layout"><div className="home-reading">
    <section className="home-briefing" aria-labelledby="briefing-title" data-place-anchor="briefing"><h1 id="briefing-title" tabIndex={-1}>Briefing</h1>
      {conflict && <div className="briefing-passage"><p>{conflictHandled ? <>You reported handling the date disagreement for <ObjectLink resource={conflict}/>. The saved dates are still available to inspect.</> : <>The saved dates for <ObjectLink resource={conflict}/> disagree. {conflict.deadline.planningAt && <>Plan for <strong>{dueLabel(conflict.deadline.planningAt)}</strong> until you confirm the date.</>}</>}</p><div className="briefing-action briefing-review"><Action data-focus-key={`review-${conflict.id}`} onClick={() => onSelect(conflict.id)}>Review dates <Glyph name="forward"/></Action>{reportable && report?.(originalConflict!)}</div></div>}
      {passages.filter(p=>p.resource.id!==conflict?.id).slice(0,conflict?1:2).map(p=>{
        const due=p.resource.kind==='assignment' ? p.resource.deadline.planningAt : null;
        const launch=p.reason!=='changed-date' && p.resource.kind==='assignment' && !launchable.has(p.resource.id) && work.today.concat(work.upcoming.flatMap(g=>g.items)).some(r=>r.id===p.resource.id);
        return <div className="briefing-passage" key={`${p.resource.id}:${p.span.start}`}><p><span className="briefing-context">{course(p.resource)} · <ObjectLink resource={p.resource}/>{due && <> · due {whenInline(due)} {time(due)}</>}</span><q>{p.span.text}</q></p>
          {p.reason==='changed-date' ? <div className="briefing-action"><Action data-focus-key={`briefing-${p.resource.id}`} onClick={()=>onSelect(p.resource.id)}>Review change <Glyph name="forward"/></Action></div>
            : launch ? <div className="briefing-action"><StartWork resource={p.resource} refreshKey={refreshKey} action/></div> : null}</div>;
      })}
      {!conflict && !passages.length && <><p className="home-empty">No new source-backed instructions to highlight. Your saved work and materials are below.</p><div className="home-provenance"><button onClick={onSources}>Saved sources <Glyph name="chevron"/></button></div></>}
    </section>
    <section className="home-upcoming" aria-labelledby="upcoming-title" data-place-anchor="upcoming"><div className="home-section-heading"><h2 id="upcoming-title">Upcoming</h2><button onClick={onCourses}>All coursework</button></div>
      <div className="home-work-list">{shown.map(group)}</div>
      {!work.upcoming.length && <p className="home-empty">No future dated work in this saved capture.{work.today.length?' Today’s deadlines are in Today.':''}</p>}
      {remaining>0 && <button className="home-show-next" data-focus-key="upcoming-next" onClick={showNext}>Show next {Math.min(UPCOMING_BATCH,remaining)}</button>}
    </section>
    <section className="home-study" aria-labelledby="study-title" data-place-anchor="study"><h2 id="study-title">Study &amp; Learn</h2><div className="home-study-grid">{study.map(({material,context})=><a className="home-study-action" href={resourceHref(material.id)} data-focus-key={`study-${material.id}`} key={material.id}><span title={label(material).raw}>{course(material)}</span><h3>Review {material.title}</h3><p>Referenced in {context.title}</p><div><span>Open saved material</span><Glyph name="forward"/></div></a>)}</div>
      {!study.length && <p className="home-empty">No specific review material is supported by the current saved instructions.</p>}
    </section>
  </div><div className="home-today"><div className="home-today-heading"><h2>Today</h2><span>{day(now)}</span></div><TodayRail now={now} homeDueItems={work.today} courseLabel={course} compactEmpty onInspectSources={onSources} resources={canonical} sources={snapshot.sources} plan={snapshot.dayPlan} changes={snapshot.changes} onSelect={onSelect} onPlan={onPlan} onJoin={onJoin}/></div></div>;
}
