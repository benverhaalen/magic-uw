import { useEffect, useId, useRef, type ReactNode } from "react";
import type { ResourceView } from "@magic/contracts";
import { Action, Disclosure } from "../../../../../packages/ui/src";
import { counts, readableNote, stateLabel, stateTone, summaryLine, type LaunchOutcome } from "./launch-model";
import { destinationGroups, destinationOf, destinationPhrase, destinationSummary, type DestinationIcon } from "./destination";
import { usePreparedWork, type PreparedWorkController } from "./usePreparedWork";
import "../StartWork.css";
import "./PreparedWork.css";

// Lucide v0.468.0 nodes, ISC; attribution in packages/ui/LICENSE.icons.
// file-text, refresh-cw, x and arrow-right match docs/design/lab/vendor; the others are copied from lucide-react 0.468.0.
function Icon({ name }: { name: DestinationIcon | "retry" | "close" | "forward" | "alert" }) {
  const sheet = <><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></>;
  const paths = {
    globe: <><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></>,
    "file-text": <>{sheet}<path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></>,
    "file-spreadsheet": <>{sheet}<path d="M8 13h2"/><path d="M14 13h2"/><path d="M8 17h2"/><path d="M14 17h2"/></>,
    presentation: <><path d="M2 3h20"/><path d="M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3"/><path d="m7 21 5-5 5 5"/></>,
    "graduation-cap": <><path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z"/><path d="M22 10v6"/><path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5"/></>,
    "git-branch": <><line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></>,
    retry: <><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></>,
    close: <><path d="M18 6 6 18"/><path d="m6 6 12 12"/></>,
    forward: <><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></>,
    alert: <><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></>,
  };
  return <svg className="magic-prepared__icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export type PreparedWorkProps = {
  resource: ResourceView;
  refreshKey: string;
  /** Home Upcoming row: the whole row starts work; the outcome is a sibling below it. */
  compact?: { className: string; summary: ReactNode };
  /** Optional route to the UW connection setup step when consent is missing. */
  onSetup?: () => void;
};

/** Drop-in for StartWork: same props, one engine, outcome shared across Home and detail for the session. */
export function PreparedWork(props: PreparedWorkProps) {
  return <PreparedWorkInner key={props.resource.id} {...props} />;
}

function PreparedWorkInner({ resource, refreshKey, compact, onSetup }: PreparedWorkProps) {
  const anchor = compact ? `work-${resource.id}` : `start-work-${resource.id}`;
  const work = usePreparedWork(resource.id, refreshKey, anchor);
  return compact ? <CompactWork resource={resource} work={work} compact={compact} anchor={anchor} onSetup={onSetup}/>
    : <FullWork resource={resource} work={work} anchor={anchor} onSetup={onSetup}/>;
}

function CompactWork({ resource, work, compact, anchor, onSetup }: { resource: ResourceView; work: PreparedWorkController; compact: NonNullable<PreparedWorkProps["compact"]>; anchor: string; onSetup?: () => void }) {
  const { set, prepare, pending, canLaunch, outcome } = work;
  const groups = set ? destinationGroups(set.items) : [];
  const sends = groups.length ? `, sends ${destinationSummary(groups)}` : "";
  return <section className="magic-start-work magic-start-work--compact" aria-label={`Prepared work: ${resource.title}`} data-place-anchor={anchor}>
    <button className={`home-work-row ${compact.className}`} data-focus-key={anchor} aria-label={`Start work on ${resource.title}${sends}`}
      aria-busy={pending || undefined} aria-disabled={pending || !canLaunch || undefined}
      onClick={() => { if (!pending && canLaunch) void work.launch(); }}>
      <span className="home-work-main">{compact.summary}
        <span className="home-work-destinations">{set ? <DestinationCluster groups={groups} titles={new Map(set.items.map(item => [item.resourceId, item.title]))}/> : prepare.kind === "error" ? "Destinations unavailable" : "Preparing destinations…"}</span>
        <span className="home-work-launch">{pending ? "Sending…" : "Start work →"}</span>
      </span>
    </button>
    {outcome && <Outcome work={work} outcome={outcome} anchor={anchor} compact onSetup={onSetup}/>}
    {prepare.kind === "error" && <div className="magic-prepared__problem" role="status"><p>{prepare.message}</p><Action tone="quiet" onClick={work.refresh}>Refresh destinations</Action></div>}
  </section>;
}

