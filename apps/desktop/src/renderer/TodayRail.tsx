import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Command,
  DayPlanEntry,
  ResourceView,
  SourceHealth,
} from "@magic/contracts";
import {
  buildTodayRail,
  localTime,
  changeNotes,
  layoutLanes,
  planEntry,
  validatePlanEdit,
  type RailChange,
  type RailSuggestion,
} from "@magic/domain";

const HOUR_PX = 44;
const PROVIDER_LABEL = { teams: "Teams", zoom: "Zoom", webex: "Webex", meet: "Meet" } as const;
const RESPONSE_LABEL = {
  accepted: "Accepted",
  tentative: "Tentative",
  declined: "Declined",
  pending: "Not answered",
  organizer: "You're organizing",
} as const;
/** Home shows every due item up to this count; beyond it, one fewer plus an explicit "more". */
const HOME_DUE_ALL = 6;
const HOME_ALL_DAY_ALL = 3;

/** Saved capture coverage is not a promise that no unobserved event exists. */
export function calendarCoverageNeedsCheck(sources: SourceHealth[], now: string): boolean {
  const calendars = sources.filter(source => source.kind === "calendar" || source.scope === "calendar");
  return !calendars.length || calendars.some(source => source.status !== "ok" || !source.complete ||
    !source.lastSuccessAt || !Number.isFinite(Date.parse(source.lastSuccessAt)) ||
    Date.parse(now) - Date.parse(source.lastSuccessAt) > 24 * 60 * 60 * 1000);
}
export function emptyScheduleMessage(sources: SourceHealth[], hasAllDay: boolean, now: string): string {
  const calendars = sources.filter(source => source.kind === "calendar" || source.scope === "calendar");
  if (!calendars.length) return "No calendar source checked yet.";
  if (calendars.some(source => source.status !== "ok" || !source.complete || !source.lastSuccessAt))
    return "No timed events found. Calendar coverage is incomplete.";
  if (calendarCoverageNeedsCheck(sources, now)) return "No timed events in the saved calendar. It may be out of date.";
  return hasAllDay ? "No timed events in today’s saved schedule." : "No events today in the saved calendar.";
}

