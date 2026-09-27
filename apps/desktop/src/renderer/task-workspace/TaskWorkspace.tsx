import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { AssignmentContext, GitlabLink, ResourceView, Snapshot, SourceInvestigationResult, TaskWindowCapability, TaskWindowPage, TaskWindowRequest, TaskWindowResult } from "@magic/contracts";
import { Action, Disclosure } from "../../../../../packages/ui/src";
import { EvidenceInfo } from "../../../../../packages/ui/src/evidence-info";
import { Glyph } from "../DesktopShell";
import { usePreparedWork } from "../prepared-work/usePreparedWork";
import { readCourseTools, type CourseToolsState } from "./page-view-adapter";
import { useSourceInvestigation, type InvestigationState } from "./source-investigation";
import {
  availableTargets, choose, courseGitlabLinks, forgetWorkspace, gitlabPathFromUrl, gitlabView, httpsUrl, initialDraft, instructionsChanged,
  lastOpenLine, linkReceipt, mergeWindows, missingChoices, placementOf, pruneWorkspaces, readWorkspace, recordFrom, saveWorkspace,
  stageOf, STATE_LABEL, windowPages, windowReceipts, type Draft, type GitlabChoice, type GitlabView, type Placement, type Target,
  type TargetReceipt, type TaskWorkspaceRecord,
} from "./model";
import { targetWhy, withInvestigation } from "./investigation-targets";
import "./task-workspace.css";

type Props = {
  resource: ResourceView; snapshot: Snapshot; refreshKey: string;
  onSetup?: () => void; onFailure?: (detail: string) => void;
};
type Windows = { mode: "live" | "test_only"; capability: TaskWindowCapability } | null;

/**
 * Assignment detail: the student's own setup for this task. First open chooses the
 * pages and opens them in fresh windows of the default browser (instructions left,
 * the page the task is worked in right); later visits Continue by bringing back
 * exactly those windows. When the browser or the app can't do that, pages go to the
 * browser as ordinary links and the panel says so.
 */
export function TaskWorkspace(props: Props) {
  const source = props.snapshot.sources.find(candidate => candidate.id === props.resource.sourceId);
  if (!source) return <section className="task-workspace" aria-label="Task setup">
    <h3>Your task setup</h3>
    <p className="task-workspace__note">This assignment's source account isn't available, so a setup can't be saved for it.</p>
  </section>;
  return <TaskWorkspaceInner key={`${source.accountScope}\u0000${props.resource.id}`} {...props} accountScope={source.accountScope} />;
}

const cleanError = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");

