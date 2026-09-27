import { useEffect, useId, useRef, useState } from "react";
import type {
  LearningAct,
  LearningSessionView,
  ResourceView,
} from "@magic/contracts";

const formatLabels = {
  explanation: "Explanation",
  worked_example: "Worked example",
  practice: "Practice",
};
const eventLabels = {
  exposure: "Activity opened",
  hint: "Hint",
  answer: "Your response",
  skip: "Skipped",
  feedback: "Feedback",
  failure: "Could not finish",
};
function timestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Capture time unknown"
    : date.toLocaleString();
}

export function LearningPanel({
  resource,
  accountScope,
}: {
  resource: ResourceView;
  accountScope?: string;
}) {
  const fieldId = useId();
  const [view, setView] = useState<LearningSessionView | null>(null);
  const [sessions, setSessions] = useState<LearningSessionView[]>([]);
  const [goal, setGoal] = useState("");
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [backendReady, setBackendReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const current = useRef<LearningSessionView | null>(null);
  const draftValue = useRef("");
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(false);
  const working = useRef(false);
  const cancelled = useRef(false);
  const available = Boolean(
    window.magic.learningList &&
    window.magic.learningGet &&
    window.magic.learningStart &&
    window.magic.learningAct &&
    window.magic.learningSaveDraft,
  );

  function accept(result: LearningSessionView, restoreDraft = false) {
    if (
      result.session.resourceId !== resource.id ||
      (accountScope && result.session.accountScope !== accountScope)
    )
      return;
    current.current = result;
    if (!mounted.current) return;
    setView(result);
    setSessions((previous) => [
      result,
      ...previous.filter((item) => item.session.id !== result.session.id),
    ]);
    if (restoreDraft) {
      draftValue.current = result.session.draft;
      setDraft(result.session.draft);
    }
  }

  useEffect(() => {
    mounted.current = true;
    if (!window.magic.learningList) {
      setLoading(false);
      return;
    }
    void window.magic
      .learningList(resource.id)
      .then((items) => {
        if (!mounted.current) return;
        const matching = items.filter(
          (item) =>
            item.session.resourceId === resource.id &&
            (!accountScope || item.session.accountScope === accountScope),
        );
        setBackendReady(true);
        setSessions(matching);
        if (matching[0]) accept(matching[0], true);
      })
      .catch((cause: unknown) => {
        if (mounted.current)
          setError(
            cause instanceof Error
              ? cause.message
              : "Saved learning could not be loaded.",
          );
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
    return () => {
      mounted.current = false;
      if (working.current)
        void window.magic.cancelLearning?.().catch(() => undefined);
    };
  }, [resource.id, accountScope]);

  // Serialize writes and coalesce fast typing. Reads never start model inference.
  function saveDraft(value: string): Promise<void> {
    draftValue.current = value;
    setDraft(value);
    setSaving(true);
    const operation = saveQueue.current
      .catch(() => undefined)
      .then(async () => {
        const active = current.current;
        if (
          !active ||
          !window.magic.learningSaveDraft ||
          active.session.draft === draftValue.current
        )
          return;
        const result = await window.magic.learningSaveDraft({
          sessionId: active.session.id,
          revision: active.session.revision,
          draft: draftValue.current,
        });
        accept(result);
      });
    saveQueue.current = operation;
    void operation
      .catch((cause: unknown) => {
        if (mounted.current)
          setError(
            cause instanceof Error
              ? cause.message
              : "Draft could not be saved. Keep this page open and retry.",
          );
      })
      .finally(() => {
        if (mounted.current && saveQueue.current === operation)
          setSaving(false);
      });
    return operation;
  }

  async function operate(
    action: "start" | "explain" | "reload" | LearningAct["action"],
    sessionId?: string,
  ) {
    if (working.current) return;
    working.current = true;
    cancelled.current = false;
    setPending(true);
    setError("");
    setNotice("");
    try {
      await saveQueue.current;
      if (cancelled.current || !mounted.current) return;
      if (action === "reload") {
        if (sessionId) accept(await window.magic.learningGet!(sessionId), true);
        else {
          const items = await window.magic.learningList!(resource.id);
          if (mounted.current) {
            setSessions(items);
            if (items[0]) accept(items[0], true);
          }
        }
        if (mounted.current) setBackendReady(true);
      } else if (action === "start" || action === "explain") {
        const result = await window.magic.learningStart!({
          resourceId: resource.id,
          inputHash: resource.contentHash,
          operationId: crypto.randomUUID(),
          goal: goal.trim() || undefined,
          mode: action === "explain" ? "explain" : "practice",
        });
        if (!cancelled.current) accept(result, true);
      } else {
        const active = current.current;
        if (!active) return;
        const result = await window.magic.learningAct!({
          sessionId: active.session.id,
          revision: active.session.revision,
          operationId: crypto.randomUUID(),
          action,
          ...(action === "answer" ? { answer: draftValue.current } : {}),
        });
        if (!cancelled.current) accept(result, true);
      }
    } catch (cause) {
      if (mounted.current && !cancelled.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Learning could not continue. Your saved activity is still here.",
        );
      // Recover authoritative revision after a partial write, preserving unsaved text.
      if (current.current && window.magic.learningGet) {
        try {
          accept(await window.magic.learningGet(current.current.session.id));
        } catch {
          /* Existing evidence and draft remain visible. */
        }
      }
    } finally {
      if (cancelled.current && mounted.current && window.magic.learningList) {
        try {
          const items = await window.magic.learningList(resource.id);
          const restored =
            items.find(
              (item) => item.session.id === current.current?.session.id,
            ) ?? items[0];
          if (restored) accept(restored);
        } catch {
          /* Keep the last saved activity. */
        }
      }
      working.current = false;
      if (mounted.current) setPending(false);
    }
  }

  async function cancel() {
    cancelled.current = true;
    setNotice(
      "Stopping this request. Your saved activity and response stay here.",
    );
    try {
      await window.magic.cancelLearning?.();
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error ? cause.message : "Could not cancel yet.",
        );
    }
  }

  const session = view?.session;
  const activity = session?.activities.find(
    (item) => item.id === session.currentActivityId,
  );
  const events =
    session?.events.filter(
      (event) => event.activityId === activity?.id && event.kind !== "exposure",
    ) ?? [];
  const responded = events.some(
    (event) => event.kind === "answer" || event.kind === "skip",
  );
  const latestAnswerIndex = events.findLastIndex(
    (event) => event.kind === "answer",
  );
  const needsFeedback =
    latestAnswerIndex >= 0 &&
    !events
      .slice(latestAnswerIndex + 1)
      .some((event) => event.kind === "feedback");
  const sourceChanged = Boolean(
    session && session.inputHash !== resource.contentHash,
  );
  const restricted = resource.policy.mode === "restricted";
  const canAct =
    available &&
    backendReady &&
    !pending &&
    !loading &&
    view?.availability === "current" &&
    !sourceChanged &&
    !restricted;
  return (
    <section
      className="detail-section learning-panel"
      aria-labelledby={`${fieldId}-heading`}
    >
      <h3 id={`${fieldId}-heading`}>Learn this material</h3>
      <p className="small muted">
        Study prepared material for this assignment and its sources. Responses,
        saved hints and next activities use checked study items. Asking for a
        new explanation is a separate AI request.
      </p>
      {!available ? (
        <p className="evidence-note">
          Learning sessions need the desktop app. Saved course material is still
          available above.
        </p>
      ) : null}
      {loading ? (
        <p role="status" className="small muted">
          Loading saved learning…
        </p>
      ) : null}
      {restricted ? (
        <p className="evidence-note">
          This course restricts AI help on this work. Review the policy above
          with your instructor before using AI preparation.
        </p>
      ) : null}
      {sessions.length > 1 ? (
        <label className="field-label">
          Saved sessions
          <select
            value={session?.id ?? ""}
            disabled={pending || saving}
            onChange={(event) => void operate("reload", event.target.value)}
          >
            {sessions.map((item) => (
              <option key={item.session.id} value={item.session.id}>
                {item.session.goal || "Learn this material"} ·{" "}
                {timestamp(item.session.createdAt)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {view && (view.availability !== "current" || sourceChanged) ? (
        <p className="evidence-note">
          {sourceChanged
            ? "The assignment source has changed since this session began."
            : view.reason}{" "}
          This saved activity remains available to read. New practice needs
          checked items for the current permitted sources.
        </p>
      ) : null}
      {activity ? (
        <>
          <div className="learning-activity">
            <span className="badge">{formatLabels[activity.format]}</span>
            <h4>{activity.title}</h4>
            <p className="small muted">{activity.reason}</p>
            <p className="learning-content">{activity.content}</p>
            <details className="learning-evidence">
              <summary>Sources and capture details</summary>
              <p className="small muted">
                Saved excerpts, not complete course coverage. Matching
                quotations establish source provenance; generated teaching and
                feedback may still be wrong.
              </p>
              {session?.sources.map((source) => (
                <div key={source.resourceId} className="learning-source">
                  <button
                    className="subtle-button"
                    onClick={() =>
                      void window.magic
                        .openExternal(source.url)
                        .catch((cause: unknown) =>
                          setError(
                            cause instanceof Error
                              ? cause.message
                              : "Could not open source.",
                          ),
                        )
                    }
                  >
                    {source.title}
                  </button>
                  <p className="small muted">
                    Captured {timestamp(source.observedAt)} ·{" "}
                    {source.complete ? "Complete capture" : "Partial capture"} ·{" "}
                    {source.status.replaceAll("_", " ")}
                  </p>
                  {activity.citations
                    .filter(
                      (citation) => citation.resourceId === source.resourceId,
                    )
                    .map((citation, index) => (
                      <blockquote key={index}>{citation.quote}</blockquote>
                    ))}
                </div>
              ))}
              <p className="small muted">
                Prepared with {activity.model}. Source checks establish where
                quotations came from; they do not guarantee the teaching is
                correct.
              </p>
            </details>
          </div>
          {events.length ? (
            <div className="learning-history" aria-live="polite">
              {events.map((event) => (
                <div
                  key={event.id}
                  className={
                    event.kind === "failure"
                      ? "evidence-note"
                      : "learning-event"
                  }
                >
                  <strong>{eventLabels[event.kind]}</strong>
                  <p className="learning-content">{event.text}</p>
                  {event.citations?.length ? (
                    <details className="learning-evidence">
                      <summary>
                        Sources for this{" "}
                        {event.kind === "hint" ? "hint" : "feedback"}
                      </summary>
                      {event.citations.map((citation, index) => {
                        const source = session?.sources.find(
                          (item) =>
                            item.resourceId === citation.resourceId &&
                            item.contentHash === citation.contentHash,
                        );
                        return (
                          <div
                            key={`${citation.resourceId}-${index}`}
                            className="learning-source"
                          >
                            <span className="small muted">
                              {source?.title ?? "Saved source"}
                            </span>
                            <blockquote>{citation.quote}</blockquote>
                          </div>
                        );
                      })}
                    </details>
                  ) : null}
                  {event.kind === "feedback" ? (
                    <p className="small muted">
                      Saved study feedback · not a course grade. Reflections
                      without a deterministic check remain ungraded.
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          {needsFeedback ? (
            <div className="learning-retry">
              <p className="small muted">
                Your response is saved. Feedback has not finished for that
                response.
              </p>
              <button
                className="button"
                disabled={!canAct}
                onClick={() => void operate("retry_feedback")}
              >
                Retry feedback
              </button>
            </div>
          ) : null}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (canAct && !responded && draft.trim()) void operate("answer");
            }}
          >
            <label
              className="field-label learning-prompt"
              htmlFor={`${fieldId}-response`}
            >
              {activity.prompt}
            </label>
            <textarea
              id={`${fieldId}-response`}
              rows={4}
              maxLength={4000}
              value={draft}
              disabled={pending || responded}
              onChange={(event) =>
                void saveDraft(event.target.value).catch(() => undefined)
              }
              placeholder="Explain your thinking…"
            />
            <p className="small muted" role="status">
              {saving
                ? "Saving response…"
                : session?.draft === draft
                  ? "Response saved on this device."
                  : "Response has unsaved changes."}
            </p>
            <div className="inline-actions learning-actions">
              <button
                className="button primary"
                disabled={!canAct || responded || !draft.trim()}
                type="submit"
              >
                {activity.format === "practice"
                  ? "Check response"
                  : "Save reflection"}
              </button>
              <button
                className="button"
                disabled={!canAct || responded}
                type="button"
                onClick={() => void operate("hint")}
              >
                Show saved hint
              </button>
              <button
                className="button"
                disabled={!canAct || responded}
                type="button"
                onClick={() => void operate("skip")}
              >
                Skip activity
              </button>
              <button
                className="button"
                disabled={!canAct || !responded}
                type="button"
                onClick={() => void operate("next")}
              >
                Next activity
              </button>
            </div>
            <p className="small muted">
              You can leave and return to your saved session. Skipping or
              opening an activity does not mark coursework complete.
            </p>
          </form>
        </>
      ) : null}
      {!restricted ? (
        <details className="learning-start" open={!session}>
          <summary>
            {session
              ? "Start a new session or change your goal"
              : "Start with this material"}
          </summary>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (available && backendReady && !pending && !loading)
                void operate("start");
            }}
          >
            <label className="field-label" htmlFor={`${fieldId}-goal`}>
              What would help? <span className="muted">Optional</span>
            </label>
            <input
              id={`${fieldId}-goal`}
              maxLength={1000}
              value={goal}
              disabled={pending}
              onChange={(event) => setGoal(event.target.value)}
              placeholder="For example, help me understand the main idea"
            />
            <button
              className="button primary"
              type="submit"
              disabled={!available || !backendReady || pending || loading}
            >
              {session ? "Start new practice" : "Start practice"}
            </button>
            <button
              className="button"
              type="button"
              disabled={!available || !backendReady || pending || loading}
              onClick={() => void operate("explain")}
            >
              Explain this material
            </button>
            <p className="small muted">
              Practice uses prepared study items. Explain requests a new
              explanation through your configured AI, using the current sources
              and goal.
            </p>
          </form>
        </details>
      ) : null}
      <div className="inline-actions learning-actions">
        {pending ? (
          <button className="button small-button" onClick={() => void cancel()}>
            Cancel
          </button>
        ) : null}
        {error && available ? (
          <button
            className="button small-button"
            disabled={pending}
            onClick={() => {
              void saveDraft(draftValue.current)
                .then(() => operate("reload", current.current?.session.id))
                .catch(() => undefined);
            }}
          >
            Retry loading saved learning
          </button>
        ) : null}
      </div>
      {pending ? (
        <p className="small muted" role="status">
          Working… Your saved material stays available.
        </p>
      ) : null}
      {notice ? (
        <p className="small muted" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="attention-text" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
