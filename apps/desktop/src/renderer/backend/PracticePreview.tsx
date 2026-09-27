// owner: ui-wiring. Course practice through the learning router: practice.path (counts, modules,
// open sessions), knowledge.state (per-topic evidence states), practice.target (flashcards, a Learn
// round, a quiz by module, "quiz me on" chosen topics), study.review (FSRS), study.answer /
// study.advance / study.submit for a round. The per-assignment session stays in LearningPanel on
// the item detail; this view covers the course-scoped ops LearningPanel doesn't call.
import { useRef, useState } from "react";
import type { LearningRequest, LearningResult, StudySessionView } from "@magic/contracts";
import type {
  FlashcardData,
  FlashcardSessionView,
  KnowledgeStateData,
  PracticePathData,
  PracticeResults,
  PracticeRoundData,
} from "../../../../../packages/learning/src/router-types";
import { learning, newOperationId, pack, useAction, useLoad, type Course, type PackOutcome } from "./bridge";
import { Empty, ErrorLine, Loaded, Partial, PreviewSection, topicStateLabel } from "./ui";

type Active =
  | { kind: "cards"; view: FlashcardSessionView }
  | { kind: "round"; view: StudySessionView; practice: PracticeRoundData["practice"] }
  | { kind: "results"; results: PracticeResults };

/** The router's answer, or its message as an error (the caller shows status and message). */
async function ok<T>(request: LearningRequest): Promise<{ result: LearningResult; data: T | null }> {
  const result = await learning(request);
  return { result, data: result.status === "ok" ? (result.data as T) : null };
}

