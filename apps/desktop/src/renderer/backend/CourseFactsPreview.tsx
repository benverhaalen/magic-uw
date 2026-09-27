// owner: ui-wiring. The course profile's facts with their quotes (Snapshot.courseIntelligence, already
// held by the App; no extra read). The chosen syllabus source (the course brief) has no renderer
// channel yet, so this says so instead of guessing.
import type { CourseClaim, CourseIntelligenceView } from "@magic/contracts";
import { openExternal, useAction, type Course } from "./bridge";
import { Empty, ErrorLine, Partial, PreviewSection, formatWhen } from "./ui";

const kindLabels: Record<CourseClaim["kind"], string> = {
  ai_policy: "AI policy",
  grading: "Grading",
  topic: "Topics",
  assessment: "Assessments",
};
const methodLabels: Record<CourseClaim["method"], string> = {
  structured: "structured field",
  literal: "quoted text",
  local_model: "local model, quote checked",
  client_model: "your AI client, quote checked",
};

export function CourseFactsPreview({
  course,
  profiles,
  assignmentTitles,
}: {
  course: Course;
  profiles: CourseIntelligenceView[] | undefined;
  /** Resource ID → title, to say which assignment a per-assignment fact belongs to. */
  assignmentTitles: Map<string, string>;
}) {
  const open = useAction();
  const scopeOf = (claim: CourseClaim) =>
    claim.scope === "course" ? "Course-wide" : `Assignment: ${(claim.assignmentId && assignmentTitles.get(claim.assignmentId)) ?? claim.assignmentId ?? "unknown"}`;
  const profile = (profiles ?? [])
    .filter((p) => p.accountScope === course.accountScope && p.courseId === course.courseId)
    .sort((a, b) => b.version - a.version)[0];
  return (
    <PreviewSection title="Course facts and syllabus" op="Snapshot.courseIntelligence (the course profile) · course brief: no channel">
      {!profile ? (
        <Empty>No course profile compiled for this course yet: it is built from the syllabus and course pages after a refresh.</Empty>
      ) : (
        <>
          <p className="small muted">
            Profile v{profile.version} · compiled {formatWhen(profile.compiledAt)} · {profile.freshness.replaceAll("_", " ")}
            {profile.semantic ? ` · semantic pass ${profile.semantic.status}` : ""}
          </p>
          {profile.freshness !== "current_capture" ? (
            <Partial status={profile.freshness}>Some sources were partial or stale when this was compiled; facts may have changed since.</Partial>
          ) : null}
          {profile.claims.length === 0 ? <Empty>The profile has no facts with quotes yet.</Empty> : null}
          {(Object.keys(kindLabels) as CourseClaim["kind"][]).map((kind) => {
            const claims = profile.claims.filter((c) => c.kind === kind);
            return claims.length ? (
              <div className="backend-group" key={kind}>
                <h3>{kindLabels[kind]}</h3>
                <ul className="backend-list">
                  {claims.map((claim) => (
                    <li key={claim.id}>
                      <div className="backend-row">
                        <strong>{claim.label}</strong>
                        <span className="inline-actions">
                          {claim.policyMode ? <span className="badge">{claim.policyMode}</span> : null}
                          <span className="badge">{methodLabels[claim.method]}</span>
                        </span>
                      </div>
                      <div className="backend-meta">{scopeOf(claim)}</div>
                      {claim.value !== null && claim.value !== "" && !claim.evidence.some((e) => e.quote === String(claim.value)) ? (
                        <div className="backend-meta">{String(claim.value)}</div>
                      ) : null}
                      {claim.evidence.map((e, index) => (
                        <div key={`${e.resourceId}:${index}`}>
                          <blockquote className="backend-quote">{e.quote}</blockquote>
                          <button className="subtle-button backend-meta" onClick={() => void open.run(() => openExternal(e.url))}>
                            {e.field} · source ↗
                          </button>
                        </div>
                      ))}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null;
          })}
          {profile.conflicts.length ? (
            <Partial status="conflict">{profile.conflicts.map((c) => `${kindLabels[c.kind]}: ${c.reason}`).join(" · ")}</Partial>
          ) : null}
          {profile.unknowns.length ? (
            <>
              <h3>Not established by the saved sources</h3>
              <ul className="backend-list">
                {profile.unknowns.map((unknown) => (
                  <li key={unknown} className="small muted">
                    {unknown}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      )}
      <h3>Syllabus source</h3>
      <Partial status="not exposed">The chosen syllabus source (the course brief) has no query or bridge channel yet, so it can't be shown here.</Partial>
      <ErrorLine text={open.error} />
    </PreviewSection>
  );
}