/** Summary of where Start work sends things: one icon per actual destination category. Not a control. */
function DestinationCluster({ groups, titles }: { groups: ReturnType<typeof destinationGroups>; titles: Map<string, string> }) {
  return <span className="magic-prepared__cluster">
    {groups.map(group => <span key={group.category} className="magic-prepared__dest" title={`${group.label}: ${group.resourceIds.map(id => titles.get(id)).join(", ")}`}>
      <Icon name={group.icon}/>{group.label}
    </span>)}
  </span>;
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

/** One region whose state changes: amber while ready, blue once something was handed off. */
function FullWork({ work, anchor, onSetup }: { resource: ResourceView; work: PreparedWorkController; anchor: string; onSetup?: () => void }) {
  const heading = useId();
  const ledeRef = useRef<HTMLParagraphElement>(null);
  const { set, prepare, pending, canLaunch, outcome, earlier, returnedAt } = work;
  const current = outcome && !earlier ? outcome : null;
  const stage = stageOf(current);
  const sentBefore = !!current && current.mode !== "none";
  const assignment = set?.items.find(item => item.role === "instructions")?.title ?? set?.assignmentTitle;
  useEffect(() => { if (returnedAt) ledeRef.current?.scrollIntoView?.({ block: "nearest" }); }, [returnedAt]);
  const lede = !current ? (earlier ? "An earlier attempt used destinations that have since changed. Start again from this updated list." : "Magic sends these reviewed destinations to your browser and apps.")
    : stage === "problem" && counts(current).sent === 0 && current.problem?.kind !== "unknown" ? "Nothing was sent."
    : summaryLine(current);
  return <section className={`magic-start-work magic-prepared is-${stage === "sending" ? (sentBefore ? "return" : "ready") : stage}`} aria-labelledby={heading} data-place-anchor={anchor}>
    <header className="magic-prepared__head">
      <span className="magic-prepared__badge"><Icon name={stage === "return" ? "retry" : "forward"}/></span>
      <div className="magic-prepared__heading">
        <h3 id={heading}>{STAGE_TITLE[stage]}</h3>
        <div role="status" aria-live="polite">
          {returnedAt && current && stage === "return" && <p className="magic-prepared__return"><strong>Back from {assignment ?? "your work"}.</strong></p>}
          <p ref={ledeRef} className="magic-prepared__lede">{lede}</p>
          {current?.problem && <p className="magic-prepared__problem-text">{current.problem.message}</p>}
        </div>
      </div>
      {current && !pending && <button type="button" className="magic-prepared__dismiss" onClick={() => { work.dismiss(); focusAnchor(anchor); }} aria-label="Clear this Start work result"><Icon name="close"/></button>}
    </header>
    {set ? <>
      <ol className="magic-prepared__list" aria-label="Destinations prepared to open">
        {set.items.map(item => {
          const row = current?.items.find(entry => entry.resourceId === item.resourceId);
          const tone = row ? stateTone(row.state) : "quiet";
          const where = destinationOf(item.target);
          return <li key={item.resourceId} className={`magic-prepared__row is-${tone}`}>
            <span className="magic-prepared__kind" title={where.name}><Icon name={where.icon}/></span>
            <span className="magic-prepared__what">
              <span className="magic-prepared__title">{item.title}</span>
              <small>{destinationPhrase(item)} · {item.reason}</small>
              {row?.state.kind === "fallback" && <small>Saved copy not used because {row.state.reason}.</small>}
            </span>
            <span className="magic-prepared__state">
              {row && row.state.kind !== "ready" && <span className={`magic-prepared__status is-${tone}`}>{tone === "attention" && <Icon name="alert"/>}{stateLabel(row.state)}</span>}
              {row?.state.kind === "not_sent" && <Action tone="quiet" pending={pending} onClick={() => void work.launch([item.resourceId])} aria-label={`Try sending ${item.title} again`}><Icon name="retry"/> Try again</Action>}
            </span>
          </li>;
        })}
      </ol>
      {set.held.length > 0 && <Disclosure label={`${set.held.length} related ${set.held.length === 1 ? "item" : "items"} held back`}>
        <ul>{set.held.map(item => <li key={item.resourceId}>{item.title} · {item.reason}</li>)}</ul>
      </Disclosure>}
      <div className="magic-prepared__actions">
        {!sentBefore ? <Action data-focus-key={anchor} disabled={!canLaunch} pending={pending} onClick={() => void work.launch()}>
          Start work · open {set.items.length} {set.items.length === 1 ? "item" : "items"} <Icon name="forward"/>
        </Action> : <>
          {work.failedIds.length > 1 && <Action pending={pending} onClick={() => work.retryFailed()}><Icon name="retry"/> Try {work.failedIds.length} not sent again</Action>}
          <Action data-focus-key={anchor} tone="quiet" disabled={!canLaunch} pending={pending} onClick={() => void work.launch()}>Open all {set.items.length} again</Action>
        </>}
        {current && <Recovery work={work} outcome={current} onSetup={onSetup} full/>}
      </div>
      {[...set.notes, ...(current?.notes ?? [])].map(note => <p className="magic-start-work__note" key={note}>{readableNote(note)}</p>)}
      <p className="magic-start-work__note">Canvas may record a page view. Magic can confirm each handoff to your browser or apps, not that a page loaded. Opening does not mark work done.</p>
    </> : prepare.kind === "loading" ? <p role="status">Preparing your materials…</p> : null}
    {prepare.kind === "error" && <div className="magic-prepared__problem" role="status"><p>{prepare.message}</p><Action tone="quiet" onClick={work.refresh}>Refresh destinations</Action></div>}
  </section>;
}

function focusAnchor(anchor: string) {
  document.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(anchor)}"]`)?.focus();
}

