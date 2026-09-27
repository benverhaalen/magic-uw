// owner: study-prep. Every way into an item's space, so each entry point is one line where it sits:
// - `openItemSpace({courseId, itemId})` from anywhere (agenda rows, course lists, search results);
//   <ItemSpaceHost/>, mounted once, shows the space in a modal and returns focus on close;
// - <UpcomingAssessments/>: every included course's upcoming exams and quizzes (Study & Learn);
// - <ItemStudyBadges/>: a row's compact study state and a Study action;
// - `openWithPrep(...)`: opening a quiz or exam in Canvas first asks "Want to prep first?" (never
//   blocking Canvas), for open, unsubmitted quizzes and exams the student hasn't opted out of.
import { useEffect, useRef, useState } from "react";
import type { ItemActionId, StudyPrepItemState, StudyPrepResult, StudyPrepUpcoming } from "@magic/contracts";
import { ItemSpace, dateLine } from "./ItemSpace";
import { Icon, type IconName } from "./icons";
import { prepQuery } from "./api";

// ---------- Opening a space from anywhere ----------
export interface OpenItem {
  courseId: string;
  itemId: string;
  action?: ItemActionId;
}
const OPEN_EVENT = "magic:item-space";
export function openItemSpace(detail: OpenItem): void {
  window.dispatchEvent(new CustomEvent<OpenItem>(OPEN_EVENT, { detail }));
}

/** Mounted once in the app shell: the item space as a modal dialog; Esc and the close button return focus. */
export function ItemSpaceHost() {
  const [open, setOpen] = useState<OpenItem | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const on = (e: Event) => setOpen((e as CustomEvent<OpenItem>).detail);
    window.addEventListener(OPEN_EVENT, on);
    return () => window.removeEventListener(OPEN_EVENT, on);
  }, []);
  useEffect(() => {
    const d = dialog.current;
    if (open && d && !d.open) d.showModal?.();
  }, [open]);
  if (!open) return null;
  const close = () => dialog.current?.close();
  return (
    <dialog ref={dialog} className="sp-dialog" aria-label="Item" onClose={() => setOpen(null)} onCancel={(e) => { e.preventDefault(); close(); }}>
      <button className="sp-icon-button sp-dialog-close" aria-label="Close" title="Close (Esc)" onClick={close}>
        <Icon name="x" />
      </button>
      <ItemSpace key={`${open.courseId}:${open.itemId}:${open.action ?? ""}`} courseId={open.courseId} itemId={open.itemId} {...(open.action ? { initialAction: open.action } : {})} onClose={close} />
    </dialog>
  );
}

// ---------- A small per-course cache, so rows share one query ----------
type ListResult = Extract<StudyPrepResult, { status: "list" }>;
const lists = new Map<string, { at: number; value: Promise<ListResult | null> }>();
const TTL_MS = 30_000;
function courseList(courseId: string | null): Promise<ListResult | null> {
  const key = courseId ?? "*";
  const hit = lists.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = prepQuery(courseId ? { courseId } : {}).then((r) => (r.status === "list" ? r : null)).catch(() => null);
  lists.set(key, { at: Date.now(), value });
  return value;
}
export const refreshStudyLists = () => lists.clear();
function useList(courseId: string | null) {
  const [value, setValue] = useState<ListResult | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void courseList(courseId).then((v) => live && setValue(v));
    return () => {
      live = false;
    };
  }, [courseId]);
  return value;
}

