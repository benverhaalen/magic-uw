// owner: ui-wiring. "Workspace tools": one labelled preview per finished backend capability, so the
// whole system can be run end to end before the designed screens exist. Each tab reads only what it
// shows (scoped queries, the graph reads, one learning or notes op); nothing polls.
import { useState } from "react";
import type { AgendaEntry, Snapshot } from "@magic/contracts";
import { query, useLoad, type Course } from "./bridge";
import { AgendaPreview } from "./AgendaPreview";
import { ReferencesPreview } from "./ReferencesPreview";
import { GuidesPreview } from "./GuidesPreview";
import { PracticePreview } from "./PracticePreview";
import { AnalyticsPreview } from "./AnalyticsPreview";
import { NotesPreview } from "./NotesPreview";
import { OutlookPreview } from "./OutlookPreview";
import { CourseFactsPreview } from "./CourseFactsPreview";
import { Empty, Loaded, PreviewLabel } from "./ui";
import "./backend.css";

// pending: intent-router. The command bar's intent router is on an unmerged branch; it mounts here
// once its contract is on main. Nothing is implemented against the unmerged contract.
function IntentRouterStub() {
  return null;
}
// pending: acquisition sync.status. The sync-status indicator waits for the acquisition branch's
// `sync.status` contract to merge; it mounts here then.
function SyncStatusStub() {
  return null;
}

const tabs = [
  ["agenda", "Agenda"],
  ["references", "Assignment references"],
  ["guides", "Study guides"],
  ["practice", "Practice"],
  ["analytics", "Practice analytics"],
  ["notes", "Notes"],
  ["outlook", "Outlook"],
  ["facts", "Course facts"],
] as const;
type Tab = (typeof tabs)[number][0];
/** Views that need a course; Agenda and Outlook span every course. */
const courseScoped = new Set<Tab>(["references", "guides", "practice", "analytics", "notes", "facts"]);
/** Pseudo-courses the summary lists that are not classes. */
const notCourses = new Set(["outlook-mail", "outlook-calendar"]);

export function WorkspaceTools({ snapshot }: { snapshot: Snapshot | null }) {
  const [tab, setTab] = useState<Tab>("agenda");
  const [courseKey, setCourseKey] = useState<string | null>(null);
  const [assignmentId, setAssignmentId] = useState<string | null>(null);
  const [wanted, setWanted] = useState<string[] | null>(null);
  const [summary, reloadSummary] = useLoad("tools-summary", () => query({ view: "summary" }));
  const courses: Course[] =
    summary.state === "ready"
      ? summary.value.courses
          .filter((c) => c.included && !notCourses.has(c.courseId))
          .map((c) => ({ accountScope: c.accountScope, courseId: c.courseId, courseName: c.courseName }))
      : [];
  const course = courses.find((c) => `${c.accountScope}:${c.courseId}` === courseKey) ?? courses[0] ?? null;
  const [assignmentsLoad] = useLoad(course ? `tools-assignments:${course.accountScope}:${course.courseId}` : null, () =>
    query({ view: "resources", courseId: course!.courseId, accountScope: course!.accountScope, kinds: ["assignment"], limit: 50 }),
  );
  const assignments = assignmentsLoad.state === "ready" ? assignmentsLoad.value.items.filter((a) => !a.deleted) : [];
  const anchorIds = assignments.map((a) => a.id);
  // An agenda entry can list its calendar copy first; pick the copy that is a saved assignment.
  const resolvedAssignment = wanted ? (assignments.find((a) => wanted.includes(a.id))?.id ?? null) : assignmentId;
  const chooseAssignment = (id: string) => {
    setWanted(null);
    setAssignmentId(id || null);
  };
  const openFromAgenda = (entry: AgendaEntry) => {
    setCourseKey(`${entry.accountScope}:${entry.courseId}`);
    setWanted(entry.resourceIds);
    setTab("references");
  };

  return (
    <div className="settings-page backend-page">
      <IntentRouterStub /* pending: intent-router */ />
      <div className="page-heading">
        <div>
          <p className="eyebrow">Backend wiring</p>
          <h1>
            Workspace tools <PreviewLabel />
          </h1>
        </div>
        <SyncStatusStub /* pending: acquisition sync.status */ />
      </div>
      <p className="backend-intro">
        Each view calls the real backend and shows its real answer, including empty and partial ones. These are wiring previews, not designed screens.
        {snapshot?.fixtureMode ? " This workspace holds the synthetic sample course." : ""}
      </p>
      <div className="backend-tabs" role="tablist" aria-label="Workspace tools">
        {tabs.map(([value, label]) => (
          <button
            key={value}
            role="tab"
            aria-selected={tab === value}
            aria-current={tab === value ? "page" : undefined}
            className="button small-button"
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {courseScoped.has(tab) ? (
        <Loaded load={summary} retry={reloadSummary}>
          {() =>
            courses.length === 0 ? (
              <Empty>No included courses saved yet. Connect Canvas from Home, or load the sample course.</Empty>
            ) : (
              <div className="backend-controls">
                <label>
                  Course
                  <select
                    value={course ? `${course.accountScope}:${course.courseId}` : ""}
                    onChange={(event) => {
                      setCourseKey(event.target.value);
                      setWanted(null);
                      setAssignmentId(null);
                    }}
                  >
                    {courses.map((c) => (
                      <option key={`${c.accountScope}:${c.courseId}`} value={`${c.accountScope}:${c.courseId}`}>
                        {c.courseName}
                      </option>
                    ))}
                  </select>
                </label>
                {assignmentsLoad.state === "error" ? <span className="small attention-text">Assignments could not load: {assignmentsLoad.message}</span> : null}
              </div>
            )
          }
        </Loaded>
      ) : null}
      {tab === "agenda" ? (
        <AgendaPreview onOpenAssignment={openFromAgenda} />
      ) : tab === "outlook" ? (
        <OutlookPreview />
      ) : !course ? null : assignmentsLoad.state === "loading" && tab !== "guides" && tab !== "notes" && tab !== "facts" ? (
        <p className="small muted" role="status">
          Loading the course's assignments…
        </p>
      ) : tab === "references" ? (
        <ReferencesPreview assignments={assignments} assignmentId={resolvedAssignment} onChoose={chooseAssignment} />
      ) : tab === "guides" ? (
        <GuidesPreview key={course.courseId} course={course} />
      ) : tab === "practice" ? (
        <PracticePreview key={`${course.accountScope}:${course.courseId}`} course={course} anchorIds={anchorIds} />
      ) : tab === "analytics" ? (
        <AnalyticsPreview
          key={`${course.accountScope}:${course.courseId}`}
          course={course}
          anchorIds={anchorIds}
          assignments={assignments}
          assignmentId={resolvedAssignment}
          onChoose={chooseAssignment}
        />
      ) : tab === "notes" ? (
        <NotesPreview key={`${course.accountScope}:${course.courseId}`} course={course} />
      ) : (
        <CourseFactsPreview
          course={course}
          profiles={snapshot?.courseIntelligence}
          assignmentTitles={new Map(assignments.map((a) => [a.id, a.title]))}
        />
      )}
    </div>
  );
}
