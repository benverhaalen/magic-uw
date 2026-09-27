import { useEffect, useRef, useState } from "react";
import type {
  ResourceView,
  WorkLaunchReceipt,
  WorkSet,
} from "@magic/contracts";

const via = {
  browser: "Opened in your browser",
  file: "Opened the saved copy",
  browser_fallback: "Opened the original online",
} as const;

/**
 * One-click prepared work for an assignment. The destinations are shown before
 * activation; afterwards each one reports what happened, and only failures retry.
 */
export function StartWork({
  resource,
  refreshKey,
}: {
  resource: ResourceView;
  /** Changes when links or the assignment change, so the prepared list is rebuilt. */
  refreshKey: string;
}) {
  const [set, setSet] = useState<WorkSet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [launchReceipt, setReceipt] = useState<WorkLaunchReceipt | null>(null);
  const launchingRef = useRef(false);
  const available = !!window.magic.startWork;

  useEffect(() => {
    let current = true;
    setReceipt(null);
    setError(null);
    window.magic
      .execute({ type: "work-set", id: resource.id })
      .then((result) => current && setSet(result.workSet ?? null))
      .catch(
        (cause) =>
          current &&
          setError(
            cause instanceof Error ? cause.message : "Could not prepare this work.",
          ),
      );
    return () => {
      current = false;
    };
  }, [resource.id, refreshKey]);

  const launch = async (only?: string[]) => {
    if (launchingRef.current || !window.magic.startWork) return;
    launchingRef.current = true;
    setLaunching(true);
    setError(null);
    try {
      const next = await window.magic.startWork(resource.id, only);
      setReceipt((previous) =>
        only && previous
          ? {
              ...next,
              opened: [...previous.opened, ...next.opened],
              notes: [...previous.notes, ...next.notes],
            }
          : next,
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Nothing could be opened. Try again.",
      );
    } finally {
      launchingRef.current = false;
      setLaunching(false);
    }
  };

  if (!set)
    return error ? (
      <section className="detail-section start-work">
        <h3>Start work</h3>
        <p className="small attention-text">{error}</p>
      </section>
    ) : null;

  const count = set.items.length;
  // A launch that resolves after switching assignments must not report here.
  const receipt =
    launchReceipt?.assignmentId === resource.id ? launchReceipt : null;
  return (
    <section className="detail-section start-work" aria-labelledby="start-work-heading">
      <h3 id="start-work-heading">Start work</h3>
      <ol className="work-destinations" aria-label="What Start work opens">
        {set.items.map((item) => (
          <li key={item.resourceId}>
            <span className="work-title">{item.title}</span>
            <span className="small muted">
              {item.role === "instructions"
                ? "Assignment page · opens in front"
                : item.target.kind === "file"
                  ? "Saved copy on this device"
                  : "Course page in your browser"}
            </span>
          </li>
        ))}
      </ol>
      {set.notes.map((note) => (
        <p key={note} className="small muted">
          {note}
        </p>
      ))}
      {set.held.length ? (
        <details className="work-held">
          <summary className="small">
            {set.held.length} related {set.held.length === 1 ? "item" : "items"} not opened
          </summary>
          <ul>
            {set.held.map((held) => (
              <li key={held.resourceId} className="small">
                <strong>{held.title}</strong> · {held.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <button
        className="button primary start-work-button"
        // aria-disabled keeps keyboard focus on the button while opening; the ref blocks repeats.
        disabled={!available}
        aria-disabled={launching}
        onClick={() => void launch()}
      >
        {launching
          ? "Opening…"
          : `Start work · open ${count} ${count === 1 ? "item" : "items"}`}
      </button>
      <p className="small muted">
        Opens in your browser and apps. Canvas may record that you viewed a page.
        Opening does not mark anything done.
      </p>
      <div role="status" aria-live="polite" className="work-receipt">
        {receipt ? (
          <>
            <p className="small">
              {receipt.mode === "dry_run"
                ? `Verification mode: nothing opened. Would open ${receipt.opened.length}.`
                : receipt.failed.length
                  ? `Opened ${receipt.opened.length} of ${receipt.opened.length + receipt.failed.length}.`
                  : `Opened ${receipt.opened.length}. Return here any time.`}
            </p>
            <ul>
              {receipt.opened.map((item) => (
                <li key={`ok:${item.resourceId}`} className="small">
                  ✓ {item.title} · {receipt.mode === "dry_run" ? "not opened" : via[item.via]}
                </li>
              ))}
              {receipt.failed.map((item) => (
                <li key={`fail:${item.resourceId}`} className="small attention-text">
                  ✕ {item.title} · {item.reason}
                </li>
              ))}
            </ul>
            {receipt.notes
              .filter((note) => !set.notes.includes(note))
              .map((note) => (
                <p key={note} className="small muted">
                  {note}
                </p>
              ))}
            {receipt.failed.length ? (
              <button
                className="button small-button"
                aria-disabled={launching}
                onClick={() => void launch(receipt.failed.map((f) => f.resourceId))}
              >
                Retry {receipt.failed.length === 1 ? "the failed item" : "failed items"}
              </button>
            ) : null}
          </>
        ) : null}
        {error ? <p className="small attention-text">{error}</p> : null}
      </div>
    </section>
  );
}
