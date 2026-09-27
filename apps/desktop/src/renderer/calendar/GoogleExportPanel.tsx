// owner: calendar-import. Calendar → Export → review → Google Calendar import in the default browser.
// Magic attaches each prepared file in Google's own chooser and reports only what it observed;
// the student chooses the destination and clicks Import in Google.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppBridge, CalendarImportFile, CalendarImportRequest, CalendarImportResult, PlanningSnapshot } from '@magic/contracts';
import { Action } from '../../../../../packages/ui/src';
import { addDays, localTime, type CalendarResource } from './model';
import { COMBINED_NAME, EXPORT_FAMILIES, FAMILY_NAMES, exportFiles, previewGoogleExport, type ExportMode } from './google-export';
import { ImportFlow, type ImportFlowState } from './import-flow';

export interface GoogleExportPanelProps {
  resources: CalendarResource[];
  planning?: PlanningSnapshot;
  timeZone: string;
  now: string;
  courseLabel: (resource: CalendarResource) => string;
  bridge: Pick<AppBridge, 'calendarImport'>;
  onClose: () => void;
}
const POLL_MS = 3000, POLL_LIMIT = 200;

/** What the student reads for one file; never stronger than the observed state. */
export function fileStatus(file: CalendarImportFile): string {
  const where = file.destination ? ` Google shows “${file.destination}” under Add to calendar.` : '';
  switch (file.state) {
    case 'waiting': return 'Not attached yet.';
    case 'preselected': return `Attached in Google: ${file.fileName}.${where} Choose the calendar you want, then click Import in Google.`;
    case 'imported': return `Google reported importing ${file.imported} of ${file.total} events${file.destination ? ` into “${file.destination}”` : ''}.`;
    case 'unknown': return file.detail ?? 'Magic couldn’t see what happened. Check Google Calendar before importing again.';
    case 'refused': return file.detail ?? 'Magic stopped this file for safety. Nothing was sent to Google.';
    case 'stopped': switch (file.stoppedFrom) {
      case 'preselected': return `Stopped after Magic attached ${file.fileName} in Google. Magic didn’t see an import and removed its copy, so clicking Import now may fail; check Google Calendar.`;
      case 'attaching': return 'Stopped while Magic was attaching this file. Check the Google window; Magic didn’t see the result and removed its copy.';
      case 'unknown': return 'Stopped. Magic couldn’t confirm whether this file reached Google; check Google Calendar.';
      default: return 'Stopped before this file was attached.';
    }
  }
}

export function ImportSteps({ result, pending, run }: { result: CalendarImportResult; pending: string | null; run: (request: CalendarImportRequest) => void }) {
  const session = result.session;
  if (!session) return null;
  const busy = pending !== null;
  const active = !session.stopped && session.files.some(f => f.state !== 'imported');
  const current = session.files.find(f => f.state !== 'imported' && f.state !== 'stopped');
  return <div className="mc-calendar-export-steps">
    <p role="status">{session.window === 'observed' ? `Google Calendar is open in a new ${result.capability.browser ?? 'browser'} window.` : session.window === 'dispatched' ? 'Magic asked your browser to open Google Calendar but didn’t see the window.' : ''}</p>
    <ol>{session.files.map(file => <li key={file.key} data-state={file.state} aria-current={file === current ? 'step' : undefined}>
      <strong>{file.calendarName}</strong> <span>{file.events} events</span>
      <p>{fileStatus(file)}</p>
      {file === current && !session.stopped && <div className="mc-calendar-export-actions">
        {file.state !== 'preselected' && <Action tone={file.state === 'waiting' ? 'primary' : 'quiet'} pending={pending === `attach:${file.key}`} disabled={busy} onClick={() => run({ action: 'attach', sessionId: session.id, fileKey: file.key })}>{file.state === 'waiting' ? 'Attach file in Google' : 'Attach again'}</Action>}
        {file.state === 'preselected' && <Action tone="quiet" pending={pending === `check:${file.key}`} disabled={busy} onClick={() => run({ action: 'check', sessionId: session.id, fileKey: file.key })}>Check import</Action>}
        {file.state !== 'preselected' && <button className="mc-calendar-control" disabled={busy} onClick={() => run({ action: 'create-calendar', sessionId: session.id, fileKey: file.key })}>Create “{file.calendarName}” in Google</button>}
        {result.manual && <button className="mc-calendar-control" disabled={busy} onClick={() => run({ action: 'reveal', sessionId: session.id, fileKey: file.key })}>Show file in Finder</button>}
      </div>}
    </li>)}</ol>
    {result.manual && <div className="mc-calendar-export-note" role="note">
      {!result.capability.accessibility && <p>To attach files for you, Magic needs Accessibility permission (System Settings → Privacy &amp; Security → Accessibility). <button className="mc-calendar-control" disabled={busy} onClick={() => run({ action: 'request-access' })}>Allow access</button></p>}
      <p>Or import it yourself: in Google Calendar, open Settings → Import &amp; export, click Select file from your computer, choose the file shown in Finder, pick a calendar and click Import.</p>
    </div>}
    {active && <div className="mc-calendar-export-actions"><button className="mc-calendar-control" onClick={() => run({ action: 'stop', sessionId: session.id })}>Stop</button></div>}
  </div>;
}

