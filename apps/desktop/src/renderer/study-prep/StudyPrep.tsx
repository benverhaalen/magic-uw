// owner: study-prep. <StudyPrep courseId assessmentId />: one upcoming exam or quiz as a notebook.
// Left, the Sources (its coverage, all ticked; untick or filter by assignment, module or topic).
// Centre, a zero-token overview and a grounded ask over the ticked sources, or the open study
// material. Right, the Studio: a study guide, a practice quiz and flashcards, made on request
// on the student's own AI, each with its state. Nothing is generated until the student clicks.
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { StudyPrepKind, StudyPrepMaterial, StudyPrepResult, StudyPrepScopeItem, StudyPrepSource, StudyPrepSourceRole } from "@magic/contracts";
import { createOperationScope } from "../../../../../packages/ui/src/operation-scope";
import { MathText } from "./MathText";
import { Icon, type IconName } from "./icons";
import { CardsView, GuideView, QuizView, SourceRef } from "./views";
import { ask, prepGenerate, prepQuery, type AskAnswer, type PrepScope } from "./api";

type Ok = Extract<StudyPrepResult, { status: "ok" }>;
type View = "overview" | StudyPrepKind;
const KINDS: { kind: StudyPrepKind; label: string; icon: IconName; noun: (n: number) => string }[] = [
  { kind: "guide", label: "Study guide", icon: "guide", noun: (n) => `${n} section${n === 1 ? "" : "s"}` },
  { kind: "quiz", label: "Practice quiz", icon: "quiz", noun: (n) => `${n} question${n === 1 ? "" : "s"}` },
  { kind: "cards", label: "Flashcards", icon: "cards", noun: (n) => `${n} card${n === 1 ? "" : "s"}` },
];
const EXAM_ROLES = new Set<StudyPrepSourceRole>(["practice_exam", "past_exam", "solutions", "review_sheet"]);
const ROLE_ICON: Record<StudyPrepSourceRole, IconName> = {
  lecture: "slides", slides: "slides", reading: "reading", homework: "homework", solutions: "key", practice_exam: "exam", review_sheet: "exam", past_exam: "exam", syllabus: "file", other: "file",
};
const ROLE_LABEL: Record<StudyPrepSourceRole, string> = {
  lecture: "Lecture", slides: "Slides", reading: "Reading", homework: "Homework", solutions: "Solutions", practice_exam: "Practice exam", review_sheet: "Review sheet", past_exam: "Past exam", syllabus: "Syllabus", other: "Material",
};

function dateLine(a: Ok["assessment"]): string {
  const parts: string[] = [];
  if (a.date) {
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(a.date) ? `${a.date}T12:00:00` : a.date);
    parts.push(new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", ...(/T\d\d:\d\d/.test(a.date) ? { hour: "numeric", minute: "2-digit" } : {}) }).format(d));
  } else parts.push("Date not found");
  if (a.daysAway !== null) parts.push(a.daysAway === 0 ? "today" : a.daysAway === 1 ? "tomorrow" : a.daysAway > 1 ? `in ${a.daysAway} days` : `${-a.daysAway} days ago`);
  if (a.where) parts.push(a.where);
  if (a.weight !== null) parts.push(`${a.weight}% of grade`);
  return parts.join(" · ");
}
const when = (iso: string | null) => (iso ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso)) : "");

/** The effective selection: ticked sources, narrowed by the assignment and module chips. */
export function effectiveSources(sources: StudyPrepSource[], ticked: ReadonlySet<string> | null, chips: ReadonlySet<string>, items: StudyPrepScopeItem[]): string[] {
  const narrowing = items.filter((i) => i.kind !== "topic" && chips.has(`${i.kind}:${i.id}`));
  const allowed = narrowing.length ? new Set(narrowing.flatMap((i) => i.resourceIds)) : null;
  return sources.map((s) => s.resourceId).filter((id) => (!ticked || ticked.has(id)) && (!allowed || allowed.has(id)));
}

