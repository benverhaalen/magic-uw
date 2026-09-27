import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { AppBridge, Command, CommandResult, Snapshot } from "@magic/contracts";
import { Action } from "../../../../../packages/ui/src";
import {
  buildSourcesModel,
  formatWhen,
  readLabels,
  type Connection,
  type ConnectionState,
  type CourseCoverage,
  type CourseLabel,
  type OutlookFacts,
} from "./model";

// owner: sources page. Account and source health, sign-in, refresh, coverage, consent and
// disconnect-versus-delete. Global connection notices belong to the shell (ConnectionNotice);
// this page reports each connection inside its own row.

type Run = (command: Command, message?: string) => Promise<CommandResult | undefined>;
type GraphState = NonNullable<OutlookFacts["graph"]>["state"];
/** Outlook through Microsoft sign-in. Present on builds with the Graph connection; optional here. */
interface OutlookGraphStatus {
  outlook: GraphState;
  lastSyncAt: string | null;
  counts: { messages: number; events: number };
  icsConnected: boolean;
  reason?: string | null;
}
export type SourcesBridge = Partial<Pick<AppBridge, "signInUW" | "syncCanvas" | "signOutUW" | "setOutlookCalendar" | "outlookCalendarStatus" | "keepSignedIn" | "importFile">> & {
  outlookConnect?(): Promise<OutlookGraphStatus>;
  outlookStatus?(): Promise<OutlookGraphStatus>;
  outlookDisconnectGraph?(): Promise<OutlookGraphStatus>;
};
export type SignInService = "canvas" | "gitlab";

export interface SourcesPageProps {
  snapshot: Snapshot;
  busy: boolean;
  run: Run;
  /** Consent-gated sign-in owned by the app; opens Agreements first when UW contact is not agreed. */
  onSignIn: (service?: SignInService) => unknown;
  /** Canvas and feed refresh through the app's shared operation; undefined result means it did not finish. */
  onSync: () => Promise<CommandResult | undefined> | undefined;
  onSignOut: () => unknown;
  onImport: () => unknown;
  onSample: () => unknown;
  onOpenMyUw: () => void;
  onOpenPrivacy: () => void;
  /** Whether the student agreed to UW contact; sign-in routes to Agreements otherwise. */
  uwConsented: boolean;
  /** Concise course labels (from the shared course cards); raw names stay visible beside them. */
  courseLabels?: CourseLabel[];
  /** Optional per-course material access detail (for example CourseSpaceDetails on current main). */
  accessDetails?: ReactNode;
  /** Reading settings (IngestionControls) supplied by the app. */
  readingSettings?: ReactNode;
  /** Reloads the saved snapshot without reading any source, after an Outlook disconnect removed items. */
  onSourcesChanged?: () => unknown;
  bridge?: SourcesBridge;
  now?: () => Date;
}

// Lucide nodes (lucide-react 1.48 / lucide-static paths); ISC attribution: packages/ui/LICENSE.icons.
const glyphs = {
  canvas: <><path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z" /><path d="M22 10v6" /><path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5" /></>,
  outlook: <><path d="M8 2v3" /><path d="M16 2v3" /><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18" /><path d="M8 13h.01" /><path d="M12 13h.01" /><path d="M16 13h.01" /><path d="M8 17h.01" /><path d="M12 17h.01" /></>,
  myuw: <><path d="M14 21v-3a2 2 0 0 0-4 0v3" /><path d="M18 4.933V21" /><path d="m4 6 7.106-3.79a2 2 0 0 1 1.788 0L20 6" /><path d="M6 4.933V21" /><circle cx="12" cy="9" r="2" /></>,
  file: <><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" /><path d="M14 2v5a1 1 0 0 0 1 1h5" /><path d="M12 12v6" /><path d="m15 15-3-3-3 3" /></>,
  refresh: <><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" /></>,
  signin: <><path d="m10 17 5-5-5-5" /><path d="M15 12H3" /><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /></>,
  chevron: <path d="m6 9 6 6 6-6" />,
  lock: <><rect width="18" height="11" x="3" y="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></>,
  check: <><circle cx="12" cy="12" r="10" /><path d="m16 9-5.5 5.5L8 12" /></>,
  alert: <><circle cx="12" cy="12" r="10" /><line x1="12" x2="12" y1="8" y2="12" /><line x1="12" x2="12.01" y1="16" y2="16" /></>,
  clock: <><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></>,
  unplug: <><path d="m19 5 3-3" /><path d="m2 22 3-3" /><path d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z" /><path d="M7.5 13.5 10 11" /><path d="M10.5 16.5 13 14" /><path d="m12 6 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z" /></>,
};
function Glyph({ name, size = 16 }: { name: keyof typeof glyphs; size?: number }) {
  return <svg className="sources-glyph" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{glyphs[name]}</svg>;
}

