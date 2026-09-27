// owner: study frontend. A flashcard review session over the canonical card ops (FSRS scheduling
// stays in the backend). Reviewing a card is study evidence, never coursework completion.
import { forwardRef, useRef, useState } from "react";
import { activeRequest } from "./api";
import { plural, RATINGS } from "./model";
import type { FlashcardSessionView } from "./types";

export const FlashcardReview = forwardRef<
  HTMLHeadingElement,
  {
    session: FlashcardSessionView;
    label: string;
    onSession(session: FlashcardSessionView): void;
    onClose(): void;
  }
>(function FlashcardReview({ session, label, onSession, onClose }, heading) {
  const [revealed, setRevealed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const shownAt = useRef(Date.now());
  const card = session.current;
  const lastReview = [...session.reviewed].reverse().find((r) => !r.undone);
  const current = session.availability === "current";

  async function send(request: Parameters<typeof activeRequest>[0]) {
    setPending(true);
    setError("");
    try {
      const next = await activeRequest(request);
      if (next.kind !== "flashcards") throw new Error("The flashcard session could not be read.");
      setRevealed(false);
      shownAt.current = Date.now();
      onSession(next.flashcards);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The card could not be saved. Try again.");
      try {
        const fresh = await activeRequest({ op: "study.session", sessionId: session.id });
        if (fresh.kind === "flashcards") onSession(fresh.flashcards);
      } catch {
        /* Keep the current card visible. */
      }
    } finally {
      setPending(false);
    }
  }
  const mutation = () => ({ sessionId: session.id, revision: session.revision, operationId: crypto.randomUUID() });

  return (
    <div className="study-activity">
      <div className="study-activity-head">
        <button className="study-back" type="button" onClick={onClose}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
          Study overview
        </button>
        <p className="study-meta">
          {label} · {session.status === "complete" ? "Session finished" : `${plural(session.remaining, "card")} left`}
        </p>
      </div>
      {!current ? <p className="study-note" role="status">{session.reason} Reviews are paused; your saved reviews are kept.</p> : null}
      {card ? (
        <>
          <div className="study-card">
            {card.topics.length ? (
              <p className="study-meta">{card.topics.map((t) => t.label).join(" · ")}</p>
            ) : null}
            <h4 className="study-question" tabIndex={-1} ref={heading}>{card.front}</h4>
            {revealed ? <p className="study-prose study-card-back">{card.back}</p> : null}
          </div>
          {revealed ? (
            <div className="study-buttons" role="group" aria-label="How well did you recall it?">
              {RATINGS.map(({ rating, label: text }) => (
                <button
                  key={rating}
                  type="button"
                  className={`study-button${rating === 3 ? " primary" : ""}`}
                  disabled={pending || !current}
                  onClick={() =>
                    void send({
                      op: "study.review",
                      cardId: card.cardId,
                      rating,
                      reviewMs: Math.min(86_400_000, Math.max(0, Date.now() - shownAt.current)),
                      ...mutation(),
                    })
                  }
                >
                  {text}
                </button>
              ))}
            </div>
          ) : (
            <div className="study-buttons">
              <button className="study-button primary" type="button" disabled={pending} onClick={() => setRevealed(true)}>
                Show answer
              </button>
            </div>
          )}
          {card.citations.length ? (
            <details className="study-disclosure">
              <summary>Source quote</summary>
              {card.citations.map((c, i) => (
                <blockquote key={i}>{c.quote}</blockquote>
              ))}
            </details>
          ) : null}
        </>
      ) : (
        <div className="study-finished">
          <h4 className="study-question" tabIndex={-1} ref={heading}>No cards left in this session</h4>
          <p className="study-meta">
            {plural(session.reviewed.filter((r) => !r.undone).length, "card")} reviewed. The next review dates are saved
            on this device.
          </p>
        </div>
      )}
      <div className="study-buttons">
        {lastReview ? (
          <button
            className="study-button quiet"
            type="button"
            disabled={pending || !current}
            onClick={() => void send({ op: "study.undoReview", reviewId: lastReview.reviewId, ...mutation() })}
          >
            Undo last rating
          </button>
        ) : null}
        {!card ? (
          <button className="study-button quiet" type="button" onClick={onClose}>
            Back to study overview
          </button>
        ) : null}
      </div>
      {error ? <p className="study-error" role="alert">{error}</p> : null}
    </div>
  );
});
