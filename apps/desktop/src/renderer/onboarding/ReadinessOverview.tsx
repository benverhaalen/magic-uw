import type { Snapshot } from "@magic/contracts";
import type { PopulateSummary, SourceLine } from "./model";
import { projectReadiness } from "./readiness";
import { Icon, Spinner } from "./icons";

function CheckRow({ line }: { line: SourceLine }) {
  return (
    <li className={`onb-source ${line.state}`}>
      <span className="onb-source-mark" aria-hidden="true">
        {line.state === "reading" ? <Spinner /> : line.state === "ready" ? <Icon name="check" className="onb-ok" /> : <Icon name="alert" className="onb-warn" />}
      </span>
      <span className="onb-source-text">
        <span className="onb-source-label">{line.label}</span>
        {line.reason ? <span className="onb-source-reason">{line.reason}</span> : null}
      </span>
      <span className="onb-source-status">
        {line.status}
        {line.detail ? <span className="onb-source-detail">{line.detail}</span> : null}
      </span>
    </li>
  );
}

export function ReadinessOverview({ snapshot, summary }: { snapshot: Snapshot; summary: PopulateSummary }) {
  const overview = projectReadiness(snapshot, summary.sources);
  const notes = [
    overview.signIn ? `${overview.signIn} ${overview.signIn === 1 ? "check needs" : "checks need"} sign-in.` : null,
    overview.failed ? `${overview.failed} ${overview.failed === 1 ? "check needs" : "checks need"} review in Sources.` : null,
    overview.importantAreas.length === 1 ? overview.importantAreas[0] : overview.importantAreas.length ? `${overview.importantAreas.length} course areas in this read need review.` : null,
  ].filter((note): note is string => !!note);
  return (
    <div className="onb-readiness">
      {summary.total > 0 ? <p className="onb-readiness-saved"><strong>{summary.total}</strong> saved {summary.total === 1 ? "item" : "items"}{overview.includedCourses ? ` · ${overview.includedCourses} ${overview.includedCourses === 1 ? "course site" : "course sites"} included in this read` : ""}{overview.currentCourses ? ` · ${overview.currentCourses} matched to current UW enrollment` : ""}</p> : null}
      {notes.length ? (
        <ul className="onb-readiness-notes" aria-label="Read checks needing attention">
          {notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      ) : null}
      {overview.checks ? (
        <details className="onb-readiness-more">
          <summary><span className="onb-more-label">More about this read</span><span className="onb-less-label">Show less</span><span className="onb-readiness-muted"> · {overview.checks} checks</span></summary>
          <p className="onb-readiness-help">Canvas access varies by course and area. A missing or blocked area does not tell us whether your instructor uses it. Open Sources in your workspace to review a connection.</p>
          {summary.counts.length ? <p className="onb-readiness-types">Saved: {summary.counts.map((entry) => `${entry.count} ${entry.label}`).join(", ")}.</p> : null}
          <div className="onb-readiness-groups" aria-label="Source check groups">
            {overview.groups.map((group) => (
              <details className="onb-readiness-group" key={group.id}>
                <summary><span>{group.label}</span><span className="onb-readiness-muted">{group.incomplete ? `${group.incomplete} incomplete · ` : ""}{group.checks.length} checks</span></summary>
                <ul className="onb-sources" aria-label={`${group.label} source checks`}>
                  {group.checks.map((line) => <CheckRow key={line.id} line={line} />)}
                </ul>
              </details>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
