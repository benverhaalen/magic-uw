// The Analytics tab: one calm dashboard per course answering "how am I doing and what should I do
// next". Five elements: grade trend, homework completion, assignment prep, topic mastery and three
// next actions. Every figure is computed in code (./model.ts); nothing here calls a model.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Snapshot } from "@magic/contracts";
import type { FlashcardData, PracticeRoundData } from "../../../../../packages/learning/src/router-types";
import { ChartFrame, Legend, LevelBar, LineChart, ProgressBar, RingChart, StackedBarChart, percentDomain, type Series } from "../charts";
import { SessionRunner, type SessionStart } from "../backend/mastery/SessionRunner";
import { operationId, type MasteryApi } from "../backend/mastery/api";
import { loadAnalyticsInputs, localCourseData, type CourseRef } from "./load";
import {
  COMPLETION,
  COMPLETION_LABEL,
  buildCourseAnalytics,
  monthDay,
  type ActionCard,
  type ActionsView,
  type CompletionView,
  type CourseAnalyticsView,
  type EmptyState,
  type GradeTrendView,
  type PrepView,
  type TopicsView,
} from "./model";
import { sampleStudyApi } from "./sample";

const COMPLETION_SERIES: Series[] = COMPLETION.map((key) => ({ key, label: COMPLETION_LABEL[key] }));
const STATE_SERIES: Series[] = [
  { key: "solid", label: "Mastered" },
  { key: "getting_there", label: "Getting there" },
  { key: "iffy", label: "Iffy" },
  { key: "not_seen", label: "Not seen yet" },
];
const dateText = (t: number) => monthDay(new Date(t));

export interface DashboardHandlers {
  onAction: (card: ActionCard) => void;
  onPrep: (itemId: string) => void;
  onCoursework: () => void;
  busy?: boolean;
}

function Empty({ state, onCoursework }: { state: EmptyState; onCoursework: () => void }) {
  return (
    <div className="ca-empty" role="status">
      <p>{state.message}</p>
      <button type="button" className="ca-secondary" onClick={onCoursework}>
        {state.action.label}
      </button>
    </div>
  );
}

function GradeTrend({ view, onCoursework }: { view: GradeTrendView; onCoursework: () => void }) {
  if (view.status === "empty")
    return (
      <section className="ca-card ca-card--trend" data-shot="grade-trend">
        <h3 className="chart-frame-title">Grade trend</h3>
        <Empty state={view} onCoursework={onCoursework} />
      </section>
    );
  const xs = view.points.map((p) => p.at);
  const x0 = xs[0]!,
    x1 = Math.max(xs.at(-1)!, view.band?.x1 ?? 0);
  const yDomain = percentDomain(
    view.points.map((p) => p.running),
    view.band ? [view.band.lo, view.band.hi] : [],
  );
  const span = Math.max(1, x1 - x0);
  const xTicks = Array.from({ length: 5 }, (_, i) => x0 + (span * i) / 4).map((x) => ({ x, label: dateText(x) }));
  const last = view.points.at(-1)!;
  return (
    <section className="ca-card ca-card--trend">
      <ChartFrame
        shot="grade-trend"
        title="Grade trend"
        summary={view.summary}
        aside={
          <div className="ca-grade">
            <span className="ca-grade-figure">{view.current.percent !== null ? `${view.current.percent}%` : "—"}</span>
            {view.letter ? (
              <span className="ca-letter" title={view.letterNote}>
                {view.letter.letter}
              </span>
            ) : null}
          </div>
        }
        table={{
          columns: ["Item", "Date", "Score", "Weight", "Course grade after"],
          rows: view.points.map((p) => [p.title, dateText(p.at), p.scoreText, p.weightText, `${p.running}%`]),
        }}
      >
        <LineChart
          points={view.points.map((p) => ({
            x: p.at,
            y: p.running,
            label: p.title,
            lines: [`Score ${p.scoreText}`, p.weightText, `Course grade after: ${p.running}%`, ...(p.late ? ["Submitted late"] : [])],
            hollow: p.late,
          }))}
          xDomain={[x0, x1]}
          yDomain={yDomain}
          xTicks={xTicks}
          refLines={view.cutoffs.map((c) => ({ y: c.min, label: c.letter }))}
          band={view.band ? { x0: view.band.x0, x1: view.band.x1, lo0: last.running, hi0: last.running, lo1: view.band.lo, hi1: view.band.hi, label: view.band.text } : null}
        />
      </ChartFrame>
      <div className="ca-notes">
        <p>{view.trendText}</p>
        {view.band ? (
          <p className="ca-whatif">
            <span className="ca-dash" aria-hidden="true" />
            {view.band.text}
          </p>
        ) : null}
        <p className="ca-cite">
          {view.current.percent !== null ? view.current.basis : view.current.reason} {view.letterNote}
        </p>
      </div>
    </section>
  );
}

