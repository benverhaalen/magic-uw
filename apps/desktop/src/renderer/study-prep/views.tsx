// owner: study-prep. The Studio's three views: the study guide (collapsible sections with their
// sources), the practice quiz (one question at a time, graded by code, then the explanation) and
// the flashcards (a flip deck, and a review that records ratings in the existing FSRS schedule).
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { StudyPrepCard, StudyPrepGuide, StudyPrepQuizItem, StudyPrepQuote } from "@magic/contracts";
import { Disclosure, EvidenceLink } from "../../../../../packages/ui/src/components";
import { MathText } from "./MathText";
import { Icon } from "./icons";
import { checkAnswer, type QuizCheck } from "./quiz-check";
import { learning, operationId } from "./api";

/** A source quote: the quote on hover, and the source opened in the app at that resource on click. */
export function SourceRef({ source }: { source: StudyPrepQuote }) {
  if (!source.resourceId) return null;
  return (
    <span className="sp-source-ref" title={`“${source.quote}” (${source.title})`}>
      <EvidenceLink source={{ resourceId: source.resourceId, version: null, href: `#resource/${encodeURIComponent(source.resourceId)}`, sourceLabel: source.title, capturedAt: null }}>
        <Icon name="file" />
        <span className="sp-source-ref-label">{source.title}</span>
      </EvidenceLink>
    </span>
  );
}

export function GuideView({ guide }: { guide: StudyPrepGuide }) {
  if (!guide.sections.length) return <p className="sp-quiet">Nothing in this guide passed the checks. Try again, or tick more sources.</p>;
  return (
    <article className="sp-guide" aria-label={guide.title}>
      <h3 className="sp-view-title">{guide.title}</h3>
      {guide.sections.map((s, i) => (
        <Disclosure key={s.id} label={s.title} defaultOpen={i < 3}>
          <ul className="sp-blocks">
            {s.blocks.map((b) => (
              <li key={b.id} className={`sp-block sp-block-${b.kind}`}>
                {b.heading ? (
                  <strong className="sp-block-head">
                    <MathText text={b.heading} />
                  </strong>
                ) : null}
                <MathText text={b.text} className="sp-block-text" />
                {b.kind === "example" && b.computed ? (
                  <span className="sp-computed" title="Recomputed by the app">
                    <Icon name="check" /> {b.expression} = {b.computed}
                  </span>
                ) : null}
                <SourceRef source={b.source} />
              </li>
            ))}
          </ul>
        </Disclosure>
      ))}
    </article>
  );
}

