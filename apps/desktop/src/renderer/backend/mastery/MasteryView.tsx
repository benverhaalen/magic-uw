// Course mastery (D57): three elements by default (spec: Study & Learn ≤ 3):
// 1. where you are (one stacked state bar, what changed since last week) with the one next step;
// 2. topics by module, collapsed (a topic's detail holds "I know this" and "Hide");
// 3. assessments: upcoming readiness by default; past exams and grades one tab away.
// Every figure is the router's (0 tokens). "Generate" and "Build my strategy" use the student's AI
// and say so. No percentages of mastery, no grade predictions, no streaks or points.
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { Snapshot } from "@magic/contracts";
import type { MasteryTopic, NextStep, NextStepCommand } from "../../../../../../packages/learning/src/mastery/types";
import type { FlashcardData, PracticeRoundData } from "../../../../../../packages/learning/src/router-types";
import {
  bridgeApi,
  courseChoices,
  must,
  operationId,
  type ClaimData,
  type CourseChoice,
  type CourseGradesData,
  type CourseMasteryData,
  type ExamHistoryData,
  type HideData,
  type MasteryApi,
  type StrategyRunResult,
} from "./api";
import { SessionRunner, type SessionStart } from "./SessionRunner";
import { StateBar, countsText } from "./StateBar";
import "./mastery.css";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayText = (iso: string) => {
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  // The knowledge model's own format ("26 Sep"), so dates in reasons and rows read alike.
  return Number.isNaN(d.getTime()) ? iso : `${d.getDate()} ${MONTHS[d.getMonth()]}`;
};
const inDays = (d: number) => (d === 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`);

interface Props {
  snapshot: Snapshot | null;
  /** The course a host page already chose (Workspace tools): no selector is shown. */
  course?: CourseChoice;
  api?: MasteryApi;
  /** Opens Data & AI, where a held first-time share is reviewed. */
  onOpenPrivacy?: () => void;
  /** For the headless render: open a module and a topic, or a tab, on first paint. */
  initial?: { courseKey?: string; openModules?: string[]; openTopic?: string; tab?: Tab };
}
type Tab = "upcoming" | "past" | "grades";

export function MasteryView({ snapshot, course: fixed, api = bridgeApi, onOpenPrivacy, initial }: Props) {
  const courses = fixed ? (fixed.anchorIds.length ? [fixed] : []) : snapshot ? courseChoices(snapshot) : [];
  const [courseKey, setCourseKey] = useState(initial?.courseKey ?? courses[0]?.key ?? "");
  const course = courses.find((c) => c.key === courseKey) ?? courses[0];
  const [data, setData] = useState<CourseMasteryData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [session, setSession] = useState<SessionStart | null>(null);
  const [busy, setBusy] = useState(false);
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    if (!course) return;
    const seq = ++loadSeq.current;
    setLoading(true);
    setError("");
    try {
      const d = await must<CourseMasteryData>(api, { op: "course.mastery", courseId: course.courseId, anchorIds: course.anchorIds });
      if (seq === loadSeq.current) setData(d);
    } catch (e) {
      if (seq === loadSeq.current) setError(e instanceof Error ? e.message : "Mastery couldn't be computed.");
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [api, course?.key]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  /** Runs a next step's exact command (the anchors and an operation ID are added here). */
  async function run(command: NextStepCommand, title: string) {
    if (!course) return;
    setBusy(true);
    setNotice("");
    setError("");
    try {
      if (command.type === "pack") {
        const result = (await api.pack(command.pack, command.scope)) as { status?: string; message?: string } | null;
        setNotice(result?.message ?? "Generation finished.");
        await load();
        return;
      }
      const res = await api.learning({ ...command.request, anchorIds: course.anchorIds, operationId: operationId() });
      if (res.status !== "ok") throw new Error(res.message ?? "That practice couldn't start.");
      const d = res.data as PracticeRoundData | FlashcardData;
      setSession("flashcards" in d ? { kind: "cards", data: d, title } : { kind: "round", data: d, title });
    } catch (e) {
      setError(e instanceof Error ? e.message : "That practice couldn't start.");
    } finally {
      setBusy(false);
    }
  }

  async function claim(topic: MasteryTopic) {
    if (!course) return;
    setBusy(true);
    setNotice("");
    try {
      const c = await must<ClaimData>(api, { op: "mastery.claim", courseId: course.courseId, anchorIds: course.anchorIds, topicId: topic.topicId, operationId: operationId() });
      if (c.check) setSession({ kind: "round", data: c.check as PracticeRoundData, title: `Check: ${topic.label}` });
      else setNotice(c.message);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The check couldn't start.");
    } finally {
      setBusy(false);
    }
  }

  async function hide(topicId: string, hidden: boolean) {
    if (!course) return;
    setBusy(true);
    try {
      const h = await must<HideData>(api, { op: "mastery.hide", courseId: course.courseId, anchorIds: course.anchorIds, topicId, hidden });
      setNotice(h.message);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That topic couldn't be changed.");
    } finally {
      setBusy(false);
    }
  }

  if (!courses.length)
    return (
      <div className={`mastery ${fixed ? "mastery--embedded" : ""}`}>
        {fixed ? null : <Header />}
        <p className="mastery-empty">No course with assignments is saved yet. Connect Canvas or load the sample from Home, then open Mastery again.</p>
      </div>
    );

  if (session)
    return (
      <div className={`mastery ${fixed ? "mastery--embedded" : ""}`}>
        <SessionRunner
          api={api}
          start={session}
          onDone={() => {
            setSession(null);
            void load();
          }}
        />
      </div>
    );

  return (
    <div className={`mastery ${fixed ? "mastery--embedded" : ""}`} aria-busy={loading}>
      {fixed ? null : <Header courses={courses} course={course} onCourse={setCourseKey} />}
      <div className="mastery-feedback-region" aria-live="polite">
        {error ? (
          <p className="mastery-error" role="alert">
            {error}{" "}
            <button type="button" className="mastery-link" onClick={() => void load()}>
              Try again
            </button>
          </p>
        ) : null}
        {notice ? <p className="mastery-notice">{notice}</p> : null}
      </div>
      {!data ? (
        loading ? (
          <p className="mastery-empty" role="status">
            Working out this course's topic states from your answers…
          </p>
        ) : null
      ) : (
        <>
          <Summary data={data} busy={busy} onRun={run} />
          {data.status === "ok" ? <Topics data={data} busy={busy} onClaim={claim} onHide={hide} onRun={run} initial={initial} /> : null}
          <Assessments api={api} course={course!} data={data} busy={busy} onRun={run} onOpenPrivacy={onOpenPrivacy} initialTab={initial?.tab} />
          <p className="mastery-footnote">{data.note} States come from your unassisted answers and card reviews; the rules are starting values that haven't been validated yet.</p>
        </>
      )}
    </div>
  );
}

function Header({ courses, course, onCourse }: { courses?: CourseChoice[]; course?: CourseChoice; onCourse?: (key: string) => void }) {
  const id = useId();
  return (
    <header className="mastery-header">
      <h1>Mastery</h1>
      {courses && courses.length > 1 && course ? (
        <label className="mastery-course" htmlFor={id}>
          <span className="mastery-visually-hidden">Course</span>
          <select id={id} value={course.key} onChange={(e) => onCourse?.(e.target.value)}>
            {courses.map((c) => (
              <option key={c.key} value={c.key}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      ) : course ? (
        <p className="mastery-course-name">{course.name}</p>
      ) : null}
    </header>
  );
}

/** Element 1: the bar, what changed, and the one next step. */
function Summary({ data, busy, onRun }: { data: CourseMasteryData; busy: boolean; onRun: (c: NextStepCommand, title: string) => void }) {
  return (
    <section className="mastery-section mastery-summary" aria-labelledby="mastery-where">
      <h2 id="mastery-where">{data.status === "ok" ? data.label : "No topics yet"}</h2>
      {data.status === "ok" ? (
        <>
          <StateBar counts={data.counts} legend />
          {data.sinceLastWeek.text ? <p className="mastery-since">{data.sinceLastWeek.text}</p> : null}
        </>
      ) : (
        <p className="mastery-since">{data.message}</p>
      )}
      {data.nextStep ? <NextStepButton step={data.nextStep} busy={busy} onRun={onRun} lead /> : <p className="mastery-since">{data.nextStepNote}</p>}
    </section>
  );
}

function NextStepButton({ step, busy, onRun, lead = false }: { step: NextStep; busy: boolean; onRun: (c: NextStepCommand, title: string) => void; lead?: boolean }) {
  return (
    <button type="button" className={lead ? "mastery-study" : "mastery-secondary mastery-prep"} disabled={busy} onClick={() => onRun(step.command, step.label)}>
      <span className="mastery-study-label">{step.label}</span>
      <span className="mastery-study-detail">
        {step.detail}
        {step.usesAi ? " Uses your AI." : ""}
      </span>
      <span className="mastery-arrow" aria-hidden="true">
        →
      </span>
    </button>
  );
}

/** Element 2: topics by module, collapsed; a topic's detail holds the claim and hide actions. */
function Topics({
  data,
  busy,
  onClaim,
  onHide,
  onRun,
  initial,
}: {
  data: CourseMasteryData;
  busy: boolean;
  onClaim: (t: MasteryTopic) => void;
  onHide: (id: string, hidden: boolean) => void;
  onRun: (c: NextStepCommand, title: string) => void;
  initial?: Props["initial"];
}) {
  const [open, setOpen] = useState<Set<string>>(new Set(initial?.openModules ?? []));
  const [topic, setTopic] = useState<string | null>(initial?.openTopic ?? null);
  const [showHidden, setShowHidden] = useState(false);
  const byId = new Map(data.topics.map((t) => [t.topicId, t]));
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <section className="mastery-section" aria-labelledby="mastery-topics">
      <h2 id="mastery-topics">Topics</h2>
      <ul className="mastery-modules">
        {data.modules.map((m) => {
          const key = m.moduleId ?? "other";
          const isOpen = open.has(key);
          const panel = `mastery-module-${key}`;
          return (
            <li key={key} className="mastery-module">
              <button type="button" className="mastery-module-row" aria-expanded={isOpen} aria-controls={panel} onClick={() => toggle(key)}>
                <span className="mastery-chevron" aria-hidden="true">
                  {isOpen ? "▾" : "▸"}
                </span>
                <span className="mastery-module-label">{m.label}</span>
                <span className="mastery-module-counts">{countsText(m.counts)}</span>
                {m.dueForReview ? (
                  <span className="mastery-due" title="Due for review">
                    <span className="mastery-due-dot" aria-hidden="true" />
                    {m.dueForReview} due
                  </span>
                ) : null}
                <StateBar counts={m.counts} size="mini" />
              </button>
              {isOpen ? (
                <ul id={panel} className="mastery-topics">
                  {m.topicIds.map((id) => {
                    const t = byId.get(id)!;
                    const detail = `mastery-topic-${id}`;
                    const expanded = topic === id;
                    return (
                      <li key={id}>
                        <button type="button" className="mastery-topic-row" aria-expanded={expanded} aria-controls={detail} onClick={() => setTopic(expanded ? null : id)}>
                          <span className="mastery-topic-label">{t.label}</span>
                          {t.dueForReview ? (
                            <span className="mastery-due" title="Due for review">
                              <span className="mastery-due-dot" aria-hidden="true" />
                              <span className="mastery-visually-hidden">Due for review</span>
                            </span>
                          ) : null}
                          <span className={`mastery-chip mastery-chip--${t.state}`}>{t.stateLabel}</span>
                        </button>
                        {expanded ? <TopicDetail id={detail} topic={t} busy={busy} onClaim={onClaim} onHide={onHide} onRun={onRun} courseId={data.courseId} /> : null}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
      {data.hidden.length ? (
        <div className="mastery-hidden">
          <button type="button" className="mastery-link" aria-expanded={showHidden} onClick={() => setShowHidden(!showHidden)}>
            {data.hidden.length} hidden {data.hidden.length === 1 ? "topic" : "topics"}
          </button>
          {showHidden ? (
            <ul className="mastery-plain-list">
              {data.hidden.map((h) => (
                <li key={h.topicId}>
                  {h.label}{" "}
                  <button type="button" className="mastery-link" disabled={busy} onClick={() => onHide(h.topicId, false)}>
                    Show again
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function TopicDetail({
  id,
  topic: t,
  busy,
  onClaim,
  onHide,
  onRun,
  courseId,
}: {
  id: string;
  topic: MasteryTopic;
  busy: boolean;
  onClaim: (t: MasteryTopic) => void;
  onHide: (id: string, hidden: boolean) => void;
  onRun: (c: NextStepCommand, title: string) => void;
  courseId: string;
}) {
  return (
    <div id={id} className="mastery-topic-detail">
      {t.reasons[0]?.text !== t.why ? <p>{t.why}</p> : null}
      {t.reasons.length ? (
        <ul className="mastery-plain-list">
          {t.reasons.map((r) => (
            <li key={r.text}>
              {r.text} <span className="mastery-muted">{r.clearsWhen}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {t.dueForReview ? <p className="mastery-muted">Due for review: time since you last recalled it makes slipping likely. Its state stays until an answer says otherwise.</p> : null}
      <p className="mastery-muted">
        {t.evidenceCount ? `${t.evidenceCount} ${t.evidenceCount === 1 ? "answer or review" : "answers and reviews"}, last on ${dayText(t.lastEvidenceDay!)}.` : "No answers yet."}
        {t.assessments.length ? ` On ${t.assessments.map((a) => `${a.title} ${inDays(a.daysAway)}`).join(", ")}.` : ""}
      </p>
      <div className="mastery-row-actions">
        {t.practiceItems ? (
          <button type="button" className="mastery-secondary" disabled={busy} onClick={() => onClaim(t)}>
            I know this
          </button>
        ) : (
          <>
            <span className="mastery-muted">No practice items yet.</span>
            <button type="button" className="mastery-secondary" disabled={busy} onClick={() => onRun({ type: "pack", pack: "quiz", scope: { courseId, topicIds: [t.topicId] } }, `Generate practice for ${t.label}`)}>
              Generate practice (uses your AI)
            </button>
          </>
        )}
        <button type="button" className="mastery-link" disabled={busy} onClick={() => onHide(t.topicId, true)}>
          Not relevant: hide it
        </button>
      </div>
      {t.practiceItems ? <p className="mastery-muted">"I know this" starts a short check from its practice; your answers set its state.</p> : null}
    </div>
  );
}

/** Element 3: upcoming readiness by default; past exams and grades are one tab away. */
function Assessments({
  api,
  course,
  data,
  busy,
  onRun,
  onOpenPrivacy,
  initialTab,
}: {
  api: MasteryApi;
  course: CourseChoice;
  data: CourseMasteryData;
  busy: boolean;
  onRun: (c: NextStepCommand, title: string) => void;
  onOpenPrivacy?: () => void;
  initialTab?: Tab;
}) {
  const [tab, setTab] = useState<Tab>(initialTab ?? "upcoming");
  const tabs: { key: Tab; label: string }[] = [
    { key: "upcoming", label: "Upcoming" },
    { key: "past", label: "Past exams" },
    { key: "grades", label: "Grades" },
  ];
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const to = e.key === "ArrowRight" ? (i + 1) % tabs.length : e.key === "ArrowLeft" ? (i + tabs.length - 1) % tabs.length : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    setTab(tabs[to]!.key);
    refs.current[to]?.focus();
  };
  return (
    <section className="mastery-section" aria-labelledby="mastery-assessments">
      <div className="mastery-section-head">
        <h2 id="mastery-assessments">Assessments</h2>
        <div role="tablist" aria-label="Assessments" className="mastery-tabs">
          {tabs.map((t, i) => (
            <button
              key={t.key}
              ref={(el) => {
                refs.current[i] = el;
              }}
              role="tab"
              type="button"
              id={`mastery-tab-${t.key}`}
              aria-selected={tab === t.key}
              aria-controls={`mastery-panel-${t.key}`}
              tabIndex={tab === t.key ? 0 : -1}
              className="mastery-tab"
              onClick={() => setTab(t.key)}
              onKeyDown={(e) => onKey(e, i)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div role="tabpanel" id={`mastery-panel-${tab}`} aria-labelledby={`mastery-tab-${tab}`} tabIndex={0} className="mastery-panel">
        {tab === "upcoming" ? <Upcoming data={data} busy={busy} onRun={onRun} /> : tab === "past" ? <Past api={api} course={course} /> : <Grades api={api} course={course} onOpenPrivacy={onOpenPrivacy} />}
      </div>
    </section>
  );
}

function Upcoming({ data, busy, onRun }: { data: CourseMasteryData; busy: boolean; onRun: (c: NextStepCommand, title: string) => void }) {
  if (!data.assessments.length && !data.undatedAssessments.length) return <p className="mastery-muted">No dated exam or quiz is in this course's captured work yet.</p>;
  return (
    <>
      <ul className="mastery-exams">
        {data.assessments.map((a) => (
          <li key={a.assessmentId} className="mastery-exam">
            <div className="mastery-exam-head">
              <span className="mastery-exam-title">{a.title}</span>
              <span className="mastery-muted">
                {dayText(a.at)} · {inDays(a.daysAway)}
              </span>
            </div>
            {a.scope === "linked" ? (
              <>
                <StateBar counts={a.counts} size="mini" />
                <p className="mastery-muted">
                  {a.label}
                  {a.dueForReview ? ` · ${a.dueForReview} due for review` : ""}
                </p>
                {a.nextStep && JSON.stringify(a.nextStep.command) !== JSON.stringify(data.nextStep?.command) ? (
                  <NextStepButton step={a.nextStep} busy={busy} onRun={onRun} />
                ) : a.nextStep ? (
                  <p className="mastery-muted">Its next step is the one at the top.</p>
                ) : null}
              </>
            ) : (
              <p className="mastery-muted">{a.label}. Its topics show once its materials or stated coverage link to them.</p>
            )}
          </li>
        ))}
      </ul>
      {data.undatedAssessments.length ? <p className="mastery-muted">No date found yet for {data.undatedAssessments.map((u) => u.title).join(", ")}.</p> : null}
    </>
  );
}

function Past({ api, course }: { api: MasteryApi; course: CourseChoice }) {
  const [history, setHistory] = useState<ExamHistoryData | null>(null);
  const [error, setError] = useState("");
  const [all, setAll] = useState(false);
  useEffect(() => {
    let live = true;
    must<ExamHistoryData>(api, { op: "mastery.history", courseId: course.courseId, anchorIds: course.anchorIds })
      .then((h) => live && setHistory(h))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : "Past exams couldn't be read."));
    return () => {
      live = false;
    };
  }, [api, course.key]);
  if (error) return <p className="mastery-error">{error}</p>;
  if (!history) return <p className="mastery-muted" role="status">Replaying your answers as of each exam date…</p>;
  if (!history.exams.length) return <p className="mastery-muted">No past exam or quiz is in this course's captured work yet.</p>;
  return (
    <>
      <ul className="mastery-exams">
        {(all ? history.exams : history.exams.slice(0, 3)).map((e) => (
          <li key={e.assessmentId} className="mastery-exam">
            <div className="mastery-exam-head">
              <span className="mastery-exam-title">{e.title}</span>
              <span className="mastery-muted">{dayText(e.at)}</span>
            </div>
            <p className="mastery-muted">{e.score ? e.score.text : "No score captured from Canvas."}</p>
            {e.topicIds.length ? (
              <>
                <p>On {dayText(e.at)}, from your answers up to then: {countsText(e.asOf.counts)}.</p>
                {e.since.up.length || e.since.down.length ? (
                  <p className="mastery-muted">
                    Since then: {[...e.since.up.map((t) => `${t.label} moved up`), ...e.since.down.map((t) => `${t.label} moved down`)].join(", ")}.
                  </p>
                ) : (
                  <p className="mastery-muted">No topic has moved since.</p>
                )}
              </>
            ) : (
              <p className="mastery-muted">No topics were linked to it.</p>
            )}
          </li>
        ))}
      </ul>
      {!all && history.exams.length > 3 ? (
        <button type="button" className="mastery-link" onClick={() => setAll(true)}>
          Show {history.exams.length - 3} earlier
        </button>
      ) : null}
      <p className="mastery-muted">{history.note}</p>
    </>
  );
}

function Grades({ api, course, onOpenPrivacy }: { api: MasteryApi; course: CourseChoice; onOpenPrivacy?: () => void }) {
  const [g, setG] = useState<CourseGradesData | null>(null);
  const [error, setError] = useState("");
  const [strategy, setStrategy] = useState<StrategyRunResult | null>(null);
  const [building, setBuilding] = useState(false);
  useEffect(() => {
    let live = true;
    setStrategy(null);
    must<CourseGradesData>(api, { op: "course.grades", courseId: course.courseId, anchorIds: course.anchorIds })
      .then((d) => live && setG(d))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : "Grades couldn't be read."));
    return () => {
      live = false;
    };
  }, [api, course.key]);
  async function build() {
    setBuilding(true);
    try {
      setStrategy((await api.pack("strategy", { courseId: course.courseId })) as StrategyRunResult);
    } catch (e) {
      setStrategy({ status: "failed", message: e instanceof Error ? e.message : "The strategy couldn't be built.", pack: "strategy", courseRef: null, observations: [], observationHash: null, actions: [], cached: false, tokens: { in: 0, cached: 0, out: 0 }, receiptIds: [] });
    } finally {
      setBuilding(false);
    }
  }
  if (error) return <p className="mastery-error">{error}</p>;
  if (!g) return <p className="mastery-muted" role="status">Reading your captured scores…</p>;
  const grade = g.grades.grade;
  const obsText = new Map(g.observations.map((o) => [o.id, o.text]));
  return (
    <div className="mastery-grades">
      <p>{grade.status === "known" ? `Current grade from your captured scores: ${grade.percent}%.` : grade.reason}</p>
      {grade.status === "known" ? <p className="mastery-muted">{grade.basis}</p> : null}
      {g.observations.length ? (
        <ul className="mastery-plain-list mastery-observations">
          {g.observations.filter((o) => o.kind !== "grade").map((o) => (
            <li key={o.id}>{o.text}</li>
          ))}
        </ul>
      ) : (
        <p className="mastery-muted">Not enough scored work or practice yet to observe a trend.</p>
      )}
      <div className="mastery-strategy">
        <button type="button" className="mastery-secondary" disabled={building || !g.observations.length} onClick={() => void build()}>
          {building ? "Building…" : "Build my strategy"}
        </button>
        <span className="mastery-muted">Uses your AI once, from these observations only. Every number it writes is checked against them.</span>
      </div>
      {strategy ? (
        <div className="mastery-strategy-result" role="status">
          <p className={strategy.status === "done" ? "" : "mastery-error"}>{strategy.message}</p>
          {strategy.status === "blocked" && onOpenPrivacy ? (
            <button type="button" className="mastery-link" onClick={onOpenPrivacy}>
              Review it in Data &amp; AI
            </button>
          ) : null}
          {strategy.actions.length ? (
            <ol className="mastery-plain-list">
              {strategy.actions.map((a, i) => (
                <li key={i}>
                  <strong>{a.when}:</strong> {a.text} <span className="mastery-muted">From: {a.basedOn.map((id) => obsText.get(id) ?? id).join(" ")}</span>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}
      <p className="mastery-muted">{g.note}</p>
    </div>
  );
}
