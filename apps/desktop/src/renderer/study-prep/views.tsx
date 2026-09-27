// owner: study-prep. The study actions' views: the study guide, the practice quiz (graded by code,
// then the explanation), flashcards (a flip deck, and a review that records ratings in the existing
// FSRS schedule), the practice exam (timed or untimed, then the key with worked solutions and the
// passages behind each problem), practice problems, the outline coach, the rubric checklist and
// the milestone plan.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { StudyPrepCard, StudyPrepExam, StudyPrepExamProblem, StudyPrepGuide, StudyPrepOutline, StudyPrepQuizItem, StudyPrepQuote, StudyPrepSections } from "@magic/contracts";
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
  if (!guide.sections.length) return <p className="sp-quiet">Nothing in this guide passed the checks. Try again, or tick more materials.</p>;
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
  useEffect(() => {
    setIndex(0);
    setAnswers({});
  }, [items]);
  if (!items.length) return <p className="sp-quiet">No questions passed the checks. Try again, or tick more materials.</p>;
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
    if (!checked && q.options && n >= 1 && n <= q.options.length) {
      e.stopPropagation();
      set({ choice: q.options[n - 1]!.id, check: undefined });
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (checked) setIndex(index + 1);
      else check();
    }
  };
  return (
    <div className="sp-quiz" tabIndex={-1} onKeyDown={onKey} aria-label="Practice quiz">
      <Progress value={index} of={items.length} label={`Question ${index + 1} of ${items.length}`} />
      <div className="sp-quiz-head">
        <span className="sp-topics">{q.topics.slice(0, 3).map((t) => <span key={t} className="sp-tag">{t}</span>)}</span>
      </div>
      <p className="sp-stem" id={`stem-${q.itemId}`}>
        <MathText text={q.stem} />
      </p>
      {q.kind === "numeric" ? (
        <label className="sp-numeric">
          <input type="text" inputMode="decimal" aria-labelledby={`stem-${q.itemId}`} value={a.text ?? ""} disabled={!!checked} onChange={(e) => set({ text: e.target.value, check: undefined })} placeholder="Your answer" />
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

function Progress({ value, of, label }: { value: number; of: number; label: string }) {
  return (
    <div className="sp-progress" role="progressbar" aria-valuemin={0} aria-valuemax={of} aria-valuenow={value} aria-label={label}>
      <span className="sp-progress-bar" style={{ width: `${of ? Math.round((100 * value) / of) : 0}%` }} />
      <span className="sp-progress-label">{label}</span>
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

/**
 * Flashcards: a deck to flip through (arrows, space) and a review that schedules each card with
 * FSRS (1 to 4 to rate), scoped to exactly this item's linked cards.
 */
export function CardsView({ cards, courseId, anchorIds, reviewItemIds, dueCount, startInReview = false }: { cards: StudyPrepCard[]; courseId: string; anchorIds: string[]; reviewItemIds: string[]; dueCount: number; startInReview?: boolean }) {
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [review, setReview] = useState<ReviewSession | null>(null);
  const [reviewed, setReviewed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shownAt = useRef(Date.now());
  const started = useRef(false);
  useEffect(() => {
    setIndex(0);
    setFlipped(false);
  }, [cards]);
  useEffect(() => {
    shownAt.current = Date.now();
  }, [review?.current?.cardId, index]);
  const sessionOf = (data: unknown): ReviewSession | null => {
    const f = (data as { flashcards?: ReviewSession } | undefined)?.flashcards;
    return f && typeof f.id === "string" ? f : null;
  };
  const startReview = async () => {
    if (!reviewItemIds.length) return setError("No cards are linked to this item yet.");
    if (!anchorIds.length) return setError("This course has no saved material to review against yet.");
    setBusy(true);
    setError(null);
    try {
      const r = await learning({ op: "practice.target", courseId, anchorIds: anchorIds.slice(0, 50), mode: "flashcards", count: Math.min(60, reviewItemIds.length), itemIds: reviewItemIds.slice(0, 200), operationId: operationId() });
      const s = r.status === "ok" ? sessionOf(r.data) : null;
      if (!s) setError(r.message ?? "Review couldn't start.");
      else {
        setReview(s);
        setReviewed(0);
        setFlipped(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (startInReview && !started.current) {
      started.current = true;
      void startReview();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startInReview]);
  const rate = async (rating: 1 | 2 | 3 | 4) => {
    if (!review?.current || busy) return;
    setBusy(true);
    try {
      const r = await learning({ op: "study.review", cardId: review.current.cardId, rating, reviewMs: Math.min(86_400_000, Date.now() - shownAt.current), sessionId: review.id, revision: review.revision, operationId: operationId() });
      const s = r.status === "ok" ? sessionOf(r.data) : null;
      if (!s) setError(r.message ?? "That rating wasn't saved.");
      else {
        setReview(s);
        setReviewed((n) => n + 1);
        setFlipped(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  if (!cards.length && !review && !busy)
    return (
      <div className="sp-empty">
        <p className="sp-quiet">{reviewItemIds.length ? `${dueCount} card${dueCount === 1 ? "" : "s"} due for this item.` : "No cards for this item yet."}</p>
        {reviewItemIds.length ? (
          <button className="sp-button sp-primary" onClick={() => void startReview()}>
            <Icon name="flip" /> Review now
          </button>
        ) : null}
        {error ? <p className="sp-error" role="alert">{error}</p> : null}
      </div>
    );
  const face = review ? review.current : cards[index];
  const onKey = (e: KeyboardEvent) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      setFlipped((f) => !f);
    } else if (!review && e.key === "ArrowRight") {
      e.stopPropagation();
      setIndex((i) => Math.min(cards.length - 1, i + 1));
      setFlipped(false);
    } else if (!review && e.key === "ArrowLeft") {
      e.stopPropagation();
      setIndex((i) => Math.max(0, i - 1));
      setFlipped(false);
    } else if (review && flipped && ["1", "2", "3", "4"].includes(e.key)) {
      e.stopPropagation();
      void rate(Number(e.key) as 1 | 2 | 3 | 4);
    }
  };
  const deckCard = !review ? cards[index] : null;
  const total = review ? reviewed + review.remaining : cards.length;
  return (
    <div className="sp-cards" tabIndex={0} onKeyDown={onKey} aria-label={review ? "Flashcard review" : "Flashcard deck"}>
      <div className="sp-quiz-head">
        <Progress value={review ? reviewed : index + 1} of={total} label={review ? `${review.remaining} left · ${reviewed} reviewed` : `${index + 1} of ${cards.length}`} />
        {review ? (
          <button className="sp-button" onClick={() => setReview(null)}>
            Deck
          </button>
        ) : (
          <button className="sp-button" onClick={() => void startReview()} disabled={busy || !reviewItemIds.length} title="Review with spaced repetition: your ratings schedule each card">
            <Icon name="flip" /> Review{dueCount ? ` · ${dueCount} due` : ""}
          </button>
        )}
      </div>
      {review && (review.status === "complete" || !review.current) ? (
        <p className="sp-quiet" role="status">{reviewed ? `Done: ${reviewed} reviewed.` : review.reason || "Nothing is due. Come back when cards are due."}</p>
      ) : face ? (
        <button className={`sp-flashcard ${flipped ? "is-flipped" : ""}`} onClick={() => setFlipped(!flipped)} aria-pressed={flipped} aria-label={flipped ? "Show front" : "Show back"}>
          <span className="sp-flashcard-side">{flipped ? "Back" : "Front"}</span>
          <MathText text={flipped ? face.back : face.front} className="sp-flashcard-text" />
        </button>
      ) : (
        <div className="sp-skeleton sp-skeleton-card" aria-busy="true" />
      )}
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
      ) : review?.current ? (
        <div className="sp-row sp-ratings" role="group" aria-label="How well did you recall it?">
          {flipped ? (
            RATINGS.map((r) => (
              <button key={r.rating} className="sp-button" disabled={busy} onClick={() => void rate(r.rating)} title={`${r.label} (${r.rating})`}>
                <span className="sp-kbd">{r.rating}</span> {r.label}
              </button>
            ))
          ) : (
            <span className="sp-hint">Space to show the answer, then 1 to 4 to rate it.</span>
          )}
        </div>
      ) : null}
      {error ? <p className="sp-error" role="alert">{error}</p> : null}
    </div>
  );
}

// ---------- Problems: practice problems and practice exams ----------
type Mark = "right" | "wrong" | null;
function gradeProblem(p: StudyPrepExamProblem, response: string): Mark {
  if (!p.answer) return null;
  if (p.answer.kind === "choice") return response ? (response === p.answer.key ? "right" : "wrong") : null;
  if (p.answer.kind === "numeric") {
    if (!response.trim()) return null;
    const c = checkAnswer({ kind: "numeric", options: null, key: p.answer.value, unit: p.answer.unit }, { kind: "number", text: response });
    return c.status === "right" ? "right" : c.status === "wrong" ? "wrong" : null;
  }
  return null; // expressions and proofs: the student marks against the worked solution
}
const answerText = (p: StudyPrepExamProblem) =>
  !p.answer ? null : p.answer.kind === "choice" ? (p.options?.find((o) => o.id === (p.answer as { key: string }).key)?.text ?? null) : p.answer.kind === "numeric" ? `${p.answer.value}${p.answer.unit ? ` ${p.answer.unit}` : ""}` : `$${p.answer.expr}$`;

function ProblemBlock({ p, response, onResponse, reveal, mark, onMark, locked }: { p: StudyPrepExamProblem; response: string; onResponse: (v: string) => void; reveal: boolean; mark: Mark; onMark: (m: Mark) => void; locked: boolean }) {
  const auto = gradeProblem(p, response);
  const shown = reveal ? (auto ?? mark) : null;
  return (
    <li className={`sp-problem ${shown ? `is-${shown}` : ""}`}>
      <div className="sp-problem-head">
        <strong>{p.number}.</strong>
        {p.points !== null ? <span className="sp-tag">{p.points} pt{p.points === 1 ? "" : "s"}</span> : null}
        <span className="sp-tag">{p.topic}</span>
      </div>
      <MathText text={p.prompt} className="sp-stem" />
      {p.options ? (
        <div className="sp-options" role="radiogroup">
          {p.options.map((o) => (
            <label key={o.id} className={`sp-option ${response === o.id ? "is-chosen" : ""} ${reveal && p.answer?.kind === "choice" && o.id === p.answer.key ? "is-key" : ""}`}>
              <input type="radio" name={`p-${p.id}`} checked={response === o.id} disabled={locked} onChange={() => onResponse(o.id)} />
              <MathText text={o.text} />
            </label>
          ))}
        </div>
      ) : p.answer?.kind === "numeric" ? (
        <label className="sp-numeric">
          <input type="text" inputMode="decimal" value={response} disabled={locked} onChange={(e) => onResponse(e.target.value)} placeholder="Your answer" aria-label={`Answer to problem ${p.number}`} />
          {p.answer.unit ? <span className="sp-unit">{p.answer.unit}</span> : null}
        </label>
      ) : (
        <textarea className="sp-work" value={response} disabled={locked} onChange={(e) => onResponse(e.target.value)} placeholder="Your work" rows={3} aria-label={`Your work for problem ${p.number}`} />
      )}
      {reveal ? (
        <div className="sp-feedback" role="status">
          {auto ? <strong>{auto === "right" ? "Right." : "Not quite."}</strong> : (
            <span className="sp-row sp-mark" role="group" aria-label="Mark your answer against the solution">
              <span className="sp-hint">Compare with the solution:</span>
              <button className={`sp-button ${mark === "right" ? "sp-primary" : ""}`} onClick={() => onMark("right")}>Right</button>
              <button className={`sp-button ${mark === "wrong" ? "sp-primary" : ""}`} onClick={() => onMark("wrong")}>Not yet</button>
            </span>
          )}
          {answerText(p) ? (
            <span>
              Answer: <MathText text={answerText(p)!} />
            </span>
          ) : null}
          <MathText text={p.solution} className="sp-explanation" />
          <span className="sp-cites">
            {p.sources.map((s, i) => (
              <SourceRef key={i} source={s} />
            ))}
            <span className="sp-hint" title="How the app checked this answer">{p.verified === "recomputed" ? "Answer recomputed" : p.verified === "symbolic" ? "Answer checked symbolically" : p.verified === "key" ? "One key among the options" : "Marked by you"}</span>
          </span>
        </div>
      ) : null}
    </li>
  );
}

export function ExamView({ exam }: { exam: StudyPrepExam }) {
  const [phase, setPhase] = useState<"ready" | "taking" | "done">("ready");
  const [timed, setTimed] = useState(!!exam.minutes);
  const [responses, setResponses] = useState<Record<string, string>>({});
  const [marks, setMarks] = useState<Record<string, Mark>>({});
  const [endsAt, setEndsAt] = useState<number | null>(null);
  const [nowMs, setNow] = useState(Date.now());
  useEffect(() => {
    if (phase !== "taking" || !endsAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [phase, endsAt]);
  useEffect(() => {
    if (phase === "taking" && endsAt && nowMs >= endsAt) setPhase("done");
  }, [nowMs, endsAt, phase]);
  const sections = useMemo(() => {
    const out = new Map<string, StudyPrepExamProblem[]>();
    for (const p of exam.problems) out.set(p.section ?? "", [...(out.get(p.section ?? "") ?? []), p]);
    return [...out.entries()];
  }, [exam]);
  if (!exam.problems.length) return <p className="sp-quiet">No problems passed the checks. Try again, or tick more materials.</p>;
  const score = exam.problems.reduce(
    (acc, p) => {
      const m = gradeProblem(p, responses[p.id] ?? "") ?? marks[p.id] ?? null;
      return { earned: acc.earned + (m === "right" ? (p.points ?? 1) : 0), marked: acc.marked + (m ? 1 : 0) };
    },
    { earned: 0, marked: 0 },
  );
  const total = exam.totalPoints ?? exam.problems.reduce((n, p) => n + (p.points ?? 1), 0);
  const left = endsAt ? Math.max(0, Math.round((endsAt - nowMs) / 1000)) : null;
  return (
    <article className="sp-exam" aria-label={exam.title}>
      <div className="sp-exam-head">
        <h3 className="sp-view-title">{exam.title}</h3>
        <p className="sp-hint">{exam.basis}</p>
      </div>
      {phase === "ready" ? (
        <div className="sp-row sp-exam-start">
          <label className="sp-check">
            <input type="checkbox" checked={timed} disabled={!exam.minutes} onChange={(e) => setTimed(e.target.checked)} /> Timed{exam.minutes ? ` (${exam.minutes} min)` : ""}
          </label>
          <button className="sp-button sp-primary" onClick={() => { setPhase("taking"); setEndsAt(timed && exam.minutes ? Date.now() + exam.minutes * 60_000 : null); }}>
            Start
          </button>
        </div>
      ) : (
        <div className="sp-row sp-exam-bar" role="status">
          {phase === "taking" ? <span className="sp-count">{left !== null ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} left` : "Untimed"}</span> : <span className="sp-count">{score.earned} of {total} points{score.marked < exam.problems.length ? ` (${exam.problems.length - score.marked} to mark)` : ""}</span>}
          {phase === "taking" ? (
            <button className="sp-button sp-primary" onClick={() => setPhase("done")}>Submit</button>
          ) : (
            <button className="sp-button" onClick={() => { setResponses({}); setMarks({}); setPhase("ready"); }}>
              <Icon name="refresh" /> Try again
            </button>
          )}
        </div>
      )}
      {phase !== "ready"
        ? sections.map(([section, problems]) => (
            <section key={section} className="sp-exam-section">
              {section ? <h4 className="sp-group-title">{section}</h4> : null}
              <ol className="sp-problems">
                {problems.map((p) => (
                  <ProblemBlock key={p.id} p={p} response={responses[p.id] ?? ""} onResponse={(v) => setResponses((r) => ({ ...r, [p.id]: v }))} reveal={phase === "done"} mark={marks[p.id] ?? null} onMark={(m) => setMarks((x) => ({ ...x, [p.id]: m }))} locked={phase === "done"} />
                ))}
              </ol>
            </section>
          ))
        : null}
    </article>
  );
}

export function ProblemsView({ problems }: { problems: StudyPrepExamProblem[] }) {
  const [responses, setResponses] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [marks, setMarks] = useState<Record<string, Mark>>({});
  if (!problems.length) return <p className="sp-quiet">No problems passed the checks. Try again, or tick more materials.</p>;
  return (
    <ol className="sp-problems" aria-label="Practice problems">
      {problems.map((p) => (
        <div key={p.id}>
          <ProblemBlock p={p} response={responses[p.id] ?? ""} onResponse={(v) => setResponses((r) => ({ ...r, [p.id]: v }))} reveal={!!shown[p.id]} mark={marks[p.id] ?? null} onMark={(m) => setMarks((x) => ({ ...x, [p.id]: m }))} locked={!!shown[p.id]} />
          {!shown[p.id] ? (
            <button className="sp-button" onClick={() => setShown((s) => ({ ...s, [p.id]: true }))}>
              <Icon name="check" /> Check and show the solution
            </button>
          ) : null}
        </div>
      ))}
    </ol>
  );
}

export function OutlineView({ outline }: { outline: StudyPrepOutline }) {
  if (!outline.sections.length && !outline.focus.length) return <p className="sp-quiet">Nothing in the outline passed the checks. Try again.</p>;
  return (
    <article className="sp-outline" aria-label={outline.title}>
      <h3 className="sp-view-title">{outline.title}</h3>
      <p className="sp-hint">Questions and a structure to work from. The writing is yours.</p>
      {outline.focus.length ? (
        <section>
          <h4 className="sp-group-title">Your main point</h4>
          <ul className="sp-checklist">
            {outline.focus.map((q, i) => (
              <li key={i}>
                <MathText text={q} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {outline.sections.map((s, i) => (
        <Disclosure key={i} label={s.heading} defaultOpen={i < 2}>
          <ul className="sp-checklist">
            {s.questions.map((q, j) => (
              <li key={j}>
                <MathText text={q} />
              </li>
            ))}
          </ul>
          {s.evidence.length ? (
            <ul className="sp-evidence">
              {s.evidence.map((e, j) => (
                <li key={j}>
                  <span>{e.hint}</span> <SourceRef source={e.source} />
                </li>
              ))}
            </ul>
          ) : null}
        </Disclosure>
      ))}
    </article>
  );
}

/** Each rubric criterion to check before submitting; the ticks stay on this device. */
export function RubricView({ itemId, rubric }: { itemId: string; rubric: NonNullable<StudyPrepSections["rubric"]> }) {
  const storageKey = `magic:rubric-check:${itemId}`;
  const [done, setDone] = useState<Record<number, boolean>>(() => {
    try {
      return JSON.parse(globalThis.localStorage?.getItem(storageKey) ?? "{}") as Record<number, boolean>;
    } catch {
      return {};
    }
  });
  useEffect(() => {
    try {
      globalThis.localStorage?.setItem(storageKey, JSON.stringify(done));
    } catch {
      /* the checklist still works for this session */
    }
  }, [done, storageKey]);
  if (!rubric.length) return <p className="sp-quiet">No rubric was posted for this item.</p>;
  const count = Object.values(done).filter(Boolean).length;
  return (
    <div className="sp-rubric">
      <Progress value={count} of={rubric.length} label={`${count} of ${rubric.length} checked`} />
      <ul className="sp-checklist">
        {rubric.map((c, i) => (
          <li key={i}>
            <label className="sp-check">
              <input type="checkbox" checked={!!done[i]} onChange={(e) => setDone((d) => ({ ...d, [i]: e.target.checked }))} />
              <span>
                <strong>{c.criterion}</strong>
                {c.points !== null ? <span className="sp-tag">{c.points} pts</span> : null}
                {c.detail ? <span className="sp-hint">{c.detail}</span> : null}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function MilestonesView({ milestones, now = new Date() }: { milestones: NonNullable<StudyPrepSections["milestones"]>; now?: Date }) {
  if (!milestones.length) return <p className="sp-quiet">No dated deliverables were found for this project.</p>;
  const day = (iso: string | null) => (iso ? Math.round((new Date(iso).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000) : null);
  return (
    <ol className="sp-milestones">
      {milestones.map((m) => {
        const d = day(m.date);
        return (
          <li key={m.resourceId} className={m.done ? "is-done" : d !== null && d < 0 ? "is-past" : ""}>
            <span className="sp-milestone-dot" aria-hidden="true" />
            <a href={`#resource/${encodeURIComponent(m.resourceId)}`}>{m.title}</a>
            <span className="sp-hint">{m.done ? "Submitted" : m.date ? `${m.date.slice(0, 10)}${d !== null ? ` · ${d === 0 ? "today" : d > 0 ? `in ${d} days` : `${-d} days ago`}` : ""}` : "No date"}</span>
          </li>
        );
      })}
    </ol>
  );
}
