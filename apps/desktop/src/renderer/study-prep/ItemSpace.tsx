// owner: study-prep. <ItemSpace courseId itemId />: one space per work item (an assignment, quiz,
// exam, lab, essay, reading…), the same grammar for every kind, catered to what it is. Header (what
// and when, status, readiness, cards due, Open in Canvas), then its study actions, then "What you
// need": the sections its type lists (instructions, coverage, rubric, milestones…) and the linked
// materials, ticked as the sources the actions use. Nothing is generated until the student clicks.
// Keys: the letter on each action, O opens Canvas, Esc goes back.
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { ITEM_SPACE, ITEM_TYPES, STUDY_PREP_KINDS, type ItemAction, type ItemActionId, type ItemSectionId, type ItemType, type StudyPrepItem, type StudyPrepKind, type StudyPrepMaterial, type StudyPrepResult, type StudyPrepScopeItem, type StudyPrepSource, type StudyPrepSourceRole } from "@magic/contracts";
import { createOperationScope } from "../../../../../packages/ui/src/operation-scope";
import { Disclosure } from "../../../../../packages/ui/src/components";
import { MathText } from "./MathText";
import { Icon, type IconName } from "./icons";
import { CardsView, ExamView, GuideView, MilestonesView, OutlineView, ProblemsView, QuizView, RubricView, SourceRef } from "./views";
import { ask, correctType, openExternal, prepGenerate, prepQuery, type AskAnswer, type PrepScope } from "./api";

type Ok = Extract<StudyPrepResult, { status: "ok" }>;
type View = "need" | ItemActionId;
const isKind = (id: ItemActionId): id is StudyPrepKind => (STUDY_PREP_KINDS as readonly string[]).includes(id);
const ACTION_ICON: Record<ItemActionId, IconName> = {
  guide: "guide", quiz: "quiz", cards: "cards", exam: "exam", problems: "homework", outline: "reading", review: "flip", rubric_check: "check", milestone_plan: "quiz", ask: "chat",
};
const EXAM_ROLES = new Set<StudyPrepSourceRole>(["practice_exam", "past_exam", "solutions", "review_sheet"]);
const ROLE_ICON: Record<StudyPrepSourceRole, IconName> = {
  lecture: "slides", slides: "slides", reading: "reading", file: "file", page: "file", homework: "homework", solutions: "key", practice_exam: "exam", review_sheet: "exam", past_exam: "exam", syllabus: "file", other: "file",
};
const ROLE_LABEL: Record<StudyPrepSourceRole, string> = {
  lecture: "Lecture", slides: "Slides", reading: "Reading", file: "File", page: "Page", homework: "Homework", solutions: "Solutions", practice_exam: "Practice exam", review_sheet: "Review sheet", past_exam: "Past exam", syllabus: "Syllabus", other: "Material",
};
const SECTION_TITLE: Record<ItemSectionId, string> = {
  blueprint: "What it covers", past_exams: "Past and practice exams", readiness: "Where you stand", topics: "Topics", cards_due: "Cards", instructions: "Instructions", worked_examples: "Worked examples",
  formulas: "Formulas and definitions", rubric: "Rubric", readings: "Readings", citation_style: "Citation style", safety: "Safety and equipment", milestones: "Milestones", contacts: "Contacts",
  material: "The material", when_where: "When and where", materials: "Linked materials", sessions: "Class sessions", announcements: "Announcements",
};

export function dateLine(a: Pick<StudyPrepItem, "date" | "daysAway">): string {
  const parts: string[] = [];
  if (a.date) {
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(a.date) ? `${a.date}T12:00:00` : a.date);
    parts.push(new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", ...(/T\d\d:\d\d/.test(a.date) ? { hour: "numeric", minute: "2-digit" } : {}) }).format(d));
  } else parts.push("No date");
  if (a.daysAway !== null) parts.push(a.daysAway === 0 ? "today" : a.daysAway === 1 ? "tomorrow" : a.daysAway > 1 ? `in ${a.daysAway} days` : `${-a.daysAway} days ago`);
  return parts.join(" · ");
}
const when = (iso: string | null) => (iso ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso)) : "");

