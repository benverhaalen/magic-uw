import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Action } from '../../../../../packages/ui/src/components';
import { EvidenceInfo } from '../../../../../packages/ui/src/evidence-info';
import { courseIdentityHues } from './course-index-view';
import type { CourseWorkModel, CourseWorkRow } from './course-work-model';
import { WorkGlyph } from './CoursesViewToggle';
import { groupCourseWork, workToday, workPlacement, workTimeLabel, workSourceLabel, workRowAnchor, workRowFocus,
  pageWorkGroups, workDayKey, workDayOpen, openWorkDayState, type WorkListState, type WorkSection, type WorkBucket, type WorkPage } from './course-work-display';
import '../../../../../packages/ui/src/deadline-emphasis.css';
import './courses-work-view.css';

export type WorkReportResult =
  | { status: 'saved'; issueId: string; revision: number; checked: boolean; reportedAt: string }
  | { status: 'conflict'; reason: 'revision' | 'obligation-changed' | 'scope-changed' }
  | { status: 'unavailable'; reason: 'storage' | 'capacity' };
type Attempt = { row: CourseWorkRow; checked: boolean; operationId: string };
type Feedback = { pending: boolean; error?: string; retry?: Attempt; obligationVersion?: string; receipt?: Extract<WorkReportResult, {status:'saved'}> };
export interface CoursesWorkListProps {
  model: CourseWorkModel;
  state: WorkListState;
  onStateChange: (state: WorkListState) => void;
  timeZone: string;
  /** Optional controlled clock for previews; production uses live time and resume updates. */
  now?: string;
  onOpen: (row: CourseWorkRow) => void;
  /** The integration adapter validates exact row scope and uses existing resource/work-set/date handlers. */
  onAction: (row: CourseWorkRow) => void | Promise<void>;
  /** Must return persisted readback, not merely command dispatch or an in-memory check. */
  onReport: (row: CourseWorkRow, checked: boolean, operationId: string) => Promise<WorkReportResult>;
  onSources: () => void;
}
export function CoursesWorkList(props: CoursesWorkListProps) {
  // Scope key remount prevents results or pending UI from leaking to a different admitted set/term.
  return <ScopedWorkList key={props.model.scope.key} {...props}/>;
}
function ScopedWorkList({ model, state, onStateChange, timeZone, now, onOpen, onAction, onReport, onSources }: CoursesWorkListProps) {
  const [feedback, setFeedback] = useState<Record<string, Feedback>>({});
  const [actions, setActions] = useState<Record<string, {pending: boolean; error?: string}>>({});
  const busy = useRef(new Set<string>()), actionBusy = useRef(new Set<string>()), alive = useRef(true);
  const stateRef = useRef(state); stateRef.current = state;
  function publish(next: WorkListState) { stateRef.current = next; onStateChange(next); }
  const [clock, setClock] = useState(() => new Date().toISOString());
  useEffect(() => {
    if (now) return;
    const tick = () => setClock(new Date().toISOString());
    const interval = window.setInterval(tick, 60_000);
    window.addEventListener('focus', tick); document.addEventListener('visibilitychange', tick);
    return () => { window.clearInterval(interval); window.removeEventListener('focus', tick); document.removeEventListener('visibilitychange', tick); };
  }, [now]);
  const today = workToday({ ...model, generatedAt: now ?? clock }, timeZone);
  const buckets = groupCourseWork(model.rows, today, state);
  const hues = courseIdentityHues(model.scope.courses.map(course => `${course.accountScope}:${course.courseId}`));
  const top = useRef<HTMLDivElement>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const place = useRef<{ anchor: string | null; offset: number; focus: string | null } | null>(null);
  function captureListPlace() {
    const pane = top.current?.closest<HTMLElement>('.desktop-workspace'); if (!pane) return;
    const edge = pane.getBoundingClientRect().top;
    // Rows inside a collapsed day stay mounted for its exit motion but are not a place to return to.
    const anchor = Array.from(top.current?.querySelectorAll<HTMLElement>('[data-place-anchor]') ?? []).find(node => !node.closest('[inert]') && node.getBoundingClientRect().bottom > edge);
    const active = document.activeElement as HTMLElement | null;
    place.current = { anchor: anchor?.dataset.placeAnchor ?? null, offset: anchor ? anchor.getBoundingClientRect().top - edge : 0,
      focus: active && top.current?.contains(active) ? active.dataset.focusKey ?? null : place.current?.focus ?? null };
  }
  useLayoutEffect(() => {
    const pane = top.current?.closest<HTMLElement>('.desktop-workspace');
    const saved = place.current;
    if (pane && saved?.anchor) {
      const anchor = Array.from(top.current?.querySelectorAll<HTMLElement>('[data-place-anchor]') ?? []).find(node => node.dataset.placeAnchor === saved.anchor);
      if (anchor) pane.scrollTop += anchor.getBoundingClientRect().top - pane.getBoundingClientRect().top - saved.offset;
      // Restore only focus lost by a data reorder, never steal it from another live control.
      if (saved.focus && document.activeElement === document.body) top.current?.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(saved.focus)}"]`)?.focus({ preventScroll: true });
    }
    captureListPlace();
  }, [model.rows, today]);
  useEffect(() => {
    const pane = top.current?.closest<HTMLElement>('.desktop-workspace');
    pane?.addEventListener('scroll', captureListPlace, { passive: true }); top.current?.addEventListener('focusin', captureListPlace);
    return () => { pane?.removeEventListener('scroll', captureListPlace); top.current?.removeEventListener('focusin', captureListPlace); };
  }, [model.rows.length > 0]);
  async function report(attempt: Attempt) {
    const { row, checked, operationId } = attempt;
    if (!row.report || busy.current.has(row.key)) return;
    busy.current.add(row.key);
    setFeedback(previous => ({ ...previous, [row.key]: { ...previous[row.key], pending: true, retry: attempt, error: undefined } }));
    // Pin before any authoritative snapshot update can move a successful row away from its invoker.
    const current = stateRef.current;
    if (!current.pins[row.key]) publish({ ...current, pins: { ...current.pins, [row.key]: workPlacement(row, today, model.rows) } });
    let result: WorkReportResult;
    try { result = await onReport(row, checked, operationId); }
    catch { result = { status: 'unavailable', reason: 'storage' }; }
    if (!alive.current) return;
    busy.current.delete(row.key);
    if (result?.status === 'saved' && result.issueId === row.report.issueId && result.revision > row.report.revision && result.checked === checked) {
      setFeedback(previous => ({ ...previous, [row.key]: { pending: false, receipt: result, obligationVersion: row.report?.obligationVersion } }));
      // Undo returns to its checkbox without moving the reader's scroll position.
      if (!checked) top.current?.querySelector<HTMLInputElement>(`[data-report-key="${CSS.escape(row.key)}"]`)?.focus({ preventScroll: true });
    } else {
      const error = result?.status === 'conflict' ? 'This work changed. Review the latest details before saving.'
        : result?.status === 'unavailable' && result.reason === 'capacity' ? 'Not saved. Local history is full.' : 'Not saved. Try again.';
      setFeedback(previous => ({ ...previous, [row.key]: { ...previous[row.key], pending: false, error, retry: result?.status === 'conflict' ? undefined : attempt } }));
    }
  }
  async function act(row: CourseWorkRow) {
    if (!row.action || actionBusy.current.has(row.key)) return;
    actionBusy.current.add(row.key); setActions(previous => ({ ...previous, [row.key]: { pending: true } }));
    try { await onAction(row); if (alive.current) setActions(previous => ({ ...previous, [row.key]: { pending: false } })); }
    catch { if (alive.current) setActions(previous => ({ ...previous, [row.key]: { pending: false, error: 'Couldn’t open this. Try again.' } })); }
    finally { actionBusy.current.delete(row.key); }
  }
  function expand(section: WorkSection, expanded: boolean) {
    const current = stateRef.current;
    publish({ ...current, expanded: { ...current.expanded, [section]: expanded } });
  }
  function setDay(section: WorkSection, day: string, open: boolean) {
    const groups = groupCourseWork(model.rows, today, stateRef.current).find(bucket => bucket.section === section)?.groups ?? [];
    publish(openWorkDayState(stateRef.current, model.scope.key, section, groups, today, day, open));
  }
  function reveal(section: WorkSection) {
    expand(section, true);
    requestAnimationFrame(() => top.current?.querySelector<HTMLElement>(`[data-work-section="${section}"]`)?.scrollIntoView({ block: 'start', behavior: 'instant' }));
  }
  if (!model.rows.length) return <div className="cw-list cw-empty"><p>No saved work is available for {model.scope.term.state === 'verified' ? model.scope.term.label : 'these courses'} yet.</p>
    {model.coverage.length > 0 && <p>Some sources are incomplete. Check Sources for current coverage.</p>}<Action tone="quiet" onClick={onSources}>Open Sources</Action></div>;
  const hiddenUncertainty = buckets.filter(bucket => ['conflict', 'undated'].includes(bucket.section));
  const currentCount = buckets.find(bucket => bucket.section === 'current')?.count ?? 0;
  return <div className="cw-list" ref={top}>
    {currentCount > 20 && hiddenUncertainty.length > 0 && <p className="cw-uncertainty">Some saved work has {hiddenUncertainty.map((bucket, index) => <span key={bucket.section}>{index > 0 ? ' or ' : ''}<button onClick={() => reveal(bucket.section)}>{bucket.section === 'conflict' ? 'dates to confirm' : 'no date'}</button></span>)}.</p>}
    {buckets.map(bucket => <WorkSectionView key={bucket.section} bucket={bucket} state={state} scope={model.scope.key} today={today} onStateChange={publish} onExpand={expand} onDay={setDay}>
      {row => {
        const response = feedback[row.key], saved = response?.receipt;
        const authoritative = row.report;
        // Only a matching obligation can use local confirmed readback while snapshot propagation catches up.
        const attemptVersion = response?.obligationVersion ?? response?.retry?.row.report?.obligationVersion;
        const validReceipt = saved && authoritative && saved.issueId === authoritative.issueId && saved.revision > authoritative.revision && !authoritative.needsReview && (!attemptVersion || attemptVersion === authoritative.obligationVersion);
        const reportState = validReceipt ? { ...authoritative!, checked: saved.checked, revision: saved.revision, reportedAt: saved.reportedAt } : authoritative;
        const effective = { ...row, report: reportState };
        return <WorkRow key={row.key} row={effective} today={today} hue={hues.get(`${row.accountScope}:${row.courseId}`) ?? 'neutral'} showDate={!!state.pins[row.key]?.date && row.time.state === 'dated' && state.pins[row.key]!.date !== row.time.date}
          feedback={response} action={actions[row.key]} onOpen={() => onOpen(row)} onAction={() => void act(row)}
          onCheck={checked => void report({ row: effective, checked, operationId: crypto.randomUUID() })}
          onRetry={() => { if (response?.retry) void report(response.retry); }}/>
      }}
    </WorkSectionView>)}
    <footer className="cw-footer">End of saved work for {model.scope.term.state === 'verified' ? model.scope.term.label : 'these courses'}.
      {' '}Saved information may have changed.
      {model.coverage.length > 0 && <EvidenceInfo label="Work list coverage">{model.coverage.map((item, index) => <p key={`${item.kind}:${index}`}>{item.label}</p>)}</EvidenceInfo>}
    </footer>
  </div>;
}
function WorkSectionView({ bucket, state, scope, today, onStateChange, onExpand, onDay, children }: {
  bucket: WorkBucket; state: WorkListState; scope: string; today: string; onStateChange: (state: WorkListState) => void;
  onExpand: (section: WorkSection, expanded: boolean) => void; onDay: (section: WorkSection, day: string, open: boolean) => void; children: (row: CourseWorkRow) => React.ReactNode;
}) {
  const id = useId(), trigger = useRef<HTMLButtonElement>(null), section = useRef<HTMLElement>(null);
  const open = bucket.section === 'current' || (state.expanded[bucket.section] ?? ['conflict', 'undated'].includes(bucket.section));
  const { groups, limit, hidden } = pageWorkGroups(bucket.groups, group => workDayOpen(state, scope, workDayKey(group, today)), state.visible[bucket.section] ?? 20);
  function collapse() {
    const currentAnchor = section.current?.closest('.desktop-workspace');
    const position = trigger.current?.getBoundingClientRect().top ?? 0;
    trigger.current?.focus({ preventScroll: true }); onExpand(bucket.section, false);
    requestAnimationFrame(() => { if (currentAnchor && trigger.current) currentAnchor.scrollTop += trigger.current.getBoundingClientRect().top - position; });
  }
  return <section ref={section} className="cw-bucket" data-work-section={bucket.section}>
    {bucket.section !== 'current' && <button ref={trigger} type="button" className="cw-disclosure magic-fb-pill" aria-expanded={open} aria-controls={id}
      data-focus-key={`course-work-section-${bucket.section}`} onClick={() => open ? collapse() : onExpand(bucket.section, true)}><WorkGlyph name="chevron"/>{bucket.label}{!open ? ` · ${bucket.count}` : ''}</button>}
    {open && <div id={id}>{groups.map(group => <WorkDayView key={group.key} group={group} day={workDayKey(group, today)} heading={bucket.section === 'current' || !!group.date} onDay={(day, open) => onDay(bucket.section, day, open)}>{group.rows.map(children)}</WorkDayView>)}
      {hidden > 0 && <button className="cw-page-control magic-fb-pill" data-focus-key={`course-work-more-${bucket.section}`} onClick={() => onStateChange({ ...state, visible: { ...state.visible, [bucket.section]: limit + 20 } })}>Show {Math.min(20, hidden)} more</button>}
      {limit > 30 && <button className="cw-page-control magic-fb-pill" data-focus-key={`course-work-less-${bucket.section}`} onClick={event => {
        const pane = event.currentTarget.closest('.desktop-workspace'), top = section.current?.getBoundingClientRect().top ?? 0;
        // Focus a persistent section or first day trigger before removing the later rows and this button.
        (trigger.current ?? section.current?.querySelector<HTMLElement>('.cw-day-toggle, .cw-open'))?.focus({ preventScroll: true });
        onStateChange({ ...state, visible: { ...state.visible, [bucket.section]: 20 } });
        requestAnimationFrame(() => { if (pane && section.current) pane.scrollTop += section.current.getBoundingClientRect().top - top; });
      }}>Show less</button>}
    </div>}
  </section>;
}
function WorkDayView({ group, day, heading, onDay, children }: {
  group: WorkPage['groups'][number]; day: string | null; heading: boolean; onDay: (day: string, open: boolean) => void; children: React.ReactNode;
}) {
  const id = useId(), trigger = useRef<HTMLButtonElement>(null), rows = useRef<HTMLDivElement>(null);
  const date = group.date && ['Today', 'Tomorrow'].includes(group.label) && <time className="cw-day-date" dateTime={group.date}>{new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${group.date}T12:00:00Z`))}</time>;
  function toggle(day: string) {
    // Closing makes the rows inert at once; focus inside them returns to the heading instead of the page.
    if (group.open && rows.current?.contains(document.activeElement)) trigger.current?.focus({ preventScroll: true });
    onDay(day, !group.open);
  }
  const list = <ul className="cw-rows">{children}</ul>;
  return <section className="cw-day">
    {heading && <header className="cw-day-header" data-place-anchor={day ? `course-day-${day}` : undefined}>
      {day ? <h2><button ref={trigger} type="button" className="cw-day-toggle magic-fb-pill" aria-expanded={group.open} aria-controls={id} data-focus-key={`course-day-${day}`} onClick={() => toggle(day)}>
        <WorkGlyph name="chevron"/><span>{group.label}</span>{date}{!group.open && <span className="cw-day-count">· {group.total}</span>}</button></h2>
        : <><h2>{group.label}</h2>{date}</>}
    </header>}
    {/* The shared disclosure-rows recipe: the same mounted node changes height and opacity, so a reversal
        retargets from the painted value; closed rows are inert immediately and hidden once the exit ends. */}
    {day ? <div ref={rows} id={id} className="magic-motion-rows cw-day-rows" data-open={group.open} inert={!group.open}><div>{list}</div></div> : list}
  </section>;
}
function WorkRow({ row, today, hue, showDate, feedback, action, onOpen, onAction, onCheck, onRetry }: {
  row: CourseWorkRow; today: string; hue: string; showDate: boolean; feedback?: Feedback; action?: {pending:boolean;error?:string};
  onOpen: () => void; onAction: () => void; onCheck: (checked: boolean) => void; onRetry: () => void;
}) {
  const id = useId();
  const checkable = row.mode === 'task' && row.report !== null;
  const checked = !!row.report?.checked;
  const source = workSourceLabel(row);
  const kind = ({ assignment: 'Assignment', quiz: 'Quiz', exam: 'Exam', prep: 'Prep', lecture: 'Lecture', discussion: 'Discussion', class: 'Class' })[row.kind];
  const glyph = row.kind === 'lecture' || row.kind === 'discussion' || row.kind === 'class' ? 'lecture' : row.kind === 'prep' ? 'prep' : row.kind === 'exam' ? 'exam' : 'assignment';
  const status = feedback?.pending ? 'Saving…' : feedback?.error ?? ((row.report?.needsReview || row.report?.scheduleChanged) ? row.report.changeLabel ?? (row.report.needsReview ? 'Changed since you marked it done' : 'Schedule changed after you marked it done') : checked ? 'You marked this done' : '');
  return <li className="cw-row" data-kind={row.kind} data-checked={checked} data-place-anchor={workRowAnchor(row.key)}>
    {checkable ? <label className="cw-check cw-nested"><input type="checkbox" checked={checked} aria-label={`Mark ${row.title} ${checked ? 'not done' : 'done'}${row.kind === 'prep' ? ' for preparation' : ''}`}
      data-report-key={row.key} data-focus-key={workRowFocus(row.key, 'check')} aria-describedby={`${id}-status`} aria-disabled={feedback?.pending || undefined}
      onChange={() => { if (!feedback?.pending) onCheck(!checked); }}/>{checked && <WorkGlyph name="check"/>}</label>
      : <span className="cw-commitment"><WorkGlyph name={glyph}/></span>}
    <div className="cw-body"><div className="cw-meta"><span className="cw-course" data-magic-hue={hue}>{row.courseLabel}</span><span className="cw-kind">{checkable && <WorkGlyph name={glyph}/>} {kind}</span><span className="cw-time">{workTimeLabel(row, today, showDate)}</span></div>
      <h3 className="cw-title">{row.resourceId ? <button className="cw-open" type="button" data-focus-key={workRowFocus(row.key, 'open')} onClick={onOpen}>{row.title}</button> : row.title}</h3>
      {(checkable || source || row.meetingEvidence === 'weekly-pattern' || row.action) && <div id={`${id}-status`} className="cw-status">
        <span role="status" className={feedback?.error ? 'cw-error' : undefined}>{status}</span>
        {checked && row.report?.needsReview && <button className="cw-nested" aria-label={`Confirm ${row.title} is still done`} aria-disabled={feedback?.pending || undefined} onClick={() => { if (!feedback?.pending) onCheck(true); }}>Still done</button>}
        {checked && <button className="cw-nested" aria-disabled={feedback?.pending || undefined} onClick={() => { if (!feedback?.pending) onCheck(false); }}>Undo</button>}
        {feedback?.error && feedback.retry && <button className="cw-nested" onClick={onRetry}>Retry</button>}
        {source && <span>{source}</span>}{row.meetingEvidence === 'weekly-pattern' && <span>Weekly schedule · exceptions not confirmed</span>}
        {action?.error && <span role="status">{action.error}</span>}
      </div>}
    </div>
    {row.action && <div className="cw-primary cw-nested"><Action tone={row.mode === 'task' && !checked ? 'primary' : 'quiet'} pending={action?.pending} data-focus-key={workRowFocus(row.key, 'action')} onClick={onAction}>{row.action.label}</Action></div>}
  </li>;
}