// ---------- Badges: what is prepared for an item ----------
const BADGES: { kind: "guide" | "cards" | "quiz" | "exam" | "problems"; icon: IconName; label: string }[] = [
  { kind: "guide", icon: "guide", label: "Study guide" },
  { kind: "cards", icon: "cards", label: "Cards" },
  { kind: "quiz", icon: "quiz", label: "Practice quiz" },
  { kind: "exam", icon: "exam", label: "Practice exam" },
  { kind: "problems", icon: "homework", label: "Practice problems" },
];
export function StateBadges({ state }: { state: StudyPrepItemState }) {
  const shown = BADGES.filter((b) => state.materials[b.kind].status !== "missing");
  return (
    <span className="sp-badges">
      {shown.map((b) => {
        const m = state.materials[b.kind];
        return (
          <span key={b.kind} className={`sp-badge-icon is-${m.status}`} title={`${b.label}: ${m.status === "ready" ? `${m.count} ready` : m.status === "stale" ? "materials changed" : m.status === "generating" ? "being made" : "couldn't be made"}`}>
            <Icon name={b.icon} />
            {m.count ? <span>{m.count}</span> : null}
          </span>
        );
      })}
      {state.due ? (
        <span className="sp-badge-icon is-due" title={`${state.due} of ${state.cards} cards due today`}>
          <Icon name="flip" />
          <span>{state.due}</span>
        </span>
      ) : null}
    </span>
  );
}

/** A course row's study state (icons) and one Study action; nothing when the row isn't in the list. */
export function ItemStudyBadges({ courseId, itemId }: { courseId: string; itemId: string }) {
  const list = useList(courseId);
  const state = list?.assignments[itemId] ?? list?.upcoming.find((u) => u.id === itemId || u.resourceId === itemId)?.state;
  if (!state) return null;
  return (
    <span className="sp-row-study">
      <StateBadges state={state} />
      <button className="sp-icon-button" onClick={(e) => { e.stopPropagation(); openItemSpace({ courseId, itemId }); }} aria-label="Study" title="Study: guide, cards and practice for this">
        <Icon name="guide" />
      </button>
    </span>
  );
}

// ---------- Upcoming exams and quizzes ----------
function UpcomingRow({ u }: { u: StudyPrepUpcoming }) {
  return (
    <li>
      <button className="sp-upcoming-row" onClick={() => openItemSpace({ courseId: u.courseId, itemId: u.id })} title={`Prep for ${u.title}`}>
        <span className="sp-upcoming-when">
          <strong>{u.daysAway === null ? "No date" : u.daysAway === 0 ? "Today" : u.daysAway === 1 ? "Tomorrow" : `${u.daysAway} days`}</strong>
          <span>{u.date ? dateLine({ ...u, daysAway: null }) : ""}</span>
        </span>
        <span className="sp-upcoming-main">
          <span className="sp-upcoming-course">{u.courseName}</span>
          <span className="sp-upcoming-title">{u.title}</span>
        </span>
        <span className="sp-upcoming-side">
          {u.mastery ? <span className="sp-chip sp-mastery" title="From your practice answers, not a grade prediction.">{u.mastery.label}</span> : null}
          <StateBadges state={u.state} />
          <span className="sp-prep-cta">Prep <Icon name="next" /></span>
        </span>
      </button>
    </li>
  );
}

/** Every included course's upcoming exams and quizzes, soonest first (or one course's, with `courseId`). */
export function UpcomingAssessments({ courseId = null, title = "Upcoming exams and quizzes", limit = 8 }: { courseId?: string | null; title?: string; limit?: number }) {
  const list = useList(courseId);
  if (list === undefined)
    return (
      <section className="sp-upcoming" aria-label={title} aria-busy="true">
        <div className="sp-skeleton short" />
        <div className="sp-skeleton" />
      </section>
    );
  if (!list?.upcoming.length) return null;
  return (
    <section className="sp-upcoming" aria-labelledby="sp-upcoming-title">
      <h3 className="sp-group-title" id="sp-upcoming-title">{title}</h3>
      <ul>{list.upcoming.slice(0, limit).map((u) => <UpcomingRow key={`${u.courseId}:${u.id}`} u={u} />)}</ul>
    </section>
  );
}

/** The course page's entry: its upcoming exams and quizzes, each opening its space. */
export function CourseStudyPrep({ courseId }: { courseId: string }) {
  return <UpcomingAssessments courseId={courseId} title="Study prep" limit={6} />;
}

