import { useEffect, useId, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

// Lucide chevron-right, ISC; attribution in ../LICENSE.icons.
function Chevron() {
  return <svg className="magic-ui-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>;
}

/** Command, never navigation. Pending prevents repeated activation without dropping focus. */
export function Action({ tone = 'primary', pending = false, children, onClick, ...props }:
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> & { tone?: 'primary' | 'quiet'; pending?: boolean }) {
  return <button {...props} type={props.type ?? 'button'} className={`magic-ui-action magic-ui-action--${tone}`}
    aria-busy={pending || undefined} aria-disabled={pending || props.disabled || undefined}
    onClick={event => { if (pending || props.disabled) { event.preventDefault(); return; } onClick?.(event); }}>
    {children}{pending && <span aria-hidden="true"> …</span>}
  </button>;
}

export interface SourceReference {
  resourceId: string;
  version: string | null;
  href: string;
  sourceLabel: string;
  capturedAt: string | null;
}
/** Real anchor to exact object/evidence route. Caller renders freshness and uncertainty there.
 * No multi-app launch, completion update or fabricated evidence handler is bundled here.
 */
export function EvidenceLink({ source, children }: { source: SourceReference; children: ReactNode }) {
  return <a className="magic-ui-link" href={source.href} data-resource-id={source.resourceId}
    data-source-version={source.version ?? 'unknown'}>{children}</a>;
}

export interface ConfirmationRecord { issueId: string; sourceVersion: string; reportedAt: string }
export interface ConfirmationChange { issueId: string; sourceVersion: string; handled: boolean }
/** Controlled self-report, scoped to source version. Parent owns persistence, error and old history.
 * A changed source shows unchecked; an unrelated wording edit does not change sourceVersion.
 */
export function Confirmation({ issueId, sourceVersion, record, onChange, pending = false, error }:
  { issueId: string; sourceVersion: string; record: ConfirmationRecord | null;
    onChange: (change: ConfirmationChange) => void; pending?: boolean; error?: string }) {
  const id = useId(), input = useRef<HTMLInputElement>(null);
  const checked = record?.issueId === issueId && record.sourceVersion === sourceVersion;
  const change = (handled: boolean) => { if (!pending) onChange({ issueId, sourceVersion, handled }); };
  return <div className="magic-ui-confirmation">
    <label><input ref={input} type="checkbox" checked={checked} aria-disabled={pending || undefined}
      aria-describedby={`${id}-help ${id}-status`} onChange={() => change(!checked)} /> I’ve handled this</label>
    <p id={`${id}-help`} className="magic-ui-meta">Your report for this source version; not verification from the course.</p>
    <div id={`${id}-status`} role="status" className="magic-ui-meta">
      {error || (pending ? 'Saving your choice…' : checked ? 'Reported handled. ' : '')}
      {checked && <Action tone="quiet" pending={pending} onClick={() => { change(false); input.current?.focus(); }}>Undo</Action>}
    </div>
  </div>;
}

/** Native disclosure semantics with the same icon at rest/open. */
export function Disclosure({ label, children }: { label: string; children: ReactNode }) {
  return <details className="magic-ui-disclosure"><summary><Chevron />{label}</summary>{children}</details>;
}

/** Nonmodal navigation: ordinary links, Tab order, Escape and focus departure.
 * Keep labels short; caller owns destination routing and destination focus/scroll restoration.
 */
export function NavigationPopover({ label, links }:
  { label: string; links: readonly { label: string; href: string }[] }) {
  const id = useId(), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const element = panel.current!;
    const update = () => setOpen(element.matches(':popover-open'));
    element.addEventListener('toggle', update);
    return () => element.removeEventListener('toggle', update);
  }, []);
  function place() {
    const element = panel.current!, rect = trigger.current!.getBoundingClientRect();
    const width = Math.min(280, innerWidth - 24);
    element.style.width = `${width}px`;
    element.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - width - 12))}px`;
    element.style.top = `${Math.max(12, Math.min(rect.bottom + 6, innerHeight - element.offsetHeight - 12))}px`;
  }
  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);
  return <>
    <button ref={trigger} type="button" className="magic-ui-action" aria-expanded={open} aria-controls={id}
      onClick={() => {
        const element = panel.current!;
        if (element.matches(':popover-open')) element.hidePopover();
        else { element.showPopover(); place(); element.querySelector<HTMLAnchorElement>('a')?.focus(); }
      }}>{label}</button>
    <div ref={panel} id={id} popover="auto" className="magic-ui-popover"
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); panel.current?.hidePopover(); trigger.current?.focus(); } }}
      onBlur={event => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== trigger.current) panel.current?.hidePopover();
      }}>
      <nav aria-label={label}>{links.map(link => <a key={link.href} href={link.href} onClick={() => panel.current?.hidePopover()}>{link.label}</a>)}</nav>
    </div>
  </>;
}
