import { useState } from "react";
import { decodeUwTerm, UW_GRADE_POINTS } from "../../../../packages/domain/src/planning";
import { planningPolicies } from "../../../../packages/domain/src/planning-policy";
import { gpaBySemester, gradesNeeded, whatIfGpa } from "../../../../packages/domain/src/gpa";
import type { AuditNode, Command, CommandResult, PlanningComparison, PlanningCourseHistory, PlanningSourceHealth, Snapshot, StoredPlanningRecord, UwGpaGrade } from "@magic/contracts";

type Props = {
  snapshot: Snapshot;
  busy: boolean;
  run: (command: Command) => Promise<CommandResult | undefined>;
  open: (url: string) => void;
  signIn: (service: "myuw" | "enroll") => void;
  refresh: () => void;
};
const time = (value: string | null) => value ? new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "Not checked";
const sourceLabels = { uw_public: "Public catalog", uw_enroll: "Course Search & Enroll", uw_myuw: "My UW", uw_dars: "Degree audit", madgrades: "Madgrades", normalized_import: "Local import" };
function accounts(snapshot: Snapshot) {
  return new Set(snapshot.planning?.records.filter((record) => !record.deleted && record.accountScope !== "public").map((record) => record.accountScope));
}
function rows(snapshot: Snapshot) {
  const separateAccounts = accounts(snapshot).size > 1;
  return snapshot.planning?.records.filter((record) => !record.deleted && (!separateAccounts || record.accountScope === "public")) ?? [];
}
function fresh(stamp: string) {
  const age = Date.now() - Date.parse(stamp);
  return Number.isFinite(age) && age >= 0 && age <= 86_400_000;
}
function stale(record: StoredPlanningRecord, snapshot: Snapshot) {
  const source = snapshot.planning?.sources.find((item) => item.id === record.sourceId);
  return !source || source.status !== "complete" || source.completeness !== "complete" || !fresh(source.observedAt) || !fresh(record.provenance.observedAt);
}
function Evidence({ record, snapshot, open }: { record: StoredPlanningRecord; snapshot: Snapshot; open: Props["open"] }) {
  return <div className="planning-evidence"><button className="subtle-button" onClick={() => open(record.provenance.sourceUrl)}>Source ↗</button><span>{time(record.provenance.observedAt)}{stale(record, snapshot) ? " · Needs verification" : ""}</span></div>;
}

export function PlanningAlerts({ snapshot, open, onPlanning }: Pick<Props, "snapshot" | "open"> & { onPlanning?: () => void }) {
  const alerts = rows(snapshot).filter((record) => record.kind === "hold" || (record.kind === "appointment" && (!record.endsAt || Date.parse(record.endsAt) >= Date.now())));
  if (!alerts.length) return null;
  return <section className="planning-alerts" aria-label="Enrollment and holds">
    <div className="planning-section-title"><h2>Enrollment & holds</h2>{onPlanning ? <button className="subtle-button" onClick={onPlanning}>My UW →</button> : null}</div>
    {alerts.map((record) => <article key={record.localId} className="planning-row">
      {record.kind === "hold" ? <><strong>{record.title}</strong><p>{record.description}</p><span className="badge">{record.blocksEnrollment === true ? "Blocks enrollment" : record.blocksEnrollment === false ? "Does not block enrollment" : "Enrollment impact unknown"}</span>{record.resolutionUrl ? <button className="subtle-button" onClick={() => open(record.resolutionUrl!)}>How to resolve ↗</button> : null}</> : record.kind === "appointment" ? <><strong>Enrollment window · {decodeUwTerm(record.termCode).label}</strong><p>{record.startsAt ? time(record.startsAt) : "Opening time unavailable"}{record.endsAt ? ` – ${time(record.endsAt)}` : ""}</p></> : null}
      <Evidence record={record} snapshot={snapshot} open={open} />
    </article>)}
  </section>;
}