// ---------- Before Canvas: "Want to prep first?" ----------
export interface PrepFirstTarget {
  courseId: string;
  resourceId: string;
  title: string;
  url: string;
  kind: string;
  submissionTypes?: string[];
  submitted?: boolean | null;
  submission?: { submittedAt?: string } | null;
  lockAt?: string;
}
const SKIP_KEY = "magic:prep-first-skip";
const skipped = (): Set<string> => {
  try {
    return new Set(JSON.parse(globalThis.localStorage?.getItem(SKIP_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
};
/** Whether opening this in Canvas should ask first: an open, unsubmitted quiz or exam the student hasn't opted out of. */
export function shouldAskPrepFirst(t: PrepFirstTarget, now = Date.now()): boolean {
  if (t.kind !== "assignment") return false;
  const quizLike = (t.submissionTypes ?? []).includes("online_quiz") || /\b(?:quiz|midterm|final|exam|test)\b/i.test(t.title);
  if (!quizLike) return false;
  if (t.submitted === true || t.submission?.submittedAt) return false;
  if (t.lockAt && Date.parse(t.lockAt) <= now) return false;
  return !skipped().has(t.resourceId);
}

const PROMPT_EVENT = "magic:prep-first";
/** Open a quiz or exam in Canvas, asking first when it applies; everything else opens at once. */
export function openWithPrep(t: PrepFirstTarget, openCanvas: () => void): void {
  if (!shouldAskPrepFirst(t)) return openCanvas();
  window.dispatchEvent(new CustomEvent(PROMPT_EVENT, { detail: { t, openCanvas } }));
}

/** Mounted once beside the host: the small prompt. Canvas is always one click (or Enter) away. */
export function PrepFirstPrompt() {
  const [ask, setAsk] = useState<{ t: PrepFirstTarget; openCanvas: () => void } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const canvasButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const on = (e: Event) => setAsk((e as CustomEvent<{ t: PrepFirstTarget; openCanvas: () => void }>).detail);
    window.addEventListener(PROMPT_EVENT, on);
    return () => window.removeEventListener(PROMPT_EVENT, on);
  }, []);
  useEffect(() => {
    const d = dialog.current;
    if (ask && d && !d.open) {
      d.showModal?.();
      canvasButton.current?.focus();
    }
  }, [ask]);
  if (!ask) return null;
  const { t, openCanvas } = ask;
  const close = () => dialog.current?.close();
  const prep = (action: ItemActionId) => {
    close();
    openItemSpace({ courseId: t.courseId, itemId: t.resourceId, action });
  };
  return (
    <dialog ref={dialog} className="sp-prompt" aria-labelledby="sp-prompt-title" onClose={() => setAsk(null)}>
      <p id="sp-prompt-title" className="sp-prompt-title">
        {t.title} opens in Canvas. Want to prep first?
      </p>
      <div className="sp-prompt-actions">
        <button className="sp-button" onClick={() => prep("review")} title="Cards due for its topics">
          <Icon name="flip" /> Quick review
        </button>
        <button className="sp-button" onClick={() => prep("quiz")} title="A practice quiz on its topics">
          <Icon name="quiz" /> Practice quiz
        </button>
        <button className="sp-button" onClick={() => prep("guide")} title="A study guide for it">
          <Icon name="guide" /> Study guide
        </button>
      </div>
      <div className="sp-prompt-foot">
        <button
          className="sp-link-button"
          onClick={() => {
            try {
              globalThis.localStorage?.setItem(SKIP_KEY, JSON.stringify([...skipped(), t.resourceId]));
            } catch {
              /* asked again next time */
            }
            close();
            openCanvas();
          }}
        >
          Don't ask for this one
        </button>
        <button ref={canvasButton} className="sp-button sp-primary" onClick={() => { close(); openCanvas(); }}>
          Open in Canvas <Icon name="next" />
        </button>
      </div>
    </dialog>
  );
}
