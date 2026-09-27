import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Command, CommandResult, ResourceView, Snapshot } from '@magic/contracts';
import { personalReportIssue, personalReportState, personalReportVersion } from '@magic/contracts';
import { Confirmation } from '../../../../packages/ui/src';
import { ReportWriter, type ReportFeedback } from './report-writer';
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
export function PersonalReport({ resource, snapshot, run, compactWhenHandled = false, summary }: {
  compactWhenHandled?: boolean; summary?: ReactNode;
  resource: ResourceView; snapshot: Snapshot;
  run: (command: Command) => Promise<CommandResult | undefined>;
}) {
  const evidence = deadlineReportEvidence(resource, snapshot);
  if (!evidence) return <p className="magic-ui-meta" role="status">The saved source evidence could not be fully resolved. Refresh sources before reporting this handled.</p>;
  return <ResolvedReport key={personalReportIssue('deadline-review', evidence.map(item => item.resourceId)) + personalReportVersion(evidence)} evidence={evidence} snapshot={snapshot} run={run} compactWhenHandled={compactWhenHandled} summary={summary}/>;
}
function ResolvedReport({ evidence, snapshot, run, compactWhenHandled, summary }: { evidence: NonNullable<ReturnType<typeof deadlineReportEvidence>>; snapshot: Snapshot; run: (command: Command) => Promise<CommandResult | undefined>; compactWhenHandled: boolean; summary?: ReactNode }) {
  const issueId = personalReportIssue('deadline-review', evidence.map(item => item.resourceId));
  const sourceVersion = personalReportVersion(evidence);
  const state = personalReportState(snapshot.personalReports, issueId, sourceVersion);
  const [feedback, setFeedback] = useState<ReportFeedback>({ pending: false, error: '' });
  const writer = useMemo(() => new ReportWriter({ issueId, sourceVersion, evidence, expectedRevision: state.revision }, setFeedback), [issueId, sourceVersion]);
  useLayoutEffect(() => writer.update({ issueId, sourceVersion, evidence, expectedRevision: state.revision }), [writer, issueId, sourceVersion, evidence, state.revision]);
  useLayoutEffect(() => () => writer.invalidate(), [writer]);
  return <Confirmation issueId={issueId} sourceVersion={sourceVersion} record={state.record}
    pending={feedback.pending} error={feedback.error} compactWhenHandled={compactWhenHandled} summary={summary}
    onChange={({ handled }) => { void writer.change(handled, run); }}/>
}

/** Keep the report mounted across collapse/Undo. Callers supply only persisted current-version state. */
export function HandledBriefing({ handled, children, action, report }: { handled: boolean; children: ReactNode; action: ReactNode; report: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const focusWithin = useRef(false);
  const previous = useRef(handled);
  useEffect(() => {
    const clear = () => { focusWithin.current = false; };
    window.addEventListener('blur', clear);
    return () => window.removeEventListener('blur', clear);
  }, []);
  useLayoutEffect(() => {
    if (previous.current !== handled && focusWithin.current) {
      root.current?.querySelector<HTMLElement>(handled ? '[data-report-undo]' : 'input[type="checkbox"]')?.focus({ preventScroll: true });
    }
    previous.current = handled;
  }, [handled]);
  return <div ref={root} className="briefing-passage magic-handled-briefing" data-handled={handled}
    onFocusCapture={() => { focusWithin.current = true; }}
    onBlurCapture={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) focusWithin.current = false; }}>
    <div className="magic-handled-briefing__body" inert={handled} aria-hidden={handled || undefined}><div>{children}</div></div>
    <div className="briefing-review magic-handled-briefing__aside"><div className="magic-handled-briefing__action" inert={handled} aria-hidden={handled || undefined}><div>{action}</div></div>{report}</div>
  </div>;
}