export function PracticePreview({ course, anchorIds }: { course: Course; anchorIds: string[] }) {
  const scope = { courseId: course.courseId, anchorIds };
  const anchorKey = anchorIds.join(",");
  const [topicIds, setTopicIds] = useState<string[]>([]);
  const [moduleId, setModuleId] = useState("");
  const [active, setActive] = useState<Active | null>(null);
  const [answer, setAnswer] = useState<{ status: string; message: string } | null>(null);
  const [made, setMade] = useState<PackOutcome | null>(null);
  const action = useAction();
  const [path, reloadPath] = useLoad(anchorIds.length ? `path:${course.courseId}:${anchorKey}` : null, () =>
    learning({ op: "practice.path", ...scope }),
  );
  const [states, reloadStates] = useLoad(anchorIds.length ? `states:${course.courseId}:${anchorKey}:${topicIds.join(",")}` : null, () =>
    learning({ op: "knowledge.state", ...scope, ...(topicIds.length ? { topicIds } : {}) }),
  );
  const reloadAll = () => {
    reloadPath();
    reloadStates();
  };

  if (!anchorIds.length)
    return (
      <PreviewSection title="Practice" op="learning practice.path">
        <Empty>Practice is anchored to the course's assignments, and none are saved for this course yet.</Empty>
      </PreviewSection>
    );

  const start = async (mode: "flashcards" | "learn" | "test", pick: { topicIds?: string[]; moduleIds?: string[] }) => {
    setAnswer(null);
    const got = await action.run(() =>
      ok<FlashcardData | PracticeRoundData>({ op: "practice.target", ...scope, mode, count: 10, operationId: newOperationId(), ...pick }),
    );
    if (!got) return;
    if (!got.data) return setAnswer({ status: got.result.status, message: got.result.message ?? "No practice started." });
    setActive("flashcards" in got.data ? { kind: "cards", view: got.data.flashcards } : { kind: "round", view: got.data.session, practice: got.data.practice });
  };
  const generate = async (name: "cards" | "quiz") => {
    setMade(null);
    const outcome = await action.run(() => pack(name, { courseId: course.courseId, ...(topicIds.length ? { topicIds } : {}) }));
    if (outcome) {
      setMade(outcome);
      reloadAll();
    }
  };

  return (
    <PreviewSection
      title="Practice"
      op="learning practice.path · knowledge.state · practice.target · study.review · study.answer / advance / submit · pack cards|quiz"
      actions={
        <button className="button small-button" onClick={reloadAll}>
          Reload
        </button>
      }
    >
      <Loaded load={path} retry={reloadPath}>
        {(result) => {
          const data = (result.data ?? null) as PracticePathData | null;
          if (!data) return <Partial status={result.status}>{result.message ?? "Practice isn't available for this course."}</Partial>;
          return (
            <>
              {result.status !== "ok" ? <Partial status={result.status}>{result.message}</Partial> : null}
              {data.availability !== "current" ? <Partial status={data.availability}>{data.reason}</Partial> : null}
              <p className="small">
                {data.questions} checked questions · {data.cards.total} cards ({data.cards.dueToday} due today) · Mastered {data.mastered.count} of{" "}
                {data.mastered.of} topics
              </p>
              <div className="inline-actions">
                <button className="button small-button" disabled={action.busy} onClick={() => void generate("cards")}>
                  Generate flashcards
                </button>
                <button className="button small-button" disabled={action.busy} onClick={() => void generate("quiz")}>
                  Generate quiz questions
                </button>
              </div>
              {made ? (
                <Partial status={made.status}>
                  {made.message}
                  {made.tokens ? ` · ${made.cached ? "cached, " : ""}${made.tokens.in + made.tokens.out} tokens` : ""}
                </Partial>
              ) : null}
              {data.topics.length ? (
                <>
                  <h3>Quiz me on</h3>
                  <div className="backend-checks">
                    {data.topics.map((t) => (
                      <label key={t.conceptId}>
                        <input
                          type="checkbox"
                          checked={topicIds.includes(t.conceptId)}
                          onChange={(event) =>
                            setTopicIds((ids) => (event.target.checked ? [...ids, t.conceptId] : ids.filter((id) => id !== t.conceptId)))
                          }
                        />
                        {t.label}
                      </label>
                    ))}
                  </div>
                </>
              ) : (
                <Empty>No topics in this course's map yet; they come from generated practice and the course map.</Empty>
              )}
              <div className="backend-controls">
                <button className="button" disabled={action.busy || !data.ready} onClick={() => void start("flashcards", topicIds.length ? { topicIds } : {})}>
                  Review flashcards
                </button>
                <button className="button" disabled={action.busy || !data.ready} onClick={() => void start("learn", topicIds.length ? { topicIds } : {})}>
                  {topicIds.length ? "Learn round on chosen topics" : "Learn round"}
                </button>
                <button className="button" disabled={action.busy || !data.ready || !topicIds.length} onClick={() => void start("test", { topicIds })}>
                  Quiz me on chosen topics
                </button>
                <label>
                  Module
                  <select value={moduleId} onChange={(event) => setModuleId(event.target.value)}>
                    <option value="">Choose a module</option>
                    {data.modules.map((m) => (
                      <option key={m.moduleId} value={m.moduleId}>
                        {m.label} ({m.questions} questions, {m.cards} cards)
                      </option>
                    ))}
                  </select>
                </label>
                <button className="button" disabled={action.busy || !data.ready || !moduleId} onClick={() => void start("test", { moduleIds: [moduleId] })}>
                  Quiz by module
                </button>
              </div>
              {!data.modules.length ? <p className="small muted">No modules in the course map yet, so a quiz can't be sectioned by module.</p> : null}
              {data.openSessions.length ? (
                <p className="small muted">
                  Open sessions: {data.openSessions.map((s) => `${s.goal} (${s.mode})`).join(" · ")}
                </p>
              ) : null}
            </>
          );
        }}
      </Loaded>
      {answer ? <Partial status={answer.status}>{answer.message}</Partial> : null}
      <ErrorLine text={action.error} />
      {active?.kind === "cards" ? (
        <Flashcards
          view={active.view}
          onChange={(view) => setActive({ kind: "cards", view })}
          onDone={() => {
            setActive(null);
            reloadAll();
          }}
        />
      ) : active?.kind === "round" ? (
        <Round
          view={active.view}
          practice={active.practice}
          onChange={(view, practice) => setActive({ kind: "round", view, practice })}
          onResults={(results) => {
            setActive({ kind: "results", results });
            reloadAll();
          }}
        />
      ) : active?.kind === "results" ? (
        <Results results={active.results} onClose={() => setActive(null)} />
      ) : null}
      <h3>Topic states{topicIds.length ? " (chosen topics)" : ""}</h3>
      <p className="small muted">Evidence-defined states from your own practice; not a grade prediction.</p>
      <Loaded load={states} retry={reloadStates}>
        {(result) => {
          const data = (result.data ?? null) as KnowledgeStateData | null;
          if (!data) return <Partial status={result.status}>{result.message ?? "Topic states are unavailable."}</Partial>;
          if (!data.topics.length) return <Empty>No topics yet: states appear once the course has a topic map.</Empty>;
          return (
            <ul className="backend-list">
              {data.topics.map((t) => (
                <li key={t.conceptId}>
                  <div className="backend-row">
                    <strong>{t.label}</strong>
                    <span className="badge">{t.stateLabel}</span>
                  </div>
                  <div className="backend-meta">
                    {t.moduleLabel ? `${t.moduleLabel} · ` : ""}
                    {t.counts.answers} answers, {t.counts.cardReviews} card reviews · {t.practiceItems} practice items
                  </div>
                  {t.reasons[0] ? <div className="backend-meta">{t.reasons[0].text} Clears when: {t.reasons[0].clearsWhen}</div> : null}
                </li>
              ))}
            </ul>
          );
        }}
      </Loaded>
    </PreviewSection>
  );
}

const ratings: [1 | 2 | 3 | 4, string][] = [
  [1, "Again"],
  [2, "Hard"],
  [3, "Good"],
  [4, "Easy"],
];

function Flashcards({ view, onChange, onDone }: { view: FlashcardSessionView; onChange: (v: FlashcardSessionView) => void; onDone: () => void }) {
  const [flipped, setFlipped] = useState(false);
  const shownAt = useRef(Date.now());
  const action = useAction();
  const card = view.current;
  const rate = async (rating: 1 | 2 | 3 | 4) => {
    if (!card) return;
    const got = await action.run(() =>
      ok<FlashcardData>({
        op: "study.review",
        cardId: card.cardId,
        rating,
        reviewMs: Math.min(86_400_000, Date.now() - shownAt.current),
        sessionId: view.id,
        revision: view.revision,
        operationId: newOperationId(),
      }),
    );
    if (!got) return;
    if (!got.data) return action.setError(got.result.message ?? "The review was not saved.");
    setFlipped(false);
    shownAt.current = Date.now();
    onChange(got.data.flashcards);
  };
  return (
    <div className="backend-card">
      <div className="backend-row">
        <strong>Flashcards</strong>
        <span className="small muted">
          {view.remaining} left · {view.dueToday} due today · {view.reviewed.length} reviewed
        </span>
      </div>
      {view.availability !== "current" ? <Partial status={view.availability}>{view.reason}</Partial> : null}
      {card ? (
        <>
          <div className="backend-meta">Topics: {card.topics.map((t) => t.label).join(", ") || "none tagged"}</div>
          <p>{card.front}</p>
          {flipped ? (
            <>
              <p>
                <strong>Answer: </strong>
                {card.back}
              </p>
              {card.citations[0] ? <blockquote className="backend-quote">{card.citations[0].quote}</blockquote> : null}
              <div className="inline-actions">
                {ratings.map(([value, label]) => (
                  <button key={value} className="button small-button" disabled={action.busy} onClick={() => void rate(value)}>
                    {label}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <button className="button small-button" onClick={() => setFlipped(true)}>
              Show answer
            </button>
          )}
        </>
      ) : (
        <>
          <p className="small">Session complete. Reviews are saved on this device.</p>
          <button className="button small-button" onClick={onDone}>
            Close
          </button>
        </>
      )}
      <ErrorLine text={action.error} />
    </div>
  );
}

function Round({
  view,
  practice,
  onChange,
  onResults,
}: {
  view: StudySessionView;
  practice: PracticeRoundData["practice"];
  onChange: (v: StudySessionView, p: PracticeRoundData["practice"]) => void;
  onResults: (r: PracticeResults) => void;
}) {
  const [response, setResponse] = useState("");
  const shownAt = useRef(Date.now());
  const action = useAction();
  const item = view.currentItem;
  const topics = item ? practice.topicsByItem[`${item.id}@${item.version}`] ?? [] : [];
  const section = item ? practice.sections.find((s) => s.itemIds.includes(item.id)) : undefined;
  const step = async (request: LearningRequest) => {
    const got = await action.run(() => ok<PracticeRoundData>(request));
    if (!got) return;
    if (!got.data) return action.setError(got.result.message ?? "The round could not continue.");
    setResponse("");
    shownAt.current = Date.now();
    onChange(got.data.session, got.data.practice);
  };
  const common = () => ({ sessionId: view.id, revision: view.revision, operationId: newOperationId() });
  const submitAnswer = () => {
    if (!item) return;
    const value =
      item.kind === "mc" || item.kind === "tf"
        ? { kind: "choice" as const, optionId: response }
        : item.kind === "numeric"
          ? { kind: "number" as const, value: Number(response), ...(item.unit ? { unit: item.unit } : {}) }
          : { kind: "text" as const, text: response };
    void step({
      op: "study.answer",
      ...common(),
      itemId: item.id,
      itemVersion: item.version,
      response: value,
      confidence: null,
      responseMs: Math.min(86_400_000, Date.now() - shownAt.current),
    });
  };
  const finish = async () => {
    const got = await action.run(() => ok<{ results: PracticeResults }>({ op: "study.submit", sessionId: view.id }));
    if (!got) return;
    if (!got.data) return action.setError(got.result.message ?? "Results are unavailable.");
    onResults(got.data.results);
  };
  const lastEvent = item ? view.events.filter((e) => e.itemId === item.id && e.kind === "answer").at(-1) : undefined;
  return (
    <div className="backend-card">
      <div className="backend-row">
        <strong>{view.goal}</strong>
        <span className="badge">{practice.mode === "test" ? "Quiz" : "Learn"}</span>
      </div>
      {practice.sections.length > 1 || section ? (
        <div className="backend-meta">Sections: {practice.sections.map((s) => (s === section ? `[${s.label}]` : s.label)).join(" · ")}</div>
      ) : null}
      {view.availability !== "current" ? <Partial status={view.availability}>{view.reason}</Partial> : null}
      {item ? (
        <>
          <div className="backend-meta">Topics: {topics.map((t) => t.label).join(", ") || "none tagged"}</div>
          <p>{item.stem}</p>
          {view.answered ? (
            <>
              {lastEvent ? (
                <p className="small">
                  {lastEvent.outcome ? `${lastEvent.outcome}. ` : ""}
                  {lastEvent.text}
                </p>
              ) : null}
              <p className="small muted">Study feedback, not a course grade.</p>
              <button className="button small-button" disabled={action.busy} onClick={() => void step({ op: "study.advance", ...common(), action: "next" })}>
                Next
              </button>
            </>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (response.trim()) submitAnswer();
              }}
            >
              {item.options ? (
                <div className="backend-checks">
                  {item.options.map((o) => (
                    <label key={o.id}>
                      <input type="radio" name={`answer-${item.id}`} checked={response === o.id} onChange={() => setResponse(o.id)} />
                      {o.text}
                    </label>
                  ))}
                </div>
              ) : (
                <input
                  className="text-input"
                  aria-label="Your answer"
                  type={item.kind === "numeric" ? "number" : "text"}
                  value={response}
                  onChange={(event) => setResponse(event.target.value)}
                />
              )}
              <div className="inline-actions">
                <button className="button small-button" type="submit" disabled={action.busy || !response.trim()}>
                  Check
                </button>
                <button className="button small-button" type="button" disabled={action.busy} onClick={() => void step({ op: "study.advance", ...common(), action: "skip" })}>
                  Skip
                </button>
              </div>
            </form>
          )}
        </>
      ) : (
        <p className="small">No questions left in this round.</p>
      )}
      <div className="inline-actions">
        <button className="subtle-button" disabled={action.busy} onClick={() => void finish()}>
          Finish and see topic results
        </button>
      </div>
      <ErrorLine text={action.error} />
    </div>
  );
}

function Results({ results, onClose }: { results: PracticeResults; onClose: () => void }) {
  return (
    <div className="backend-card">
      <div className="backend-row">
        <strong>Round results</strong>
        <button className="button small-button" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="small">
        {results.answered} answered · {results.correct} matched the checked answer · {results.skipped} skipped
        {results.unscored ? ` · ${results.unscored} could not be settled by code` : ""}
      </p>
      <ul className="backend-list">
        {results.topics.map((t) => (
          <li key={t.conceptId}>
            {t.label}: {t.before ? topicStateLabel[t.before] : "no evidence"} → {t.afterLabel} ({t.direction})
          </li>
        ))}
      </ul>
      {results.studyNext.length ? <p className="small muted">Study next: {results.studyNext.map((s) => `${s.label} (${s.reason})`).join(" · ")}</p> : null}
    </div>
  );
}
