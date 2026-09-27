import { useEffect, useId, useRef, useState, type ComponentType, type ReactNode, type RefObject } from "react";
import type { ResourceView } from "@magic/contracts";
import { Action, Disclosure } from "../../../../../packages/ui/src";
import { counts, launchLabel, pageViewApplies, readableNote, sendsLine, sentTitles, slotView, stateLabel, stateTone, summaryLine, type LaunchOutcome, type SlotView } from "./launch-model";
import { destinationGroups, destinationOf, destinationPhrase, type DestinationIcon } from "./destination";
import { usePreparedWork, type PreparedWorkController } from "./usePreparedWork";
import "../StartWork.css";
import "./PreparedWork.css";
import { CanvasMark } from "./canvas-mark";

// Lucide v0.468.0 nodes, ISC; attribution in packages/ui/LICENSE.icons.
// file-text, refresh-cw, x and arrow-right match docs/design/lab/vendor; the others are copied from lucide-react 0.468.0.
type IconName = DestinationIcon | "retry" | "close" | "forward" | "alert" | "info";
function Icon({ name }: { name: IconName }) {
  if (name === "canvas") return <CanvasMark/>;
  const sheet = <><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></>;
  const paths = {
    globe: <><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></>,
    "file-text": <>{sheet}<path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></>,
    file: sheet,
    "file-spreadsheet": <>{sheet}<path d="M8 13h2"/><path d="M14 13h2"/><path d="M8 17h2"/><path d="M14 17h2"/></>,
    presentation: <><path d="M2 3h20"/><path d="M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3"/><path d="m7 21 5-5 5 5"/></>,

    "git-branch": <><line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></>,
    retry: <><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></>,
    close: <><path d="M18 6 6 18"/><path d="m6 6 12 12"/></>,
    forward: <><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></>,
    alert: <><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></>,
    info: <><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></>,
  };
  return <svg className="magic-prepared__icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export type PreparedWorkProps = {
  resource: ResourceView;
  refreshKey: string;
  /** Route to the saved assignment detail, used when nothing can be launched or the list changed. */
  onInspect?: () => void;
  /** Home Upcoming tile: the whole card starts work; `trailing` holds sibling controls, never nested. */
  compact?: { className: string; summary: ReactNode; description?: string; trailing?: ReactNode;
    /** Data attributes for the card surface (e.g. packages/ui deadlineSurface), spread onto the card. */
    surface?: Readonly<Record<`data-${string}`, string>> };
  /** Labeled action beside a briefing passage, with the same prepared set, status slot and retry. */
  action?: boolean;
  /** Actual route to the UW connection setup step ("Finish setup"). */
  onSetup?: () => void;
  /** Plain confirmation with nothing to act on; the shell shows it as a notice without moving content. */
  onNotice?: (text: string) => void;
  /** Original text of an unexpected failure, for the shell's global failure contract. */
  onFailure?: (detail: string) => void;
  /** Detail only: opens the assignment's own page when nothing prepared can be sent (lets the shell drop a duplicate "Open original"). */
  onOpenOriginal?: () => void;
  /** Shared info toggletip for routine detail (e.g. packages/ui EvidenceInfo). Children are phrasing only. */
  info?: InfoRenderer;
};
export type InfoRenderer = ComponentType<{ label: string; children: ReactNode }>;

/** Drop-in for StartWork: same props plus setup/notice/failure routes; one engine, outcome shared across surfaces. */
export function PreparedWork(props: PreparedWorkProps) {
  return <PreparedWorkInner key={props.resource.id} {...props} />;
}

function PreparedWorkInner(props: PreparedWorkProps) {
  const { resource, refreshKey, compact, action, onNotice, onFailure } = props;
  const container = useRef<HTMLElement>(null);
  const lazy = !!(compact || action);
  const [visible, setVisible] = useState(!lazy);
  useEffect(() => {
    if (visible || !container.current) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { root: document.querySelector(".desktop-workspace"), rootMargin: "100px" });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, [visible]);
  const anchor = compact ? `work-${resource.id}` : action ? `start-${resource.id}` : `start-work-${resource.id}`;
  const work = usePreparedWork(resource.id, refreshKey, anchor, { enabled: visible, onNotice, onFailure });
  return <WorkView {...props} work={work} anchor={anchor} container={container}/>;
}

/** Rendering only, driven by a controller. Exported as a test seam for rendered states. */
export function WorkView(props: PreparedWorkProps & { work: PreparedWorkController; anchor: string; container?: RefObject<HTMLElement | null> }) {
  return props.compact || props.action ? <Tile {...props}/> : <FullWork work={props.work} anchor={props.anchor} onSetup={props.onSetup} onOpenOriginal={props.onOpenOriginal} info={props.info}/>;
}

