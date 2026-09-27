import { useEffect, useRef, useState } from "react";
import {
  localContextPayload,
  type LocalAnswer,
  type LocalStatus,
  type ResourceView,
} from "@magic/contracts";

export function LocalAiPanel({
  resource,
  privacyKey,
}: {
  resource?: ResourceView;
  privacyKey: string;
}) {
  const [status, setStatus] = useState<LocalStatus | null>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<LocalAnswer | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const version = useRef(0),
    running = useRef(false);
  const evidenceKey = `${resource?.id ?? ""}:${resource?.contentHash ?? ""}:${privacyKey}`;
  // Clear completed and late responses when the selected evidence or privacy changes.
  useEffect(() => {
    version.current++;
    setAnswer(null);
    setError("");
    setPending(false);
    return () => {
      version.current++;
      if (running.current)
        void window.magic.cancelLocal?.().catch(() => undefined);
      running.current = false;
    };
  }, [evidenceKey]);
  async function run<T>(
    operation: () => Promise<T>,
    accept: (result: T) => void,
  ) {
    if (running.current) return;
    const current = ++version.current;
    running.current = true;
    setPending(true);
    setError("");
    setAnswer(null);
    try {
      const result = await operation();
      if (version.current === current) accept(result);
    } catch (cause) {
      if (version.current === current)
        setError(
          cause instanceof Error ? cause.message : "Local AI is unavailable.",
        );
    } finally {
      if (version.current === current) {
        running.current = false;
        setPending(false);
      }
    }
  }
  function cancel() {
    version.current++;
    running.current = false;
    setPending(false);
    void window.magic.cancelLocal?.().catch(() => undefined);
  }
  const context = resource
    ? localContextPayload({
        course: resource.courseName,
        title: resource.title,
        text: resource.text,
        policy: resource.policy.evidence,
      })
    : null;
  return (
    <section
      className={resource ? "detail-section" : "settings-section"}
      aria-label="Local AI"
    >
      <h2>{resource ? "Ask locally" : "Local model"}</h2>
      <p className="small muted">
        Your question and the selected course excerpt go to Ollama on this
        device, with its cloud features disabled. Nothing is downloaded
        automatically.
      </p>
      <div className="inline-actions">
        <button
          className="button"
          disabled={pending || !window.magic.localStatus}
          onClick={() => void run(() => window.magic.localStatus!(), setStatus)}
        >
          Check local setup
        </button>
        {pending ? (
          <button className="button" onClick={cancel}>
            Cancel
          </button>
        ) : null}
      </div>
      {pending ? (
        <p className="small muted" role="status">
          Working locally…
        </p>
      ) : null}
      {status ? (
        <div className="evidence-note">
          <strong>
            {status.status === "ready"
              ? `Ready · ${status.selectedModel}`
              : "Setup needed"}
          </strong>
          <p>{status.reason}</p>
          <details>
            <summary>How the model is chosen</summary>
            <p className="small">{status.basis}</p>
          </details>
        </div>
      ) : null}
      {!resource ? (
        <p className="small muted">
          Install Ollama and llmfit yourself, then start Ollama with cloud
          disabled and install a model whose exact tag and quantization fit the
          hardware recommendation. Open a course item to ask a question. Model
          licenses apply separately.
        </p>
      ) : null}
      {resource && context ? (
        <>
          <details className="manifest">
            <summary>Exact local context</summary>
            <p className="small muted">
              This excerpt, the policy mode ({resource.policy.mode}), your
              question, and coaching instructions form the local request. Longer
              sources are excerpted; an answer cannot claim to have read the
              rest.
            </p>
            <pre>{JSON.stringify(context, null, 2)}</pre>
          </details>
          {resource.policy.mode === "restricted" ? (
            <p className="evidence-note">
              This course restricts AI help on this work. Review the policy
              evidence above and ask your instructor which preparation is
              permitted.
            </p>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!question.trim() || !window.magic.localAsk) return;
                void run(
                  () =>
                    window.magic.localAsk!({
                      id: resource.id,
                      inputHash: resource.contentHash,
                      question,
                    }),
                  (result) => {
                    if (
                      result.resourceId === resource.id &&
                      result.inputHash === resource.contentHash
                    )
                      setAnswer(result);
                  },
                );
              }}
            >
              <label className="field-label" htmlFor="local-question">
                One question about this item
              </label>
              <textarea
                id="local-question"
                rows={3}
                maxLength={2000}
                value={question}
                disabled={pending}
                onChange={(event) => setQuestion(event.target.value)}
                style={{
                  width: "100%",
                  resize: "vertical",
                  font: "inherit",
                  padding: 10,
                  marginBottom: 10,
                  border: "1px solid var(--magic-line-field)",
                  borderRadius: 6,
                }}
              />
              <button
                className="button"
                disabled={pending || !question.trim() || !window.magic.localAsk}
                type="submit"
              >
                Ask locally
              </button>
            </form>
          )}
          {answer ? (
            <div className="local-answer" role="status">
              <p className="source-text">{answer.text}</p>
              <p className="small muted">
                {answer.model ?? "Course policy"} · Based on the saved excerpt
                of {answer.sourceTitle}. This is coaching, not a verified answer
                key.
              </p>
            </div>
          ) : null}
        </>
      ) : null}
      {error ? (
        <p className="attention-text" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
