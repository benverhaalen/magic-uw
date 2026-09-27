import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { ResourceView, WorkLaunchReceipt, WorkSet, Snapshot } from "@magic/contracts";
import { Action, Disclosure } from "../../../../packages/ui/src";
import "./StartWork.css";

export function preparedWorkRevision(snapshot: Snapshot) {
  return JSON.stringify([snapshot.sources.map(source => [source.id, source.lastAttemptAt, source.status]), snapshot.links, snapshot.privacy, snapshot.consents]);
}
type Props = { resource: ResourceView; refreshKey: string; compact?: { className: string; summary: ReactNode } };
/** Keep each assignment's pending work and receipt scoped to that assignment. */
export function StartWork(props: Props) {
  return <PreparedWork key={props.resource.id} {...props} />;
}
function PreparedWork({ resource, refreshKey, compact }: Props) {
  const heading = useId();
  const [set, setSet] = useState<WorkSet | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [receipt, setReceipt] = useState<WorkLaunchReceipt | null>(null);
  const [reload, setReload] = useState(0);
  const busy = useRef(false);
  const mounted = useRef(true);
  const previewHash = useRef<string | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let current = true;
    window.magic.execute({ type: "work-set", id: resource.id }).then(result => {
      if (!current) return;
      const next = result.workSet ?? null;
      if (previewHash.current !== next?.previewHash) setReceipt(null);
      previewHash.current = next?.previewHash ?? null;
      setSet(next); setError("");
    }).catch(cause => {
      if (!current) return;
      setSet(null); setReceipt(null); previewHash.current = null;
      setError(cause instanceof Error ? cause.message : "Could not prepare this work.");
    });
    return () => { current = false; };
  }, [resource.id, refreshKey, reload]);
  const launch = async (only?: string[]) => {
    if (busy.current || !set || !window.magic.startWork) return;
    const hash = set.previewHash;
    busy.current = true; setPending(true); setError("");
    try {
      const next = await window.magic.startWork(resource.id, hash, only);
      if (!mounted.current || previewHash.current !== hash) return;
      setReceipt(previous => only && previous ? {
        ...next,
        opened: [...previous.opened, ...next.opened],
        failed: [...previous.failed.filter(item => !only.includes(item.resourceId)), ...next.failed],
        notes: [...new Set([...previous.notes, ...next.notes])],
      } : next);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "Could not open this work. Try again.");
    } finally { busy.current = false; if (mounted.current) setPending(false); }
  };
  return <section className={compact ? 'magic-start-work magic-start-work--compact' : 'magic-start-work'} aria-label={compact ? `Prepared work: ${resource.title}` : undefined} aria-labelledby={compact ? undefined : heading} data-place-anchor={compact ? `work-${resource.id}` : undefined}>
    {!compact && <h3 id={heading}>Start work</h3>}
    {compact ? <button className={`home-work-row ${compact.className}`} data-focus-key={`work-${resource.id}`} aria-label={`Start work on ${resource.title}`} aria-busy={pending || undefined} aria-disabled={pending || undefined} disabled={!set || !window.magic.startWork} onClick={() => void launch()}>
      <span className="home-work-main">{compact.summary}<span className="home-work-destinations">{set ? <>Open {set.items.map(item => `${item.title} (${item.target.kind === 'file' ? 'saved document' : 'browser'})`).join(' + ')}</> : error ? 'Destinations unavailable' : 'Preparing destinations…'}</span><span className="home-work-launch">{pending ? 'Opening…' : 'Start work →'}</span></span>
    </button> : set ? <>
      <ol className="magic-start-work__destinations" aria-label="Destinations prepared to open">
        {set.items.map(item => <li key={item.resourceId}><span>{item.title}</span><small>
          {item.role === "instructions" ? "Assignment page · opens in front" : item.target.kind === "file" ? "Saved document in its usual app" : "Course page in your browser"}
        </small><small>{item.reason}</small></li>)}
      </ol>
      {set.notes.map(note => <p className="magic-start-work__note" key={note}>{note}</p>)}
      {set.held.length > 0 && <Disclosure label={`${set.held.length} related ${set.held.length === 1 ? "item" : "items"} held back`}>
        <ul>{set.held.map(item => <li key={item.resourceId}>{item.title} — {item.reason}</li>)}</ul>
      </Disclosure>}
      <Action disabled={!window.magic.startWork} pending={pending} onClick={() => void launch()}>
        Start work · open {set.items.length} {set.items.length === 1 ? "item" : "items"}
      </Action>
      <p className="magic-start-work__note">Canvas may record a page view. Opening does not mark work done.</p>
    </> : !error && <p role="status">Preparing your materials…</p>}
    <div role="status" aria-live="polite">
      {receipt && <>
        <p>{receipt.mode === "dry_run" ? "Verification mode: nothing opened." : `Opened ${receipt.opened.length} of ${receipt.opened.length + receipt.failed.length}.`}</p>
        <ul className="magic-start-work__receipt">
          {receipt.opened.map(item => <li key={item.resourceId}>{item.title} · {receipt.mode === "dry_run" ? "would open" : item.via === "file" ? "saved copy opened" : "opened in browser"}</li>)}
          {receipt.failed.map(item => <li key={item.resourceId}>{item.title} · {item.reason}</li>)}
        </ul>
        {receipt.notes.filter(note => !set?.notes.includes(note)).map(note => <p className="magic-start-work__note" key={note}>{note}</p>)}
        {!!receipt.failed.length && <Action tone="quiet" pending={pending} onClick={() => void launch(receipt.failed.map(item => item.resourceId))}>Retry failed items</Action>}
      </>}
      {error && <p>{error}</p>}
    </div>
    {error && <Action tone="quiet" pending={pending} onClick={() => { setError(""); setReload(value => value + 1); }}>Refresh prepared destinations</Action>}
  </section>;
}
