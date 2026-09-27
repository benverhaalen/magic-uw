import { progressText, type RefreshProgress } from "./refresh-flow";

// owner: onboarding-recovery (My UW refresh). What Refresh is doing now, inside the page's existing
// status region (role=status). After it finishes, only a sign-in that stopped stays said; the
// page's own outcome line reports what each source returned.
export function RefreshStep({ step, pending, canSignIn, show }: {
  step: RefreshProgress | null;
  pending: boolean;
  canSignIn: boolean;
  /** Brings the open UW window forward; main reuses it and never opens a second one. */
  show: (service: Extract<RefreshProgress, { stage: "signin" }>["service"]) => void;
}) {
  if (!step || !(pending || step.stage === "stopped")) return null;
  return <>
    <span className="myuw-outcome">{progressText(step)}</span>
    {pending && step.stage === "signin" && canSignIn ? <button type="button" className="myuw-quiet" onClick={() => show(step.service)}>Show UW window</button> : null}
  </>;
}