/** The effective selection: ticked sources, narrowed by the assignment and module chips. */
export function effectiveSources(sources: StudyPrepSource[], ticked: ReadonlySet<string> | null, chips: ReadonlySet<string>, items: StudyPrepScopeItem[]): string[] {
  const narrowing = items.filter((i) => i.kind !== "topic" && chips.has(`${i.kind}:${i.id}`));
  const allowed = narrowing.length ? new Set(narrowing.flatMap((i) => i.resourceIds)) : null;
  return sources.map((s) => s.resourceId).filter((id) => (!ticked || ticked.has(id)) && (!allowed || allowed.has(id)));
}

function stateText(m: StudyPrepMaterial): string {
  switch (m.status) {
    case "missing":
      return "Not made yet";
    case "generating":
      return "Making it now…";
    case "ready":
      return `Made ${when(m.generatedAt)}`;
    case "stale":
      return "Materials changed since it was made";
    case "failed":
      return m.message ?? "Couldn't make it";
  }
}

function statusChips(item: StudyPrepItem): string[] {
  const s = item.status;
  return [s.graded ? `Graded ${s.graded}` : s.submitted ? "Submitted" : s.missing ? "Missing" : "", s.availability === "closed" && !s.submitted ? "Closed" : s.availability === "not_yet_open" ? "Not open yet" : ""].filter(Boolean);
}

export function ItemSpace({ courseId, itemId, initialAction, onClose }: { courseId: string; itemId: string; initialAction?: ItemActionId; onClose?: () => void }) {
  const [data, setData] = useState<StudyPrepResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ticked, setTicked] = useState<Set<string> | null>(null);
  const [chips, setChips] = useState<Set<string>>(new Set());
  const [view, setView] = useState<View>(initialAction ?? "need");
  const [pending, setPending] = useState<Set<StudyPrepKind>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const ops = useMemo(() => createOperationScope(), []);
  const root = useRef<HTMLElement>(null);
  const ok = data?.status === "ok" ? data : null;

  useEffect(() => {
    setData(null);
    setTicked(null);
    setChips(new Set());
    setView(initialAction ?? "need");
    setNotice(null);
    return () => ops.invalidate();
  }, [courseId, itemId, initialAction, ops]);

  const selection = useMemo(() => {
    if (!ok) return { resourceIds: undefined as string[] | undefined, topicIds: [] as string[] };
    const ids = effectiveSources(ok.sources, ticked, chips, ok.scopeItems);
    const all = ids.length === ok.sources.length;
    const topicIds = ok.scopeItems.filter((i) => i.kind === "topic" && chips.has(`topic:${i.id}`)).map((i) => i.id);
    return { resourceIds: all ? undefined : ids, topicIds };
  }, [ok, ticked, chips]);
  const selectionKey = JSON.stringify(selection);
  const scope: PrepScope = { courseId, itemId, ...(selection.resourceIds ? { resourceIds: selection.resourceIds } : {}), ...(selection.topicIds.length ? { topicIds: selection.topicIds } : {}) };

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
  }, [courseId, itemId, selectionKey, ops]);
  useEffect(() => {
    const t = setTimeout(() => void load(), data ? 150 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);
  // Progress: poll the 0-token query while anything is being made.
  const generating = !!ok && STUDY_PREP_KINDS.some((k) => ok.materials[k].status === "generating");
  useEffect(() => {
    if (!generating && !pending.size) return;
    const t = setInterval(() => void load(), 1500);
    return () => clearInterval(t);
  }, [generating, pending.size, load]);

  const generate = async (kinds: StudyPrepKind[]) => {
    if (!ok || !kinds.length) return;
    setPending((p) => new Set([...p, ...kinds]));
    setNotice(null);
    try {
      const r = await prepGenerate(kinds, scope);
      if (r.status !== "done") setNotice(r.message);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setPending((p) => new Set([...p].filter((k) => !kinds.includes(k))));
      void load();
    }
  };

  const activate = (a: ItemAction) => {
    if (!ok) return;
    if (isKind(a.id)) {
      const m = ok.materials[a.id];
      if (m.status === "missing" || m.status === "failed") void generate([a.id]);
    }
    setView(a.id);
  };
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    const t = e.target as HTMLElement;
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || t.closest("input, textarea, select, [contenteditable]")) return;
    if (e.key === "Escape") {
      if (view !== "need") {
        e.preventDefault();
        e.stopPropagation();
        setView("need");
      } else if (onClose) {
        e.preventDefault();
        onClose();
      }
      return;
    }
    if (!ok) return;
    const key = e.key.toLowerCase();
    if (key === "o" && ok.item.url) {
      e.preventDefault();
      void openExternal(ok.item.url);
      return;
    }
    const a = ok.config.actions.find((x) => x.key === key);
    if (a) {
      e.preventDefault();
      activate(a);
    }
  };

  if (error && !data)
    return (
      <section className="sp sp-state" aria-label="Item">
        <p className="sp-error" role="alert">
          <Icon name="alert" /> {error}
        </p>
        <button className="sp-button" onClick={() => void load()}>
          <Icon name="refresh" /> Try again
        </button>
      </section>
    );
  if (!data) return <ItemSkeleton />;
  if (data.status !== "ok")
    return (
      <section className="sp sp-state" aria-label="Item">
        <p className="sp-quiet">{data.status === "list" ? "Choose an item." : data.message}</p>
      </section>
    );

  return <ItemSpaceView data={data} view={view} setView={setView} ticked={ticked} setTicked={setTicked} chips={chips} setChips={setChips} selection={selection} scope={scope} pending={pending} notice={notice} generate={generate} activate={activate} load={load} onKey={onKey} rootRef={root} />;
}

