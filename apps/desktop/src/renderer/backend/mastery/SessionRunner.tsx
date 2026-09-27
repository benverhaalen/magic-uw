// Runs the practice a next step or a claim check starts, in place, then returns to mastery with the
// states recomputed. Answers go through the same session ops as every practice surface; the grading,
// the evidence and the state changes are the router's. Nothing here scores anything.
import { useEffect, useRef, useState } from "react";
import type { StudySessionView } from "@magic/contracts";
import type {
  FlashcardData,
  FlashcardSessionView,
  PracticeResultsData,
  PracticeRoundData,
} from "../../../../../../packages/learning/src/router-types";
import { must, operationId, type MasteryApi } from "./api";

export type SessionStart = { kind: "round"; data: PracticeRoundData; title: string } | { kind: "cards"; data: FlashcardData; title: string };

const DIRECTION: Record<string, string> = { up: "moved up", down: "moved down", same: "no change", new: "first evidence" };
const RATINGS = [
  { rating: 1 as const, label: "Again" },
  { rating: 2 as const, label: "Hard" },
  { rating: 3 as const, label: "Good" },
  { rating: 4 as const, label: "Easy" },
];

export function SessionRunner({ api, start, onDone }: { api: MasteryApi; start: SessionStart; onDone: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <section className="mastery-runner" aria-labelledby="mastery-runner-title">
      <div className="mastery-runner-head">
        <h2 id="mastery-runner-title" tabIndex={-1} ref={heading}>
          {start.title}
        </h2>
        <button type="button" className="mastery-link" onClick={onDone}>
          Back to mastery
        </button>
      </div>
      {start.kind === "round" ? <Round api={api} initial={start.data} onDone={onDone} /> : <Cards api={api} initial={start.data.flashcards} onDone={onDone} />}
    </section>
  );
}

