import { useEffect, useId, useRef, useState } from "react";
import type {
  LearningRequest,
  ResourceView,
  StudySessionView,
} from "@magic/contracts";

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
function timestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Capture time unknown"
    : date.toLocaleString();
}
async function study(request: LearningRequest) {
  const response = await window.magic.execute({ type: "learning", request, reply: "result" });
  const result = response.learning;
  if (!result || result.status !== "ok")
    throw new Error(
      result?.message ||
        "Learning could not continue. Your saved coursework is still available.",
    );
  return result;
}
async function readSessions(resourceId: string): Promise<StudySessionView[]> {
  const result = await study({ op: "study.sessions", resourceId });
  if (
    !result.data ||
    typeof result.data !== "object" ||
    !("sessions" in result.data) ||
    !Array.isArray(result.data.sessions) ||
    !result.data.sessions.every(isSession)
  )
    throw new Error("Saved study sessions could not be read.");
  return [...result.data.sessions].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
}
async function sessionRequest(
  request: LearningRequest,
): Promise<StudySessionView> {
  const result = await study(request);
  if (
    !result.data ||
    typeof result.data !== "object" ||
    !("session" in result.data) ||
    !isSession(result.data.session)
  )
    throw new Error("The study session could not be read.");
  return result.data.session;
}
function isSession(value: unknown): value is StudySessionView {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<StudySessionView>;
  return (
    typeof session.id === "string" &&
    typeof session.resourceId === "string" &&
    typeof session.accountScope === "string" &&
    typeof session.revision === "number" &&
    typeof session.draft === "string" &&
    Array.isArray(session.events) &&
    Array.isArray(session.sources)
  );
}

