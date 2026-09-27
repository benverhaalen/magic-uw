// owner: study-prep. Study & Learn: every assignment, quiz and exam across the student's current
// courses, soonest first, grouped Today / This week / Later with Past folded. Each row: course,
// type, due date and countdown, readiness, cards due and what is prepared. A row opens the item's
// space. Filter by course and type, or search. Keys: ↑ ↓ move, Enter opens, G / C / T open the
// study guide, cards or test. The Home card shows the next three exams and quizzes.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ITEM_SPACE, type ItemActionId, type StudyPrepResult, type StudyPrepUpcoming } from "@magic/contracts";
import { Disclosure } from "../../../../../packages/ui/src/components";
import { Icon } from "./icons";
import { openItemSpace, StateBadges } from "./entries";
import { prepQuery } from "./api";

type List = Extract<StudyPrepResult, { status: "list" }>;
type Group = "past" | "today" | "week" | "later";
const GROUP_TITLE: Record<Group, string> = { today: "Today", week: "This week", later: "Later", past: "Past" };
const groupOf = (d: number | null): Group => (d === null ? "later" : d < 0 ? "past" : d === 0 ? "today" : d <= 7 ? "week" : "later");
const countdown = (d: number | null) => (d === null ? "No date" : d === 0 ? "Today" : d === 1 ? "Tomorrow" : d > 0 ? `${d} days` : `${-d}d ago`);
const dueText = (date: string | null) => {
  if (!date) return "";
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T12:00:00` : date);
  return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", ...(/T\d\d:\d\d/.test(date) ? { hour: "numeric", minute: "2-digit" } : {}) }).format(d);
};

/** The study action a letter opens for an item of this type (T is its test: a practice exam or quiz). */
export function actionFor(item: StudyPrepUpcoming, key: string): ItemActionId | null {
  const actions = ITEM_SPACE[item.type].actions;
  const byKey = actions.find((a) => a.key === key);
  if (byKey) return byKey.id;
  if (key === "g") return actions.find((a) => a.id === "guide")?.id ?? null;
  if (key === "c") return actions.find((a) => a.id === "cards" || a.id === "review")?.id ?? null;
  if (key === "t") return actions.find((a) => a.id === "exam" || a.id === "quiz" || a.id === "problems")?.id ?? null;
  return null;
}

function useStudyList(initial?: List) {
  const [list, setList] = useState<List | null | undefined>(initial);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (initial) return;
    let live = true;
    prepQuery({})
      .then((r) => live && (r.status === "list" ? setList(r) : setError("message" in r ? r.message : "Study & Learn isn't available.")))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { list, error };
}

function Row({ item, onKey }: { item: StudyPrepUpcoming; onKey: (e: KeyboardEvent<HTMLButtonElement>, item: StudyPrepUpcoming) => void }) {
  return (
    <li>
      <button className={`sp-work-row ${item.status.submitted ? "is-done" : ""}`} data-study-row onClick={() => openItemSpace({ courseId: item.courseId, itemId: item.id })} onKeyDown={(e) => onKey(e, item)} title={`${item.title}: open its study space (Enter; G guide, C cards, T test)`}>
        <span className="sp-work-when">
          <strong>{countdown(item.daysAway)}</strong>
          <span>{dueText(item.date)}</span>
        </span>
        <span className="sp-work-main">
          <span className="sp-work-meta">
            <span className="sp-course-chip">{item.courseName}</span>
            <span className="sp-type-chip">{ITEM_SPACE[item.type].label}</span>
            {item.status.submitted ? <span className="sp-type-chip">Submitted</span> : item.status.missing ? <span className="sp-type-chip is-missing">Missing</span> : null}
          </span>
          <span className="sp-work-title">{item.title}</span>
        </span>
        <span className="sp-work-side">
          {item.mastery ? <span className="sp-chip sp-mastery" title="From your practice answers, not a grade prediction.">{item.mastery.label}</span> : null}
          <StateBadges state={item.state} />
          <Icon name="next" />
        </span>
      </button>
    </li>
  );
}

export function StudyLearnPage({ initial }: { initial?: List }) {
  const { list, error } = useStudyList(initial);
  const [course, setCourse] = useState("");
  const [type, setType] = useState("");
  const [search, setSearch] = useState("");
  const root = useRef<HTMLElement>(null);
  const items = list?.items ?? [];
  const courses = useMemo(() => [...new Map(items.map((i) => [i.courseId, i.courseName])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [items]);
  const types = useMemo(() => [...new Set(items.map((i) => i.type))].sort(), [items]);
  const q = search.trim().toLowerCase();
  const shown = items.filter((i) => (!course || i.courseId === course) && (!type || i.type === type) && (!q || `${i.title} ${i.courseName} ${ITEM_SPACE[i.type].label}`.toLowerCase().includes(q)));
  const groups = (["today", "week", "later", "past"] as Group[]).map((g) => ({ g, rows: shown.filter((i) => groupOf(i.daysAway) === g) })).filter((x) => x.rows.length);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, item: StudyPrepUpcoming) => {
    const rows = Array.from(root.current?.querySelectorAll<HTMLButtonElement>("[data-study-row]") ?? []);
    const i = rows.indexOf(e.currentTarget);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
      return;
    }
    const key = e.key.toLowerCase();
    if (!e.metaKey && !e.ctrlKey && !e.altKey && (key === "g" || key === "c" || key === "t")) {
      const action = actionFor(item, key);
      if (action) {
        e.preventDefault();
        openItemSpace({ courseId: item.courseId, itemId: item.id, action });
      }
    }
  };
  return (
    <section className="sp-study-learn" aria-labelledby="sp-sl-title" ref={root}>
      <div className="sp-sl-head">
        <h1 id="sp-sl-title" tabIndex={-1}>Study &amp; Learn</h1>
        <div className="sp-sl-filters" role="search">
          <label className="sp-search">
            <Icon name="search" />
            <input type="search" placeholder="Search" aria-label="Search coursework" value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <select aria-label="Course" value={course} onChange={(e) => setCourse(e.target.value)}>
            <option value="">All courses</option>
            {courses.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          <select aria-label="Type" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All types</option>
            {types.map((t) => <option key={t} value={t}>{ITEM_SPACE[t].label}</option>)}
          </select>
        </div>
      </div>
      {list === undefined && !error ? (
        <div aria-busy="true" className="sp-sl-skeleton">
          <div className="sp-skeleton" />
          <div className="sp-skeleton" />
          <div className="sp-skeleton short" />
        </div>
      ) : error ? (
        <p className="sp-error" role="alert"><Icon name="alert" /> {error}</p>
      ) : !items.length ? (
        <p className="sp-quiet">No coursework with dates in your current courses yet.</p>
      ) : !shown.length ? (
        <p className="sp-quiet">Nothing matches. <button className="sp-link-button" onClick={() => { setCourse(""); setType(""); setSearch(""); }}>Clear filters</button></p>
      ) : (
        groups.map(({ g, rows }) =>
          g === "past" ? (
            <Disclosure key={g} label={`${GROUP_TITLE[g]} (${rows.length})`}>
              <ul className="sp-work-list">{rows.slice().reverse().map((i) => <Row key={`${i.courseId}:${i.id}`} item={i} onKey={onKey} />)}</ul>
            </Disclosure>
          ) : (
            <section key={g} className="sp-sl-group" aria-labelledby={`sp-sl-${g}`}>
              <h2 id={`sp-sl-${g}`} className="sp-group-title">{GROUP_TITLE[g]} <span className="sp-count">{rows.length}</span></h2>
              <ul className="sp-work-list">{rows.map((i) => <Row key={`${i.courseId}:${i.id}`} item={i} onKey={onKey} />)}</ul>
            </section>
          ),
        )
      )}
    </section>
  );
}

/** Home's compact Study card: the next three exams and quizzes with readiness and Prep, and See all. */
export function HomeStudyCard({ onSeeAll, initial }: { onSeeAll: () => void; initial?: List }) {
  const { list } = useStudyList(initial);
  const next = (list?.upcoming ?? []).slice(0, 3);
  if (list === undefined) return <div className="sp-home-card" aria-busy="true"><div className="sp-skeleton short" /><div className="sp-skeleton" /></div>;
  return (
    <section className="sp-home-card" aria-labelledby="sp-home-title">
      <div className="sp-home-head">
        <h2 id="sp-home-title">Study</h2>
        <button className="sp-link-button" onClick={onSeeAll}>See all <Icon name="next" /></button>
      </div>
      {next.length ? (
        <ul>
          {next.map((u) => (
            <li key={`${u.courseId}:${u.id}`}>
              <span className="sp-home-main">
                <span className="sp-course-chip">{u.courseName}</span>
                <strong>{u.title}</strong>
                <span className="sp-hint">{countdown(u.daysAway)}{u.mastery ? ` · ${u.mastery.label}` : ""}</span>
              </span>
              <button className="sp-button" onClick={() => openItemSpace({ courseId: u.courseId, itemId: u.id })}>Prep</button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="sp-quiet">No exams or quizzes coming up.</p>
      )}
    </section>
  );
}
