import type { ReactNode } from 'react';
import type { Command, ResourceView, Snapshot } from '@magic/contracts';
import { projectWork } from '@magic/domain';
import { Action, EvidenceLink } from '../../../../packages/ui/src';
import { deadlineReportEvidence } from './PersonalReport';
import { personalReportIssue, personalReportState, personalReportVersion } from '@magic/contracts';
import { StartWork, preparedWorkRevision } from './StartWork';
import { TodayRail } from './TodayRail';
import { Glyph } from './DesktopShell';
import { resourceHref } from './navigation';
export function ObjectLink({ resource, children }: { resource: ResourceView; children?: ReactNode }) {
  return <EvidenceLink source={{ resourceId: resource.id, version: resource.contentHash, href: resourceHref(resource.id), sourceLabel: resource.courseName, capturedAt: resource.observedAt }}>{children ?? resource.title}</EvidenceLink>;
}
export function courseTone(id: string) { return ['rose', 'blue', 'coral'][Array.from(id).reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 3]; }
export function dueLabel(value: string | null) {
  return value ? new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : 'Due date not found';
}
function excerpt(text: string) { const clean = text.replace(/\s+/g, ' ').trim(); return clean.length > 240 ? `${clean.slice(0, clean.lastIndexOf(' ', 237))}…` : clean; }
export function Home({ snapshot, resources, onSelect, onCourses, onSources, onPlan, report }: {
  snapshot: Snapshot; resources: ResourceView[]; onSelect: (id: string) => void; onCourses: () => void; onSources: () => void;
  onPlan: (command: Command) => Promise<unknown>; report?: (resource: ResourceView) => ReactNode;
}) {
  const refreshKey = preparedWorkRevision(snapshot);
  const work = projectWork(resources, new Date().toISOString(), Intl.DateTimeFormat().resolvedOptions().timeZone);
  const upcoming = [...work.overdue, ...work.upcoming].slice(0, 4);
  const conflict = resources.find(r => r.deadline.conflict && !r.completed && !r.submitted);
  const conflictEvidence = conflict && deadlineReportEvidence(conflict, snapshot);
  const conflictHandled = conflictEvidence && personalReportState(snapshot.personalReports, personalReportIssue('deadline-review', conflictEvidence.map(item => item.resourceId)), personalReportVersion(conflictEvidence)).record;
  const next = [...work.dueToday, ...work.upcoming, ...work.overdue].find(r => r.id !== conflict?.id);
  const nextResource = resources.find(r => r.id === next?.id);
  const update = resources.filter(r => r.text && r.id !== next?.id && r.id !== conflict?.id && r.kind === 'message').sort((a,b) => b.observedAt.localeCompare(a.observedAt))[0];
  const study = snapshot.links.filter(link => link.status === 'accepted' && link.type === 'specifies').flatMap(link => {
    const from = resources.find(r => r.id === link.toId), to = resources.find(r => r.id === link.fromId);
    if (!from || !to || !to.text || to.kind === 'assignment') return [];
    return [{ link, from, to }];
  }).filter((item, index, all) => all.findIndex(other => other.to.id === item.to.id) === index).slice(0,2);
  const incomplete = snapshot.sources.some(source => source.status !== 'ok' || !source.complete);
  return <div className="home-layout"><div className="home-reading">
    <section className="home-briefing" aria-labelledby="briefing-title" data-place-anchor="briefing"><h1 id="briefing-title" tabIndex={-1}>Briefing</h1>
      {nextResource && <div className="briefing-passage"><p><ObjectLink resource={nextResource}/> is {next?.dueAt && Date.parse(next.dueAt) < Date.now() ? 'past its saved deadline' : 'coming up'} in {nextResource.courseName}{nextResource.deadline.planningAt ? <> · <strong>{dueLabel(nextResource.deadline.planningAt)}</strong></> : null}. {nextResource.text ? excerpt(nextResource.text) : 'Open the saved requirements and check the original source before beginning.'}</p><div className="briefing-action"><Action data-focus-key={`review-${nextResource.id}`} onClick={() => onSelect(nextResource.id)}>Review requirements <Glyph name="forward"/></Action></div></div>}
      {conflict && <div className="briefing-passage"><p>{conflictHandled ? <>You reported handling the date disagreement for <ObjectLink resource={conflict}/>. Your report is saved for these sources; their dates remain available to inspect.</> : <>The saved dates for <ObjectLink resource={conflict}/> disagree. {conflict.deadline.planningAt && <>Plan for <strong>{dueLabel(conflict.deadline.planningAt)}</strong> until you confirm the date. </>}Review the source evidence before deciding which deadline applies.</>}</p><div className="briefing-action briefing-review"><Action data-focus-key={`review-${conflict.id}`} onClick={() => onSelect(conflict.id)}>Review dates <Glyph name="forward"/></Action>{report?.(conflict)}</div></div>}
      {update && <div className="briefing-passage"><p>In <ObjectLink resource={update}/>, {update.courseName} shares an update: {excerpt(update.text)}</p></div>}
      {!nextResource && !conflict && !update && <p>There isn’t enough saved context for a useful briefing yet. Your coursework is available in Courses; refresh your sources to bring in requirements and materials.</p>}
      <div className="home-provenance"><span>From saved course sources{incomplete ? ' · some coverage is incomplete' : ''}.</span><button onClick={onSources}>Inspect sources <Glyph name="chevron"/></button></div>
    </section>
    <section className="home-upcoming" aria-labelledby="upcoming-title" data-place-anchor="upcoming"><div className="home-section-heading"><h2 id="upcoming-title">Upcoming</h2><button onClick={onCourses}>View all</button></div>
      <div className="home-work-list">{upcoming.map(item => {
        const resource = resources.find(r => r.id === item.id)!;
        return <StartWork key={item.id} resource={resource} refreshKey={refreshKey} compact={{className: `tone-${courseTone(`${resource.sourceId}:${resource.courseId}`)}`, summary: <span className="home-work-summary"><span><span className="home-work-meta">{item.courseName}{item.points !== null && <span>{item.points} pts</span>}</span><span className="home-work-name">{item.title}</span></span><span className="home-work-due"><strong>{Date.parse(item.dueAt) < Date.now() ? 'Past due · ' : ''}{new Intl.DateTimeFormat(undefined,{weekday:'short',month:'short',day:'numeric'}).format(new Date(item.dueAt))}</strong><span>{new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit'}).format(new Date(item.dueAt))}{item.conflict ? ' · dates disagree' : ''}</span></span></span>}}/>;
      })}</div>
      {!upcoming.length && <p className="home-empty">No upcoming dated work in the saved capture. {work.dueToday.length ? 'Today’s deadlines are in the Today panel.' : 'Undated assignments and other materials are in Courses.'} {incomplete ? 'Some sources still need checking.' : ''}</p>}
    </section>
    <section className="home-study" aria-labelledby="study-title" data-place-anchor="study"><h2 id="study-title">Study &amp; Learn</h2><div className="home-study-grid">{study.map(({link,from,to}) => <a className="home-study-action" href={resourceHref(to.id)} key={link.id}><span>{to.courseName}</span><h3>Review {to.title}</h3><p>Linked to {from.title}</p><div><span>Open saved material</span><Glyph name="forward"/></div></a>)}</div>
      {!study.length && <p className="home-empty">No confirmed study materials are linked yet. Open a course item to inspect its related sources before choosing what to review.</p>}
    </section>
  </div><div className="home-today"><div className="home-today-heading"><h2>Today</h2><span>{new Intl.DateTimeFormat(undefined,{weekday:'short',month:'short',day:'numeric'}).format(new Date())}</span></div><TodayRail compactEmpty onInspectSources={onSources} resources={resources} sources={snapshot.sources} plan={snapshot.dayPlan} changes={snapshot.changes} onSelect={onSelect} onPlan={onPlan}/></div></div>;
}
