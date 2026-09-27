import { useEffect, useRef, useState } from 'react';
import type { Command, CommandResult, ResourceView, Snapshot } from '@magic/contracts';
import { personalReportIssue, personalReportState, personalReportVersion } from '@magic/contracts';
import { Confirmation } from '../../../../packages/ui/src';
/** Mirror current core/evidence deadline provenance, then verify no displayed claim was omitted.
 * Unknown evidence cannot be confirmed. Calendar claims retain their independent hashes. */
export function deadlineReportEvidence(resource: ResourceView, snapshot: Snapshot) {
  const contributors = [resource];
  for (const link of snapshot.links.filter(link => link.status === 'accepted' && link.type === 'same_as' && link.toId === resource.id)) {
    const source = snapshot.resources.find(item => item.id === link.fromId && !item.deleted);
    if (!source) return null;
    if (source.calendar && !contributors.some(item => item.id === source.id)) contributors.push(source);
  }
  const claimKey = (claim: ResourceView['deadlines'][number]) => JSON.stringify([claim.value, claim.kind, claim.quote, claim.authority, claim.scopeConfirmed]);
  const actual = contributors.flatMap(item => item.deadlines).map(claimKey).sort();
  const displayed = resource.deadline.claims.map(claimKey).sort();
  if (actual.length !== displayed.length || actual.some((claim, index) => claim !== displayed[index]) || contributors.length > 12) return null;
  return contributors.map(item => ({ resourceId: item.id, contentHash: item.contentHash }));
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
  useEffect(() => { generation.current++; active.current = false; setPending(false); setError(''); return () => { generation.current++; }; }, [issueId, sourceVersion]);
  return <Confirmation issueId={issueId} sourceVersion={sourceVersion} record={state.record} pending={pending} error={error}
    onChange={async ({ handled }) => {
      if (active.current) return;
      active.current = true; setPending(true); setError('');
      const ticket = generation.current;
      const result = await run({ type: 'personal-report', value: { operationId: crypto.randomUUID(), issueId, evidence, sourceVersion, handled, expectedRevision: state.revision } });
      if (ticket !== generation.current) return;
      if (!result) { setError('Your report was not saved. Refreshing the current evidence; try again.'); await run({ type: 'snapshot' }); }
      if (ticket === generation.current) { setPending(false); active.current = false; }
    }}/>
}