function Completion({ view, onCoursework }: { view: CompletionView; onCoursework: () => void }) {
  if (view.status === "empty")
    return (
      <section className="ca-card" data-shot="completion">
        <h3 className="chart-frame-title">Homework completion</h3>
        <Empty state={view} onCoursework={onCoursework} />
      </section>
    );
  const values = COMPLETION.map((k) => view.totals[k]);
  return (
    <section className="ca-card">
      <ChartFrame
        shot="completion"
        title="Homework completion"
        summary={view.summary}
        table={{ columns: ["Week of", ...COMPLETION.map((k) => COMPLETION_LABEL[k])], rows: view.weeks.map((w) => [w.label, ...w.values]) }}
      >
        <div className="ca-completion">
          <RingChart series={COMPLETION_SERIES} values={values} center={String(view.totals.on_time)} caption="on time" />
          <div className="ca-completion-bars">
            <StackedBarChart series={COMPLETION_SERIES} columns={view.weeks.map((w) => ({ label: w.label, values: w.values }))} />
          </div>
        </div>
      </ChartFrame>
      <Legend series={COMPLETION_SERIES} values={values} />
      <p className="ca-count">{view.onTimeText}</p>
      {view.unrecorded ? <p className="ca-cite">{view.unrecorded} past items have no submission recorded (for example, in-class work).</p> : null}
    </section>
  );
}

function Prep({ view, onPrep, onCoursework }: { view: PrepView; onPrep: (id: string) => void; onCoursework: () => void }) {
  if (view.status === "empty")
    return (
      <section className="ca-card" data-shot="assignment-prep">
        <h3 className="chart-frame-title">Assignment prep</h3>
        <Empty state={view} onCoursework={onCoursework} />
      </section>
    );
  return (
    <section className="ca-card">
      <ChartFrame
        shot="assignment-prep"
        title="Assignment prep"
        summary={view.rows.map((r) => `${r.title}, ${r.when}: ${r.readiness}${r.due ? `, ${r.due}` : ""}.`).join(" ")}
        table={{
          columns: ["Item", "Due", "Mastered", "Getting there", "Iffy", "Not seen yet", "Due"],
          rows: view.rows.map((r) => [r.title, r.when, r.counts.solid, r.counts.getting_there, r.counts.iffy, r.counts.not_seen, r.due ?? "—"]),
        }}
      >
        <ul className="ca-prep">
          {view.rows.map((r) => (
            <li key={r.itemId} className="ca-prep-row">
              <div className="ca-prep-head">
                <div>
                  <span className="ca-chip">{r.kind}</span>
                  <strong className="ca-prep-title">{r.title}</strong>
                </div>
                <button type="button" className="ca-secondary" onClick={() => onPrep(r.itemId)} aria-label={`Prep for ${r.title}`}>
                  Prep
                </button>
              </div>
              <p className="ca-meta">
                {r.when} · {r.weight}
              </p>
              <ProgressBar series={STATE_SERIES} values={[r.counts.solid, r.counts.getting_there, r.counts.iffy, r.counts.not_seen]} label={`${r.title}: ${r.readiness}`} />
              <p className="ca-meta">
                <span>{r.readiness}</span>
                {r.due ? <span className="ca-due">{r.due}</span> : null}
              </p>
            </li>
          ))}
        </ul>
      </ChartFrame>
      <Legend series={STATE_SERIES} />
      <p className="ca-cite">{view.note}</p>
    </section>
  );
}

