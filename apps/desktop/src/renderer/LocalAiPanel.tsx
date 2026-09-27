import { useEffect, useRef, useState } from "react";
import type { LocalStatus } from "@magic/contracts";

/**
 * The Ollama setup helper, shown under "Your AI" when "On this computer (Ollama)" is chosen. Questions
 * about an item go through chat like every other AI (the chat store's local path), not a panel per item.
 * The check runs only when the student presses it; nothing is downloaded or installed.
 */
export function LocalAiPanel({ privacyKey }: { privacyKey: string }) {
  const [status, setStatus] = useState<LocalStatus | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const version = useRef(0);
  // A new privacy setting makes an earlier check stale.
  useEffect(() => {
    version.current++;
    setStatus(null);
    setError("");
    setPending(false);
  }, [privacyKey]);
  async function check() {
    if (!window.magic.localStatus || pending) return;
    const current = ++version.current;
    setPending(true);
    setError("");
    try {
      const result = await window.magic.localStatus();
      if (version.current === current) setStatus(result);
    } catch (cause) {
      if (version.current === current) setError(cause instanceof Error ? cause.message : "Local AI is unavailable.");
    } finally {
      if (version.current === current) setPending(false);
    }
  }
  function cancel() {
    version.current++;
    setPending(false);
    void window.magic.cancelLocal?.().catch(() => undefined);
  }
  return (
    <div className="local-ai-panel" aria-label="Ollama setup" role="group">
      <p className="small muted">
        Your question and the selected course excerpt go to Ollama on this device, with its cloud features
        disabled. Nothing is downloaded automatically.
      </p>
      <div className="inline-actions">
        <button className="button" disabled={pending || !window.magic.localStatus} onClick={() => void check()}>
          Check local setup
        </button>
        {pending ? <button className="button" onClick={cancel}>Cancel</button> : null}
      </div>
      {pending ? <p className="small muted" role="status">Checking…</p> : null}
      {status ? (
        <div className="evidence-note">
          <strong>{status.status === "ready" ? `Ready · ${status.selectedModel}` : "Setup needed"}</strong>
          <p>{status.reason}</p>
          <details>
            <summary>How the model is chosen</summary>
            <p className="small">{status.basis}</p>
          </details>
        </div>
      ) : null}
      <p className="small muted">
        Install Ollama and llmfit yourself, then start Ollama with cloud disabled and install a model whose exact
        tag and quantization fit the hardware recommendation. Model licenses apply separately.
      </p>
      {error ? <p className="attention-text" role="alert">{error}</p> : null}
    </div>
  );
}