export function MyUw({ snapshot, busy, run, open, signIn, refresh }: Props) {
  const records = rows(snapshot), sources = snapshot.planning?.sources ?? [];
  const multipleAccounts = accounts(snapshot).size > 1;
  const terms = [...new Map(records.filter((record) => record.kind === "term").sort((a, b) => Number(a.past !== null) - Number(b.past !== null) || a.provenance.observedAt.localeCompare(b.provenance.observedAt)).map((term) => [term.code, term])).values()].sort((a, b) => a.code.localeCompare(b.code));
  const [chosenTerm, setTerm] = useState("");
  const termCode = terms.some((term) => term.code === chosenTerm) ? chosenTerm : terms.find((term) => term.past === false)?.code || "";
  const [style, setStyle] = useState<"balanced" | "mornings" | "compact" | "lighter">("balanced");
  const [comparison, setComparison] = useState<{ input: string; value: PlanningComparison } | null>(null);
  const [subject, setSubject] = useState("");
  const input = JSON.stringify([termCode, style, sources.map((source) => [source.id, source.observedAt])]);
  const current = comparison?.input === input ? comparison.value : null;
  const subjects = [...new Map(records.filter((row) => row.kind === "subject").sort((a, b) => a.provenance.observedAt.localeCompare(b.provenance.observedAt)).map((row) => [row.code, row])).values()].sort((a, b) => a.shortName.localeCompare(b.shortName));
  const audits = records.filter((record) => record.kind === "audit");
  const summaries = records.filter((record) => record.kind === "student_summary");
  const advisors = records.filter((record) => record.kind === "advisor");
  const catalog = records.filter((record) => record.kind === "catalog_course");
  const enrolled = records.filter((record) => record.kind === "enrollment_package").filter((record) => record.enrollmentState === "enrolled");
  const history = records.filter((record) => record.kind === "course_history");
  // Domain functions validate against the plain contract shape; strip the storage-only fields (localId, sourceId, etc.).
  const courseHistory: PlanningCourseHistory[] = history.map((record) => ({
    id: record.id, kind: "course_history", provenance: record.provenance, courseKey: record.courseKey,
    termCode: record.termCode, state: record.state, credits: record.credits, grade: record.grade, gpaEligible: record.gpaEligible,
  }));
  const semesters = gpaBySemester(courseHistory);
  const reportedGpa = summaries.find((summary) => summary.cumulativeGpa !== null)?.cumulativeGpa ?? null;
  const computedCumulativeGpa = semesters.length ? semesters[semesters.length - 1].cumulativeGpa : null;
  const enrolledTermCodes = [...new Set(enrolled.map((course) => course.termCode))].sort();
  const thisTermCode = enrolledTermCodes[0] ?? "";
  const thisTermCourses = enrolled.filter((course) => course.termCode === thisTermCode);
  const [grades, setGrades] = useState<Record<string, UwGpaGrade | "">>({});
  const [creditOverrides, setCreditOverrides] = useState<Record<string, string>>({});
  const [targetGpa, setTargetGpa] = useState("");
  const gradeOptions = Object.keys(UW_GRADE_POINTS) as UwGpaGrade[];
  const creditsFor = (courseKey: string): number | null => {
    const override = creditOverrides[courseKey]?.trim();
    if (override) { const value = Number(override); return Number.isFinite(value) && value > 0 ? value : null; }
    const catalogMatch = catalog.find((course) => course.courseKey === courseKey && course.creditMin !== null && course.creditMin === course.creditMax);
    return catalogMatch ? catalogMatch.creditMin : null;
  };
  const hypotheticals = thisTermCourses.flatMap((course) => {
    const grade = grades[course.courseKey], credits = creditsFor(course.courseKey);
    return grade && credits !== null ? [{ courseKey: course.courseKey, credits, grade }] : [];
  });
  const whatIf = whatIfGpa(courseHistory, hypotheticals);
  const targetGpaValue = targetGpa.trim() !== "" ? Number(targetGpa) : null;
  const targetResult = targetGpaValue !== null && Number.isFinite(targetGpaValue)
    ? gradesNeeded(courseHistory, thisTermCourses.map((course) => ({ courseKey: course.courseKey, credits: creditsFor(course.courseKey) ?? Number.NaN })), targetGpaValue)
    : null;
  const reconciliation = snapshot.planning?.reconciliation;
  const namedCourse = (key: string) => catalog.find((course) => course.courseKey === key)?.title || key.replace(/^uw:(\d+):/, (_match, code: string) => `${subjects.find((row) => row.code === code)?.shortName ?? code} `);
  const readableReason = (reason: string) => reason.replace(/uw:\d+:[A-Z0-9]+/g, namedCourse);
  const connected = (key: string) => sources.some((source) => source.scope.key === key && source.status === "complete" && fresh(source.observedAt));
  const privateSources = sources.filter((source) => source.accountScope !== "public");
  const partial = !privateSources.length || privateSources.some((source) => source.status !== "complete" || source.completeness !== "complete" || !fresh(source.observedAt));
  async function compare() {
    const result = await run({ type: "planning-compare", termCode, style });
    if (result?.planningComparison) setComparison({ input, value: result.planningComparison });
  }
  return <>
    <div className="page-heading"><div><p className="eyebrow">Degree & next term</p><h1>My UW</h1></div><div className="toolbar">
      {window.magic.syncPlanning ? <button className="button" disabled={busy} onClick={refresh}>Refresh planning</button> : null}
      <button className="button" disabled={busy} onClick={() => open("https://enroll.wisc.edu/")}>Course Search & Enroll ↗</button>
    </div></div>
    <div className="planning-content">
      <p className="muted">Planning stays on this device. My Magic UW reads school records; enrollment changes happen in UW’s own tools.</p>
      {multipleAccounts ? <p role="status" className="evidence-note">Records from more than one student are saved. Personal planning is hidden to avoid mixing them. Clear local data in Data & AI before connecting a different student.</p> : null}
      {partial ? <div className="evidence-note"><p>{!privateSources.length ? "Your student record and degree audit haven’t been connected here yet." : "Some planning information is incomplete or needs refresh. Source notes below show what is available."}</p>
        {window.magic.signInUW ? <div className="inline-actions">{!connected("connection:myuw-session") ? <button className="button" disabled={busy} onClick={() => signIn("myuw")}>Sign in to My UW</button> : null}{!connected("connection:student-info") ? <button className="button" disabled={busy} onClick={() => signIn("enroll")}>Sign in to Course Search & Enroll</button> : null}</div> : <p className="small muted">UW sign-in is available in the desktop app.</p>}
      </div> : null}
      <PlanningAlerts snapshot={snapshot} open={open} />
      {summaries.map((summary) => <section key={summary.localId} className="settings-section"><h2>{summary.programNames.join(" · ") || "Student record"}</h2><p>{summary.career || "Career not available"}{summary.earnedCredits !== null ? ` · ${summary.earnedCredits} earned credits` : ""}{summary.cumulativeGpa !== null ? ` · ${summary.cumulativeGpa.toFixed(3)} reported GPA` : ""}</p><Evidence record={summary} snapshot={snapshot} open={open} /></section>)}
      {semesters.length || thisTermCourses.length ? <section className="settings-section"><h2>GPA</h2>
        {semesters.length ? <>{semesters.map((term) => <article className="planning-row" key={term.termCode}><strong>{term.label}</strong><p className="small muted">{term.termCredits} GPA credits · Term GPA {term.termGpa !== null ? term.termGpa.toFixed(3) : "Not enough graded credits yet"} · Cumulative {term.cumulativeGpa !== null ? term.cumulativeGpa.toFixed(3) : "—"}{term.cumulativeHasUnknowns ? " · some attempts unresolved" : ""}</p></article>)}
          <p className="small muted">{reportedGpa === null ? "Your student record hasn’t reported a cumulative GPA to compare against." : computedCumulativeGpa === null ? "Not enough graded history here to compute a cumulative GPA to compare." : Math.abs(computedCumulativeGpa - reportedGpa) < 0.0005 ? `Matches the ${reportedGpa.toFixed(3)} reported on your student record.` : `Our computed cumulative (${computedCumulativeGpa.toFixed(3)}) differs from the ${reportedGpa.toFixed(3)} reported on your student record — see Compare academic sources below.`}</p></> : <p className="muted">Connect your course history to see GPA by semester.</p>}
        {thisTermCourses.length ? <>
          <h3>This term, what if?</h3>
          {thisTermCourses.map((course) => <div className="planning-row" key={course.localId}><strong>{namedCourse(course.courseKey)}</strong>
            <div className="planning-controls">
              <label>Grade<select value={grades[course.courseKey] ?? ""} onChange={(event) => setGrades((prior) => ({ ...prior, [course.courseKey]: event.target.value as UwGpaGrade | "" }))}><option value="">Choose a grade</option>{gradeOptions.map((grade) => <option key={grade} value={grade}>{grade}</option>)}</select></label>
              {creditsFor(course.courseKey) === null ? <label>Credits<input type="number" min={0} max={12} step={0.5} value={creditOverrides[course.courseKey] ?? ""} onChange={(event) => setCreditOverrides((prior) => ({ ...prior, [course.courseKey]: event.target.value }))} /></label> : null}
            </div>
          </div>)}
          <p>Projected term GPA: {whatIf.term.gpa !== null ? whatIf.term.gpa.toFixed(3) : "Choose grades to see a projection"}{whatIf.term.unknownCount ? " · some classes still need a grade or credits" : ""}</p>
          <p>Projected cumulative GPA: {whatIf.cumulative.gpa !== null ? whatIf.cumulative.gpa.toFixed(3) : "—"}</p>
          <div className="planning-controls"><label>Target cumulative GPA<input type="number" min={0} max={4} step={0.01} value={targetGpa} onChange={(event) => setTargetGpa(event.target.value)} /></label></div>
          {targetResult ? <p>{targetResult.status === "unknown" ? targetResult.reason
            : targetResult.status === "already_met" ? `Already reachable at a cumulative of ${targetResult.achievableCumulative.toFixed(3)}, even with an F this term.`
            : targetResult.status === "reachable" ? `Needs at least ${targetResult.neededGrade} in every current class this term to reach ${targetGpaValue!.toFixed(3)}.`
            : `Not reachable this term even with straight A's; the best achievable cumulative is ${targetResult.bestAchievableCumulative.toFixed(3)}.`}</p> : null}
        </> : <p className="small muted">Connect this term’s enrollment to try what-if grades.</p>}
      </section> : null}
      {enrolled.length ? <section className="settings-section"><h2>Enrolled courses</h2>{enrolled.map((course) => <article className="planning-row" key={course.localId}><strong>{namedCourse(course.courseKey)}</strong><p className="small muted">{decodeUwTerm(course.termCode).label} · {course.sections.join(" · ")}</p>{course.meetings.map((meeting, index) => <p className="small" key={index}>{meeting.kind === "exam" ? "Exam · " : ""}{meeting.mode === "asynchronous" ? "Asynchronous" : meeting.mode === "unknown" ? "Meeting time not confirmed" : `${meeting.days.map((day) => ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][day]).join(" / ")} · ${minuteLabel(meeting.startMinute)}–${minuteLabel(meeting.endMinute)}`}{meeting.location ? ` · ${meeting.location}` : ""}{meeting.kind === "exam" && meeting.startDate ? ` · ${meeting.startDate}` : ""}</p>)}<Evidence record={course} snapshot={snapshot} open={open} /></article>)}</section> : null}
      {history.length ? <details className="settings-section"><summary>Course history · {history.length} source records</summary><p className="small muted">Completed, in-progress, planned, and dropped records stay separate. Overlapping sources may describe the same attempt; this list is not a transcript or credit total.</p>{history.slice().sort((a, b) => (b.termCode || "").localeCompare(a.termCode || "")).map((course) => <article className="planning-row" key={course.localId}><strong>{namedCourse(course.courseKey)}</strong><p>{course.termCode ? decodeUwTerm(course.termCode).label : "Term unknown"} · {course.state.replaceAll("_", " ")}{course.grade ? ` · ${course.grade}` : ""}{course.credits !== null ? ` · ${course.credits} credits` : ""}</p><Evidence record={course} snapshot={snapshot} open={open} /></article>)}</details> : null}
      <details className="settings-section"><summary>Compare academic sources{reconciliation?.status === "available" ? ` · ${reconciliation.attempts.filter(row => row.differences.length).length} differences` : ""}</summary>
        {reconciliation?.warnings.map((warning) => <p className="small muted" key={warning}>{warning}</p>)}
        {reconciliation?.status === "available" ? <><p className="small">{reconciliation.attempts.filter(row => row.coverage === "matched").length} attempts matched across Canvas and academic records · {reconciliation.attempts.filter(row => row.coverage === "academic_only").length} academic attempts without a matched Canvas course · {reconciliation.unresolvedCanvasCourses} Canvas spaces without an exact course/term match</p>
        {reconciliation.attempts.map((attempt) => <details className="planning-row" key={`${attempt.courseKey}:${attempt.termCode}`}><summary>{namedCourse(attempt.courseKey)} · {decodeUwTerm(attempt.termCode).label}{attempt.differences.length ? ` · ${attempt.differences.map(value => value === "applied_credits" ? "credits applied in DARS" : value).join(", ")} differ` : ` · ${attempt.coverage.replaceAll("_", " ")}`}</summary>
          {attempt.claims.map((claim, index) => <p key={index}><button className="subtle-button" onClick={() => open(claim.url)}>{claim.source === "canvas" ? "Canvas gradebook" : claim.source === "audit" ? "DARS applied course" : "Student course history"} ↗</button> · {claim.grade ? `${claim.source === "canvas" ? "Final letter: " : ""}${claim.grade}` : "No final letter reported"}{claim.source === "canvas" && claim.currentGrade ? ` · Current letter: ${claim.currentGrade}` : ""}{claim.source === "canvas" && claim.score != null ? ` · Canvas final calculation ${claim.score}%` : ""}{claim.source === "canvas" && claim.currentScore != null ? ` · Canvas current calculation ${claim.currentScore}%` : ""}{claim.credits !== null ? ` · ${claim.credits} ${claim.creditBasis === "audit_application" ? "credits applied in this audit" : "attempt credits"}` : ""} · {claim.state.replaceAll("_", " ")} · Observed {time(claim.observedAt)}{claim.needsRefresh ? " · Needs verification" : ""}</p>)}
        </details>)}</> : null}
      </details>
      <section className="settings-section"><h2>Degree progress</h2>
        {!audits.length ? <p className="muted">A current degree audit is needed to show what remains. Catalog descriptions alone don’t establish degree progress.</p> : audits.map((audit) => <div className="planning-audit" key={audit.localId}><h3>{audit.nodes.find(node => node.parentId === null)?.title || "Saved degree audit"}</h3><p className="small muted">Report generated {audit.generatedAt ? time(audit.generatedAt) : "time not verified; see report evidence"} · {audit.coverage} coverage</p>
          {audit.nodes.filter((node) => node.parentId === null).map((node) => <Requirement key={node.nodeId} node={node} nodes={audit.nodes} />)}
          <Evidence record={audit} snapshot={snapshot} open={open} /></div>)}
      </section>
      <section className="settings-section"><h2>Compare next-term courses</h2><p className="muted">Degree progress comes first, then schedule fit. Each option is compared with your saved enrollment individually.</p>
        <div className="planning-controls"><label>Term<select value={termCode} onChange={(event) => setTerm(event.target.value)} disabled={busy || !terms.length}><option value="">{terms.length ? "Choose a term" : "Term list not connected"}</option>{terms.map((term) => <option key={term.localId} value={term.code}>{term.label}</option>)}</select></label>
          <label>Schedule preference<select value={style} onChange={(event) => setStyle(event.target.value as typeof style)} disabled={busy}><option value="balanced">Balanced days</option><option value="mornings">Mornings only</option><option value="compact">Compact days</option><option value="lighter">Fewer credits per course</option></select></label>
          <button className="button" disabled={busy || !termCode || multipleAccounts} onClick={() => void compare()}>Compare courses</button></div>
        {!terms.length ? <p className="small muted">A verified term list is required before comparing offerings.</p> : null}
        {comparison && !current ? <p className="evidence-note">The inputs have changed. Compare again to use the latest saved records.</p> : null}
        {current ? <><div className="evidence-note">{current.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div>{!current.candidates.length ? <p>No verified requirement matches to show from these saved sources.</p> : current.candidates.map((candidate) => <article className="planning-candidate" key={`${candidate.courseKey}:${candidate.packageId}`}><h3>{candidate.title}</h3><p>{candidate.requirements.join(" · ")}</p><div className="planning-tags"><span className="badge">Prerequisites: {candidate.prerequisite}</span><span className="badge">Schedule: {candidate.schedule}</span><span className="badge">{candidate.seatStatus}{candidate.seatsAvailable !== null ? ` · ${candidate.seatsAvailable} seats observed` : ""}</span></div><p className="small muted">{candidate.prerequisiteReasons.map(readableReason).join(" ")} {candidate.scheduleReasons.map(readableReason).join(" ")}</p>{candidate.multipleRequirements ? <p className="small">Potential matches in several requirements; double counting needs confirmation.</p> : null}{candidate.historicalAverage !== null ? <p className="small">Historical average: {candidate.historicalAverage.toFixed(2)} from {candidate.historicalCount} GPA grades. Not a prediction.</p> : null}<div className="planning-evidence">{candidate.evidence.map((evidence, index) => <button key={`${evidence.url}:${index}`} title={`Observed ${time(evidence.observedAt)}`} className="subtle-button" onClick={() => open(evidence.url)}>{evidence.label} ↗</button>)}<span>Observed {time(candidate.observedAt)}</span></div></article>)}</> : null}
      </section>
      {subjects.length ? <section className="settings-section"><h2>Course catalog</h2><p className="muted">Browse public Guide descriptions. Term availability, seats, and eligibility need separate records.</p><div className="planning-controls"><label>Subject<select value={subject} onChange={(event) => setSubject(event.target.value)} disabled={busy}><option value="">Choose a subject</option>{subjects.map((row) => <option key={row.localId} value={row.code}>{row.shortName} · {row.formalName}</option>)}</select></label><button className="button" disabled={busy || !subject} onClick={() => void run({ type: "planning-guide", subjectCode: subject })}>Load descriptions</button><button className="button" disabled={busy || !subject || !termCode} onClick={() => void run({ type: "planning-search", subjectCode: subject, termCode, page: 1 })}>Load first 50 term offerings</button></div>{catalog.length ? <details><summary>{catalog.length} saved course descriptions</summary>{catalog.map((course) => <article key={course.localId} className="planning-row"><strong>{course.title}</strong><p>{course.description}</p><p className="small">Requisites: {course.prerequisiteText ?? "Not found"}</p>{course.id.startsWith("course:") && course.termCode ? <button className="button" disabled={busy} onClick={() => void run({ type: "planning-sections", recordId: course.localId })}>Load section options · {decodeUwTerm(course.termCode).label}</button> : null}<Evidence record={course} snapshot={snapshot} open={open} /></article>)}</details> : null}</section> : null}
      {advisors.length ? <section className="settings-section"><h2>Your assigned advisors</h2>{advisors.map((advisor) => <article className="planning-row" key={advisor.localId}><strong>{advisor.displayName}</strong><p>{advisor.role}</p>{advisor.contactUrl ? <button className="subtle-button" onClick={() => open(advisor.contactUrl!)}>Contact information ↗</button> : null}<Evidence record={advisor} snapshot={snapshot} open={open} /></article>)}</section> : null}
      <details className="settings-section"><summary>UW planning rules & sources</summary>{planningPolicies.map((policy) => <article className="planning-row" key={policy.id}><h3>{policy.title}</h3><p>{policy.text}</p><p className="small muted">{policy.scope} · Reviewed {policy.checkedAt}</p><button className="subtle-button" onClick={() => open(policy.sourceUrl)}>Read the official policy ↗</button></article>)}</details>
      {sources.length ? <details className="settings-section"><summary>Planning sources · {sources.length}</summary>{sources.map((source) => <Source key={source.id} source={source} open={open} />)}</details> : null}
    </div>
  </>;
}
function minuteLabel(value: number | null) {
  if (value === null) return "Unknown";
  const hour = Math.floor(value / 60) % 24;
  return `${hour % 12 || 12}:${String(value % 60).padStart(2, "0")}${hour >= 12 ? "pm" : "am"}`;
}
function Requirement({ node, nodes, depth = 0 }: { node: AuditNode; nodes: AuditNode[]; depth?: number }) {
  // The schema rejects cycles. Bound rendering too, so unusually deep reports remain inspectable at source.
  return <details><summary><span>{node.title || "Untitled requirement"}</span><span className="badge">{node.status.replaceAll("_", " ")}</span></summary>
    <p>{node.needsCourses !== null ? `${node.needsCourses} courses needed. ` : ""}{node.needsCredits !== null ? `${node.needsCredits} credits needed. ` : ""}</p>
    {node.evidence.map((evidence) => <blockquote key={evidence.blockId}>{evidence.quote}</blockquote>)}
    {depth < 16 ? nodes.filter((child) => child.parentId === node.nodeId).map((child) => <Requirement key={child.nodeId} node={child} nodes={nodes} depth={depth + 1} />) : <p className="small muted">Open the source report for deeper detail.</p>}
  </details>;
}
function Source({ source, open }: { source: PlanningSourceHealth; open: Props["open"] }) {
  return <article className="planning-row"><strong>{sourceLabels[source.source]} · {source.scope.kind.replaceAll("_", " ")}</strong><p>{source.status} · {source.completeness} coverage · Checked {time(source.observedAt)}</p>{source.diagnostics.map((diagnostic) => <p className="small muted" key={diagnostic.code}>{diagnostic.message}</p>)}<button className="subtle-button" onClick={() => open(source.sourceUrl)}>Open source ↗</button></article>;
}