function Topics({ view, onCoursework }: { view: TopicsView; onCoursework: () => void }) {
  const [all, setAll] = useState(false);
  if (view.status === "empty")
    return (
      <section className="ca-card ca-card--wide" data-shot="topic-mastery">
        <h3 className="chart-frame-title">Topic mastery</h3>
        <Empty state={view} onCoursework={onCoursework} />
      </section>
    );
  const rows = all ? view.rows : view.rows.slice(0, 8);
  return (
    <section className="ca-card ca-card--wide">
      <ChartFrame
        shot="topic-mastery"
        title="Topic mastery"
        summary={view.summary}
        aside={<span className="ca-meta">{view.label}</span>}
        table={{ columns: ["Topic", "Module", "State", "Detail"], rows: view.rows.map((r) => [r.label, r.module ?? "—", r.stateLabel, r.tier]) }}
      >
        <ul className="ca-topics">
          {rows.map((r) => (
            <li key={r.topicId} className="ca-topic">
              <div className="ca-topic-head">
                <strong>{r.label}</strong>
                <span className="ca-meta">{r.module}</span>
              </div>
              <LevelBar level={r.level} steps={4} tone={r.state} label={`${r.label}: ${r.stateLabel}${r.level === 4 ? ", confirmed" : ""}`} />
              <p className="ca-meta" title={r.why}>
                <span>{r.tier}</span>
                {r.due ? <span className="ca-due">Due for review</span> : null}
              </p>
            </li>
          ))}
        </ul>
      </ChartFrame>
      <div className="ca-row">
        <Legend series={STATE_SERIES} />
        {view.rows.length > 8 ? (
          <button type="button" className="chart-table-toggle" onClick={() => setAll((v) => !v)}>
            {all ? "Show fewer" : `Show all ${view.rows.length} topics`}
          </button>
        ) : null}
      </div>
      <p className="ca-cite">States come from your own answers and card reviews. The fourth step is a Mastered topic you recalled correctly on a later day.</p>
    </section>
  );
}

