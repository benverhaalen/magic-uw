import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Command,
  CommandResult,
  ContextManifest,
  PrivacyPreferences,
  ResourceView,
  Snapshot,
  SourceHealth,
} from "@magic/contracts";
import { MyUw, PlanningAlerts } from "./MyUw";
import { LocalAiPanel } from "./LocalAiPanel";
import { LearningPanel } from "./LearningPanel";
import { ProviderGuidance } from "./ProviderGuidance";
import { IngestionControls, McpConnections } from "./IngestionControls";

type View = "today" | "courses" | "myuw" | "sources" | "privacy";
type Recipient = ContextManifest["recipient"];
type Run = (
  command: Command,
  message?: string,
) => Promise<CommandResult | undefined>;
const recipientLabels: Record<Recipient, string> = {
  local: "Local model",
  jev: "Jev · TypeSafe",
  chatgpt: "ChatGPT",
  claude: "Claude",
  gemini: "Gemini",
};
const statusLabels: Record<SourceHealth["status"], string> = {
  ok: "Checked",
  partial: "Partial capture",
  needs_sign_in: "Sign in needed",
  error: "Could not refresh",
  inaccessible: "Access restricted",
  not_published: "Not published",
  needs_attention: "Needs review",
};

function formatDate(value: string | null, full = false): string {
  if (!value) return "Not checked";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat(
    undefined,
    full
      ? {
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
          timeZoneName: "short",
        }
      : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
  ).format(date);
}