/** Recovery for problems before or around the handoff. Full variant omits controls it already shows. */
function Recovery({ work, outcome, onSetup, full }: { work: PreparedWorkController; outcome: LaunchOutcome; onSetup?: () => void; full?: boolean }) {
  const problem = outcome.problem, { pending } = work;
  return <>
    {!full && work.failedIds.length > 0 && !problem && <Action tone="quiet" pending={pending} onClick={() => work.retryFailed()}><Icon name="retry"/> Try {work.failedIds.length} not sent again</Action>}
    {problem?.kind === "busy" && <Action tone="quiet" pending={pending} onClick={() => void work.launch()}>Try again</Action>}
    {problem?.kind === "setup" && onSetup && <Action tone="quiet" onClick={onSetup}>Finish setup</Action>}
    {!full && (problem?.kind === "retry_expired" || problem?.kind === "unknown") && <Action tone="quiet" pending={pending} disabled={!work.canLaunch} onClick={() => void work.launch()}>Open all again</Action>}
    {problem?.kind === "unavailable" && <Action tone="quiet" onClick={work.refresh}>Refresh destinations</Action>}
  </>;
}

/** Home row sibling: short summary, rows only when something needs attention, and recovery. */
function Outcome({ work, outcome, anchor, onSetup }: { work: PreparedWorkController; outcome: LaunchOutcome; anchor: string; compact?: boolean; onSetup?: () => void }) {
  const { earlier, returnedAt } = work;
  const tally = counts(outcome);
  const title = outcome.items.find(item => item.role === "instructions")?.title;
  return <div className={`magic-prepared__outcome${returnedAt ? " is-returned" : ""}`}>
    <div role="status" aria-live="polite">
      {earlier ? <p className="magic-start-work__note">An earlier attempt used destinations that have since changed. Start again from the updated row.</p>
        : <p className="magic-prepared__summary">{returnedAt && <strong>Back from {title ?? "your work"}. </strong>}{summaryLine(outcome)}</p>}
      {!earlier && tally.pending === 0 && (tally.failed > 0 || tally.unconfirmed > 0 || outcome.items.some(item => item.state.kind === "fallback")) && <ul className="magic-start-work__receipt">
        {outcome.items.filter(item => item.state.kind !== "ready").map(item => <li key={item.resourceId}>{item.title} · {stateLabel(item.state)}</li>)}
      </ul>}
      {outcome.problem && <p className="magic-prepared__problem-text">{outcome.problem.message}</p>}
    </div>
    <div className="magic-prepared__recover">
      {!earlier && <Recovery work={work} outcome={outcome} onSetup={onSetup}/>}
      {tally.pending === 0 && <button type="button" className="magic-prepared__dismiss" onClick={() => { work.dismiss(); focusAnchor(anchor); }} aria-label="Clear this Start work result"><Icon name="close"/></button>}
    </div>
  </div>;
}
