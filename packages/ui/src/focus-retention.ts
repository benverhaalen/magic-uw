/** Decision state for returning focus to a control that lost it only because it became disabled.
 * Native `disabled` on the focused control moves focus to the document body without a user choice.
 * Any real focus change, pointer press or departure to an enabled target releases the hold.
 */
export class DisabledFocusHold<T> {
  private last: T | null = null;
  private held: T | null = null;
  /** focusin anywhere, including our own restoration. */
  focused(target: T) { this.last = target; this.held = null; }
  /** focusout; a control that is disabled at departure lost focus to the fixup, not to the user. */
  departed(target: T, disabled: boolean) { if (!disabled && target === this.last) { this.last = null; this.held = null; } }
  /** A pointer press redirects attention; never pull focus back after it. */
  pointed() { this.last = null; this.held = null; }
  /** After disabled-state changes: returns the control to refocus, if any. */
  settle(isDisabled: (target: T) => boolean, isConnected: (target: T) => boolean, focusIsIdle: boolean): T | null {
    if (this.held !== null && !isConnected(this.held)) this.held = null;
    if (this.last !== null && isConnected(this.last) && isDisabled(this.last)) { this.held = this.last; return null; }
    if (this.held === null) return null;
    const target = this.held;
    this.held = null;
    return focusIsIdle ? target : null;
  }
}

/** Install once per document (for example beside the host's root render). Returns uninstall.
 * Covers raw controls disabled by a shared busy flag; prefer `Action`, which never drops focus.
 * Does not restore a control that was unmounted, nor move focus the user or page already moved.
 */
export function retainFocusThroughDisable(doc: Document = document): () => void {
  const hold = new DisabledFocusHold<HTMLElement>();
  const idle = () => { const active = doc.activeElement; return !active || active === doc.body || active === doc.documentElement; };
  const disabled = (element: HTMLElement) => element.matches(':disabled');
  const onFocusIn = (event: FocusEvent) => { if (event.target instanceof HTMLElement) hold.focused(event.target); };
  const onFocusOut = (event: FocusEvent) => { if (event.target instanceof HTMLElement) hold.departed(event.target, disabled(event.target)); };
  const onPointer = () => hold.pointed();
  const observer = new MutationObserver(() => {
    hold.settle(disabled, element => element.isConnected, idle())?.focus({ preventScroll: true });
  });
  doc.addEventListener('focusin', onFocusIn, true);
  doc.addEventListener('focusout', onFocusOut, true);
  doc.addEventListener('pointerdown', onPointer, true);
  observer.observe(doc, { subtree: true, attributes: true, attributeFilter: ['disabled'] });
  return () => {
    observer.disconnect();
    doc.removeEventListener('focusin', onFocusIn, true);
    doc.removeEventListener('focusout', onFocusOut, true);
    doc.removeEventListener('pointerdown', onPointer, true);
  };
}