type Answer = { choice?: string; text?: string; check?: QuizCheck };
export function QuizView({ items }: { items: StudyPrepQuizItem[] }) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setIndex(0);
    setAnswers({});
  }, [items]);
  if (!items.length) return <p className="sp-quiet">No questions passed the checks. Try again, or tick more sources.</p>;
  const done = index >= items.length;
  const right = items.filter((q) => answers[q.itemId]?.check?.status === "right").length;
  if (done)
    return (
      <div className="sp-quiz-done" role="status">
        <p>
          {right} of {items.length} right.
        </p>
        <button className="sp-button" onClick={() => { setAnswers({}); setIndex(0); }}>
          <Icon name="refresh" /> Start over
        </button>
      </div>
    );
  const q = items[index]!;
  const a = answers[q.itemId] ?? {};
  const set = (patch: Answer) => setAnswers((all) => ({ ...all, [q.itemId]: { ...all[q.itemId], ...patch } }));
  const check = () => {
    const response = q.kind === "numeric" ? { kind: "number" as const, text: a.text ?? "" } : { kind: "choice" as const, optionId: a.choice ?? "" };
    set({ check: checkAnswer(q, response) });
  };
  const checked = a.check && a.check.status !== "invalid";
  const onKey = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement && e.target.type === "text" && e.key !== "Enter") return;
    const n = Number(e.key);
    if (!checked && q.options && n >= 1 && n <= q.options.length) set({ choice: q.options[n - 1]!.id, check: undefined });
    else if (e.key === "Enter") {
      e.preventDefault();
      if (checked) setIndex(index + 1);
      else check();
    }
  };
  return (
    <div className="sp-quiz" ref={root} tabIndex={-1} onKeyDown={onKey} aria-label="Practice quiz">
      <div className="sp-quiz-head">
        <span className="sp-count">
          {index + 1} / {items.length}
        </span>
        <span className="sp-topics">{q.topics.slice(0, 3).map((t) => <span key={t} className="sp-tag">{t}</span>)}</span>
      </div>
      <p className="sp-stem" id={`stem-${q.itemId}`}>
        <MathText text={q.stem} />
      </p>
      {q.kind === "numeric" ? (
        <label className="sp-numeric">
          <input
            type="text"
            inputMode="decimal"
            aria-labelledby={`stem-${q.itemId}`}
            value={a.text ?? ""}
            disabled={!!checked}
            onChange={(e) => set({ text: e.target.value, check: undefined })}
            placeholder="Your answer"
          />
          {q.unit ? <span className="sp-unit">{q.unit}</span> : null}
        </label>
      ) : (
        <div className="sp-options" role="radiogroup" aria-labelledby={`stem-${q.itemId}`}>
          {(q.options ?? []).map((o, i) => {
            const state = checked ? (o.id === String(q.key) ? "key" : o.id === a.choice ? "wrong" : "") : "";
            return (
              <label key={o.id} className={`sp-option ${a.choice === o.id ? "is-chosen" : ""} ${state ? `is-${state}` : ""}`}>
                <input type="radio" name={`q-${q.itemId}`} checked={a.choice === o.id} disabled={!!checked} onChange={() => set({ choice: o.id, check: undefined })} />
                <span className="sp-option-key" aria-hidden="true">{i + 1}</span>
                <MathText text={o.text} />
              </label>
            );
          })}
        </div>
      )}
      {a.check?.status === "invalid" ? <p className="sp-error" role="alert">{a.check.reason}</p> : null}
      {checked ? (
        <div className={`sp-feedback is-${a.check!.status}`} role="status">
          <strong>{a.check!.status === "right" ? "Right." : "Not quite."}</strong>{" "}
          {a.check!.status === "wrong" && "expected" in a.check! ? (
            <span>
              Answer: <MathText text={a.check!.expected} />
            </span>
          ) : null}
          {q.explanation ? <MathText text={q.explanation} className="sp-explanation" /> : null}
          <SourceRef source={q.source} />
        </div>
      ) : null}
      <div className="sp-row">
        <button className="sp-icon-button" aria-label="Previous question" title="Previous question" disabled={index === 0} onClick={() => setIndex(index - 1)}>
          <Icon name="prev" />
        </button>
        {checked ? (
          <button className="sp-button sp-primary" onClick={() => setIndex(index + 1)}>
            {index + 1 === items.length ? "Finish" : "Next"} <Icon name="next" />
          </button>
        ) : (
          <button className="sp-button sp-primary" onClick={check} disabled={q.kind === "numeric" ? !a.text?.trim() : !a.choice}>
            <Icon name="check" /> Check
          </button>
        )}
      </div>
    </div>
  );
}

interface ReviewCard {
  cardId: string;
  front: string;
  back: string;
}
interface ReviewSession {
  id: string;
  revision: number;
  status: "active" | "complete";
  current?: ReviewCard;
  remaining: number;
  reason: string;
}
const RATINGS = [
  { rating: 1, label: "Again" },
  { rating: 2, label: "Hard" },
  { rating: 3, label: "Good" },
  { rating: 4, label: "Easy" },
] as const;