export function LearningPanel({
  resource,
  accountScope,
}: {
  resource: ResourceView;
  accountScope?: string;
}) {
  const fieldId = useId();
  const [view, setView] = useState<StudySessionView | null>(null);
  const [sessions, setSessions] = useState<StudySessionView[]>([]);
  const [goal, setGoal] = useState("");
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [backendReady, setBackendReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const current = useRef<StudySessionView | null>(null);
  const draftValue = useRef("");
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(false);
  const working = useRef(false);
  const openedAt = useRef(Date.now());

  function matches(result: StudySessionView) {
    return (
      result.resourceId === resource.id &&
      (!accountScope || result.accountScope === accountScope)
    );
  }
  function accept(result: StudySessionView, restoreDraft = false) {
    if (!matches(result)) return;
    if (
      current.current?.currentItem?.id !== result.currentItem?.id ||
      current.current?.id !== result.id
    )
      openedAt.current = Date.now();
    current.current = result;
    if (!mounted.current) return;
    setView(result);
    setSessions((previous) => [
      result,
      ...previous.filter((item) => item.id !== result.id),
    ]);
    if (restoreDraft) {
      draftValue.current = result.draft;
      setDraft(result.draft);
    }
  }
  useEffect(() => {
    mounted.current = true;
    void readSessions(resource.id)
      .then((items) => {
        if (!mounted.current) return;
        const matching = items.filter(matches);
        setBackendReady(true);
        setSessions(matching);
        if (matching[0]) accept(matching[0], true);
      })
      .catch((cause: unknown) => {
        if (mounted.current)
          setError(
            cause instanceof Error
              ? cause.message
              : "Saved study could not be loaded.",
          );
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
    return () => {
      mounted.current = false;
    };
  }, [resource.id, accountScope]);

  // Serialize durable writes, coalescing typing before the next operation takes its revision.
  function saveDraft(value: string): Promise<void> {
    draftValue.current = value;
    setDraft(value);
    setSaving(true);
    const operation = saveQueue.current
      .catch(() => undefined)
      .then(async () => {
        const active = current.current;
        if (!active || active.draft === draftValue.current) return;
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
    action:
      | "start"
      | "explain"
      | "reload"
      | "answer"
      | "hint"
      | "saved_explanation"
      | "skip"
      | "next",
    sessionId?: string,
  ) {
    if (working.current) return;
    working.current = true;
    setPending(true);
    setError("");
    try {
      await saveQueue.current;
      if (!mounted.current) return;
      if (action === "reload") {
        if (sessionId)
          accept(await sessionRequest({ op: "study.resume", sessionId }), true);
        else {
          const items = (await readSessions(resource.id)).filter(matches);
          if (mounted.current) {
            setSessions(items);
            if (items[0]) accept(items[0], true);
          }
        }
        if (mounted.current) setBackendReady(true);
      } else if (action === "start") {
        accept(
          await sessionRequest({
            op: "study.plan",
            courseId: resource.courseId,
            resourceId: resource.id,
            inputHash: resource.contentHash,
            operationId: crypto.randomUUID(),
            goal: goal.trim() || undefined,
            minutes: 15,
            difficulty: "normal",
          }),
          true,
        );
      } else if (action === "explain") {
        // The canonical router reports unavailable until the explanation pack and consent path exist.
        await study({
          op: "notebook.ask",
          courseId: resource.courseId,
          question: goal.trim() || `Help me understand ${resource.title}.`,
          scope: { resourceIds: [resource.id] },
        });
      } else {
        const active = current.current;
        const item = active?.currentItem;
        if (!active || !item) return;
        const common = {
          sessionId: active.id,
          revision: active.revision,
          operationId: crypto.randomUUID(),
        };
        let request: LearningRequest;
        if (action === "answer") {
          const response =
            item.kind === "mc" || item.kind === "tf"
              ? { kind: "choice" as const, optionId: draftValue.current }
              : item.kind === "numeric"
                ? {
                    kind: "number" as const,
                    value: Number(draftValue.current),
                    ...(item.unit ? { unit: item.unit } : {}),
                  }
                : { kind: "text" as const, text: draftValue.current };
          request = {
            op: "study.answer",
            ...common,
            itemId: item.id,
            itemVersion: item.version,
            response,
            confidence: null,
            responseMs: Math.min(
              86_400_000,
              Math.max(0, Date.now() - openedAt.current),
            ),
          };
        } else if (action === "hint" || action === "saved_explanation") {
          request = {
            op: "study.hint",
            ...common,
            itemId: item.id,
            level: action === "hint" ? "hint" : "explain",
          };
        } else request = { op: "study.advance", ...common, action };
        accept(await sessionRequest(request), true);
      }
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Learning could not continue. Your saved work is still here.",
        );
      // A write may have succeeded before transport failed. Recover revision without discarding local text.
      if (current.current) {
        try {
          accept(
            await sessionRequest({
              op: "study.session",
              sessionId: current.current.id,
            }),
          );
        } catch {
          /* Keep the saved activity and draft visible. */
        }
      }
    } finally {
      working.current = false;
      if (mounted.current) setPending(false);
    }
  }

  const item = view?.currentItem;
  const events =
    view?.events.filter(
      (event) =>
        event.itemId === item?.id && event.itemVersion === item?.version,
    ) ?? [];
  const sourceChanged = Boolean(
    view && view.inputHash !== resource.contentHash,
  );
  const restricted = resource.policy.mode === "restricted";
  const canAct =
    backendReady &&
    !pending &&
    !loading &&
    view?.availability === "current" &&
    !sourceChanged &&
    !restricted;
  const validResponse =
    Boolean(draft.trim()) &&
    (item?.kind !== "numeric" || Number.isFinite(Number(draft)));
  return (
    <section
      className="detail-section learning-panel"
      aria-labelledby={`${fieldId}-heading`}
    >
      <h3 id={`${fieldId}-heading`}>Learn this material</h3>
      <p className="small muted">
        Practice with saved study items. Checking a response and showing saved
        help do not make a new AI request.
      </p>
      {loading ? (
        <p role="status" className="small muted">
          Loading saved learning…
        </p>
      ) : null}
      {restricted ? (
        <p className="evidence-note">
          This course restricts AI help on this work. Review the course policy
          before using AI preparation.
        </p>
      ) : null}
      {sessions.length > 1 ? (
        <label className="field-label">
          Saved sessions
          <select
            value={view?.id ?? ""}
            disabled={pending || saving}
            onChange={(event) => void operate("reload", event.target.value)}
          >
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.goal || "Practice"} · {timestamp(session.startedAt)}
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
          Your saved session remains available to read. New practice needs
          checked items for current permitted sources.
        </p>
      ) : null}
      {item ? (
        <>
          <div className="learning-activity">
            <span className="badge">Practice</span>
            <h4>{item.stem}</h4>
            <p className="small muted">
              {item.checks.some(
                (check) => check.check === "quote" && check.outcome === "pass",
              )
                ? "Source quote checked. "
                : ""}
              {item.checks.some(
                (check) =>
                  check.check === "support" && check.outcome === "pass",
              )
                ? "Answer support was checked; it can still be wrong."
                : "Answer support has not been independently checked."}
            </p>
            <details className="learning-evidence">
              <summary>Sources and capture details</summary>
              <p className="small muted">
                Saved excerpts, not complete course coverage. Matching
                quotations establish provenance; they do not guarantee the
                teaching is correct.
              </p>
              {view?.sources.map((source) => (
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
                    Captured {timestamp(source.observedAt)}
                  </p>
                  {item.citations
                    .filter(
                      (citation) =>
                        citation.resourceId === source.resourceId &&
                        citation.contentHash === source.contentHash,
                    )
                    .map((citation, index) => (
                      <blockquote key={index}>{citation.quote}</blockquote>
                    ))}
                </div>
              ))}
            </details>
          </div>
          {events.length ? (
            <div className="learning-history" aria-live="polite">
              {events.map((event) => (
                <div key={event.id} className="learning-event">
                  <strong>{eventLabels[event.kind]}</strong>
                  <p className="learning-content">{event.text}</p>
                  {event.outcome ? <p>{outcomeLabels[event.outcome]}</p> : null}
                  {event.checks?.length ? (
                    <p className="small muted">{event.checks.join(" · ")}</p>
                  ) : null}
                  {event.kind === "answer" ? (
                    <p className="small muted">
                      Study feedback, not a course grade.
                      {event.outcome === "undecided"
                        ? " This response needs review; the check could not decide."
                        : ""}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (canAct && !view?.answered && validResponse)
                void operate("answer");
            }}
          >
            {view?.answered ? (
              <div className="inline-actions learning-actions">
                <button
                  className="button primary"
                  type="button"
                  disabled={!canAct}
                  onClick={() => void operate("next")}
                >
                  Next activity
                </button>
              </div>
            ) : (
              <>
                <label
                  className="field-label learning-prompt"
                  htmlFor={`${fieldId}-response`}
                >
                  Your response
                  {item.kind === "numeric" && item.unit
                    ? ` (${item.unit})`
                    : ""}
                </label>
                {item.kind === "mc" || item.kind === "tf" ? (
                  <select
                    id={`${fieldId}-response`}
                    value={draft}
                    disabled={pending || view?.answered}
                    onChange={(event) =>
                      void saveDraft(event.target.value).catch(() => undefined)
                    }
                  >
                    <option value="">Choose an answer</option>
                    {item.options?.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.text}
                      </option>
                    ))}
                  </select>
                ) : item.kind === "numeric" ? (
                  <input
                    id={`${fieldId}-response`}
                    type="number"
                    step="any"
                    value={draft}
                    disabled={pending || view?.answered}
                    onChange={(event) =>
                      void saveDraft(event.target.value).catch(() => undefined)
                    }
                  />
                ) : (
                  <textarea
                    id={`${fieldId}-response`}
                    rows={4}
                    maxLength={2000}
                    value={draft}
                    disabled={pending || view?.answered}
                    onChange={(event) =>
                      void saveDraft(event.target.value).catch(() => undefined)
                    }
                    placeholder="Explain your thinking…"
                  />
                )}
                <p className="small muted" role="status">
                  {saving
                    ? "Saving response…"
                    : view?.draft === draft
                      ? "Response saved on this device."
                      : "Response has unsaved changes."}
                </p>
                <div className="inline-actions learning-actions">
                  <button
                    className="button primary"
                    type="submit"
                    disabled={!canAct || view?.answered || !validResponse}
                  >
                    Check response
                  </button>
                  <button
                    className="button"
                    type="button"
                    disabled={!canAct || view?.answered}
                    onClick={() => void operate("saved_explanation")}
                  >
                    Show saved explanation
                  </button>
                  <button
                    className="button"
                    type="button"
                    disabled={!canAct || view?.answered}
                    onClick={() => void operate("skip")}
                  >
                    Skip activity
                  </button>
                </div>
              </>
            )}
            <p className="small muted">
              Leave and return to your saved session. Skipping or opening an
              activity does not mark coursework complete.
            </p>
          </form>
        </>
      ) : view?.status === "complete" ? (
        <p className="evidence-note">
          You have reached the end of this practice session. Your responses are
          saved; this does not mark coursework complete.
        </p>
      ) : null}
      {view && !item ? (
        <div className="learning-history">
          {view.events.map((event) => (
            <div className="learning-event" key={event.id}>
              <strong>{eventLabels[event.kind]}</strong>
              <p className="learning-content">{event.text}</p>
              {event.outcome ? <p>{outcomeLabels[event.outcome]}</p> : null}
            </div>
          ))}
          {view.status !== "complete" || draft ? (
            <>
              <label
                className="field-label"
                htmlFor={`${fieldId}-saved-response`}
              >
                Saved response
              </label>
              <textarea
                id={`${fieldId}-saved-response`}
                rows={4}
                maxLength={2000}
                value={draft}
                disabled={pending}
                onChange={(event) =>
                  void saveDraft(event.target.value).catch(() => undefined)
                }
              />
              <p className="small muted" role="status">
                {saving
                  ? "Saving response…"
                  : view.draft === draft
                    ? "Response saved on this device."
                    : "Response has unsaved changes."}
              </p>
            </>
          ) : null}
        </div>
      ) : null}
      {!restricted ? (
        <details className="learning-start" open={!view}>
          <summary>
            {view
              ? "Start a new session or change your goal"
              : "Start with this material"}
          </summary>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (backendReady && !pending && !loading) void operate("start");
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
            <div className="inline-actions learning-actions">
              <button
                className="button primary"
                type="submit"
                disabled={!backendReady || pending || loading}
              >
                {view ? "Start new practice" : "Start practice"}
              </button>
              <button
                className="button"
                type="button"
                disabled={!backendReady || pending || loading}
                onClick={() => void operate("explain")}
              >
                Explain this material
              </button>
            </div>
            <p className="small muted">
              Practice plans about 15 minutes from available checked items. New
              AI explanations are not connected in this build; saved
              explanations remain available with practice.
            </p>
          </form>
        </details>
      ) : null}
      {error ? (
        <>
          <p className="attention-text" role="alert">
            {error}
          </p>
          <button
            className="button small-button"
            disabled={pending}
            onClick={() =>
              void saveDraft(draftValue.current)
                .then(() => operate("reload", current.current?.id))
                .catch(() => undefined)
            }
          >
            Retry loading saved learning
          </button>
        </>
      ) : null}
      {pending ? (
        <p className="small muted" role="status">
          Working… Your saved material stays available.
        </p>
      ) : null}
    </section>
  );
}