function Actions({ view, onAction, onCoursework, busy }: { view: ActionsView; onAction: (c: ActionCard) => void; onCoursework: () => void; busy?: boolean }) {
  return (
    <section className="ca-card ca-card--actions" data-shot="next-actions" aria-labelledby="ca-actions-title">
      <h3 id="ca-actions-title" className="chart-frame-title">
        What to do next
      </h3>
      {view.status === "empty" ? (
        <Empty state={view} onCoursework={onCoursework} />
      ) : (
        <ol className="ca-actions">
          {view.cards.map((c, i) => (
            <li key={c.id} className={`ca-action ca-action--${c.kind}`}>
              <span className="ca-rank" aria-hidden="true">
                {i + 1}
              </span>
              <div className="ca-action-body">
                <strong>{c.title}</strong>
                <p className="ca-meta">{c.detail}</p>
                {c.usesAi ? <p className="ca-cite">Uses your AI, with its consent and receipt.</p> : null}
                <button type="button" className={i === 0 ? "ca-primary" : "ca-secondary"} disabled={busy} onClick={() => onAction(c)}>
                  {c.cta}
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** The dashboard for a computed view. Pure: the headless tests and the perf check render this. */
export function AnalyticsDashboard({ view, onAction, onPrep, onCoursework, busy }: { view: CourseAnalyticsView } & DashboardHandlers) {
  const g = view.grade;
  const headline = [
    g.status === "ok" && g.current.percent !== null ? `${g.current.percent}%${g.letter ? ` · ${g.letter.letter}` : ""} in the course` : null,
    view.completion.status === "ok" ? view.completion.onTimeText : null,
    view.topics.status === "ok" ? view.topics.label : null,
  ].filter(Boolean);
  return (
    <div className="course-analytics" data-shot="course-analytics">
      <header className="ca-header">
        <div>
          <p className="ca-eyebrow">Course analytics{view.synthetic ? " · synthetic sample" : ""}</p>
          <h2 className="ca-title">{view.courseName}</h2>
          {headline.length ? <p className="ca-headline">{headline.join(" · ")}</p> : null}
        </div>
        {view.synthetic ? <span className="ca-chip ca-chip--sample">Synthetic sample</span> : null}
      </header>
      <div className="ca-grid">
        <GradeTrend view={view.grade} onCoursework={onCoursework} />
        <Actions view={view.actions} onAction={onAction} onCoursework={onCoursework} busy={busy} />
        <Completion view={view.completion} onCoursework={onCoursework} />
        <Prep view={view.prep} onPrep={onPrep} onCoursework={onCoursework} />
        <Topics view={view.topics} onCoursework={onCoursework} />
      </div>
      <p className="ca-footnote">Computed on this device from your captured Canvas records and your own practice. No AI call; not a grade prediction.</p>
    </div>
  );
}

const bridgeApi: MasteryApi = {
  async learning(request) {
    const response = await window.magic.execute({ type: "learning", request });
    return response.learning ?? { op: request.op, status: "failed", message: "The study service didn't answer." };
  },
  async pack(pack, scope) {
    const response = await window.magic.execute({ type: "pack", pack, scope });
    return response.pack ?? null;
  },
};

/** The tab for one course: reads once per course and snapshot revision, then renders the dashboard. */
export function CourseAnalyticsTab({
  snapshot,
  course,
  onOpenItem,
  onCoursework,
  api,
}: {
  snapshot: Snapshot;
  course: CourseRef;
  /** Opens an item's own space by its resource ID (Prep and "Open assignment"). */
  onOpenItem: (itemId: string) => void;
  onCoursework: () => void;
  api?: MasteryApi;
}) {
  const sampleApi = useMemo(() => sampleStudyApi(), []);
  const [view, setView] = useState<CourseAnalyticsView | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<SessionStart | null>(null);
  const [nonce, setNonce] = useState(0);
  const snapRef = useRef(snapshot);
  snapRef.current = snapshot;
  const synthetic = view?.synthetic === true;
  const study: MasteryApi = api ?? (synthetic ? sampleApi : bridgeApi);
  // Re-read when the course's own records change, not on every 2-second snapshot poll.
  const revision = useMemo(
    () => snapshot.resources.filter((r) => r.courseId === course.courseId).map((r) => `${r.id}:${r.observedAt}:${r.submission?.score ?? ""}`).join("|"),
    [snapshot.resources, course.courseId],
  );
  useEffect(() => {
    let live = true;
    setError("");
    loadAnalyticsInputs(api ?? bridgeApi, snapRef.current, course)
      .then((inputs) => live && setView(buildCourseAnalytics(inputs)))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : "Analytics couldn't be computed."));
    return () => {
      live = false;
    };
  }, [course.accountScope, course.courseId, revision, nonce]);

  async function onAction(card: ActionCard) {
    if (card.kind === "start" && card.itemId) return onOpenItem(card.itemId);
    if (!card.command) return;
    setBusy(true);
    setNotice("");
    try {
      if (card.command.type === "pack") {
        const r = (await study.pack(card.command.pack, card.command.scope)) as { message?: string } | null;
        setNotice(r?.message ?? "Generation finished.");
        return;
      }
      const anchorIds = localCourseData(snapRef.current, course).anchorIds;
      const res = await study.learning({ ...card.command.request, anchorIds: anchorIds.length ? anchorIds : ["sample"], operationId: operationId() });
      if (res.status !== "ok") throw new Error(res.message ?? "That practice couldn't start.");
      const d = res.data as PracticeRoundData | FlashcardData;
      setSession("flashcards" in d ? { kind: "cards", data: d, title: card.title } : { kind: "round", data: d, title: card.title });
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "That practice couldn't start.");
    } finally {
      setBusy(false);
    }
  }

  if (session)
    return (
      <div className="mastery mastery--embedded">
        <SessionRunner
          api={study}
          start={session}
          onDone={() => {
            setSession(null);
            setNonce((n) => n + 1);
          }}
        />
      </div>
    );
  if (error)
    return (
      <div className="ca-empty" role="alert">
        <p>{error}</p>
        <button type="button" className="ca-secondary" onClick={() => setNonce((n) => n + 1)}>
          Try again
        </button>
      </div>
    );
  if (!view) return <p className="ca-loading" aria-busy="true">Reading this course…</p>;
  return (
    <>
      {notice ? (
        <p className="ca-notice" role="status">
          {notice}
        </p>
      ) : null}
      <AnalyticsDashboard view={view} onAction={(c) => void onAction(c)} onPrep={onOpenItem} onCoursework={onCoursework} busy={busy} />
    </>
  );
}
