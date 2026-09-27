import { MagicGlyph } from '../../../../packages/ui/src/glyph';
import { projectScheduleResources, type ScheduleAlias } from './schedule-projection';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Command, DayPlanEntry, ResourceView, SourceHealth, Link } from '@magic/contracts';
import { calendarCoverageDetail, projectCalendarCoverage, layoutLanes, localTime, planEntry, type RailSuggestion } from '@magic/domain';
import { Action } from '../../../../packages/ui/src';
import { EvidenceInfo } from '../../../../packages/ui/src/evidence-info';
import { monthVisibleItemCount } from './calendar/month-fit';
import '../../../../packages/ui/src/evidence-info.css';
import { calendarItems, calendarItemLabel, clock, dayLabel, requestedSuggestions, shiftPeriod, visibleDates, type CalendarItem, type CalendarState } from './calendar/model';
import './calendar/calendar.css';

export type { CalendarState } from './calendar/model';
export interface CalendarPageProps {
  resources: ResourceView[];
  sources: SourceHealth[];
  links?: Link[];
  aliases?: ScheduleAlias[];
  plan: DayPlanEntry[];
  state?: CalendarState;
  onStateChange?: (state: CalendarState) => void;
  onSelect: (resourceId: string, returnState: CalendarState, focusId: string) => void;
  onPlan: (command: Command) => Promise<unknown>;
  timeZone?: string;
  /** Test clock only. Production omits it and updates each minute. */
  now?: string;
  restoreFocusId?: string;
  /** Shared display normalization can be supplied without changing source identity. */
  formatCourseLabel?: (resourceId: string, courseName: string) => string;
}
function Chevron({ next = false }: { next?: boolean }) {
  return <MagicGlyph name={next ? 'chevron' : 'chevronLeft'} size={16} />;
}
const focusId = (date: string, key: string) => `calendar-item-${encodeURIComponent(date + ':' + key)}`;
export function CalendarPage({ resources, sources, links = [], aliases = [], plan, state, onStateChange, onSelect, onPlan, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone, now: fixedNow, restoreFocusId, formatCourseLabel = (_id, name) => name }: CalendarPageProps) {
  const [liveNow, setLiveNow] = useState(() => new Date().toISOString());
  const now = fixedNow ?? liveNow, today = localTime(now, timeZone).date;
  const [internal, setInternal] = useState<CalendarState>(() => ({ view: 'week', date: today, scrollTop: 0 }));
  const current = state ?? internal;
  const monthGrid = useRef<HTMLDivElement>(null);
  const [monthSize, setMonthSize] = useState({ rowHeight: 0, rem: 16 });
  const currentRef = useRef(current); currentRef.current = current;
  const scroll = useRef<HTMLDivElement>(null), requestButton = useRef<HTMLButtonElement>(null);
  const [detailDate, setDetailDate] = useState<string | null>(() => current.detailDate ?? null);
  const dayPanel = useRef<HTMLDivElement>(null);
  const restoredFocus = useRef<string | undefined>(undefined);
  const [requestDate, setRequestDate] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null), pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState('');
  const [removedEntry, setRemovedEntry] = useState<DayPlanEntry | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<CalendarItem | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (fixedNow) return; const id = setInterval(() => setLiveNow(new Date().toISOString()), 60000); return () => clearInterval(id); }, [fixedNow]);
  const update = (next: CalendarState) => { currentRef.current = next; setInternal(next); onStateChange?.(next); };
  const navigate = (patch: Partial<CalendarState>) => { setDetailDate(null); setRequestDate(null); setSelectedPlan(null); setError(null); setNotice(''); update({ ...currentRef.current, scrollTop: 0, detailDate: undefined, selectedPlanKey: undefined, ...patch }); };
  const scopedResources = useMemo(() => { const byId = new Map(sources.map(s => [s.id, s])); return projectScheduleResources(resources.map(r => ({ ...r, accountScope: byId.get(r.sourceId)?.accountScope, sourceScope: byId.get(r.sourceId)?.scope, sourceKind: byId.get(r.sourceId)?.kind })), links, aliases); }, [resources, sources, links, aliases]);
  const dates = useMemo(() => visibleDates(current.date, current.view), [current.date, current.view]);
  useLayoutEffect(() => {
    const grid = monthGrid.current;
    if (current.view !== 'month' || !grid) return;
    const measure = () => {
      const row = grid.firstElementChild;
      if (!row) return;
      const rowHeight = row.getBoundingClientRect().height;
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      setMonthSize(previous => previous.rowHeight === rowHeight && previous.rem === rem ? previous : { rowHeight, rem });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    observer.observe(grid.firstElementChild!);
    return () => observer.disconnect();
  }, [current.view, dates.length]);
  const days = useMemo(() => dates.map(date => ({ date, items: calendarItems(scopedResources, plan, date, timeZone, links) })), [dates, scopedResources, plan, timeZone, links]);
  const timed = days.flatMap(day => day.items.filter(x => !x.allDay));
  const startHour = Math.max(0, Math.min(8, ...timed.map(x => Math.floor(x.startMin / 60))));
  const endHour = Math.min(24, Math.max(18, ...timed.map(x => Math.ceil(x.endMin / 60))));
  const hours = Array.from({ length: endHour - startHour + 1 }, (_, i) => startHour + i);
  useLayoutEffect(() => { if (scroll.current) scroll.current.scrollTop = currentRef.current.scrollTop; }, [current.date, current.view]);
  useLayoutEffect(() => { if (current.selectedPlanKey) { const entry = plan.find(p => p.key === current.selectedPlanKey && p.status === 'accepted'); if (entry) setSelectedPlan(calendarItems(scopedResources, plan, entry.date, timeZone, links).find(i => i.entry?.key === entry.key) ?? null); } }, []);
  useLayoutEffect(() => {
    if (!detailDate || !dayPanel.current) return;
    dayPanel.current.showPopover();
    // Long day lists begin at their heading; Back restores the exact item below.
    document.getElementById('calendar-day-heading')?.focus({ preventScroll: true });
  }, [detailDate]);
  useLayoutEffect(() => {
    if (!restoreFocusId || restoredFocus.current === restoreFocusId) return;
    const target = document.getElementById(restoreFocusId);
    if (!target) return;
    restoredFocus.current = restoreFocusId;
    target.focus({ preventScroll: true });
    if (dayPanel.current?.contains(target)) target.scrollIntoView({ block: 'nearest' });
  }, [restoreFocusId, detailDate, selectedPlan, monthSize]);
  const suggestions = requestDate ? requestedSuggestions(scopedResources, plan, requestDate, now, timeZone) : null;
  const coverage = useMemo(() => projectCalendarCoverage(sources, resources, now), [sources, resources, now]);
  function open(item: CalendarItem, date: string) {
    if (item.kind === 'study') { setDetailDate(null); setSelectedPlan(item); setRequestDate(null); setError(null); return; }
    onSelect(item.resourceId, { ...currentRef.current, scrollTop: scroll.current?.scrollTop ?? 0, detailDate: detailDate ?? undefined, selectedPlanKey: undefined }, focusId(date, item.key));
  }
  async function save(command: Command, key: string, success: string) {
    if (pendingRef.current) return false;
    pendingRef.current = true; setPending(key); setError(null); setNotice('');
    try { await onPlan(command); if (mounted.current) setNotice(success); return true; }
    catch { if (mounted.current) setError('Could not confirm the change. Try again.'); return false; }
    finally { pendingRef.current = false; if (mounted.current) setPending(null); }
  }
  async function accept(s: RailSuggestion) {
    if (!requestDate) return;
    const fresh = requestedSuggestions(scopedResources, plan, requestDate, fixedNow ?? new Date().toISOString(), timeZone).suggestions.find(x => x.id === s.id && x.startMin === s.startMin && x.endMin === s.endMin);
    if (!fresh) { setError('Schedule changed. Review these suggestions.'); return; }
    if (await save({ type: 'day-plan', entry: planEntry(fresh, requestDate, 'accepted') }, s.id, 'Study time added to your calendar.')) document.getElementById('calendar-review-close')?.focus();
  }
  function closeDay(restoreTrigger = true) {
    const date = detailDate;
    dayPanel.current?.hidePopover();
    setDetailDate(null);
    update({ ...currentRef.current, detailDate: undefined });
    if (restoreTrigger && date) document.getElementById(`calendar-more-${date}`)?.focus({ preventScroll: true });
  }
  function dayDisclosure(date: string, count: number) {
    return <button id={`calendar-more-${date}`} className="mc-calendar-more magic-fb-pill" aria-expanded={detailDate === date} aria-controls="calendar-day-panel" aria-haspopup="dialog" aria-label={`View all ${count} items for ${dayLabel(date, { weekday: 'long', month: 'long', day: 'numeric' })}`} onClick={() => { setDetailDate(date); setRequestDate(null); setSelectedPlan(null); }}>{current.view === 'month' ? 'All' : 'View all'} {count}</button>;
  }
  const detailItems = detailDate ? calendarItems(scopedResources, plan, detailDate, timeZone, links) : [];
  const eventButton = (item: CalendarItem, date: string, compact = false) => <button key={item.key} id={focusId(date, item.key)} className={`mc-calendar-event mc-calendar-event--${item.kind}${compact ? ' mc-calendar-event--compact' : ''}${item.submitted ? ' mc-calendar-event--submitted' : ''}`} onClick={() => open(item, date)} title={`${item.title} · ${item.courseName} · ${item.detail}`}><span className="mc-calendar-event-title">{item.title}</span><span className="mc-calendar-event-detail">{item.kind === 'deadline' ? calendarItemLabel(item, compact) : compact && current.view === 'month' ? item.allDay ? 'All day' : clock(item.startMin) : item.detail}</span><span className="mc-calendar-event-course">{formatCourseLabel(item.resourceId, item.courseName)}</span></button>;
  const label = current.view === 'month' ? dayLabel(current.date, { month: 'long', year: 'numeric' }) : `${dayLabel(dates[0], { month: 'long', day: 'numeric' })}–${dayLabel(dates[6], { ...(dates[0].slice(0, 7) !== dates[6].slice(0, 7) ? { month: 'short' as const } : {}), day: 'numeric' })}`;
  return <section className="mc-calendar" aria-label="Calendar">
    <header className="mc-calendar-toolbar">
      <h2 tabIndex={-1}>{label}</h2><button className="mc-calendar-control" onClick={() => navigate({ date: today })}>Today</button>
      <div className="mc-calendar-arrows"><button className="mc-calendar-control" aria-label={`Previous ${current.view}`} onClick={() => navigate({ date: shiftPeriod(current.date, current.view, -1) })}><Chevron /></button><button className="mc-calendar-control" aria-label={`Next ${current.view}`} onClick={() => navigate({ date: shiftPeriod(current.date, current.view, 1) })}><Chevron next /></button></div>
      <div className="mc-calendar-view" aria-label="Calendar view">{(['week', 'month'] as const).map(view => <button key={view} aria-pressed={current.view === view} onClick={() => navigate({ view })}>{view === 'week' ? 'Week' : 'Month'}</button>)}</div>
      <button ref={requestButton} className="mc-calendar-find" onClick={() => { setDetailDate(null); setRequestDate(current.date); setSelectedPlan(null); setError(null); setNotice(''); }}>Find study time <span aria-hidden="true">→</span></button>
    </header>
    <div className="mc-calendar-meta"><span>{timeZone.replaceAll('_', ' ')}</span><span>{coverage.summary} <EvidenceInfo label="About calendar coverage">{calendarCoverageDetail(coverage, timeZone)}</EvidenceInfo></span></div>
    {detailDate && <div ref={dayPanel} id="calendar-day-panel" popover="auto" role="dialog" aria-labelledby="calendar-day-heading" className="mc-calendar-day-popover"
      onToggle={event => { if (!event.currentTarget.matches(':popover-open')) closeDay(false); }}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeDay(); } }}
      onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) closeDay(false); }}>
      <div className="mc-calendar-review-heading"><div><h3 id="calendar-day-heading" tabIndex={-1}>{dayLabel(detailDate, { weekday: 'long', month: 'long', day: 'numeric' })}</h3><p>All {detailItems.length} items for this day</p></div><button className="mc-calendar-control" onClick={() => closeDay()}>Close</button></div>
      <div className="mc-calendar-day-list">{detailItems.map(item => eventButton(item, detailDate + ':expanded'))}</div>
    </div>}
    {(requestDate || selectedPlan) && <section className="mc-calendar-review" aria-label={requestDate ? 'Review study suggestions' : 'Planned study time'}>
      <div className="mc-calendar-review-heading"><h3>{requestDate ? `Study time · ${dayLabel(requestDate, { weekday: 'short', month: 'short', day: 'numeric' })}` : selectedPlan!.title}</h3><button id="calendar-review-close" className="mc-calendar-control" onClick={() => { setRequestDate(null); setSelectedPlan(null); setError(null); requestButton.current?.focus(); }}>Close</button></div>
      {requestDate && <><p>Suggestions use captured deadlines and open time. Review before adding; nothing is scheduled automatically.</p><label className="mc-calendar-date-label">Find time on <input type="date" value={requestDate} onChange={e => { if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) { setRequestDate(e.target.value); setError(null); } }} /></label>{suggestions!.unavailable ? <p>{suggestions!.unavailable}</p> : suggestions!.suggestions.length === 0 ? <p>No suitable blocks found in the available schedule for this day. Your calendar has not changed.</p> : suggestions!.suggestions.map(s => <article className="mc-calendar-suggestion" key={s.id}><div><strong>{s.title}</strong><span>{clock(s.startMin)}–{clock(s.endMin)} · {formatCourseLabel(s.resourceId, s.courseName)}</span><p>{s.reason}</p></div><Action disabled={pending !== null} pending={pending === s.id} onClick={() => accept(s)}>Add to calendar</Action></article>)}</>}
      {selectedPlan?.entry && <><p>{selectedPlan.detail} · {formatCourseLabel(selectedPlan.resourceId, selectedPlan.courseName)}</p><div className="mc-calendar-plan-actions"><button id="calendar-open-study" className="mc-calendar-control" onClick={() => onSelect(selectedPlan.resourceId, { ...currentRef.current, selectedPlanKey: selectedPlan.entry!.key, detailDate: undefined }, 'calendar-open-study')}>Open study material</button><Action disabled={pending !== null} pending={pending === selectedPlan.key} onClick={async () => { const entry = selectedPlan.entry!; if (await save({ type: 'day-plan-remove', key: entry.key, date: entry.date }, selectedPlan.key, 'Study block removed.')) { setRemovedEntry(entry); setSelectedPlan(null); requestButton.current?.focus(); } }}>Remove from calendar</Action></div></>}
      <div className="mc-calendar-action-feedback">
        <span className="mc-calendar-feedback-reserve" aria-hidden="true">Schedule changed. Review these suggestions.</span>
        <span role={error ? 'alert' : 'status'}>{error ?? (pending ? 'Saving…' : '')}</span>
      </div>
    </section>}
    <div className="mc-calendar-feedback" role="status">{notice}{removedEntry && <button className="mc-calendar-control" disabled={pending !== null} onClick={async () => { if (await save({ type: 'day-plan', entry: removedEntry }, removedEntry.key, 'Study block restored.')) setRemovedEntry(null); }}>Undo removal</button>}{error && !requestDate && !selectedPlan && <span role="alert">{error}</span>}</div>
    <div className={`mc-calendar-scroll${current.view === 'month' ? ' mc-calendar-scroll--month' : ''}`} ref={scroll} onScroll={e => { const next = { ...currentRef.current, scrollTop: e.currentTarget.scrollTop }; currentRef.current = next; setInternal(next); onStateChange?.(next); }}>
      {current.view === 'week' ? <div className="mc-calendar-week">
        <div className="mc-calendar-days"><span />{days.map(day => <button key={day.date} aria-pressed={day.date === current.date} aria-current={day.date === today ? 'date' : undefined} onClick={() => navigate({ date: day.date, scrollTop: scroll.current?.scrollTop ?? 0 })}><span>{dayLabel(day.date, { weekday: 'short' })}</span><strong>{dayLabel(day.date, { day: 'numeric' })}</strong></button>)}</div>
        <div className="mc-calendar-all-day"><span>All day<br />& due</span>{days.map(day => <div key={day.date}>{day.items.filter(x => x.allDay).slice(0, 2).map(item => eventButton(item, day.date, true))}{day.items.filter(x => x.allDay).length > 2 && dayDisclosure(day.date, day.items.length)}</div>)}</div>
        <div className="mc-calendar-time-grid" style={{ height: (endHour - startHour) * 64 + 28 }}><div className="mc-calendar-time-labels">{hours.map(hour => <span key={hour} style={{ top: (hour - startHour) * 64 }}>{hour === 24 ? '12 AM' : `${hour % 12 || 12} ${hour < 12 ? 'AM' : 'PM'}`}</span>)}</div>
          {days.map(day => { const entries = day.items.filter(x => !x.allDay); const lanes = layoutLanes(entries.map(x => ({ id: x.key, startMin: x.startMin, endMin: Math.max(x.endMin, x.startMin + 25) }))); return <div className="mc-calendar-time-day" key={day.date}>{hours.map(hour => <div className="mc-calendar-hour-line" key={hour} style={{ top: (hour - startHour) * 64 }} />)}{entries.map(item => { const lane = lanes.get(item.key)!; return <div className="mc-calendar-event-slot" key={item.key} style={{ top: (item.startMin / 60 - startHour) * 64, height: Math.max(26, (item.endMin - item.startMin) / 60 * 64 - 2), left: `${lane.lane / lane.lanes * 100}%`, width: `${100 / lane.lanes}%` }}>{eventButton(item, day.date)}</div>; })}{day.date === today && localTime(now, timeZone).min >= startHour * 60 && localTime(now, timeZone).min <= endHour * 60 && <div className="mc-calendar-now" style={{ top: (localTime(now, timeZone).min / 60 - startHour) * 64 }} aria-label={`Current time ${clock(localTime(now, timeZone).min)}`} />}</div>; })}
        </div>
      </div> : <div className="mc-calendar-month"><div className="mc-calendar-month-head">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => <span key={day}>{day}</span>)}</div><div className="mc-calendar-month-days" ref={monthGrid} style={{ gridTemplateRows: `repeat(${days.length / 7}, minmax(4rem, 1fr))` }}>{days.map(day => { const visibleCount = monthVisibleItemCount(day.items.length, monthSize.rowHeight, monthSize.rem); return <section key={day.date} className={day.date.slice(0, 7) !== current.date.slice(0, 7) ? 'mc-calendar-other-month' : ''} aria-label={dayLabel(day.date, { month: 'long', day: 'numeric' })}><button className="mc-calendar-day-number" aria-current={day.date === today ? 'date' : undefined} aria-label={`Open week of ${dayLabel(day.date, { month: 'long', day: 'numeric' })}`} onClick={() => navigate({ date: day.date, view: 'week' })}>{dayLabel(day.date, { ...(day.date.endsWith('-01') ? { month: 'short' as const } : {}), day: 'numeric' })}</button>{day.items.slice(0, visibleCount).map(item => eventButton(item, day.date, true))}{day.items.length > visibleCount && dayDisclosure(day.date, day.items.length)}</section>; })}</div></div>}
    </div>
    {!days.some(day => day.items.length) && <p className="mc-calendar-empty">No captured commitments in this {current.view}. Open another date or connect a calendar in Settings.</p>}
  </section>;
}