export interface ItemSpaceViewProps {
  data: Ok;
  view: View;
  setView: (v: View) => void;
  ticked: Set<string> | null;
  setTicked: (v: Set<string> | null) => void;
  chips: Set<string>;
  setChips: (v: Set<string>) => void;
  selection: { resourceIds: string[] | undefined; topicIds: string[] };
  scope: PrepScope;
  pending: ReadonlySet<StudyPrepKind>;
  notice: string | null;
  generate: (kinds: StudyPrepKind[]) => Promise<void> | void;
  activate: (a: ItemAction) => void;
  load: () => Promise<void> | void;
  onKey?: (e: KeyboardEvent<HTMLElement>) => void;
  rootRef?: React.RefObject<HTMLElement | null>;
}
/** The space for loaded data: pure, so each item type's layout renders from a query result alone. */
export function ItemSpaceView({ data, view, setView, ticked, setTicked, chips, setChips, selection, scope, pending, notice, generate, activate, load, onKey, rootRef }: ItemSpaceViewProps) {
  const d = data;
  const root = rootRef;
  const nothingTicked = !!selection.resourceIds && selection.resourceIds.length === 0;
  const blocked = d.restricted ? "This course restricts AI-made study material." : nothingTicked ? "Tick at least one material." : null;
  const material = (k: StudyPrepKind) => d.materials[k];
  const busy = (k: StudyPrepKind) => pending.has(k) || material(k).status === "generating";
  const kinds = d.config.actions.map((a) => a.id).filter(isKind);
  const missing = kinds.filter((k) => (material(k).status === "missing" || material(k).status === "failed") && !busy(k));
  const current = view === "need" ? null : d.config.actions.find((a) => a.id === view) ?? null;

  return (
    <section className="sp sp-space" ref={root} aria-label={`${d.item.title}`} tabIndex={-1} onKeyDown={onKey}>
      <Header data={d} onReload={() => void load()} />
      {d.config.actions.length ? (
        <div className="sp-actions" role="toolbar" aria-label="Study actions">
          {d.config.actions.map((a) => {
            const k = isKind(a.id) ? a.id : null;
            const m = k ? material(k) : null;
            const count = m ? m.count : a.id === "review" ? d.review.due : 0;
            const state = k ? (busy(k) ? "generating" : m!.status) : "code";
            const disabled = !!blocked && !!k && !m!.count;
            return (
              <button
                key={a.id + a.label}
                className={`sp-action is-${state} ${view === a.id ? "is-open" : ""}`}
                onClick={() => activate(a)}
                disabled={disabled}
                aria-pressed={view === a.id}
                aria-keyshortcuts={a.key.toUpperCase()}
                title={`${a.hint}${k ? `. ${stateText(m!)}` : ""} (${a.key.toUpperCase()})`}
              >
                <Icon name={ACTION_ICON[a.id]} />
                <span className="sp-action-text">
                  <span className="sp-action-label">{a.label}</span>
                  <span className="sp-action-state">{k ? (busy(k) ? "Making it…" : m!.status === "ready" ? `${m!.count} ready` : m!.status === "stale" ? "Update available" : m!.status === "failed" ? "Try again" : "Make it") : a.id === "review" ? `${d.review.due} due` : "Open"}</span>
                </span>
                {k && busy(k) ? <Icon name="spinner" spin /> : count ? <span className="sp-badge">{count}</span> : null}
                <span className="sp-kbd" aria-hidden="true">{a.key.toUpperCase()}</span>
              </button>
            );
          })}
          {missing.length > 1 && !blocked ? (
            <button className="sp-icon-button sp-make-all" onClick={() => void generate(missing)} aria-label={`Make ${missing.length} at once`} title={`Make ${missing.length} at once: one request sends your materials once`}>
              <Icon name="all" />
            </button>
          ) : null}
        </div>
      ) : null}
      {notice ? (
        <p className="sp-notice" role="alert">
          <Icon name="alert" /> {notice}
        </p>
      ) : null}
      <div className="sp-main">
        {current ? (
          <div className="sp-view" key={view}>
            <div className="sp-center-bar">
              <button className="sp-icon-button" aria-label="Back to what you need" title="Back (Esc)" onClick={() => setView("need")}>
                <Icon name="prev" />
              </button>
              <span className="sp-center-title">{current.label}</span>
              {isKind(current.id) && material(current.id).status === "stale" ? (
                <button className="sp-chip is-stale" onClick={() => void generate([current.id as StudyPrepKind])} title={`Changed: ${material(current.id).changed.join(", ")}`}>
                  <Icon name="refresh" /> Update
                </button>
              ) : null}
              {isKind(current.id) && (material(current.id).status === "ready" || material(current.id).status === "stale") ? (
                <span className="sp-hint">{stateText(material(current.id))}</span>
              ) : null}
            </div>
            <ActionView action={current} data={d} scope={scope} busy={isKind(current.id) && busy(current.id)} blocked={blocked} onMake={() => isKind(current.id) && void generate([current.id])} />
          </div>
        ) : (
          <WhatYouNeed data={d} ticked={ticked} setTicked={setTicked} chips={chips} setChips={setChips} selected={selection.resourceIds ?? d.sources.map((s) => s.resourceId)} onAction={(id) => { const a = d.config.actions.find((x) => x.id === id); if (a) activate(a); }} scope={scope} askDisabled={nothingTicked} />
        )}
      </div>
    </section>
  );
}

