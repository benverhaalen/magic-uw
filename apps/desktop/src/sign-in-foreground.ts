// owner: onboarding-recovery (My UW refresh). A second sign-in request while the app's UW window
// is open joins that window (singleFlight in main); this brings it in front of the student even
// when it was minimized or hidden. focus() alone leaves a minimized window where it was.
export interface ForegroundWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

/** True when an open window was brought forward; nothing is created here. */
export function bringSignInForward(window: ForegroundWindow | null | undefined): boolean {
  if (!window || window.isDestroyed()) return false;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  return true;
}
