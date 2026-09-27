import { Fragment, useId, useMemo, type ReactNode } from 'react';
import type { ResourceView, Snapshot } from '@magic/contracts';
import { personalReportIssue, personalReportState, personalReportVersion } from '@magic/contracts';
import { Action, EvidenceLink } from '../../../../../packages/ui/src';
import { EvidenceInfo } from '../../../../../packages/ui/src/evidence-info';
import { InlineEntity, InlineTime, sourceDates, type PresentationLabel } from '../../../../../packages/ui/src/inline-context';
import { MagicGlyph } from '../../../../../packages/ui/src/glyph';
import type { IdentityHue } from '../../../../../packages/ui/src/deadline-emphasis';
import '../../../../../packages/ui/src/deadline-emphasis.css';
import { courseKey, courseKeys } from '../../../../../packages/domain/src/course-page';
import { courseIdentityHues } from '../courses/course-index-view';
import { deadlineReportEvidence, HandledBriefing } from '../PersonalReport';
import { PreparedWork } from '../prepared-work/PreparedWork';
import { Glyph } from '../DesktopShell';
import { resourceHref } from '../navigation';
import { schedulePlanning } from '../schedule-projection';
import { briefExcerpt, calendarLabel, coverageNote, type BriefAction, type BriefItem, type DailyBriefProjection, type StatedRelation } from './brief';
import './brief.css';

export function ObjectLink({ resource, children }: { resource: ResourceView; children?: ReactNode }) {
  return <EvidenceLink source={{ resourceId: resource.id, version: resource.contentHash, href: resourceHref(resource.id), sourceLabel: resource.courseName, capturedAt: resource.observedAt }}>{children ?? resource.title}</EvidenceLink>;
}

/**
 * Brief source link: the same EvidenceLink route, data and accessible name as ObjectLink, with a
 * small north-east arrow as its non-color cue instead of an underline. The arrow is aria-hidden and
 * travels with the last word, so it never starts a line alone.
 */
function SourceLink({ resource, text }: { resource: ResourceView; text: string }) {
  const [head, tail] = arrowTail(text);
  return <ObjectLink resource={resource}>{head}<span className="briefing-link-tail">{tail}<MagicGlyph name="upRight" size={12} className="briefing-link-arrow"/></span></ObjectLink>;
}

/** Splits link text so the arrow keeps the last word. A long final token (a URL or code) keeps only
 * its last character, so the rest can still wrap inside a narrow line instead of overflowing. */
export function arrowTail(text: string): [head: string, tail: string] {
  const trimmed = text.trimEnd();
  const word = /\S+$/.exec(trimmed)?.[0] ?? '';
  const keep = word.length > 0 && word.length <= 18 ? word.length : /[\uDC00-\uDFFF]$/.test(trimmed) ? 2 : 1;
  return [trimmed.slice(0, trimmed.length - keep), trimmed.slice(trimmed.length - keep)];
}

/**
 * Course identity hue, shared with Courses: the key set the Courses work list hashes (admitted
 * courses; without an admission, every captured course as the Courses index does), so one course
 * keeps one hue on both surfaces. Keys are account scope + course id, never a name; a course
 * outside the set renders neutral.
 */
export function briefCourseHues(snapshot: Pick<Snapshot, 'courseWorkAdmission' | 'sources'>, resources: ResourceView[]) {
  const admitted = snapshot.courseWorkAdmission?.courses;
  const hues = courseIdentityHues(admitted ? admitted.map(c => courseKey(c.accountScope, c.courseId)) : courseKeys({ resources, sources: snapshot.sources }));
  const scope = new Map(snapshot.sources.map(s => [s.id, s.accountScope]));
  return (r: Pick<ResourceView, 'sourceId' | 'courseId'>): IdentityHue | 'neutral' => hues.get(courseKey(scope.get(r.sourceId) ?? r.sourceId, r.courseId)) ?? 'neutral';
}

export interface BriefFormat {
  course: (r: ResourceView) => string;
  nameOf: (r: ResourceView) => PresentationLabel;
  day: (value: string, precision?: 'day' | 'minute') => string;
  time: (value: string) => string;
  whenInline: (value: string) => string;
}

