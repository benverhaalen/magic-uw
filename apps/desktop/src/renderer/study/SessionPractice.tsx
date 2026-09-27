// owner: study frontend. One saved practice session (per-material or course practice) through the
// canonical study ops. Checking a response and showing saved help make no new AI request.
import { forwardRef, useEffect, useId, useRef, useState } from "react";
import type { LearningRequest, StudySessionView } from "@magic/contracts";
import { sessionRequest } from "./api";
import { plural, when } from "./model";

const eventLabels = {
  answer: "Your response and feedback",
  hint: "Saved hint",
  explain: "Saved explanation",
  skip: "Skipped",
};
const outcomeLabels = {
  correct: "Matched the checked answer",
  partial: "Partly matched the checked answer",
  incorrect: "Did not match the checked answer",
  undecided: "Needs review · the check could not decide",
};

type Action = "answer" | "hint" | "saved_explanation" | "skip" | "next";

export const SessionPractice = forwardRef<
  HTMLHeadingElement,
  {
    session: StudySessionView;
    /** Why new actions are paused (policy, changed source, stale course); null when current. */
    pausedReason: string | null;
    label: string;
    onSession(session: StudySessionView): void;
    onOpenSource(url: string): void;
    onResults?: () => void;
    onClose(): void;
  }
>(function SessionPractice({ session, pausedReason, label, onSession, onOpenSource, onResults, onClose }, heading) {
  const fieldId = useId();
  const [draft, setDraft] = useState(session.draft);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const current = useRef(session);
  const draftValue = useRef(session.draft);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(true);
  const working = useRef(false);
  const openedAt = useRef(Date.now());

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // A different item or session restores that session's saved draft; typing is never overwritten.
  const itemKey = `${session.id}:${session.currentItem?.id ?? ""}:${session.currentItem?.version ?? ""}`;
  useEffect(() => {
    openedAt.current = Date.now();
    draftValue.current = session.draft;
    setDraft(session.draft);
  }, [itemKey]);
  current.current = session;

  function accept(next: StudySessionView) {
    current.current = next;
    if (mounted.current) onSession(next);
  }

  function saveDraft(value: string): Promise<void> {
    draftValue.current = value;
    setDraft(value);
    setSaving(true);
    const operation = saveQueue.current
      .catch(() => undefined)
      .then(async () => {
        const active = current.current;
        if (active.draft === draftValue.current) return;
        accept(
          await sessionRequest({
            op: "study.draft",
            sessionId: active.id,
            revision: active.revision,
            operationId: crypto.randomUUID(),
            draft: draftValue.current,
          }),
        );
      });
    saveQueue.current = operation;
    void operation
      .catch((cause: unknown) => {
        if (mounted.current)
          setError(cause instanceof Error ? cause.message : "Response could not be saved. Keep this page open and retry.");
      })
      .finally(() => {
        if (mounted.current && saveQueue.current === operation) setSaving(false);
      });
    return operation;
  }

  async function operate(action: Action | "reload") {
    if (working.current) return;
    working.current = true;
    setPending(true);
    setError("");
    try {
      await saveQueue.current.catch(() => undefined);
      const active = current.current;
      const item = active.currentItem;
      if (action === "reload") {
        accept(await sessionRequest({ op: "study.session", sessionId: active.id }));
        return;
      }
      if (!item) return;
      const common = { sessionId: active.id, revision: active.revision, operationId: crypto.randomUUID() };
      let request: LearningRequest;
      if (action === "answer") {
        const response =
          item.kind === "mc" || item.kind === "tf"
            ? { kind: "choice" as const, optionId: draftValue.current }
            : item.kind === "numeric"
              ? { kind: "number" as const, value: Number(draftValue.current), ...(item.unit ? { unit: item.unit } : {}) }
              : { kind: "text" as const, text: draftValue.current };
        request = {
          op: "study.answer",
          ...common,
          itemId: item.id,
          itemVersion: item.version,
          response,
          confidence: null,
          responseMs: Math.min(86_400_000, Math.max(0, Date.now() - openedAt.current)),
        };
      } else if (action === "hint" || action === "saved_explanation")
        request = { op: "study.hint", ...common, itemId: item.id, level: action === "hint" ? "hint" : "explain" };
      else request = { op: "study.advance", ...common, action };
      accept(await sessionRequest(request));
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : "Practice could not continue. Your saved work is still here.");
      // A write may have succeeded before transport failed. Recover the revision without discarding text.
      try {
        accept(await sessionRequest({ op: "study.session", sessionId: current.current.id }));
      } catch {
        /* Keep the saved activity and draft visible. */
      }
    } finally {
      working.current = false;
      if (mounted.current) setPending(false);
    }
  }

  const item = session.currentItem;
  const events = session.events.filter((e) => e.itemId === item?.id && e.itemVersion === item?.version);
  const canAct = !pending && !pausedReason && session.availability === "current";
  const validResponse = Boolean(draft.trim()) && (item?.kind !== "numeric" || Number.isFinite(Number(draft)));
  const planned = session.plan.reduce((sum, step) => sum + step.itemIds.length, 0);
  const done = new Set(session.events.filter((e) => e.kind === "answer" || e.kind === "skip").map((e) => e.itemId)).size;
  const saveLine = saving ? "Saving response…" : session.draft === draft ? "Response saved on this device." : "Response has unsaved changes.";

  return (
    <div className="study-activity" aria-labelledby={`${fieldId}-title`}>
      <div className="study-activity-head">
        <button className="study-back" type="button" onClick={onClose}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
          Study overview
        </button>
        <p className="study-meta">
          {label}
          {planned && item ? ` · Question ${Math.max(1, Math.min(session.answered ? done : done + 1, planned))} of ${planned}` : planned ? ` · ${plural(planned, "question")}` : ""}
        </p>
      </div>
      {pausedReason || session.availability !== "current" ? (
        <p className="study-note" role="status">
          {pausedReason || session.reason} Your saved session remains available to read.
        </p>
      ) : null}
      {item ? (
        <>
          <h4 id={`${fieldId}-title`} className="study-question" tabIndex={-1} ref={heading}>
            {item.stem}
          </h4>
          <p className="study-meta">
            {item.checks.some((c) => c.check === "quote" && c.outcome === "pass") ? "Source quote checked. " : ""}
            {item.checks.some((c) => c.check === "support" && c.outcome === "pass")
              ? "Answer support was checked; it can still be wrong."
              : "Answer support has not been independently checked."}
          </p>
          {events.length ? (
            <div className="study-history" aria-live="polite">
              {events.map((event) => (
                <div key={event.id} className="study-event">
                  <strong>{eventLabels[event.kind]}</strong>
                  <p className="study-prose">{event.text}</p>
                  {event.outcome ? <p className="study-outcome">{outcomeLabels[event.outcome]}</p> : null}
                  {event.kind === "answer" ? <p className="study-meta">Study feedback, not a course grade.</p> : null}
                </div>
              ))}
            </div>
          ) : null}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (canAct && !session.answered && validResponse) void operate("answer");
            }}
          >
            {session.answered ? (
              <div className="study-buttons">
                <button className="study-button primary" type="button" disabled={!canAct} onClick={() => void operate("next")}>
                  Next question
                </button>
              </div>
            ) : (
              <>
                {item.kind === "mc" || item.kind === "tf" ? (
                  <fieldset className="study-options" disabled={pending}>
                    <legend className="study-label">Choose an answer</legend>
                    {item.options?.map((option) => (
                      <label key={option.id} className={`study-option${draft === option.id ? " selected" : ""}`}>
                        <input
                          type="radio"
                          name={`${fieldId}-option`}
                          value={option.id}
                          checked={draft === option.id}
                          onChange={() => void saveDraft(option.id).catch(() => undefined)}
                        />
                        <span>{option.text}</span>
                      </label>
                    ))}
                  </fieldset>
                ) : (
                  <>
                    <label className="study-label" htmlFor={`${fieldId}-response`}>
                      Your response{item.kind === "numeric" && item.unit ? ` (${item.unit})` : ""}
                    </label>
                    {item.kind === "numeric" ? (
                      <input
                        id={`${fieldId}-response`}
                        className="study-field"
                        type="number"
                        step="any"
                        value={draft}
                        disabled={pending}
                        onChange={(e) => void saveDraft(e.target.value).catch(() => undefined)}
                      />
                    ) : (
                      <textarea
                        id={`${fieldId}-response`}
                        className="study-field"
                        rows={4}
                        maxLength={2000}
                        value={draft}
                        disabled={pending}
                        onChange={(e) => void saveDraft(e.target.value).catch(() => undefined)}
                        placeholder="Explain your thinking…"
                      />
                    )}
                  </>
                )}
                <p className="study-meta" role="status">{saveLine}</p>
                <div className="study-buttons">
                  <button className="study-button primary" type="submit" disabled={!canAct || !validResponse}>
                    Check response
                  </button>
                  <button className="study-button quiet" type="button" disabled={!canAct} onClick={() => void operate("hint")}>
                    Hint
                  </button>
                  <button className="study-button quiet" type="button" disabled={!canAct} onClick={() => void operate("saved_explanation")}>
                    Saved explanation
                  </button>
                  <button className="study-button quiet" type="button" disabled={!canAct} onClick={() => void operate("skip")}>
                    Skip
                  </button>
                </div>
              </>
            )}
          </form>
          <details className="study-disclosure">
            <summary>Source quote and capture time</summary>
            <p className="study-meta">
              Saved excerpts, not complete course coverage. A matching quote shows where the question came from; it
              does not guarantee the teaching is correct.
            </p>
            {session.sources.map((source) => {
              const quotes = item.citations.filter(
                (c) => c.resourceId === source.resourceId && c.contentHash === source.contentHash,
              );
              if (!quotes.length) return null;
              return (
                <div key={source.resourceId} className="study-source">
                  <button className="study-link" type="button" onClick={() => onOpenSource(source.url)}>
                    {source.title}
                  </button>
                  <span className="study-meta"> · captured {when(source.observedAt)}</span>
                  {quotes.map((c, i) => (
                    <blockquote key={i}>{c.quote}</blockquote>
                  ))}
                </div>
              );
            })}
          </details>
        </>
      ) : (
        <div className="study-finished">
          <h4 id={`${fieldId}-title`} className="study-question" tabIndex={-1} ref={heading}>
            {session.status === "complete" ? "You reached the end of this practice" : "No question is open"}
          </h4>
          <p className="study-meta">
            Your responses are saved on this device. Practicing does not mark coursework complete.
          </p>
          <div className="study-buttons">
            {onResults && session.status === "complete" ? (
              <button className="study-button primary" type="button" onClick={onResults}>
                See how your topics moved
              </button>
            ) : null}
            <button className="study-button quiet" type="button" onClick={onClose}>
              Back to study overview
            </button>
          </div>
        </div>
      )}
      {error ? (
        <div className="study-error" role="alert">
          <p>{error}</p>
          <button
            className="study-button quiet"
            type="button"
            disabled={pending}
            onClick={() => void saveDraft(draftValue.current).then(() => operate("reload")).catch(() => undefined)}
          >
            Retry
          </button>
        </div>
      ) : null}
      {pending ? <p className="study-meta" role="status">Working… your saved practice stays here.</p> : null}
    </div>
  );
});
