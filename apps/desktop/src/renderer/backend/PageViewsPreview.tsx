import { SHOW_DATE_CONFLICT_UI } from '../date-conflict-policy';
// owner: page-views. Wiring previews of the four page views, each one composite read-only query:
// assignment.workspace, assessment.page, lecture.session and study.offers. Every row shows code's
// reason and the first quote behind it; what's missing is listed as missing. Links open in the
// default browser on the student's click; a Canvas tool (LTI) is only ever pointed at in Canvas.
// The one generating action is "Write how to approach it" (the page-approach pack, on request).
import { useState } from "react";
import type {
  AssessmentPage,
  AssignmentWorkspace,
  LectureSession,
  PageEvidence,
  PageMissing,
  PageOpen,
  PageResource,
  ResourceSummary,
  StudyOffers,
} from "@magic/contracts";
import { openExternal, pack, query, useAction, useLoad, type Course } from "./bridge";
import { Empty, ErrorLine, Loaded, Partial, PreviewSection, formatWhen, topicStateLabel } from "./ui";
import { ItemSpace } from "../study-prep"; // owner: study-prep
const EXAM_KINDS = new Set(["exam", "midterm", "final", "quiz"]); // owner: study-prep

const views = [
  ["assignment", "Assignment workspace"],
  ["assessment", "Assessment page"],
  ["lecture", "Lecture session"],
  ["offers", "Study offers"],
] as const;
type View = (typeof views)[number][0];

function Quote({ value }: { value: PageEvidence | undefined }) {
  if (!value) return null;
  return (
    <div className="backend-meta">
      “{value.quote.length > 200 ? `${value.quote.slice(0, 199)}…` : value.quote}” — {value.source}
      {value.basis === "field" || value.basis === "structure" ? ` (${value.field ?? value.basis})` : ""}
    </div>
  );
}
function OpenButton({ open, onOpen }: { open: PageOpen; onOpen: (url: string) => void }) {
  if (open.how === "none" || !open.url) return open.note ? <div className="backend-meta">{open.note}</div> : null;
  const label = open.how === "canvas" ? "Open in Canvas ↗" : open.how === "app" ? "Open original ↗" : `${(() => { try { return new URL(open.url!).host; } catch { return "Open"; } })()} ↗`;
  return (
    <>
      <button className="subtle-button backend-meta" onClick={() => onOpen(open.url!)}>
        {label}
      </button>
      {open.note ? <div className="backend-meta">{open.note}</div> : null}
    </>
  );
}
function Rows({ items, onOpen, empty }: { items: PageResource[]; onOpen: (url: string) => void; empty: string }) {
  if (!items.length) return <Empty>{empty}</Empty>;
  return (
    <ul className="backend-list">
      {items.map((r, i) => (
        <li key={`${r.resourceId ?? r.title}:${i}`}>
          <div className="backend-row">
            <strong>{r.title}</strong>
            <span className="inline-actions">
              {r.role ? <span className="badge">{r.role}</span> : null}
              {r.provisional ? <span className="badge">provisional</span> : null}
              <span className="badge">{r.freshness.status}</span>
            </span>
          </div>
          <div className="backend-meta">{r.reasons.join(" · ")}</div>
          <Quote value={r.evidence[0]} />
          <OpenButton open={r.open} onOpen={onOpen} />
        </li>
      ))}
    </ul>
  );
}
function Missing({ items }: { items: PageMissing[] }) {
  return items.length ? (
    <ul className="backend-list">
      {items.map((m) => (
        <li key={m.field} className="small muted">
          <span className="badge">{m.field}</span> {m.text}
        </li>
      ))}
    </ul>
  ) : (
    <Empty>Nothing reported missing.</Empty>
  );
}

