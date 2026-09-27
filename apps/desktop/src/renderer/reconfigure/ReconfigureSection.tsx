// owner: reconfigure. The Data & AI row that starts setup over, behind a plain-words confirmation.
// A native modal dialog: focus moves into it, Escape and Cancel close it and change nothing.
import { useRef, useState } from "react";

export function ReconfigureSection({ disabled, onConfirm }: { disabled: boolean; onConfirm: () => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState("");
  const close = () => { setProblem(""); dialog.current?.close(); };
  const confirm = async () => {
    setWorking(true);
    setProblem("");
    try {
      await onConfirm();
      dialog.current?.close();
    } catch (error) {
      setProblem(error instanceof Error && error.message.length < 200 ? error.message : "Setup could not be reset. Nothing else changed.");
    } finally {
      setWorking(false);
    }
  };
  return <section className="settings-section">
    <h2>Set up again</h2>
    <p>Go through setup from the first step, with your AI detected fresh.</p>
    <button className="button" disabled={disabled} onClick={() => dialog.current?.showModal()}>Reconfigure My Magic UW…</button>
    <dialog ref={dialog} className="reconfigure-dialog" aria-labelledby="reconfigure-title" aria-describedby="reconfigure-what reconfigure-kept" onCancel={(event) => { if (working) event.preventDefault(); else setProblem(""); }}>
      <h2 id="reconfigure-title">Reconfigure My Magic UW?</h2>
      <p id="reconfigure-what">
        This resets your AI setup: how My Magic UW connects to Claude Code or Codex, its separate sign-in profile, your
        chosen AI, and its saved checks of what is installed. Setup then starts again from the first step.
      </p>
      <p id="reconfigure-kept">Your courses, notes and sign-ins are kept.</p>
      {problem ? <p className="attention-text" role="alert">{problem}</p> : null}
      <div className="inline-actions reconfigure-actions">
        <button className="button" disabled={working} onClick={close} autoFocus>Cancel</button>
        <button className="button primary" disabled={working} onClick={() => void confirm()}>{working ? "Resetting…" : "Reconfigure"}</button>
      </div>
    </dialog>
  </section>;
}