export function GoogleExportPanel({ resources, planning, timeZone, now, courseLabel, bridge, onClose }: GoogleExportPanelProps) {
  const today = localTime(now, timeZone).date;
  const scopes = useMemo(() => [...new Set(resources.filter(r => r.accountScope && !r.deleted && (r.kind === 'assignment' || r.scheduleDeadline)).map(r => r.accountScope!))].sort(), [resources]);
  // One combined calendar is the normal first choice; the student can switch to three separate calendars.
  const [scope, setScope] = useState(''), [mode, setMode] = useState<ExportMode>('combined');
  const [from, setFrom] = useState(today), [through, setThrough] = useState(addDays(today, 120));
  const [flowState, setFlowState] = useState<ImportFlowState>({ result: null, pending: null, error: '' }), [localError, setLocalError] = useState('');
  const flow = useRef<ImportFlow | null>(null);
  if (!flow.current) flow.current = new ImportFlow(bridge, setFlowState);
  const { result, pending } = flowState, error = localError || flowState.error;
  // One account is chosen for the student; several need an explicit choice, never the first.
  const chosen = scopes.length === 1 ? scopes[0]! : scopes.includes(scope) ? scope : '';
  const preview = useMemo(() => {
    if (!chosen) return null;
    try { return { value: previewGoogleExport(resources, planning, { from, through, canvasScope: chosen, timeZone, now, courseLabel }), error: '' }; }
    catch (cause) { return { value: null, error: cause instanceof Error ? cause.message : 'Review the date range.' }; }
  }, [resources, planning, chosen, from, through, timeZone, now, courseLabel]);
  const polls = useRef(0);
  const session = result?.session ?? null;
  async function start() {
    const value = preview?.value;
    if (!value) return;
    let files;
    try { files = exportFiles(value, mode, new Date().toISOString()); } catch (cause) { setLocalError(cause instanceof Error ? cause.message : 'Couldn’t prepare the file.'); return; }
    setLocalError('');
    if (files.length) await flow.current!.start(mode, files.map(({ family, calendarName, events, ics }) => ({ family, calendarName, events, ics })));
  }
  const run = (request: CalendarImportRequest) => {
    if (request.action === 'stop') void flow.current!.stop();
    else if (request.action !== 'prepare') { if (request.action !== 'check') polls.current = 0; void flow.current!.run(request); }
  };
  // Waiting for the student to click Import in Google: read Google's own result, bounded.
  const watching = session?.files.find(f => f.state === 'preselected');
  useEffect(() => {
    if (!watching || !session || session.stopped || pending) return;
    const timer = setTimeout(() => { if (polls.current++ < POLL_LIMIT) run({ action: 'check', sessionId: session.id, fileKey: watching.key }); }, POLL_MS);
    return () => clearTimeout(timer);
  }, [watching?.key, session?.id, session?.stopped, pending, result]);
  // Leaving the export ends it: prepared files are removed and nothing further is attached or opened.
  // A closed flow stays closed; StrictMode's replayed setup (and Fast Refresh) gets a fresh one instead of reusing it.
  useEffect(() => {
    if (!flow.current) { flow.current = new ImportFlow(bridge, setFlowState); setFlowState(flow.current.state); }
    const current = flow.current;
    void current.status();
    return () => { current.close(); if (flow.current === current) flow.current = null; };
  }, []);

  const counts = preview?.value?.counts, omitted = preview?.value?.omitted;
  const leftOut = omitted ? [
    [omitted.dateReview, 'without one confirmed due date'], [omitted.conflict, 'with disagreeing dates'], [omitted.typeUnknown, 'whose Canvas type wasn’t captured'],
    [omitted.clockChange, 'at a daylight-saving clock change'], [omitted.scheduleUnverified, 'from unconfirmed class schedules'], [omitted.cancelled, 'cancelled'],
  ].filter(([count]) => Number(count) > 0).map(([count, why]) => `${count} ${why}`) : [];
  const total = counts ? counts.lectures + counts.assignments + counts.exams : 0;
  const locked = !!session || !!pending || flow.current.stopped;
  return <section id="calendar-export-panel" className="mc-calendar-export" aria-labelledby="calendar-export-heading" onKeyDown={event => { if (event.key === 'Escape' && !pending) { event.preventDefault(); onClose(); } }}>
    <div className="mc-calendar-review-heading"><div><h3 id="calendar-export-heading" tabIndex={-1}>Add to Google Calendar</h3>
      <p>A one-time copy of your lectures, assignments, and exams &amp; quizzes. Later changes here don’t sync to Google.</p></div>
      <button className="mc-calendar-control" onClick={onClose}>{flow.current.liveSession || pending === 'prepare' ? 'Stop and close' : 'Close'}</button></div>
    {scopes.length > 1 && <label className="mc-calendar-export-field">School account <select value={chosen} disabled={locked} onChange={event => setScope(event.target.value)}><option value="">Choose…</option>{scopes.map((value, index) => <option key={value} value={value}>Account {index + 1} · {resources.find(r => r.accountScope === value)?.courseName ?? 'school'}</option>)}</select></label>}
    {!scopes.length && <p>No captured school coursework yet. Connect Canvas in Settings, then return here.</p>}
    <fieldset className="mc-calendar-export-options" disabled={locked}><legend>In Google Calendar</legend>
      <label><input type="radio" name="calendar-export-mode" checked={mode === 'combined'} onChange={() => setMode('combined')} />One calendar: {COMBINED_NAME}</label>
      <label><input type="radio" name="calendar-export-mode" checked={mode === 'split'} onChange={() => setMode('split')} />Three calendars: {EXPORT_FAMILIES.map(f => FAMILY_NAMES[f]).join(', ')}</label>
    </fieldset>
    <div className="mc-calendar-export-dates"><label>From <input type="date" value={from} disabled={locked} onChange={event => setFrom(event.target.value)} /></label><label>Through <input type="date" value={through} disabled={locked} onChange={event => setThrough(event.target.value)} /></label></div>
    {preview?.error && <p role="alert">{preview.error}</p>}
    {counts && <p className="mc-calendar-export-count">{EXPORT_FAMILIES.map(f => `${FAMILY_NAMES[f]} ${counts[f]}`).join(' · ')}</p>}
    {leftOut.length > 0 && <p className="mc-calendar-export-note">Left out: {leftOut.join(', ')}. Review them in My Magic UW.</p>}
    {preview?.value?.scheduleNote && <p className="mc-calendar-export-note">{preview.value.scheduleNote}</p>}
    {!locked && <div className="mc-calendar-export-actions">
      <Action disabled={!total || !!pending} pending={pending === 'prepare' || pending === 'open'} onClick={() => void start()}>Open Google Calendar</Action>
      <span className="mc-calendar-export-note">{result?.capability.browser ? `Opens a new ${result.capability.browser} window. You choose the calendar and click Import there.` : 'You choose the calendar and click Import in Google.'}</span>
    </div>}
    {result && <ImportSteps result={result} pending={pending} run={run} />}
    {flow.current.stopped && !session && <p role="status" className="mc-calendar-export-note">Stopped before Google Calendar opened. Magic removed the prepared files.</p>}
    {result?.notice && <p role="status" className="mc-calendar-export-note">{result.notice}</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
