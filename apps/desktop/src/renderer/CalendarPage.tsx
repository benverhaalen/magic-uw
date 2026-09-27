import { MagicGlyph } from '../../../../packages/ui/src/glyph';
import { projectScheduleResources, type ScheduleAlias } from './schedule-projection';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Command, DayPlanEntry, ResourceView, SourceHealth, Link, PlanningSnapshot, PersonalCalendarEvent } from '@magic/contracts';
import { calendarCoverageDetail, projectCalendarCoverage, layoutLanes, localTime, planEntry, type RailSuggestion } from '@magic/domain';
import { Action } from '../../../../packages/ui/src';
import { EvidenceInfo } from '../../../../packages/ui/src/evidence-info';
import { monthVisibleItemCount } from './calendar/month-fit';
import { enrollmentCalendarItems, enrollmentScheduleNote } from './calendar/enrollment';
import { personalCalendarItems } from './calendar/personal';
import '../../../../packages/ui/src/evidence-info.css';
import { calendarItems, calendarItemLabel, clock, dayLabel, localMinuteInstant, localTime as calendarLocalTime, requestedSuggestions, shiftPeriod, visibleDates, type CalendarItem, type CalendarState } from './calendar/model';
import './calendar/calendar.css';

export type { CalendarState } from './calendar/model';
export interface CalendarPageProps {
  resources: ResourceView[];
  sources: SourceHealth[];
  links?: Link[];
  aliases?: ScheduleAlias[];
  plan: DayPlanEntry[];
  planning?: PlanningSnapshot;
  personalEvents?: PersonalCalendarEvent[];
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
type EventDraft = { id?: string; title: string; date: string; allDay: boolean; start: string; end: string; location: string; notes: string };
const timeInput = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const parseTime = (value: string) => /^\d{2}:\d{2}$/.test(value) ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : NaN;
export function CalendarPage({ resources, sources, links = [], aliases = [], plan, planning, personalEvents = [], state, onStateChange, onSelect, onPlan, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone, now: fixedNow, restoreFocusId, formatCourseLabel = (_id, name) => name }: CalendarPageProps) {
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
  const [selectedMeeting, setSelectedMeeting] = useState<CalendarItem | null>(null);
  const [selectedPersonal, setSelectedPersonal] = useState<CalendarItem | null>(null);
  const [draft, setDraft] = useState<EventDraft | null>(null);
  const [meetingTrigger, setMeetingTrigger] = useState<string | null>(null);
  const [personalTrigger, setPersonalTrigger] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (fixedNow) return; const id = setInterval(() => setLiveNow(new Date().toISOString()), 60000); return () => clearInterval(id); }, [fixedNow]);
  const update = (next: CalendarState) => { currentRef.current = next; setInternal(next); onStateChange?.(next); };
  const navigate = (patch: Partial<CalendarState>) => { setDetailDate(null); setRequestDate(null); setSelectedPlan(null); setSelectedMeeting(null); setSelectedPersonal(null); setDraft(null); setError(null); setNotice(''); update({ ...currentRef.current, scrollTop: 0, detailDate: undefined, selectedPlanKey: undefined, ...patch }); };
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
  const kinds: CalendarItem['kind'][] = ['class', 'exam', 'deadline', 'event', 'study', 'personal'];
  const shown = current.types ?? kinds;
  const calendarDayItems = (date: string) => [...calendarItems(scopedResources, plan, date, timeZone, links), ...enrollmentCalendarItems(planning, date, timeZone), ...personalCalendarItems(personalEvents, date, timeZone)].sort((a, b) => a.startMin - b.startMin || a.title.localeCompare(b.title));
  const days = useMemo(() => dates.map(date => ({ date, items: calendarDayItems(date).filter(item => shown.includes(item.kind)) })), [dates, scopedResources, plan, planning, personalEvents, timeZone, links, current.types]);
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
  useLayoutEffect(() => { if (selectedMeeting) document.getElementById('calendar-meeting-heading')?.focus({ preventScroll: true }); }, [selectedMeeting]);
  useLayoutEffect(() => { if (selectedPersonal) document.getElementById('calendar-personal-heading')?.focus({ preventScroll: true }); }, [selectedPersonal]);
  useLayoutEffect(() => { if (draft) document.getElementById('calendar-personal-title')?.focus({ preventScroll: true }); }, [draft?.id, Boolean(draft)]);
  useLayoutEffect(() => {
    if (!restoreFocusId || restoredFocus.current === restoreFocusId) return;
    const target = document.getElementById(restoreFocusId);
    if (!target) return;
    restoredFocus.current = restoreFocusId;
    target.focus({ preventScroll: true });
    if (dayPanel.current?.contains(target)) target.scrollIntoView({ block: 'nearest' });
  }, [restoreFocusId, detailDate, selectedPlan, monthSize]);
  const suggestions = requestDate ? requestedSuggestions(scopedResources, plan, requestDate, now, timeZone, [...enrollmentCalendarItems(planning, requestDate, timeZone), ...personalCalendarItems(personalEvents, requestDate, timeZone)]) : null;
  const coverage = useMemo(() => projectCalendarCoverage(sources, resources, now), [sources, resources, now]);
  function open(item: CalendarItem, date: string) {
    if (item.kind === 'study') { setDetailDate(null); setSelectedPlan(item); setRequestDate(null); setError(null); return; }
    if (item.kind === 'personal') { setPersonalTrigger(date.endsWith(':expanded') ? `calendar-more-${date.slice(0, 10)}` : focusId(date, item.key)); setDetailDate(null); setSelectedPersonal(item); setDraft(null); setRequestDate(null); setError(null); return; }
    if (item.kind === 'class' || (item.kind === 'exam' && item.sourceLabel === 'Course Search & Enroll')) { setMeetingTrigger(date.endsWith(':expanded') ? `calendar-more-${date.slice(0, 10)}` : focusId(date, item.key)); setDetailDate(null); setSelectedMeeting(item); setRequestDate(null); setError(null); return; }
    onSelect(item.resourceId, { ...currentRef.current, scrollTop: scroll.current?.scrollTop ?? 0, detailDate: detailDate ?? undefined, selectedPlanKey: undefined }, focusId(date, item.key));
  }
  function closeMeeting() { setSelectedMeeting(null); const id = meetingTrigger; if (id) requestAnimationFrame(() => document.getElementById(id)?.focus({ preventScroll: true })); }
  function closePersonal() { setSelectedPersonal(null); const id = personalTrigger; if (id) requestAnimationFrame(() => document.getElementById(id)?.focus({ preventScroll: true })); }
  async function save(command: Command, key: string, success: string) {
    if (pendingRef.current) return false;
    pendingRef.current = true; setPending(key); setError(null); setNotice('');
    try { await onPlan(command); if (mounted.current) setNotice(success); return true; }
    catch { if (mounted.current) setError('Could not confirm the change. Try again.'); return false; }
    finally { pendingRef.current = false; if (mounted.current) setPending(null); }
  }
  function editPersonal(event?: PersonalCalendarEvent) {
    const start = event?.startsAt ? calendarLocalTime(event.startsAt, timeZone) : null;
    const end = event?.endsAt ? calendarLocalTime(event.endsAt, timeZone) : null;
    setSelectedPersonal(null); setSelectedMeeting(null); setRequestDate(null); setError(null);
    setDraft({ id: event?.id, title: event?.title ?? '', date: start?.date ?? event?.date ?? currentRef.current.date, allDay: event?.allDay ?? false,
      start: timeInput(start?.min ?? 540), end: timeInput(end?.min ?? 600), location: event?.location ?? '', notes: event?.notes ?? '' });
  }
  async function savePersonal() {
    if (!draft) return;
    const start = draft.allDay ? null : localMinuteInstant(draft.date, parseTime(draft.start), timeZone);
    const end = draft.allDay ? null : localMinuteInstant(draft.date, parseTime(draft.end), timeZone);
    if (!draft.title.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(draft.date) || (!draft.allDay && (!start || !end || Date.parse(end) - Date.parse(start) < 15 * 60000))) {
      setError('Add a title and a valid time lasting at least 15 minutes. Times skipped by a clock change cannot be saved.'); return;
    }
    const event: PersonalCalendarEvent = { id: draft.id ?? crypto.randomUUID(), title: draft.title.trim(), date: draft.date, allDay: draft.allDay,
      startsAt: start, endsAt: end, timeZone, location: draft.location.trim(), notes: draft.notes.trim() };
    if (await save({ type: 'personal-calendar-save', event }, event.id, draft.id ? 'Personal event updated.' : 'Personal event added.')) { setDraft(null); requestAnimationFrame(() => document.getElementById(draft.id && personalTrigger || 'calendar-new-event')?.focus({ preventScroll: true })); }
  }
  async function accept(s: RailSuggestion) {
    if (!requestDate) return;
    const fresh = requestedSuggestions(scopedResources, plan, requestDate, fixedNow ?? new Date().toISOString(), timeZone, [...enrollmentCalendarItems(planning, requestDate, timeZone), ...personalCalendarItems(personalEvents, requestDate, timeZone)]).suggestions.find(x => x.id === s.id && x.startMin === s.startMin && x.endMin === s.endMin);
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
  function dayDisclosure(date: string, count: number, visible = 0) {
    return <button id={`calendar-more-${date}`} className="mc-calendar-more magic-fb-pill" aria-expanded={detailDate === date} aria-controls="calendar-day-panel" aria-haspopup="dialog" aria-label={`View all ${count} items for ${dayLabel(date, { weekday: 'long', month: 'long', day: 'numeric' })}`} onClick={() => { setDetailDate(date); setRequestDate(null); setSelectedPlan(null); }}>{current.view === 'month' ? `+${count - visible} more` : `View all ${count}`}</button>;
  }
  const detailItems = detailDate ? calendarDayItems(detailDate).filter(item => shown.includes(item.kind)) : [];
  const eventButton = (item: CalendarItem, date: string, compact = false) => <button key={item.key} id={focusId(date, item.key)} className={`mc-calendar-event mc-calendar-event--${item.kind}${compact ? ' mc-calendar-event--compact' : ''}${item.submitted ? ' mc-calendar-event--submitted' : ''}`} onClick={() => open(item, date)} title={`${item.title} · ${item.courseName} · ${item.detail}`}><span className="mc-calendar-event-title">{item.title}</span><span className="mc-calendar-event-detail">{item.kind === 'deadline' || (item.kind === 'exam' && item.precision) ? calendarItemLabel(item, compact) : compact && current.view === 'month' ? item.allDay ? 'All day' : clock(item.startMin) : item.detail}</span><span className="mc-calendar-event-course">{item.kind === 'class' || (item.kind === 'exam' && item.sourceLabel === 'Course Search & Enroll') ? item.courseName : formatCourseLabel(item.resourceId, item.courseName)}</span></button>;
  const label = current.view === 'month' ? dayLabel(current.date, { month: 'long', year: 'numeric' }) : `${dayLabel(dates[0], { month: 'long', day: 'numeric' })}–${dayLabel(dates[6], { ...(dates[0].slice(0, 7) !== dates[6].slice(0, 7) ? { month: 'short' as const } : {}), day: 'numeric' })}`;
  const monthMinRow = monthSize.rem > 20 ? '2rem' : '0px';
  return <section className="mc-calendar" aria-label="Calendar">
    <header className="mc-calendar-toolbar">
      <h2 tabIndex={-1}>{label}</h2><button className="mc-calendar-control" onClick={() => navigate({ date: today })}>Today</button>
      <div className="mc-calendar-arrows"><button className="mc-calendar-control" aria-label={`Previous ${current.view}`} onClick={() => navigate({ date: shiftPeriod(current.date, current.view, -1) })}><Chevron /></button><button className="mc-calendar-control" aria-label={`Next ${current.view}`} onClick={() => navigate({ date: shiftPeriod(current.date, current.view, 1) })}><Chevron next /></button></div>
      <div className="mc-calendar-view" aria-label="Calendar view">{(['week', 'month'] as const).map(view => <button key={view} aria-pressed={current.view === view} onClick={() => navigate({ view })}>{view === 'week' ? 'Week' : 'Month'}</button>)}</div>
      <button id="calendar-new-event" className="mc-calendar-control" onClick={() => editPersonal()}>New event</button>
      <button ref={requestButton} className="mc-calendar-find" onClick={() => { setDetailDate(null); setRequestDate(current.date); setSelectedPlan(null); setError(null); setNotice(''); }}>Find study time <span aria-hidden="true">→</span></button>
    </header>
    <div className="mc-calendar-meta"><span>{timeZone.replaceAll('_', ' ')}</span><span>{coverage.summary} <EvidenceInfo label="About calendar coverage">{calendarCoverageDetail(coverage, timeZone)}</EvidenceInfo></span></div>
    <div className="mc-calendar-filters" role="group" aria-label="Show calendar types">{([['class', 'Classes'], ['exam', 'Exams & quizzes'], ['deadline', 'Due work'], ['event', 'Other events'], ['study', 'Study time'], ['personal', 'Personal']] as const).map(([kind, label]) => <label key={kind}><input type="checkbox" checked={shown.includes(kind)} onChange={() => update({ ...currentRef.current, types: shown.includes(kind) ? shown.filter(value => value !== kind) : [...shown, kind] })}/>{label}</label>)}</div>
    {enrollmentScheduleNote(planning) && <p className="mc-calendar-schedule-note">{enrollmentScheduleNote(planning)}</p>}
    {detailDate && <div ref={dayPanel} id="calendar-day-panel" popover="auto" role="dialog" aria-labelledby="calendar-day-heading" className="mc-calendar-day-popover"
      onToggle={event => { if (!event.currentTarget.matches(':popover-open')) closeDay(false); }}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeDay(); } }}
      onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) closeDay(false); }}>
      <div className="mc-calendar-review-heading"><div><h3 id="calendar-day-heading" tabIndex={-1}>{dayLabel(detailDate, { weekday: 'long', month: 'long', day: 'numeric' })}</h3><p>All {detailItems.length} items for this day</p></div><button className="mc-calendar-control" onClick={() => closeDay()}>Close</button></div>
      <div className="mc-calendar-day-list">{detailItems.map(item => eventButton(item, detailDate + ':expanded'))}</div>
    </div>}
    {(requestDate || selectedPlan || selectedMeeting) && <section className="mc-calendar-review" aria-label={requestDate ? 'Review study suggestions' : selectedMeeting ? 'Class meeting details' : 'Planned study time'} onKeyDown={event => { if (event.key === 'Escape' && selectedMeeting) { event.preventDefault(); closeMeeting(); } }}>
      <div className="mc-calendar-review-heading"><h3 id={selectedMeeting ? 'calendar-meeting-heading' : undefined} tabIndex={selectedMeeting ? -1 : undefined}>{requestDate ? `Study time · ${dayLabel(requestDate, { weekday: 'short', month: 'short', day: 'numeric' })}` : (selectedPlan ?? selectedMeeting)!.title}</h3><button id="calendar-review-close" className="mc-calendar-control" onClick={() => { setRequestDate(null); setSelectedPlan(null); if (selectedMeeting) closeMeeting(); else requestButton.current?.focus(); setError(null); }}>Close</button></div>
      {selectedMeeting && <p>{clock(selectedMeeting.startMin)}–{clock(selectedMeeting.endMin)} · {selectedMeeting.detail}{selectedMeeting.needsReview ? ' · Schedule needs verification in My UW' : ''}</p>}
      {requestDate && <><p>Suggestions use captured deadlines and open time. Review before adding; nothing is scheduled automatically.</p><label className="mc-calendar-date-label">Find time on <input type="date" value={requestDate} onChange={e => { if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) { setRequestDate(e.target.value); setError(null); } }} /></label>{suggestions!.unavailable ? <p>{suggestions!.unavailable}</p> : suggestions!.suggestions.length === 0 ? <p>No suitable blocks found in the available schedule for this day. Your calendar has not changed.</p> : suggestions!.suggestions.map(s => <article className="mc-calendar-suggestion" key={s.id}><div><strong>{s.title}</strong><span>{clock(s.startMin)}–{clock(s.endMin)} · {formatCourseLabel(s.resourceId, s.courseName)}</span><p>{s.reason}</p></div><Action disabled={pending !== null} pending={pending === s.id} onClick={() => accept(s)}>Add to calendar</Action></article>)}</>}
      {selectedPlan?.entry && <><p>{selectedPlan.detail} · {formatCourseLabel(selectedPlan.resourceId, selectedPlan.courseName)}</p><div className="mc-calendar-plan-actions"><button id="calendar-open-study" className="mc-calendar-control" onClick={() => onSelect(selectedPlan.resourceId, { ...currentRef.current, selectedPlanKey: selectedPlan.entry!.key, detailDate: undefined }, 'calendar-open-study')}>Open study material</button><Action disabled={pending !== null} pending={pending === selectedPlan.key} onClick={async () => { const entry = selectedPlan.entry!; if (await save({ type: 'day-plan-remove', key: entry.key, date: entry.date }, selectedPlan.key, 'Study block removed.')) { setRemovedEntry(entry); setSelectedPlan(null); requestButton.current?.focus(); } }}>Remove from calendar</Action></div></>}
      <div className="mc-calendar-action-feedback">
        <span className="mc-calendar-feedback-reserve" aria-hidden="true">Schedule changed. Review these suggestions.</span>
        <span role={error ? 'alert' : 'status'}>{error ?? (pending ? 'Saving…' : '')}</span>
      </div>
    </section>}
    {selectedPersonal?.personalEvent && <section className="mc-calendar-review" aria-label="Personal event details" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); closePersonal(); } }}><div className="mc-calendar-review-heading"><h3 id="calendar-personal-heading" tabIndex={-1}>{selectedPersonal.title}</h3><button className="mc-calendar-control" onClick={closePersonal}>Close</button></div><p>{selectedPersonal.detail}{selectedPersonal.personalEvent.notes ? ` · ${selectedPersonal.personalEvent.notes}` : ''}</p><div className="mc-calendar-plan-actions"><button className="mc-calendar-control" onClick={() => editPersonal(selectedPersonal.personalEvent)}>Edit event</button><button className="mc-calendar-control" disabled={pending !== null} onClick={async () => { const id = selectedPersonal.personalEvent!.id; if (await save({ type: 'personal-calendar-remove', id }, id, 'Personal event removed.')) { setSelectedPersonal(null); requestAnimationFrame(() => document.getElementById('calendar-new-event')?.focus({ preventScroll: true })); } }}>Delete event</button></div></section>}
    {draft && <form className="mc-calendar-review mc-calendar-personal-form" aria-label={draft.id ? 'Edit personal event' : 'New personal event'} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); const id = draft.id && personalTrigger || 'calendar-new-event'; setDraft(null); requestAnimationFrame(() => document.getElementById(id)?.focus({ preventScroll: true })); } }} onSubmit={event => { event.preventDefault(); void savePersonal(); }}>
      <div className="mc-calendar-review-heading"><h3>{draft.id ? 'Edit event' : 'New event'}</h3><button type="button" className="mc-calendar-control" onClick={() => { const id = draft.id && personalTrigger || 'calendar-new-event'; setDraft(null); setError(null); requestAnimationFrame(() => document.getElementById(id)?.focus({ preventScroll: true })); }}>Cancel</button></div>
      <label>Title<input id="calendar-personal-title" required maxLength={200} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })}/></label>
      <label>Date<input required type="date" value={draft.date} onChange={event => setDraft({ ...draft, date: event.target.value })}/></label>
      <label className="mc-calendar-personal-check"><input type="checkbox" checked={draft.allDay} onChange={event => setDraft({ ...draft, allDay: event.target.checked })}/>All day</label>
      {!draft.allDay && <div className="mc-calendar-personal-times"><label>Start<input required type="time" value={draft.start} onChange={event => setDraft({ ...draft, start: event.target.value })}/></label><label>End<input required type="time" value={draft.end} onChange={event => setDraft({ ...draft, end: event.target.value })}/></label></div>}
      <label>Location<input maxLength={300} value={draft.location} onChange={event => setDraft({ ...draft, location: event.target.value })}/></label>
      <label>Notes<textarea maxLength={2000} value={draft.notes} onChange={event => setDraft({ ...draft, notes: event.target.value })}/></label>
      <p>Saved on this device. Times use {timeZone.replaceAll('_', ' ')}.</p><div className="mc-calendar-plan-actions"><Action disabled={pending !== null} pending={pending !== null} type="submit">Save event</Action></div>
      {error && <span role="alert">{error}</span>}
    </form>}
    <div className="mc-calendar-feedback" role="status">{notice}{removedEntry && <button className="mc-calendar-control" disabled={pending !== null} onClick={async () => { if (await save({ type: 'day-plan', entry: removedEntry }, removedEntry.key, 'Study block restored.')) setRemovedEntry(null); }}>Undo removal</button>}{error && !requestDate && !selectedPlan && <span role="alert">{error}</span>}</div>
    <div className={`mc-calendar-scroll${current.view === 'month' ? ' mc-calendar-scroll--month' : ''}`} ref={scroll} onScroll={e => { const next = { ...currentRef.current, scrollTop: e.currentTarget.scrollTop }; currentRef.current = next; setInternal(next); onStateChange?.(next); }}>
      {current.view === 'week' ? <div className="mc-calendar-week">
        <div className="mc-calendar-days"><span />{days.map(day => <button key={day.date} aria-pressed={day.date === current.date} aria-current={day.date === today ? 'date' : undefined} onClick={() => navigate({ date: day.date, scrollTop: scroll.current?.scrollTop ?? 0 })}><span>{dayLabel(day.date, { weekday: 'short' })}</span><strong>{dayLabel(day.date, { day: 'numeric' })}</strong></button>)}</div>
        <div className="mc-calendar-all-day"><span>All day<br />& due</span>{days.map(day => { const allDay = day.items.filter(x => x.allDay); return <div key={day.date}>{allDay.slice(0, 1).map(item => eventButton(item, day.date, true))}{allDay.length > 1 && dayDisclosure(day.date, day.items.length)}</div>; })}</div>
        <div className="mc-calendar-time-grid" style={{ height: (endHour - startHour) * 64 + 28 }}><div className="mc-calendar-time-labels">{hours.map(hour => <span key={hour} style={{ top: (hour - startHour) * 64 }}>{hour === 24 ? '12 AM' : `${hour % 12 || 12} ${hour < 12 ? 'AM' : 'PM'}`}</span>)}</div>
          {days.map(day => { const entries = day.items.filter(x => !x.allDay); const lanes = layoutLanes(entries.map(x => ({ id: x.key, startMin: x.startMin, endMin: Math.max(x.endMin, x.startMin + 25) }))); return <div className="mc-calendar-time-day" key={day.date}>{hours.map(hour => <div className="mc-calendar-hour-line" key={hour} style={{ top: (hour - startHour) * 64 }} />)}{entries.map(item => { const lane = lanes.get(item.key)!; return <div className="mc-calendar-event-slot" key={item.key} style={{ top: (item.startMin / 60 - startHour) * 64, height: Math.max(26, (item.endMin - item.startMin) / 60 * 64 - 2), left: `${lane.lane / lane.lanes * 100}%`, width: `${100 / lane.lanes}%` }}>{eventButton(item, day.date)}</div>; })}{day.date === today && localTime(now, timeZone).min >= startHour * 60 && localTime(now, timeZone).min <= endHour * 60 && <div className="mc-calendar-now" style={{ top: (localTime(now, timeZone).min / 60 - startHour) * 64 }} aria-label={`Current time ${clock(localTime(now, timeZone).min)}`} />}</div>; })}
        </div>
      </div> : <div className="mc-calendar-month"><div className="mc-calendar-month-head">{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => <span key={day}>{day}</span>)}</div><div className="mc-calendar-month-days" ref={monthGrid} style={{ gridTemplateRows: `repeat(${days.length / 7}, minmax(${monthMinRow}, 1fr))` }}>{days.map(day => { const visibleCount = monthVisibleItemCount(day.items.length, monthSize.rowHeight, monthSize.rem); return <section key={day.date} className={day.date.slice(0, 7) !== current.date.slice(0, 7) ? 'mc-calendar-other-month' : ''} aria-label={dayLabel(day.date, { month: 'long', day: 'numeric' })}><button className="mc-calendar-day-number" aria-current={day.date === today ? 'date' : undefined} aria-label={`Open week of ${dayLabel(day.date, { month: 'long', day: 'numeric' })}`} onClick={() => navigate({ date: day.date, view: 'week' })}>{dayLabel(day.date, { ...(day.date.endsWith('-01') ? { month: 'short' as const } : {}), day: 'numeric' })}</button>{day.items.slice(0, visibleCount).map(item => eventButton(item, day.date, true))}{day.items.length > visibleCount && dayDisclosure(day.date, day.items.length, visibleCount)}</section>; })}</div></div>}
    </div>
    {!days.some(day => day.items.length) && <p className="mc-calendar-empty">{shown.length === 0 ? 'All calendar types are hidden. Turn on a type above to see its events.' : 'No visible commitments in this view. Check another date or change the types shown above.'}</p>}
  </section>;
}