function ItemSkeleton() {
  return (
    <section className="sp sp-space" aria-label="Item" aria-busy="true">
      <div className="sp-skeleton short" />
      <div className="sp-skeleton" />
      <div className="sp-skeleton-row">
        <div className="sp-skeleton sp-skeleton-action" />
        <div className="sp-skeleton sp-skeleton-action" />
        <div className="sp-skeleton sp-skeleton-action" />
      </div>
      <div className="sp-skeleton sp-skeleton-block" />
    </section>
  );
}

function Header({ data, onReload }: { data: Ok; onReload: () => void }) {
  const i = data.item;
  const [typeNote, setTypeNote] = useState<string | null>(null);
  const meta = [dateLine(i), i.where, i.points !== null ? `${i.points} pts` : "", i.weight ? `${i.weight.percent}% of ${i.weight.of === "course" ? "grade" : "its group"}` : ""].filter(Boolean);
  return (
    <header className="sp-head">
      <div className="sp-head-main">
        <p className="sp-kicker">
          <span>{i.courseName}</span>
          <label className="sp-type" title={`${i.typeReason}. Change it if it's wrong.`}>
            <span className="sp-visually-hidden">Item type</span>
            <select
              value={i.type}
              onChange={(e) => {
                const type = e.target.value as ItemType;
                void correctType(i.courseId, i.id, type).then((m) => { setTypeNote(m); onReload(); }).catch((err) => setTypeNote(err instanceof Error ? err.message : String(err)));
              }}
            >
              {ITEM_TYPES.map((t) => (
                <option key={t} value={t}>{ITEM_SPACE[t].label}</option>
              ))}
            </select>
          </label>
          {typeNote ? <span className="sp-hint" role="status">{typeNote}</span> : null}
        </p>
        <h2 className="sp-title">{i.title}</h2>
        <p className="sp-meta">
          {meta.join(" · ")}
          {statusChips(i).map((s) => (
            <span key={s} className="sp-chip is-status">{s}</span>
          ))}
        </p>
      </div>
      <div className="sp-head-side">
        {data.config.actions.length ? (
          <span className="sp-chip sp-mastery" title={data.mastery ? `Mastered ${data.mastery.counts.solid} · Getting there ${data.mastery.counts.getting_there} · Iffy ${data.mastery.counts.iffy} · Not seen ${data.mastery.counts.not_seen}. From your practice answers, not a grade prediction.` : "Practice on its topics to see where you stand."}>
            {data.mastery ? data.mastery.label : "No practice yet"}
          </span>
        ) : null}
        {data.review.cards ? (
          <span className="sp-chip" title={`${data.review.cards} cards linked to this item`}>
            <Icon name="cards" /> {data.review.due} due
          </span>
        ) : null}
        {i.url ? (
          <button className="sp-button" onClick={() => void openExternal(i.url!)} title="Open in Canvas (O)" aria-keyshortcuts="O">
            Open in Canvas <Icon name="next" />
          </button>
        ) : null}
      </div>
    </header>
  );
}