function Icon({
  name,
}: {
  name: "today" | "courses" | "myuw" | "sources" | "privacy" | "search" | "arrow" | "file" | "check";
}) {
  if (name === "myuw") return <img className="uw-nav-mark" src={new URL("./assets/uw-crest.svg", import.meta.url).href} alt="" aria-hidden="true" />;
  const paths = {
    courses: <><path d="M3 4h6v13H3zM11 4h6v13h-6zM5 7h2m6 0h2" /></>,
    myuw: <><path d="m2 7 8-4 8 4-8 4-8-4Zm3 3v5c3 3 7 3 10 0v-5M18 7v8" /></>,
    today: (
      <>
        <rect x="3" y="5" width="14" height="12" rx="2" />
        <path d="M6 3v4m8-4v4M3 9h14M7 12h3m-3 3h5" />
      </>
    ),
    sources: (
      <>
        <path d="m10 2 7 4-7 4-7-4 7-4Zm-7 8 7 4 7-4m-14 4 7 4 7-4" />
      </>
    ),
    privacy: (
      <>
        <path d="M10 2 3 5v5c0 4 7 8 7 8s7-4 7-8V5l-7-3Z" />
        <path d="m7 10 2 2 4-4" />
      </>
    ),
    search: (
      <>
        <circle cx="8.5" cy="8.5" r="5.5" />
        <path d="m13 13 4 4" />
      </>
    ),
    arrow: (
      <>
        <path d="M5 15 15 5M5 5h10v10" />
      </>
    ),
    file: (
      <>
        <path d="M5 2h6l4 4v12H5V2Zm6 0v5h4M8 11h4m-4 3h4" />
      </>
    ),
    check: <path d="m4 10 4 4 8-8" />,
  };
  return (
    <svg
      viewBox="0 0 20 20"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

export function App() {
  const [view, setView] = useState<View>("today");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const requestVersion = useRef(0);
  const busyRef = useRef(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    try {
      if (!window.magic)
        throw new Error(
          "The desktop connection is unavailable. Open Magic Canvas from the desktop app.",
        );
      const result = await window.magic.execute({ type: "snapshot" });
      if (mounted.current && version === requestVersion.current)
        setSnapshot(result.snapshot);
    } catch (cause) {
      if (mounted.current && version === requestVersion.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not read local data. Try again.",
        );
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 2000);
    return () => {
      mounted.current = false;
      requestVersion.current++;
      window.clearInterval(timer);
    };
  }, [refresh]);

  const perform = useCallback(
    async (
      operation: () => Promise<CommandResult | null | void>,
      message?: string,
    ): Promise<CommandResult | undefined> => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setError("");
      setNotice("");
      requestVersion.current++;
      try {
        const result = await operation();
        if (!mounted.current) return;
        if (result) {
          requestVersion.current++;
          setSnapshot(result.snapshot);
        }
        if (result?.message || message)
          setNotice(result?.message || message || "");
        return result || undefined;
      } catch (cause) {
        if (mounted.current)
          setError(
            cause instanceof Error
              ? cause.message
              : "The action could not finish. Try again.",
          );
        return undefined;
      } finally {
        busyRef.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [],
  );

  const run: Run = useCallback(
    (command, message) => perform(() => window.magic.execute(command), message),
    [perform],
  );
  const importFile = () => perform(() => window.magic.importFile());
  const signIn = async () => {
    if (!window.magic.signInUW) return;
    await perform(async () => {
      await window.magic.signInUW!();
      return window.magic.syncCanvas ? window.magic.syncCanvas() : undefined;
    });
    await refresh();
  };
  const sync = () =>
    window.magic.syncCanvas
      ? perform(() => window.magic.syncCanvas!())
      : undefined;
  const signOut = () =>
    window.magic.signOutUW
      ? perform(
          () => window.magic.signOutUW!(),
          "UW browser session cleared. Saved course records are still on this device.",
        )
      : undefined;
  const open = (url: string) => {
    void perform(() => window.magic.openExternal(url));
  };
  const resources =
    snapshot?.resources.filter((resource) => {
      if (resource.deleted) return false;
      const source = snapshot.sources.find((s) => s.id === resource.sourceId);
      const override = snapshot.courseOverrides?.find(
        (o) =>
          o.accountScope === source?.accountScope &&
          o.courseId === resource.courseId,
      );
      const course = snapshot.resources.find(
        (r) =>
          r.kind === "course" &&
          r.course &&
          r.courseId === resource.courseId &&
          snapshot.sources.find((s) => s.id === r.sourceId)?.scope ===
            "course" &&
          snapshot.sources.find((s) => s.id === r.sourceId)?.accountScope ===
            source?.accountScope,
      );
      if (
        course?.course?.accessRestricted ||
        (course?.course?.accessState && course.course.accessState !== "open")
      )
        return false;
      if (
        course?.course?.selection?.reasons.some((reason) =>
          /absent|no longer|not returned/i.test(reason),
        )
      )
        return false;
      const term = snapshot.ingestionSettings?.selectedTerm;
      if (
        term &&
        course?.course &&
        term !== course.course.termName &&
        term !== course.course.termId
      )
        return false;
      if (override?.included != null) return override.included;
      return course?.course?.selection?.included ?? true;
    }) ?? [];
  const accountBySource = new Map(snapshot?.sources.map((source) => [source.id, source.accountScope]));
  const courses = [...new Map(resources.map((resource) => [
    `${accountBySource.get(resource.sourceId) ?? resource.sourceId}:${resource.courseId}`, resource,
  ])).values()];
  const selected =
    resources.find((resource) => resource.id === selectedId) ?? null;
  const openItems = resources.filter(
    (resource) =>
      resource.kind === "assignment" &&
      !resource.completed &&
      resource.submitted !== true,
  ).length;
  const unavailableSources =
    snapshot?.sources.filter(
      (source) => source.status !== "ok" || !source.complete,
    ) ?? [];
  const needsSignIn = unavailableSources.some(
    (source) => source.status === "needs_sign_in",
  );
  const oldestCapture = resources.reduce<string | null>(
    (oldest, resource) =>
      !oldest || resource.observedAt < oldest ? resource.observedAt : oldest,
    null,
  );

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Workspace">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            m
          </span>
          <span>Magic Canvas</span>
        </div>
        <nav aria-label="Main navigation">
          {(
            [
              ["today", "Home"],
              ["courses", "Courses"],
              ["myuw", "My UW"],
              ["sources", "Sources"],
              ["privacy", "Data & AI"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              className={`nav-button ${key === "sources" ? "nav-utility" : ""} ${view === key ? "active" : ""}`}
              aria-current={view === key ? "page" : undefined}
              onClick={() => setView(key)}
            >
              <Icon name={key === "privacy" ? "privacy" : key} />
              {label}
              {key === "today" && openItems > 0 ? (
                <span className="nav-count">{openItems}</span>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="storage-label">
            <Icon name="privacy" />
            <span>Stored on this device</span>
          </div>
          <button
            className="subtle-button privacy-shortcut"
            onClick={() => setView("privacy")}
          >
            {snapshot?.privacy.mode === "selective_cloud"
              ? "Selective cloud access"
              : "Cloud access is off"}
            <span aria-hidden="true">↗</span>
          </button>
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <span>
            {view === "today"
              ? "Your workspace"
              : view === "sources"
                ? "Connected sources"
                : view === "privacy" ? "Privacy & models" : view === "myuw" ? "My UW" : "Your courses"}
          </span>
          <div className="topbar-end">
            {snapshot?.fixtureMode ? (
              <span className="badge">Synthetic sample</span>
            ) : null}
            {busy ? (
              <span role="status" className="muted">
                Working…
              </span>
            ) : (
              <span className="muted">Local workspace</span>
            )}
          </div>
        </header>
        <div className="feedback-region">
          {error ? (
            <div className="message error" role="alert">
              <span>{error}</span>
              <button aria-label="Dismiss error" onClick={() => setError("")}>
                ×
              </button>
            </div>
          ) : null}
          {notice ? (
            <div className="message" role="status">
              <span>{notice}</span>
              <button aria-label="Dismiss notice" onClick={() => setNotice("")}>
                ×
              </button>
            </div>
          ) : null}
        </div>
        {!snapshot ? (
          <section className="initial-state">
            <h1>Your classes, in one place.</h1>
            <p className="muted">
              {error
                ? "The local workspace could not be opened."
                : "Opening your local workspace…"}
            </p>
            {error ? (
              <button className="button" onClick={() => void refresh()}>
                Try again
              </button>
            ) : null}
          </section>
        ) : view === "today" ? (
          <>
            <div className="page-heading">
              <div>
                <p className="eyebrow">
                  {new Intl.DateTimeFormat(undefined, {
                    weekday: "long",
                    month: "long",
                    day: "numeric",
                  }).format(new Date())}
                </p>
                <h1>Today</h1>
              </div>
              <div className="toolbar">
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => void importFile()}
                >
                  Import capture
                </button>
                {window.magic.syncCanvas ? (
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => void sync()}
                  >
                    Refresh Canvas
                  </button>
                ) : null}
              </div>
            </div>
            <PlanningAlerts snapshot={snapshot} open={open} onPlanning={() => setView("myuw")} />
            {unavailableSources.length > 0 ? (
              <div className="evidence-note" role="status">
                <p>
                  {needsSignIn
                    ? "A source needs sign-in before it can be checked. Saved coursework may have changed."
                    : "Some sources could not be checked completely. Saved coursework may have changed."}
                </p>
                <button
                  className="subtle-button"
                  onClick={() => setView("sources")}
                >
                  {needsSignIn
                    ? "Review sign-in and sources"
                    : "Review sources"}
                </button>
              </div>
            ) : null}
            {resources.length === 0 ? (
              <EmptyWorkspace
                busy={busy}
                canSignIn={Boolean(window.magic.signInUW)}
                onSignIn={signIn}
                onImport={importFile}
                onSample={() => run({ type: "fixture" })}
              />
            ) : (
              <div className={`today-layout ${selected ? "has-detail" : ""}`}>
                <section className="resource-panel" aria-label="Coursework">
                  <label className="search-box">
                    <Icon name="search" />
                    <input
                      aria-label="Search coursework"
                      placeholder="Find in your classes"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                    <kbd aria-hidden="true">⌕</kbd>
                  </label>
                  <ResourceList
                    resources={resources}
                    sources={snapshot.sources}
                    query={query}
                    selectedId={selected?.id ?? null}
                    busy={busy}
                    onSelect={setSelectedId}
                    onComplete={(resource, checked) =>
                      void run({
                        type: "complete",
                        id: resource.id,
                        completed: checked,
                      })
                    }
                  />
                  <p className="list-footnote">
                    Based on saved sources.
                    {oldestCapture
                      ? ` Oldest saved item capture: ${formatDate(oldestCapture, true)}.`
                      : ""}{" "}
                    Open an item to inspect its dates and evidence.
                  </p>
                </section>
                {selected ? (
                  <ResourceDetail
                    key={selected.id}
                    resource={selected}
                    snapshot={snapshot}
                    busy={busy}
                    run={run}
                    open={open}
                    onClose={() => setSelectedId(null)}
                  />
                ) : (
                  <div className="detail-placeholder">
                    <Icon name="file" />
                    <p>Select an item to see what’s behind it.</p>
                  </div>
                )}
              </div>
            )}
          </>
        ) : view === "myuw" ? (
          <MyUw snapshot={snapshot} busy={busy} run={run} open={open}
            refresh={() => void perform(async () => window.magic.syncPlanning?.())}
            signIn={(service) => void perform(async () => { await window.magic.signInUW?.(service); return window.magic.syncPlanning?.(); })} />
        ) : view === "courses" ? (
          <><div className="page-heading"><h1>Courses</h1></div><div className="planning-content">
            {courses.map((course) => <article className="planning-row" key={course.id}><h2>{course.courseName}</h2><button className="button" onClick={() => { setQuery(course.courseName); setSelectedId(null); setView("today"); }}>View coursework</button></article>)}
            {!resources.length ? <p className="muted">Connect Canvas from Home to see your courses here.</p> : null}
          </div></>
        ) : view === "sources" ? (
          <Sources
            snapshot={snapshot}
            run={run}
            busy={busy}
            canSignIn={Boolean(window.magic.signInUW)}
            canSync={Boolean(window.magic.syncCanvas)}
            canSignOut={Boolean(window.magic.signOutUW)}
            onSignIn={signIn}
            onSync={sync}
            onSignOut={signOut}
            onImport={importFile}
            onSample={() => run({ type: "fixture" })}
          />
        ) : (
          <Privacy snapshot={snapshot} busy={busy} run={run} open={open} />
        )}
      </main>
    </div>
  );
}

function EmptyWorkspace({
  busy,
  canSignIn,
  onSignIn,
  onImport,
  onSample,
}: {
  busy: boolean;
  canSignIn: boolean;
  onSignIn: () => unknown;
  onImport: () => unknown;
  onSample: () => unknown;
}) {
  return (
    <section className="empty-workspace">
      <div className="empty-icon">
        <Icon name="sources" />
      </div>
      <h2>Bring your classes into focus.</h2>
      <p>
        Connect UW to read your coursework, or import a saved capture. Your
        course records stay in the local workspace. Reading Canvas content may
        mark it viewed, including “must view” requirements.
      </p>
      <div className="empty-actions">
        {canSignIn ? (
          <button className="button primary" disabled={busy} onClick={onSignIn}>
            Sign in to UW <span aria-hidden="true">→</span>
          </button>
        ) : null}
        <button className="button" disabled={busy} onClick={onImport}>
          Import capture
        </button>
      </div>
      <div className="sample-divider">
        <span>Explore first</span>
      </div>
      <button
        className="subtle-button sample-button"
        disabled={busy}
        onClick={onSample}
      >
        Load sample course <span aria-hidden="true">↗</span>
      </button>
      <p className="small muted">Synthetic coursework. No account required.</p>
    </section>
  );
}

function ResourceList({
  resources,
  sources,
  query,
  selectedId,
  busy,
  onSelect,
  onComplete,
}: {
  resources: ResourceView[];
  sources: SourceHealth[];
  query: string;
  selectedId: string | null;
  busy: boolean;
  onSelect: (id: string) => void;
  onComplete: (resource: ResourceView, checked: boolean) => void;
}) {
  const needle = query.trim().toLocaleLowerCase();
  const visible = resources
    .filter(
      (resource) =>
        !needle ||
        `${resource.title} ${resource.courseName} ${resource.text}`
          .toLocaleLowerCase()
          .includes(needle),
    )
    .sort(
      (a, b) =>
        Number(a.completed || a.submitted === true) -
          Number(b.completed || b.submitted === true) ||
        (a.deadline.planningAt ?? "9999").localeCompare(
          b.deadline.planningAt ?? "9999",
        ) ||
        a.title.localeCompare(b.title),
    );
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  return (
    <div className="resource-list">
      <div className="list-heading">
        <span>Coursework & materials</span>
        <span>{visible.length}</span>
      </div>
      {visible.length === 0 ? (
        <div className="no-results">No coursework matches “{query}”.</div>
      ) : (
        visible.map((resource) => {
          const done = resource.completed || resource.submitted === true;
          const source = sourceById.get(resource.sourceId);
          return (
            <div
              key={resource.id}
              className={`resource-row ${selectedId === resource.id ? "selected" : ""} ${done ? "is-complete" : ""}`}
            >
              {resource.kind === "assignment" ? (
                <input
                  className="complete-checkbox"
                  type="checkbox"
                  aria-label={`Mark ${resource.title} complete`}
                  checked={done}
                  disabled={busy || resource.submitted === true}
                  onChange={(event) =>
                    onComplete(resource, event.target.checked)
                  }
                  title={
                    resource.submitted === true
                      ? "Submission reported by source"
                      : "Mark complete locally"
                  }
                />
              ) : (
                <span className="resource-kind-icon">
                  <Icon name="file" />
                </span>
              )}
              <button
                className="resource-select"
                aria-pressed={selectedId === resource.id}
                onClick={() => onSelect(resource.id)}
              >
                <span className="resource-course">{resource.courseName}</span>
                <span className="resource-title">{resource.title}</span>
                <span
                  className={`resource-subline ${resource.deadline.conflict ? "attention-text" : ""}`}
                >
                  {done
                    ? resource.submitted === true
                      ? "Submitted · reported by source"
                      : "Marked complete"
                    : resource.deadline.conflict
                      ? `Conflicting dates · plan for ${formatDate(resource.deadline.planningAt)}`
                      : resource.deadline.dueAt
                        ? `Due ${formatDate(resource.deadline.dueAt)}`
                        : resource.kind === "assignment"
                          ? "Due date not found"
                          : (resource.kindLabel ?? resource.kind)}
                  {source && source.status !== "ok"
                    ? ` · ${statusLabels[source.status]}`
                    : ""}
                </span>
              </button>
              <span className="row-chevron" aria-hidden="true">
                ›
              </span>
            </div>
          );
        })
      )}
    </div>
  );
}

function ResourceDetail({
  resource,
  snapshot,
  busy,
  run,
  open,
  onClose,
}: {
  resource: ResourceView;
  snapshot: Snapshot;
  busy: boolean;
  run: Run;
  open: (url: string) => void;
  onClose: () => void;
}) {
  const [recipient, setRecipient] = useState<Recipient>("local");
  const [manifest, setManifest] = useState<ContextManifest | null>(null);
  const source = snapshot.sources.find(
    (candidate) => candidate.id === resource.sourceId,
  );
  const links = snapshot.links.filter(
    (link) => link.fromId === resource.id || link.toId === resource.id,
  );
  const preview = async () => {
    const result = await run({ type: "context", id: resource.id, recipient });
    setManifest(result?.manifest ?? null);
  };
  // A preview applies only to the exact resource version and privacy choices it was made for.
  useEffect(() => {
    setManifest(null);
  }, [
    resource.contentHash,
    snapshot.privacy.mode,
    snapshot.privacy.jevEnabled,
    snapshot.privacy.hostedProvider,
    snapshot.privacy.shareCourseText,
    snapshot.privacy.shareStudentWork,
  ]);
  return (
    <section className="resource-detail" aria-label="Selected item">
      <div className="detail-top">
        <span className="eyebrow">{resource.kindLabel ?? resource.kind}</span>
        <button
          className="icon-button"
          aria-label="Close item"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <p className="detail-course">{resource.courseName}</p>
      <h2>{resource.title}</h2>
      <dl className="facts">
        <div>
          <dt>Due</dt>
          <dd className={resource.deadline.conflict ? "attention-text" : ""}>
            {resource.deadline.conflict
              ? "Dates conflict"
              : resource.deadline.dueAt
                ? formatDate(resource.deadline.dueAt, true)
                : "No confirmed due date"}
          </dd>
        </div>
        {resource.points !== null ? (
          <div>
            <dt>Points</dt>
            <dd>{resource.points}</dd>
          </div>
        ) : null}
        <div>
          <dt>Source</dt>
          <dd>{source?.label ?? resource.sourceId}</dd>
        </div>
        <div>
          <dt>Last seen</dt>
          <dd>{formatDate(resource.observedAt, true)}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>
            {resource.submitted === true
              ? "Submitted · reported by source"
              : resource.completed
                ? "Marked complete locally"
                : resource.submitted === false
                  ? "Not submitted · reported by source"
                  : "Submission status unknown"}
          </dd>
        </div>
      </dl>
      {source && (source.status !== "ok" || !source.complete) ? (
        <div className="evidence-note">
          {statusLabels[source.status]}. This item may have changed since its
          last successful capture.
        </div>
      ) : null}
      <button
        className="button source-button"
        onClick={() => open(resource.url)}
      >
        Open original <Icon name="arrow" />
      </button>
      <p className="source-url">{resource.url}</p>
      <section className="detail-section">
        <h3>Instructions</h3>
        {resource.text ? (
          <p className="source-text">{resource.text}</p>
        ) : (
          <p className="muted">No instructions were found in this capture.</p>
        )}
      </section>
      <section className="detail-section">
        <h3>Deadline evidence</h3>
        <p className="muted small">{resource.deadline.reason}</p>
        {resource.deadline.conflict && resource.deadline.planningAt ? (
          <p className="evidence-note">
            For planning: {formatDate(resource.deadline.planningAt, true)}.
            Confirm the date in the source.
          </p>
        ) : null}
        {resource.deadline.claims.length ? (
          <ul className="evidence-list">
            {resource.deadline.claims.map((claim, index) => (
              <li key={`${claim.kind}-${claim.value}-${index}`}>
                <div>
                  <span className="badge">{claim.kind}</span>
                  <span>{formatDate(claim.value, true)}</span>
                </div>
                <blockquote>
                  {claim.quote || "Structured source field"}
                </blockquote>
                {!claim.scopeConfirmed ? (
                  <span className="small attention-text">
                    Not confirmed to apply to this item
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted">
            No date claims are available in this capture.
          </p>
        )}
      </section>
      <section className="detail-section">
        <h3>
          Course AI policy <span className="badge">{resource.policy.mode}</span>
        </h3>
        <p className="source-text">
          {resource.policy.evidence ||
            "No AI policy was found in the captured material. Coaching is the default."}
        </p>
      </section>
      <LearningPanel key={`${resource.id}:${source?.accountScope}:${resource.contentHash}:${JSON.stringify(snapshot.privacy)}`} resource={resource} accountScope={source?.accountScope} />
      <LocalAiPanel
        key={`${resource.contentHash}:${JSON.stringify(snapshot.privacy)}`}
        resource={resource}
        privacyKey={JSON.stringify(snapshot.privacy)}
      />
      {links.length ? (
        <section className="detail-section">
          <h3>Related material</h3>
          {links.map((link) => {
            const otherId =
              link.fromId === resource.id ? link.toId : link.fromId;
            const other = snapshot.resources.find(
              (candidate) => candidate.id === otherId,
            );
            return (
              <div key={link.id} className="link-evidence">
                <strong>{other?.title ?? "Related source"}</strong>
                <span className="small muted">
                  {link.type.replaceAll("_", " ")} · {link.status}
                </span>
                <p>{link.reason}</p>
                <div className="inline-actions">
                  {link.status !== "accepted" ? (
                    <button
                      className="button small-button"
                      disabled={busy}
                      onClick={() =>
                        void run({
                          type: "link",
                          id: link.id,
                          status: "accepted",
                        })
                      }
                    >
                      Accept link
                    </button>
                  ) : null}
                  {link.status !== "rejected" ? (
                    <button
                      className="button small-button"
                      disabled={busy}
                      onClick={() =>
                        void run({
                          type: "link",
                          id: link.id,
                          status: "rejected",
                        })
                      }
                    >
                      {link.status === "accepted" ? "Undo link" : "Reject link"}
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </section>
      ) : null}
      <section className="detail-section">
        <h3>Data preview</h3>
        <p className="small muted">
          Inspect the exact context prepared for a model. Previewing does not
          send it.
        </p>
        <label className="field-label" htmlFor="recipient">
          Recipient
        </label>
        <div className="inline-actions">
          <select
            id="recipient"
            disabled={busy}
            value={recipient}
            onChange={(event) => {
              setRecipient(event.target.value as Recipient);
              setManifest(null);
            }}
          >
            {Object.entries(recipientLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <button
            className="button"
            disabled={busy}
            onClick={() => void preview()}
          >
            Preview data
          </button>
        </div>
        {manifest ? <Manifest manifest={manifest} /> : null}
        <div className="classification-action">
          <button
            className="button"
            disabled={
              busy ||
              !snapshot.gatewayConfigured ||
              snapshot.privacy.mode !== "selective_cloud" ||
              !snapshot.privacy.jevEnabled ||
              !snapshot.privacy.shareCourseText
            }
            onClick={() => void run({ type: "enrich", id: resource.id })}
          >
            Classify with Jev
          </button>
          <p className="small muted">
            {!snapshot.gatewayConfigured
              ? "The shared Jev gateway is not configured."
              : snapshot.privacy.mode !== "selective_cloud" ||
                  !snapshot.privacy.jevEnabled ||
                  !snapshot.privacy.shareCourseText
                ? "Enable Jev and course text sharing in Data & AI to send this context."
                : "Sends the permitted context to TypeSafe through the shared gateway."}
          </p>
        </div>
      </section>
    </section>
  );
}

function Manifest({ manifest }: { manifest: ContextManifest }) {
  return (
    <div className="manifest">
      <div className="manifest-status">
        <strong>
          {manifest.allowed
            ? "Allowed by your settings"
            : "Blocked by your settings"}
        </strong>
        <span>{manifest.characters.toLocaleString()} characters</span>
      </div>
      <p className="small">{manifest.reason}</p>
      <dl className="manifest-facts">
        <div>
          <dt>Recipient</dt>
          <dd>{recipientLabels[manifest.recipient]}</dd>
        </div>
        <div>
          <dt>Purpose</dt>
          <dd>{manifest.purpose}</dd>
        </div>
        <div>
          <dt>Categories</dt>
          <dd>{manifest.categories.join(", ") || "None"}</dd>
        </div>
      </dl>
      <details>
        <summary>Exact prepared payload</summary>
        <pre>{JSON.stringify(manifest.payload, null, 2)}</pre>
      </details>
    </div>
  );
}

function Sources({
  snapshot,
  run,
  busy,
  canSignIn,
  canSync,
  canSignOut,
  onSignIn,
  onSync,
  onSignOut,
  onImport,
  onSample,
}: {
  snapshot: Snapshot;
  run: Run;
  busy: boolean;
  canSignIn: boolean;
  canSync: boolean;
  canSignOut: boolean;
  onSignIn: () => unknown;
  onSync: () => unknown;
  onSignOut: () => unknown;
  onImport: () => unknown;
  onSample: () => unknown;
}) {
  return (
    <div className="settings-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Local evidence</p>
          <h1>Sources</h1>
        </div>
        <button className="button" disabled={busy} onClick={onImport}>
          Import capture
        </button>
      </div>
      <section className="settings-section">
        <div className="section-heading">
          <div>
            <h2>UW Canvas</h2>
            <p>
              Sign in in the app’s browser. The session stays on this device.
              Reading content may mark it viewed or satisfy a “must view”
              requirement in Canvas. Magic Canvas does not submit work, post,
              enroll, or send explicit completion commands.
            </p>
          </div>
        </div>
        <div className="inline-actions">
          {canSignIn ? (
            <button
              className="button primary"
              disabled={busy}
              onClick={onSignIn}
            >
              Sign in to UW
            </button>
          ) : null}
          {canSync ? (
            <button className="button" disabled={busy} onClick={onSync}>
              Refresh Canvas
            </button>
          ) : null}
          {canSignOut ? (
            <button
              className="subtle-button"
              disabled={busy}
              onClick={onSignOut}
            >
              Clear UW session
            </button>
          ) : null}
        </div>
        <p className="small muted">
          If UW requests Duo or a new sign-in, complete it in the browser.
          Previously captured records remain available when a session expires.
        </p>
      </section>
      <IngestionControls snapshot={snapshot} busy={busy} run={run} />
      <section className="settings-section">
        <h2>Captured sources</h2>
        <p className="muted">
          A successful check describes that capture. It does not guarantee that
          the source is still unchanged.
        </p>
        {snapshot.sources.length === 0 ? (
          <div className="empty-source">
            <p>No sources captured yet.</p>
            <button
              className="subtle-button"
              disabled={busy}
              onClick={onSample}
            >
              Load sample course
            </button>
            <span className="small muted">Synthetic data only</span>
          </div>
        ) : (
          <div className="source-list">
            {snapshot.sources.map((source) => (
              <article className="source-row" key={source.id}>
                <div className="source-title">
                  <h3>{source.label}</h3>
                  <span
                    className={`badge ${source.status !== "ok" ? "attention-badge" : ""}`}
                  >
                    {statusLabels[source.status]}
                  </span>
                  {source.kind === "fixture" ? (
                    <span className="badge">Synthetic</span>
                  ) : null}
                </div>
                <dl className="source-facts">
                  <div>
                    <dt>Last attempt</dt>
                    <dd>{formatDate(source.lastAttemptAt, true)}</dd>
                  </div>
                  <div>
                    <dt>Last successful capture</dt>
                    <dd>{formatDate(source.lastSuccessAt, true)}</dd>
                  </div>
                  <div>
                    <dt>Coverage</dt>
                    <dd>
                      {source.complete
                        ? "Complete for this scope"
                        : "Incomplete"}{" "}
                      · {source.resourceCount} records
                    </dd>
                  </div>
                  <div>
                    <dt>Scope</dt>
                    <dd>{source.scope}</dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
        )}
      </section>
      <section className="settings-section">
        <h2>Background processing</h2>
        <p className="muted">
          Changes are processed locally. Hosted judgments require your data
          settings to allow them.
        </p>
        <div className="job-summary">
          {(["pending", "running", "done", "failed"] as const).map((status) => (
            <div key={status}>
              <strong>
                {snapshot.jobs.filter((job) => job.status === status).length}
              </strong>
              <span>
                {status === "done"
                  ? "Finished"
                  : status[0].toUpperCase() + status.slice(1)}
              </span>
            </div>
          ))}
        </div>
        {snapshot.jobs.some((job) => job.status === "failed") ? (
          <p className="small attention-text">
            Some processing failed. Your original captures remain available.
          </p>
        ) : null}
      </section>
    </div>
  );
}

function Privacy({
  snapshot,
  busy,
  run,
  open,
}: {
  snapshot: Snapshot;
  busy: boolean;
  run: Run;
  open: (url: string) => void;
}) {
  const [deleteText, setDeleteText] = useState("");
  const [showDelete, setShowDelete] = useState(false);
  const value = snapshot.privacy;
  const update = (patch: Partial<PrivacyPreferences>) =>
    run(
      { type: "privacy", value: { ...value, ...patch } },
      "Data settings saved.",
    );
  const erase = async () => {
    if (deleteText !== "DELETE LOCAL DATA") return;
    const result = await run(
      { type: "purge", confirmation: "DELETE LOCAL DATA" },
      "Local coursework and activity deleted.",
    );
    if (result) {
      setDeleteText("");
      setShowDelete(false);
    }
  };
  return (
    <div className="settings-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Your data, your choice</p>
          <h1>Data & AI</h1>
        </div>
        <span className="badge">
          {value.mode === "local_only"
            ? "Cloud access off"
            : "Selective cloud access"}
        </span>
      </div>
      <section className="settings-section">
        <h2>Where your data goes</h2>
        <p>
          Course records, source history, completion state, and practice records
          are stored on this device. UW sign-in sessions stay in the app’s local
          browser. Degree audits, holds, course history, and planning records also stay local; this build does not send them to hosted AI or expose them through coursework MCP connections.
        </p>
        <fieldset className="mode-choices" disabled={busy}>
          <legend>Cloud access</legend>
          <label
            className={
              value.mode === "local_only"
                ? "mode-choice selected-mode"
                : "mode-choice"
            }
          >
            <input
              type="radio"
              name="cloud-mode"
              checked={value.mode === "local_only"}
              onChange={() => void update({ mode: "local_only" })}
            />
            <span>
              <strong>Keep AI context local</strong>
              <span>
                Block context from being sent to all hosted AI, including Jev.
              </span>
            </span>
          </label>
          <label
            className={
              value.mode === "selective_cloud"
                ? "mode-choice selected-mode"
                : "mode-choice"
            }
          >
            <input
              type="radio"
              name="cloud-mode"
              checked={value.mode === "selective_cloud"}
              onChange={() => void update({ mode: "selective_cloud" })}
            />
            <span>
              <strong>Choose what can be shared</strong>
              <span>
                Allow only the services and categories you turn on below.
              </span>
            </span>
          </label>
        </fieldset>
        <p className="small muted">
          Local data settings control AI sharing. Refreshing Canvas still
          contacts UW, and opening an original source contacts that website.
        </p>
      </section>
      <section className="settings-section">
        <h2>Models & services</h2>
        <SettingToggle
          label="Jev judgments"
          description="Classifies course material through our gateway. Permitted context is visible to the gateway operator and TypeSafe; the shared API key remains on the server. We pay for usage."
          checked={value.jevEnabled}
          disabled={busy || value.mode === "local_only"}
          onChange={(checked) => void update({ jevEnabled: checked })}
        />
        <p className="setting-note">
          {snapshot.gatewayConfigured
            ? "Shared gateway configured."
            : "The shared gateway has not been configured on this device."}
        </p>
        <div className="provider-setting">
          <label className="field-label" htmlFor="provider">
            Preferred AI
          </label>
          <select
            id="provider"
            disabled={busy || value.mode === "local_only"}
            value={value.hostedProvider}
            onChange={(event) =>
              void update({
                hostedProvider: event.target
                  .value as PrivacyPreferences["hostedProvider"],
              })
            }
          >
            <option value="none">Local model</option>
            <option value="chatgpt">ChatGPT</option>
            <option value="claude">Claude</option>
            <option value="gemini">Gemini</option>
          </select>
          <p className="small muted">
            This is a data preference, not an account connection. Hosted account
            handoff and automatic model installation are not available in this
            build. Installed local models can be used below.
          </p>
        </div>
      </section>
      <LocalAiPanel privacyKey={JSON.stringify(value)} />
      <section className="settings-section">
        <h2>What may be shared</h2>
        <SettingToggle
          label="Course text"
          description="Relevant course name, item title, instructions, and policy evidence. Preview the exact selection from an item before sending."
          checked={value.shareCourseText}
          disabled={busy || value.mode === "local_only"}
          onChange={(checked) => void update({ shareCourseText: checked })}
        />
        <SettingToggle
          label="Your work"
          description="Allow student-authored material, including connected GitLab content, when a feature or MCP connection requests it."
          checked={value.shareStudentWork}
          disabled={busy || value.mode === "local_only"}
          onChange={(checked) => void update({ shareStudentWork: checked })}
        />
        <SettingToggle
          label="Grades"
          description="Scores and grading status. Stored locally; sharing is off by default."
          checked={!!value.shareGrades}
          disabled={busy || value.mode === "local_only"}
          onChange={(checked) => void update({ shareGrades: checked })}
        />
        <SettingToggle
          label="Grader comments"
          description="Feedback that can help explain mistakes. Keeping comments locally does not enable cloud sharing."
          checked={!!value.shareComments}
          disabled={busy || value.mode === "local_only"}
          onChange={(checked) => void update({ shareComments: checked })}
        />
        <SettingToggle
          label="Course communications"
          description="Selected announcements and messages. These may contain personal information."
          checked={!!value.shareCommunications}
          disabled={busy || value.mode === "local_only"}
          onChange={(checked) => void update({ shareCommunications: checked })}
        />
        <p className="small muted">
          UW sign-in credentials, login cookies, and the shared Jev key are not
          part of model context. Turning off access prevents future sends; it
          cannot recall data already sent.
        </p>
      </section>
      <ProviderGuidance open={open} disabled={busy} />
      <McpConnections snapshot={snapshot} busy={busy} run={run} />
      <section className="settings-section">
        <h2>Recent data activity</h2>
        <p className="muted">
          Receipts record the destination and amount of context, without storing
          a second copy of the sent text.
        </p>
        {snapshot.receipts.length ? (
          <ul className="receipt-list">
            {snapshot.receipts
              .slice()
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
              .slice(0, 30)
              .map((receipt) => (
                <li key={receipt.id}>
                  <div>
                    <strong>
                      {recipientLabels[receipt.recipient as Recipient] ??
                        receipt.recipient}
                    </strong>
                    <span className="badge">
                      {receipt.status === "sent"
                        ? "Send attempted"
                        : receipt.status}
                    </span>
                  </div>
                  <p>{receipt.purpose}</p>
                  <span className="small muted">
                    {formatDate(receipt.createdAt, true)} ·{" "}
                    {receipt.characters.toLocaleString()} characters ·{" "}
                    {receipt.categories.join(", ") || "No categories"}
                  </span>
                </li>
              ))}
          </ul>
        ) : (
          <div className="no-activity">No recorded AI data activity.</div>
        )}
      </section>
      <section className="settings-section danger-section">
        <h2>Delete local data</h2>
        <p>
          Remove saved coursework, source history, judgments, links, and
          learning activity from this workspace. This does not delete anything
          from UW or from a hosted provider.
        </p>
        {!showDelete ? (
          <button
            className="button danger-button"
            disabled={busy}
            onClick={() => setShowDelete(true)}
          >
            Delete local data…
          </button>
        ) : (
          <div className="delete-confirm">
            <label className="field-label" htmlFor="delete-confirm">
              Type DELETE LOCAL DATA to confirm
            </label>
            <input
              id="delete-confirm"
              autoComplete="off"
              spellCheck={false}
              value={deleteText}
              onChange={(event) => setDeleteText(event.target.value)}
            />
            <div className="inline-actions">
              <button
                className="button danger-button"
                disabled={busy || deleteText !== "DELETE LOCAL DATA"}
                onClick={() => void erase()}
              >
                Permanently delete
              </button>
              <button
                className="button"
                disabled={busy}
                onClick={() => {
                  setShowDelete(false);
                  setDeleteText("");
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        <p className="small muted">
          Deleting local data also clears app-owned UW sessions, calendar feed
          secrets, downloaded documents, and exported MCP connections. It does
          not delete UW records.
        </p>
      </section>
    </div>
  );
}

function SettingToggle({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={`setting-toggle ${disabled ? "disabled-setting" : ""}`}>
      <span>
        <strong>{label}</strong>
        <span>{description}</span>
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}
