// owner: ui-wiring. Practice analytics (code-only, 0 tokens): analytics.course, analytics.assignment
// and analytics.agendaHints. Topic counts per evidence state only; no percentage or grade prediction.
import type { ResourceSummary } from "@magic/contracts";
import type {
  AgendaHintsData,
  AssignmentAnalyticsData,
  CourseAnalyticsData,
  StateDistribution,
  StudyNextRow,
} from "../../../../../packages/learning/src/router-types";
import { learning, useLoad, type Course } from "./bridge";
import { Empty, Loaded, Partial, PreviewSection, formatWhen, topicStateLabel } from "./ui";

const distribution = (d: StateDistribution) =>
  (["solid", "getting_there", "iffy", "not_seen"] as const).map((k) => `${topicStateLabel[k]} ${d[k]}`).join(" · ") + " topics";

function StudyNext({ rows }: { rows: StudyNextRow[] }) {
  if (!rows.length) return <Empty>No study-next topics: nothing links to practice evidence yet.</Empty>;
  return (
    <ul className="backend-list">
      {rows.map((r) => (
        <li key={r.conceptId}>
          <div className="backend-row">
            <strong>{r.label}</strong>
            <span className="badge">{r.stateLabel}</span>
          </div>
          <div className="backend-meta">
            {r.reason}
            {r.exam ? ` · before ${r.exam.title} (${r.exam.daysAway} days)` : ""}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function AnalyticsPreview({
  course,
  anchorIds,
  assignments,
  assignmentId,
  onChoose,
}: {
  course: Course;
  anchorIds: string[];
  assignments: ResourceSummary[];
  assignmentId: string | null;
  onChoose: (id: string) => void;
}) {
  const base = { courseId: course.courseId, anchorIds };
  const anchorKey = anchorIds.join(",");
  const ready = anchorIds.length > 0;
  const [courseLoad, reloadCourse] = useLoad(ready ? `an-course:${course.courseId}:${anchorKey}` : null, () =>
    learning({ op: "analytics.course", ...base }),
  );
  const [hintsLoad, reloadHints] = useLoad(ready ? `an-hints:${course.courseId}:${anchorKey}` : null, () =>
    learning({ op: "analytics.agendaHints", ...base }),
  );
  const [assignmentLoad, reloadAssignment] = useLoad(ready && assignmentId ? `an-assignment:${assignmentId}:${anchorKey}` : null, () =>
    learning({ op: "analytics.assignment", ...base, assignmentId: assignmentId! }),
  );
  if (!ready)
    return (
      <PreviewSection title="Practice analytics" op="learning analytics.course · analytics.assignment · analytics.agendaHints">
        <Empty>Analytics are anchored to the course's assignments, and none are saved for this course yet.</Empty>
      </PreviewSection>
    );
  return (
    <PreviewSection title="Practice analytics" op="learning analytics.course · analytics.assignment · analytics.agendaHints">
      <p className="small muted">Evidence states from your own practice. No scores, percentages or grade predictions.</p>
      <h3>Course</h3>
      <Loaded load={courseLoad} retry={reloadCourse}>
        {(result) => {
          const data = result.status === "ok" ? (result.data as CourseAnalyticsData) : null;
          if (!data) return <Partial status={result.status}>{result.message ?? "Course analytics are unavailable."}</Partial>;
          return (
            <>
              <p className="small">{distribution(data.distribution)}</p>
              <p className="small muted">{data.coverage.text}</p>
              {data.modules.length ? (
                <ul className="backend-list">
                  {data.modules.map((m) => (
                    <li key={m.moduleId ?? "none"}>
                      <strong>{m.label}</strong>
                      <div className="backend-meta">
                        {distribution(m.distribution)} · {m.coverage.text}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>No modules in the course map yet.</Empty>
              )}
              {data.exams.length ? (
                <>
                  <h3>Upcoming exams</h3>
                  <ul className="backend-list">
                    {data.exams.map((e) => (
                      <li key={e.assessmentId}>
                        <div className="backend-row">
                          <strong>{e.title}</strong>
                          <span className="badge">{e.scope === "linked" ? "linked to topics" : "no topics linked yet"}</span>
                        </div>
                        <div className="backend-meta">
                          {formatWhen(e.at)} · {e.daysAway} days · date from {e.dateSource} · {distribution(e.distribution)}
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <Empty>No dated exams or quizzes found for this course.</Empty>
              )}
              {data.undatedExams.length ? <p className="small muted">Undated: {data.undatedExams.map((e) => e.title).join(", ")} (no date is invented).</p> : null}
              {data.trend.transitions.length ? (
                <p className="small muted">Recent changes: {data.trend.transitions.map((t) => t.text).join(" · ")}</p>
              ) : null}
              <h3>Study next</h3>
              <StudyNext rows={data.studyNext} />
              {data.note ? <p className="small muted">{data.note}</p> : null}
            </>
          );
        }}
      </Loaded>
      <h3>Agenda hints</h3>
      <Loaded load={hintsLoad} retry={reloadHints}>
        {(result) => {
          const data = result.status === "ok" ? (result.data as AgendaHintsData) : null;
          if (!data) return <Partial status={result.status}>{result.message ?? "Agenda hints are unavailable."}</Partial>;
          return data.hints.length ? (
            <ul className="backend-list">
              {data.hints.map((h) => (
                <li key={h.conceptId}>
                  {h.text}
                  <div className="backend-meta">{h.minutes === null ? "No practice items yet for this topic." : `About ${h.minutes} minutes from ${h.items} items`}</div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No agenda hints: they need a dated exam and topics linked to it.</Empty>
          );
        }}
      </Loaded>
      <h3>One assignment</h3>
      <div className="backend-controls">
        <label>
          Assignment
          <select value={assignmentId ?? ""} onChange={(event) => onChoose(event.target.value)}>
            <option value="">Choose an assignment</option>
            {assignments.map((a) => (
              <option key={a.id} value={a.id}>
                {a.title}
              </option>
            ))}
          </select>
        </label>
      </div>
      {assignmentId ? (
        <Loaded load={assignmentLoad} retry={reloadAssignment}>
          {(result) => {
            const data = result.status === "ok" ? (result.data as AssignmentAnalyticsData) : null;
            if (!data) return <Partial status={result.status}>{result.message ?? "Assignment analytics are unavailable."}</Partial>;
            return (
              <>
                {data.linkage !== "linked" ? <Partial status={data.linkage}>{data.reason}</Partial> : null}
                <p className="small">
                  {data.materials.length} linked materials · {distribution(data.distribution)}
                </p>
                <p className="small muted">{data.coverage.text}</p>
                {data.materials.length ? (
                  <ul className="backend-list">
                    {data.materials.map((m) => (
                      <li key={m.resourceId}>
                        {m.title}
                        <div className="backend-meta">{m.reason}</div>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <p className="small muted">
                  {data.calibration.status === "not_enough" ? data.calibration.text : `${data.calibration.flags.length} confidence flags`}
                </p>
                <StudyNext rows={data.studyNext} />
              </>
            );
          }}
        </Loaded>
      ) : null}
    </PreviewSection>
  );
}
