import type { ReactNode } from 'react';
import type { ResourceView, Snapshot, SourceHealth } from '@magic/contracts';
import { Action, Disclosure } from '../../../../packages/ui/src';
import { EvidenceInfo } from '../../../../packages/ui/src/evidence-info';
import { InlineTime, presentationLabel } from '../../../../packages/ui/src/inline-context';
import { projectCourseLabel } from '../../../../packages/domain/src/course-label';
import { Glyph } from './DesktopShell';
import type { DeadlineReviewResource } from './DeadlineReview';
import { SHOW_DATE_CONFLICT_UI } from './date-conflict-policy';
import './resource-detail-header.css';

const sourceStates: Record<SourceHealth['status'], string> = {
  ok: 'Checked', partial: 'Partial capture', needs_sign_in: 'Sign in needed',
  error: 'Could not refresh', inaccessible: 'Access restricted',
  not_published: 'Not published', needs_attention: 'Needs review',
};
const materialFormats: Record<string, string> = { SubHeader: 'Module heading', Page: 'Course page', ExternalUrl: 'Web link', ExternalTool: 'Course tool', File: 'File', Assignment: 'Assignment', Discussion: 'Discussion', Quiz: 'Quiz' };
const dateText = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown date' : new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(date);
};

/** Display facts only. Resource identity, dates and source evidence are never rewritten. */
export function resourceDetailPresentation(resource: ResourceView, snapshot: Snapshot) {
  const source = snapshot.sources.find(s => s.id === resource.sourceId);
  const course = source && snapshot.resources.find(r => r.kind === 'course' && r.courseId === resource.courseId &&
    snapshot.sources.some(s => s.id === r.sourceId && s.accountScope === source.accountScope));
  const courseSource = course && snapshot.sources.find(s => s.id === course.sourceId);
  const label = course && courseSource ? projectCourseLabel({ resource: course, source: courseSource }) : null;
  const courseName = label?.displayTitle ?? resource.courseName;
  const courseCode = label?.displayCode;
  const title = presentationLabel(resource.title, { shownPrefixes: [courseName, ...(courseCode ? [courseCode] : [])] });
  const freshness = !source ? 'Source unavailable' : source.status === 'partial' || !source.complete ? 'Partial capture'
    : source.status === 'needs_sign_in' || source.status === 'error' ? 'May have changed'
    : source.status === 'ok' ? null : sourceStates[source.status];
  const planning = (resource as DeadlineReviewResource).personalDeadline;
  const selected = planning?.needsReview ? null : planning?.selected;
  const action = resource.kind === 'assignment' ? 'Open assignment' : resource.kind === 'material' ? 'Open material' : 'Open original';
  const showDeadline = resource.kind === 'assignment' || resource.deadline.conflict || Boolean(resource.deadline.dueAt);
  const status = resource.submitted === true ? 'Submitted · reported by source' : resource.completed ? 'Marked complete locally'
    : resource.submitted === false ? 'Not submitted · reported by source' : 'Submission status unknown';
  return { source, courseName, courseCode, title, freshness, action, showDeadline, status, selected };
}

export function ResourceDetailHeader({ resource, snapshot, open, changedWhileReading, deadlineReview }: {
  resource: ResourceView; snapshot: Snapshot; open: (url: string) => void; changedWhileReading: boolean; deadlineReview?: ReactNode;
}) {
  const view = resourceDetailPresentation(resource, snapshot);
  return <header className="resource-heading">
    <p className="resource-heading__course">{view.courseCode && <span>{view.courseCode} · </span>}{view.courseName}</p>
    <p className="resource-heading__kind">{resource.kindLabel ?? resource.kind}</p>
    <div className="resource-heading__title-row">
      <h2 tabIndex={-1} data-label-rule={view.title.rule}>{view.title.label}</h2>
      {resource.kind !== 'assignment' && <Action onClick={() => open(resource.url)}>{view.action} <Glyph name="external" /></Action>}
    </div>
    <div className="resource-heading__meta">
    <dl className="resource-heading__facts">
      {view.showDeadline && <div><dt>{view.selected ? 'Your planning date' : resource.deadline.conflict && !SHOW_DATE_CONFLICT_UI ? 'Planning date' : resource.kind === 'event' ? 'When' : 'Due'}</dt><dd>
        {view.selected ? <><InlineTime dateTime={view.selected.value} parts={[view.selected.precision === 'day'
          ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' }).format(new Date(view.selected.value))
          : dateText(view.selected.value)]} />{SHOW_DATE_CONFLICT_UI && resource.deadline.conflict && <small className="resource-heading__source-conflict">Source dates disagree</small>}</> : resource.deadline.conflict ? SHOW_DATE_CONFLICT_UI ? <strong className="attention-text">Dates disagree</strong> : resource.deadline.planningAt ? <InlineTime dateTime={resource.deadline.planningAt} parts={[dateText(resource.deadline.planningAt)]}/> : 'Planning date unavailable' : resource.deadline.dueAt
          ? <InlineTime dateTime={resource.deadline.dueAt} parts={[dateText(resource.deadline.dueAt)]} /> : 'No confirmed due date'}
      </dd></div>}
      {resource.kind === 'assignment' && resource.points !== null && <div><dt>Points</dt><dd>{resource.points}</dd></div>}
      {resource.kind === 'assignment' && <div><dt>Status</dt><dd>{view.status}</dd></div>}
      {resource.kind === 'material' && resource.moduleItem?.type && <div><dt>Format</dt><dd>{materialFormats[resource.moduleItem.type] ?? resource.moduleItem.type}</dd></div>}
      {resource.kind !== 'assignment' && resource.completed && <div><dt>Your report</dt><dd>Marked complete locally</dd></div>}
    </dl>
    {SHOW_DATE_CONFLICT_UI && deadlineReview}
    <p className="resource-heading__freshness">
      {view.freshness && <span>{view.freshness}</span>}
      <EvidenceInfo label="Saved source freshness">
        This is the saved capture from {dateText(resource.observedAt)}.
        {view.freshness ? ' Current source content may differ. Saved content remains available.' : ' A saved capture does not guarantee that the source is unchanged.'}
      </EvidenceInfo>
    </p>
    </div>
    {changedWhileReading && <p className="resource-heading__change" role="status">This saved item changed while you were reading. Its requirements and dates below reflect the latest capture; your position has been kept.</p>}
  </header>;
}

/** Large/raw identifiers stay reversible without taking over the default reading path. */
export function ResourceProvenance({ resource, snapshot }: { resource: ResourceView; snapshot: Snapshot }) {
  const { source } = resourceDetailPresentation(resource, snapshot);
  return <Disclosure label="Source details" placeKey={`resource-source:${resource.id}`}>
    <dl className="resource-provenance">
      <div><dt>Original title</dt><dd>{resource.title}</dd></div>
      <div><dt>Course</dt><dd>{resource.courseName}</dd></div>
      <div><dt>Source</dt><dd>{source?.label ?? resource.sourceId}</dd></div>
      <div><dt>Source status</dt><dd>{source ? sourceStates[source.status] : 'Source unavailable'}{source && !source.complete ? ' · Incomplete capture' : ''}</dd></div>
      <div><dt>Saved</dt><dd>{dateText(resource.observedAt)}</dd></div>
      <div><dt>Original URL</dt><dd>{resource.url}</dd></div>
      <div><dt>Resource ID</dt><dd>{resource.id}</dd></div>
      <div><dt>Source ID</dt><dd>{resource.sourceId}</dd></div>
      {source && <div><dt>Account scope</dt><dd>{source.accountScope}</dd></div>}
    </dl>
  </Disclosure>;
}
