// owner: ui-wiring. Shared bits for the preview views: the Preview label, honest state lines and dates.
import type { ReactNode } from "react";
import type { Load } from "./bridge";

export function PreviewLabel() {
  return (
    <span className="badge" title="Wiring preview: calls the real backend; the designed screen replaces it.">
      Preview
    </span>
  );
}

/** A section of one preview: its heading, the backend op it calls, and its body. */
export function PreviewSection({ title, op, children, actions }: { title: string; op: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="settings-section backend-section" aria-label={title}>
      <div className="backend-section-head">
        <h2>
          {title} <PreviewLabel />
        </h2>
        {actions ? <div className="inline-actions">{actions}</div> : null}
      </div>
      <p className="small muted backend-op">Backend: {op}</p>
      {children}
    </section>
  );
}

/** Loading and error are distinct; `ready` renders the body. */
export function Loaded<T>({ load, retry, children }: { load: Load<T>; retry?: () => void; children: (value: T) => ReactNode }) {
  if (load.state === "loading")
    return (
      <p className="small muted" role="status">
        Loading…
      </p>
    );
  if (load.state === "error")
    return (
      <div className="backend-error" role="alert">
        <p className="small attention-text">Could not load: {load.message}</p>
        {retry ? (
          <button className="button small-button" onClick={retry}>
            Try again
          </button>
        ) : null}
      </div>
    );
  return <>{children(load.value)}</>;
}

/** An empty result: says what is missing, never a placeholder row. */
export function Empty({ children }: { children: ReactNode }) {
  return <p className="small muted backend-empty">{children}</p>;
}

/** A partial or conditional answer from the backend (stale, unavailable, not built, needs consent). */
export function Partial({ status, children }: { status: string; children: ReactNode }) {
  return (
    <div className="evidence-note backend-partial">
      <span className="badge">{status.replaceAll("_", " ")}</span> {children}
    </div>
  );
}

export function ErrorLine({ text }: { text: string }) {
  return text ? (
    <p className="small attention-text" role="alert">
      {text}
    </p>
  ) : null;
}

export function formatWhen(value: string | null | undefined, withTime = true): string {
  if (!value) return "No date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat(
    undefined,
    withTime ? { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" } : { weekday: "short", month: "short", day: "numeric" },
  ).format(date);
}

/** Evidence-defined topic states under their student-facing names; never a number. */
export const topicStateLabel: Record<string, string> = {
  solid: "Mastered",
  getting_there: "Getting there",
  iffy: "Iffy",
  not_seen: "Not seen yet",
};