function ActionView({ action, data, scope, busy, blocked, onMake }: { action: ItemAction; data: Ok; scope: PrepScope; busy: boolean; blocked: string | null; onMake: () => void }) {
  const id = action.id;
  if (id === "review") return <CardsView cards={[]} courseId={data.courseId} anchorIds={data.anchorIds} reviewItemIds={data.review.cardItemIds} dueCount={data.review.due} startInReview />;
  if (id === "rubric_check") return <RubricView itemId={data.item.id} rubric={data.sections.rubric ?? []} />;
  if (id === "milestone_plan") return <MilestonesView milestones={data.sections.milestones ?? []} />;
  if (id === "ask") return <AskPanel scope={scope} disabled={!!blocked} />;
  const m = data.materials[id];
  const has = m.status === "ready" || m.status === "stale" || ((m.status === "generating" || m.status === "failed") && m.count > 0);
  if (!has)
    return busy ? (
      <div className="sp-making" aria-busy="true">
        <div className="sp-skeleton" />
        <div className="sp-skeleton short" />
        <div className="sp-skeleton" />
        <p className="sp-hint">Your AI is reading the ticked materials. Every quote is checked before it shows here.</p>
      </div>
    ) : (
      <div className="sp-empty">
        <p className="sp-quiet">{m.status === "failed" ? (m.message ?? "Couldn't make it.") : action.hint}</p>
        <button className="sp-button sp-primary" onClick={onMake} disabled={!!blocked} title={blocked ?? "Uses your AI"}>
          <Icon name={ACTION_ICON[id]} /> {m.status === "failed" ? "Try again" : `Make ${action.label.toLowerCase()}`}
        </button>
        {blocked ? <p className="sp-hint">{blocked}</p> : null}
      </div>
    );
  if (id === "guide" && m.guide) return <GuideView guide={m.guide} />;
  if (id === "quiz" && m.quiz) return <QuizView items={m.quiz} />;
  if (id === "cards" && m.cards) return <CardsView cards={m.cards} courseId={data.courseId} anchorIds={data.anchorIds} reviewItemIds={data.review.cardItemIds} dueCount={data.review.due} />;
  if (id === "exam" && m.exam) return <ExamView exam={m.exam} />;
  if (id === "problems" && m.problems) return <ProblemsView problems={m.problems} />;
  if (id === "outline" && m.outline) return <OutlineView outline={m.outline} />;
  return <p className="sp-quiet">Nothing to show yet.</p>;
}

function Section({ id, children, count }: { id: ItemSectionId; children: ReactNode; count?: number }) {
  return (
    <section className={`sp-section sp-section-${id}`} aria-labelledby={`sp-s-${id}`}>
      <h3 className="sp-group-title" id={`sp-s-${id}`}>
        {SECTION_TITLE[id]}
        {count ? <span className="sp-count">{count}</span> : null}
      </h3>
      {children}
    </section>
  );
}

function LongText({ text }: { text: string }) {
  const lines = text.split("\n");
  if (lines.length <= 14 && text.length <= 1400) return <div className="sp-prose">{text}</div>;
  const head = lines.slice(0, 10).join("\n").slice(0, 1000);
  return (
    <div className="sp-prose">
      {head}
      <Disclosure label="Show all">
        <div className="sp-prose">{text.slice(head.length)}</div>
      </Disclosure>
    </div>
  );
}