function clock(min: number) {
  const h = Math.floor(min / 60) % 24,
    m = min % 60;
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
function hourLabel(h: number) {
  return `${h % 12 || 12}${h < 12 || h === 24 ? "a" : "p"}`;
}
function hhmm(min: number) {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}
function fromHhmm(value: string) {
  const [h, m] = value.split(":").map(Number);
  return Number.isFinite(h) ? h! * 60 + (m ?? 0) : NaN;
}
const isStudy = (s: RailSuggestion) => s.type !== "work";
function duration(min: number) {
  const h = Math.floor(min / 60),
    m = min % 60;
  return h ? `${h} h${m ? ` ${m} m` : ""}` : `${m} m`;
}

export function TodayRail({
  resources,
  sources,
  plan = [],
  changes = [],
  onSelect,
  onPlan,
  compactEmpty = false,
  now: suppliedNow,
  homeDueItems,
  courseLabel,
  onInspectSources,
  onJoin,
}: {
  compactEmpty?: boolean;
  now?: string;
  homeDueItems?: ResourceView[];
  courseLabel?: (resource: ResourceView) => string;
  onInspectSources?: () => void;
  resources: ResourceView[];
  sources: SourceHealth[];
  plan?: DayPlanEntry[];
  /** Recent source changes; due items note a moved date or updated instructions. */
  changes?: RailChange[];
  /** Opens a meeting's https join link in the browser. Without it, no Join button is shown. */
  onJoin?: (url: string) => void;
  onSelect: (id: string) => void;
  /** Saves a day-plan decision locally; resolves after the snapshot refreshes. */
  onPlan: (command: Command) => Promise<unknown>;
}) {
  const [clockNow, setNow] = useState(() => new Date().toISOString());
  useEffect(() => {
    const timer = window.setInterval(
      () => setNow(new Date().toISOString()),
      60000,
    );
    return () => window.clearInterval(timer);
  }, []);
  const now = suppliedNow ?? clockNow;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const rail = useMemo(
    () => buildTodayRail(resources, now, timeZone, plan),
    [resources, now, timeZone, plan],
  );
  const due = homeDueItems ? homeDueItems.map(r => ({id:r.id,title:r.title,courseName:r.courseName,dueMin:localTime(r.deadline.planningAt!,timeZone).min,conflict:r.deadline.conflict})) : rail.due;
  const notes = useMemo(() => changeNotes(changes, now, timeZone), [changes, now, timeZone]);
  // Home keeps crowded days scannable without hiding a lone item behind a control.
  const dueShown = homeDueItems && due.length > HOME_DUE_ALL ? HOME_DUE_ALL - 1 : due.length;
  const allDayShown = homeDueItems && rail.allDay.length > HOME_ALL_DAY_ALL ? HOME_ALL_DAY_ALL - 1 : rail.allDay.length;
  const dueRow = (d: (typeof due)[number]) => (
    <li key={d.id}>
      <button
        className="rail-row"
        data-focus-key={`today-${d.id}`}
        title={`${d.title} · ${d.courseName}${d.conflict ? " · dates disagree, planning for the earlier one" : ""}${notes.get(d.id) ? ` · ${notes.get(d.id)!.join(" · ")}` : ""}`}
        onClick={() => onSelect(d.id)}
      >
        <span className="rail-time">{clock(d.dueMin)}</span>
        <span className="rail-row-main">
          <span className="rail-row-title">{d.title}</span>
          {homeDueItems && courseLabel && <span className="rail-course">{courseLabel(homeDueItems.find(r=>r.id===d.id)!)}</span>}
          {(notes.get(d.id) ?? []).map((n) => (
            <span key={n} className="rail-change">{n}</span>
          ))}
        </span>
        {d.conflict ? (
          <span className="rail-flag" aria-label="Dates disagree">
            !
          </span>
        ) : null}
      </button>
    </li>
  );
  const allDayEntry = (e: (typeof rail.allDay)[number]) => homeDueItems ? (
    <button key={e.id} className="rail-allday rail-allday--home" data-focus-key={`allday-${e.id}`} title={e.title} aria-label={`${e.title}, all day. Open details`} onClick={() => onSelect(e.id)}>
      <span>All day</span>{e.title}
    </button>
  ) : (
    <div key={e.id} className="rail-allday" title={e.title}>
      {e.title}
    </div>
  );
  // Normal content is commitments and accepted blocks; suggestions appear on request.
  const [showSuggestions, setShowSuggestions] = useState(false);
  const visible = rail.suggestions.filter(
    (s) => s.state !== "suggested" || showSuggestions,
  );
  const isCompactEmpty = compactEmpty && rail.events.length === 0 && visible.length === 0;
  const pendingCount = rail.suggestions.filter((s) => s.state === "suggested").length;
  const [focusId, setFocusId] = useState<string | null>(null);
  const focused =
    visible.find((s) => s.id === focusId) ??
    visible.find((s) => s.state === "planned") ??
    visible.find((s) => s.state === "suggested");

  // Day-plan actions. Each one saves through core; the rail re-derives from the saved plan.
  const saved = (s: RailSuggestion) =>
    plan.find((p) => p.key === s.id && p.date === rail.date);
  const accept = (s: RailSuggestion) =>
    onPlan({ type: "day-plan", entry: planEntry(s, rail.date, "accepted") });
  const remove = (s: RailSuggestion) =>
    onPlan({ type: "day-plan-remove", key: s.id, date: rail.date });
  const markDone = (s: RailSuggestion, done: boolean) => {
    const entry = saved(s) ?? planEntry(s, rail.date, "accepted");
    return onPlan({
      type: "day-plan",
      entry: { ...entry, doneAt: done ? new Date().toISOString() : null },
    });
  };
  const [undo, setUndo] = useState<RailSuggestion | null>(null);
  useEffect(() => {
    if (!undo) return;
    const timer = window.setTimeout(() => setUndo(null), 6000);
    return () => window.clearTimeout(timer);
  }, [undo]);
  const skip = async (s: RailSuggestion) => {
    await onPlan({ type: "day-plan", entry: planEntry(s, rail.date, "skipped") });
    setUndo(s);
  };

  const [editing, setEditing] = useState<RailSuggestion | null>(null);
  const [form, setForm] = useState({ title: "", start: "", end: "" });
  const startEdit = (s: RailSuggestion) => {
    setEditing(s);
    setForm({ title: s.title, start: hhmm(s.startMin), end: hhmm(s.endMin) });
  };
  const check = validatePlanEdit(
    { startMin: fromHhmm(form.start), endMin: fromHhmm(form.end) },
    rail.events,
  );
  const saveEdit = async () => {
    if (!editing || !check.ok) return;
    const base = saved(editing) ?? planEntry(editing, rail.date, "accepted");
    await onPlan({
      type: "day-plan",
      entry: {
        ...base,
        // Saving an edit puts the block on the plan.
        status: "accepted",
        block: {
          ...base.block,
          title: form.title.trim() || editing.title,
          startMin: fromHhmm(form.start),
          endMin: fromHhmm(form.end),
        },
      },
    });
    setEditing(null);
  };

  function tools(s: RailSuggestion) {
    const tool = (icon: string, label: string, fn: () => unknown, tone = "") => (
      <button
        key={label}
        className={`rail-tool ${tone}`}
        title={label}
        aria-label={`${label}: ${s.title}`}
        onClick={(event) => {
          event.stopPropagation();
          void fn();
        }}
      >
        {icon}
      </button>
    );
    if (s.state === "suggested")
      return [
        tool("✓", "Accept", () => accept(s), "ok"),
        tool("✎", "Edit", () => startEdit(s)),
        tool("✕", "Skip", () => skip(s), "no"),
      ];
    if (s.state === "planned")
      return [
        ...(isStudy(s) ? [tool("☐", "Mark done", () => markDone(s, true), "ok")] : []),
        tool("✎", "Edit", () => startEdit(s)),
        tool("↺", "Remove from plan", () => remove(s)),
      ];
    if (s.doneBy === "student")
      return [tool("↺", "Mark not done", () => markDone(s, false))];
    return []; // Canvas-submitted blocks stay crossed out.
  }

  const grid = useRef<HTMLDivElement>(null);
  const top = (min: number) =>
    ((min - rail.hours.start * 60) / 60) * HOUR_PX;
  const height = (start: number, end: number) =>
    ((end - start) / 60) * HOUR_PX - 2;
  useEffect(() => {
    grid.current?.scrollTo({ top: Math.max(0, top(rail.nowMin) - 50) });
    // Scroll to now once per day; later refreshes keep the student's position.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rail.date]);

  // Freshness and coverage are per source; one timestamp cannot vouch for all of them.
  const time = (iso: string | null | undefined) =>
    iso
      ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(iso))
      : null;
  const newest = (list: SourceHealth[]) =>
    list.map((s) => s.lastSuccessAt).filter((v): v is string => !!v).sort().at(-1) ?? null;
  const courseSources = sources.filter((s) => s.kind === "canvas" || s.kind === "fixture");
  const calendarSources = sources.filter((s) => s.kind === "calendar");
  const incomplete = (list: SourceHealth[]) => list.some((s) => s.status !== "ok" || !s.complete);
  const dueEmpty = !courseSources.length
    ? "No course source checked yet."
    : incomplete(courseSources)
      ? "Nothing due today in the sources that could be checked. Some are incomplete."
      : "Nothing due today in checked sources.";
  const freshness = [
    courseSources.length
      ? `Courses ${incomplete(courseSources) ? "partly checked" : "checked"}${time(newest(courseSources)) ? ` ${time(newest(courseSources))}` : ""}`
      : "Courses not checked",
    calendarSources.length
      ? `calendar ${incomplete(calendarSources) ? "partly checked" : "checked"}${time(newest(calendarSources)) ? ` ${time(newest(calendarSources))}` : ""}`
      : "no calendar feed",
  ].join(" · ");
  const heading = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(now));
  const hourCount = rail.hours.end - rail.hours.start;
  // Overlapping events and blocks share the row side by side instead of covering each other.
  const lanes = layoutLanes([
    ...rail.events.map((e) => ({ id: e.id, startMin: e.startMin, endMin: e.endMin ?? e.startMin + 30 })),
    ...visible.map((s) => ({ id: s.id, startMin: s.startMin, endMin: s.endMin })),
  ]);
  const across = (id: string) => {
    const { lane, lanes: n } = lanes.get(id) ?? { lane: 0, lanes: 1 };
    if (n === 1) return {};
    const col = `(100% - 36px) / ${n}`;
    return { left: `calc(34px + ${col} * ${lane})`, width: `calc(${col} - 2px)`, right: "auto" };
  };

  return (
    <aside className={`today-rail${isCompactEmpty ? " is-compact-empty" : ""}`} aria-label="Today's schedule">
      <div className="rail-heading">
        <span>Due today</span>
        <span>{due.length || ""}</span>
      </div>
      <ul className={`rail-due${homeDueItems ? " rail-due--home" : ""}`}>
        {due.length ? (
          due.slice(0, dueShown).map(dueRow)
        ) : (
          <li className="rail-empty-line">{dueEmpty}</li>
        )}
      </ul>
      {due.length > dueShown ? (
        // The heading counts every unique item; the rest stay one explicit click away.
        <details className="rail-more" data-place-disclosure="today-due-more">
          <summary data-focus-key="today-due-more">{due.length - dueShown} more due today</summary>
          <ul className="rail-due rail-due--home">{due.slice(dueShown).map(dueRow)}</ul>
        </details>
      ) : null}

      {editing ? (
        <form
          className="rail-edit"
          aria-label={`Edit ${editing.title}`}
          onSubmit={(event) => {
            event.preventDefault();
            void saveEdit();
          }}
        >
          <div className="rail-heading">
            <span>Edit {isStudy(editing) ? "study" : "work"} block</span>
          </div>
          <label>
            Title
            <input
              value={form.title}
              maxLength={200}
              autoFocus
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </label>
          <div className="rail-edit-times">
            <label>
              Start
              <input
                type="time"
                step={300}
                value={form.start}
                onChange={(e) => setForm({ ...form, start: e.target.value })}
              />
            </label>
            <label>
              End
              <input
                type="time"
                step={300}
                value={form.end}
                onChange={(e) => setForm({ ...form, end: e.target.value })}
              />
            </label>
          </div>
          <p className="rail-edit-msg" aria-live="polite">
            {check.ok
              ? `${fromHhmm(form.end) - fromHhmm(form.start)} minutes`
              : check.reason}
            {check.overlaps.length ? (
              <span className="rail-warn-text">
                {" "}
                · Overlaps {check.overlaps.join(", ")}
              </span>
            ) : null}
          </p>
          <div className="rail-edit-actions">
            <button className="button primary" type="submit" disabled={!check.ok}>
              Save to plan
            </button>
            <button className="button" type="button" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : focused ? (
        <>
          <div className="rail-heading">
            <span>{focused.state === "suggested" ? "Suggested" : "Next up"}</span>
            <span>{rail.plannedMin ? `${duration(rail.plannedMin)} planned` : ""}</span>
          </div>
          <div className={`rail-next ${focused.type}`}>
            <button
              className="rail-next-title"
              title={focused.reason}
              onClick={() => onSelect(focused.resourceId)}
            >
              {focused.title}
            </button>
            <span className="rail-next-time">
              {clock(focused.startMin)}–{clock(focused.endMin)} ·{" "}
              {focused.courseName}
            </span>
            <span className="rail-chips">
              {focused.factors.slice(0, 3).map((f) => (
                <span key={f} className="rail-chip">
                  {f}
                </span>
              ))}
            </span>
          </div>
        </>
      ) : null}

      {pendingCount ? (
        <div className="rail-suggest-bar">
          <span>
            {pendingCount} suggestion{pendingCount === 1 ? "" : "s"} for free time
            {showSuggestions ? ` · ${duration(rail.suggestedMin)}` : ""}
          </span>
          <button
            aria-pressed={showSuggestions}
            onClick={() => setShowSuggestions((v) => !v)}
          >
            {showSuggestions ? "Hide" : "Show"}
          </button>
        </div>
      ) : null}

      <div className="rail-heading">
        <span>Schedule</span>
        <span>{heading}</span>
      </div>
      {rail.allDay.slice(0, allDayShown).map(allDayEntry)}
      {rail.allDay.length > allDayShown ? (
        <details className="rail-more" data-place-disclosure="today-allday-more">
          <summary data-focus-key="today-allday-more">{rail.allDay.length - allDayShown} more all day</summary>
          {rail.allDay.slice(allDayShown).map(allDayEntry)}
        </details>
      ) : null}
      {isCompactEmpty ? <div className="rail-empty-schedule" role="status">
        <p>{emptyScheduleMessage(sources, rail.allDay.length > 0, now)}</p>
        {onInspectSources && calendarCoverageNeedsCheck(sources, now) && <button onClick={onInspectSources}>Check sources</button>}
      </div> : <div className="rail-grid" ref={grid}>
        <div
          className="rail-grid-inner"
          style={{ height: hourCount * HOUR_PX + 12 }}
        >
          {Array.from(
            { length: hourCount + 1 },
            (_, i) => rail.hours.start + i,
          ).map((h) => (
            <div
              key={h}
              className="rail-hour"
              style={{ top: (h - rail.hours.start) * HOUR_PX }}
            >
              <span>{hourLabel(h)}</span>
            </div>
          ))}
          {rail.events.map((e) => {
            const end = e.endMin ?? e.startMin + 30;
            const range = e.endMin != null ? `${clock(e.startMin)}–${clock(e.endMin)}` : `${clock(e.startMin)}, start only`;
            const status = e.response ? RESPONSE_LABEL[e.response] : null;
            const provider = e.onlineMeeting ? PROVIDER_LABEL[e.onlineMeeting] : null;
            const canJoin = Boolean(e.joinUrl && onJoin && e.response !== "declined");
            return (
              <div
                key={e.id}
                className={`rail-event ${e.response ?? ""}`}
                style={{ top: top(e.startMin) + 1, height: height(e.startMin, end), ...across(e.id) }}
              >
                <button
                  className={`rail-block event ${e.startOnly ? "start-only" : ""}`}
                  title={`${e.title} · ${range}${e.location ? ` · ${e.location}` : ""}${status ? ` · ${status}` : ""}`}
                  aria-label={`${e.title}, ${range}${status ? `, ${status}` : ""}. Open details`}
                  onClick={() => onSelect(e.id)}
                >
                  <b>
                    {provider ? <span className="rail-teams rail-provider">{provider}</span> : null}
                    {e.title}
                  </b>
                  {height(e.startMin, end) >= 36 ? (
                    (lanes.get(e.id)?.lanes ?? 1) > 1 ? (
                      // Sharing the row: the range would wrap and clip. Full times stay in the label.
                      <span>{clock(e.startMin)}</span>
                    ) : (
                      <span>
                        {e.endMin != null
                          ? `${clock(e.startMin)}–${clock(e.endMin)}`
                          : `${clock(e.startMin)} · start only`}
                        {e.location && !e.onlineMeeting ? ` · ${e.location}` : ""}
                        {status && e.response !== "accepted" && e.response !== "organizer" ? ` · ${status}` : ""}
                      </span>
                    )
                  ) : null}
                </button>
                {canJoin ? (
                  <button
                    className="rail-join"
                    aria-label={`Join ${e.title}${provider ? ` on ${provider}` : ""}`}
                    title={`Join${provider ? ` on ${provider}` : ""} in your browser`}
                    onClick={() => onJoin!(e.joinUrl!)}
                  >
                    Join
                  </button>
                ) : null}
              </div>
            );
          })}
          {visible.map((s) => {
            const label =
              s.state === "done"
                ? s.doneBy === "canvas"
                  ? "Submitted on Canvas"
                  : "Done"
                : s.state === "planned"
                  ? "Planned"
                  : "Suggested";
            return (
              <div
                key={s.id}
                className="rail-slot"
                style={{ top: top(s.startMin) + 1, height: height(s.startMin, s.endMin), ...across(s.id) }}
              >
                <button
                  className={`rail-block suggestion ${s.type} ${s.state} ${focused?.id === s.id ? "focused" : ""}`}
                  title={`${s.title} · ${clock(s.startMin)}–${clock(s.endMin)}\n${s.reason}`}
                  aria-label={`${label}: ${s.title}, ${clock(s.startMin)} to ${clock(s.endMin)}`}
                  aria-pressed={focused?.id === s.id}
                  onClick={() => setFocusId(s.id)}
                >
                  <b>
                    {s.state === "done" ? "✓ " : ""}
                    {s.title}
                  </b>
                </button>
                <div className="rail-tools">{tools(s)}</div>
              </div>
            );
          })}
          {rail.hasCalendarSource ? (
            <div
              className="rail-now"
              style={{ top: top(rail.nowMin) }}
              aria-label={`Now, ${clock(rail.nowMin)}`}
            />
          ) : (
            <p className="rail-grid-empty">
              No calendar connected, so classes and meetings may be missing.
              <br />
              Connect a calendar feed in Sources.
            </p>
          )}
        </div>
      </div>}
      {undo ? (
        <div className="rail-undo" role="status">
          <span>Skipped “{undo.title}”</span>
          <button
            onClick={() => {
              void onPlan({ type: "day-plan-remove", key: undo.id, date: rail.date });
              setUndo(null);
            }}
          >
            Undo
          </button>
        </div>
      ) : null}
      <p className="rail-foot">{freshness}</p>
    </aside>
  );
}