export function PageViewsPreview({
  course,
  assignments,
  assignmentId,
  onChoose,
}: {
  course: Course;
  assignments: ResourceSummary[];
  assignmentId: string | null;
  onChoose: (id: string) => void;
}) {
  const [view, setView] = useState<View>("assignment");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const action = useAction();
  const openUrl = (url: string) => void action.run(() => openExternal(url));
  const chosen = assignments.find((a) => a.id === assignmentId) ?? null;
  const [workspace, reloadWorkspace] = useLoad(view === "assignment" && chosen ? `page:ws:${chosen.id}` : null, () => query({ view: "assignment.workspace", resourceId: chosen!.id }));
  const [assessment, reloadAssessment] = useLoad(view === "assessment" && chosen ? `page:as:${chosen.id}` : null, () => query({ view: "assessment.page", assessmentId: chosen!.id }));
  const [lecture, reloadLecture] = useLoad(view === "lecture" ? `page:lec:${course.accountScope}:${course.courseId}:${date}` : null, () =>
    query({ view: "lecture.session", courseId: course.courseId, accountScope: course.accountScope, date }),
  );
  const [offers, reloadOffers] = useLoad(view === "offers" ? `page:offers:${course.accountScope}:${course.courseId}` : null, () =>
    query({ view: "study.offers", courseId: course.courseId, accountScope: course.accountScope, days: 30 }),
  );
  const approach = (page: AssignmentWorkspace | AssessmentPage, reload: () => void) =>
    action.run(async () => {
      const outcome = await pack(page.approach.request.pack, page.approach.request.scope);
      if (outcome.status !== "done") throw new Error(outcome.message);
      reload();
    });

  return (
    <PreviewSection title="Page views" op="query assignment.workspace · assessment.page · lecture.session · study.offers">
      <div className="backend-tabs" role="tablist" aria-label="Page views">
        {views.map(([value, label]) => (
          <button key={value} role="tab" aria-selected={view === value} className="button small-button" onClick={() => setView(value)}>
            {label}
          </button>
        ))}
      </div>
      {view === "assignment" || view === "assessment" ? (
        assignments.length === 0 ? (
          <Empty>No assignments saved for this course yet.</Empty>
        ) : (
          <div className="backend-controls">
            <label>
              {view === "assignment" ? "Assignment" : "Assessment (any graded item)"}
              <select value={chosen?.id ?? ""} onChange={(event) => onChoose(event.target.value)}>
                <option value="">Choose one</option>
                {assignments.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.title}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )
      ) : view === "lecture" ? (
        <div className="backend-controls">
          <label>
            Date
            <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </label>
        </div>
      ) : null}

      {view === "assignment" && chosen ? (
        <Loaded load={workspace} retry={reloadWorkspace}>
          {(w) => (
            <>
              <h3>{w.header.title}</h3>
              <ul className="backend-list">
                <li>Due: {w.header.due ? formatWhen(w.header.due.at) : w.header.deadline.conflict && !SHOW_DATE_CONFLICT_UI ? 'Date in saved sources' : w.header.deadline.reason}</li>
                <li>Points: {w.header.points?.value ?? "not posted"} · Grade: {w.header.gradeWeight.text ?? "unknown"}</li>
                <li>Status: {w.header.status.state.replaceAll("_", " ")} · Submit as: {w.header.submissionTypes.join(", ") || "not posted"}</li>
                <li>{w.header.aiPolicy.text}</li>
                {w.header.effort ? <li>Effort: {w.header.effort.lowMin}–{w.header.effort.highMin} min ({w.header.effort.basis})</li> : null}
              </ul>
              <h3>Instructions</h3>
              {w.instructions.text ? <p className="small">{w.instructions.text.slice(0, 600)}{w.instructions.text.length > 600 ? "…" : ""}</p> : <Empty>No description posted.</Empty>}
              <OpenButton open={w.instructions.canvas} onOpen={openUrl} />
              <h3>Resources ({w.resources.length}{w.moreResources.count ? ` of ${w.resources.length + w.moreResources.count}` : ""})</h3>
              <Rows items={w.resources} onOpen={openUrl} empty="No resource is linked to it, named in it or in its module." />
              <h3>Tools</h3>
              {w.tools.length ? (
                <ul className="backend-list">
                  {w.tools.map((t, i) => (
                    <li key={`${t.url}:${i}`}>
                      <div className="backend-row">
                        <strong>{t.name}</strong>
                        <span className="inline-actions">
                          <span className="badge">{t.kind}</span>
                          <span className="badge">{t.accessState}</span>
                        </span>
                      </div>
                      <div className="backend-meta">{t.reason}</div>
                      {t.action.url ? (
                        <button className="subtle-button backend-meta" onClick={() => openUrl(t.action.url!)}>
                          {t.action.kind === "open_from_canvas" ? "Open in Canvas ↗" : "Open in browser ↗"}
                        </button>
                      ) : null}
                      {t.action.note ? <div className="backend-meta">{t.action.note}</div> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>No tools found for it.</Empty>
              )}
              <h3>Changes</h3>
              {w.changes.length ? (
                <ul className="backend-list">
                  {w.changes.map((c, i) => (
                    <li key={i}>
                      <strong>{c.title}</strong> <span className="badge">{c.kind.replaceAll("_", " ")}</span>
                      <div className="backend-meta">{c.reason}{c.at ? ` · ${formatWhen(c.at)}` : ""}</div>
                      <Quote value={c.evidence[0]} />
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>No announcement, mail or date change names it.</Empty>
              )}
              <h3>Readiness</h3>
              <Partial status={w.readiness.status}>{w.readiness.message} {w.readiness.note}</Partial>
              <ApproachBlock page={w} busy={action.busy} onWrite={() => approach(w, reloadWorkspace)} />
              <h3>Missing</h3>
              <Missing items={w.missing} />
            </>
          )}
        </Loaded>
      ) : null}

      {view === "assessment" && chosen ? (
        <Loaded load={assessment} retry={reloadAssessment}>
          {(p) => (
            <>
              <h3>{p.assessment.title} <span className="badge">{p.assessment.kind}</span></h3>
              {/* owner: study-prep: the item's space (what you need, study actions) for an exam or quiz */}
              {EXAM_KINDS.has(p.assessment.kind) ? <ItemSpace courseId={course.courseId} itemId={p.assessment.id} /> : null}
              <ul className="backend-list">
                {p.details.map((d) => (
                  <li key={d.field}>
                    <div className="backend-row">
                      <strong>{d.field.replaceAll("_", " ")}</strong>
                      <span className="badge">{d.status}</span>
                    </div>
                    <div className="backend-meta">{d.field === "date" && d.value ? formatWhen(d.value) : d.text}</div>
                    {d.claims.map((c, i) => (
                      <div key={i} className="backend-meta">
                        {c.superseded ? "(replaced) " : ""}
                        {d.field === "date" ? formatWhen(c.value) : c.value} — “{c.evidence.quote.slice(0, 160)}” ({c.evidence.source})
                      </div>
                    ))}
                  </li>
                ))}
              </ul>
              <h3>Scope</h3>
              <p className="small">{p.scope.text}</p>
              {p.scope.quotes.map((q, i) => <Quote key={i} value={q} />)}
              {p.scope.modules.length ? <div className="backend-meta">Modules: {p.scope.modules.map((m) => `${m.title} (${m.reason})`).join("; ")}</div> : null}
              <h3>Core</h3>
              <Rows items={p.materials.core} onOpen={openUrl} empty="No core material." />
              <h3>Also useful</h3>
              <Rows items={p.materials.alsoUseful} onOpen={openUrl} empty="Nothing else linked." />
              <h3>Practice</h3>
              <Rows items={p.materials.practice} onOpen={openUrl} empty="No practice material linked." />
              <p className="small muted">{p.practice.message}</p>
              <h3>Sheet</h3>
              <Partial status={p.sheet.status}>{p.sheet.text}</Partial>
              {p.sheet.entries.slice(0, 10).map((e, i) => (
                <div key={i} className="backend-meta">
                  <span className="badge">{e.kind}</span> {e.evidence.quote} — {e.evidence.source}
                </div>
              ))}
              <h3>Readiness and plan</h3>
              <Partial status={p.readiness.status}>{p.readiness.message}</Partial>
              {p.readiness.topics.map((t) => (
                <div key={t.conceptId} className="backend-meta">
                  {t.label}: {topicStateLabel[t.state] ?? t.stateLabel} — {t.reason}
                </div>
              ))}
              <Partial status={p.plan.status}>{p.plan.text}</Partial>
              {p.plan.days.map((d) => (
                <div key={d.date} className="backend-meta">
                  {formatWhen(`${d.date}T12:00:00`, false)}: {d.topics.map((t) => `${t.label} (${t.minutes} min)`).join(", ")}
                </div>
              ))}
              <h3>Office hours before the exam</h3>
              {p.officeHours.length ? p.officeHours.slice(0, 6).map((o, i) => <div key={i} className="backend-meta">{formatWhen(`${o.date}T12:00:00`, false)}: {o.text}</div>) : <Empty>None posted before the exam.</Empty>}
              <h3>Offers</h3>
              {p.offers.length ? p.offers.map((o) => <div key={o.id} className="backend-meta"><span className="badge">{o.status.replaceAll("_", " ")}</span> {o.label}: {o.reason}</div>) : <Empty>No offers for this item.</Empty>}
              <Partial status={p.mastery.status}>{p.mastery.message}</Partial>
              <ApproachBlock page={p} busy={action.busy} onWrite={() => approach(p, reloadAssessment)} />
              <h3>Missing</h3>
              <Missing items={p.missing} />
            </>
          )}
        </Loaded>
      ) : null}

      {view === "lecture" ? (
        <Loaded load={lecture} retry={reloadLecture}>
          {(l: LectureSession) => (
            <>
              {l.session ? (
                <p className="small">
                  {l.session.title} · {l.session.type} · {l.session.typeBasis}
                  {l.session.module ? ` · module "${l.session.module.title}" (${l.session.module.reason})` : ""}
                </p>
              ) : (
                <Empty>No scheduled session found for this date.</Empty>
              )}
              <h3>Slides</h3>
              <Rows items={l.slides} onOpen={openUrl} empty="No slides found." />
              <h3>Readings</h3>
              <Rows items={l.readings} onOpen={openUrl} empty="No readings found." />
              <h3>Recordings</h3>
              <Rows items={l.recordings} onOpen={openUrl} empty="No recording link found." />
              <h3>Key terms</h3>
              {l.keyTerms.length ? l.keyTerms.map((t) => <div key={t.term} className="backend-meta">{t.term} — {t.evidence.source}</div>) : <Empty>No key terms found.</Empty>}
              <h3>Due within 7 days</h3>
              {l.dueSoon.length ? l.dueSoon.map((d) => <div key={d.resourceId} className="backend-meta">{d.title} · {formatWhen(d.dueAt)} · {d.reason}</div>) : <Empty>Nothing due uses this session's materials.</Empty>}
              <h3>Office hours that day</h3>
              {l.officeHours.length ? l.officeHours.map((o, i) => <div key={i} className="backend-meta">{o.text}</div>) : <Empty>None posted for this weekday.</Empty>}
              <h3>Missing</h3>
              <Missing items={l.missing} />
            </>
          )}
        </Loaded>
      ) : null}

      {view === "offers" ? (
        <Loaded load={offers} retry={reloadOffers}>
          {(o: StudyOffers) => (
            <>
              <Partial status={o.gradeBank.status}>{o.gradeBank.reason ?? o.gradeBank.note}</Partial>
              <ul className="backend-list">
                {o.gradeBank.groups.map((g) => (
                  <li key={g.groupId} className="backend-meta">
                    {g.title}: {g.weight === null ? "no weight" : `${g.weight}% (${g.weightBasis})`}
                    {g.standing ? ` · ${g.standing.percent}% of ${g.standing.graded} graded` : ""}
                  </li>
                ))}
              </ul>
              {o.items.length ? (
                <ul className="backend-list">
                  {o.items.map((i) => (
                    <li key={i.assessmentId}>
                      <div className="backend-row">
                        <strong>{i.title}</strong>
                        <span className="inline-actions">
                          <span className="badge">{i.stakes}</span>
                          <span className="badge">{i.grade.basis}</span>
                        </span>
                      </div>
                      <div className="backend-meta">{i.critical.text}</div>
                      <div className="backend-meta">{i.grade.text}</div>
                      {i.offers.map((x) => (
                        <div key={x.id} className="backend-meta">
                          <span className="badge">{x.status.replaceAll("_", " ")}</span> {x.label}
                        </div>
                      ))}
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>No graded item is due in the next 30 days.</Empty>
              )}
              <Missing items={o.missing} />
            </>
          )}
        </Loaded>
      ) : null}
      <ErrorLine text={action.error} />
    </PreviewSection>
  );
}

function ApproachBlock({ page, busy, onWrite }: { page: AssignmentWorkspace | AssessmentPage; busy: boolean; onWrite: () => void }) {
  return (
    <>
      <h3>How to approach it</h3>
      {page.approach.text ? <p className="small">{page.approach.text}</p> : <Partial status={page.approach.status}>{page.approach.message}</Partial>}
      {page.approach.status !== "unavailable" && !page.approach.text ? (
        <button className="button small-button" disabled={busy} onClick={onWrite}>
          Write how to approach it (your AI, one checked call)
        </button>
      ) : null}
    </>
  );
}
// end owner: page-views