function WhatYouNeed({ data, ticked, setTicked, chips, setChips, selected, onAction, scope, askDisabled }: { data: Ok; ticked: Set<string> | null; setTicked: (v: Set<string> | null) => void; chips: Set<string>; setChips: (v: Set<string>) => void; selected: string[]; onAction: (id: ItemActionId) => void; scope: PrepScope; askDisabled: boolean }) {
  const s = data.sections;
  const o = data.overview;
  const has = (id: ItemSectionId) => data.config.sections.includes(id);
  const blocks: ReactNode[] = [];
  for (const id of data.config.sections) {
    if (id === "instructions" && data.instructions) blocks.push(<Section key={id} id={id}><LongText text={data.instructions.text} /></Section>);
    if (id === "blueprint" && (o.covered.length || o.modules.length || o.format || o.dates.length))
      blocks.push(
        <Section key={id} id={id}>
          {o.covered.map((c, i) => (
            <blockquote key={i} className="sp-quote">
              {c.text}
              {c.source ? <SourceRef source={c.source} /> : null}
            </blockquote>
          ))}
          {o.modules.length ? <p className="sp-tags">{o.modules.map((m) => <span key={m} className="sp-tag">{m}</span>)}</p> : null}
          <p className="sp-facts">
            {o.dates.map((x) => <span key={x.label} className="sp-fact"><span className="sp-fact-label">{x.label}</span> {x.date.slice(0, 10)}</span>)}
            {o.length ? <span className="sp-fact"><span className="sp-fact-label">Length</span> {o.length}</span> : null}
            {o.format ? <span className="sp-fact sp-fact-wide"><span className="sp-fact-label">Format</span> {o.format}</span> : null}
          </p>
        </Section>,
      );
    if (id === "readiness" && s.readiness?.length)
      blocks.push(
        <Section key={id} id={id}>
          <ul className="sp-readiness">
            {s.readiness.map((t) => (
              <li key={t.topicId}><span className={`sp-dot is-${t.state}`} aria-hidden="true" /> {t.label} <span className="sp-hint">{t.stateLabel}</span></li>
            ))}
          </ul>
        </Section>,
      );
    if (id === "past_exams" && s.pastExams?.length)
      blocks.push(
        <Section key={id} id={id} count={s.pastExams.length}>
          <ul className="sp-list">
            {s.pastExams.map((p) => (
              <li key={p.resourceId}><Icon name={ROLE_ICON[p.role]} /> <a href={`#resource/${encodeURIComponent(p.resourceId)}`}>{p.title}</a> <span className="sp-hint">{ROLE_LABEL[p.role]}</span></li>
            ))}
          </ul>
        </Section>,
      );
    if (id === "topics" && o.topics.length) blocks.push(<Section key={id} id={id}><p className="sp-tags">{o.topics.map((t) => <span key={t.id} className="sp-tag">{t.label}</span>)}</p></Section>);
    if (id === "cards_due")
      blocks.push(
        <Section key={id} id={id}>
          <p className="sp-row sp-row-start">
            <span>{data.review.cards ? `${data.review.due} of ${data.review.cards} due today` : "No cards for these topics yet."}</span>
            {data.review.due ? <button className="sp-button" onClick={() => onAction("review")}><Icon name="flip" /> Quick review</button> : null}
          </p>
        </Section>,
      );
    if (id === "worked_examples" && s.workedExamples?.length)
      blocks.push(<Section key={id} id={id}><ul className="sp-list">{s.workedExamples.map((w, i) => <li key={i}><span>{w.text}</span> <SourceRef source={w.source} /></li>)}</ul></Section>);
    if (id === "formulas" && o.keyTerms.length)
      blocks.push(<Section key={id} id={id}><ul className="sp-terms">{o.keyTerms.map((t, i) => <li key={i} className={`sp-term is-${t.kind}`}><span>{t.value}</span><SourceRef source={t.source} /></li>)}</ul></Section>);
    if (id === "rubric")
      blocks.push(
        <Section key={id} id={id} count={s.rubric?.length}>
          {s.rubric?.length ? (
            <p className="sp-row sp-row-start">
              <span>{s.rubric.length} criteria{s.rubric.some((c) => c.points !== null) ? `, ${s.rubric.reduce((n, c) => n + (c.points ?? 0), 0)} points` : ""}</span>
              {data.config.actions.some((a) => a.id === "rubric_check") ? <button className="sp-button" onClick={() => onAction("rubric_check")}><Icon name="check" /> Checklist</button> : null}
            </p>
          ) : <p className="sp-quiet">No rubric was posted.</p>}
        </Section>,
      );
    if (id === "readings") {
      const readings = data.sources.filter((x) => x.role === "reading" || x.role === "file" || x.role === "page");
      if (readings.length) blocks.push(<Section key={id} id={id} count={readings.length}><ul className="sp-list">{readings.map((r) => <li key={r.resourceId}><Icon name={ROLE_ICON[r.role]} /> <a href={`#resource/${encodeURIComponent(r.resourceId)}`}>{r.title}</a></li>)}</ul></Section>);
    }
    if (id === "citation_style" && s.citationStyle) blocks.push(<Section key={id} id={id}><p className="sp-row sp-row-start"><span className="sp-chip">{s.citationStyle.style}</span><SourceRef source={s.citationStyle.source} /></p></Section>);
    if (id === "safety" && s.safety?.length) blocks.push(<Section key={id} id={id}><ul className="sp-list">{s.safety.map((x, i) => <li key={i}><Icon name="alert" /> <span>{x.text}</span> <SourceRef source={x.source} /></li>)}</ul></Section>);
    if (id === "milestones" && s.milestones?.length) blocks.push(<Section key={id} id={id}><MilestonesView milestones={s.milestones} /></Section>);
    if (id === "contacts" && s.contacts?.length) blocks.push(<Section key={id} id={id}><ul className="sp-list">{s.contacts.map((c) => <li key={c.name}>{c.name} <span className="sp-hint">{c.role}</span></li>)}</ul></Section>);
    if (id === "material" && s.material) blocks.push(<Section key={id} id={id}><LongText text={s.material.text} /></Section>);
    if (id === "when_where") blocks.push(<Section key={id} id={id}><p>{[dateLine(data.item), data.item.where].filter(Boolean).join(" · ")}</p></Section>);
    if (id === "materials") blocks.push(<Materials key={id} data={data} ticked={ticked} setTicked={setTicked} chips={chips} setChips={setChips} selected={selected} />);
    if (id === "sessions" && data.sessions.length) blocks.push(<Section key={id} id={id}><ul className="sp-list">{data.sessions.map((x) => <li key={x.date + x.title}><span className="sp-hint">{x.date.slice(0, 10)}</span> {x.title}</li>)}</ul></Section>);
    if (id === "announcements" && data.announcements.length)
      blocks.push(<Section key={id} id={id}><ul className="sp-list">{data.announcements.map((x) => <li key={x.resourceId}><a href={`#resource/${encodeURIComponent(x.resourceId)}`}>{x.title}</a> <span className="sp-hint">{x.excerpt}</span></li>)}</ul></Section>);
  }
  // Every type that studies lists its materials (the sources the actions use), even when its row doesn't name them.
  if (!has("materials") && data.config.actions.length && data.sources.length) blocks.push(<Materials key="materials" data={data} ticked={ticked} setTicked={setTicked} chips={chips} setChips={setChips} selected={selected} />);
  for (const w of o.warnings) blocks.push(<p key={w} className="sp-hint"><Icon name="alert" /> {w}</p>);
  const askable = data.config.actions.length > 0 && !data.config.actions.some((a) => a.id === "ask");
  return (
    <div className="sp-need">
      {blocks.length ? blocks : <p className="sp-quiet">Nothing else is needed for this one.</p>}
      {askable ? <AskPanel scope={scope} disabled={askDisabled} compact /> : null}
    </div>
  );
}

