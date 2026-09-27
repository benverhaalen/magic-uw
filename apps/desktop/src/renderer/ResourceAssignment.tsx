import type { ReactNode } from 'react';
import type { ResourceView, Snapshot } from '@magic/contracts';
import { Disclosure } from '../../../../packages/ui/src';
import { preparedWorkRevision } from './StartWork';
import { PreparedWork } from './prepared-work/PreparedWork';
import { EvidenceInfo } from '../../../../packages/ui/src/evidence-info';
import { reportWorkspaceFailure } from './workspace-feedback';

const formats: Record<string, string> = {
  online_upload: 'File upload', online_text_entry: 'Text entry', online_url: 'Website URL',
  media_recording: 'Media recording', student_annotation: 'Document annotation',
  external_tool: 'External tool', online_quiz: 'Online quiz', discussion_topic: 'Discussion',
  on_paper: 'On paper', none: 'No online submission', not_graded: 'Not graded',
};

/** Exact captured requirements and rubric. No generated synopsis or inferred submission format. */
export function ResourceAssignment({ resource, snapshot, policy, provenance, onSetup, onNotice, onOpenOriginal }: {
  resource: ResourceView; snapshot: Snapshot; policy: ReactNode; provenance: ReactNode; onSetup: () => void; onNotice: (text: string) => void; onOpenOriginal: () => void;
}) {
  const submissionTypes = [...new Set(resource.submissionTypes ?? [])];
  return <div className="resource-assignment">
    <div className="resource-assignment__reading">
      <section className="detail-section resource-assignment__instructions" aria-labelledby="assignment-instructions">
        <h3 id="assignment-instructions">Instructions</h3>
        {resource.text ? <p className="source-text">{resource.text}</p>
          : <p className="muted">This capture has no instructions. Open the assignment to check its requirements.</p>}
      </section>
      {provenance}
    </div>
    <aside className="resource-assignment__work" aria-label="Assignment work and requirements">
      <PreparedWork resource={resource} refreshKey={preparedWorkRevision(snapshot)} info={EvidenceInfo} onSetup={onSetup} onNotice={onNotice} onFailure={reportWorkspaceFailure} onOpenOriginal={onOpenOriginal} />
      {policy}
      {submissionTypes.length > 0 && <section className="resource-assignment__support" aria-labelledby="assignment-submission">
        <h3 id="assignment-submission">Submission</h3>
        <ul>{submissionTypes.map(type => <li key={type}>{formats[type] ?? type}</li>)}</ul>
      </section>}
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