function TaskWorkspaceInner({ resource, snapshot, refreshKey, onSetup, onFailure, accountScope }: Props & { accountScope: string }) {
  const heading = useId();
  const anchor = `task-open-${resource.id}`;
  // Read-only here: the reviewed work set supplies the instructions and linked pages.
  const work = usePreparedWork(resource.id, refreshKey, anchor, { onFailure });
  const [record, setRecord] = useState<TaskWorkspaceRecord | null>(() => readWorkspace(accountScope, resource.id));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => initialDraft(record, []));
  const [gitlab, setGitlab] = useState<GitlabChoice>(() => record?.choices.gitlab ?? { state: "unset" });
  const [tools, setTools] = useState<CourseToolsState>({ kind: "loading" });
  const [linkedNow, setLinkedNow] = useState<GitlabLink[] | null>(null);
  const [windows, setWindows] = useState<Windows | "loading">("loading");
  const [busy, setBusy] = useState<"" | "open" | "close" | "access">("");
  const [problem, setProblem] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);
  const [adding, setAdding] = useState(false);
  const [returned, setReturned] = useState(false);
  // Keyed by the exact evidence it reads, not `refreshKey`: prepared work refreshes on every snapshot revision; this paid read doesn't.
  const investigation = useSourceInvestigation({ accountScope, resource, snapshot });
  const awaiting = useRef<"no" | "sent" | "left">("no");
  const seededDraft = useRef(!!record);
  const bridge = window.magic.taskWindows;

  useEffect(() => { pruneWorkspaces(snapshot); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let current = true;
    void readCourseTools(resource.id, resource.contentHash).then(next => { if (current) setTools(next); });
    return () => { current = false; };
  }, [resource.id, resource.contentHash]);
  const refreshWindows = async () => {
    if (!bridge) { setWindows(null); return; }
    try { const r = await bridge({ action: "status" }); setWindows({ mode: r.mode, capability: r.capability }); }
    catch { setWindows(null); }
  };
  useEffect(() => { void refreshWindows(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Session-only return cue: set after a real handoff once the student leaves Magic and comes back.
  useEffect(() => {
    const leave = () => { if (awaiting.current === "sent") awaiting.current = "left"; };
    const back = () => { if (awaiting.current === "left" && document.visibilityState !== "hidden") { awaiting.current = "no"; setReturned(true); } };
    const visibility = () => document.visibilityState === "hidden" ? leave() : back();
    window.addEventListener("blur", leave);
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", visibility);
    return () => { window.removeEventListener("blur", leave); window.removeEventListener("focus", back); document.removeEventListener("visibilitychange", visibility); };
  }, []);

  // A link saved here reaches the shared snapshot on its next read; until then add the command's own result.
  const snapshotLinks = courseGitlabLinks(snapshot, accountScope, resource.courseId);
  const links = linkedNow ? [...snapshotLinks, ...linkedNow.filter(link => !snapshotLinks.some(saved => saved.projectPath === link.projectPath))] : snapshotLinks;
  useEffect(() => {
    if (linkedNow?.every(link => snapshotLinks.some(saved => saved.projectPath === link.projectPath))) setLinkedNow(null);
  }, [snapshot.gitlabLinks]); // eslint-disable-line react-hooks/exhaustive-deps
  const courseTools = tools.kind === "ready" ? tools.tools : [];
  const gitlabNow = gitlabView(gitlab, links);
  // Source-check pages join as optional, cited suggestions; they never change the pre-selection.
  const offered = withInvestigation(availableTargets({ set: work.set, gitlab: gitlabNow, tools: courseTools, pages: draft.pages }), {
    result: investigation.state.kind === "ready" ? investigation.state.value : null, assignment: resource, accountScope, saved: snapshot,
  });
  const targets = offered.targets;
  // First open: the page the assignment links outside Canvas is suggested for the right window once known.
  useEffect(() => {
    if (seededDraft.current || work.prepare.kind === "loading") return;
    seededDraft.current = true;
    setDraft(initialDraft(null, targets));
  }, [work.prepare.kind, work.set]); // eslint-disable-line react-hooks/exhaustive-deps
  const pages = windowPages(resource, work.set, targets, draft);
  const stage = stageOf(record);
  const choosing = stage === "first_open" || editing;
  const changed = instructionsChanged(record, resource);
  const live = windows !== "loading" && (windows?.mode === "test_only" || windows?.capability.newWindow) ? windows : null;
  const owned = record?.windows ?? [];

  const persist = (next: TaskWorkspaceRecord) => {
    setRecord(next);
    try { saveWorkspace(next); }
    catch { setProblem("This device couldn't save your setup. Your choices apply until you leave this page."); }
  };
  const save = () => { persist(recordFrom({ previous: record, accountScope, resource, draft, gitlab })); setEditing(false); };
  const cancel = () => { setDraft(initialDraft(record, targets)); setGitlab(record?.choices.gitlab ?? { state: "unset" }); setEditing(false); };
  const forget = () => {
    try { forgetWorkspace(accountScope, resource.id); } catch { /* removed from this visit either way */ }
    setRecord(null); setEditing(false); setDraft(initialDraft(null, targets)); setGitlab({ state: "unset" }); setReturned(false); setNotice("");
  };

  /** Opens `list` (or brings back this task's windows) and saves what actually happened. */
  const run = async (list: TaskWindowPage[], how: "open" | "continue") => {
    if (busy || !list.length) return;
    setBusy("open"); setReturned(false); setProblem(""); setNotice("");
    let receipts: TargetReceipt[] = [];
    let nextWindows = owned;
    try {
      const result = await openTaskPages({ bridge: live ? bridge : undefined, accountScope, resourceId: resource.id, pages: list, windows: how === "continue" ? owned : undefined });
      receipts = result.receipts;
      if (result.windows) nextWindows = mergeWindows(owned, result.windows, how === "continue");
    } catch (cause) {
      setProblem(cleanError(cause));
    } finally {
      persist(recordFrom({ previous: record, accountScope, resource, draft, gitlab, windows: nextWindows, last: { at: new Date().toISOString(), targets: receipts } }));
      setEditing(false);
      if (receipts.some(r => ["handed_off", "new_window", "new_window_unplaced", "focused"].includes(r.state))) awaiting.current = document.hasFocus() ? "sent" : "left";
      setBusy("");
    }
  };
  const primary = () => owned.length && live ? run(pages, "continue") : run(pages, "open");
  const close = async () => {
    if (busy || !bridge || !owned.length) return;
    setBusy("close"); setConfirmClose(false); setProblem("");
    try {
      const result = await bridge({ action: "close", accountScope, resourceId: resource.id, windows: owned });
      persist(recordFrom({ previous: record, accountScope, resource, draft, gitlab, windows: result.windows }));
      setNotice(closeSummary(result));
    } catch (cause) { setProblem(cleanError(cause)); }
    finally { setBusy(""); }
  };
  const allowArrangement = async () => {
    if (!bridge || busy) return;
    setBusy("access");
    try { const r = await bridge({ action: "request-access" }); setWindows({ mode: r.mode, capability: r.capability }); }
    catch (cause) { setProblem(cleanError(cause)); }
    finally { setBusy(""); }
  };
  const addPage = async (url: string, title: string) => {
    const page = { url, title: title.trim().slice(0, 200) };
    const nextDraft: Draft = { ...draft, pages: [...draft.pages.filter(p => p.url !== url), page], support: [...draft.support.filter(k => k !== `page:${url}`), `page:${url}`] };
    setDraft(nextDraft); setAdding(false);
    if (stage === "first_open" || editing) return;
    persist(recordFrom({ previous: record, accountScope, resource, draft: nextDraft, gitlab }));
    // With task windows already open, the new page opens beside them in its own window.
    if (owned.length && live) {
      const one: TaskWindowPage = { key: `page:${url}`, role: "support", url, title: page.title || url, origin: "student" };
      setBusy("open");
      try {
        const result = await openTaskPages({ bridge, accountScope, resourceId: resource.id, pages: [one] });
        const windowsNow = mergeWindows(owned, result.windows ?? [], false);
        persist(recordFrom({ previous: record, accountScope, resource, draft: nextDraft, gitlab, windows: windowsNow, last: { at: new Date().toISOString(), targets: [...(record?.last?.targets ?? []).filter(t => t.key !== one.key), ...result.receipts] } }));
      } catch (cause) { setProblem(cleanError(cause)); }
      finally { setBusy(""); }
    }
  };

  const stale = missingChoices(draft, targets, tools.kind !== "loading" && work.prepare.kind !== "loading");
  const lastRows = record?.last?.targets ?? [];
  const n = pages.length;
  const openLabel = choosing ? (live ? `Save and open ${n} ${n === 1 ? "window" : "windows"}` : `Save and open ${n}`)
    : owned.length && live ? "Continue" : live ? `Open ${n} task ${n === 1 ? "window" : "windows"}` : `Open ${n} in your browser`;
  const workTarget = targets.find(t => t.key === draft.work);

  return <section className={`task-workspace is-${choosing ? "choosing" : "continue"}`} aria-labelledby={heading} data-place-anchor={`task-${resource.id}`}>
    <header className="task-workspace__head">
      <h3 id={heading}>{stage === "first_open" ? "Set up this task" : "Continue this task"}</h3>
      <div role="status" aria-live="polite">
        {returned && <p className="task-workspace__return">Back from your work. Your setup is saved.</p>}
        <p className="task-workspace__lede">{stage === "first_open"
          ? "Choose the pages you work in. Magic opens them in new windows and remembers them for this assignment on this device."
          : lastOpenLine(record?.last ?? null)}</p>
        {changed && <p className="task-workspace__attention">The instructions changed since you saved this setup. Check them before you continue.</p>}
        {problem && <p className="task-workspace__attention">{problem}</p>}
        {notice && <p className="task-workspace__confirmation">{notice}</p>}
      </div>
    </header>

    <InstructionsFact resource={resource} />
    {work.set?.context && <ContextFacts context={work.set.context} />}
    <SourceInvestigationFacts state={investigation.state} onStop={investigation.stop} onRestart={investigation.restart}
      lookup={id => snapshot.resources.find(r => r.id === id)} />
    <WindowsFact windows={windows} work={workTarget?.label ?? null} busy={busy === "access"} onAllow={() => void allowArrangement()} />

    {choosing ? <fieldset className="task-workspace__choices">
      <legend>Where each page opens</legend>
      <p className="task-workspace__row task-workspace__row--fixed">
        <span className="task-workspace__what"><span className="task-workspace__label">{resource.title}</span><small>Canvas assignment instructions</small></span>
        <span className="task-workspace__state">Left window</span>
      </p>
      {targets.map(target => {
        const tool = courseTools.find(t => `tool:${t.url}` === target.key);
        return <PlacementRow key={target.key} target={target} value={placementOf(draft, target.key)}
          evidence={tool?.evidence ? `“${tool.evidence.quote}” from ${tool.evidence.source}` : targetWhy(target)}
          onChange={value => setDraft(d => choose(d, target, value))} />;
      })}
      {offered.notes.map(note => <p key={note} className="task-workspace__row task-workspace__row--quiet">{note}</p>)}
      {!targets.length && <p className="task-workspace__row task-workspace__row--quiet">
        {work.prepare.kind === "loading" ? "Reading the assignment's linked pages…" : work.prepare.kind === "error" && work.prepare.problem.kind === "setup"
          ? <>Linked pages need the UW connection setup first. {onSetup && <button type="button" className="task-workspace__inline-action" onClick={onSetup}>Finish setup</button>}</>
          : "The assignment doesn't link other pages. Add one if you work somewhere else."}
      </p>}
      <GitlabChoiceRow view={gitlabNow} accountScope={accountScope} courseId={resource.courseId}
        onChoose={choice => { setGitlab(choice); if (choice.state === "project" && !draft.work) setDraft(d => ({ ...d, work: `gitlab:${choice.projectPath}` })); }} onLinked={setLinkedNow} />
      {tools.kind === "ready" && tools.canvasOnly.map(tool => <p key={tool.name} className="task-workspace__row task-workspace__row--quiet">
        <span className="task-workspace__label">{tool.name}</span><small>{tool.note}</small></p>)}
      {tools.kind === "error" && <p className="task-workspace__row task-workspace__row--quiet">{tools.message} Other choices still work.</p>}
      {stale.map(key => <p key={key} className="task-workspace__row task-workspace__row--quiet">
        <span>A saved page is no longer part of this assignment and won't open.</span>
        <button type="button" className="task-workspace__inline-action" onClick={() => setDraft(d => ({ ...d, work: d.work === key ? null : d.work, support: d.support.filter(k => k !== key) }))}>Remove</button>
      </p>)}
    </fieldset> : <ol className="task-workspace__saved" aria-label="Task pages">
      {pages.map(page => {
        const last = lastRows.find(row => row.key === page.key);
        const open = owned.some(w => w.key === page.key);
        return <li key={page.key} className="task-workspace__row">
          <span className="task-workspace__what"><span className="task-workspace__label">{page.title}</span>
            <small>{page.role === "instructions" ? (pages.some(p => p.role === "work") ? "Left window" : "Own window") : page.role === "work" ? "Right window" : "Own window"}{open ? " · window remembered" : ""}</small></span>
          {last && <span className={`task-workspace__state is-${last.state}`} title={last.detail}>{STATE_LABEL[last.state]}</span>}
        </li>;
      })}
      {gitlabNow.kind === "removed" && <li className="task-workspace__row task-workspace__attention">
        {gitlabNow.projectPath} is no longer linked to this course, so it won't open. Change pages to link it again or choose another.</li>}
    </ol>}

    {adding ? <AddPageForm onAdd={(url, title) => void addPage(url, title)} onCancel={() => setAdding(false)} /> : null}
    {confirmClose && <div className="task-workspace__confirm" role="group" aria-label="Close task windows">
      <p>Close {owned.length} task {owned.length === 1 ? "window" : "windows"}? Other tabs you opened in {owned.length === 1 ? "it" : "them"} close too, and your browser may ask first. Other browser windows stay open.</p>
      <span className="task-workspace__actions">
        <Action pending={busy === "close"} onClick={() => void close()}>Close windows</Action>
        <Action tone="quiet" onClick={() => setConfirmClose(false)}>Keep them</Action>
      </span>
    </div>}

    <div className="task-workspace__actions">
      <Action data-focus-key={anchor} disabled={!!busy && busy !== "open"} pending={busy === "open" || (choosing && work.prepare.kind === "loading")} onClick={() => void primary()}>
        {openLabel} <Glyph name="forward" />
      </Action>
      {choosing && <Action tone="quiet" disabled={!!busy} onClick={save}>{stage === "first_open" ? "Save without opening" : "Save changes"}</Action>}
      {editing && <Action tone="quiet" disabled={!!busy} onClick={cancel}>Cancel</Action>}
      {!adding && <Action tone="quiet" disabled={!!busy} onClick={() => setAdding(true)}>Add a page</Action>}
      {!choosing && live && owned.length > 0 && !confirmClose && <Action tone="quiet" disabled={!!busy} onClick={() => setConfirmClose(true)}>Close task windows</Action>}
      {!choosing && owned.length > 0 && <Action tone="quiet" disabled={!!busy} onClick={() => void run(pages, "open")}>Open fresh windows</Action>}
      {!choosing && <Action tone="quiet" disabled={!!busy} onClick={() => setEditing(true)}>Change pages</Action>}
      {!choosing && <Action tone="quiet" disabled={!!busy} onClick={forget}>Forget this setup</Action>}
    </div>
    <Disclosure label="Window behavior" placeKey={`task-window-behavior:${resource.id}`}><p className="task-workspace__note">Magic manages only windows verified in this app session. After restarting Magic, choose Open fresh windows; existing windows stay untouched. It can't see your tabs, restore where you were in a page or unsaved work, or confirm a page loaded. Opening doesn't submit or mark anything done.</p></Disclosure>
  </section>;
}

/**
 * Opens pages in task windows when the app can, otherwise as ordinary browser links.
 * With `windows`, brings those back first and reopens only pages whose window is gone.
 * Exported as a test seam.
 */
export async function openTaskPages(input: {
  bridge: ((request: TaskWindowRequest) => Promise<TaskWindowResult>) | undefined;
  accountScope: string; resourceId: string; pages: TaskWindowPage[]; windows?: TaskWorkspaceRecord["windows"];
}): Promise<{ receipts: TargetReceipt[]; windows: TaskWorkspaceRecord["windows"] | null }> {
  if (input.bridge) {
    const request: TaskWindowRequest = input.windows
      ? { action: "continue", accountScope: input.accountScope, resourceId: input.resourceId, pages: input.pages, windows: input.windows }
      : { action: "open", accountScope: input.accountScope, resourceId: input.resourceId, pages: input.pages };
    const result = await input.bridge(request);
    return { receipts: windowReceipts(result.outcomes, input.pages), windows: result.windows };
  }
  const openLink = window.magic.openLink;
  const receipts: TargetReceipt[] = [];
  for (const page of input.pages) {
    if (!openLink) { receipts.push({ key: page.key, label: page.title, state: "not_sent", detail: "This build can't open links from here." }); continue; }
    try { await openLink(page.url); receipts.push(linkReceipt(page)); }
    catch (cause) { receipts.push(linkReceipt(page, cause)); }
  }
  return { receipts, windows: null };
}

function closeSummary(result: TaskWindowResult) {
  const closed = result.outcomes.filter(o => o.state === "closed" || o.state === "missing").length;
  const left = result.outcomes.filter(o => o.state !== "closed" && o.state !== "missing");
  if (!left.length) return `Closed ${closed} task ${closed === 1 ? "window" : "windows"}.`;
  return `${closed ? `Closed ${closed}. ` : ""}${left[0]!.detail ?? "Some task windows are still open."}`;
}

/** What the browser and this Mac let Magic do, stated before anything opens. */
function WindowsFact({ windows, work, busy, onAllow }: { windows: Windows | "loading"; work: string | null; busy: boolean; onAllow: () => void }) {
  if (windows === "loading") return null;
  if (windows?.mode === "test_only") return <p className="task-workspace__fact">Verification mode: nothing opens.</p>;
  if (!windows || !windows.capability.newWindow) return <p className="task-workspace__fact">
    {windows?.capability.reason ?? "This build can't open task windows."} Pages go to your browser, which chooses where they open.
  </p>;
  const browser = windows.capability.browser ?? "browser";
  const layout = work ? `instructions on the left, ${work} on the right` : "instructions in their own window";
  if (!windows.capability.accessibility) return <p className="task-workspace__fact">
    Magic can open new {browser} windows ({layout}) but can't place them or bring them back until you allow window arrangement for Magic.{" "}
    <button type="button" className="task-workspace__inline-action" disabled={busy} onClick={onAllow}>Allow window arrangement</button>
  </p>;
  return <p className="task-workspace__fact">Opens new {browser} windows: {layout}.</p>;
}

function PlacementRow({ target, value, evidence, onChange }: { target: Target; value: Placement; evidence?: string; onChange: (value: Placement) => void }) {
  const id = useId();
  return <div className="task-workspace__row task-workspace__place">
    <span className="task-workspace__what">
      <label htmlFor={id} className="task-workspace__label">{target.label}</label>
      <small id={`${id}-detail`}>{target.detail}</small>
    </span>
    <span className="task-workspace__place-control">
      {evidence && <EvidenceInfo label={`Why ${target.label} is offered`}>{evidence}</EvidenceInfo>}
      <select id={id} value={value} aria-describedby={`${id}-detail`} onChange={event => onChange(event.currentTarget.value as Placement)}>
        <option value="right">Right window</option>
        <option value="own">Own window</option>
        <option value="off">Don't open</option>
      </select>
    </span>
  </div>;
}

function AddPageForm({ onAdd, onCancel }: { onAdd: (url: string, title: string) => void; onCancel: () => void }) {
  const field = useId();
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const safe = httpsUrl(url.trim());
    if (!safe) { setError("Use a full https:// address."); return; }
    onAdd(safe, "");
  };
  return <form className="task-workspace__link-form" onSubmit={submit}>
    <label htmlFor={field}>Page address</label>
    <div className="task-workspace__link-field">
      <input id={field} type="url" inputMode="url" placeholder="https://" value={url} onChange={event => { setUrl(event.currentTarget.value); setError(""); }} aria-invalid={!!error || undefined} aria-describedby={error ? `${field}-error` : undefined} />
      <Action type="submit" tone="quiet" disabled={!url.trim()}>Add page</Action>
      <Action tone="quiet" onClick={onCancel}>Cancel</Action>
    </div>
    {error && <p id={`${field}-error`} className="task-workspace__attention" role="alert">{error}</p>}
  </form>;
}

const FINDING_LABEL = { instruction: "Confirmed instruction", work_target: "Work target", reading: "Reading", context: "Course context" } as const;
type Citation = SourceInvestigationResult["findings"][number]["citations"][number];
/** The cited words: the saved local span when that exact version is still saved, else the excerpt the result carried. */
function citedText(c: Citation, saved: ResourceView | undefined) {
  const exact = saved && saved.contentHash === c.contentHash && saved.text && c.end <= saved.text.length ? saved.text.slice(c.start, c.end) : c.excerpt;
  return clip(sourceQuoteText(exact), 400);
}
const hostName = (url: string | null) => { try { return url ? new URL(url).host : null; } catch { return null; } };

/**
 * What the source investigation found. A finding supported only by a section matched through
 * the assignment's title is related course context, never a confirmed instruction. Each finding
 * cites its quoted source inline and links it; saved version and character span sit behind the
 * info toggletip. When Stop or a result replaces the focused control, focus moves to the region's
 * next control (or the region), not the page start.
 */
export function SourceInvestigationFacts({ state, onStop, onRestart, lookup }: {
  state: InvestigationState; onStop: () => void; onRestart: () => void; lookup?: (resourceId: string) => ResourceView | undefined;
}) {
  const region = useRef<HTMLElement>(null);
  const control = useRef<HTMLButtonElement>(null);
  const hadFocus = useRef(false);
  // Read before this commit replaces the control: was it the focused element?
  if (typeof document !== "undefined" && control.current && document.activeElement === control.current) hadFocus.current = true;
  useEffect(() => {
    if (!hadFocus.current) return;
    hadFocus.current = false;
    if (document.activeElement && document.activeElement !== document.body) return;
    (control.current ?? region.current)?.focus();
  }, [state.kind]);
  if (state.kind === "idle") return null;
  const body = state.kind === "loading" ? <>
    <p className="task-workspace__fact" role="status">Checking saved course sources for this assignment…</p>
    <div className="task-workspace__inline-actions"><button ref={control} type="button" className="task-workspace__inline-action" onClick={onStop}>Stop</button></div>
  </> : state.kind === "stopped" ? <>
    <p className="task-workspace__note" role="status">{state.changed ? "Stopped checking course sources. They've changed since; Magic checks again only when you ask." : "Stopped checking course sources. Magic checks again only when you ask."}</p>
    <div className="task-workspace__inline-actions"><button ref={control} type="button" className="task-workspace__inline-action" onClick={onRestart}>Check course sources</button></div>
  </> : state.kind === "error" ? <>
    <p className="task-workspace__attention" role="status">Course sources couldn't be checked: {state.message}</p>
    <div className="task-workspace__inline-actions"><button ref={control} type="button" className="task-workspace__inline-action" onClick={onRestart}>Try again</button></div>
  </> : <ReadyInvestigation result={state.value} lookup={lookup} />;
  return <section ref={region} tabIndex={-1} className="task-workspace__context task-workspace__investigation" aria-label="What the course sources say">{body}</section>;
}

function ReadyInvestigation({ result, lookup }: { result: SourceInvestigationResult; lookup?: (resourceId: string) => ResourceView | undefined }) {
  let n = 0;
  return <>
    <h4>What the course sources say</h4>
    <p className="task-workspace__fact">{result.summary}</p>
    {result.findings.map((finding, index) => {
      const related = finding.citations.length > 0 && finding.citations.every(c => c.provisional);
      const cited = finding.citations.map(c => {
        const saved = lookup?.(c.resourceId);
        const url = httpsUrl(c.sourceUrl);
        return { c, n: ++n, url, title: saved?.title?.trim() || hostName(url) || "Saved course source", text: citedText(c, saved) };
      });
      return <figure className="task-workspace__cited" key={index}>
        <figcaption>
          <span className="task-workspace__label">{related ? "Related course context" : FINDING_LABEL[finding.kind]}</span>
          {related && <small>Found by the assignment's title on a course page that isn't linked to it, so it isn't confirmed as this assignment's instructions.</small>}
        </figcaption>
        <p>{finding.text}{cited.map(x => <span key={x.n} className="task-workspace__cite-ref"> [{x.n}]</span>)}</p>
        {cited.map(x => <div className="task-workspace__citation" key={`${x.c.resourceId}:${x.c.start}:${x.n}`}>
          {x.text && <blockquote cite={x.url ?? undefined}>{x.text}</blockquote>}
          <small>
            [{x.n}] {x.url ? <a href={x.url} target="_blank" rel="noreferrer">{x.title}</a> : x.title}
            {x.c.provisional && !related && " · title match only"}
            {" "}<EvidenceInfo label={`Source ${x.n} details`}>Saved version {x.c.version}, characters {x.c.start}–{x.c.end}{x.c.provisional ? ". Matched by the assignment's title, not linked to it." : "."}</EvidenceInfo>
          </small>
        </div>)}
      </figure>;
    })}
    {result.unknowns.length > 0 && <p className="task-workspace__fact">Still unclear: {result.unknowns.join(" ")}</p>}
  </>;
}

function InstructionsFact({ resource }: { resource: ResourceView }) {
  const saved = new Date(resource.observedAt);
  const when = Number.isNaN(saved.getTime()) ? "" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(saved);
  return <p className="task-workspace__fact">
    {resource.text?.trim()
      ? <>Instructions are from the saved Canvas capture{when && ` of ${when}`}, shown on this page.</>
      : <>The saved capture has no instructions for this assignment. Check the assignment page before you start.</>}
  </p>;
}

/**
 * What the saved assignment doesn't settle: submission, unread linked files and, for an empty
 * assignment, the cited same-course section, quoted with its source and marked possibly related.
 */
export function ContextFacts({ context }: { context: AssignmentContext }) {
  const section = context.sections[0];
  const unread = context.links.filter(link => !link.captured);
  const sources = context.sources.filter(source => source.note && context.sections.some(s => s.sourceId === source.sourceId));
  return <div className="task-workspace__context">
    <Disclosure label="Submission and source details" placeKey={`task-source-details:${context.anchor}`}><p className="task-workspace__fact">{context.submission.text}</p>
    {unread.length > 0 && <p className="task-workspace__fact">
      {unread.length === 1 ? "The linked page" : `${unread.length} linked pages`} ({[...new Set(unread.map(link => link.host))].join(", ")}) {unread.length === 1 ? "opens" : "open"} as linked. Magic hasn't read {unread.length === 1 ? "it" : "them"}, so {unread.length === 1 ? "its" : "their"} contents aren't part of these instructions.
    </p>}
    </Disclosure>
    {section && <Disclosure label={section.provisional ? "Possibly related source" : "Linked source excerpt"} placeKey={`task-context:${section.sourceId}:${context.anchor}`}><figure className="task-workspace__cited">
      <figcaption>
        <span className="task-workspace__label">{section.provisional ? "Possibly related" : "Linked"}: {context.anchor} in {section.title}</span>
        <small>{section.provisional ? "Found by the assignment's title. It isn't linked to this assignment, so it may not be its instructions." : "Linked to this assignment."}</small>
      </figcaption>
      <blockquote cite={section.url}>{clip(sourceQuoteText(section.quote), 600)}</blockquote>
      {/* Date-conflict presentation temporarily suppressed; context retains evidence. */}
      {sources.map(source => <p key={source.sourceId} className="task-workspace__fact">{source.note}</p>)}
      {context.sections.length > 1 && <small>{context.sections.length - 1} more {context.anchor} {context.sections.length === 2 ? "mention" : "mentions"} on the same page.</small>}
    </figure></Disclosure>}
  </div>;
}
/** Display-only text conversion; saved quote, offsets and hash remain unchanged. */
export function sourceQuoteText(text: string): string {
  const plain = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\/?(?:p|div|li|ul|ol|br|h[1-6]|tr)\b[^>]*>/gi, "\n").replace(/<[^>]+>/g, "");
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…" };
  return plain.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (!entity.startsWith("#")) return entities[entity.toLowerCase()] ?? whole;
    const point = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
  }).replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
