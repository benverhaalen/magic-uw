import { useEffect, useRef, useState } from 'react';
import type { Command, CommandResult, ResourceView, Snapshot } from '@magic/contracts';
import { personalReportIssue, personalReportState, personalReportVersion } from '@magic/contracts';
import { Confirmation } from '../../../../packages/ui/src';
/** Use canonical provenance rather than reimplementing deadline extraction in the renderer.
 * Unresolved mentions also contribute: changed wording must reopen a student report. */
export function deadlineReportEvidence(resource: ResourceView, snapshot: Snapshot) {
  const contributors = resource.deadlineContributors;
  if (!contributors?.length || contributors.length > 12 || !contributors.some(item => item.resourceId === resource.id)) return null;
  const available = new Map(snapshot.resources.filter(item => !item.deleted).map(item => [item.id, item]));
  for (const item of contributors) if (available.get(item.resourceId)?.contentHash !== item.contentHash) return null;
  const byId = new Map(contributors.map(item => [item.resourceId, item.contentHash]));
  for (const claim of [...resource.deadline.claims, ...(resource.deadline.unresolved ?? [])]) {
    if (claim.span && byId.get(claim.span.resourceId) !== claim.span.contentHash) return null;
  }
  return contributors;
}
/** Student report only. Source submission and local work completion remain separate. */
export function PersonalReport({ resource, snapshot, run }: {
  resource: ResourceView; snapshot: Snapshot;
  run: (command: Command) => Promise<CommandResult | undefined>;
}) {
  const evidence = deadlineReportEvidence(resource, snapshot);
  if (!evidence) return <p className="magic-ui-meta" role="status">The saved source evidence could not be fully resolved. Refresh sources before reporting this handled.</p>;
  return <ResolvedReport evidence={evidence} snapshot={snapshot} run={run}/>;
}
function ResolvedReport({ evidence, snapshot, run }: { evidence: NonNullable<ReturnType<typeof deadlineReportEvidence>>; snapshot: Snapshot; run: (command: Command) => Promise<CommandResult | undefined> }) {
  const issueId = personalReportIssue('deadline-review', evidence.map(item => item.resourceId));
  const sourceVersion = personalReportVersion(evidence);
  const state = personalReportState(snapshot.personalReports, issueId, sourceVersion);
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  const generation = useRef(0), active = useRef(false);
  const uncertain = useRef<{ handled: boolean; revision: number } | null>(null);
  useEffect(() => {
    if (uncertain.current && state.revision > uncertain.current.revision) { setError(''); uncertain.current = null; }
  }, [state.revision]);
  useEffect(() => { generation.current++; active.current = false; setPending(false); setError(''); return () => { generation.current++; }; }, [issueId, sourceVersion]);
  return <Confirmation issueId={issueId} sourceVersion={sourceVersion} record={state.record} pending={pending} error={error}
    onChange={async ({ handled }) => {
      if (active.current) return;
      active.current = true; setPending(true); setError('');
      const ticket = generation.current;
      const result = await run({ type: 'personal-report', value: { operationId: crypto.randomUUID(), issueId, evidence, sourceVersion, handled, expectedRevision: state.revision } });
      if (ticket !== generation.current) return;
      if (!result) {
        uncertain.current = { handled, revision: state.revision };
        setError('Change not confirmed. Checking the saved report…');
        const readback = await run({ type: 'snapshot' });
        if (ticket !== generation.current) return;
        if (readback) {
          const confirmed = personalReportState(readback.snapshot.personalReports, issueId, sourceVersion);
          setError(Boolean(confirmed.record) === handled ? '' : 'Showing the saved report. Your change was not confirmed.');
          uncertain.current = null;
        } else setError('Change not confirmed. Showing the last saved report.');
      }
      if (ticket === generation.current) { setPending(false); active.current = false; }
    }}/>
}