/**
 * Daily Brief: connected, source-backed passages with at most one action each. Every action keeps a
 * stable focus key so Back lands on it, states when it can only open a saved copy or a link, and
 * never reports reading, completion or readiness. Empty and partial coverage stay explicit.
 */
export function DailyBrief({ brief, conflict, onReviewDate, snapshot, resources, timeZone, format, prepared, report, reviewDates, onSelect, onOpenSource, onSources, onPastDue }: {
  brief: DailyBriefProjection; conflict: ResourceView | null; onReviewDate: (id: string) => void;
  snapshot: Snapshot; resources: ResourceView[]; timeZone: string; format: BriefFormat;
  prepared: Omit<Parameters<typeof PreparedWork>[0], 'resource' | 'onInspect' | 'action' | 'compact'>;
  report?: (resource: ResourceView, summary?: ReactNode) => ReactNode;
  reviewDates?: (resource: ResourceView) => ReactNode;
  onSelect: (id: string) => void; onOpenSource?: (url: string) => void; onSources: () => void; onPastDue: () => void;
}) {
  const { nameOf, day, time, whenInline } = format;
  const hueOf = useMemo(() => briefCourseHues(snapshot, resources), [snapshot.courseWorkAdmission, snapshot.sources, resources]);
  /** Course code as a filled pill in its identity hue; the text is unchanged, so color is never the only cue. */
  const course = (r: ResourceView, lead = false) => <span className={lead ? 'briefing-course briefing-course--lead' : 'briefing-course'} data-magic-hue={hueOf(r)}>{format.course(r)}</span>;
  const conflictPlanning = conflict && schedulePlanning(conflict, timeZone);
  const chosenDate = conflictPlanning?.personal ? conflict?.personalDeadline?.selected : null;
  // Reporting must use exactly the core's contributor set, not a display-only union.
  const originalConflict = conflict && resources.find(r => r.id === conflict.id);
  const reportable = originalConflict && JSON.stringify(originalConflict.deadlineContributors) === JSON.stringify(conflict?.deadlineContributors);
  const conflictEvidence = reportable && deadlineReportEvidence(originalConflict, snapshot);
  const conflictHandled = conflictEvidence && personalReportState(snapshot.personalReports, personalReportIssue('deadline-review', conflictEvidence.map(item => item.resourceId)), personalReportVersion(conflictEvidence)).record;

  const dueTag = (r: ResourceView, after = '.') => {
    const planning = schedulePlanning(r, timeZone);
    const due = planning && r.kind === 'assignment' && !planning.conflict ? planning.at : null;
    if (!planning || !due) return null;
    // A date-only deadline shows the calendar date schedulePlanning already resolved; a timed one is
    // formatted by Home's formatters, which use the same supplied time zone.
    return <> {planning.personal ? 'has your planning date' : 'is due'} <InlineTime dateTime={due} parts={planning.minute === null ? [calendarLabel(planning.date), 'time not provided'] : [whenInline(due), time(due)]} after={after}/></>;
  };
  /**
   * At most one info control per passage: where its sentence comes from, and any limit on its action
   * that the heading's coverage note does not already state. Every limit is still announced on the
   * action itself (BriefActionControl), so the visible cue stays one per fact, not one per passage.
   */
  const info = (label: string, action: BriefAction | null, provenance?: ReactNode) => {
    const status = action?.status;
    const own = status && (status.state === 'link-only' || (status.state === 'unknown' && brief.coverage.state !== 'none'));
    const note = own ? status.note : null;
    if (!note && !provenance) return null;
    return <> <EvidenceInfo label={label}>{provenance}{provenance && note && ' '}{note}</EvidenceInfo></>;
  };
  const named = (r: ResourceView) => { const label = nameOf(r); return <InlineEntity name={label}><SourceLink resource={r} text={label.label}/></InlineEntity>; };
  const run = (action: BriefAction, url?: string) => () => {
    if (action.kind === 'past-due') onPastDue();
    else if (action.kind === 'open-quiz' && url && onOpenSource) onOpenSource(url);
    else if (action.targetId) onSelect(action.targetId);
  };

  function item(entry: BriefItem) {
    switch (entry.kind) {
      case 'project': {
        const planning = schedulePlanning(entry.resource, timeZone);
        return <div className="briefing-passage" key={entry.id} data-brief-item="project">
          <p>{course(entry.resource, true)} {named(entry.resource)} {planning && !planning.conflict ? <> {planning.personal ? 'has your planning date on' : 'is due'} {new Intl.DateTimeFormat(undefined, { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${planning.date}T12:00:00Z`))}</> : ' is coming up'}. The instructions require a {entry.parts[0]} and a {entry.parts[1]}.{info('About this project', entry.action)}</p>
          <div className="briefing-action"><BriefActionControl action={entry.action} onClick={run(entry.action)}/></div>
        </div>;
      }
      case 'lecture-prep':
        return <div className="briefing-passage" key={entry.id} data-brief-item="lecture-prep">
          <p>Your saved enrollment lists a {entry.classKind} tomorrow for {course(entry.lecture)}. {named(entry.lecture)} says to read <SourceLink resource={entry.material} text={entry.material.title}/> before class.{info('Where this comes from', entry.action, <>From the saved event description: <q data-evidence-version={entry.relation.evidence.contentHash} data-evidence-start={entry.relation.evidence.start} data-evidence-end={entry.relation.evidence.end}>{entry.relation.evidence.text}</q></>)}</p>
          <div className="briefing-action"><BriefActionControl action={entry.action} onClick={run(entry.action)}/></div>
        </div>;
      case 'date-conflict': {
        const r = entry.resource;
        const conflictName = <>{course(r)} {named(r)}</>;
        const dates = sourceDates(r.deadline.claims);
        const sourced = dates.every(d => d.sources.length > 0);
        return <HandledBriefing key={entry.id} handled={Boolean(conflictHandled) && !chosenDate}
          action={<div className="briefing-action briefing-review" onFocusCapture={() => onReviewDate(r.id)}>{reviewDates?.(r) ?? <BriefActionControl action={entry.action} onClick={run(entry.action)}/>}</div>}
          report={!chosenDate && reportable && report?.(originalConflict!, <>Dates for {conflictName}: reported handled.</>)}>
          <p>{chosenDate ? <>Your planning date for {conflictName} is <InlineTime dateTime={chosenDate.value} parts={chosenDate.precision === 'day' && conflictPlanning ? [calendarLabel(conflictPlanning.date, true)] : [day(chosenDate.value), time(chosenDate.value)]} after="."/></>
            : <>Check the due date for {conflictName}{dates.length > 1 ? <>: {sourced ? null : 'saved sources list '}{dates.map((d, i) => <Fragment key={d.value}>{i > 0 && (i === dates.length - 1 ? ' and ' : ', ')}{sourced && <>{d.sources.join(' and ')} {d.sources.length > 1 ? 'say' : 'says'} </>}<InlineTime dateTime={d.value} parts={d.precision === 'day' ? [day(d.value, 'day')] : [day(d.value), time(d.value)]} after={i === dates.length - 1 ? '.' : undefined}/></Fragment>)}</> : <>. Its saved sources disagree.</>}</>}{info('About these dates', entry.action)}</p>
        </HandledBriefing>;
      }
      case 'prerequisite': {
        const { assignment, quiz, reference } = entry.prerequisite;
        const due = !quiz.deadline.conflict ? quiz.deadline.dueAt : null;
        return <div className="briefing-passage" key={entry.id} data-brief-item={entry.kind}>
          <p>{course(assignment, true)} <span title={quiz.title}><SourceLink resource={quiz} text={reference}/></span> comes before the reading and questions in {named(assignment)}.{due && <> The quiz is due <InlineTime dateTime={due} parts={[whenInline(due), time(due)]} after="."/></>}{info('About this quiz', entry.action)}</p>
          <div className="briefing-action"><BriefActionControl action={entry.action} onClick={run(entry.action, quiz.url)}/></div>
        </div>;
      }
      case 'linked-materials': {
        const shown = entry.materials.slice(0, 3), more = entry.materials.length - shown.length;
        const tag = dueTag(entry.context);
        const { relation } = entry;
        return <div className="briefing-passage" key={entry.id} data-brief-item={entry.kind} data-relation={relation.modality}>
          <p>{course(entry.context, true)} {named(entry.context)}{tag ?? '.'} Its instructions say {RELATION_LEAD[relation.modality]} {relation.verb} {shown.map((m, i) => <Fragment key={m.id}>{i > 0 && (i === shown.length - 1 && !more ? ' and ' : ', ')}<SourceLink resource={m} text={m.title}/></Fragment>)}{more > 0 && <> and {more} more</>}.
            {info('Where this comes from', entry.action, <>From the saved instructions: <q data-evidence-start={relation.evidence.start} data-evidence-end={relation.evidence.end} data-evidence-version={relation.evidence.contentHash}>{relation.evidence.text}</q></>)}</p>
          <div className="briefing-action"><BriefActionControl action={entry.action} onClick={run(entry.action)}/></div>
        </div>;
      }
      case 'passage': {
        const p = entry.passage;
        const tag = dueTag(p.resource);
        const excerpt = briefExcerpt(p.span.text);
        const clipped = excerpt !== p.span.text;
        return <div className="briefing-passage" key={entry.id} data-brief-item={entry.kind}>
          <p>{course(p.resource, true)} {named(p.resource)}{tag ?? ':'} <q>{excerpt}</q>{info(clipped ? 'Saved passage and action details' : 'About this action', entry.action?.kind === 'start-work' ? null : entry.action, clipped ? <q data-evidence-version={p.span.contentHash} data-evidence-start={p.span.start} data-evidence-end={p.span.end}>{p.span.text}</q> : undefined)}</p>
          {entry.action?.kind === 'start-work' ? <div className="briefing-action"><PreparedWork openTask={p.resource.kind === "assignment"} resource={p.resource} {...prepared} onInspect={() => onSelect(p.resource.id)} action/></div>
            : entry.action ? <div className="briefing-action"><BriefActionControl action={entry.action} onClick={run(entry.action)}/></div> : null}
        </div>;
      }
      case 'past-due':
        return <div className="briefing-passage briefing-passage--quiet" key={entry.id} data-brief-item={entry.kind}>
          <p>{entry.count === 1 ? '1 earlier deadline is' : `${entry.count} earlier deadlines are`} not shown as submitted in the saved coursework.{info('About past-due work', entry.action)}</p>
          <div className="briefing-action"><BriefActionControl action={entry.action} tone="quiet" onClick={run(entry.action)}/></div>
        </div>;
    }
  }

  const { coverage, fallback } = brief;
  // Incomplete coverage with passages: one info control by the heading, not a closing caveat paragraph.
  // An empty brief states coverage in its fallback sentence instead, with Saved sources beside it.
  const partial = !fallback && coverageNote(coverage);
  return <section className="home-briefing" aria-labelledby="briefing-title" data-place-anchor="briefing">
    <div className="briefing-heading" data-brief-coverage={coverage.state}><h1 id="briefing-title" tabIndex={-1}>Daily Brief</h1>{partial && <EvidenceInfo label="About Daily Brief coverage">{partial}</EvidenceInfo>}</div>
    {brief.items.map(item)}
    {fallback && <><p className="home-empty" data-brief-fallback={coverage.state}>{fallback.text}</p><div className="home-provenance"><button className="magic-fb-pill" onClick={onSources}>Saved sources <Glyph name="chevron"/></button></div></>}
  </section>;
}

/** The stated modality, worded as the source states it; never strengthened. */
const RELATION_LEAD: Record<StatedRelation['modality'], string> = { required: 'you need to', expected: 'you should', optional: 'you can', instruction: 'to' };

/**
 * Shared Action with the brief's semantic status. A limited status is announced with the control
 * through a visually hidden description; the visible detail is the passage's info control, so the
 * action keeps the shared 174px geometry in every state.
 */
export function BriefActionControl({ action, onClick, tone = 'primary' }: { action: BriefAction; onClick: () => void; tone?: 'primary' | 'quiet' }) {
  const noteId = useId();
  const note = action.status.state === 'current' ? null : action.status.note;
  return <>
    <Action tone={tone} data-focus-key={action.focusKey} intent={action.intent ?? undefined} data-action-status={action.status.state} aria-describedby={note ? noteId : undefined} onClick={onClick}>{action.label} <Glyph name="forward"/></Action>
    {note && <span id={noteId} className="briefing-visually-hidden">{note}</span>}
  </>;
}