const clip = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, max).replace(/\s+\S*$/, "")}…`;

/** GitLab for this task: a course link is only a suggestion until the student confirms it for this task. */
function GitlabChoiceRow({ view, accountScope, courseId, onChoose, onLinked }: {
  view: GitlabView; accountScope: string; courseId: string; onChoose: (choice: GitlabChoice) => void; onLinked: (links: GitlabLink[]) => void;
}) {
  const [linking, setLinking] = useState(false);
  const [url, setUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const field = useId();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || !url.trim()) return;
    setPending(true); setError(""); setMessage("");
    try {
      const result = await window.magic.execute({ type: "gitlab-link", accountScope, courseId, url: url.trim() });
      const saved = courseGitlabLinks(result.snapshot, accountScope, courseId);
      onLinked(saved);
      const path = gitlabPathFromUrl(url);
      const match = saved.find(link => link.projectPath === path) ?? [...saved].sort((a, b) => b.addedAt.localeCompare(a.addedAt))[0];
      if (match) onChoose({ state: "project", projectPath: match.projectPath });
      setMessage(match ? `Saved ${match.projectPath} as this course's GitLab project and chose it for this task.` : result.message ?? "Saved.");
      setUrl(""); setLinking(false);
    } catch (cause) {
      setError((cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""));
    } finally { setPending(false); }
  };
  const form = <form className="task-workspace__link-form" onSubmit={event => void submit(event)}>
    <label htmlFor={field}>UW GitLab project address</label>
    <div className="task-workspace__link-field">
      <input id={field} type="url" inputMode="url" placeholder="https://git.doit.wisc.edu/group/project" value={url} onChange={event => setUrl(event.currentTarget.value)} aria-invalid={!!error || undefined} aria-describedby={error ? `${field}-error` : undefined} />
      <Action type="submit" tone="quiet" pending={pending} disabled={!url.trim()}>Link project</Action>
      <Action tone="quiet" disabled={pending} onClick={() => { setLinking(false); setError(""); }}>Cancel</Action>
    </div>
    {error && <p id={`${field}-error`} className="task-workspace__attention" role="alert">{error}</p>}
  </form>;
  const status = message && <p className="task-workspace__confirmation" role="status">{message}</p>;
  return <div className="task-workspace__row task-workspace__gitlab">
    <span className="task-workspace__what">
      <span className="task-workspace__label">GitLab</span>
      {view.kind === "confirmed" && <small>{view.projectPath}. You chose this project for this task.</small>}
      {view.kind === "removed" && <small className="task-workspace__attention">{view.projectPath} is no longer linked to this course, so it won't open.</small>}
      {view.kind === "suggested" && <small>{view.links.length === 1 ? `This course has a linked project, ${view.links[0]}.` : "This course has linked projects."} A course link doesn't say which project this task uses.</small>}
      {view.kind === "missing" && <small>No GitLab project is saved for this course. If this task is in UW GitLab, link its project.</small>}
      {view.kind === "none" && <small>You said this task doesn't use GitLab.</small>}
      {status}
      {linking ? form : <span className="task-workspace__inline-actions">
        {view.kind === "suggested" && view.links.map(path => <button key={path} type="button" className="task-workspace__inline-action" onClick={() => onChoose({ state: "project", projectPath: path })}>Use {view.links.length > 1 ? path : "it"} for this task</button>)}
        {view.kind !== "confirmed" && <button type="button" className="task-workspace__inline-action" onClick={() => { setLinking(true); setMessage(""); }}>{view.kind === "missing" ? "Link a project" : "Link a different project"}</button>}
        {view.kind === "confirmed" && <button type="button" className="task-workspace__inline-action" onClick={() => onChoose({ state: "unset" })}>Not this task's project</button>}
        {view.kind !== "none" && view.kind !== "confirmed" && <button type="button" className="task-workspace__inline-action" onClick={() => onChoose({ state: "none" })}>This task doesn't use GitLab</button>}
        {view.kind === "none" && <button type="button" className="task-workspace__inline-action" onClick={() => onChoose({ state: "unset" })}>Change</button>}
      </span>}
    </span>
  </div>;
}