/** What the tile's main target does right now. */
function tileTarget(work: PreparedWorkController, onInspect?: () => void) {
  const { set, prepare, pending, earlier, canLaunch, outcome } = work;
  const changed = earlier && !!outcome && (sentTitles(outcome).length > 0 || outcome.problem?.kind === "changed");
  if (onInspect && (prepare.kind === "error" || !set || !window.magic.startWork)) return { label: "View assignment", run: onInspect, disabled: false };
  if (onInspect && changed) return { label: "Review updated list", run: onInspect, disabled: false };
  return { label: set ? launchLabel(set) : "Start work", run: () => void work.launch(), disabled: pending || !canLaunch };
}

function Tile({ resource, work, anchor, container, compact, action, onInspect, onSetup, info }: PreparedWorkProps & { work: PreparedWorkController; anchor: string; container?: RefObject<HTMLElement | null> }) {
  const described = useId();
  const { set, pending } = work;
  const target = tileTarget(work, onInspect);
  const activate = () => { if (!target.disabled && !pending) target.run(); };
  const facts = [compact?.description, set ? sendsLine(set) : null, set && pageViewApplies(set) ? "Canvas may record a page view" : null].filter(Boolean).join(". ");
  const titles = set ? `${target.label}. ${sendsLine(set)}. ${set.items.map(item => item.title).join(" + ")}${pageViewApplies(set) ? ". Canvas may record a page view." : ""}` : undefined;
  const slot = <StatusSlot work={work} anchor={anchor} onSetup={onSetup} onInspect={onInspect} info={info}/>;
  if (compact) return <section ref={container as RefObject<HTMLElement>} className="magic-start-work magic-start-work--compact magic-prepared-tile" aria-label={`Prepared work: ${resource.title}`} data-place-anchor={anchor}>
    <div className={`home-work-card magic-prepared-card ${compact.className}`} {...compact.surface}>
      <button className="home-work-row magic-prepared-target" data-focus-key={anchor} aria-label={`${target.label}: ${resource.title}`} aria-describedby={described} title={titles}
        aria-busy={pending || undefined} aria-disabled={target.disabled || undefined} onClick={activate}>
        {compact.summary}
      </button>
      {slot}
      {compact.trailing}
      <span id={described} hidden>{facts}</span>
    </div>
  </section>;
  const multi = !!set && set.items.length > 1;
  return <section ref={container as RefObject<HTMLElement>} className="magic-start-work magic-start-work--action magic-prepared-action" aria-label={`Prepared work: ${resource.title}`} data-place-anchor={anchor}>
    <Action data-focus-key={anchor} aria-describedby={described} title={titles} pending={pending} aria-disabled={target.disabled || undefined} onClick={activate}>
      <span>{target.label}{multi && target.label === "Start work" && <small>{sendsLine(set)}</small>}</span><Icon name="forward"/>
    </Action>
    {slot}
    <span id={described} hidden>{facts}</span>
  </section>;
}

/** Idle marks: one icon per actual destination category, decoration only (the row names them). */
function Marks({ work }: { work: PreparedWorkController }) {
  if (!work.set) return null;
  const groups = destinationGroups(work.set.items);
  return <span className="magic-prepared-slot__marks" aria-hidden="true">
    {groups.slice(0, 3).map(group => <span key={group.key} className="magic-prepared-slot__mark" title={group.label}><Icon name={group.icon}/></span>)}

  </span>;
}

/**
 * The reserved action/status slot. Every state renders inside the same fixed
 * bounds: marks when idle, then Sending…, then the result or one short remedy.
 * Routine detail opens over the page instead of pushing rows down. Never nested
 * in the launch button.
 */
function StatusSlot({ work, anchor, onSetup, onInspect, info }: { work: PreparedWorkController; anchor: string; onSetup?: () => void; onInspect?: () => void; info?: InfoRenderer }) {
  const view: SlotView = slotView({
    outcome: work.outcome, earlier: work.earlier, pending: work.pending,
    prepareError: work.prepare.kind === "error" ? work.prepare.problem : null,
    canSetup: !!onSetup, canReview: !!onInspect,
  });
  // The student saw the result here; a later visit does not repeat a "back" cue.
  useEffect(() => () => work.acknowledgeReturn(), []); // eslint-disable-line react-hooks/exhaustive-deps
  // Remedies disappear once they run; keep focus on the tile's own target.
  const keepFocus = () => focusAnchor(anchor);
  const remedy = view.remedy && (() => {
    switch (view.remedy.kind) {
      case "retry_failed": return () => { keepFocus(); work.retryFailed(); };
      case "retry_all": return () => { keepFocus(); void work.launch(); };
      case "refresh": return () => { keepFocus(); work.refresh(); };
      case "setup": return () => onSetup?.();
      case "review": return () => onInspect?.();
    }
  })();
  const Info = info ?? LocalInfo;
  const label = `Start work details: ${view.text}`;
  return <div className={`home-work-status-slot magic-prepared-slot is-${view.tone}`}>
    {/* One live region in every state; with a remedy its text is announced but takes no slot width. */}
    <span className={view.remedy ? "magic-prepared-sr" : "magic-prepared-slot__text"} role="status" aria-live="polite">{view.text}</span>
    {view.tone === "idle" && <Marks work={work}/>}
    {view.remedy && remedy && <button type="button" className="home-work-remedy magic-prepared-slot__remedy" aria-label={view.remedy.name} onClick={remedy}>{view.remedy.label}</button>}
    {view.details.length > 0 && <Info label={label}>
      {view.details.map(line => <span key={line} className="magic-prepared-info__line">{line}</span>)}
      {view.technical && <span className="magic-prepared-info__line magic-prepared-info__technical">Technical detail: <code>{view.technical}</code></span>}
    </Info>}
  </div>;
}

