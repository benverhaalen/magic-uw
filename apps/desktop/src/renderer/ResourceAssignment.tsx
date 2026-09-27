import type { ReactNode } from 'react';
import type { ResourceView, Snapshot } from '@magic/contracts';
import { Action, Disclosure } from '../../../../packages/ui/src';
import { Glyph } from './DesktopShell';
import { preparedWorkRevision } from './StartWork';
import { PreparedWork } from './prepared-work/PreparedWork';
import { EvidenceInfo } from '../../../../packages/ui/src/evidence-info';
import { reportWorkspaceFailure } from './workspace-feedback';
import { TaskWorkspace } from './task-workspace/TaskWorkspace';

const formats: Record<string, string> = {
  online_upload: 'File upload', online_text_entry: 'Text entry', online_url: 'Website URL',
  media_recording: 'Media recording', student_annotation: 'Document annotation',
  external_tool: 'External tool', online_quiz: 'Online quiz', discussion_topic: 'Discussion',
  on_paper: 'On paper', none: 'No Canvas submission', not_graded: 'Not graded',
};
/** Below this, TaskWorkspace asks the source investigator for linked course context. */
const SPARSE_INSTRUCTIONS = 200;

/** What the saved capture holds, stated plainly. Never implies instructions that weren't captured. */
export function instructionsState(resource: Pick<ResourceView, 'text'>, investigates: boolean) {
  const text = (resource.text ?? '').trim();
  if (!text) return { text: null, note: 'No instructions were saved from the assignment page. Open it to check what it asks for.' };
  return { text: resource.text, note: text.length < SPARSE_INSTRUCTIONS
    ? `This is everything the saved assignment page says.${investigates ? ' Linked course sources Magic finds for it appear in the task setup above.' : ''}` : null };
}

/** Exact captured requirements and rubric. No generated synopsis or inferred submission format. */
export function ResourceAssignment({ resource, snapshot, policy, provenance, onSetup, onNotice, onOpenOriginal }: {
  resource: ResourceView; snapshot: Snapshot; policy: ReactNode; provenance: ReactNode; onSetup: () => void; onNotice: (text: string) => void; onOpenOriginal: () => void;
}) {
  const submissionTypes = [...new Set(resource.submissionTypes ?? [])];
  const instructions = instructionsState(resource, Boolean(window.magic?.investigateAssignment));
  return <div className="resource-assignment">
<TaskWorkspace resource={resource} snapshot={snapshot} refreshKey={preparedWorkRevision(snapshot)} onSetup={onSetup} onFailure={reportWorkspaceFailure} />
    <div className="resource-assignment__reading">
      <section className="detail-section resource-assignment__instructions" aria-labelledby="assignment-instructions">
        <div className="resource-assignment__instructions-head">
          <h3 id="assignment-instructions">Instructions</h3>
          <Action tone="quiet" onClick={onOpenOriginal}>Open original <Glyph name="external" /></Action>
        </div>
        {instructions.text && <p className="source-text">{instructions.text}</p>}
        {instructions.note && <p className="muted small">{instructions.note}</p>}
      </section>
      {provenance}
    </div>
    <aside className="resource-assignment__work" aria-label="Assignment work and requirements">
      <Disclosure label="Other opening options" placeKey={`opening-options:${resource.id}`}>
        <PreparedWork resource={resource} refreshKey={preparedWorkRevision(snapshot)} info={EvidenceInfo} onSetup={onSetup} onNotice={onNotice} onFailure={reportWorkspaceFailure} onOpenOriginal={onOpenOriginal} />
      </Disclosure>
      {policy}
      {submissionTypes.length > 0 && <Disclosure label="Captured submission format" placeKey={`submission:${resource.id}`}><section className="resource-assignment__support" aria-labelledby="assignment-submission">
        <h3 id="assignment-submission">Submission</h3>
        <ul>{submissionTypes.map(type => <li key={type}>{formats[type] ?? type}</li>)}</ul>
      </section></Disclosure>}
      {resource.rubric && resource.rubric.length > 0 && <section className="resource-assignment__support" aria-labelledby="assignment-rubric">
        <h3 id="assignment-rubric">Grading criteria</h3>
        <ol className="resource-assignment__rubric">{resource.rubric.map((criterion, index) => <li key={`${criterion.id ?? criterion.criterionId ?? 'criterion'}:${index}`}>
          <div className="resource-assignment__criterion"><span>{criterion.description || `Criterion ${index + 1}`}</span>
            {criterion.points != null && <span>{criterion.points} {criterion.points === 1 ? 'pt' : 'pts'}</span>}</div>
          {(criterion.longDescription || criterion.ratings?.length) && <Disclosure label="Criterion details" placeKey={`rubric:${resource.id}:${index}`}>
            {criterion.longDescription && <p className="resource-assignment__quote">{criterion.longDescription}</p>}
            {criterion.ratings && <ul>{criterion.ratings.map((rating, ratingIndex) => <li key={`${rating.id ?? 'rating'}:${ratingIndex}`}>
              <p>{rating.description}{rating.points != null && <> · {rating.points} {rating.points === 1 ? 'pt' : 'pts'}</>}</p>
              {rating.longDescription && <p className="resource-assignment__quote">{rating.longDescription}</p>}
            </li>)}</ul>}
          </Disclosure>}
        </li>)}</ol>
      </section>}
    </aside>
  </div>;
}