function Materials({ data, ticked, setTicked, chips, setChips, selected }: { data: Ok; ticked: Set<string> | null; setTicked: (v: Set<string> | null) => void; chips: Set<string>; setChips: (v: Set<string>) => void; selected: string[] }) {
  const [search, setSearch] = useState("");
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
    { title: "Course materials", rows: visible.filter((s) => !EXAM_ROLES.has(s.role)) },
    { title: "Past and practice exams", rows: visible.filter((s) => EXAM_ROLES.has(s.role)) },
  ].filter((g) => g.rows.length);
  // A module or assignment chip that selects no material would only empty the list, so it isn't shown.
  const chipItems = data.scopeItems.filter((i) => (i.kind === "topic" || i.resourceIds.length > 0) && (!q || i.title.toLowerCase().includes(q)));
  const allTicked = !ticked;
  if (!data.sources.length)
    return (
      <Section id="materials">
        <p className="sp-quiet">No course materials are linked to this yet.</p>
      </Section>
    );
  return (
    <section className="sp-section sp-materials" aria-labelledby="sp-s-materials">
      <div className="sp-section-head">
        <h3 className="sp-group-title" id="sp-s-materials">
          <label className="sp-check-all" title={allTicked ? "Untick all" : "Tick all"}>
            <input type="checkbox" checked={allTicked} ref={(el) => { if (el) el.indeterminate = !!ticked && ticked.size > 0; }} onChange={() => setTicked(allTicked ? new Set() : null)} />
            <span>{SECTION_TITLE.materials}</span>
          </label>
          <span className="sp-count" title="Materials the study actions use">{selected.length}/{all.length}</span>
        </h3>
        {all.length > 6 ? (
          <label className="sp-search">
            <Icon name="search" />
            <input type="search" placeholder="Filter" aria-label="Filter materials" value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
        ) : null}
      </div>
      {chipItems.length > 1 ? (
        <div className="sp-chips" role="group" aria-label="Narrow by assignment, module or topic">
          {chipItems.map((i) => {
            const key = `${i.kind}:${i.id}`;
            const on = chips.has(key);
            return (
              <button key={key} className={`sp-chip is-${i.kind} ${on ? "is-on" : ""}`} aria-pressed={on} title={i.kind === "topic" ? `Focus on ${i.title}` : `Only materials for ${i.title} (${i.resourceIds.length})`} onClick={() => toggleChip(key)}>
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
      {groups.map((g) => (
        <div key={g.title} className="sp-source-group" role="group" aria-label={g.title}>
          {groups.length > 1 ? <h4 className="sp-subgroup-title">{g.title}</h4> : null}
          <ul className="sp-source-list">
            {g.rows.map((s) => (
              <li key={s.resourceId} className={`sp-source ${selected.includes(s.resourceId) ? "" : "is-off"}`}>
                <label>
                  <input type="checkbox" checked={isTicked(s.resourceId)} onChange={() => toggle(s.resourceId)} />
                  <span className="sp-role" title={ROLE_LABEL[s.role]}>
                    <Icon name={ROLE_ICON[s.role]} />
                  </span>
                  <span className="sp-source-title">{s.title}</span>
                  <span className="sp-source-reason">{s.reason}</span>
                </label>
                <a className="sp-icon-button" href={`#resource/${encodeURIComponent(s.resourceId)}`} aria-label={`Open ${s.title}`} title="Open">
                  <Icon name="next" />
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

interface Turn {
  question: string;
  answer: AskAnswer | null;
  error?: string;
}
function AskPanel({ scope, disabled, compact = false }: { scope: PrepScope; disabled: boolean; compact?: boolean }) {
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
    <section className={`sp-ask ${compact ? "is-compact" : ""}`} aria-label="Ask about the linked materials">
      {turns.length ? (
        <ol className="sp-turns">
          {turns.map((t, i) => (
            <li key={i} className="sp-turn">
              <p className="sp-q">{t.question}</p>
              {t.error ? (
                <p className="sp-error" role="alert">{t.error}</p>
              ) : !t.answer ? (
                <div className="sp-skeleton short" aria-busy="true" />
              ) : t.answer.unavailable ? (
                <p className="sp-notice">{t.answer.unavailable}</p>
              ) : (
                <div className="sp-a">
                  <MathText text={t.answer.notFound ? "Not in the ticked materials." : t.answer.text} />
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
        <input type="text" value={text} onChange={(e) => setText(e.target.value)} placeholder={disabled ? "Tick a material to ask about it" : "Ask about these materials"} aria-label="Ask a question about the ticked materials" disabled={disabled} maxLength={2000} />
        <button className="sp-icon-button" type="submit" aria-label="Ask" title="Ask (uses your AI)" disabled={disabled || busy || !text.trim()}>
          <Icon name="send" />
        </button>
      </form>
    </section>
  );
}