/** Fallback when no shared info toggletip is supplied: native disclosure, opens over the page, Escape returns to it. */
function LocalInfo({ label, children }: { label: string; children: ReactNode }) {
  const details = useRef<HTMLDetailsElement>(null);
  return <details ref={details} className="home-work-error-info magic-prepared-info"
    onKeyDown={event => { if (event.key === "Escape" && details.current?.open) { event.stopPropagation(); details.current.open = false; details.current.querySelector("summary")?.focus(); } }}>
    <summary aria-label={label}><Icon name="info"/></summary>
    <div role="note" aria-label={label}>{children}</div>
  </details>;
}

type Stage = "ready" | "sending" | "verify" | "return" | "problem";
function stageOf(outcome: LaunchOutcome | null): Stage {
  if (!outcome) return "ready";
  if (counts(outcome).pending) return "sending";
  if (outcome.problem && (outcome.mode === "none" || outcome.problem.kind === "unknown")) return "problem";
  if (outcome.mode === "dry_run") return "verify";
  if (outcome.mode === "opened") return "return";
  return outcome.problem ? "problem" : "ready";
}
const STAGE_TITLE: Record<Stage, string> = { ready: "Start work", sending: "Start work", verify: "Verification run", return: "Return to your work", problem: "Start work" };

/** Assignment detail: one flat region whose state changes; rows are separated by lines, not an inner card. */
function FullWork({ work, anchor, onSetup, onOpenOriginal, info }: { work: PreparedWorkController; anchor: string; onSetup?: () => void; onOpenOriginal?: () => void; info?: InfoRenderer }) {
  const Info = info ?? LocalInfo;
  const heading = useId();
  const { set, prepare, pending, canLaunch, outcome, earlier, returnedAt } = work;
  const current = outcome && !earlier ? outcome : null;
  const stage = stageOf(current);
  const sentBefore = !!current && current.mode !== "none";
  const assignment = set?.items.find(item => item.role === "instructions")?.title ?? set?.assignmentTitle;
  const earlierSent = earlier && outcome ? sentTitles(outcome) : [];
  // Acknowledge on leaving; no scroll on mount, so Back keeps the restored place.
  useEffect(() => () => work.acknowledgeReturn(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const problem = current?.problem ?? null;
  const lede = !current ? (earlier ? "The prepared list changed since your last attempt. Review it before starting again." : "Magic sends these reviewed destinations to your browser and apps.")
    : problem && stage === "problem" ? problem.message
    : summaryLine(current);
  const extra = problem && stage !== "problem" && problem.message !== lede ? problem.message : null;
  const label = set ? launchLabel(set) : "Start work";
  const setupNeeded = problem?.kind === "setup" || (prepare.kind === "error" && prepare.problem.kind === "setup");
  const footnote = set ? [pageViewApplies(set) ? "Canvas may record a page view." : "", "Magic can confirm each handoff to your browser or apps, not that a page loaded. Opening does not mark work done."].filter(Boolean).join(" ") : "";
  return <section className={`magic-start-work magic-prepared is-${stage === "sending" ? (sentBefore ? "return" : "ready") : stage}`} aria-labelledby={heading} data-place-anchor={anchor}>
    <header className="magic-prepared__head">
      <span className="magic-prepared__badge"><Icon name={stage === "return" ? "retry" : "forward"}/></span>
      <div className="magic-prepared__heading">
        <h3 id={heading}>{STAGE_TITLE[stage]}</h3>
        <div role="status" aria-live="polite">
          {returnedAt && current && stage === "return" && <p className="magic-prepared__return"><strong>Back from {assignment ?? "your work"}.</strong></p>}
          {(set || prepare.kind !== "error") && <p className="magic-prepared__lede">{lede}</p>}
          {earlierSent.length > 0 && <p className="magic-prepared__earlier">Earlier attempt sent {earlierSent.join(", ")}.</p>}
          {extra && <p className="magic-prepared__problem-text">{extra}</p>}
          {problem?.kind === "unknown" && problem.raw && <TechnicalDetail raw={problem.raw}/>}
        </div>
      </div>
      {current && !pending && <button type="button" className="magic-prepared__dismiss" onClick={() => { work.dismiss(); focusAnchor(anchor); }} aria-label="Clear this Start work result"><Icon name="close"/></button>}
    </header>
    {set ? <>
      <div className="magic-prepared__actions">
        {setupNeeded && onSetup ? <Action data-focus-key={anchor} onClick={onSetup}>Finish setup <Icon name="forward"/></Action>
          : !sentBefore ? <Action data-focus-key={anchor} disabled={!canLaunch} pending={pending} onClick={() => void work.launch()}>
            {label}{label === "Start work" && ` · open ${set.items.length} items`} <Icon name="forward"/>
          </Action> : <>
            {work.failedIds.length > 1 && <Action pending={pending} onClick={() => work.retryFailed()}><Icon name="retry"/> Try {work.failedIds.length} not sent again</Action>}
            <Action data-focus-key={anchor} tone="quiet" disabled={!canLaunch} pending={pending} onClick={() => void work.launch()}>{set.items.length === 1 ? "Open again" : `Open all ${set.items.length} again`}</Action>
          </>}
        {problem?.kind === "busy" && <Action tone="quiet" pending={pending} onClick={() => void work.launch()}>Try again</Action>}
        {problem?.kind === "unavailable" && <Action tone="quiet" onClick={work.refresh}>Refresh destinations</Action>}
      </div>
      <ol className="magic-prepared__list" aria-label="Destinations prepared to open">
        {set.items.map(item => {
          const row = current?.items.find(entry => entry.resourceId === item.resourceId);
          const tone = row ? stateTone(row.state) : "quiet";
          const where = destinationOf(item.target);
          const retryable = row?.state.kind === "not_sent" && !row.state.stale;
          return <li key={item.resourceId} className={`magic-prepared__row is-${tone}`}>
            <span className="magic-prepared__kind" title={where.name}><Icon name={where.icon}/></span>
            <span className="magic-prepared__what">
              <span className="magic-prepared__title">{item.title}</span>
              <span className="magic-prepared__source"><small>{where.name}</small><Info label={`Why ${item.title} is included`}><span>{destinationPhrase(item)}. {item.reason}</span></Info></span>
              {row?.state.kind === "fallback" && <small>Saved copy not used because {row.state.reason}</small>}
            </span>
            <span className="magic-prepared__state">
              {row && row.state.kind !== "ready" && <span className={`magic-prepared__status is-${tone}`}>{tone === "attention" && <Icon name="alert"/>}{stateLabel(row.state)}</span>}
              {retryable && <Action tone="quiet" pending={pending} onClick={() => void work.launch([item.resourceId])} aria-label={`Try sending ${item.title} again`}><Icon name="retry"/> Try again</Action>}
            </span>
          </li>;
        })}
      </ol>
      {set.held.length > 0 && <Disclosure label={`${set.held.length} related ${set.held.length === 1 ? "item" : "items"} held back`}>
        <ul>{set.held.map(item => <li key={item.resourceId}>{item.title} · {item.reason}</li>)}</ul>
      </Disclosure>}
      <p className="magic-start-work__note">{[...set.notes, ...(current?.notes ?? [])].map(note => readableNote(note)).concat(footnote).join(" ")}</p>
    </> : prepare.kind === "loading" ? <p role="status">Preparing your materials…</p> : null}
    {prepare.kind === "error" && <div className="magic-prepared__problem" role="status">
      <p>{prepare.problem.kind === "setup" ? "Finish the UW connection setup step before Magic prepares course pages." : prepare.problem.message}</p>
      {prepare.problem.kind === "setup" ? onSetup && <Action tone="quiet" onClick={onSetup}>Finish setup</Action>
        : <Action tone="quiet" onClick={work.refresh}>Refresh destinations</Action>}
      {prepare.problem.kind === "unknown" && prepare.problem.raw && <TechnicalDetail raw={prepare.problem.raw}/>}
    </div>}
    {!set && prepare.kind !== "loading" && onOpenOriginal && <div className="magic-prepared__actions">
      <Action tone="quiet" onClick={onOpenOriginal}>Open original <Icon name="forward"/></Action>
    </div>}
  </section>;
}

function TechnicalDetail({ raw }: { raw: string }) {
  return <details className="magic-prepared__technical"><summary>Technical detail</summary><code>{raw}</code></details>;
}

function focusAnchor(anchor: string) {
  document.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(anchor)}"]`)?.focus({ preventScroll: true });
}