export function CardsView({ cards, courseId, assessmentId, anchorIds }: { cards: StudyPrepCard[]; courseId: string; assessmentId: string; anchorIds: string[] }) {
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [review, setReview] = useState<ReviewSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shownAt = useRef(Date.now());
  useEffect(() => {
    setIndex(0);
    setFlipped(false);
  }, [cards]);
  useEffect(() => {
    shownAt.current = Date.now();
  }, [review?.current?.cardId, index]);
  if (!cards.length) return <p className="sp-quiet">No cards passed the checks. Try again, or tick more sources.</p>;

  const sessionOf = (data: unknown): ReviewSession | null => {
    const f = (data as { flashcards?: ReviewSession } | undefined)?.flashcards;
    return f && typeof f.id === "string" ? f : null;
  };
  const startReview = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await learning({ op: "practice.target", courseId, assessmentId, anchorIds: anchorIds.slice(0, 50), mode: "flashcards", count: Math.min(60, Math.max(1, cards.length)), operationId: operationId() });
      const s = r.status === "ok" ? sessionOf(r.data) : null;
      if (!s) setError(r.message ?? "Review couldn't start.");
      else {
        setReview(s);
        setFlipped(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const rate = async (rating: 1 | 2 | 3 | 4) => {
    if (!review?.current || busy) return;
    setBusy(true);
    try {
      const r = await learning({ op: "study.review", cardId: review.current.cardId, rating, reviewMs: Math.min(86_400_000, Date.now() - shownAt.current), sessionId: review.id, revision: review.revision, operationId: operationId() });
      const s = r.status === "ok" ? sessionOf(r.data) : null;
      if (!s) setError(r.message ?? "That rating wasn't saved.");
      else {
        setReview(s);
        setFlipped(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const face = review ? review.current : cards[index];
  const onKey = (e: KeyboardEvent) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      setFlipped((f) => !f);
    } else if (!review && e.key === "ArrowRight") {
      setIndex((i) => Math.min(cards.length - 1, i + 1));
      setFlipped(false);
    } else if (!review && e.key === "ArrowLeft") {
      setIndex((i) => Math.max(0, i - 1));
      setFlipped(false);
    } else if (review && flipped && ["1", "2", "3", "4"].includes(e.key)) void rate(Number(e.key) as 1 | 2 | 3 | 4);
  };
  const deckCard = !review ? cards[index]! : null;
  return (
    <div className="sp-cards" tabIndex={0} onKeyDown={onKey} aria-label={review ? "Flashcard review" : "Flashcard deck"}>
      <div className="sp-quiz-head">
        <span className="sp-count">{review ? `${review.remaining} left` : `${index + 1} / ${cards.length}`}</span>
        {review ? (
          <button className="sp-button" onClick={() => setReview(null)}>
            Back to deck
          </button>
        ) : (
          <button className="sp-button" onClick={() => void startReview()} disabled={busy} title="Review with spaced repetition: your ratings schedule each card">
            <Icon name="flip" /> Review
          </button>
        )}
      </div>
      {review && (review.status === "complete" || !review.current) ? (
        <p className="sp-quiet" role="status">{review.reason || "Nothing is due. Come back when cards are due."}</p>
      ) : face ? (
        <button className={`sp-flashcard ${flipped ? "is-flipped" : ""}`} onClick={() => setFlipped(!flipped)} aria-pressed={flipped} aria-label={flipped ? "Show front" : "Show back"}>
          <span className="sp-flashcard-side">{flipped ? "Back" : "Front"}</span>
          <MathText text={flipped ? face.back : face.front} className="sp-flashcard-text" />
        </button>
      ) : null}
      {deckCard ? (
        <div className="sp-row">
          <button className="sp-icon-button" aria-label="Previous card" title="Previous card (←)" disabled={index === 0} onClick={() => { setIndex(index - 1); setFlipped(false); }}>
            <Icon name="prev" />
          </button>
          <span className="sp-topics">{deckCard.topics.slice(0, 2).map((t) => <span key={t} className="sp-tag">{t}</span>)}</span>
          <SourceRef source={deckCard.source} />
          <button className="sp-icon-button" aria-label="Next card" title="Next card (→)" disabled={index + 1 >= cards.length} onClick={() => { setIndex(index + 1); setFlipped(false); }}>
            <Icon name="next" />
          </button>
        </div>
      ) : review?.current && flipped ? (
        <div className="sp-row sp-ratings" role="group" aria-label="How well did you recall it?">
          {RATINGS.map((r) => (
            <button key={r.rating} className="sp-button" disabled={busy} onClick={() => void rate(r.rating)} title={`${r.label} (${r.rating})`}>
              {r.label}
            </button>
          ))}
        </div>
      ) : null}
      {error ? <p className="sp-error" role="alert">{error}</p> : null}
    </div>
  );
}