function MaterialState({ m }: { m: StudyPrepMaterial }) {
  if (m.status === "generating") return <Icon name="spinner" spin />;
  if (m.status === "failed") return <span className="sp-dot is-failed" aria-hidden="true" />;
  if (m.status === "stale") return <span className="sp-dot is-stale" aria-hidden="true" />;
  if (m.status === "ready") return <span className="sp-dot is-ready" aria-hidden="true" />;
  return null;
}
function stateText(m: StudyPrepMaterial, noun: (n: number) => string): string {
  switch (m.status) {
    case "missing":
      return "Not made yet. Uses your AI.";
    case "generating":
      return "Making it now…";
    case "ready":
      return `${noun(m.count)} · made ${when(m.generatedAt)}`;
    case "stale":
      return `Sources changed (${m.changed.slice(0, 2).join(", ")}${m.changed.length > 2 ? "…" : ""}). Regenerate to update.`;
    case "failed":
      return m.message ?? "Couldn't make it. Try again.";
  }
}

export function StudyPrep({ courseId, assessmentId }: { courseId: string; assessmentId: string }) {
  const [data, setData] = useState<StudyPrepResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ticked, setTicked] = useState<Set<string> | null>(null);
  const [chips, setChips] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [view, setView] = useState<View>("overview");
  const [pending, setPending] = useState<Set<StudyPrepKind>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const ops = useMemo(() => createOperationScope(), []);
  const ok = data?.status === "ok" ? data : null;

  // Reset when the assessment changes.
  useEffect(() => {
    setData(null);
    setTicked(null);
    setChips(new Set());
    setView("overview");
    setNotice(null);
    return () => ops.invalidate();
  }, [courseId, assessmentId, ops]);

  const selection = useMemo(() => {
    if (!ok) return { resourceIds: undefined as string[] | undefined, topicIds: [] as string[] };
    const ids = effectiveSources(ok.sources, ticked, chips, ok.scopeItems);
    const all = ids.length === ok.sources.length;
    const topicIds = ok.scopeItems.filter((i) => i.kind === "topic" && chips.has(`topic:${i.id}`)).map((i) => i.id);
    return { resourceIds: all ? undefined : ids, topicIds };
  }, [ok, ticked, chips]);
  const selectionKey = JSON.stringify(selection);
  const scope: PrepScope = { courseId, assessmentId, ...(selection.resourceIds ? { resourceIds: selection.resourceIds } : {}), ...(selection.topicIds.length ? { topicIds: selection.topicIds } : {}) };

  const load = useCallback(async () => {
    const ticket = ops.start();
    try {
      const r = await prepQuery(scope);
      if (!ticket.isCurrent()) return;
      setData(r);
      setError(null);
    } catch (e) {
      if (ticket.isCurrent()) setError(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId, assessmentId, selectionKey, ops]);
  useEffect(() => {
    const t = setTimeout(() => void load(), data ? 150 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);
  // Progress: poll the 0-token query while anything is being made.
  const generating = !!ok && KINDS.some((k) => ok.materials[k.kind].status === "generating");
  useEffect(() => {
    if (!generating && !pending.size) return;
    const t = setInterval(() => void load(), 1500);
    return () => clearInterval(t);
  }, [generating, pending.size, load]);

  const generate = async (kinds: StudyPrepKind[]) => {
    if (!ok || !kinds.length) return;
    setPending((p) => new Set([...p, ...kinds]));
    setNotice(null);
    void load();
    try {
      const r = await prepGenerate(kinds, scope);
      if (r.status !== "done") setNotice(r.message);
      else if (kinds.length === 1) setView(kinds[0]!);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setPending((p) => new Set([...p].filter((k) => !kinds.includes(k))));
      void load();
    }
  };

  if (error && !data)
    return (
      <section className="sp sp-state" aria-label="Study prep">
        <p className="sp-error" role="alert">
          <Icon name="alert" /> {error}
        </p>
        <button className="sp-button" onClick={() => void load()}>
          <Icon name="refresh" /> Try again
        </button>
      </section>
    );
  if (!data)
    return (
      <section className="sp sp-state" aria-label="Study prep" aria-busy="true">
        <div className="sp-skeleton" />
        <div className="sp-skeleton short" />
      </section>
    );
  if (data.status !== "ok")
    return (
      <section className="sp sp-state" aria-label="Study prep">
        <p className="sp-quiet">{data.status === "list" ? "Choose an exam or quiz." : data.message}</p>
      </section>
    );

  const d = data;
  const nothingTicked = !!selection.resourceIds && selection.resourceIds.length === 0;
  const studioBlocked = d.restricted ? "This course restricts AI-made study material." : nothingTicked ? "Tick at least one source." : null;
  const material = (k: StudyPrepKind) => d.materials[k];
  const isBusy = (k: StudyPrepKind) => pending.has(k) || material(k).status === "generating";
  const missingKinds = KINDS.map((k) => k.kind).filter((k) => material(k).status !== "ready" && !isBusy(k));

  return (
    <section className="sp" aria-label={`Study prep: ${d.assessment.title}`}>
      <header className="sp-head">
        <div className="sp-head-main">
          <h2 className="sp-title">{d.assessment.title}</h2>
          <p className="sp-meta">{dateLine(d.assessment)}</p>
        </div>
        <span
          className="sp-chip sp-mastery"
          title={d.mastery ? `Mastered ${d.mastery.counts.solid} · Getting there ${d.mastery.counts.getting_there} · Iffy ${d.mastery.counts.iffy} · Not seen ${d.mastery.counts.not_seen}. From your practice answers, not a grade prediction.` : "Practice on these topics to see where you stand."}
        >
          {d.mastery ? d.mastery.label : "No practice yet"}
        </span>
      </header>
      <div className="sp-body">
        <SourcesPanel data={d} ticked={ticked} setTicked={setTicked} chips={chips} setChips={setChips} search={search} setSearch={setSearch} selected={selection.resourceIds ?? d.sources.map((s) => s.resourceId)} />
        <main className="sp-center" aria-label={view === "overview" ? "Overview and questions" : KINDS.find((k) => k.kind === view)!.label}>
          {view !== "overview" ? (
            <div className="sp-center-bar">
              <button className="sp-icon-button" aria-label="Back to overview" title="Back to overview" onClick={() => setView("overview")}>
                <Icon name="prev" />
              </button>
              <span className="sp-center-title">{KINDS.find((k) => k.kind === view)!.label}</span>
              {material(view).status === "stale" ? <span className="sp-chip is-stale" title={material(view).changed.join(", ")}>Sources changed</span> : null}
            </div>
          ) : null}
          <div className="sp-center-scroll">
            {view === "overview" ? (
              <Overview data={d} />
            ) : view === "guide" && material("guide").guide ? (
              <GuideView guide={material("guide").guide!} />
            ) : view === "quiz" && material("quiz").quiz ? (
              <QuizView items={material("quiz").quiz!} />
            ) : view === "cards" && material("cards").cards ? (
              <CardsView cards={material("cards").cards!} courseId={courseId} assessmentId={d.assessment.id} anchorIds={d.anchorIds} />
            ) : (
              <p className="sp-quiet">{isBusy(view) ? "Making it now…" : stateText(material(view), KINDS.find((k) => k.kind === view)!.noun)}</p>
            )}
            {view === "overview" ? <AskPanel scope={scope} disabled={nothingTicked} key={selectionKey} /> : null}
          </div>
        </main>
        <aside className="sp-studio" aria-label="Studio">
          <div className="sp-pane-head">
            <span>Studio</span>
            <button
              className="sp-icon-button"
              aria-label="Make everything that's missing in one call"
              title={missingKinds.length > 1 ? `Make ${missingKinds.length} at once: one call sends your sources once` : "Everything is made"}
              disabled={!!studioBlocked || missingKinds.length < 2}
              onClick={() => void generate(missingKinds)}
            >
              <Icon name="all" />
            </button>
          </div>
          <div className="sp-tools" role="group" aria-label="Make study material">
            {KINDS.map(({ kind, label, icon, noun }) => {
              const m = material(kind);
              const busy = isBusy(kind);
              const has = m.status === "ready" || m.status === "stale" || (m.count > 0 && m.status !== "missing");
              return (
                <div key={kind} className={`sp-tool is-${busy ? "generating" : m.status}`}>
                  <button
                    className="sp-tool-main"
                    title={studioBlocked ?? `${label}: ${stateText(m, noun)}`}
                    aria-label={`${label}. ${stateText(m, noun)}`}
                    disabled={!!studioBlocked && !has}
                    onClick={() => (has ? setView(kind) : void generate([kind]))}
                  >
                    <Icon name={icon} />
                    <span className="sp-tool-label">{label}</span>
                    {m.count ? <span className="sp-badge">{m.count}</span> : null}
                    {busy ? <Icon name="spinner" spin /> : <MaterialState m={m} />}
                  </button>
                  {has || m.status === "failed" ? (
                    <button
                      className="sp-icon-button"
                      aria-label={`Regenerate ${label.toLowerCase()}`}
                      title={m.status === "ready" ? "Up to date with your sources (regenerating costs nothing and changes nothing)" : `Regenerate ${label.toLowerCase()}`}
                      disabled={busy || !!studioBlocked}
                      onClick={() => void generate([kind])}
                    >
                      <Icon name="refresh" />
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
          {notice ? (
            <p className="sp-notice" role="alert">
              <Icon name="alert" /> {notice}
            </p>
          ) : null}
          {studioBlocked ? <p className="sp-quiet">{studioBlocked}</p> : <p className="sp-hint">Made from the ticked sources on your AI. Every quote is checked against them.</p>}
        </aside>
      </div>
    </section>
  );
}

function SourcesPanel({
  data,
  ticked,
  setTicked,
  chips,
  setChips,
  search,
  setSearch,
  selected,
}: {
  data: Ok;
  ticked: Set<string> | null;
  setTicked: (v: Set<string> | null) => void;
  chips: Set<string>;
  setChips: (v: Set<string>) => void;
  search: string;
  setSearch: (v: string) => void;
  selected: string[];
}) {
  const all = data.sources.map((s) => s.resourceId);
  const isTicked = (id: string) => !ticked || ticked.has(id);
  const toggle = (id: string) => {
    const next = new Set(ticked ?? all);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setTicked(next.size === all.length ? null : next);
  };
  const toggleChip = (key: string) => {
    const next = new Set(chips);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setChips(next);
  };
  const q = search.trim().toLowerCase();
  const visible = data.sources.filter((s) => !q || s.title.toLowerCase().includes(q) || (s.moduleLabel ?? "").toLowerCase().includes(q));
  const groups = [
    { title: "Materials", rows: visible.filter((s) => !EXAM_ROLES.has(s.role)) },
    { title: "Past & practice exams", rows: visible.filter((s) => EXAM_ROLES.has(s.role)) },
  ].filter((g) => g.rows.length);
  // A module or assignment chip that selects no source would only empty the list, so it isn't shown.
  const chipItems = data.scopeItems.filter((i) => (i.kind === "topic" || i.resourceIds.length > 0) && (!q || i.title.toLowerCase().includes(q)));
  const allTicked = !ticked;
  return (
    <aside className="sp-sources" aria-label="Sources">
      <div className="sp-pane-head">
        <label className="sp-check-all" title={allTicked ? "Untick all" : "Tick all"}>
          <input type="checkbox" checked={allTicked} ref={(el) => { if (el) el.indeterminate = !!ticked && ticked.size > 0; }} onChange={() => setTicked(allTicked ? new Set() : null)} />
          <span>Sources</span>
        </label>
        <span className="sp-count" title="Sources used for the Studio and questions">
          {selected.length}/{all.length}
        </span>
      </div>
      <label className="sp-search">
        <Icon name="search" />
        <input type="search" placeholder="Filter" aria-label="Filter sources and chips" value={search} onChange={(e) => setSearch(e.target.value)} />
      </label>
      {chipItems.length ? (
        <div className="sp-chips" role="group" aria-label="Narrow by assignment, module or topic">
          {chipItems.map((i) => {
            const key = `${i.kind}:${i.id}`;
            const on = chips.has(key);
            return (
              <button
                key={key}
                className={`sp-chip is-${i.kind} ${on ? "is-on" : ""}`}
                aria-pressed={on}
                title={i.kind === "topic" ? `Focus on ${i.title}` : `Only sources for ${i.title} (${i.resourceIds.length})`}
                onClick={() => toggleChip(key)}
                disabled={i.kind !== "topic" && !i.resourceIds.length}
              >
                {i.title}
              </button>
            );
          })}
          {chips.size ? (
            <button className="sp-chip is-clear" onClick={() => setChips(new Set())} aria-label="Clear filters" title="Clear filters">
              <Icon name="x" />
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="sp-source-list">
        {groups.map((g) => (
          <section key={g.title} aria-label={g.title}>
            <h3 className="sp-group-title">{g.title}</h3>
            <ul>
              {g.rows.map((s) => {
                const used = selected.includes(s.resourceId);
                return (
                  <li key={s.resourceId} className={`sp-source ${used ? "" : "is-off"}`} title={s.reason}>
                    <label>
                      <input type="checkbox" checked={isTicked(s.resourceId)} onChange={() => toggle(s.resourceId)} />
                      <span className="sp-role" title={ROLE_LABEL[s.role]}>
                        <Icon name={ROLE_ICON[s.role]} />
                      </span>
                      <span className="sp-source-title">{s.title}</span>
                    </label>
                    <a className="sp-icon-button" href={`#resource/${encodeURIComponent(s.resourceId)}`} aria-label={`Open ${s.title}`} title="Open source">
                      <Icon name="next" />
                    </a>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {!groups.length ? <p className="sp-quiet">{data.sources.length ? "No source matches the filter." : "No study sources are linked to this assessment yet."}</p> : null}
      </div>
    </aside>
  );
}

function Overview({ data }: { data: Ok }) {
  const o = data.overview;
  return (
    <div className="sp-overview">
      {o.covered.length ? (
        <section>
          <h3 className="sp-group-title">Covers</h3>
          {o.covered.map((c, i) => (
            <blockquote key={i} className="sp-quote">
              {c.text}
              {c.source ? <SourceRef source={c.source} /> : null}
            </blockquote>
          ))}
        </section>
      ) : null}
      {o.modules.length || o.topics.length ? (
        <section>
          <h3 className="sp-group-title">Topics</h3>
          <p className="sp-tags">
            {o.topics.length ? o.topics.map((t) => <span key={t.id} className="sp-tag">{t.label}</span>) : o.modules.map((m) => <span key={m} className="sp-tag">{m}</span>)}
          </p>
        </section>
      ) : null}
      {o.keyTerms.length ? (
        <section>
          <h3 className="sp-group-title">Key terms</h3>
          <ul className="sp-terms">
            {o.keyTerms.map((t, i) => (
              <li key={i} className={`sp-term is-${t.kind}`}>
                <span>{t.value}</span>
                <SourceRef source={t.source} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="sp-facts">
        {o.dates.map((d) => (
          <span key={d.label} className="sp-fact">
            <span className="sp-fact-label">{d.label}</span> {d.date.slice(0, 10)}
          </span>
        ))}
        {o.length ? (
          <span className="sp-fact">
            <span className="sp-fact-label">Length</span> {o.length}
          </span>
        ) : null}
        {o.format ? (
          <span className="sp-fact sp-fact-wide">
            <span className="sp-fact-label">Format</span> {o.format}
          </span>
        ) : null}
      </section>
      {o.warnings.map((w) => (
        <p key={w} className="sp-hint">
          <Icon name="alert" /> {w}
        </p>
      ))}
    </div>
  );
}

interface Turn {
  question: string;
  answer: AskAnswer | null;
  error?: string;
}
function AskPanel({ scope, disabled }: { scope: PrepScope; disabled: boolean }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  // A block body: scrollIntoView returns a Promise in current Chromium, and an effect may only return a cleanup.
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "nearest" });
  }, [turns.length]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const question = text.trim();
    if (!question || busy || disabled) return;
    setText("");
    setBusy(true);
    setTurns((t) => [...t, { question, answer: null }]);
    try {
      const answer = await ask(scope, question);
      setTurns((t) => t.map((x, i) => (i === t.length - 1 ? { ...x, answer } : x)));
    } catch (err) {
      setTurns((t) => t.map((x, i) => (i === t.length - 1 ? { ...x, error: err instanceof Error ? err.message : String(err) } : x)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="sp-ask" aria-label="Ask about the ticked sources">
      {turns.length ? (
        <ol className="sp-turns">
          {turns.map((t, i) => (
            <li key={i} className="sp-turn">
              <p className="sp-q">{t.question}</p>
              {t.error ? (
                <p className="sp-error" role="alert">{t.error}</p>
              ) : !t.answer ? (
                <p className="sp-quiet" aria-busy="true">
                  <Icon name="spinner" spin /> Reading your sources…
                </p>
              ) : t.answer.unavailable ? (
                <p className="sp-notice">{t.answer.unavailable}</p>
              ) : (
                <div className="sp-a">
                  <MathText text={t.answer.notFound ? "Not in the ticked sources." : t.answer.text} />
                  {t.answer.citations.length ? (
                    <span className="sp-cites">
                      {t.answer.citations.map((c, j) => (
                        <SourceRef key={j} source={{ resourceId: c.resourceId, title: c.title, url: c.url, quote: c.quote, start: null, end: null }} />
                      ))}
                    </span>
                  ) : null}
                </div>
              )}
            </li>
          ))}
        </ol>
      ) : null}
      <div ref={end} />
      <form className="sp-composer" onSubmit={(e) => void submit(e)}>
        <Icon name="chat" />
        <input type="text" value={text} onChange={(e) => setText(e.target.value)} placeholder={disabled ? "Tick a source to ask" : "Ask about these sources"} aria-label="Ask a question about the ticked sources" disabled={disabled} maxLength={2000} />
        <button className="sp-icon-button" type="submit" aria-label="Ask" title="Ask (uses your AI)" disabled={disabled || busy || !text.trim()}>
          <Icon name="send" />
        </button>
      </form>
    </section>
  );
}

/** The course page's entry: each upcoming exam or quiz with a "Study prep" button. */
export function StudyPrepEntries({ courseId, onOpen }: { courseId: string; onOpen: (assessmentId: string, title: string) => void }) {
  const [data, setData] = useState<StudyPrepResult | null>(null);
  useEffect(() => {
    let live = true;
    prepQuery({ courseId })
      .then((r) => live && setData(r))
      .catch(() => live && setData(null));
    return () => {
      live = false;
    };
  }, [courseId]);
  if (data?.status !== "list" || !data.upcoming.length) return null;
  return (
    <section className="course-section sp-course-entries" aria-labelledby="sp-entries-title">
      <h2 id="sp-entries-title">Study prep</h2>
    <ul className="sp-entries">
      {data.upcoming.map((a) => (
        <li key={a.id}>
          <button className="sp-entry" onClick={() => onOpen(a.id, a.title)} title={`Study prep for ${a.title}`}>
            <Icon name="guide" />
            <span className="sp-entry-title">{a.title}</span>
            <span className="sp-entry-when">{dateLine(a)}</span>
          </button>
        </li>
      ))}
    </ul>
    </section>
  );
}
