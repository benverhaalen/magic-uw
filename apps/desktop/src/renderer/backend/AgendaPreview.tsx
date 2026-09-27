// owner: ui-wiring. Daily agenda from the material pipeline's graph agenda (graph `agenda`), not the
// command bar's old `due` verb. Class meetings appear here when enrollment records give their times.
import type { AgendaEntry, AgendaGroup } from "@magic/contracts";
import { graph, useLoad } from "./bridge";
import { Empty, Loaded, PreviewSection, formatWhen } from "./ui";

const groupLabels: Record<AgendaGroup, string> = {
  overdue: "Overdue (last 14 days)",
  today: "Today",
  week: "This week",
  later: "Later",
};
const kindLabels: Record<AgendaEntry["kind"], string> = {
  assignment: "Assignment",
  quiz: "Quiz",
  exam: "Exam",
  event: "Event",
  class: "Class",
};
const dateKindLabels: Record<AgendaEntry["dateKind"], string> = { due: "Due", closes: "Closes", starts: "Starts" };

export function localDate(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function AgendaPreview({ onOpenAssignment }: { onOpenAssignment: (entry: AgendaEntry) => void }) {
  const date = localDate();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [load, reload] = useLoad(`agenda:${date}:${tz}`, () => graph({ type: "agenda", date, tz, days: 14 }));
  return (
    <PreviewSection
      title="Daily agenda"
      op={`graph agenda (date ${date}, ${tz}, 14 days)`}
      actions={
        <button className="button small-button" onClick={reload}>
          Reload
        </button>
      }
    >
      <Loaded load={load} retry={reload}>
        {(agenda) =>
          agenda.entries.length === 0 ? (
            <Empty>Nothing dated in the next 14 days or overdue in the last 14. Dates come from saved Canvas items, calendars and class schedules.</Empty>
          ) : (
            <>
              {(Object.keys(groupLabels) as AgendaGroup[]).map((group) =>
                agenda.groups[group].length ? (
                  <div className="backend-group" key={group}>
                    <h3>{groupLabels[group]}</h3>
                    <ul className="backend-list">
                      {agenda.groups[group].map((entry) => (
                        <li key={entry.key}>
                          <div className="backend-row">
                            <strong>{entry.title}</strong>
                            <span className="badge">{kindLabels[entry.kind]}</span>
                          </div>
                          <div className="backend-meta">
                            {entry.courseName} · {dateKindLabels[entry.dateKind]}{" "}
                            {entry.allDay ? `${formatWhen(entry.at, false)} (all day)` : formatWhen(entry.at)}
                            {entry.submitted === true ? " · Submitted (reported by source)" : entry.submitted === false ? " · Not submitted (reported by source)" : ""}
                            {" · "}date from {entry.authority}
                          </div>
                          {entry.kind !== "class" && entry.kind !== "event" && entry.resourceIds[0] ? (
                            <button className="subtle-button backend-meta" onClick={() => onOpenAssignment(entry)}>
                              {entry.references.length
                                ? `${entry.references.length} linked reference${entry.references.length === 1 ? "" : "s"} →`
                                : "No linked references found yet · open references →"}
                            </button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null,
              )}
              {!agenda.entries.some((e) => e.kind === "class") ? (
                <p className="small muted">No class meetings on this agenda: they appear once My UW enrollment gives section times.</p>
              ) : null}
            </>
          )
        }
      </Loaded>
    </PreviewSection>
  );
}
