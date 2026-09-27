import { useEffect, useMemo, useRef, useState } from "react";
import type { ResourceView, SourceHealth } from "@magic/contracts";
import { buildTodayRail } from "@magic/domain";

const HOUR_PX = 48;
// Blocks shorter than this show one line so adjacent blocks never overlap.
const COMPACT_PX = 34;

function clock(min: number) {
  const h = Math.floor(min / 60) % 24,
    m = min % 60;
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
function hourLabel(h: number) {
  return `${h % 12 || 12}${h < 12 || h === 24 ? "a" : "p"}`;
}

export function TodayRail({
  resources,
  sources,
  onSelect,
}: {
  resources: ResourceView[];
  sources: SourceHealth[];
  onSelect: (id: string) => void;
}) {
  const [now, setNow] = useState(() => new Date().toISOString());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date().toISOString()), 60000);
    return () => window.clearInterval(timer);
  }, []);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const rail = useMemo(
    () => buildTodayRail(resources, now, timeZone),
    [resources, now, timeZone],
  );
  const grid = useRef<HTMLDivElement>(null);
  const top = (min: number) => ((min - rail.hours.start * 60) / 60) * HOUR_PX;
  const height = (start: number, end: number) => ((end - start) / 60) * HOUR_PX - 2;
  useEffect(() => {
    grid.current?.scrollTo({ top: Math.max(0, top(rail.nowMin) - 60) });
    // Scroll once per day; later refreshes keep the student's position.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rail.date]);

  const lastCheck = sources
    .map((s) => s.lastSuccessAt)
    .filter((v): v is string => !!v)
    .sort()
    .at(-1);
  const heading = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(now));
  const hourCount = rail.hours.end - rail.hours.start;

  return (
    <aside className="today-rail" aria-label="Today's schedule">
      <div className="rail-heading">
        <span>Due today</span>
        <span>{rail.due.length}</span>
      </div>
      <ul className="rail-due">
        {rail.due.length ? (
          rail.due.map((d) => (
            <li key={d.id}>
              <button className="rail-link" onClick={() => onSelect(d.id)}>
                <span className="rail-time">{clock(d.dueMin)}</span>
                <span>
                  {d.title}
                  <span className="rail-course">{d.courseName}</span>
                  {d.conflict ? (
                    <span className="rail-warn">
                      Dates disagree · planning time
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          ))
        ) : (
          <li className="rail-empty-line">Nothing due today in saved sources.</li>
        )}
      </ul>

      {rail.suggestions.length ? (
        <>
          <div className="rail-heading">
            <span>Suggested</span>
            <span>Estimates</span>
          </div>
          <ul className="rail-plan">
            {rail.suggestions.map((s) => (
              <li key={s.id}>
                <button
                  className={`rail-link rail-plan-item ${s.type}`}
                  onClick={() => onSelect(s.resourceId)}
                >
                  <span className="rail-time">{clock(s.startMin)}</span>
                  <span>
                    {s.title}
                    <span className="rail-reason">{s.reason}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <div className="rail-heading">
        <span>Schedule</span>
        <span>{heading}</span>
      </div>
      {rail.allDay.map((e) => (
        <div key={e.id} className="rail-allday">
          All day · {e.title}
        </div>
      ))}
      <div className="rail-grid" ref={grid}>
        <div className="rail-grid-inner" style={{ height: hourCount * HOUR_PX + 12 }}>
          {Array.from({ length: hourCount + 1 }, (_, i) => rail.hours.start + i).map((h) => (
            <div key={h} className="rail-hour" style={{ top: (h - rail.hours.start) * HOUR_PX }}>
              <span>{hourLabel(h)}</span>
            </div>
          ))}
          {rail.events.map((e) => (
            <div
              key={e.id}
              className={`rail-block event ${e.startOnly ? "start-only" : ""}`}
              style={{
                top: top(e.startMin) + 1,
                height: height(e.startMin, e.endMin ?? e.startMin + 30),
              }}
            >
              <b>{e.title}</b>
              {height(e.startMin, e.endMin ?? e.startMin + 30) >= COMPACT_PX ? (
                <span>
                  {e.endMin != null
                    ? `${clock(e.startMin)}–${clock(e.endMin)}`
                    : `${clock(e.startMin)} · start only`}
                </span>
              ) : null}
            </div>
          ))}
          {rail.suggestions.map((s) => (
            <button
              key={s.id}
              className={`rail-block suggestion ${s.type}`}
              title={s.reason}
              onClick={() => onSelect(s.resourceId)}
              style={{
                top: top(s.startMin) + 1,
                height: height(s.startMin, s.endMin),
              }}
            >
              <b>{s.title}</b>
              {height(s.startMin, s.endMin) >= COMPACT_PX ? (
                <span>
                  Suggested · {clock(s.startMin)}–{clock(s.endMin)}
                </span>
              ) : null}
            </button>
          ))}
          {rail.hasCalendarSource ? (
            <div className="rail-now" style={{ top: top(rail.nowMin) }} aria-label={`Now, ${clock(rail.nowMin)}`} />
          ) : (
            <p className="rail-grid-empty">
              No calendar events captured.
              <br />
              Connect a calendar feed in Sources to see classes here.
            </p>
          )}
        </div>
      </div>
      <p className="rail-foot">
        {rail.hasCalendarSource ? "Calendar + course sources" : "Course sources only"}
        {lastCheck
          ? ` · checked ${new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(lastCheck))}`
          : ""}
        . Suggestions are estimates; nothing is scheduled for you.
      </p>
    </aside>
  );
}