function Round({ api, initial, onDone }: { api: MasteryApi; initial: PracticeRoundData; onDone: () => void }) {
  const [round, setRound] = useState(initial);
  const [choice, setChoice] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<PracticeResultsData["results"] | null>(null);
  const shownAt = useRef(Date.now());
  const s: StudySessionView = round.session;
  const item = s.currentItem;
  const last = s.answered ? s.events.filter((e) => e.kind === "answer").at(-1) : undefined;
  const chips = item ? (round.practice.topicsByItem[`${item.id}@${item.version}`] ?? []) : [];
  const answeredCount = s.events.filter((e) => e.kind === "answer").length;

  async function step(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work. Your saved work is unchanged.");
    } finally {
      setBusy(false);
    }
  }
  const answer = () =>
    step(async () => {
      if (!item) return;
      const response =
        item.kind === "mc" || item.kind === "tf"
          ? { kind: "choice" as const, optionId: choice }
          : item.kind === "numeric"
            ? { kind: "number" as const, value: Number(text) }
            : { kind: "text" as const, text };
      setRound(await must<PracticeRoundData>(api, { op: "study.answer", sessionId: s.id, revision: s.revision, operationId: operationId(), itemId: item.id, itemVersion: item.version, response, confidence: null, responseMs: Math.min(86_400_000, Date.now() - shownAt.current) }));
    });
  const next = () =>
    step(async () => {
      const r = await must<PracticeRoundData>(api, { op: "study.advance", sessionId: s.id, revision: s.revision, operationId: operationId(), action: "next" });
      setRound(r);
      setChoice("");
      setText("");
      shownAt.current = Date.now();
      if (r.session.status === "complete") setResults((await must<PracticeResultsData>(api, { op: "study.submit", sessionId: s.id })).results);
    });

  if (results)
    return (
      <div className="mastery-results" role="status">
        <p className="mastery-lead">
          {results.correct} of {results.answered} right{results.unscored ? `, ${results.unscored} not scored yet` : ""}.
        </p>
        <ul className="mastery-plain-list">
          {results.topics.map((t) => (
            <li key={t.conceptId}>
              <strong>{t.label}</strong>: {t.afterLabel} ({DIRECTION[t.direction]})
            </li>
          ))}
        </ul>
        <button type="button" className="mastery-action" onClick={onDone}>
          Done
        </button>
      </div>
    );
  if (!item || s.availability !== "current")
    return (
      <div className="mastery-results">
        <p>{s.availability !== "current" ? s.reason : "This session has no question to show."}</p>
        <button type="button" className="mastery-action" onClick={onDone}>
          Back to mastery
        </button>
      </div>
    );
  const canSubmit = !busy && (item.kind === "mc" || item.kind === "tf" ? !!choice : text.trim().length > 0);
  return (
    <form
      className="mastery-question"
      onSubmit={(e) => {
        e.preventDefault();
        if (s.answered) void next();
        else if (canSubmit) void answer();
      }}
    >
      <p className="mastery-meta">
        Question {answeredCount + (s.answered ? 0 : 1)} · {chips.map((c) => c.label).join(", ") || "Topic not tagged"}
      </p>
      <fieldset disabled={s.answered || busy}>
        <legend className="mastery-stem">{item.stem}</legend>
        {item.kind === "mc" || item.kind === "tf" ? (
          <div className="mastery-options">
            {(item.options ?? []).map((o) => (
              <label key={o.id} className={`mastery-option ${choice === o.id ? "is-chosen" : ""}`}>
                <input type="radio" name="mastery-option" value={o.id} checked={choice === o.id} onChange={() => setChoice(o.id)} />
                {o.text}
              </label>
            ))}
          </div>
        ) : (
          <label className="mastery-field">
            Your answer
            <input type={item.kind === "numeric" ? "number" : "text"} value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" />
          </label>
        )}
      </fieldset>
      {last ? (
        <p className={`mastery-feedback mastery-feedback--${last.outcome ?? "undecided"}`} role="status">
          {last.text}
        </p>
      ) : null}
      {error ? (
        <p className="mastery-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="mastery-row-actions">
        <button type="submit" className="mastery-action" disabled={s.answered ? busy : !canSubmit}>
          {s.answered ? (busy ? "Loading…" : "Next") : busy ? "Checking…" : "Check answer"}
        </button>
      </div>
      {item.citations[0] ? <p className="mastery-source">From your course material: “{item.citations[0].quote}”</p> : null}
    </form>
  );
}

function Cards({ api, initial, onDone }: { api: MasteryApi; initial: FlashcardSessionView; onDone: () => void }) {
  const [view, setView] = useState(initial);
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const shownAt = useRef(Date.now());
  const card = view.current;
  async function rate(rating: 1 | 2 | 3 | 4) {
    if (!card) return;
    setBusy(true);
    setError("");
    try {
      const r = await must<FlashcardData>(api, { op: "study.review", cardId: card.cardId, rating, reviewMs: Math.min(86_400_000, Date.now() - shownAt.current), sessionId: view.id, revision: view.revision, operationId: operationId() });
      setView(r.flashcards);
      setShown(false);
      shownAt.current = Date.now();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work. Your saved work is unchanged.");
    } finally {
      setBusy(false);
    }
  }
  if (!card || view.status === "complete")
    return (
      <div className="mastery-results" role="status">
        <p className="mastery-lead">Reviewed {view.reviewed.filter((r) => !r.undone).length} {view.reviewed.length === 1 ? "card" : "cards"}.</p>
        <button type="button" className="mastery-action" onClick={onDone}>
          Done
        </button>
      </div>
    );
  return (
    <div className="mastery-question">
      <p className="mastery-meta">
        {view.remaining} left · {card.topics.map((t) => t.label).join(", ")}
      </p>
      <p className="mastery-stem">{card.front}</p>
      {shown ? (
        <>
          <p className="mastery-back">{card.back}</p>
          <div className="mastery-row-actions" role="group" aria-label="How well did you recall it?">
            {RATINGS.map((r) => (
              <button key={r.rating} type="button" className="mastery-secondary" disabled={busy} onClick={() => void rate(r.rating)}>
                {r.label}
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="mastery-row-actions">
          <button type="button" className="mastery-action" onClick={() => setShown(true)} autoFocus>
            Show answer
          </button>
        </div>
      )}
      {error ? (
        <p className="mastery-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