const tones: Record<string, { tone: string; glyph: keyof typeof glyphs }> = {
  canvas: { tone: "coral", glyph: "canvas" },
  outlook: { tone: "blue", glyph: "outlook" },
  myuw: { tone: "amber", glyph: "myuw" },
};
const stateWords: Record<ConnectionState, string> = {
  connected: "Up to date",
  partial: "Partly read",
  stale: "May be out of date",
  needs_sign_in: "Sign in needed",
  error: "Needs attention",
  not_connected: "Not connected",
  sample: "Sample data",
};
/** After a control that held focus disappeared, move focus to the first target still present.
 *  Focus the student has already moved elsewhere is left alone. Runs after React commits. */
function settleFocus(...targets: (() => HTMLElement | null | undefined)[]) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const a = document.activeElement;
    if (a && a !== document.body && a.isConnected) return;
    for (const target of targets) { const el = target(); if (el?.isConnected) { el.focus(); return; } }
  }));
}
const stateGlyph = (state: ConnectionState): keyof typeof glyphs => state === "connected" ? "check" : state === "stale" ? "clock" : state === "not_connected" || state === "sample" ? "unplug" : "alert";

export function SourcesPage(props: SourcesPageProps) {
  const { snapshot, busy } = props;
  const bridge: SourcesBridge = props.bridge ?? (typeof window !== "undefined" ? (window.magic as SourcesBridge) : {});
  const now = (props.now ?? (() => new Date()))();
  const [icsConnected, setIcsConnected] = useState<boolean | null>(null);
  const [graph, setGraph] = useState<OutlookGraphStatus | null>(null);
  // A fresh visit opens the connection needing attention. Back restores the student's rows, scroll
  // and focus through the shell's navigation (details[data-place-disclosure] and data-focus-key).
  const [expanded, setExpanded] = useState<string[]>(() => {
    const first = buildSourcesModel(snapshot, { now, labels: props.courseLabels, outlook: { icsConnected: null } }).attention;
    return first ? [first.id] : [];
  });
  const [refreshNote, setRefreshNote] = useState<{ text: string; tone: "status" | "alert" } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const live = useRef(true);
  const page = useRef<HTMLDivElement>(null);
  // The accounts this snapshot reads. A reply that started under other accounts (sign-out, a
  // different NetID, a rebuilt snapshot) is dropped instead of being reported on this one.
  const scopeKey = accountScopeKey(snapshot);
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;
  const outlookSeq = useRef(0);

  const readOutlook = useCallback(async () => {
    const seq = ++outlookSeq.current;
    const [ics, g] = await Promise.all([
      bridge.outlookCalendarStatus?.().then((s) => s.connected).catch(() => null) ?? Promise.resolve(null),
      bridge.outlookStatus?.().catch(() => null) ?? Promise.resolve(null),
    ]);
    if (!live.current || seq !== outlookSeq.current) return; // a newer read or an action already answered
    setIcsConnected(g?.icsConnected ?? ics);
    setGraph(g);
  }, [bridge]);
  useEffect(() => {
    live.current = true;
    void readOutlook();
    return () => { live.current = false; };
  }, [readOutlook, scopeKey]);

  const model = buildSourcesModel(snapshot, {
    now,
    labels: props.courseLabels,
    outlook: { icsConnected, graph: graph ? { state: graph.outlook, lastSyncAt: graph.lastSyncAt, messages: graph.counts.messages, events: graph.counts.events } : null },
  });
  // Opens a row and moves focus to its first control, for actions that finish inside the details.
  const reveal = (id: string) => {
    setOpen(id, true);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-connection="${id}"] .source-connection-details :is(input, button)`)?.focus());
  };
  const setOpen = (id: string, open: boolean) => setExpanded((e) => (open ? (e.includes(id) ? e : [...e, id]) : e.filter((x) => x !== id)));

  const refresh = async () => {
    if (!bridge.syncCanvas || refreshing) return;
    const startedFor = scopeRef.current;
    setRefreshing(true);
    setRefreshNote({ text: "Reading Canvas and your calendar feeds. Saved coursework stays available, and partial results are kept as they arrive.", tone: "status" });
    const result = await props.onSync();
    if (!live.current) return;
    setRefreshing(false);
    if (startedFor !== scopeRef.current) { setRefreshNote(null); return; }
    setRefreshNote(result
      ? { text: `Refresh finished ${formatWhen(new Date().toISOString(), new Date())}. Each source below shows what was read.`, tone: "status" }
      : { text: "The refresh did not finish. Saved coursework is unchanged. Try again, or check the source that needs attention below.", tone: "alert" });
    // A row's Try again disappears once its source reads cleanly; keep focus on the page's refresh.
    settleFocus(() => page.current?.querySelector<HTMLElement>('[data-focus-key="sources-refresh"]'), () => page.current?.querySelector<HTMLElement>("h1"));
    void readOutlook();
  };
  // Outlook status answered by an action is newer than any read still in flight.
  const outlookChanged = (g: OutlookGraphStatus | null, ics?: boolean) => {
    outlookSeq.current++;
    if (g) setGraph(g);
    if (ics !== undefined) setIcsConnected(ics);
  };
  // A finished refresh no longer describes the rows once the session ends.
  const signOut = async () => { setRefreshNote(null); await props.onSignOut(); };
  const connected = model.connections.filter((c) => c.state !== "not_connected" && c.state !== "sample");
  const nothingConnected = !connected.length;

  return (
    <div className="sources-page" ref={page}>
      <header className="sources-head">
        <div>
          <h1 tabIndex={-1}>Connected accounts</h1>
          <p className="sources-summary">{model.summary}</p>
        </div>
        {bridge.syncCanvas && !nothingConnected ? (
          <Action data-focus-key="sources-refresh" pending={refreshing} disabled={busy && !refreshing} onClick={() => void refresh()}>
            <Glyph name="refresh" /> {refreshing ? "Refreshing" : "Refresh now"}
          </Action>
        ) : null}
      </header>
      <p className={`sources-refresh-note ${refreshNote?.tone === "alert" ? "is-alert" : ""}`} role={refreshNote?.tone === "alert" ? "alert" : "status"}>
        {refreshNote?.text ?? ""}
      </p>
      <ul className="sources-list">
        {model.connections.map((c) => (
          <ConnectionRow key={c.id} connection={c} open={expanded.includes(c.id)} onOpen={(open) => setOpen(c.id, open)}
            action={<RowAction connection={c} {...props} bridge={bridge} busy={busy || refreshing} onRefresh={refresh} onReveal={() => reveal(c.id)} />}>
            {c.id === "canvas" ? (
              <CanvasDetails connection={c} {...props} onSignOut={signOut} bridge={bridge} busy={busy || refreshing} at={now} />
            ) : c.id === "outlook" ? (
              <OutlookDetails connection={c} bridge={bridge} busy={busy || refreshing} graph={graph} icsConnected={icsConnected}
                onChanged={outlookChanged} onSync={props.onSync} onSourcesChanged={props.onSourcesChanged} now={now} />
            ) : c.id === "myuw" ? (
              <PlanningDetails connection={c} now={now} onOpenMyUw={props.onOpenMyUw} />
            ) : (
              <OtherDetails connection={c} now={now} onOpenPrivacy={props.onOpenPrivacy} />
            )}
          </ConnectionRow>
        ))}
      </ul>
      <section className="sources-add" aria-labelledby="sources-add-title">
        <h2 id="sources-add-title">Add from a file</h2>
        <p>Import a capture saved from Canvas or another course page. It is checked before anything is saved.</p>
        <div className="sources-actions">
          <Action tone="quiet" data-focus-key="sources-import" disabled={busy} onClick={() => props.onImport()}><Glyph name="file" /> Import a capture</Action>
          {nothingConnected ? <Action tone="quiet" data-focus-key="sources-sample" disabled={busy} onClick={() => props.onSample()}>Try the sample course</Action> : null}
        </div>
        {nothingConnected ? <p className="sources-fine">The sample course is synthetic and is labeled everywhere it appears.</p> : null}
      </section>
      {model.runs.length ? (
        <section className="sources-runs" aria-labelledby="sources-runs-title">
          <h2 id="sources-runs-title">Recent checks</h2>
          <ol>
            {model.runs.map((r) => (
              <li key={r.id} className={r.tone === "attention" ? "is-attention" : undefined}>
                <span className="sources-run-when">{capitalize(r.when)}</span>
                <span>{r.trigger}</span>
                <span className="sources-run-result">{r.result}</span>
                {r.detail ? <span className="sources-fine">{r.detail}</span> : null}
              </li>
            ))}
          </ol>
          <FailedJobs snapshot={snapshot} />
        </section>
      ) : null}
      {props.readingSettings ? (
        <details className="sources-settings" data-place-disclosure="sources:reading-settings">
          <summary data-focus-key="sources-reading-settings"><span>What Magic reads and when</span><Glyph name="chevron" /></summary>
          <div className="sources-settings-body">{props.readingSettings}</div>
        </details>
      ) : null}
      <footer className="sources-boundary">
        <Glyph name="lock" size={18} />
        <div>
          <button type="button" className="sources-link" data-focus-key="sources-privacy" onClick={props.onOpenPrivacy}>Data & AI settings</button>
          <p>My Magic UW only reads. Opening a page can mark it viewed or satisfy a "must view" requirement in Canvas. It never submits work, posts, enrolls or marks anything complete.</p>
        </div>
      </footer>
    </div>
  );
}

function accountScopeKey(snapshot: Pick<Snapshot, "sources">): string {
  return [...new Set(snapshot.sources.filter((s) => s.kind === "canvas" && !s.accountScope.startsWith("connection:")).map((s) => s.accountScope))].sort().join("|");
}

function capitalize(text: string) { return text.charAt(0).toUpperCase() + text.slice(1); }

function FailedJobs({ snapshot }: { snapshot: Snapshot }) {
  const failed = snapshot.jobs.filter((j) => j.status === "failed").length;
  const pending = snapshot.jobs.filter((j) => j.status === "pending" || j.status === "running").length;
  if (!failed && !pending) return null;
  return (
    <p className="sources-fine">
      {pending ? `${pending} saved ${pending === 1 ? "item is" : "items are"} still being processed on this device. ` : ""}
      {failed ? `${failed} processing ${failed === 1 ? "step" : "steps"} failed; the original captures remain available.` : ""}
    </p>
  );
}

function ConnectionRow({ connection: c, open, onOpen, action, children }: { connection: Connection; open: boolean; onOpen: (open: boolean) => void; action: ReactNode; children: ReactNode }) {
  const id = useId();
  const look = tones[c.id] ?? { tone: c.state === "sample" ? "quiet" : "rose", glyph: "file" as const };
  const secondary = c.state === "not_connected" ? null : c.state === "sample" ? "Not from your school" : c.freshness;
  return (
    <li className={`source-connection tone-${look.tone} is-${c.state}`} data-connection={c.id}>
      <div className="source-connection-row">
        <span className="source-tile" aria-hidden="true"><Glyph name={look.glyph} size={18} /></span>
        <div className="source-connection-name">
          <h2 id={`${id}-name`}>{c.name}</h2>
          <p className="sources-fine">{c.accountShort}</p>
        </div>
        <div className="source-connection-state">
          <span className={`source-state is-${c.state}`}><Glyph name={stateGlyph(c.state)} size={15} />{stateWords[c.state]}</span>
          {secondary ? <span className="sources-fine">{secondary}</span> : null}
        </div>
        <div className="source-connection-action">{action}</div>
      </div>
      <details className="source-connection-more" data-place-disclosure={`sources:${c.id}`} open={open} onToggle={(e) => { const next = e.currentTarget.open; if (next !== open) onOpen(next); }}>
        <summary className="source-toggle" data-focus-key={`sources-${c.id}-details`} aria-label={`${c.name} details`} aria-describedby={`${id}-name`}>
          <Glyph name="chevron" size={16} />
        </summary>
        <div className="source-connection-details">
          {c.headline ? <p className="source-lead">{c.headline}</p> : null}
          <p className="source-covers"><span>Reads</span> {c.covers}</p>
          {children}
        </div>
      </details>
    </li>
  );
}

function RowAction({ connection: c, bridge, busy, uwConsented, onSignIn, onOpenMyUw, onRefresh, onReveal }: SourcesPageProps & { connection: Connection; bridge: SourcesBridge; onRefresh: () => Promise<void>; onReveal: () => void }) {
  if (c.id === "canvas") {
    if (!bridge.signInUW) return null;
    if (c.state === "not_connected" || c.state === "needs_sign_in")
      return <Action data-focus-key="sources-canvas-signin" disabled={busy} onClick={() => onSignIn("canvas")}><Glyph name="signin" /> {!uwConsented ? "Review agreement" : c.state === "needs_sign_in" ? "Sign in again" : "Sign in"}</Action>;
    if (c.state === "error" || c.state === "stale" || c.state === "partial")
      return bridge.syncCanvas ? <Action data-focus-key="sources-canvas-retry" disabled={busy} onClick={() => void onRefresh()}><Glyph name="refresh" /> {c.state === "stale" ? "Refresh" : "Try again"}</Action> : null;
    return null;
  }
  if (c.id === "outlook") {
    const canSetUp = Boolean(bridge.setOutlookCalendar || bridge.outlookConnect);
    if (!canSetUp) return null;
    if (c.state === "not_connected") return <Action data-focus-key="sources-outlook-setup" disabled={busy} onClick={onReveal}>Set up</Action>;
    if (c.state === "needs_sign_in") return <Action data-focus-key="sources-outlook-signin" disabled={busy} onClick={onReveal}><Glyph name="signin" /> Sign in again</Action>;
    return null;
  }
  if (c.id === "myuw" && c.state !== "connected") return <Action data-focus-key="sources-myuw-open" tone="quiet" onClick={onOpenMyUw}>Open My UW</Action>;
  return null;
}

function Facts({ items }: { items: [string, ReactNode][] }) {
  return <dl className="source-facts">{items.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}

/** Two-step confirmation in place; Cancel returns focus to the control that opened it. */
function Confirm({ label, tone = "quiet", explain, confirmLabel, disabled, onConfirm }: { label: ReactNode; tone?: "quiet" | "danger"; explain: ReactNode; confirmLabel: string; disabled: boolean; onConfirm: () => Promise<unknown> | unknown }) {
  const [asking, setAsking] = useState(false);
  const [pending, setPending] = useState(false);
  const trigger = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const row = useRef<Element | null>(null);
  useEffect(() => { if (asking) { row.current = panel.current?.closest("[data-connection]") ?? null; panel.current?.querySelector<HTMLElement>("button")?.focus(); } }, [asking]);
  // Back to the control that opened it; when the action replaced that control (a disconnected
  // calendar shows its link field instead), to the row's first control.
  const close = () => {
    setAsking(false);
    settleFocus(() => trigger.current?.querySelector<HTMLElement>("button"),
      () => row.current?.querySelector<HTMLElement>(".source-connection-details :is(input, button)"),
      () => row.current?.querySelector<HTMLElement>("summary"));
  };
  if (!asking)
    return <div ref={trigger} className={`source-manage ${tone === "danger" ? "is-danger" : ""}`}><Action tone="quiet" disabled={disabled} onClick={() => setAsking(true)}>{label}</Action></div>;
  return (
    <div ref={panel} className={`source-confirm ${tone === "danger" ? "is-danger" : ""}`} role="group" aria-label={confirmLabel}
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } }}>
      <div className="source-confirm-text">{explain}</div>
      <div className="sources-actions">
        <Action tone="quiet" onClick={close}>Cancel</Action>
        <Action pending={pending} disabled={disabled} onClick={async () => { setPending(true); try { await onConfirm(); } finally { setPending(false); close(); } }}>{confirmLabel}</Action>
      </div>
    </div>
  );
}

function CanvasDetails({ connection: c, bridge, busy, at: now, uwConsented, onSignIn, onSignOut, onOpenPrivacy, accessDetails }: SourcesPageProps & { connection: Connection; bridge: SourcesBridge; at: Date }) {
  const courseCount = c.courses.length;
  return (
    <>
      {!uwConsented ? (
        <p className="source-callout">Magic contacts UW only after you agree to it. Signing in opens that agreement first; nothing is read until you accept.</p>
      ) : null}
      {c.state !== "not_connected" ? (
        <Facts items={[
          ["Every course read in full", c.oldestSuccessAt ? capitalize(formatWhen(c.oldestSuccessAt, now)) : "Not yet"],
          ["Saved records", String(c.records)],
        ]} />
      ) : (
        <p>Sign in with your NetID in the app's own browser. If UW asks for Duo, finish it there; Magic never answers Duo for you.</p>
      )}
      {c.notes.map((n) => <p key={n} className="source-callout">{n}</p>)}
      {courseCount ? (
        <section className="source-courses" aria-label="Course coverage">
          <h3>Courses <span className="sources-fine">{courseCount}</span></h3>
          <ul>{c.courses.map((course) => <CourseRow key={course.key} course={course} now={now} busy={busy} canSignIn={Boolean(bridge.signInUW)} onSignIn={onSignIn} />)}</ul>
        </section>
      ) : null}
      {accessDetails ? <div className="source-access">{accessDetails}</div> : null}
      {c.state !== "not_connected" ? <KeepSignedIn bridge={bridge} busy={busy} /> : null}
      {c.state !== "not_connected" ? (
        <div className="source-manage-group">
          <h3>Manage</h3>
          <div className="source-manage-options">
            {bridge.signOutUW ? (
              <Confirm label={<><Glyph name="unplug" /> Sign out of UW</>} confirmLabel="Sign out" disabled={busy}
                explain={<><p><strong>Sign out keeps your saved coursework.</strong> Magic stops reading Canvas and GitLab until you sign in again.</p><p>It also removes your published Outlook calendar link and its meetings from this device.</p></>}
                onConfirm={() => onSignOut()} />
            ) : null}
            <div className="source-manage is-danger">
              <Action tone="quiet" data-focus-key="sources-canvas-delete" onClick={onOpenPrivacy}>Delete saved coursework</Action>
              <p className="sources-fine">Opens Data & AI. Delete local data removes everything Magic saved on this device, from every source; this cannot be undone.</p>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

const courseStateTone = (s: CourseCoverage["state"]) => (s === "complete" ? "ok" : s === "limited" || s === "not_checked" ? "quiet" : "attention");
function CourseRow({ course, now, busy, canSignIn, onSignIn }: { course: CourseCoverage; now: Date; busy: boolean; canSignIn: boolean; onSignIn: (s?: SignInService) => unknown }) {
  return (
    <li className="source-course">
      <details>
        <summary>
          <span className="source-course-name">
            <strong>{course.label}</strong>
            {course.rawName !== course.label ? <span className="sources-fine">{course.rawName}</span> : null}
          </span>
          <span className={`source-course-state tone-${courseStateTone(course.state)}`}>{readLabels[course.state]}</span>
          <span className="sources-fine">{course.records} records</span>
          <Glyph name="chevron" size={14} />
        </summary>
        <div className="source-course-body">
          <p className="sources-fine">
            {course.oldestSuccessAt ? `Every section read in full ${formatWhen(course.oldestSuccessAt, now)}.` : `Some sections have never been read in full. Newest check ${formatWhen(course.newestAttemptAt, now)}.`}
          </p>
          {course.needsGitLab && canSignIn ? (
            <div className="source-inline-fix">
              <p>This course's GitLab needs its own sign-in.</p>
              <Action tone="quiet" disabled={busy} onClick={() => onSignIn("gitlab")}><Glyph name="signin" /> Sign in to GitLab</Action>
            </div>
          ) : null}
          <ul className="source-scopes">
            {course.scopes.map((s) => (
              <li key={s.id}>
                <span>{scopeName(s.scope)}</span>
                <span className={`tone-${courseStateTone(s.state)}`}>{readLabels[s.state]}</span>
                <span className="sources-fine">{s.records}</span>
                {s.notes.length ? <span className="source-scope-notes">{s.notes.join(" ")}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      </details>
    </li>
  );
}
const scopeNames: Record<string, string> = {
  course: "Course home", assignments: "Assignments", announcements: "Announcements", discussions: "Discussions", pages: "Pages", files: "Files",
  syllabus: "Syllabus", quizzes: "Quizzes", modules: "Modules", calendar_feed: "Calendar feed", course_websites: "Course websites",
};
function scopeName(scope: string) {
  if (scopeNames[scope]) return scopeNames[scope];
  if (scope.startsWith("document:")) return "Linked document";
  if (scope.startsWith("linked-page:")) return "Linked page";
  if (scope.startsWith("gitlab:")) return `GitLab ${scope.slice(7).replaceAll("_", " ")}`;
  return capitalize(scope.replaceAll(/[_-]/g, " "));
}

function KeepSignedIn({ bridge, busy }: { bridge: SourcesBridge; busy: boolean }) {
  const [value, setValue] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    bridge.keepSignedIn?.().then((v) => { if (live) setValue(v); }).catch(() => {});
    return () => { live = false; };
  }, [bridge]);
  if (!bridge.keepSignedIn || value === null) return null;
  return (
    <label className="source-toggle-setting">
      <span>
        <strong>Keep me signed in</strong>
        <span className="sources-fine">Closing the window keeps My Magic UW running and it starts with your computer, so your UW session stays open. Quit or Sign out ends the session.</span>
        {error ? <span className="source-error" role="alert">{error}</span> : null}
      </span>
      <input type="checkbox" role="switch" checked={value} disabled={busy || saving}
        onChange={(e) => {
          setSaving(true); setError("");
          bridge.keepSignedIn!(e.target.checked).then(setValue).catch(() => setError("That setting could not be saved. It is unchanged.")).finally(() => setSaving(false));
        }} />
    </label>
  );
}

function OutlookDetails({ connection: c, bridge, busy, graph, icsConnected, onChanged, onSync, onSourcesChanged, now }: {
  connection: Connection; bridge: SourcesBridge; busy: boolean; graph: OutlookGraphStatus | null; icsConnected: boolean | null;
  onChanged: (graph: OutlookGraphStatus | null, ics?: boolean) => void; onSync: SourcesPageProps["onSync"]; onSourcesChanged: SourcesPageProps["onSourcesChanged"]; now: Date;
}) {
  const [link, setLink] = useState("");
  const [message, setMessage] = useState<{ text: string; alert: boolean } | null>(null);
  const [working, setWorking] = useState(false);
  const inputId = useId();
  // Microsoft sign-in is offered only when this build reports it set up; it has not been proven
  // against UW, which may need to approve the app first.
  const graphBuilt = Boolean(bridge.outlookConnect && bridge.outlookStatus);
  const hasGraph = graphBuilt && graph !== null && graph.outlook !== "not_set_up";
  const graphConnected = graph?.outlook === "connected";
  const saveIcs = async (value: string | null) => {
    if (!bridge.setOutlookCalendar) return;
    setWorking(true); setMessage(null);
    try {
      const result = await bridge.setOutlookCalendar(value);
      onChanged(null, result.connected);
      setLink(""); // the link is cleared only after it was saved; a failure keeps the draft
      setMessage({ text: result.connected ? "Saved. Reading your calendar now." : "Disconnected. Its meetings were removed from this device.", alert: false });
      if (result.connected) {
        const read = await onSync();
        setMessage(read ? { text: "Saved. Your calendar was read; this row shows what was found.", alert: false } : { text: "Saved, but the first read did not finish. Refresh now tries again.", alert: true });
      } else await onSourcesChanged?.();
    } catch (cause) {
      setMessage({ text: cause instanceof Error ? cause.message : "The link could not be saved. Nothing changed.", alert: true });
    } finally { setWorking(false); }
  };
  const connectGraph = async () => {
    setWorking(true); setMessage(null);
    try {
      const status = await bridge.outlookConnect!();
      onChanged(status);
      // The row's lead states the reason for a state it reports; this line reports the action's outcome.
      const reported = status.outlook === "needs_uw_approval" || status.outlook === "expired" || status.outlook === "error";
      setMessage(status.outlook === "connected" ? { text: "Connected. Mail and calendar are read on the next check.", alert: false } : { text: reported ? "Microsoft did not connect." : graphMessage(status.outlook), alert: true });
    } catch (cause) {
      setMessage({ text: cause instanceof Error ? cause.message : "Microsoft sign-in did not finish. Nothing changed.", alert: true });
    } finally { setWorking(false); }
  };
  const disconnectGraph = async () => {
    try {
      const status = await bridge.outlookDisconnectGraph!();
      onChanged(status);
      await onSourcesChanged?.();
      setMessage({ text: "Disconnected. Mail, calendar events, OneNote pages and OneDrive files read through Microsoft were removed from this device.", alert: false });
    } catch (cause) {
      setMessage({ text: cause instanceof Error ? cause.message : "Outlook could not be disconnected. Nothing was removed.", alert: true });
    }
  };
  const disabled = busy || working;
  return (
    <>
      {c.state !== "not_connected" && (graphConnected || c.records) ? (
        <Facts items={[
          ...(graphConnected ? [["Saved from Microsoft", `${graph!.counts.events} events, ${graph!.counts.messages} messages`] as [string, ReactNode]] : []),
          ...(c.records ? [["Saved items", String(c.records)] as [string, ReactNode]] : []),
        ]} />
      ) : null}
      {hasGraph ? (
        <div className="source-subsection">
          <h3>Microsoft sign-in</h3>
          <p>Reads your UW Outlook calendar, mail previews (subject, sender, date and a short preview; full messages are never saved), OneNote pages and linked OneDrive files through the app's own Microsoft sign-in. No password or token reaches this window.</p>
          {!graphConnected && graph?.outlook !== "needs_uw_approval" ? <p className="sources-fine">UW may need to approve this app before Microsoft allows it. If it does, this row says so and nothing is read.</p> : null}
                    <div className="sources-actions">
            {!graphConnected ? (
              <Action disabled={disabled} pending={working} onClick={() => void connectGraph()}><Glyph name="signin" /> {graph?.outlook === "expired" ? "Sign in to Microsoft again" : "Connect with Microsoft"}</Action>
            ) : (
              <Confirm label={<><Glyph name="unplug" /> Disconnect Microsoft</>} tone="danger" confirmLabel="Disconnect and remove" disabled={disabled}
                explain={<p><strong>Disconnecting also deletes what it saved.</strong> Mail, calendar events, OneNote pages and OneDrive files read through Microsoft are removed from this device. Coursework and your published calendar link are not affected.</p>}
                onConfirm={disconnectGraph} />
            )}
          </div>
        </div>
      ) : graphBuilt && graph?.outlook === "not_set_up" ? (
        <p className="sources-fine">Microsoft sign-in is not set up in this build. The published calendar link below adds your meetings without it.</p>
      ) : null}
      <div className="source-subsection">
        <h3>{hasGraph ? "Published calendar link" : "Published calendar"}</h3>
        {!bridge.setOutlookCalendar ? (
          <p className="sources-fine">Available in the desktop app.</p>
        ) : icsConnected ? (
          <>
            <p>Your published calendar link is saved, encrypted on this device and never shared. Published calendars don't include Teams join links; open the meeting in Outlook or Teams to join.</p>
            <Confirm label={<><Glyph name="unplug" /> Disconnect calendar</>} tone="danger" confirmLabel="Disconnect and remove" disabled={disabled}
              explain={<p><strong>Disconnecting also removes its meetings from this device.</strong> Coursework is not affected. You can paste the link again later.</p>}
              onConfirm={() => saveIcs(null)} />
          </>
        ) : (
          <form className="source-link-form" onSubmit={(e) => { e.preventDefault(); if (link.trim()) void saveIcs(link); }}>
            <p>Adds your meetings and appointments to Home and Calendar. In Outlook on the web, open Settings, Calendar, Shared calendars, then Publish a calendar with "Can view titles and locations" and copy the ICS link. Anyone with that link can see those titles and locations, so Magic stores it encrypted on this device.</p>
            <label htmlFor={inputId} className="sources-fine">Published calendar ICS link</label>
            <div className="source-link-row">
              <input id={inputId} className="source-input" value={link} onChange={(e) => setLink(e.target.value)} autoComplete="off" spellCheck={false}
                placeholder="https://outlook.office365.com/owa/calendar/…/calendar.ics" aria-invalid={message?.alert || undefined} />
              <Action type="submit" disabled={disabled || !link.trim()} pending={working}>Connect</Action>
            </div>
          </form>
        )}
      </div>
      {message ? <p className={message.alert ? "source-error" : "sources-fine"} role={message.alert ? "alert" : "status"}>{message.text}</p> : null}
      {c.state !== "not_connected" && c.sources.some((s) => s.notes.length) ? <ul className="source-scopes">{c.sources.filter((s) => s.notes.length).map((s) => <li key={s.id}><span>{scopeName(s.scope)}</span><span className="source-scope-notes">{s.notes.join(" ")}</span></li>)}</ul> : null}
    </>
  );
}
function graphMessage(state: GraphState): string {
  switch (state) {
    case "needs_uw_approval": return "UW has not approved Microsoft access for this app yet. Nothing new is read until it does.";
    case "expired": return "Your Microsoft sign-in ended. Saved meetings and mail stay here but may be out of date.";
    case "error": return "The Microsoft connection reported a problem. Saved items are unchanged.";
    case "not_set_up": return "Microsoft sign-in is not set up in this build.";
    default: return "Microsoft sign-in did not finish. Nothing changed.";
  }
}

function PlanningDetails({ connection: c, now, onOpenMyUw }: { connection: Connection; now: Date; onOpenMyUw: () => void }) {
  return (
    <>
      <p>Your student record, degree audit and course planning sources are read and refreshed from My UW, where each one shows its evidence.</p>
      {c.sources.length ? (
        <ul className="source-scopes">
          {c.sources.map((s) => (
            <li key={s.id}>
              <span>{s.scope}</span>
              <span className={`tone-${courseStateTone(s.state)}`}>{readLabels[s.state]}</span>
              <span className="sources-fine">{capitalize(formatWhen(s.lastAttemptAt, now))}</span>
              {s.notes.length ? <span className="source-scope-notes">{s.notes.join(" ")}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="sources-actions"><Action tone="quiet" data-focus-key="sources-myuw-open-details" onClick={onOpenMyUw}>Open My UW</Action></div>
    </>
  );
}

function OtherDetails({ connection: c, now, onOpenPrivacy }: { connection: Connection; now: Date; onOpenPrivacy: () => void }) {
  const s = c.sources[0];
  return (
    <>
      <p>{c.account}</p>
      <Facts items={[["Last check", capitalize(formatWhen(c.newestAttemptAt, now))], ["Coverage", s ? readLabels[s.state] : "Not checked"], ["Saved records", String(c.records)]]} />
      {s?.notes.length ? <p className="sources-fine">{s.notes.join(" ")}</p> : null}
      <div className="source-manage is-danger">
        <Action tone="quiet" data-focus-key={`${c.id}-delete`} onClick={onOpenPrivacy}>Delete saved data</Action>
        <p className="sources-fine">Opens Data & AI. Delete local data removes everything Magic saved on this device, from every source.</p>
      </div>
    </>
  );
}
